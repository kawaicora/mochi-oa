/**
 * ScrollingSpectrum — 瀑布频谱
 * 规则：
 * 1. Y轴：顶部C10，底部C1，C1~C10对数拉伸填满画布高度
 * 2. 右侧钢琴标尺同步对齐，八度标签固定8px
 * 3. 无 minHz/maxHz，仅内部clamp限制区间
 */
export interface ScrollingSpectrumOptions {
  width?: number
  height?: number
  fftSize?: number
  scrollSpeed?: number
  minDb?: number
  maxDb?: number
  background?: string
  fps?: number
  pianoWidthRatio?: number
  devicePixelRatio?: number
}

function midiToHz(midiNote: number): number {
  return 440 * Math.pow(2, (midiNote - 69) / 12)
}

const MIDI_C1 = 24
const MIDI_C10 = 108
const FREQ_C1 = midiToHz(MIDI_C1)    // 32.7032 Hz
const FREQ_C10 = midiToHz(MIDI_C10)  // 16744.0362 Hz

function getMidiRangeKeys(startMidi: number, endMidi: number) {
  const white: number[] = []
  const black: number[] = []
  for (let m = startMidi; m <= endMidi; m++) {
    const mod = m % 12
    if ([0,2,4,5,7,9,11].includes(mod)) white.push(m)
    else black.push(m)
  }
  return { white, black }
}
const { white: WHITE_KEYS, black: BLACK_KEYS } = getMidiRangeKeys(MIDI_C1, MIDI_C10)

export class ScrollingSpectrum {
  private running = false
  private timer: number | null = null
  private audioCtx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private dpr = 1

  GetScrollingSpectrumStream(
    audioStream: MediaStream | null,
    opts: ScrollingSpectrumOptions = {}
  ): MediaStream | null {
    const audioTrack = audioStream?.getAudioTracks()[0]
    if (!audioTrack) return null

    const {
      width = 1280,
      height = 720,
      fftSize = 8192,
      scrollSpeed = 5,
      minDb = -120,
      maxDb = -10,
      background = '#0b0f1a',
      fps = 30,
      pianoWidthRatio = 0.08,
      devicePixelRatio = window.devicePixelRatio ?? 1,
    } = opts

    this.dpr = devicePixelRatio
    this.canvas = document.createElement('canvas')
    this.canvas.width = width * this.dpr
    this.canvas.height = height * this.dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)

