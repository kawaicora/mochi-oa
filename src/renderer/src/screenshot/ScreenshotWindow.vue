<script setup lang="ts">
/**
 * 独立截屏窗口：全屏固定，加载主窗口捕获的整屏截图，交给 ScreenshotEditor 框选/绘制。
 * 工具栏：框选(不全屏)时用独立工具栏窗口；全屏编辑时隐藏独立窗口、工具栏内嵌在编辑窗口内部。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ScreenshotEditor from '../components/ScreenshotEditor.vue'
import type { ScreenshotEditorExpose } from '../components/ScreenshotEditor.vue'

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
// 进入编辑：全屏 → 隐藏独立窗口、内嵌工具栏显示；框选 → 显示独立窗口、内嵌工具栏隐藏
function onEditStarted(info: { sel: { x: number; y: number; w: number; h: number }; full: boolean }): void {
  inlineToolbar.value = info.full
  void window.pantry.screenshotToolbarVisible(!info.full)
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
