<script setup lang="ts">
/**
 * 独立 Office 预览窗口壳：无边框窗口的自定义标题栏（与主窗口一致）+ 预览内容区。
 * 标题栏：拖拽区 + 文件名 + 最小化 / 最大化 / 关闭；
 * 内容区 flex 占满剩余高度，复用 PdfPreview / DocxPreview / SheetPreview（standalone）。
 * 窗口缩放时标题栏固定、内容区为滚动容器，内部元素保持原尺寸，不会压缩布局。
 */
import { computed, type Component } from 'vue'
import PdfPreview from '../components/PdfPreview.vue'
import DocxPreview from '../components/DocxPreview.vue'
import SheetPreview from '../components/SheetPreview.vue'

const props = defineProps<{ kind: string; path: string; name: string }>()

const comp = computed<Component | null>(() => {
  if (props.kind === 'pdf') return PdfPreview
  if (props.kind === 'word') return DocxPreview
  if (props.kind === 'excel') return SheetPreview
  return null
})
const icon = computed(() => {
  if (props.kind === 'pdf') return 'fas fa-file-pdf'
  if (props.kind === 'word') return 'fas fa-file-word'
  if (props.kind === 'excel') return 'fas fa-file-excel'
  return 'fas fa-file'
})

function minWin(): void { void window.pantry.minimizeWindow() }
function toggleWin(): void { void window.pantry.toggleMaximize() }
function closeWin(): void { void window.pantry.closeWindow() }
</script>

<template>
  <div class="preview-root">
    <!-- 标题栏（主界面风格） -->
    <header class="pv-top">
      <div class="pv-title"><i :class="icon"></i>&nbsp;{{ name }}</div>
      <div class="pv-drag"></div>
      <div class="pv-controls no-drag">
        <button class="win-btn" title="最小化" @click="minWin"><i class="fas fa-minus"></i></button>
        <button class="win-btn" title="最大化 / 还原" @click="toggleWin"><i class="fas fa-square"></i></button>
        <button class="win-btn win-close" title="关闭" @click="closeWin"><i class="fas fa-times"></i></button>
      </div>
    </header>

    <!-- 预览内容区（滚动容器，不随窗口缩放压缩内部布局） -->
    <div class="pv-body">
      <component v-if="comp" :is="comp" :path="path" :name="name" :standalone="true" />
      <div v-else class="pv-unknown">未知预览类型：{{ kind || '(空)' }}</div>
    </div>
  </div>
</template>

<style scoped>
.preview-root { height: 100%; display: flex; flex-direction: column; background: var(--dt-bg-app); }

/* 标题栏：与主窗口一致 */
.pv-top { height: 44px; flex-shrink: 0; display: flex; align-items: center; background: #fff; border-bottom: 1px solid var(--dt-border-light); }
.pv-title { display: flex; align-items: center; gap: 8px; padding: 0 12px; flex: 0 0 auto; font-size: 15px; font-weight: 600; color: var(--dt-text); max-width: 60%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; -webkit-app-region: drag; }
.pv-title i { color: var(--dt-primary, #0089ff); flex-shrink: 0; }
.pv-drag { flex: 1; height: 100%; -webkit-app-region: drag; }
.pv-controls { display: flex; -webkit-app-region: no-drag; }
.win-btn { width: 38px; height: 32px; display: inline-flex; align-items: center; justify-content: center; color: var(--dt-text-3); font-size: 12px; border-radius: 4px; transition: background 0.15s; }
.win-btn:hover { background: var(--dt-hover); color: var(--dt-text); }
.win-btn.win-close:hover { background: #e81123; color: #fff; }

.pv-body { flex: 1; min-height: 0; display: flex; flex-direction: column; position: relative; overflow: hidden; }
.pv-unknown { padding: 40px; color: var(--dt-text-3, #888); font-size: 14px; }
</style>
