<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'

const props = defineProps<{
  src: string
  alt?: string
}>()
const emit = defineEmits<{ close: [] }>()

// 缩放与平移状态
const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const MIN_SCALE = 0.1
const MAX_SCALE = 10
const containerRef = ref<HTMLElement | null>(null)
const imgRef = ref<HTMLImageElement | null>(null)

// 拖拽状态
let dragging = false
let startX = 0
let startY = 0
let origX = 0
let origY = 0

const scalePercent = computed(() => Math.round(scale.value * 100))

function zoom(factor: number, centerX?: number, centerY?: number): void {
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale.value * factor))
  if (newScale === scale.value) return

  // 以鼠标位置为中心缩放
  if (centerX !== undefined && centerY !== undefined && containerRef.value) {
    const rect = containerRef.value.getBoundingClientRect()
    const cx = centerX - rect.left - rect.width / 2
    const cy = centerY - rect.top - rect.height / 2
    // 调整平移量使缩放中心保持不动
    translateX.value = cx - (cx - translateX.value) * (newScale / scale.value)
    translateY.value = cy - (cy - translateY.value) * (newScale / scale.value)
  }
  scale.value = newScale
}

function resetZoom(): void {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function fitToScreen(): void {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
}

function onWheel(e: WheelEvent): void {
  e.preventDefault()
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15
  zoom(factor, e.clientX, e.clientY)
}

function onMouseDown(e: MouseEvent): void {
  dragging = true
  startX = e.clientX
  startY = e.clientY
  origX = translateX.value
  origY = translateY.value
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging) return
  translateX.value = origX + (e.clientX - startX)
  translateY.value = origY + (e.clientY - startY)
}

function onMouseUp(): void {
  dragging = false
}

function onDblClick(e: MouseEvent): void {
  if (scale.value > 1) {
    resetZoom()
  } else {
    zoom(2.5, e.clientX, e.clientY)
  }
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close')
  } else if (e.key === '+' || e.key === '=') {
    zoom(1.25)
  } else if (e.key === '-') {
    zoom(1 / 1.25)
  } else if (e.key === '0') {
    resetZoom()
  }
}

onMounted(() => {
  containerRef.value?.addEventListener('wheel', onWheel, { passive: false })
  window.addEventListener('keydown', onKeydown)
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
})

onUnmounted(() => {
  containerRef.value?.removeEventListener('wheel', onWheel)
  window.removeEventListener('keydown', onKeydown)
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('mouseup', onMouseUp)
})
</script>

<template>
  <div class="iv-mask" @click.self="emit('close')">
    <!-- 关闭按钮 -->
    <button class="iv-btn iv-close" title="关闭 (Esc)" @click="emit('close')">
      <i class="fas fa-times"></i>
    </button>

    <!-- 工具栏 -->
    <div class="iv-toolbar">
      <button class="iv-btn" title="缩小 (-)" @click="zoom(1/1.25)">
        <i class="fas fa-search-minus"></i>
      </button>
      <span class="iv-scale" title="双击重置">{{ scalePercent }}%</span>
      <button class="iv-btn" title="放大 (+)" @click="zoom(1.25)">
        <i class="fas fa-search-plus"></i>
      </button>
      <div class="iv-sep"></div>
      <button class="iv-btn" title="适应屏幕 (0)" @click="fitToScreen">
        <i class="fas fa-expand"></i>
      </button>
      <button class="iv-btn" title="100% 原始大小" @click="resetZoom">
        <i class="fas fa-arrows-alt"></i>
      </button>
    </div>

    <!-- 图片容器 -->
    <div ref="containerRef" class="iv-container" @mousedown="onMouseDown" @dblclick="onDblClick">
      <img
        ref="imgRef"
        :src="src"
        :alt="alt || '预览'"
        class="iv-img"
        :style="{
          transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`,
          cursor: dragging ? 'grabbing' : 'grab'
        }"
        draggable="false"
      />
    </div>
  </div>
</template>

<style scoped>
.iv-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.93);
  z-index: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.iv-container {
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.iv-img {
  max-width: 90vw;
  max-height: 90vh;
  object-fit: contain;
  border-radius: 4px;
  transition: cursor 0.15s;
  will-change: transform;
}

.iv-toolbar {
  position: fixed;
  bottom: 28px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px 12px;
  background: rgba(30, 30, 30, 0.85);
  backdrop-filter: blur(8px);
  border-radius: 24px;
  z-index: 510;
}

.iv-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: transparent;
  border: none;
  color: #fff;
  font-size: 15px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.iv-btn:hover { background: rgba(255, 255, 255, 0.15); }

.iv-close {
  position: fixed;
  top: 20px;
  right: 24px;
  width: 40px;
  height: 40px;
  background: rgba(255, 255, 255, 0.12);
  z-index: 510;
}
.iv-close:hover { background: rgba(255, 80, 80, 0.7); }

.iv-scale {
  color: #fff;
  font-size: 13px;
  min-width: 56px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.iv-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.2);
  margin: 0 6px;
}
</style>
