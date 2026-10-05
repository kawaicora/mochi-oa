export interface VoiceAvatarOptions {
  size?: number
  avatar?: string
}
export interface VoiceSpectrumConfig {
  /** FFT 大小，必须是 32~32768 之间的 2 的整数次幂 */
  fftSize: number
  /** 频谱显示范围 */
  minHz: number
  maxHz: number
  /** 每个半圆的频谱柱数量 */
  barCount: number
  /** 频谱动态范围 */
  minDb: number
  maxDb: number
  multiplier : number,
  /** Attack / Release，单位为秒 */
  attack: number
  release: number
  /** 频谱环外观 */
  innerOffset: number
  outerOffset: number
  lineWidth: number
  /** Canvas 帧率 */
  fps: number
}

export class VoiceAvatarSpectrum {
  private readonly config: VoiceSpectrumConfig
  constructor(config: Partial<VoiceSpectrumConfig> = {}) {
    this.config = {
      fftSize: 2048,
      minHz: 20,
      maxHz: 2000,
      barCount: 180,
      multiplier : 2.0,
      minDb: -80,
      maxDb: 0,
      attack: 0,
      release: 0,
      innerOffset: 5,
      outerOffset: 80,
      lineWidth: 8,
      fps: 60,
      ...config,
    }
  }

