<script setup lang="ts">
/**
 * 独立截屏窗口：全屏固定，加载主窗口捕获的整屏截图，交给 ScreenshotEditor 框选/绘制。
 * 保存 → 主进程写临时 PNG、关窗、通知主窗口发送；取消 → 直接关窗。
 */
import { ref, onMounted } from 'vue'
import ScreenshotEditor from '../components/ScreenshotEditor.vue'

const data = ref<{ src: string; srcWidth: number; srcHeight: number } | null>(null)

onMounted(async () => {
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

async function onSave(dataUrl: string): Promise<void> {
  await window.pantry.screenshotSave(dataUrl)
}
function onCancel(): void {
  window.pantry.closeWindow()
}
// 框选进入编辑 → 窗口缩放/定位到选框（冻结画面跟随，工具栏自适应）
const TOOLBAR_DIP = 46
function onResizeWindow(sel: { x: number; y: number; w: number; h: number }): void {
  window.pantry.screenshotResize(sel, TOOLBAR_DIP)
}
</script>

<template>
  <div class="shot-win">
    <ScreenshotEditor
      v-if="data"
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
