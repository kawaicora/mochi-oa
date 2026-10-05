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
  /** 高频最大加强 dB，默认 6 */
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
      highBoostDb = 6,
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
    let data = new Uint8Array(0)
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
      data = new Uint8Array(analyser.frequencyBinCount)
      if (audioCtx.state === 'suspended') void audioCtx.resume()
    } catch {
      // 分析不可用：仍输出滚动频谱（空数据静默背景）
    }

    const binCount = fftSize / 2
    const logMin = Math.log(Math.max(1, minHz))
    const logMax = Math.log(Math.max(logMin + 1e-3, maxHz))

    // 颜色 hue 代表强度（Wave Candy 官方定义）：弱=红(0°)→橙→强=黄(60°)，低暗高亮
    const energyColor = (db: number): string => {
      let amp = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)))
      amp = Math.sqrt(amp)
      const hue = amp * 60
      const light = 20 + amp * 50
      return `hsl(${hue.toFixed(1)}, 100%, ${light.toFixed(1)}%)`
    }

    let running = true
    let timer = 0

    // 背景弱频率门限：仅去除绝对静音（无显式值时 minDb 之上 2dB），避免切断持续音导致断续
    const gateDb = enhancedFrequency ? (noiseGateDb !== undefined ? noiseGateDb : minDb + 2) : -Infinity

    // 细化频率线：按频率精确采样（相邻 bin 线性插值），避免取整导致的错位/色块
    const sampleAt = (freq: number): number => {
      const bp = (freq / rate) * binCount
      if (bp < 0 || bp >= data.length) return 0
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

      // 3) 取当前帧频谱
      if (analyser) analyser.getByteFrequencyData(data)

      // 4) 在右侧新列绘制频谱瀑布：y=频率(对数，顶部高频底部低频)，颜色=幅度
      for (let py = 0; py < height; py++) {
        const freq = Math.exp(logMax - (py / height) * (logMax - logMin))
        const raw = sampleAt(freq) / 255
        if (raw <= 0.005) continue
        const rawDb = minDb + raw * (maxDb - minDb)

        // 背景弱频率去除：原始幅度低于门限不绘制
        if (rawDb < gateDb) continue

        let db = rawDb
        // 自然加权：低频提升（频率每升高一倍频程衰减 naturalWeightDbPerOctave dB）
        if (naturalWeight) {
          const oct = Math.log2(freq / Math.max(1, minHz))
          db += naturalWeightDbPerOctave * oct
        }
        // 增强频率：高频有效频率加强（超过起始频率后逐步加强 highBoostDb dB）
        if (enhancedFrequency && freq > highBoostFromHz) {
          const t = (freq - highBoostFromHz) / Math.max(1, maxHz - highBoostFromHz)
          db += highBoostDb * t
        }

        g.fillStyle = energyColor(db)
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