    let data = new Uint8Array(0)
    let sampleRate = 48000
    try {
      this.audioCtx = new AudioContext()
      this.source = this.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]))
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = fftSize
      this.analyser.smoothingTimeConstant = 0
      this.analyser.minDecibels = minDb
      this.analyser.maxDecibels = maxDb
      this.source.connect(this.analyser)
      sampleRate = this.audioCtx.sampleRate
      data = new Uint8Array(this.analyser.frequencyBinCount)
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume()
    } catch { /* 音频失败保留画布流 */ }

    const binCount = fftSize / 2
    const logC1 = Math.log(FREQ_C1)
    const logC10 = Math.log(FREQ_C10)

    // ======================
    // 【最终正确映射】
    // FREQ_C10 → py = 0（画布顶部）
    // FREQ_C1  → py = cssH（画布底部）
    // ======================
    const freqToPy = (hz: number, cssH: number): number => {
      const clampedHz = Math.max(FREQ_C1, Math.min(FREQ_C10, hz))
      const logF = Math.log(clampedHz)
      return cssH * (logC10 - logF) / (logC10 - logC1)
    }

    const dbColor = (t: number): string => {
      const c = Math.max(0, Math.min(1, t))
      const r = 255 * Math.pow(c, 0.8)
      const g = 255 * Math.pow(Math.max(0, c - 0.35) / 0.65, 2)
      const b = 0
      const lum = 0.2 + 0.8 * Math.pow(c, 0.7)
      return `rgb(${Math.round(r * lum)}, ${Math.round(g * lum)}, ${Math.round(b * lum)})`
    }

    const drawFrame = () => {
      if (!this.running || !this.canvas || !this.ctx) return
      const cssW = this.canvas.width / this.dpr
      const cssH = this.canvas.height / this.dpr

      const pianoW = cssW * pianoWidthRatio
      const pianoX = cssW - pianoW
      const waterfallW = cssW - pianoW

      // 瀑布区域向左滚动，钢琴区域不参与滚动
      this.ctx.drawImage(
        this.canvas,
        scrollSpeed * this.dpr,
        0,
        waterfallW * this.dpr,
        cssH * this.dpr,
        0,
        0,
        waterfallW,
        cssH
      )

      // 清空新的竖条
      this.ctx.fillStyle = background
      this.ctx.fillRect(waterfallW - scrollSpeed, 0, scrollSpeed, cssH)
      // 清空钢琴区域，每帧重绘钢琴
      this.ctx.fillRect(pianoX, 0, pianoW, cssH)

      if (this.analyser) this.analyser.getByteFrequencyData(data)

      // 绘制瀑布频谱
      let lastPy: number | null = null
      for (let bin = 0; bin < binCount; bin++) {
        const v = data[bin] / 255 * 1.5
        if (v <= 0.005) continue
        const binFreq = (bin / binCount) * (sampleRate / 2)
        const py = freqToPy(binFreq, cssH)
        this.ctx.fillStyle = dbColor(v)
        if (lastPy !== null) {
          const y0 = Math.max(0, Math.min(cssH, lastPy))
          const y1 = Math.max(0, Math.min(cssH, py))
          const top = Math.min(y0, y1)
          const hh = Math.abs(y1 - y0)
          if (hh > 0.1) {
            this.ctx.fillRect(waterfallW - scrollSpeed, top, scrollSpeed, hh)
          }
        }
        lastPy = py
      }

      // 钢琴白键
      this.ctx.fillStyle = '#f5f5f5'
      for (const midi of WHITE_KEYS) {
        const hz = midiToHz(midi)
        const hzNext = midiToHz(midi + 1)
        const py = freqToPy(hz, cssH)
        const pyNext = freqToPy(hzNext, cssH)
        const top = Math.min(py, pyNext)
        const hh = Math.max(0, Math.abs(pyNext - py))
        if (hh < 0.1) continue
        this.ctx.fillRect(pianoX, top, pianoW, hh)
      }

      // 钢琴黑键
      this.ctx.fillStyle = '#1a1a1a'
      for (const midi of BLACK_KEYS) {
        const hz = midiToHz(midi)
        const hzNext = midiToHz(midi + 1)
        const py = freqToPy(hz, cssH)
        const pyNext = freqToPy(hzNext, cssH)
        const top = Math.min(py, pyNext)
        const hh = Math.max(0, Math.abs(pyNext - py))
        if (hh < 0.1) continue
        this.ctx.fillRect(pianoX + pianoW * 0.3, top, pianoW * 0.55, hh)
      }

      // Cx八度标签，固定8px字体
      this.ctx.fillStyle = '#b0b0b0'
      this.ctx.textBaseline = 'middle'
      this.ctx.font = '8px sans-serif'
      const octaves = [24, 36, 48, 60, 72, 84, 96, 108]
      for (const midi of octaves) {
        const hz = midiToHz(midi)
        const py = freqToPy(hz, cssH)
        const oct = (midi - 24) / 12 + 1
        this.ctx.fillText(`C${oct}`, pianoX + pianoW * 0.72, py)
      }
    }

    this.running = true
    this.timer = window.setInterval(drawFrame, Math.max(16, Math.round(1000 / fps)))
    try {
      this.stream = this.canvas.captureStream(fps)
    } catch {
      this.stop()
      return null
    }
    const videoTrack = this.stream.getVideoTracks()[0]
    videoTrack.addEventListener('ended', () => this.stop())
    return this.stream
  }

  Resize(width: number, height: number): void {
    if (!this.canvas || !this.ctx) return
    this.canvas.width = width * this.dpr
    this.canvas.height = height * this.dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.ctx.fillStyle = '#0b0f1a'
    this.ctx.fillRect(0, 0, width, height)
  }

  stop() {
    if (!this.running) return
    this.running = false
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    this.source?.disconnect()
    this.analyser?.disconnect()
    if (this.audioCtx) void this.audioCtx.close()
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop())
      this.stream = null
    }
    this.audioCtx = null
    this.source = null
    this.analyser = null
    this.canvas = null
    this.ctx = null
  }
}
