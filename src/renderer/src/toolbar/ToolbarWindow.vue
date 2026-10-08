<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'

const TOOL_NAMES: Record<string, string> = { pen: '画笔', arrow: '箭头', rect: '矩形', ellipse: '椭圆', text: '文字' }
const activeTool = ref<'pen' | 'arrow' | 'rect' | 'ellipse' | 'text'>('pen')
const activeColor = ref('#ff4444')
const COLORS = ['#ff4444', '#ff8a00', '#ffd400', '#2ee62e', '#00c8ff', '#3b6bff', '#a43bff', '#ff3bd6', '#ffffff', '#000000'] as const
const TOOLS = ['pen', 'arrow', 'rect', 'ellipse', 'text'] as const
// 选择阶段（未框选）只显示 全屏/取消；进入编辑后展开工具/颜色/撤销/重做/保存
const selecting = ref(true)
let offEdit: (() => void) | null = null

onMounted(() => {
  offEdit = window.pantry.onScreenshotToolbarEdit(() => {
    selecting.value = false
  })
})
onBeforeUnmount(() => {
  offEdit?.()
})

function cmd(action: string, value?: unknown): void {
  window.pantry.screenshotToolbarCommand({ action, value })
}
function pickTool(t: 'pen' | 'arrow' | 'rect' | 'ellipse' | 'text'): void {
  activeTool.value = t
  cmd('setTool', t)
}
function pickColor(c: string): void {
  activeColor.value = c
  cmd('setColor', c)
}
</script>

<template>
  <div class="tw">
    <div class="tw-row">
      <button class="tbtn" @click="cmd('selectAll')"><i class="fas fa-expand"></i> 全屏</button>
      <button class="tbtn" @click="cmd('cancel')"><i class="fas fa-times"></i> 取消</button>
      <template v-if="!selecting">
        <span class="tsep"></span>
        <button v-for="t in TOOLS" :key="t" class="tbtn" :class="{ on: activeTool === t }" :title="TOOL_NAMES[t]" @click="pickTool(t)">
          <i v-if="t === 'pen'" class="fas fa-pen-nib"></i>
          <i v-else-if="t === 'arrow'" class="fas fa-arrow-right"></i>
          <i v-else-if="t === 'rect'" class="fas fa-square"></i>
          <i v-else-if="t === 'ellipse'" class="fas fa-circle"></i>
          <i v-else class="fas fa-font"></i>
        </button>
        <span class="tsep"></span>
        <button v-for="c in COLORS" :key="c" class="tcolor" :class="{ on: activeColor === c }" :style="{ background: c }" @click="pickColor(c)"></button>
        <span class="tsep"></span>
        <button class="tbtn" title="撤销" @click="cmd('undo')"><i class="fas fa-undo"></i></button>
        <button class="tbtn" title="重做" @click="cmd('redo')"><i class="fas fa-redo"></i></button>
        <span class="tsep"></span>
        <button class="tbtn primary" @click="cmd('save')"><i class="fas fa-check"></i> 保存发送</button>
      </template>
    </div>
  </div>
</template>

<style scoped>
.tw {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #1b1b1f;
  color: #eee;
  font-size: 13px;
  user-select: none;
  -webkit-app-region: no-drag;
  box-sizing: border-box;
}
.tw-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 8px;
  flex: 1;
  min-width: 0;
  white-space: nowrap;
}
.tbtn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: #26262b;
  color: #e6e6e6;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
  flex-shrink: 0;
  white-space: nowrap;
}
.tbtn:hover {
  background: #33333a;
}
.tbtn.on {
  background: #2d5bd6;
  border-color: #3d74f0;
}
.tbtn.primary {
  background: #2d5bd6;
  color: #fff;
}
.tbtn.primary:hover {
  background: #3d74f0;
}
.tcolor {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.25);
  cursor: pointer;
  box-sizing: border-box;
  flex-shrink: 0;
}
.tcolor.on {
  border-color: #fff;
  box-shadow: 0 0 0 2px #2d5bd6;
}
.tsep {
  width: 1px;
  height: 20px;
  background: #3a3a40;
  margin: 0 4px;
  flex-shrink: 0;
}
</style>
