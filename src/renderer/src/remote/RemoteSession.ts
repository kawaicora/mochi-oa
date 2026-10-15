/**
 * Mochi OA - 客户端对客户端远程控制会话（RemoteSession）。
 *
 * 同一条 RTCPeerConnection 传屏幕（含系统声音 48kHz / 2ch 高音质）+ 用
 * PeerConnection 自带 DataChannel('control') 传输键鼠控制数据；socket.io 只做信令
 * （offer/answer/ICE + 授权握手，password 经 socket.io 校验）。
 *
 * 角色：
 *  - slave（被控端）：采集屏幕 + 系统声音 → 发给控制端；ondatachannel 接收控制指令
 *    → IPC → main 进程真实注入键鼠；设置键鼠模式（remote=锁定+隐藏 / local=仅同步）。
 *  - master（控制端）：ontrack 收屏幕/声音；createDataChannel('control')；采集本机
 *    键鼠事件 → 归一化坐标 → DataChannel 发送。默认显示鼠标，无需处理。
 *
 * 信令走 rtc:signal（房间内广播）。本会话独立订阅 rtc:signal 并按 room + 来源过滤，
 * 与会议室/通话（RtcEngine）的 activeCall 互不干扰。
 *
 * 结束语义（重要）：控制端直接关窗口时，被控端的「正在被 [对方] 控制」提示必须消失。
 * 所以结束走多路冗余通知，任何一路到达都能收场：
 *   ① DataChannel 发 {t:'bye'}
 *   ② 信令发 {type:'bye'}（DC 还没 open 时也能到）
 *   ③ 主进程在远程窗口 closed 时补发 ② + rtc:leave（渲染层已销毁也兜得住）
 *   ④ 服务端房间广播 rtc:peerLeft（对端崩溃/断网时靠它）
 * 另外被控端把「连接 failed/closed」「disconnected 持续 5s 未恢复」也当成对端走了。
 *
 * DataChannel 协议（JSON）：
 *  控制端 → 被控端：{t:'move',x,y} | {t:'down',btn} | {t:'up',btn} | {t:'scroll',d}
 *                   | {t:'kdown',k} | {t:'kup',k} | {t:'bye'}   （x/y 为被控端屏幕像素坐标）
 *  被控端 → 控制端：{t:'meta',w,h,mode,input}                 （屏幕尺寸 + 键鼠模式 + 注入能力）
 */

import VideoStream from '../media/VideoStream'
import { rlog, rwarn, rlogThrottled, newTraceId } from '../../../shared/remote-log'

export type RemoteRole = 'master' | 'slave'
export type RemoteMode = 'remote' | 'local'

interface RtcSignalMsg {
  type?: string
  sdp?: string
  candidate?: unknown
}

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

/** disconnected 宽限期：短暂抖动（丢包/切网)常能自愈，超时仍未恢复才算结束 */
const DISCONNECT_GRACE_MS = 5000

class RemoteSession {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private role: RemoteRole | null = null
  private room = ''
  private mode: RemoteMode = 'local'
  private meId = 0
  /** 对端 userId（精确信令匹配：控制端=被控端、被控端=控制端；同一账号两端 userId 相同也不误滤） */
  private peerId = 0
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private sendSignalFn: ((signal: RtcSignalMsg) => void) | null = null
  private unsubSignal: (() => void) | null = null
  private unsubPeerLeft: (() => void) | null = null
  private callbacks: RemoteSessionCallbacks = {}
  private closed = true
  /** 日志串联用：一次远程控制的所有日志都带同一个 trace */
  private trace = ''
  /** 被控端键鼠注入能力（上报告知控制端） */
  private inputCap: RemoteInputCapability | null = null
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null

  get isActive(): boolean { return !this.closed && !!this.pc }
  get currentRole(): RemoteRole | null { return this.role }
  get screenMeta(): { w: number; h: number } | null { return this._meta }
  private _meta: { w: number; h: number } | null = null

