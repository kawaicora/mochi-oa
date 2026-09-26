/**
 * VideoStream — 本地媒体管理单例。
 * 管理摄像头 / 麦克风 / 屏幕共享 / 空轨占位流，供 WebRTC 引擎使用。
 * 空视频轨由 canvas 实时绘制占位图，不依赖外部图片资源。
 */

class VideoStream {
  /** 当前本地流（绑定到 RTCPeerConnection 和本地预览 video 元素） */
  public stream: MediaStream = new MediaStream()

  private videoElement: HTMLVideoElement | null = null

  // 占位图 canvas 句柄（用于空视频轨持续绘制）
  private placeholderCanvas: HTMLCanvasElement | null = null
  private placeholderCtx: CanvasRenderingContext2D | null = null
  private placeholderStream: MediaStream | null = null
  private placeholderTimer: number | null = null

  // 静音空音频
  private silentAudioCtx: AudioContext | null = null
  private silentDest: MediaStreamAudioDestinationNode | null = null

  // ─── 本地预览 ──────────────────────────────────────────

  SetVideoElement(el: HTMLVideoElement | null): void {
    this.videoElement = el
    if (el) {
      // 仅在需要时设置 srcObject，避免重复赋值导致视频重载闪烁
      if (el.srcObject !== this.stream) el.srcObject = this.stream
      el.muted = true
      void el.play().catch(() => { /* 自动播放可能被浏览器拦截，忽略 */ })
    }
  }

  // ─── 当前轨道 ──────────────────────────────────────────

  GetCurrentVideoTrack(): MediaStreamTrack | null {
    return this.stream.getVideoTracks()[0] ?? null
  }

  GetCurrentAudioTrack(): MediaStreamTrack | null {
    return this.stream.getAudioTracks()[0] ?? null
  }

  // ─── 切换流 ───────────────────────────────────────────

  /** 用新的视频流替换当前视频轨（音频轨不动），返回新视频轨 */
  async UpdateVideoStream(stream: MediaStream): Promise<MediaStreamTrack | null> {
    const old = this.GetCurrentVideoTrack()
    if (old) {
      old.stop()
      this.stream.removeTrack(old)
    }
    const track = stream.getVideoTracks()[0] ?? null
    if (track) this.stream.addTrack(track)
    this._bindVideoElement()
    return track
  }

  /** 用新的音频流替换当前音频轨（视频轨不动），返回新音频轨 */
  async UpdateAudioStream(stream: MediaStream): Promise<MediaStreamTrack | null> {
    const old = this.GetCurrentAudioTrack()
    if (old) {
      old.stop()
      this.stream.removeTrack(old)
    }
    const track = stream.getAudioTracks()[0] ?? null
    if (track) this.stream.addTrack(track)
    return track
  }

  // ─── 采集 ─────────────────────────────────────────────

