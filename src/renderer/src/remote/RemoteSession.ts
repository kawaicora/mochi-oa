/**
 * Mochi OA - 客户端对客户端远程控制会话（RemoteSession，LiveKit SFU 版）。
 *
 * 统一走 LiveKit SFU：
 *  - 被控端（slave）：采集屏幕 + 系统声音 → publishTrack 发布到 LiveKit room；
 *    键鼠控制指令经 LiveKit data 消息接收 → IPC → main 进程真实注入键鼠。
 *  - 控制端（master）：TrackSubscribed 订阅被控端屏幕/声音；控制端键鼠事件 →
 *    归一化坐标 → LiveKit data（publishData，destination=被控端）发送。
 *  - 屏幕元信息 meta / 结束 bye 也走 LiveKit data（被控端 → 控制端）。
 *
 * token 由服务端统一签发（rtc:dmCall 下发给控制端、rtc:dmIncoming 下发给被控端，
 * 同一 LiveKit room，双方各持各自 access token）。客户端不再持有 apiSecret、不再 P2P。
 *
 * 结束语义（保持多路冗余，SFU 下同样成立）：
 *   ① data 发 {t:'bye'}
 *   ② 主进程在远程窗口 closed 时补发 rtc:leave（对端收到 rtc:peerLeft 收场）
 *   ③ LiveKit 参与者断开 / room 断开 → 收场
 *
 * data 协议（JSON，沿用原 DataChannel 协议，仅承载通道换成 LiveKit data）：
 *  控制端 → 被控端：{t:'move',x,y} | {t:'down',btn} | {t:'up',btn} | {t:'scroll',d}
 *                   | {t:'kdown',k} | {t:'kup',k} | {t:'cursorShow'}
 *                   | {t:'touchdown'|'touchmove'|'touchup',id,x,y}
 *                   | {t:'gamepad',buttons,axes} | {t:'bye'}
 *  被控端 → 控制端：{t:'meta',w,h,mode,input}
 */

import { RoomEvent, type Room, type TrackPublishOptions } from 'livekit-client'
import type { RtcSfuInfo } from '@shared/server-types'
import { connectSfu, sendData, publishOrReplace } from '../rtc/livekitClient'
import { rlog, rwarn, rlogThrottled, newTraceId } from '../../../shared/remote-log'

export type RemoteRole = 'master' | 'slave'
export type RemoteMode = 'remote' | 'local'
/** 控制端主输入设备类型：键鼠 / 触摸（平板）/ 手柄。注入仍按实际事件类型路由。 */
export type RemoteDeviceKind = 'mouse' | 'touch' | 'gamepad'

/**
 * 远程屏幕轨发布参数：画面不允许降清。
 * - maintain-resolution：带宽受限时保分辨率、优先掉帧，不压分辨率；
 * - 关闭 simulcast：不额外发布低清副本层；
 * - 高码率 + 高优先级：屏幕文字/UI 细节优先。
 */
const SCREEN_PUBLISH_OPTIONS: TrackPublishOptions = {
  degradationPreference: 'maintain-resolution',
  simulcast: false,
  screenShareEncoding: { maxBitrate: 12_000_000, maxFramerate: 30, priority: 'high' },
  videoEncoding: { maxBitrate: 12_000_000, maxFramerate: 30, priority: 'high' }
}

/** 心跳周期（控制端 → 被控端 ping）；被控端超过该超时仍未收到对端任何消息即判定掉线并收场。 */
const HEARTBEAT_INTERVAL_MS = 2000
const PEER_TIMEOUT_MS = 6000
const WATCHDOG_INTERVAL_MS = 1000

/** 被控端键鼠注入能力（main 进程探测，透传给控制端提示用） */
export interface RemoteInputCapability {
  ok: boolean
  backend: string
  detail: string
  screen?: { w: number; h: number }
}

