<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'

interface ProgressPayload {
  phase: string
  received: number
  total: number
  percent: number
}

interface StatePayload {
  state: 'downloading' | 'installing' | 'error' | 'done'
  version?: string
  message?: string
}

const visible = ref(false)
const percent = ref(0)
const received = ref(0)
const total = ref(0)
const title = ref('正在检查更新…')
const stateText = ref('')
const isError = ref(false)
const isInstalling = ref(false)
const isDone = ref(false)

function fmtSize(n: number): string {
  if (!n || n < 0) return '0 B'
  if (n < 1024) return n + ' B'
  if (n < 1048576) return (n / 1024).toFixed(0) + ' KB'
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB'
  return (n / 1073741824).toFixed(2) + ' GB'
}

function onProgress(d: ProgressPayload): void {
  visible.value = true
  isError.value = false
  isInstalling.value = false
  isDone.value = false
  title.value = '正在下载更新'
  percent.value = d.percent
  received.value = d.received
  total.value = d.total
  stateText.value = total.value > 0
    ? `${fmtSize(received)} / ${fmtSize(total)}`
    : `${fmtSize(received)}`
}

function onState(d: StatePayload): void {
  visible.value = true
  switch (d.state) {
    case 'downloading':
      title.value = '发现新版本'
      isError.value = false
      isInstalling.value = false
      isDone.value = false
      stateText.value = d.message ?? `准备下载更新包…`
      break
    case 'installing':
      isInstalling.value = true
      isError.value = false
      isDone.value = false
      title.value = '下载完成'
      percent.value = 100
      stateText.value = d.message ?? '正在启动安装…'
      break
    case 'error':
      isError.value = true
      isInstalling.value = false
      isDone.value = false
      title.value = '更新失败'
      stateText.value = d.message ?? '自动更新遇到问题'
      // 错误信息停留几秒后收起
      setTimeout(() => { visible.value = false }, 6000)
      break
    case 'done':
      isDone.value = true
      isInstalling.value = false
      isError.value = false
      title.value = '更新完成'
      stateText.value = d.message ?? '程序已更新到最新版本'
      break
  }
}

const progressBarWidth = computed(() => `${percent.value}%`)

let offProgress: (() => void) | null = null
let offState: (() => void) | null = null

onMounted(() => {
  offProgress = window.pantry.onUpdateProgress(onProgress)
  offState = window.pantry.onUpdateState(onState)
})

onBeforeUnmount(() => {
  offProgress?.()
  offState?.()
})
</script>

<template>
  <transition name="up-overlay">
    <div v-if="visible" class="up-overlay">
      <div class="up-card" :class="{ error: isError, done: isDone }">
        <div class="up-head">
          <span class="up-title">{{ title }}</span>
          <span v-if="!isError && !isDone" class="up-pct">{{ percent }}%</span>
        </div>

        <!-- 进度条 -->
        <div class="up-track">
          <div class="up-bar" :style="{ width: progressBarWidth }"></div>
        </div>

        <div class="up-foot">
          <span class="up-state">{{ stateText }}</span>
          <span v-if="isInstalling" class="up-spin"></span>
          <i v-else-if="isDone" class="fas fa-check-circle up-done-ic"></i>
          <i v-else-if="isError" class="fas fa-exclamation-triangle up-err-ic"></i>
        </div>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.up-overlay {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 9999;
  pointer-events: none;
}
.up-card {
  width: 300px;
  padding: 14px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16);
  border: 1px solid rgba(0, 0, 0, 0.06);
  backdrop-filter: blur(6px);
}
.up-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}
.up-title {
  font-size: 14px;
  font-weight: 600;
  color: #1f2329;
}
.up-pct {
  font-size: 13px;
  font-weight: 700;
  color: #4c6fff;
  font-variant-numeric: tabular-nums;
}
.up-track {
  height: 6px;
  border-radius: 999px;
  background: #eef0f4;
  overflow: hidden;
}
.up-bar {
  height: 100%;
  border-radius: 999px;
  background: linear-gradient(90deg, #6a8bff, #4c6fff);
  transition: width 0.25s ease;
}
.up-card.error .up-bar {
  background: linear-gradient(90deg, #ff8f6a, #ff5c5c);
}
.up-card.done .up-bar {
  background: linear-gradient(90deg, #34c77b, #1fae63);
}
.up-foot {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 10px;
}
.up-state {
  font-size: 12px;
  color: #6b7280;
  flex: 1;
  word-break: break-all;
}
.up-spin {
  width: 12px;
  height: 12px;
  border: 2px solid rgba(0, 0, 0, 0.12);
  border-top-color: #4c6fff;
  border-radius: 50%;
  animation: up-rotate 0.8s linear infinite;
  flex-shrink: 0;
}
.up-done-ic {
  color: #1fae63;
  font-size: 14px;
  flex-shrink: 0;
}
.up-err-ic {
  color: #ff5c5c;
  font-size: 14px;
  flex-shrink: 0;
}
@keyframes up-rotate {
  to { transform: rotate(360deg); }
}

.up-overlay-enter-active,
.up-overlay-leave-active {
  transition: opacity 0.3s, transform 0.3s;
}
.up-overlay-enter-from,
.up-overlay-leave-to {
  opacity: 0;
  transform: translateX(24px);
}
</style>
