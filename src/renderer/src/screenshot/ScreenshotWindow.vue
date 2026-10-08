<script setup lang="ts">
/**
 * 独立截屏窗口：全屏固定，加载主窗口捕获的整屏截图，交给 ScreenshotEditor 框选/绘制。
 * 工具栏：框选(不全屏)时用独立工具栏窗口；全屏编辑时隐藏独立窗口、工具栏内嵌在编辑窗口内部。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ScreenshotEditor from '../components/ScreenshotEditor.vue'
import type { ScreenshotEditorExpose } from '../components/ScreenshotEditor.vue'
import { ScreenshotToolbar } from '@shared/ipc'

const data = ref<{ src: string; srcWidth: number; srcHeight: number } | null>(null)
const editorRef = ref<InstanceType<typeof ScreenshotEditor> | null>(null)
const inlineToolbar = ref(false)
let offCmd: (() => void) | null = null

function handleCommand(cmd: { action: string; value?: unknown }): void {
  const ed = editorRef.value as unknown as ScreenshotEditorExpose | null
  if (!ed) return
  switch (cmd.action) {
    case 'setTool':
      ed.setTool(cmd.value as 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text')
      break
    case 'setColor':
      ed.setColor(cmd.value as string)
      break
    case 'undo':
      ed.undo()
      break
    case 'redo':
      ed.redo()
      break
    case 'selectAll':
      ed.selectAll()
      break
    case 'save':
      ed.save()
      break
    case 'cancel':
      ed.cancel()
      break
  }
}

onMounted(async () => {
  offCmd = window.pantry.onScreenshotToolbarCommand(handleCommand)
  try {
    const p = await window.pantry.screenshotGetPending()
    if (p && p.dataUrl) {
      data.value = { src: p.dataUrl, srcWidth: p.width || 0, srcHeight: p.height || 0 }
      return
    }
  } catch {
    /* 忽略 */
  }
  // 无待处理截图：直接关窗
  window.pantry.closeWindow()
})

onBeforeUnmount(() => {
  offCmd?.()
})

async function onSave(dataUrl: string): Promise<void> {
  await window.pantry.screenshotSave(dataUrl)
}
function onCancel(): void {
  window.pantry.closeWindow()
}
// 框选进入编辑 → 窗口缩放/定位到选框（框选用独立工具栏窗口，无需留空间）
function onResizeWindow(sel: { x: number; y: number; w: number; h: number }): void {
  window.pantry.screenshotResize(sel)
}
// 进入编辑：全屏(沾满) → 隐藏独立窗口、内嵌工具栏显示；框选 → 显示独立窗口并定位到区域外侧(上下就近)
function onEditStarted(info: { sel: { x: number; y: number; w: number; h: number }; full: boolean }): void {
  inlineToolbar.value = info.full
  if (info.full) {
    void window.pantry.screenshotToolbarVisible(false)
    return
  }
  // 框选：显示独立工具栏窗口并定位到选框外侧
  void window.pantry.screenshotToolbarVisible(true)
  const scale = window.devicePixelRatio || 1
  const sw = window.screen.width
  const sh = window.screen.height
  const TW = ScreenshotToolbar.WIDTH
  const TH = ScreenshotToolbar.HEIGHT
  const selX = info.sel.x / scale
  const selY = info.sel.y / scale
  const selW = info.sel.w / scale
  const selH = info.sel.h / scale
  let tx: number
  let ty: number
  // 区域下方有足够空间 → 工具栏放区域下方外部
  if (sh - (selY + selH) >= TH) {
    tx = Math.round(Math.min(Math.max(selX, 0), sw - TW))
    ty = Math.round(selY + selH)
  } else if (selY >= TH) {
    // 下方不够、上方有空间 → 工具栏放区域上方外部（截取底部时显示在上面）
    tx = Math.round(Math.min(Math.max(selX, 0), sw - TW))
    ty = Math.round(selY - TH)
  } else {
    // 上下都没空间（区域几乎沾满）→ 工具栏放选框内部顶部
    tx = Math.round(Math.min(Math.max(selX, 0), sw - TW))
    ty = Math.round(selY)
  }
  void window.pantry.screenshotToolbarPos({ x: tx, y: ty, width: TW, height: TH })
}
</script>

<template>
  <div class="shot-win">
    <ScreenshotEditor
      v-if="data"
      ref="editorRef"
      :src="data.src"
      :src-width="data.srcWidth"
      :src-height="data.srcHeight"
      :inline-toolbar="inlineToolbar"
      @save="onSave"
      @cancel="onCancel"
      @resize-window="onResizeWindow"
      @edit-started="onEditStarted"
    />
  </div>
</template>

<style scoped>
.shot-win {
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background: #000;
}
</style>