/** 一块显示器的几何与缩放信息（与主进程 remote-input.ts 口径一致） */
export interface RemoteDisplayMeta {
  id: string
  label: string
  x: number
  y: number
  w: number
  h: number
  scaleFactor: number
  primary: boolean
}

interface ControlMsg {
  t: string
  x?: number
  y?: number
  d?: number
  k?: number
  btn?: string
  w?: number
  h?: number
  mode?: RemoteMode
  input?: RemoteInputCapability
  id?: string
  displays?: RemoteDisplayMeta[]
  active?: string
  /** 触摸触点标识（TouchEvent.identifier） */
  touchId?: number
  /** 控制端主输入设备类型（键鼠/触摸/手柄） */
  dev?: RemoteDeviceKind
  /** 手柄按键按下状态数组 / 摇杆轴数组 */
  buttons?: number[]
  axes?: number[]
}

export interface RemoteSessionCallbacks {
  /** 控制端：收到被控端屏幕/声音流 */
  onRemoteStream?: (stream: MediaStream) => void
  /** 控制端：收到被控端屏幕元信息（尺寸/模式/键鼠注入能力/显示器列表） */
  onMeta?: (m: { w: number; h: number; mode: RemoteMode; input?: RemoteInputCapability; displays?: RemoteDisplayMeta[]; active?: string; dev?: RemoteDeviceKind }) => void
  /** 连接状态变化；ended=true 表示会话真的结束了（两端都据此收 UI） */
  onState?: (s: { connected: boolean; ended?: boolean }) => void
  onError?: (msg: string) => void
}

/** 被控端键鼠注入会话参数（传给 main 进程 remoteInputStart） */
interface SlaveStartOpts {
  room: string
  /** SFU 连接信息（服务端签发，被控端 token） */
  sfu: RtcSfuInfo
  mode: RemoteMode
  meId: number
  peerId: number
  callbacks?: RemoteSessionCallbacks
}

class RemoteSession {
  private room: Room | null = null
  private role: RemoteRole | null = null
  private mode: RemoteMode = 'local'
  private meId = 0
  /** 对端 userId（LiveKit data 收发按 participant identity 过滤） */
  private peerId = 0
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private callbacks: RemoteSessionCallbacks = {}
  private closed = true
  /** 日志串联用：一次远程控制的所有日志都带同一个 trace */
  private trace = ''
  /** 被控端键鼠注入能力（上报告知控制端） */
  private inputCap: RemoteInputCapability | null = null
  /** 被控端全部显示器与当前活动显示器 id */
  private _displays: RemoteDisplayMeta[] = []
  private _activeDisplay = ''
  /** 对端主输入设备类型（键鼠/触摸/手柄） */
  private _deviceKind: RemoteDeviceKind | null = null
  /** 控制端心跳定时器；被控端看门狗定时器；被控端最近一次收到对端消息的时间戳 */
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private lastPeerAt = 0

  get isActive(): boolean { return !this.closed && !!this.room }
  get currentRole(): RemoteRole | null { return this.role }
  get screenMeta(): { w: number; h: number } | null { return this._meta }
  private _meta: { w: number; h: number } | null = null

  /** 控制端：被控端显示器列表 */
  get displays(): RemoteDisplayMeta[] { return this._displays }

  /** 控制端：当前活动显示器 id */
  get activeDisplayId(): string { return this._activeDisplay }

  /** 对端主输入设备类型 */
  get deviceKind(): RemoteDeviceKind | null { return this._deviceKind }

  private say(msg: string, ...rest: unknown[]): void {
    rlog(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg, ...rest)
  }

  private sayErr(msg: string, ...rest: unknown[]): void {
    rwarn(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg, ...rest)
  }

  /** 对端在 LiveKit room 里的 participant identity = String(peerId) */
  private peerIdentity(): string {
    return String(this.peerId)
  }