  private say(msg: string, ...rest: unknown[]): void {
    rlog(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg, ...rest)
  }

  private sayErr(msg: string, ...rest: unknown[]): void {
    rwarn(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg, ...rest)
  }

  // ── 被控端启动：采集屏幕+系统声音、建 DataChannel、设键鼠模式、发 offer ──
  async startSlave(opts: {
    room: string
    iceServers: RTCIceServer[]
    mode: RemoteMode
    meId: number
    peerId: number
    sendSignal: (s: RtcSignalMsg) => void
    callbacks?: RemoteSessionCallbacks
  }): Promise<boolean> {
    this.stop('restart')
    this.room = opts.room
    this.role = 'slave'
    this.mode = opts.mode
    this.meId = opts.meId
    this.peerId = opts.peerId
    this.sendSignalFn = opts.sendSignal
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    this.trace = newTraceId('slave')
    this.say(`被控端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} ice=${opts.iceServers.length} 组`)
    try {
      this.pc = new RTCPeerConnection({ iceServers: opts.iceServers })
    } catch (e) {
      this.onError(`创建连接失败：${(e as Error)?.message ?? e}`)
      this.stop('pc-create-failed')
      return false
    }
    this.wirePc()
    // DataChannel：控制端创建，被控端 ondatachannel 接收控制指令
    this.pc.ondatachannel = (ev) => {
      this.say(`收到 DataChannel label=${ev.channel.label}`)
      this.channel = ev.channel
      this.channel.onmessage = (m) => this.handleControl(JSON.parse(String(m.data)) as ControlMsg)
      this.channel.onclose = () => this.say('DataChannel 已关闭')
      this.channel.onopen = () => {
        this.say('DataChannel 打开 → 上报屏幕尺寸/模式/键鼠注入能力')
        this.sendMeta()
      }
    }
    // 采集屏幕 + 系统声音（48kHz / 2ch / 高音质）
    try {
      const s = await (navigator.mediaDevices as unknown as {
        getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream>
      }).getDisplayMedia({
        video: true,
        audio: { channelCount: 2, sampleRate: 48000, echoCancellation: false, noiseSuppression: false }
      })
      s.getTracks().forEach((t) => this.pc?.addTrack(t, s))
      this.localStream = s
      this.say(`屏幕/声音采集成功 tracks=${s.getTracks().map((t) => t.kind).join('+') || '(无)'}`)
    } catch (e) {
      this.onError(`采集屏幕失败：${(e as Error)?.message ?? e}`)
      this.stop('capture-failed')
      return false
    }
    // 键鼠注入：选后端 + 设模式（返回能力描述；不可用时明确告知控制端，避免"连上了点不动"）
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
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.sendSignalFn?.({ type: 'offer', sdp: offer.sdp })
    this.say('已发送 offer')
    this.subscribeSignals()
    return true
  }

