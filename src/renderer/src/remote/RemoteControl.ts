/**
 * 远程设备控制 —— 被控端（客户端 app）
 *
 * 登录后向服务端 dev:register 注册本机为"在线电脑"，并维持心跳；
 * 订阅服务端 dev:view / dev:enumerate / dev:start / dev:stop / dev:signal：
 *   - dev:view / dev:enumerate → 枚举摄像头/麦克风并 dev:devices 上报给控制端
 *   - dev:start { kind: camera|screen|mic, device, iceServers } → 采集对应流，
 *     以被控端为 WebRTC sender，经 dev:signal 发给控制端
 *   - dev:stop → 停流并关闭 RTCPeerConnection
 *
 * 【单流 + 轨道替换】一次会话只建一条 RTCPeerConnection + 一个常驻 MediaStream。
 * 连接建立时先挂"占位轨"（空视频 + 空音频），此后每次操作（麦克风/摄像头/屏幕）
 * 都只替换对应 kind 的轨道（RTCRtpSender.replaceTrack），不重建连接、不断流：
 *   - mic     → 替换音频轨（麦克风）
 *   - camera  → 替换视频轨（摄像头）
 *   - screen  → 替换视频轨（屏幕）+ 替换音频轨（系统声音，audio: loopback）
 * 参考客户端 VideoStream 的"替换轨、保留其它"语义。
 *
 * 信令经 main 的 serverClient socket（IPC：window.pantry.devSignal / onDevSignal）转发。
 */
import VideoStream from '../media/VideoStream'

interface DevStartPayload {
  deviceId?: string
  kind?: string
  device?: unknown
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
}
interface DevSignalPayload {
  type?: string
  sdp?: string
  candidate?: unknown
}

class RemoteControl {
  private deviceId = ''
  private info: { deviceId: string; hostname: string; os: string; ip: string } | null = null
  private pc: RTCPeerConnection | null = null
  /** 常驻输出流：占位轨 + 采集轨共用，连接建立一次 */
  private outStream = new MediaStream()
  private videoSender: RTCRtpSender | null = null
  private audioSender: RTCRtpSender | null = null
  /** 当前实际采集的轨（非占位），切换时 stop 旧轨 */
  private activeVideo: MediaStreamTrack | null = null
  private activeAudio: MediaStreamTrack | null = null
  private activeDeviceId = ''
  private connected = false
  private unsubs: Array<() => void> = []

  /** 渲染进程启动时调用一次：订阅 dev 事件（注册/心跳/系统上报已收敛到主进程 sys-report，此处只做被控采集） */
  init(): void {
    if (this.unsubs.length > 0) return
    window.pantry.devGetInfo().then((info) => {
      this.info = info
      this.deviceId = info.deviceId
      console.log(`[remote] 本机信息 deviceId=${info.deviceId} hostname=${info.hostname} ip=${info.ip} os=${info.os}`)
    }).catch((e) => console.warn('[remote] devGetInfo 失败（被控端将无法被查看）', e))

    this.unsubs.push(window.pantry.onDevView((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.enumerate() }))
    this.unsubs.push(window.pantry.onDevEnumerate((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.enumerate() }))
    this.unsubs.push(window.pantry.onDevStart((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.startCapture(d as DevStartPayload) }))
    this.unsubs.push(window.pantry.onDevStop((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.stopCapture() }))
    this.unsubs.push(window.pantry.onDevSignal((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.handleSignal(d.signal as DevSignalPayload) }))
  }

  destroy(): void {
    this.stopCapture()
    this.unsubs.forEach((u) => u())
    this.unsubs = []
  }

  // ── 设备枚举上报 ───────────────────────────────────────
  private async enumerate(): Promise<void> {
    if (!this.deviceId) return
    try {
      const cams = (await VideoStream.GetVideoDevices()).map((d) => ({ id: d.deviceId, label: d.label || '摄像头' }))
      const mics = (await VideoStream.GetAudioDevices()).map((d) => ({ id: d.deviceId, label: d.label || '麦克风' }))
      await window.pantry.devDevices(this.deviceId, cams, mics)
      console.log(`[remote] 上报设备 cams=${cams.length} mics=${mics.length}`)
    } catch (e) {
      console.warn('[remote] 枚举设备失败', e)
    }
  }

  // ── 占位轨（连接建立时挂上，之后纯 replaceTrack 无需 renegotiate） ──
  private placeholderVideoTrack(): MediaStreamTrack {
    try {
      const s = VideoStream.GetEmptyVideoStream()
      const t = s.getVideoTracks()[0]
      if (t) return t
    } catch { /* 忽略 */ }
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.captureStream(15).getVideoTracks()[0]
  }
  private placeholderAudioTrack(): MediaStreamTrack {
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    return dest.stream.getAudioTracks()[0]
  }

