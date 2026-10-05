/**
 * ScrollingSpectrum — 瀑布频谱
 * 修复：TS Uint8Array ArrayBuffer 类型报错 + getByteFrequencyData异常捕获
 */
export interface ScrollingSpectrumOptions {
  width?: number
  height?: number
  fftSize?: number
  scrollSpeed?: number
  minDb?: number
  maxDb?: number
  multiplier?: number
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
  private rafId: number | null = null
  private intervalId: NodeJS.Timeout | null = null
  private audioCtx: AudioContext | null = null
  private source: MediaStreamAudioSourceNode | null = null
  private analyser: AnalyserNode | null = null
  private stream: MediaStream | null = null
  private canvas: HTMLCanvasElement | null = null
  private ctx: CanvasRenderingContext2D | null = null
  private offscreenCanvas: HTMLCanvasElement | null = null
  private offCtx: CanvasRenderingContext2D | null = null
  private dpr = 1
  // ========= TS类型修复 =========
  private data: Uint8Array<ArrayBuffer> = new Uint8Array(0) as Uint8Array<ArrayBuffer>
  private sampleRate = 48000

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
      minDb = -70,
      maxDb = 0,
      multiplier = 2.5,
      background = '#0b0f1a',
      fps = 15,
      pianoWidthRatio = 0.08,
      devicePixelRatio = window.devicePixelRatio ?? 1,
    } = opts
    this.dpr = devicePixelRatio
    // 主画布
    this.canvas = document.createElement('canvas')
    this.canvas.width = width * this.dpr
    this.canvas.height = height * this.dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx = this.canvas.getContext('2d')!
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    // 离屏画布：缓存瀑布历史画面
    const waterfallCssW = width * (1 - pianoWidthRatio)
    this.offscreenCanvas = document.createElement('canvas')
    this.offscreenCanvas.width = waterfallCssW * this.dpr
    this.offscreenCanvas.height = height * this.dpr
    this.offCtx = this.offscreenCanvas.getContext('2d')!
    this.offCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    try {
      this.audioCtx = new AudioContext()
      this.source = this.audioCtx.createMediaStreamSource(new MediaStream([audioTrack]))
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = fftSize
      this.analyser.smoothingTimeConstant = 0
      this.analyser.minDecibels = minDb
      this.analyser.maxDecibels = maxDb
      this.source.connect(this.analyser)
      this.sampleRate = this.audioCtx.sampleRate
      // ========= TS类型修复：断言为Uint8Array<ArrayBuffer> =========
      this.data = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>
      if (this.audioCtx.state === 'suspended') void this.audioCtx.resume()
    } catch (e) {
      console.error("Audio init error:", e)
      return null
    }
    const binCount = fftSize / 2
    const logC1 = Math.log(FREQ_C1)
    const logC10 = Math.log(FREQ_C10)
    // 映射：C10 → py=0(顶部)，C1 → py=cssH(底部)
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
      if (!this.running || !this.canvas || !this.ctx || !this.offscreenCanvas || !this.offCtx) return
      // this.rafId = requestAnimationFrame(drawFrame)
      const cssW = width
      const cssH = height
      const pianoW = cssW * pianoWidthRatio
      const pianoX = cssW - pianoW
      const waterfallW = cssW - pianoW
      // ========== getByteFrequencyData 异常捕获 + 长度校验 ==========
      if (this.analyser) {
        if (this.data.length !== this.analyser.frequencyBinCount) {
          this.data = new Uint8Array(this.analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>
        }
        try {
          this.analyser.getByteFrequencyData(this.data)
        } catch (err) {
          return
        }
      }
      // ========== 1. 离屏画布：旧画面左移 ==========
      this.offCtx.drawImage(
        this.offscreenCanvas,
        scrollSpeed, 0, waterfallW - scrollSpeed, cssH,
        0, 0, waterfallW - scrollSpeed, cssH
      )
      // 清空右侧新竖条区域
      this.offCtx.fillStyle = background
      this.offCtx.fillRect(waterfallW - scrollSpeed, 0, scrollSpeed, cssH)
    
// ========== 2. 在离屏画布右侧绘制新频谱竖线（梯形面片填充，无全局渐变，保留细节） ==========
const halfW = scrollSpeed / 2
const newX = waterfallW - halfW
interface Point { py: number; v: number }
const points: Point[] = []
for (let bin = 0; bin < binCount; bin++) {
  const v = this.data[bin] / 255 * multiplier
  const binFreq = (bin / binCount) * (this.sampleRate / 2)
  const py = freqToPy(binFreq, cssH)
  points.push({ py, v })
}
// 按Y从小到大排序
points.sort((a,b) => a.py - b.py)

for (let i = 0; i < points.length - 1; i++) {
  const p0 = points[i]
  const p1 = points[i+1]
  const y0 = p0.py
  const y1 = p1.py
  const yMin = Math.min(y0, y1)
  const yMax = Math.max(y0, y1)
  const len = yMax - yMin
  if (len < 0.01) continue

  // 取两点幅值平均值作为梯形颜色
  const avgV = (p0.v + p1.v) / 2
  this.offCtx.fillStyle = dbColor(avgV)

  // 绘制梯形
  this.offCtx.beginPath()
  this.offCtx.moveTo(newX - halfW, y0)
  this.offCtx.lineTo(newX + halfW, y0)
  this.offCtx.lineTo(newX + halfW, y1)
  this.offCtx.lineTo(newX - halfW, y1)
  this.offCtx.closePath()
  this.offCtx.fill()
}


      // ========== 3. 主画布 ==========
      this.ctx.drawImage(this.offscreenCanvas, 0, 0)
      // 清空钢琴区
      this.ctx.fillStyle = background
      this.ctx.fillRect(pianoX, 0, pianoW, cssH)
      // ========== 4. 钢琴白键【修复半格偏移】 ==========
      this.ctx.fillStyle = '#f5f5f5'
      for (const midi of WHITE_KEYS) {
        // 键区间：midi-0.5 ~ midi+0.5，对齐频率区间边界
        const hzLow = midiToHz(midi - 0.5)
        const hzHigh = midiToHz(midi + 0.5)
        const pyLow = freqToPy(hzLow, cssH)
        const pyHigh = freqToPy(hzHigh, cssH)
        const top = Math.min(pyLow, pyHigh)
        const hh = Math.max(0, Math.abs(pyHigh - pyLow))
        if (hh < 0.1) continue
        this.ctx.fillRect(pianoX, top, pianoW, hh)
      }
      // ========== 5. 钢琴黑键【修复半格偏移】 ==========
      this.ctx.fillStyle = '#1a1a1a'
      for (const midi of BLACK_KEYS) {
        const hzLow = midiToHz(midi - 0.5)
        const hzHigh = midiToHz(midi + 0.5)
        const pyLow = freqToPy(hzLow, cssH)
        const pyHigh = freqToPy(hzHigh, cssH)
        const top = Math.min(pyLow, pyHigh)
        const hh = Math.max(0, Math.abs(pyHigh - pyLow))
        if (hh < 0.1) continue
        this.ctx.fillRect(pianoX + pianoW * 0.3, top, pianoW * 0.55, hh)
      }
      // ========== 6. Cx八度标签，文字放在音符区间中点 ==========
      this.ctx.fillStyle = '#b0b0b0'
      this.ctx.textBaseline = 'middle'
      this.ctx.font = '8px sans-serif'
      const octaves = [24, 36, 48, 60, 72, 84, 96, 108]
      for (const midi of octaves) {
        const hzMid = midiToHz(midi)
        const pyMid = freqToPy(hzMid, cssH)
        const oct = (midi - 24) / 12 + 1
        this.ctx.fillText(`C${oct}`, pianoX + pianoW * 0.72, pyMid)
      }
    }
    this.running = true
    // this.rafId = requestAnimationFrame(drawFrame)
    this.intervalId = setInterval(() => {
      if (this.running) drawFrame()
    }, 1000 / fps)
    try {
      this.stream = this.canvas.captureStream(fps)
    } catch (e) {
      console.error("captureStream error:", e)
      this.stop()
      return null
    }
    const videoTrack = this.stream.getVideoTracks()[0]
    videoTrack.addEventListener('ended', () => this.stop())
    return this.stream
  }

  Resize(width: number, height: number, pianoWidthRatio = 0.08): void {
    if (!this.canvas || !this.ctx || !this.offscreenCanvas || !this.offCtx) return
    const waterfallCssW = width * (1 - pianoWidthRatio)
    this.canvas.width = width * this.dpr
    this.canvas.height = height * this.dpr
    this.canvas.style.width = `${width}px`
    this.canvas.style.height = `${height}px`
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.offscreenCanvas.width = waterfallCssW * this.dpr
    this.offscreenCanvas.height = height * this.dpr
    this.offCtx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    this.offCtx.fillStyle = '#0b0f1a'
    this.offCtx.fillRect(0,0, waterfallCssW, height)
    this.ctx.fillStyle = '#0b0f1a'
    this.ctx.fillRect(0, 0, width, height)
  }

  stop() {
    this.running = false
    if (this.intervalId !== null) {
      clearInterval(this.intervalId)
      this.intervalId = null
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
    this.offscreenCanvas = null
    this.offCtx = null
  }
}