  // ── 控制端启动：建 PC 等被控 offer，ontrack 收屏幕/声音 ──
  startMaster(opts: {
    room: string
    iceServers: RTCIceServer[]
    mode: RemoteMode
    meId: number
    peerId: number
    sendSignal: (s: RtcSignalMsg) => void
    callbacks?: RemoteSessionCallbacks
  }): boolean {
    this.stop('restart')
    this.room = opts.room
    this.role = 'master'
    this.mode = opts.mode
    this.meId = opts.meId
    this.peerId = opts.peerId
    this.sendSignalFn = opts.sendSignal
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    this.trace = newTraceId('master')
    this.say(`控制端开始会话 room=${opts.room} peer=${opts.peerId} mode=${opts.mode} ice=${opts.iceServers.length} 组`)
    try {
      this.pc = new RTCPeerConnection({ iceServers: opts.iceServers })
    } catch (e) {
      this.onError(`创建连接失败：${(e as Error)?.message ?? e}`)
      this.stop('pc-create-failed')
      return false
    }
    this.wirePc()
    this.pc.ontrack = (ev) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream()
        this.callbacks.onRemoteStream?.(this.remoteStream)
        this.say('收到对端媒体流')
      }
      if (ev.track) this.remoteStream.addTrack(ev.track)
      this.say(`收到轨道 kind=${ev.track?.kind ?? '?'} 共 ${this.remoteStream.getTracks().length} 条`)
    }
    this.subscribeSignals()
    return true
  }

  /** PC 事件统一挂载：连接状态 / ICE / 断开宽限 */
  private wirePc(): void {
    const pc = this.pc
    if (!pc) return
    pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignalFn?.({ type: 'ice', candidate: ev.candidate.toJSON() })
    }
    pc.oniceconnectionstatechange = () => {
      rlogThrottled(`session/${this.role}`, 'ice-state', `ICE 状态 = ${pc.iceConnectionState}`)
    }
    pc.onconnectionstatechange = () => {
      const st = pc.connectionState
      this.say(`连接状态 = ${st}`)
      this.callbacks.onState?.({ connected: st === 'connected' })
      if (st === 'connected') {
        this.clearDisconnectTimer()
        return
      }
      if (st === 'disconnected') {
        // 抖动宽限：超时还没恢复就结束（否则被控端会一直挂着「正在被控制」）
        if (this.disconnectTimer) return
        this.sayErr(`连接中断，${DISCONNECT_GRACE_MS}ms 内未恢复则结束会话`)
        this.disconnectTimer = setTimeout(() => {
          this.disconnectTimer = null
          if (this.pc && this.pc.connectionState !== 'connected') {
            this.sayErr('连接未恢复 → 结束会话')
            this.stop('disconnected-timeout')
          }
        }, DISCONNECT_GRACE_MS)
        return
      }
      if (st === 'failed' || st === 'closed') {
        this.stop(`pc-${st}`)
      }
    }
  }

  /** 订阅信令 + 服务端对端离开广播（对端崩溃/断网时也能收场） */
  private subscribeSignals(): void {
    this.unsubSignal = window.pantry.onRtcSignal((d) => {
      if (!this.isActive || d.room !== this.room) return
      if (d.from?.userId !== this.peerId) return
      const sig = d.signal as RtcSignalMsg
      if (sig?.type === 'bye') {
        this.say('收到对端 bye 信令 → 结束会话')
        this.stop('peer-bye-signal')
        return
      }
      void this.handleSignal(sig)
    })
    this.unsubPeerLeft = window.pantry.onRtcPeerLeft((d) => {
      if (!this.isActive || d.room !== this.room) return
      this.say('收到服务端 rtc:peerLeft → 对端已离开房间，结束会话')
      this.stop('peer-left')
    })
  }

  // 处理信令：master 收 offer → answer + createDataChannel；slave 收 answer
  private async handleSignal(signal: RtcSignalMsg): Promise<void> {
    if (!this.pc || this.closed) return
    try {
      if (signal.type === 'offer' && this.role === 'master' && signal.sdp) {
        this.say('收到 offer → 建 DataChannel + 回 answer')
        await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        const ch = this.pc.createDataChannel('control')
        this.channel = ch
        this.channel.onopen = () => this.say('DataChannel 打开（控制端可发送指令）')
        this.channel.onclose = () => this.say('DataChannel 已关闭')
        this.channel.onmessage = (m) => this.handleControl(JSON.parse(String(m.data)) as ControlMsg)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.sendSignalFn?.({ type: 'answer', sdp: answer.sdp })
        this.say('已发送 answer')
      } else if (signal.type === 'answer' && this.role === 'slave' && signal.sdp) {
        this.say('收到 answer')
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
      } else if (signal.candidate) {
        try {
          await this.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
        } catch (e) {
          this.sayErr(`添加 ICE 候选失败（可能时序竞态）：${(e as Error)?.message ?? e}`)
        }
      }
    } catch (e) {
      this.onError(`信令处理失败：${(e as Error)?.message ?? e}`)
    }
  }

  // DataChannel 消息：meta（被控端→控制端）/ bye / 控制指令（控制端→被控端）
  private handleControl(msg: ControlMsg): void {
    if (!msg || typeof msg.t !== 'string') return
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
    // 被控端：控制指令 → main 进程真实注入
    rlogThrottled(`session/${this.role}`, 'ctrl', `收到控制指令 t=${msg.t}`, 1000, msg.t === 'move' ? undefined : msg)
    void window.pantry.remoteInputEvent(msg as unknown as Record<string, unknown>)
  }

  /** 控制端：发送控制指令（坐标已被控端屏幕像素换算好） */
  sendControl(msg: ControlMsg): void {
    if (this.channel && this.channel.readyState === 'open' && this.role === 'master') {
      try {
        this.channel.send(JSON.stringify(msg))
      } catch (e) {
        rwarn(`session/${this.role}`, `发送控制指令失败 t=${msg.t}：${(e as Error)?.message ?? e}`)
      }
    }
  }

  /** 被控端：上报屏幕尺寸/模式/注入能力 */
  private sendMeta(): void {
    const payload = {
      t: 'meta',
      w: window.screen.width,
      h: window.screen.height,
      mode: this.mode,
      input: this.inputCap ?? undefined
    }
    try {
      this.channel?.send(JSON.stringify(payload))
      this.say(`已上报 meta ${payload.w}x${payload.h} 注入=${this.inputCap?.backend ?? '探测中'}`)
    } catch (e) {
      this.sayErr(`上报屏幕尺寸失败：${(e as Error)?.message ?? e}`)
    }
  }

  // 控制端：接收被控端 meta（屏幕尺寸/模式/注入能力）
  private setMeta(m: { w: number; h: number; mode: RemoteMode; input?: RemoteInputCapability }): void {
    this._meta = { w: m.w, h: m.h }
    this.callbacks.onMeta?.(m)
  }

  private clearDisconnectTimer(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer)
      this.disconnectTimer = null
    }
  }

  private onError(msg: string): void {
    rwarn(`session/${this.role ?? '?'}${this.trace ? ' ' + this.trace : ''}`, msg)
    this.callbacks.onError?.(msg)
  }

  /**
   * 停止会话：先通知对端（bye），再复位/解冻鼠标、关 PC 与流，最后回报 ended。
   * 可重复调用（只有第一次生效）。
   */
  stop(reason = 'manual'): void {
    if (this.closed) return
    this.closed = true
    const role = this.role
    const room = this.room
    this.say(`结束会话 reason=${reason}`)
    this.clearDisconnectTimer()

    // ① DataChannel bye：让对端立刻收场（对端可能已关 DC，失败无所谓）
    try {
      if (this.channel && this.channel.readyState === 'open') {
        this.channel.send(JSON.stringify({ t: 'bye' }))
        this.say('已发送 bye（DataChannel）')
      }
    } catch { /* ignore */ }
    // ② 信令 bye：DC 还没 open / 已关闭时的兜底
    try {
      if (this.sendSignalFn) {
        this.sendSignalFn({ type: 'bye' })
        this.say('已发送 bye（信令）')
      }
    } catch { /* ignore */ }

    if (role === 'slave') {
      // 复位：补发按下中的 Up + 强制解冻 + 显示鼠标（宁可多执行）
      void window.pantry.remoteInputStop()
    }
    // ③ 服务端房间：把本端移出房间（对端会收到 rtc:peerLeft），空房间自动清理
    if (room) void window.pantry.rtcLeave(room)

    this.unsubSignal?.()
    this.unsubSignal = null
    this.unsubPeerLeft?.()
    this.unsubPeerLeft = null
    try {
      this.channel?.close()
    } catch { /* ignore */ }
    this.channel = null
    if (this.pc) {
      try { this.pc.close() } catch { /* ignore */ }
      this.pc = null
    }
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
    this.sendSignalFn = null
    this.callbacks = {}
    this._meta = null
    this.room = ''
    this.inputCap = null
  }
}

export default new RemoteSession()