  /** 对端进程崩溃/掉线（未发 bye）：ParticipantDisconnected 兜底收场，释放输入并清状态。 */
  private subscribePeerLeave(room: Room): void {
    room.on(RoomEvent.ParticipantDisconnected, (participant) => {
      if (this.closed) return
      if (participant?.identity === this.peerIdentity()) {
        this.say('对端断开（participantDisconnected）→ 结束会话')
        this.stop('peer-disconnected')
      }
    })
  }

  /** 控制端：周期发 ping 心跳，让被控端看门狗能及时发现硬断电/崩溃。 */
  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      this.dataToPeer({ t: 'ping' })
    }, HEARTBEAT_INTERVAL_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null }
  }

  /** 被控端：看门狗。超过 PEER_TIMEOUT_MS 没收到对端任何消息（含 ping）即判定掉线，主动收场释放粘连输入。 */
  private startWatchdog(): void {
    this.stopWatchdog()
    this.lastPeerAt = Date.now()
    this.watchdogTimer = setInterval(() => {
      if (this.closed) return
      if (Date.now() - this.lastPeerAt > PEER_TIMEOUT_MS) {
        this.sayErr(`心跳超时（${PEER_TIMEOUT_MS}ms 未收到对端消息）→ 结束会话`)
        this.stop('peer-timeout')
      }
    }, WATCHDOG_INTERVAL_MS)
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer) { clearInterval(this.watchdogTimer); this.watchdogTimer = null }
  }

  private clearTimers(): void {
    this.stopHeartbeat()
    this.stopWatchdog()
  }

  /** 通过 LiveKit data 消息发给对端（通用 sendData，destination 限定对端） */
  private dataToPeer(msg: ControlMsg): void {
    const room = this.room
    if (!room || this.closed) return
    try {
      sendData(room, this.peerIdentity(), msg)
    } catch (e) {
      rwarn(`session/${this.role}`, `发送 data 失败 t=${msg.t}：${(e as Error)?.message ?? e}`)
    }
  }

  // ── 被控端启动：采集屏幕+系统声音 → publish 到 SFU；收键鼠 data 指令注入 ──
  async startSlave(opts: SlaveStartOpts): Promise<boolean> {
    this.stop('restart')
    this.role = 'slave'
    this.mode = opts.mode
    this.meId = opts.meId
    this.peerId = opts.peerId
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    this._displays = []
    this._activeDisplay = ''
    this._deviceKind = null
    this.trace = newTraceId('slave')
    this.say(`被控端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} sfu=${opts.sfu.url}`)

    // 1. 连接 LiveKit SFU room（通用 connectSfu；Disconnected 自动收场）
    let room: Room
    try {
      room = await connectSfu(opts.sfu, {
        label: '远程协助-被控端',
        onDisconnected: () => {
          if (!this.closed) {
            this.sayErr('SFU 断开 → 结束会话')
            this.stop('sfu-disconnected')
          }
        }
      })
    } catch (e) {
      this.onError(`连接 SFU 失败：${(e as Error)?.message ?? e}`)
      this.stop('sfu-connect-failed')
      return false
    }
    this.room = room
    this.subscribePeerLeave(room)
    this.startWatchdog()
    this.say(`已连接 SFU room=${opts.sfu.roomName}`)

    // 2. 采集屏幕 + 系统声音（48kHz / 2ch / 高音质）
    //    cursor:'always' 把被控端光标持续烘焙进画面帧，控制端看到的光标来自远程画面本身。
    let screen: MediaStream
    try {
      // cursor:'always' 是 Chromium 屏幕采集约束，TS DOM 类型未声明，整体断言为 MediaStreamConstraints。
      const constraints = {
        video: { cursor: 'always' },
        audio: { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false }
      } as unknown as MediaStreamConstraints
      screen = await (navigator.mediaDevices as unknown as {
        getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
      }).getDisplayMedia(constraints)
    } catch (e) {
      this.onError(`采集屏幕失败：${(e as Error)?.message ?? e}`)
      this.stop('capture-failed')
      return false
    }
    this.localStream = screen
    // 屏幕采集内容偏向文字/UI 细节，提示编码器保清晰度
    for (const vt of screen.getVideoTracks()) vt.contentHint = 'detail'
    this.say(`屏幕/声音采集成功 tracks=${screen.getTracks().map((t) => t.kind).join('+') || '(无)'}`)

    // 3. 发布屏幕/声音轨道到 SFU（控制端订阅）
    try {
      for (const t of screen.getTracks()) {
        if (t.kind === 'video') await publishOrReplace(room, 'screen', 'video', t, SCREEN_PUBLISH_OPTIONS)
        else if (t.kind === 'audio') await publishOrReplace(room, 'system-audio', 'audio', t)
      }
      this.say('屏幕/声音已发布到 SFU')
    } catch (e) {
      this.onError(`发布屏幕到 SFU 失败：${(e as Error)?.message ?? e}`)
      this.stop('publish-failed')
      return false
    }

    // 4. 键鼠注入：选后端 + 设模式（返回能力描述）
    try {
      const r = await window.pantry.remoteInputStart(this.mode, {
        w: window.screen.width,
        h: window.screen.height
      })
      this.inputCap = r?.capability ?? { ok: r?.ok === true, backend: 'unknown', detail: '' }
      this.say(`键鼠注入后端=${this.inputCap.backend} ok=${this.inputCap.ok} 说明=${this.inputCap.detail}`)
    } catch (e) {
      this.inputCap = { ok: false, backend: 'none', detail: `启动注入失败：${(e as Error)?.message ?? e}` }
      this.sayErr(`启动键鼠注入失败：${this.inputCap.detail}`)
    }

    // 4.1 枚举被控端全部显示器（供控制端下拉切换）
    try {
      const d = await window.pantry.remoteInputListDisplays()
      this._displays = d?.displays ?? []
      this._activeDisplay = this._displays.find((x) => x.primary)?.id ?? this._displays[0]?.id ?? ''
      this.say(`枚举显示器 ${this._displays.length} 块，当前=${this._activeDisplay}`)
    } catch (e) {
      this.sayErr(`枚举显示器失败：${(e as Error)?.message ?? e}`)
    }

    // 5. data 通道：收控制端键鼠指令 / bye，上报 meta
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (this.closed) return
      if (participant?.identity !== this.peerIdentity()) return
      this.lastPeerAt = Date.now()
      let msg: ControlMsg
      try {
        msg = JSON.parse(new TextDecoder().decode(payload)) as ControlMsg
      } catch {
        return
      }
      if (msg.t === 'ping') return
      if (msg.t === 'bye') {
        this.say('收到对端 bye → 结束会话')
        this.stop('peer-bye')
        return
      }
      if (msg.t === 'switchDisplay') {
        void this.switchDisplay(String(msg.id ?? ''))
        return
      }
      if (msg.t === 'device') {
        this._deviceKind = msg.dev === 'touch' || msg.dev === 'gamepad' || msg.dev === 'mouse' ? msg.dev : null
        this.say(`对端输入设备类型=${this._deviceKind ?? '未知'}`)
        this.sendMeta()
        return
      }
      rlogThrottled(`session/${this.role}`, 'ctrl', `收到控制指令 t=${msg.t}`, 1000, msg.t === 'move' ? undefined : msg)
      void window.pantry.remoteInputEvent(msg as unknown as Record<string, unknown>)
    })

    // 6. 上报屏幕尺寸/模式/注入能力给控制端
    this.sendMeta()
    return true
  }

  // ── 控制端启动：进 SFU room，订阅被控端屏幕/声音；键鼠 data 发送 ──
  async startMaster(opts: {
    room: string
    sfu: RtcSfuInfo
    mode: RemoteMode
    meId: number
    peerId: number
    callbacks?: RemoteSessionCallbacks
  }): Promise<boolean> {
    this.stop('restart')
    this.role = 'master'
    this.mode = opts.mode
    this.meId = opts.meId
    this.peerId = opts.peerId
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    this._displays = []
    this._activeDisplay = ''
    this._deviceKind = null
    this.trace = newTraceId('master')
    this.say(`控制端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} sfu=${opts.sfu.url}`)

    let room: Room
    try {
      room = await connectSfu(opts.sfu, {
        label: '远程协助-控制端',
        onDisconnected: () => {
          if (!this.closed) {
            this.sayErr('SFU 断开 → 结束会话')
            this.stop('sfu-disconnected')
          }
        }
      })
    } catch (e) {
      this.onError(`连接 SFU 失败：${(e as Error)?.message ?? e}`)
      this.stop('sfu-connect-failed')
      return false
    }
    this.room = room
    this.subscribePeerLeave(room)
    this.startHeartbeat()
    this.say(`已连接 SFU room=${opts.sfu.roomName}`)

    // 订阅被控端屏幕/声音
    room.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
      if (this.closed) return
      if (participant?.identity !== this.peerIdentity()) return
      if (!track.mediaStreamTrack) return
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream()
        this.callbacks.onRemoteStream?.(this.remoteStream)
        this.say('收到被控端媒体流')
      }
      this.remoteStream.addTrack(track.mediaStreamTrack)
      this.say(`收到轨道 kind=${track.mediaStreamTrack.kind} 共 ${this.remoteStream.getTracks().length} 条`)
    })

    // data 通道：收被控端 meta / bye
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (this.closed) return
      if (participant?.identity !== this.peerIdentity()) return
      let msg: ControlMsg
      try {
        msg = JSON.parse(new TextDecoder().decode(payload)) as ControlMsg
      } catch {
        return
      }
      if (msg.t === 'meta') {
        this.say(`收到被控端 meta 屏幕=${msg.w}x${msg.h} mode=${msg.mode} 注入=${msg.input?.backend ?? '?'} ok=${msg.input?.ok ?? '?'}`)
        this.setMeta({
          w: Number(msg.w) || 0,
          h: Number(msg.h) || 0,
          mode: msg.mode === 'remote' ? 'remote' : 'local',
          input: msg.input,
          displays: msg.displays,
          active: msg.active,
          dev: msg.dev
        })
        return
      }
      if (msg.t === 'bye') {
        this.say('收到对端 bye → 结束会话')
        this.stop('peer-bye')
        return
      }
    })
    return true
  }

  // DataChannel 时代的旧入口被移除：控制端启动走 startMaster；被控端走 startSlave。

  /** 控制端：发送控制指令（坐标已被控端屏幕像素换算好；经 LiveKit data 发给被控端） */
  sendControl(msg: ControlMsg): void {
    if (this.role === 'master' && this.isActive) {
      this.dataToPeer(msg)
    }
  }

  /** 控制端：上报自己的主输入设备类型（键鼠/触摸/手柄），对端据此同步；类型不变不重复发。 */
  announceDevice(kind: RemoteDeviceKind): void {
    if (this._deviceKind === kind) return
    this._deviceKind = kind
    this.sendControl({ t: 'device', dev: kind })
  }

  /** 控制端：请求被控端切换显示器（注入目标 + 采集画面一起切）。 */
  requestSwitchDisplay(id: string): void {
    this.sendControl({ t: 'switchDisplay', id })
  }

  /** 被控端：切换注入/采集目标显示器：先切主进程注入目标，再重新采集该屏视频轨，最后刷新 meta。 */
  private async switchDisplay(id: string): Promise<void> {
    if (!id || id === this._activeDisplay) return
    const r = await window.pantry.remoteInputSwitchDisplay(id)
    if (!r.ok || !r.display) {
      this.sayErr(`切换显示器失败：${r.reason ?? '未知原因'}`)
      return
    }
    this._activeDisplay = r.display.id
    this.say(`切换显示器 → ${r.display.label} ${r.display.w}x${r.display.h}`)
    // 重新采集目标屏（音频 loopback 轨保持不变，只替换视频轨）
    try {
      const s = await (navigator.mediaDevices as unknown as {
        getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
      }).getDisplayMedia({ video: { cursor: 'always' }, audio: false } as unknown as MediaStreamConstraints)
      const track = s.getVideoTracks()[0]
      if (track && this.room) {
        track.contentHint = 'detail'
        const oldVideo = this.localStream?.getVideoTracks() ?? []
        oldVideo.forEach((t) => { try { t.stop() } catch { /* ignore */ } })
        oldVideo.forEach((t) => { try { this.localStream?.removeTrack(t) } catch { /* ignore */ } })
        this.localStream?.addTrack(track)
        if (!this.localStream) this.localStream = s
        await publishOrReplace(this.room, 'screen', 'video', track, SCREEN_PUBLISH_OPTIONS)
      }
    } catch (e) {
      this.sayErr(`切换显示器重新采集失败：${(e as Error)?.message ?? e}`)
    }
    this.sendMeta()
  }

  /** 被控端：上报屏幕尺寸/模式/注入能力/显示器列表 */
  private sendMeta(): void {
    const sc = this.inputCap?.screen
    const payload: ControlMsg = {
      t: 'meta',
      w: sc?.w || window.screen.width,
      h: sc?.h || window.screen.height,
      mode: this.mode,
      input: this.inputCap ?? undefined,
      displays: this._displays,
      active: this._activeDisplay,
      dev: this._deviceKind ?? undefined
    }
    this.dataToPeer(payload)
    this.say(`已上报 meta ${payload.w}x${payload.h} 显示器=${this._displays.length} 注入=${this.inputCap?.backend ?? '探测中'}`)
  }

  /** 控制端：接收被控端 meta（屏幕尺寸/模式/注入能力/显示器列表） */
  private setMeta(m: { w: number; h: number; mode: RemoteMode; input?: RemoteInputCapability; displays?: RemoteDisplayMeta[]; active?: string; dev?: RemoteDeviceKind }): void {
    this._meta = { w: m.w, h: m.h }
    this._displays = m.displays ?? []
    this._activeDisplay = m.active ?? ''
    this._deviceKind = m.dev ?? null
    this.callbacks.onMeta?.(m)
  }

  private onError(msg: string): void {
    rwarn(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg)
    this.callbacks.onError?.(msg)
  }

  /**
   * 停止会话：先通知对端（bye），再补发按下中的 Up 释放粘连、断开 SFU 与流，最后回报 ended。
   * 不锁定/解冻鼠标边界，不改光标可见性。可重复调用（只有第一次生效）。
   */
  stop(reason = 'manual'): void {
    if (this.closed) return
    this.closed = true
    const role = this.role
    this.say(`结束会话 reason=${reason}`)

    // ① data bye：让对端立刻收场（对端可能已断，失败无所谓）
    try {
      if (this.room) this.dataToPeer({ t: 'bye' })
    } catch { /* ignore */ }

    if (role === 'slave') {
      // 复位：补发按下中的 Up，释放粘连的鼠标/按键；不锁定边界、不改光标显隐
      void window.pantry.remoteInputStop()
    }

    this.clearTimers()
    this.room?.disconnect()
    this.room = null

    if (this.localStream) {
      this.localStream.getTracks().forEach((t) => { try { t.stop() } catch { /* ignore */ } })
      this.localStream = null
    }
    this.remoteStream = null

    // 通知上层「真的结束了」：被控端据此清掉「正在被控制」提示，控制端据此关查看面板
    try {
      this.callbacks.onState?.({ connected: false, ended: true })
    } catch { /* ignore */ }

    this.role = null
    this.callbacks = {}
    this._meta = null
    this.inputCap = null
    this._displays = []
    this._activeDisplay = ''
    this._deviceKind = null
  }
}

export default new RemoteSession()