  // ── 建立一次会话（PC + 占位轨 + offer），后续只替换轨道 ──
  private async ensureSession(d: DevStartPayload): Promise<boolean> {
    if (this.connected && this.pc) return true
    const ice = (d.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }]) as RTCIceServer[]
    this.stopCapture() // 清理旧会话残余
    this.activeDeviceId = d.deviceId ?? ''
    try {
      this.pc = new RTCPeerConnection({ iceServers: ice })
    } catch (e) {
      console.warn('[remote] RTCPeerConnection 创建失败', e)
      return false
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) window.pantry.devSignal(this.activeDeviceId, { type: 'candidate', sdp: undefined, candidate: ev.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => console.log('[remote] connectionState=', this.pc?.connectionState)
    // 占位轨：保证 video/audio sender 常驻，后续 replaceTrack
    const vp = this.placeholderVideoTrack()
    const ap = this.placeholderAudioTrack()
    this.outStream.addTrack(vp)
    this.outStream.addTrack(ap)
    this.videoSender = this.pc.addTrack(vp, this.outStream)
    this.audioSender = this.pc.addTrack(ap, this.outStream)
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await window.pantry.devSignal(this.activeDeviceId, { type: offer.type, sdp: offer.sdp, candidate: undefined })
    console.log('[remote] 会话建立，已发送初始 offer（占位轨 video/audio）')
    this.connected = true
    return true
  }

  // ── 替换对应 kind 的轨道（保留其它，不重建连接） ──
  private replaceVideo(track: MediaStreamTrack | null): void {
    if (track && !this.outStream.getTracks().includes(track)) this.outStream.addTrack(track)
    if (this.videoSender) { try { void this.videoSender.replaceTrack(track) } catch (e) { console.warn('[remote] replaceVideo 失败', e) } }
    if (this.activeVideo && this.activeVideo !== track) { this.activeVideo.stop() }
    this.activeVideo = track
    console.log('[remote] 视频轨已替换 kind=', this.activeVideo?.kind ?? 'null')
  }
  private replaceAudio(track: MediaStreamTrack | null): void {
    if (track && !this.outStream.getTracks().includes(track)) this.outStream.addTrack(track)
    if (this.audioSender) { try { void this.audioSender.replaceTrack(track) } catch (e) { console.warn('[remote] replaceAudio 失败', e) } }
    if (this.activeAudio && this.activeAudio !== track) { this.activeAudio.stop() }
    this.activeAudio = track
    console.log('[remote] 音频轨已替换 kind=', this.activeAudio?.kind ?? 'null')
  }

  // ── 采集 + 合并到常驻流 ──
  private async startCapture(d: DevStartPayload): Promise<void> {
    const kind = d.kind
    const ok = await this.ensureSession(d)
    if (!ok) return
    try {
      if (kind === 'mic') {
        const s = await VideoStream.GetAudioStream(typeof d.device === 'string' ? d.device : undefined)
        this.replaceAudio(s.getAudioTracks()[0] ?? null)
      } else if (kind === 'camera') {
        const s = await VideoStream.GetCameraStream(typeof d.device === 'string' ? d.device : undefined)
        this.replaceVideo(s.getVideoTracks()[0] ?? null)
      } else if (kind === 'screen') {
        // 屏幕 + 系统声音（audio: loopback，由主进程 setDisplayMediaRequestHandler 提供）
        const s = await (navigator.mediaDevices as unknown as { getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream> })
          .getDisplayMedia({ video: true, audio: true })
        this.replaceVideo(s.getVideoTracks()[0] ?? null)
        this.replaceAudio(s.getAudioTracks()[0] ?? null)
      } else {
        console.warn('[remote] 未知采集类型', kind)
        return
      }
    } catch (e) {
      console.warn(`[remote] 采集 ${kind} 失败`, e)
      await window.pantry.devSignal(this.activeDeviceId, { type: 'error', sdp: undefined, candidate: String((e as Error)?.message ?? e) })
    }
  }

  private async handleSignal(signal: DevSignalPayload): Promise<void> {
    if (!this.pc) return
    try {
      if (signal.type === 'answer' && signal.sdp) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        console.log('[remote] 已设置远端 answer')
      } else if (signal.candidate) {
        try {
          await this.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
        } catch { /* 忽略候选时序 */ }
      }
    } catch (e) {
      console.warn('[remote] 处理信令失败', e)
    }
  }

  // ── 停止 ───────────────────────────────────────────────
  private stopCapture(): void {
    if (this.pc) {
      this.pc.onicecandidate = null
      this.pc.onconnectionstatechange = null
      this.pc.close()
      this.pc = null
    }
    this.outStream.getTracks().forEach((t) => t.stop())
    this.outStream = new MediaStream()
    if (this.activeVideo) { this.activeVideo.stop(); this.activeVideo = null }
    if (this.activeAudio) { this.activeAudio.stop(); this.activeAudio = null }
    this.videoSender = null
    this.audioSender = null
    this.connected = false
    this.activeDeviceId = ''
  }
}

export default new RemoteControl()
