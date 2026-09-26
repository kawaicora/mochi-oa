<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import UserAvatar from './UserAvatar.vue'

/**
 * 音频通话头像：圆形头像 + 外圈实时环形频谱
 * - fftSize=1024 取实时频域数据
 * - 左右声道对半：左声道驱动左半圆环，右声道驱动右半圆环
 * - 可把 canvas 作为视频流导出（captureStream），无摄像头时发送给远端同步显示
 */
const props = defineProps<{
  stream?: MediaStream | null
  nick: string
  avatar?: string
  size?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)

let ctx: AudioContext | null = null
let source: MediaStreamAudioSourceNode | null = null
let splitter: ChannelSplitterNode | null = null
let analyserL: AnalyserNode | null = null
let analyserR: AnalyserNode | null = null
let captured: MediaStream | null = null
let raf = 0
let dataL: Uint8Array<ArrayBuffer> = new Uint8Array(0)
let dataR: Uint8Array<ArrayBuffer> = new Uint8Array(0)

function teardown(): void {
  cancelAnimationFrame(raf)
  captured = null
  source?.disconnect()
  splitter?.disconnect()
  analyserL?.disconnect()
  analyserR?.disconnect()
  source = null
  splitter = null
  analyserL = null
  analyserR = null
  if (ctx) void ctx.close()
  ctx = null
}

/** 半圆环频谱：把 data 均布到 [startA, endA]，径向高度随音量 */
function drawHalf(
  g: CanvasRenderingContext2D,
  data: Uint8Array,
  startA: number,
  endA: number,
  cx: number,
  cy: number,
  inner: number,
  outer: number,
  color: string
): void {
  const n = Math.min(data.length, 64)
  for (let i = 0; i < n; i++) {
    const v = data[i] / 255
    const len = inner + v * (outer - inner)
    const a = startA + (i / n) * (endA - startA)
    const x1 = cx + Math.cos(a) * inner
    const y1 = cy + Math.sin(a) * inner
    const x2 = cx + Math.cos(a) * len
    const y2 = cy + Math.sin(a) * len
    g.strokeStyle = color.replace('ALPHA', (0.35 + v * 0.65).toFixed(2))
    g.lineWidth = 3
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(x1, y1)
    g.lineTo(x2, y2)
    g.stroke()
  }
}

function draw(): void {
  if (!analyserL || !analyserR || !canvasRef.value) return
  analyserL.getByteFrequencyData(dataL)
  analyserR.getByteFrequencyData(dataR)
  const size = props.size ?? 160
  const canvas = canvasRef.value
  const dpr = window.devicePixelRatio || 1
  canvas.width = size * dpr
  canvas.height = size * dpr
  const g = canvas.getContext('2d')
  if (!g) return
  g.setTransform(dpr, 0, 0, dpr, 0, 0)
  g.clearRect(0, 0, size, size)
  const cx = size / 2
  const cy = size / 2
  const inner = size / 2 - 13
  const outer = size / 2 - 3
  // 左声道 → 左半圆；右声道 → 右半圆
  drawHalf(g, dataL, Math.PI / 2, (Math.PI * 3) / 2, cx, cy, inner, outer, 'rgba(56,132,255,ALPHA)')
  drawHalf(g, dataR, -Math.PI / 2, Math.PI / 2, cx, cy, inner, outer, 'rgba(0,200,180,ALPHA)')
}

function loop(): void {
  draw()
  raf = requestAnimationFrame(loop)
}

function setup(stream?: MediaStream | null): void {
  teardown()
  if (!stream) return
  const track = stream.getAudioTracks()[0]
  if (!track) return
  try {
    ctx = new AudioContext()
    source = ctx.createMediaStreamSource(new MediaStream([track]))
    splitter = ctx.createChannelSplitter(2)
    source.connect(splitter)
    analyserL = ctx.createAnalyser()
    analyserL.fftSize = 1024
    analyserL.smoothingTimeConstant = 0.8
    analyserR = ctx.createAnalyser()
    analyserR.fftSize = 1024
    analyserR.smoothingTimeConstant = 0.8
    splitter.connect(analyserL, 0)
    splitter.connect(analyserR, 1)
    dataL = new Uint8Array(analyserL.frequencyBinCount)
    dataR = new Uint8Array(analyserR.frequencyBinCount)
    if (ctx.state === 'suspended') void ctx.resume()
    loop()
  } catch {
    teardown()
  }
}

/** 导出 canvas 实时视频流（captureStream），供无摄像头时发送给远端 */
function getStream(): MediaStream | null {
  if (captured) return captured
  const c = canvasRef.value
  if (!c) return null
  const size = props.size ?? 160
  if (!c.width) {
    c.width = size
    c.height = size
  }
  try {
    captured = c.captureStream(30)
    return captured
  } catch {
    return null
  }
}

watch(
  () => props.stream,
  (s) => setup(s),
  { immediate: true }
)
onBeforeUnmount(teardown)

defineExpose({ getStream })
</script>

<template>
  <div class="voice-avatar" :style="{ width: size + 'px', height: size + 'px' }">
    <canvas ref="canvasRef" class="voice-ring"></canvas>
    <div class="voice-face">
      <UserAvatar :nick="nick" :avatar="avatar" :size="Math.max(24, Math.round((size ?? 160) * 0.72))" />
    </div>
  </div>
</template>

<style scoped>
.voice-avatar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.voice-ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.voice-face {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
</style>
