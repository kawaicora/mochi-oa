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
 * DataChannel 协议（JSON）：
 *  控制端 → 被控端：{t:'move',x,y} | {t:'down',btn} | {t:'up',btn} | {t:'scroll',d}
 *                   | {t:'kdown',k} | {t:'kup',k}     （x/y 为被控端屏幕像素坐标）
 *  被控端 → 控制端：{t:'meta',w,h,mode}                 （被控端屏幕尺寸 + 键鼠模式）
 */

import VideoStream from '../media/VideoStream'

export type RemoteRole = 'master' | 'slave'
export type RemoteMode = 'remote' | 'local'

interface RtcSignalMsg {
  type?: string
  sdp?: string
  candidate?: unknown
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
}

export interface RemoteSessionCallbacks {
  /** 控制端：收到被控端屏幕/声音流 */
  onRemoteStream?: (stream: MediaStream) => void
  /** 控制端：收到被控端屏幕元信息（尺寸/模式） */
  onMeta?: (m: { w: number; h: number; mode: RemoteMode }) => void
  onState?: (s: { connected: boolean; ended?: boolean }) => void
  onError?: (msg: string) => void
}

class RemoteSession {
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private role: RemoteRole | null = null
  private room = ''
  private mode: RemoteMode = 'local'
  private meId = 0
  private localStream: MediaStream | null = null
  private remoteStream: MediaStream | null = null
  private sendSignalFn: ((signal: RtcSignalMsg) => void) | null = null
  private unsubSignal: (() => void) | null = null
  private callbacks: RemoteSessionCallbacks = {}
  private closed = true

  get isActive(): boolean { return !this.closed && !!this.pc }
  get currentRole(): RemoteRole | null { return this.role }
  get screenMeta(): { w: number; h: number } | null {
    // 供控制端换算归一化坐标使用；未收到 meta 前返回 null
    return this._meta
  }
  private _meta: { w: number; h: number } | null = null

