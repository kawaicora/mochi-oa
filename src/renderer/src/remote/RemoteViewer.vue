<script setup lang="ts">
/**
 * 控制端远程查看面板（客户端对客户端，旧内嵌方案残留：实际会话由 RemoteWindow
 * 独立窗口建立，RemoteSession 已 SFU 化）。
 * 显示被控端屏幕 + 系统声音，采集本机键鼠事件 → 归一化坐标 → LiveKit data 发送。
 * 控制端默认显示鼠标（不需要隐藏）。mode=remote 时被控端本机鼠标锁定+隐藏；
 * mode=local 时仅同步位置。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import RemoteSession from './RemoteSession'
import RemoteUi, { remoteViewer } from './RemoteUi'

const videoEl = ref<HTMLVideoElement | null>(null)
const holderEl = ref<HTMLDivElement | null>(null)

// 被控端屏幕尺寸（未收到 meta 前为 null，不发送 move）
function screenOf(e: MouseEvent): { x: number; y: number } | null {
  const m = remoteViewer.meta
  if (!m || !m.w || !m.h) return null
  const holder = holderEl.value
  if (!holder) return null
  const rect = holder.getBoundingClientRect()
  const x = ((e.clientX - rect.left) / rect.width) * m.w
  const y = ((e.clientY - rect.top) / rect.height) * m.h
  return { x: Math.round(x), y: Math.round(y) }
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
  const p = screenOf(e)
  if (!p) return
  RemoteSession.sendControl({ t: 'down', btn: btnOf(e.button), x: p.x, y: p.y })
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
  if (!k) return
  // 控制端功能快捷键可透传（远程操作被控端窗口内的快捷键）
  RemoteSession.sendControl({ t: 'kdown', k })
}
function onKeyUp(e: KeyboardEvent): void {
  const k = e.keyCode || e.which
  if (!k) return
  RemoteSession.sendControl({ t: 'kup', k })
}

onMounted(() => {
  document.addEventListener('mouseup', onMouseUp)
  document.addEventListener('keydown', onKeyDown)
  document.addEventListener('keyup', onKeyUp)
})
onBeforeUnmount(() => {
  document.removeEventListener('mouseup', onMouseUp)
  document.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('keyup', onKeyUp)
})

// 流就绪后绑定到 video
watch(
  () => remoteViewer.stream,
  (s) => {
    if (videoEl.value && s) videoEl.value.srcObject = s
  },
  { immediate: true }
)

function end(): void {
  RemoteUi.end()
}
</script>

<template>
  <Teleport to="body">
    <div v-if="remoteViewer.open" class="remote-viewer-wrap" @mousedown="onMouseDown" @mousemove="onMouseMove" @wheel="onWheel">
      <div ref="holderEl" class="rv-stage">
        <video ref="videoEl" autoplay playsinline muted class="rv-video" />
        <div v-if="!remoteViewer.stream" class="rv-loading">正在建立远程控制连接…</div>
      </div>
      <div class="rv-bar">
        <div class="rv-bar-left">
          <span class="rv-title">远程控制 · {{ remoteViewer.peerName || '对端' }}</span>
          <span v-if="remoteViewer.meta" class="rv-sub">屏幕 {{ remoteViewer.meta.w }}×{{ remoteViewer.meta.h }} · {{ remoteViewer.meta.mode === 'remote' ? '远程模式' : '本地模式' }}</span>
        </div>
        <div class="rv-bar-right">
          <button class="rv-exit" @click="end">结束控制</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.remote-viewer-wrap {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: #0e0f12;
  display: flex;
  flex-direction: column;
}
.rv-stage {
  flex: 1;
  position: relative;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #000;
  cursor: crosshair;
}
.rv-video {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.rv-loading {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #9aa0aa;
  font-size: 15px;
}
.rv-bar {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  background: #16181d;
  border-top: 1px solid #262a32;
}
.rv-bar-left {
  display: flex;
  align-items: baseline;
  gap: 12px;
}
.rv-title {
  color: #e8eaed;
  font-size: 14px;
  font-weight: 600;
}
.rv-sub {
  color: #9aa0aa;
  font-size: 12px;
}
.rv-exit {
  background: #d93026;
  color: #fff;
  border: none;
  border-radius: 6px;
  padding: 7px 18px;
  font-size: 13px;
  cursor: pointer;
}
.rv-exit:hover {
  background: #f04438;
}
</style>
