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

  /** 整体显示增益 */
  gainDb: number

  /** 频段增益 */
  bassGainDb: number
  midGainDb: number
  trebleGainDb: number

  /** 是否启用自然频率加权 */
  naturalWeight: boolean

  /** 每个八度的加权 dB */
  naturalWeightDbPerOctave: number

  /** 是否启用自动增益 */
  autoGain: boolean

  /** 自动增益目标及范围 */
  autoGainTarget: number
  autoGainMinDb: number
  autoGainMaxDb: number

  /** 频谱动态范围 */
  minDb: number
  maxDb: number

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

interface SpectrumState {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D

  width: number
  height: number
  dpr: number

  audioCtx: AudioContext | null
  source: MediaStreamAudioSourceNode | null
  splitter: ChannelSplitterNode | null

  analyserL: AnalyserNode | null
  analyserR: AnalyserNode | null

  // 显式指定 ArrayBuffer，兼容新版 TypeScript 的 TypedArray 泛型
  dataL: Float32Array<ArrayBuffer>
  dataR: Float32Array<ArrayBuffer>

  smoothL: Float32Array<ArrayBuffer>
  smoothR: Float32Array<ArrayBuffer>

  spectrumL: Float32Array<ArrayBuffer>
  spectrumR: Float32Array<ArrayBuffer>

  avatar: HTMLImageElement | null

  running: boolean
  timer: number | null

  autoGainDb: number
  lastFrameTime: number

  stream: MediaStream | null
  sourceTrack: MediaStreamTrack

  onEnded: () => void
}


interface SpectrumCache {
  stream: MediaStream
  track: MediaStreamTrack
  stop: () => void
}

export class VoiceAvatarSpectrum {

  private readonly config: VoiceSpectrumConfig

  constructor(config: Partial<VoiceSpectrumConfig> = {}) {
    this.config = {
      fftSize: 2048,

      minHz: 20,
      maxHz: 4000,
      barCount: 180,

      gainDb: 0,

      bassGainDb: 0,
      midGainDb: 0,
      trebleGainDb: 0,

      naturalWeight: true,
      naturalWeightDbPerOctave: -1,

      autoGain: true,
      autoGainTarget: 0.18,
      autoGainMinDb: -12,
      autoGainMaxDb: 24,

      minDb: -60,
      maxDb: 0,

      attack: 0.025,
      release: 0.16,

      innerOffset: 2,
      outerOffset: 80,
      lineWidth: 4,

      fps: 60,

      ...config,
    }

   
  }

  // ============================================================
  // 公共 API
  // ============================================================

  // ─── 频谱 + 头像（无摄像头时的默认视频轨）──────────────

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
    let raf = 0
    let running = true
    let audioCtx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let splitter: ChannelSplitterNode | null = null
    let analyserL: AnalyserNode | null = null
    let analyserR: AnalyserNode | null = null
    let dataL = new Uint8Array(0)
    let dataR = new Uint8Array(0)
    let avatarImg: HTMLImageElement | null = null
    let chunk = 4096;
    let limitTopHz = 4000;
    try {
      audioCtx = new AudioContext()
      source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      splitter = audioCtx.createChannelSplitter(2)
      source.connect(splitter)
      analyserL = audioCtx.createAnalyser()
      analyserL.fftSize = chunk
      analyserL.smoothingTimeConstant = 0.0
      analyserR = audioCtx.createAnalyser()
      analyserR.fftSize = chunk
      analyserR.smoothingTimeConstant = 0.0
      splitter.connect(analyserL, 0)
      splitter.connect(analyserR, 1)
      if (audioCtx.state === 'suspended') void audioCtx.resume()
      dataL = new Uint8Array(analyserL.frequencyBinCount)
      dataR = new Uint8Array(analyserR.frequencyBinCount)
    } catch {
      // 音频分析不可用：仍绘制静态头像
    }

    if (opts.avatar) {
      // crossOrigin img 直接加载（服务端已返回 Access-Control-Allow-Origin），保证头像画进 canvas
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => { avatarImg = img }
      img.onerror = () => { avatarImg = null }
      img.src = opts.avatar
    }

    // 半圆环频谱：把 data 均布到 [startA, endA]，径向高度随音量
    const drawHalf = (data: Uint8Array, startA: number, endA: number, color: string, faceR: number): void => {
      const inner = faceR + 2
      const outer = faceR + 80
      const rate = audioCtx?.sampleRate ?? 48000
      const n = Math.min(data.length, Math.max(1, Math.floor((limitTopHz / rate) * chunk)))
      for (let i = 0; i < n; i++) {
        const v = data[i] / 255//Math.min(1, (data[i] / 255) * 1.5)
        const len = inner + v * (outer - inner)
        const a = startA + (i / n) * (endA - startA)
        const x1 = w / 2 + Math.cos(a) * inner
        const y1 = h / 2 + Math.sin(a) * inner
        const x2 = w / 2 + Math.cos(a) * len
        const y2 = h / 2 + Math.sin(a) * len
        g.strokeStyle = color.replace('ALPHA', (0.2 + v * 0.65).toFixed(2))
        g.lineWidth = 4
        g.lineCap = 'round'
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
      const cx = w / 2
      const cy = h / 2
      const faceR = Math.round(h * 0.36)
      // 中间：有头像 → 绘制头像图；无头像 → 蓝色渐变圆（不绘制名字）
      if (avatarImg && avatarImg.complete && avatarImg.naturalWidth > 0) {
        g.save()
        g.beginPath()
        g.arc(cx, cy, faceR, 0, Math.PI * 2)
        g.clip()
        g.drawImage(avatarImg, cx - faceR, cy - faceR, faceR * 2, faceR * 2)
        g.restore()
      } else {
        const grad = g.createLinearGradient(cx - faceR, cy - faceR, cx + faceR, cy + faceR)
        grad.addColorStop(0, '#1677ff')
        grad.addColorStop(1, '#5cb6ff')
        g.beginPath()
        g.arc(cx, cy, faceR, 0, Math.PI * 2)
        g.fillStyle = grad
        g.fill()
      }
      // 左右声道频谱环
      if (analyserL && analyserR) {
        analyserL.getByteFrequencyData(dataL)
        analyserR.getByteFrequencyData(dataR)
        drawHalf(dataL, Math.PI / 2, (Math.PI * 3) / 2, 'rgba(56,132,255,ALPHA)', faceR)
        drawHalf(dataR, -Math.PI / 2, Math.PI / 2, 'rgba(0,200,180,ALPHA)', faceR)
      }
    }
    // 用 setInterval 驱动绘制：requestAnimationFrame 在窗口最小化/不可见时会被浏览器暂停，
    // 导致后台不更新、captureStream 无新帧、远程收不到数据；interval 后台持续运行
    drawFrame()
    raf = window.setInterval(drawFrame, 33)

    let stream: MediaStream
    try {
      stream = canvas.captureStream(30)
    } catch {
      running = false
      cancelAnimationFrame(raf)
      if (audioCtx) void audioCtx.close()
      return null
    }

    const stop = (): void => {
      running = false
      clearInterval(raf)
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