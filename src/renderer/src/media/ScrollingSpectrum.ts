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

  /** 自然加权：按频率补偿人耳等响（低频提升），默认开启 */
  naturalWeight?: boolean
  /** 自然加权斜率（dB/倍频程，负值=频率越高衰减越多，低频相对提升），默认 -4 */
  naturalWeightDbPerOctave?: number

  /** 增强频率 / 背景优化：细化频率线 + 高频有效频率加强 + 背景弱频率去除，默认开启 */
  enhancedFrequency?: boolean
  /** 高频加强起始频率，默认 1000 Hz */
  highBoostFromHz?: number
  /** 高频加强：自起始频率起每倍频程增强 dB（覆盖自然加权压制，使高频有效频率显示为红），默认 10 */
  highBoostDb?: number
  /** 背景弱频率门限（低于此 dB 不绘制，去除噪点）；缺省=minDb+8 自适应 */
  noiseGateDb?: number
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
      fftSize = 32768,
      scrollSpeed = 10,
      minHz = 50,
      maxHz = 10000,
      minDb = -20,
      maxDb = -5,
      background = '#000000',
      fps = 30,
      naturalWeight = true,
      naturalWeightDbPerOctave = -3,
      enhancedFrequency = true,
      highBoostFromHz = 1000,
      highBoostDb = 10,
      noiseGateDb,
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
    let data = new Float32Array(0)
    let rate = 48000
    try {
      audioCtx = new AudioContext()
      source = audioCtx.createMediaStreamSource(new MediaStream([track]))
      analyser = audioCtx.createAnalyser()
      analyser.fftSize = fftSize
      // 如实反映连续声音：不做额外平滑，声音本身连续，持续音 FFT 输出即稳定
      analyser.smoothingTimeConstant = 0
      source.connect(analyser)
      rate = audioCtx.sampleRate
      // 浮点 dBFS 频谱（-140~0 dB）：精度远高于 0-255 整数量化，频率线精细锐利
      data = new Float32Array(analyser.frequencyBinCount)
      if (audioCtx.state === 'suspended') void audioCtx.resume()
    } catch {
      // 分析不可用：仍输出滚动频谱（空数据静默背景）
    }

    const binCount = fftSize / 2
    const logMin = Math.log(Math.max(1, minHz))
    const logMax = Math.log(Math.max(logMin + 1e-3, maxHz))

    // 颜色按能量（Wave Candy 红黄蓝紫热力）：低=蓝紫(280°)→青→绿→黄→红(0°)，低暗高亮
    const energyColor = (amp: number): string => {
      const hue = 280 - amp * 280
      const light = 25 + amp * 45
      return `hsl(${hue.toFixed(1)}, 100%, ${light.toFixed(1)}%)`
    }

    let running = true
    let timer = 0

    // 细化频率线：按频率精确采样（相邻 bin 浮点 dB 线性插值），频率线精细锐利
    const sampleAt = (freq: number): number => {
      const bp = (freq / rate) * binCount
      if (bp < 0 || bp >= data.length) return -200
      const i = Math.floor(bp)
      const frac = bp - i
      if (i + 1 < data.length) return data[i] * (1 - frac) + data[i + 1] * frac
      return data[i]
    }

    const drawFrame = (): void => {
      if (!running) return
      // 1) 整体左移（滚动）
      g.drawImage(canvas, -scrollSpeed, 0)
      // 2) 清出右侧空区（背景）
      g.fillStyle = background
      g.fillRect(width - scrollSpeed, 0, scrollSpeed, height)

      // 3) 取当前帧频谱（浮点 dBFS）
      if (analyser) analyser.getFloatFrequencyData(data)

      // 4) 自适应动态范围：相对当前帧峰值，低于峰值 45dB 归为背景（黑），弱能量不显示→频率线分离清晰
      let peakDb = -200
      for (let i = 0; i < data.length; i++) if (data[i] > peakDb) peakDb = data[i]
      const span = 45
      // 门限下限 -90dBFS：静音/近静音帧（峰值极低）整体归为背景，避免误画
      const loDb = Math.max(peakDb - span, -90)

      // 5) 在右侧新列绘制频谱瀑布：y=频率(对数，顶部高频底部低频)，颜色=能量（红黄蓝紫）
      for (let py = 0; py < height; py++) {
        const freq = Math.exp(logMax - (py / height) * (logMax - logMin))
        let db = sampleAt(freq)
        if (db < loDb) continue   // 低于动态范围 → 背景

        // 自然加权：低频提升（频率每升高一倍频程衰减 naturalWeightDbPerOctave dB）
        if (naturalWeight) db += naturalWeightDbPerOctave * Math.log2(freq / Math.max(1, minHz))
        // 增强频率：高频有效频率加强（自起始频率起每倍频程 +highBoostDb dB，覆盖自然加权压制，使高频显示为红）
        if (enhancedFrequency && freq > highBoostFromHz) {
          const oct = Math.log2(freq / highBoostFromHz)
          db += highBoostDb * oct
        }

        const amp = Math.max(0, Math.min(1, (db - loDb) / span))
        // 强 gamma：能量强弱分明，频率线锐利清晰（弱能量快速归黑）
        g.fillStyle = energyColor(amp * amp)
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
