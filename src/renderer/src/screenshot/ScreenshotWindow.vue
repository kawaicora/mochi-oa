<script setup lang="ts">
/**
 * 独立截屏窗口：全屏固定，加载主窗口捕获的整屏截图，交给 ScreenshotEditor 框选/绘制。
 * 保存 → 主进程写临时 PNG、关窗、通知主窗口发送；取消 → 直接关窗。
 * 工具栏为独立窗口：其按钮命令经主进程转发到本窗口，驱动 ScreenshotEditor。
 */
import { ref, onMounted, onBeforeUnmount } from 'vue'
import ScreenshotEditor from '../components/ScreenshotEditor.vue'
import type { ScreenshotEditorExpose } from '../components/ScreenshotEditor.vue'

const data = ref<{ src: string; srcWidth: number; srcHeight: number } | null>(null)
const editorRef = ref<InstanceType<typeof ScreenshotEditor> | null>(null)
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
// 框选进入编辑 → 窗口缩放/定位到选框（工具栏为独立窗口，无需留空间）
function onResizeWindow(sel: { x: number; y: number; w: number; h: number }): void {
  window.pantry.screenshotResize(sel)
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
      @save="onSave"
      @cancel="onCancel"
      @resize-window="onResizeWindow"
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
