/**
 * ScrollingSpectrum — 滚动频谱（瀑布频谱图，类 FL Studio Wave Candy Spectrum）。
 * 输入音频流 → 实时 FFT → 按频率（对数刻度）绘制彩色频谱带，随时间整体向左滚动，
 * 输出为可发送给远端的 MediaStream（canvas.captureStream）。
 *
 * 参数语义参考 Wave Candy：
 *  - fftSize        = Chunk（FFT 块大小，2 的整数次幂，最大分辨率可达 2048 频段）
 *  - scrollSpeed    = 滚动速度（每帧左移像素）
 *  - minHz / maxHz  = 频率显示范围（C2 起始 ~ C9 结束，对数刻度）
 *  - minDb / maxDb  = 分贝动态范围
 */

export interface ScrollingSpectrumOptions {
  width?: number
  height?: number
  /** FFT 大小（Chunk），2 的整数次幂，默认 2048 */
  fftSize?: number
  /** 滚动速度：每帧向左滚动的像素数，默认 6 */
  scrollSpeed?: number
  /** 频率显示范围（对数刻度） */
  minHz?: number
  maxHz?: number
  /** 分贝动态范围 */
  minDb?: number
  maxDb?: number
  /** 背景色 */
  background?: string
  /** Canvas 帧率（captureStream fps），默认 30 */
  fps?: number
}

export class ScrollingSpectrum {
  /**
   * 生成"滚动频谱"视频流。
   * 无音频轨时返回 null；音频分析不可用时仍输出滚动频谱（空数据静默背景）。
   */
  GetScrollingSpectrumStream(
    audioStream: MediaStream | null,
    opts: ScrollingSpectrumOptions = {}
  ): MediaStream | null {
    const track = audioStream?.getAudioTracks()[0]
    if (!track) return null

    const {
      width = 1280,
      height = 720,
      fftSize = 2048,
      scrollSpeed = 6,
      minHz = 20,
      maxHz = 16000,
      minDb = -90,
      maxDb = -10,
      background = '#0b0f1a',
      fps = 30,
    } = opts

    const dpr = window.devicePixelRatio || 1
    const canvas = document.createElement('canvas')
    canvas.width = width * dpr
    canvas.height = height * dpr
    const g = canvas.getContext('2d')!
    g.setTransform(dpr, 0, 0, dpr, 0, 0)

    // ─── 音频分析 ────────────────────────────────────────
    let audioCtx: AudioContext | null = null
    let source: MediaStreamAudioSourceNode | null = null
    let analyser: AnalyserNode | null = null
    let data = new Uint8Array(0)
    let rate = 48000
    try {
      audioCtx = new AudioContext()
      source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = fftSize
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      rate = audioCtx.sampleRate
      data = new Uint8Array(analyser.frequencyBinCount)
      if (audioCtx.state === 'suspended') void audioCtx.resume()
    } catch {
      // 分析不可用：仍输出滚动频谱（空数据静默背景）
    }

    const binCount = fftSize / 2
    const logMin = Math.log(Math.max(1, minHz))
    const logMax = Math.log(Math.max(logMin + 1e-3, maxHz))

    // db → 热力色：蓝(弱)→青→绿→黄→红(强)
    const dbColor = (db: number): string => {
      const t = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)))
      const hue = (1 - t) * 240
      const light = 30 + t * 50
      return `hsl(${hue.toFixed(1)}, 100%, ${light.toFixed(1)}%)`
    }

    let running = true
    let timer = 0

    const drawFrame = (): void => {
      if (!running) return
      // 1) 整体左移（滚动）
      g.drawImage(canvas, -scrollSpeed, 0)
      // 2) 清出右侧空区（背景）
      g.fillStyle = background
      g.fillRect(width - scrollSpeed, 0, scrollSpeed, height)

      // 3) 取当前帧频谱
      if (analyser) analyser.getByteFrequencyData(data)

      // 4) 在右侧新列绘制频谱瀑布：y=频率(对数，顶部高频底部低频)，颜色=幅度
      for (let py = 0; py < height; py++) {
        const freq = Math.exp(logMax - (py / height) * (logMax - logMin))
        const bin = Math.round((freq / rate) * binCount)
        if (bin < 0 || bin >= data.length) continue
        const v = data[bin] / 255
        if (v <= 0.005) continue
        const db = minDb + v * (maxDb - minDb)
        g.fillStyle = dbColor(db)
        g.fillRect(width - scrollSpeed, py, scrollSpeed, 1)
      }
    }

    // setInterval 驱动（rAF 在窗口后台/最小化会被浏览器暂停，interval 持续更新保证远端收到流）
    drawFrame()
    timer = window.setInterval(drawFrame, Math.max(16, Math.round(1000 / fps)))

    let stream: MediaStream
    try {
      stream = canvas.captureStream(fps)
    } catch {
      running = false
      clearInterval(timer)
      source?.disconnect()
      if (audioCtx) void audioCtx.close()
      return null
    }

    // 轨道结束自动清理
    const vt = stream.getVideoTracks()[0]
    const cleanup = (): void => {
      if (!running) return
      running = false
      clearInterval(timer)
      source?.disconnect()
      analyser?.disconnect()
      if (audioCtx) void audioCtx.close()
      stream.getTracks().forEach((t) => t.stop())
    }
    vt?.addEventListener('ended', cleanup)

    return stream
  }
}