  // ============================================================
  // 公共 API
  // ============================================================
  /**
   * 生成"头像+频谱"视频流（canvas）：圆形头像 + 左右声道实时环形频谱。
   * 不绘制名字；无摄像头时作为视频轨，本地与远端同步显示。
   */
  GetVoiceAvatarStream(
    audioStream: MediaStream | null,
    opts: { size?: number; avatar?: string } = {}
  ): MediaStream | null {
    const track = audioStream?.getAudioTracks()[0]
    if (!track) return null

    const h = opts.size ?? 1080
    const w = Math.round((h * 16) / 9)
    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = w * dpr
    canvas.height = h * dpr
    const g = canvas.getContext('2d')!
    let timerId: number | null = null
    let running = true
    let audioCtx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let splitter: ChannelSplitterNode | null = null
    let analyserL: AnalyserNode | null = null
    let analyserR: AnalyserNode | null = null

    // 固定参数，提升到外层，避免重复创建
    const chunk = 4096;
    const limitTopHz = 2000;
    let dataL = new Uint8Array(0)
    let dataR = new Uint8Array(0)
    // ========= GC优化：平滑数组只分配一次 =========
    let smoothL = new Float32Array(0)
    let smoothR = new Float32Array(0)
    let avatarImg: HTMLImageElement | null = null

    // ========= GC优化：头像背景渐变【只创建一次，不再每帧新建】 =========
    const cx = w / 2
    const cy = h / 2
    const faceR = Math.round(h * 0.36)
    const avatarGrad = g.createLinearGradient(cx - faceR, cy - faceR, cx + faceR, cy + faceR)
    avatarGrad.addColorStop(0, '#1677ff')
    avatarGrad.addColorStop(1, '#5cb6ff')

    // ========= GC优化：颜色缓存，避免循环内 string.replace =========
    const alphaCache = new Map<number, string>()
    const getColorL = (v: number): string => {
      const a = 0.2 + v * 0.65
      const key = Math.round(a * 100)
      let c = alphaCache.get(key)
      if (!c) {
        c = `rgba(56,132,255,${a.toFixed(2)})`
        alphaCache.set(key, c)
      }
      return c
    }
    const getColorR = (v: number): string => {
      const a = 0.2 + v * 0.65
      const key = Math.round(a * 100)
      let c = alphaCache.get(key)
      if (!c) {
        c = `rgba(0,200,180,${a.toFixed(2)})`
        alphaCache.set(key, c)
      }
      return c
    }

    try {
      audioCtx = new AudioContext()
      source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      splitter = audioCtx.createChannelSplitter(2)
      source.connect(splitter)
      analyserL = audioCtx.createAnalyser()
      analyserL.fftSize = chunk
      analyserL.smoothingTimeConstant = 0.0
      analyserL.minDecibels = this.config.minDb
      analyserL.maxDecibels = this.config.maxDb
      analyserR = audioCtx.createAnalyser()
      analyserR.fftSize = chunk
      analyserR.smoothingTimeConstant = 0.0
      analyserR.minDecibels = this.config.minDb
      analyserR.maxDecibels = this.config.maxDb
      splitter.connect(analyserL, 0)
      splitter.connect(analyserR, 1)
      if (audioCtx.state === 'suspended') void audioCtx.resume()

      dataL = new Uint8Array(analyserL.frequencyBinCount)
      dataR = new Uint8Array(analyserR.frequencyBinCount)
      smoothL = new Float32Array(analyserL.frequencyBinCount)
      smoothR = new Float32Array(analyserR.frequencyBinCount)
    } catch {
      // 音频分析不可用：仍绘制静态头像
    }

    if (opts.avatar) {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => { avatarImg = img }
      img.onerror = () => { avatarImg = null }
      img.src = opts.avatar
    }

    // attack/release 系数，预计算一次
    const dt = 1000 / this.config.fps / 1000
    const attackCoef = dt / (this.config.attack + dt)
    const releaseCoef = dt / (this.config.release + dt)

    // 半圆环频谱：复用变量，不循环内创建临时字符串
    const drawHalf = (
      data: Uint8Array,
      smoothBuf: Float32Array,
      startA: number,
      endA: number,
      getColor: (v: number) => string,
      faceRadius: number
    ): void => {
      const inner = faceRadius + this.config.innerOffset
      const outer = faceRadius + this.config.outerOffset
      const rate = audioCtx?.sampleRate ?? 48000
      const n = Math.min(data.length, Math.max(1, Math.floor((limitTopHz / rate) * chunk)))
      let i: number
      let vRaw: number
      let v: number
      let len: number
      let a: number
      let x1: number, y1: number, x2: number, y2: number

      g.lineWidth = this.config.lineWidth
      g.lineCap = 'round'

      for (i = 0; i < n; i++) {
        vRaw = data[i] / 255
        // 攻击释放平滑
        if (vRaw > smoothBuf[i]) {
          smoothBuf[i] = smoothBuf[i] + (vRaw - smoothBuf[i]) * attackCoef
        } else {
          smoothBuf[i] = smoothBuf[i] + (vRaw - smoothBuf[i]) * releaseCoef
        }
        v = smoothBuf[i] * this.config.multiplier
        len = inner + v * (outer - inner)
        a = startA + (i / n) * (endA - startA)

        x1 = cx + Math.cos(a) * inner
        y1 = cy + Math.sin(a) * inner
        x2 = cx + Math.cos(a) * len
        y2 = cy + Math.sin(a) * len

        g.strokeStyle = getColor(v)
        g.beginPath()
        g.moveTo(x1, y1)
        g.lineTo(x2, y2)
        g.stroke()
      }
    }

    const drawFrame = (): void => {
      if (!running) return
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.clearRect(0, 0, w, h)

      // 中间头像绘制
      if (avatarImg && avatarImg.complete && avatarImg.naturalWidth > 0) {
        g.save()
        g.beginPath()
        g.arc(cx, cy, faceR, 0, Math.PI * 2)
        g.clip()
        g.drawImage(avatarImg, cx - faceR, cy - faceR, faceR * 2, faceR * 2)
        g.restore()
      } else {
        g.beginPath()
        g.arc(cx, cy, faceR, 0, Math.PI * 2)
        g.fillStyle = avatarGrad
        g.fill()
      }

      // 左右声道频谱环
      if (analyserL && analyserR) {
        analyserL.getByteFrequencyData(dataL)
        analyserR.getByteFrequencyData(dataR)
        drawHalf(dataL, smoothL, Math.PI / 2, (Math.PI * 3) / 2, getColorL, faceR)
        drawHalf(dataR, smoothR, -Math.PI / 2, Math.PI / 2, getColorR, faceR)
      }
    }

    drawFrame()
    timerId = window.setInterval(drawFrame, 1000 / this.config.fps)
    let stream: MediaStream
    try {
      stream = canvas.captureStream(this.config.fps)
    } catch {
      running = false
      if (timerId) clearInterval(timerId)
      if (audioCtx) void audioCtx.close()
      return null
    }

    const stop = (): void => {
      running = false
      if (timerId) {
        clearInterval(timerId)
        timerId = null
      }
      source?.disconnect()
      splitter?.disconnect()
      analyserL?.disconnect()
      analyserR?.disconnect()
      if (audioCtx) void audioCtx.close()
    }

    return stream
  }

  // ============================================================
  // 数学工具
  // ============================================================
  private clamp(
    value: number,
    min: number,
    max: number,
  ): number {
    return Math.max(min, Math.min(max, value))
  }
}
