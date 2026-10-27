/**
 * Mochi OA - 客户端对客户端远程控制会话（RemoteSession，LiveKit SFU 版）。
 *
 * 统一走 LiveKit SFU：
 *  - 被控端（slave）：采集屏幕 + 系统声音 → publishTrack 发布到 LiveKit room；
 *    键鼠控制指令经 LiveKit data 消息接收 → IPC → main 进程真实注入键鼠。
 *  - 控制端（master）：TrackSubscribed 订阅被控端屏幕/声音；本机键鼠事件 →
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
 *                   | {t:'kdown',k} | {t:'kup',k} | {t:'bye'}
 *  被控端 → 控制端：{t:'meta',w,h,mode,input}
 */

import { RoomEvent, type Room } from 'livekit-client'
import type { RtcSfuInfo } from '@shared/server-types'
import { connectSfu, sendData, publishOrReplace } from '../rtc/livekitClient'
import { rlog, rwarn, rlogThrottled, newTraceId } from '../../../shared/remote-log'

export type RemoteRole = 'master' | 'slave'
export type RemoteMode = 'remote' | 'local'

/** 被控端键鼠注入能力（main 进程探测，透传给控制端提示用） */
export interface RemoteInputCapability {
  ok: boolean
  backend: string
  detail: string
  screen?: { w: number; h: number }
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
}

export interface RemoteSessionCallbacks {
  /** 控制端：收到被控端屏幕/声音流 */
  onRemoteStream?: (stream: MediaStream) => void
  /** 控制端：收到被控端屏幕元信息（尺寸/模式/键鼠注入能力） */
  onMeta?: (m: { w: number; h: number; mode: RemoteMode; input?: RemoteInputCapability }) => void
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

  get isActive(): boolean { return !this.closed && !!this.room }
  get currentRole(): RemoteRole | null { return this.role }
  get screenMeta(): { w: number; h: number } | null { return this._meta }
  private _meta: { w: number; h: number } | null = null

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
    this.trace = newTraceId('slave')
    this.say(`被控端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} sfu=${opts.sfu.url}`)

    // 1. 连接 LiveKit SFU room（通用 connectSfu；Disconnected 自动收场）
    let room: Room
    try {
      room = await connectSfu(opts.sfu, {
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
    this.say(`已连接 SFU room=${opts.sfu.roomName}`)

    // 2. 采集屏幕 + 系统声音（48kHz / 2ch / 高音质）
    let screen: MediaStream
    try {
      screen = await (navigator.mediaDevices as unknown as {
        getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
      }).getDisplayMedia({
        video: true,
        audio: { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false }
      })
    } catch (e) {
      this.onError(`采集屏幕失败：${(e as Error)?.message ?? e}`)
      this.stop('capture-failed')
      return false
    }
    this.localStream = screen
    this.say(`屏幕/声音采集成功 tracks=${screen.getTracks().map((t) => t.kind).join('+') || '(无)'}`)

    // 3. 发布屏幕/声音轨道到 SFU（控制端订阅）
    try {
      for (const t of screen.getTracks()) {
        if (t.kind === 'video') await publishOrReplace(room, 'screen', 'video', t)
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

    // 5. data 通道：收控制端键鼠指令 / bye，上报 meta
    room.on(RoomEvent.DataReceived, (payload, participant) => {
      if (this.closed) return
      if (participant?.identity !== this.peerIdentity()) return
      let msg: ControlMsg
      try {
        msg = JSON.parse(new TextDecoder().decode(payload)) as ControlMsg
      } catch {
        return
      }
      if (msg.t === 'bye') {
        this.say('收到对端 bye → 结束会话')
        this.stop('peer-bye')
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
    this.trace = newTraceId('master')
    this.say(`控制端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} sfu=${opts.sfu.url}`)

    let room: Room
    try {
      room = await connectSfu(opts.sfu, {
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
          input: msg.input
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

  /** 被控端：上报屏幕尺寸/模式/注入能力 */
  private sendMeta(): void {
    const payload: ControlMsg = {
      t: 'meta',
      w: window.screen.width,
      h: window.screen.height,
      mode: this.mode,
      input: this.inputCap ?? undefined
    }
    this.dataToPeer(payload)
    this.say(`已上报 meta ${payload.w}x${payload.h} 注入=${this.inputCap?.backend ?? '探测中'}`)
  }

  /** 控制端：接收被控端 meta（屏幕尺寸/模式/注入能力） */
  private setMeta(m: { w: number; h: number; mode: RemoteMode; input?: RemoteInputCapability }): void {
    this._meta = { w: m.w, h: m.h }
    this.callbacks.onMeta?.(m)
  }

  private onError(msg: string): void {
    rwarn(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg)
    this.callbacks.onError?.(msg)
  }

  /**
   * 停止会话：先通知对端（bye），再复位/解冻鼠标、断开 SFU 与流，最后回报 ended。
   * 可重复调用（只有第一次生效）。
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
      // 复位：补发按下中的 Up + 强制解冻 + 显示鼠标（宁可多执行）
      void window.pantry.remoteInputStop()
    }

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
  }
}

export default new RemoteSession()