  /** 摄像头：deviceId 可选（"default"=不指定，用系统默认）；直接采原始分辨率，不做降级/重采样 */
  async GetCameraStream(deviceId?: string): Promise<MediaStream> {
    const wantExact = !!deviceId && deviceId !== 'default'
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: wantExact ? { deviceId: { exact: deviceId } } : true,
        audio: false
      })
    } catch (e) {
      if (wantExact) {
        // 指定设备不可用（如另一台电脑无此设备）→ 回退系统默认
        return navigator.mediaDevices.getUserMedia({ video: true, audio: false })
      }
      throw e
    }
  }

  /** 麦克风：deviceId 可选；默认 48kHz / 16bit / 2ch 无处理（乐队/演出级音质） */
  async GetAudioStream(deviceId?: string, opts?: { sampleRate?: number; channelCount?: number }): Promise<MediaStream> {
    const sr = opts?.sampleRate ?? 48000
    const ch = opts?.channelCount ?? 2
    const wantExact = !!deviceId && deviceId !== 'default'
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: wantExact ? { exact: deviceId } : undefined,
          sampleRate: sr,
          channelCount: ch,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false
        }
      })
    } catch (e) {
      if (wantExact) {
        // 指定麦克风不可用 → 回退系统默认
        return navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: sr,
            channelCount: ch,
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false
          }
        })
      }
      throw e
    }
  }

  /** 屏幕共享：采集原始分辨率，不降级；不采集系统音频（主进程已注册 getDisplayMedia 处理器） */
  async GetScreenStream(): Promise<MediaStream> {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      throw new Error('当前环境不支持屏幕共享')
    }
    return navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: false
    })
  }

  /** 音频输出设备（供 <video>/<audio> setSinkId 切换扬声器） */
  async GetAudioOutputDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audiooutput')
  }

  /** 给指定播放元素设置音频输出设备（扬声器切换）；不支持时静默 */
  SetSinkId(el: HTMLMediaElement, deviceId: string): void {
    if (deviceId && typeof el.setSinkId === 'function') {
      void el.setSinkId(deviceId).catch(() => { /* 忽略 */ })
    }
  }

  // ─── 空轨占位 ──────────────────────────────────────────

  /**
   * 空视频流：canvas 绘制深色背景 + 麦克风图标 + "仅语音通话" 文字。
   * 不依赖外部图片，所有路径均 resolve，不会 reject 卡死。
   */
  GetEmptyVideoStream(): MediaStream {
    const cur = this.placeholderStream
    const curTrack = cur?.getVideoTracks()[0]
    if (cur && curTrack && curTrack.readyState !== 'ended') return cur
    // 占位流轨道已被停止（如之前 UpdateVideoStream 曾 stop 它）→ 重建，避免加入死轨导致本地黑屏/闪烁
    if (this.placeholderTimer !== null) { clearInterval(this.placeholderTimer); this.placeholderTimer = null }
    this.placeholderCanvas = null
    this.placeholderCtx = null
    this.placeholderStream = null

    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')!
    this.placeholderCanvas = canvas
    this.placeholderCtx = ctx

    this._drawPlaceholder()
    // 每 500ms 重绘一次（保持动画/文字清晰）
    this.placeholderTimer = window.setInterval(() => this._drawPlaceholder(), 500)

    this.placeholderStream = canvas.captureStream(15)
    return this.placeholderStream
  }

  private _drawPlaceholder(): void {
    const ctx = this.placeholderCtx
    const canvas = this.placeholderCanvas
    if (!ctx || !canvas) return

    // 深色背景
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    // 居中圆形麦克风图标背景
    const cx = canvas.width / 2
    const cy = canvas.height / 2 - 40
    const r = 60
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.fillStyle = '#2d2d44'
    ctx.fill()

    // 人像 LOGO（剪影：头 + 肩部）
    ctx.fillStyle = '#8888aa'
    // 头
    ctx.beginPath()
    ctx.arc(cx, cy - 20, 18, 0, Math.PI * 2)
    ctx.fill()
    // 躯干 / 肩部（上半圆弧）
    ctx.beginPath()
    ctx.arc(cx, cy + 36, 33, Math.PI * 1.06, Math.PI * -0.06)
    ctx.closePath()
    ctx.fill()

    // 文字 "仅语音通话"
    ctx.fillStyle = '#aaaaaa'
    ctx.font = '28px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillText('仅语音通话', cx, cy + 80)
  }

  /** 空音频流：静音 AudioBufferSource 输出 */
  GetEmptyAudioStream(): MediaStream {
    if (this.silentDest) return this.silentDest.stream
    this.silentAudioCtx = new AudioContext()
    this.silentDest = this.silentAudioCtx.createMediaStreamDestination()
    // 保持 ctx 不挂起，否则输出静音
    return this.silentDest.stream
  }

  /** 同时获取空视频 + 空音频 */
  GetEmptyVideoAndAudioStream(): MediaStream {
    const vs = this.GetEmptyVideoStream()
    const as = this.GetEmptyAudioStream()
    const mixed = new MediaStream()
    vs.getTracks().forEach((t) => mixed.addTrack(t))
    as.getTracks().forEach((t) => mixed.addTrack(t))
    return mixed
  }

  // ─── 设备枚举 ─────────────────────────────────────────

  async GetAudioDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'audioinput')
  }

  async GetVideoDevices(): Promise<MediaDeviceInfo[]> {
    const all = await navigator.mediaDevices.enumerateDevices()
    return all.filter((d) => d.kind === 'videoinput')
  }

  // ─── 清理 ─────────────────────────────────────────────

  Destroy(): void {
    // 停止所有轨道
    this.stream.getTracks().forEach((t) => t.stop())
    this.stream = new MediaStream()

    // 停止占位 canvas
    if (this.placeholderTimer !== null) {
      clearInterval(this.placeholderTimer)
      this.placeholderTimer = null
    }
    this.placeholderCanvas = null
    this.placeholderCtx = null
    this.placeholderStream = null

    // 关闭静音 AudioContext
    if (this.silentAudioCtx) {
      void this.silentAudioCtx.close()
      this.silentAudioCtx = null
      this.silentDest = null
    }

    if (this.videoElement) {
      this.videoElement.srcObject = null
      this.videoElement = null
    }
  }

  private _bindVideoElement(): void {
    if (this.videoElement && this.videoElement.srcObject !== this.stream) {
      this.videoElement.srcObject = this.stream
      void this.videoElement.play().catch(() => { /* ignore */ })
    }
  }
}

export default new VideoStream()
