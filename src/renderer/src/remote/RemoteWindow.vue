<script setup lang="ts">
/**
 * 独立远程控制窗口（控制端）。
 * 无边框 + 主窗口样式 + 可缩放（缩放不压缩内部布局，画面 object-fit: contain）。
 * 窗口内建立 WebRTC 会话：屏幕 + 系统声音（48kHz/2ch）+ PeerConnection 自带 DataChannel
 * 传输键鼠控制。窗口关闭自动结束会话并复位/解冻被控端鼠标。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RemoteSession, { type RemoteMode, type RemoteRole } from './RemoteSession'

const props = defineProps<{
  room: string
  iceServers: RTCIceServer[]
  mode: RemoteMode
  peerId: number
  peerName: string
  meId: number
}>()

const videoEl = ref<HTMLVideoElement | null>(null)
const holderEl = ref<HTMLDivElement | null>(null)
const stream = ref<MediaStream | null>(null)
const meta = ref<{ w: number; h: number; mode: RemoteMode } | null>(null)
const connected = ref(false)
const errMsg = ref('')

// ── 键鼠采集 → DataChannel ──
function screenOf(e: MouseEvent): { x: number; y: number } | null {
  const m = meta.value
  const holder = holderEl.value
  if (!m || !m.w || !m.h || !holder) return null
  const rect = holder.getBoundingClientRect()
  return {
    x: Math.round(((e.clientX - rect.left) / rect.width) * m.w),
    y: Math.round(((e.clientY - rect.top) / rect.height) * m.h)
  }
}
function btnOf(button: number): 'left' | 'middle' | 'right' {
  return button === 2 ? 'right' : button === 1 ? 'middle' : 'left'
}
function onMouseMove(e: MouseEvent): void {
  const p = screenOf(e)
  if (p) RemoteSession.sendControl({ t: 'move', x: p.x, y: p.y })
}
function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
  if (!screenOf(e)) return
  RemoteSession.sendControl({ t: 'down', btn: btnOf(e.button) })
}
function onMouseUp(e: MouseEvent): void {
  if (e.button !== 0 && e.button !== 1 && e.button !== 2) return
  RemoteSession.sendControl({ t: 'up', btn: btnOf(e.button) })
}
function onWheel(e: WheelEvent): void {
  e.preventDefault()
  RemoteSession.sendControl({ t: 'scroll', d: e.deltaY })
}
function onKeyDown(e: KeyboardEvent): void {
  const k = e.keyCode || e.which
  if (k) RemoteSession.sendControl({ t: 'kdown', k })
}
function onKeyUp(e: KeyboardEvent): void {
  const k = e.keyCode || e.which
  if (k) RemoteSession.sendControl({ t: 'kup', k })
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
  // 建立会话（控制端等被控 offer）
  RemoteSession.startMaster({
    room: props.room,
    iceServers: props.iceServers,
    mode: props.mode,
    meId: props.meId,
    sendSignal: (s) => window.pantry.rtcSignal(props.room, s as never),
    callbacks: {
      onRemoteStream: (s) => { stream.value = s },
      onMeta: (m) => { meta.value = m },
      onState: (st) => {
        connected.value = st.connected
        if (st.ended) window.pantry.closeWindow()
      },
      onError: (msg) => {
        errMsg.value = msg
        setTimeout(() => window.pantry.closeWindow(), 2600)
      }
    }
  })
})
onBeforeUnmount(() => {
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('keyup', onKeyUp)
  RemoteSession.stop()
})

watch(
  stream,
  (s) => {
    if (videoEl.value && s) videoEl.value.srcObject = s
  },
  { immediate: true }
)

// ── 无边框标题栏按钮 ──
function minimize(): void { void window.pantry.minimizeWindow() }
function toggleMax(): void { void window.pantry.toggleMaximize() }
function close(): void {
  RemoteSession.stop()
  window.pantry.closeWindow()
}
</script>

<template>
  <div class="remote-window">
    <!-- 无边框标题栏（拖拽区 + 窗口控制） -->
    <div class="rw-titlebar">
      <div class="rw-title">
        <i class="fas fa-desktop"></i>
        <span>远程控制 · {{ peerName }}</span>
        <span v-if="meta" class="rw-sub">{{ meta.w }}×{{ meta.h }} · {{ meta.mode === 'remote' ? '远程模式' : '本地模式' }}</span>
        <span v-else-if="errMsg" class="rw-sub err">{{ errMsg }}</span>
      </div>
      <div class="rw-winbtns">
        <button class="rw-win" title="最小化" @click="minimize"><i class="fas fa-minus"></i></button>
        <button class="rw-win" title="最大化/还原" @click="toggleMax"><i class="far fa-square"></i></button>
        <button class="rw-win close" title="关闭" @click="close"><i class="fas fa-times"></i></button>
      </div>
    </div>

    <!-- 画面区：缩放不压缩布局（object-fit contain），键鼠事件采集 -->
    <div ref="holderEl" class="rw-stage" @mousedown="onMouseDown" @mousemove="onMouseMove" @wheel="onWheel">
      <video ref="videoEl" autoplay playsinline muted class="rw-video" />
      <div v-if="!stream" class="rw-loading">
        {{ errMsg || (connected ? '正在建立远程控制连接…' : '等待对端接受远程控制…') }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-window {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #0e0f12;
  user-select: none;
}
/* 标题栏：主窗口样式，可拖拽 */
.rw-titlebar {
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #16181d;
  border-bottom: 1px solid #262a32;
  -webkit-app-region: drag;
  padding-left: 14px;
}
.rw-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: #e8eaed;
  font-size: 13px;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.rw-sub {
  color: #9aa0aa;
  font-size: 12px;
  font-weight: 400;
}
.rw-sub.err {
  color: #f04438;
}
.rw-winbtns {
  display: flex;
  -webkit-app-region: no-drag;
  height: 100%;
}
.rw-win {
  width: 46px;
  height: 100%;
  border: none;
  background: transparent;
  color: #c9cdd4;
  font-size: 13px;
  cursor: pointer;
}
.rw-win:hover {
  background: rgba(255, 255, 255, 0.08);
}
.rw-win.close:hover {
  background: #d93026;
  color: #fff;
}
/* 画面区：可缩放，布局不压缩 */
.rw-stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  cursor: crosshair;
}
.rw-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.rw-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9aa0aa;
  font-size: 15px;
}
</style>