  // ── 被控端启动：采集屏幕+系统声音、建 DataChannel、设键鼠模式、发 offer ──
  async startSlave(opts: {
    room: string
    iceServers: RTCIceServer[]
    mode: RemoteMode
    meId: number
    sendSignal: (s: RtcSignalMsg) => void
    callbacks?: RemoteSessionCallbacks
  }): Promise<boolean> {
    this.stop()
    this.room = opts.room
    this.role = 'slave'
    this.mode = opts.mode
    this.meId = opts.meId
    this.sendSignalFn = opts.sendSignal
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    try {
      this.pc = new RTCPeerConnection({ iceServers: opts.iceServers })
    } catch (e) {
      this.onError(`创建连接失败：${(e as Error)?.message ?? e}`)
      this.stop()
      return false
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignalFn?.({ type: 'ice', candidate: ev.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => {
      this.callbacks.onState?.({ connected: this.pc?.connectionState === 'connected' })
      if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') this.stop()
    }
    // DataChannel：控制端创建，被控端 ondatachannel 接收控制指令
    this.pc.ondatachannel = (ev) => {
      this.channel = ev.channel
      this.channel.onmessage = (m) => this.handleControl(JSON.parse(String(m.data)) as ControlMsg)
      this.channel.onopen = () => {
        // 上报被控端屏幕尺寸 + 模式，控制端据此换算归一化坐标
        try {
          this.channel?.send(JSON.stringify({ t: 'meta', w: window.screen.width, h: window.screen.height, mode: this.mode }))
        } catch { /* ignore */ }
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
    } catch (e) {
      this.onError(`采集屏幕失败：${(e as Error)?.message ?? e}`)
      this.stop()
      return false
    }
    // 键鼠模式：remote=锁定+隐藏本机鼠标；local=仅同步位置
    await window.pantry.remoteInputStart(this.mode)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    this.sendSignalFn?.({ type: 'offer', sdp: offer.sdp })
    this.subscribeSignals()
    return true
  }

  // ── 控制端启动：建 PC 等被控 offer，ontrack 收屏幕/声音 ──
  startMaster(opts: {
    room: string
    iceServers: RTCIceServer[]
    mode: RemoteMode
    meId: number
    sendSignal: (s: RtcSignalMsg) => void
    callbacks?: RemoteSessionCallbacks
  }): boolean {
    this.stop()
    this.room = opts.room
    this.role = 'master'
    this.mode = opts.mode
    this.meId = opts.meId
    this.sendSignalFn = opts.sendSignal
    this.callbacks = opts.callbacks ?? {}
    this.closed = false
    this._meta = null
    try {
      this.pc = new RTCPeerConnection({ iceServers: opts.iceServers })
    } catch (e) {
      this.onError(`创建连接失败：${(e as Error)?.message ?? e}`)
      this.stop()
      return false
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) this.sendSignalFn?.({ type: 'ice', candidate: ev.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => {
      this.callbacks.onState?.({ connected: this.pc?.connectionState === 'connected' })
      if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') this.stop()
    }
    this.pc.ontrack = (ev) => {
      if (!this.remoteStream) {
        this.remoteStream = new MediaStream()
        this.callbacks.onRemoteStream?.(this.remoteStream)
      }
      if (ev.track) this.remoteStream.addTrack(ev.track)
    }
    this.subscribeSignals()
    return true
  }

  // 订阅 rtc:signal，过滤本房间 + 非自己来源
  private subscribeSignals(): void {
    this.unsubSignal = window.pantry.onRtcSignal((d) => {
      if (!this.isActive || d.room !== this.room) return
      if (d.from?.userId === this.meId) return
      void this.handleSignal(d.signal as RtcSignalMsg)
    })
  }

  // 处理信令：master 收 offer → answer + createDataChannel；slave 收 answer
  private async handleSignal(signal: RtcSignalMsg): Promise<void> {
    if (!this.pc || this.closed) return
    try {
      if (signal.type === 'offer' && this.role === 'master' && signal.sdp) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: signal.sdp })
        const ch = this.pc.createDataChannel('control')
        this.channel = ch
        this.channel.onopen = () => { /* 就绪，控制端可发指令 */ }
        this.channel.onmessage = (m) => this.handleControl(JSON.parse(String(m.data)) as ControlMsg)
        const answer = await this.pc.createAnswer()
        await this.pc.setLocalDescription(answer)
        this.sendSignalFn?.({ type: 'answer', sdp: answer.sdp })
      } else if (signal.type === 'answer' && this.role === 'slave' && signal.sdp) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
      } else if (signal.candidate) {
        try {
          await this.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
        } catch { /* 忽略候选时序 */ }
      }
    } catch (e) {
      this.onError(`信令处理失败：${(e as Error)?.message ?? e}`)
    }
  }

  // DataChannel 消息：meta（被控端→控制端）或控制指令（控制端→被控端）
  private handleControl(msg: ControlMsg): void {
    if (!msg || typeof msg.t !== 'string') return
    if (msg.t === 'meta') {
      this.setMeta({ w: Number(msg.w) || 0, h: Number(msg.h) || 0, mode: msg.mode === 'remote' ? 'remote' : 'local' })
      return
    }
    // 被控端：控制指令 → main 进程真实注入
    void window.pantry.remoteInputEvent(msg as unknown as Record<string, unknown>)
  }

  // 控制端：发送控制指令（坐标已被控端屏幕像素换算好）
  sendControl(msg: ControlMsg): void {
    if (this.channel && this.channel.readyState === 'open' && this.role === 'master') {
      try { this.channel.send(JSON.stringify(msg)) } catch { /* ignore */ }
    }
  }

  // 控制端：接收被控端 meta（屏幕尺寸/模式）
  private setMeta(m: { w: number; h: number; mode: RemoteMode }): void {
    this._meta = { w: m.w, h: m.h }
    this.callbacks.onMeta?.(m)
  }

  private onError(msg: string): void {
    console.warn('[remote]', msg)
    this.callbacks.onError?.(msg)
  }

  /** 停止会话：复位并解冻/显示鼠标（被控端），关闭 PC 与流。可重复调用。 */
  stop(): void {
    if (this.closed) return
    this.closed = true
    if (this.role === 'slave') {
      // 复位：补发按下中的 Up + 强制解冻 + 显示鼠标（宁可多执行）
      void window.pantry.remoteInputStop()
    }
    this.unsubSignal?.()
    this.unsubSignal = null
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
    this.role = null
    this.sendSignalFn = null
    this.callbacks = {}
    this._meta = null
    this.room = ''
  }
}

export default new RemoteSession()
