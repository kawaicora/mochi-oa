<script setup lang="ts">
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue'

const TOOL_NAMES: Record<string, string> = { pen: '画笔', arrow: '箭头', rect: '矩形', ellipse: '椭圆', text: '文字' }
const activeTool = ref<'pen' | 'arrow' | 'rect' | 'ellipse' | 'text'>('pen')
const activeColor = ref('#ff4444')
const fontFamily = ref('sans-serif')
const fontSize = ref(20)
const COLORS = ['#ff4444', '#ff8a00', '#ffd400', '#2ee62e', '#00c8ff', '#3b6bff', '#a43bff', '#ff3bd6', '#ffffff', '#000000'] as const
const TOOLS = ['pen', 'arrow', 'rect', 'ellipse', 'text'] as const
const FONT_FAMILIES: { label: string; value: string }[] = [
  { label: '默认', value: 'sans-serif' },
  { label: '微软雅黑', value: '"Microsoft YaHei", sans-serif' },
  { label: '宋体', value: 'SimSun, serif' },
  { label: '黑体', value: 'SimHei, sans-serif' },
  { label: '楷体', value: 'KaiTi, serif' },
  { label: '等宽', value: 'Consolas, monospace' }
]
const FONT_SIZES = [16, 20, 26, 32]
// 选择阶段（未框选）只显示 全屏/取消；进入编辑后展开工具/颜色/撤销/重做/保存
const selecting = ref(true)
let offEdit: (() => void) | null = null
const rowRef = ref<HTMLElement | null>(null)

// 工具栏按内容自适应宽度：测量行实际宽度回传主进程水平居中，消除右侧多余空白
async function syncWidth(): Promise<void> {
  await nextTick()
  const el = rowRef.value
  if (!el) return
  await window.pantry.screenshotToolbarResize(Math.ceil(el.scrollWidth) + 4)
}

onMounted(() => {
  offEdit = window.pantry.onScreenshotToolbarEdit(() => {
    selecting.value = false
    void syncWidth()
  })
  void syncWidth()
})
onBeforeUnmount(() => {
  offEdit?.()
})
watch(selecting, () => void syncWidth())

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
function pickFont(f: string): void {
  fontFamily.value = f
  cmd('setFontFamily', f)
}
function pickSize(s: number): void {
  fontSize.value = s
  cmd('setFontSize', s)
}
</script>

<template>
  <div class="tw">
    <div ref="rowRef" class="tw-row">
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
        <select class="tselect" :value="fontFamily" @change="pickFont(($event.target as HTMLSelectElement).value)" title="字体">
          <option v-for="f in FONT_FAMILIES" :key="f.value" :value="f.value">{{ f.label }}</option>
        </select>
        <select class="tselect" :value="fontSize" @change="pickSize(Number(($event.target as HTMLSelectElement).value))" title="字号">
          <option v-for="s in FONT_SIZES" :key="s" :value="s">{{ s }}</option>
        </select>
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
.tselect {
  height: 26px;
  border: 1px solid #3a3a40;
  border-radius: 6px;
  background: #26262b;
  color: #e6e6e6;
  font-size: 12px;
  padding: 0 4px;
  cursor: pointer;
  outline: none;
  flex-shrink: 0;
}
.tselect option {
  background: #26262b;
  color: #e6e6e6;
}
</style>
