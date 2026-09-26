<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import UserAvatar from './UserAvatar.vue'

/**
 * 音频通话头像：圆形头像 + 外圈实时环形频谱
 * stream 提供音频轨（本地 mic / 远端流），内部用 AnalyserNode 取频域数据每帧绘制
 */
const props = defineProps<{
  stream?: MediaStream | null
  nick: string
  avatar?: string
  size?: number
}>()

const canvasRef = ref<HTMLCanvasElement | null>(null)
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let source: MediaStreamAudioSourceNode | null = null
let raf = 0
let data: Uint8Array<ArrayBuffer> = new Uint8Array(0)

function teardown(): void {
  cancelAnimationFrame(raf)
  source?.disconnect()
  analyser?.disconnect()
  source = null
  analyser = null
  if (ctx) void ctx.close()
  ctx = null
}

function draw(): void {
  if (!analyser || !canvasRef.value) return
  analyser.getByteFrequencyData(data)
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
  const n = Math.min(data.length, 64)
  const step = (Math.PI * 2) / n
  for (let i = 0; i < n; i++) {
    const v = data[i] / 255
    const len = inner + v * (outer - inner)
    const a = i * step - Math.PI / 2
    const x1 = cx + Math.cos(a) * inner
    const y1 = cy + Math.sin(a) * inner
    const x2 = cx + Math.cos(a) * len
    const y2 = cy + Math.sin(a) * len
    g.strokeStyle = `rgba(56, 132, 255, ${0.35 + v * 0.65})`
    g.lineWidth = 3
    g.lineCap = 'round'
    g.beginPath()
    g.moveTo(x1, y1)
    g.lineTo(x2, y2)
    g.stroke()
  }
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
    analyser = ctx.createAnalyser()
    analyser.fftSize = 128
    analyser.smoothingTimeConstant = 0.8
    source.connect(analyser)
    data = new Uint8Array(analyser.frequencyBinCount)
    if (ctx.state === 'suspended') void ctx.resume()
    loop()
  } catch {
    teardown()
  }
}

watch(
  () => props.stream,
  (s) => setup(s),
  { immediate: true }
)
onBeforeUnmount(teardown)
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
