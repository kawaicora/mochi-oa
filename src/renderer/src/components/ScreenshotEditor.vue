<script setup lang="ts">
/**
 * 截屏编辑器（参考 QQ/微信截图）：
 * 阶段一 select：显示全屏截图，拖拽框选，或点“全屏”整屏；
 * 阶段二 edit：对选中区域做画笔/箭头/矩形/椭圆/文字 + 颜色选择 + 撤销/重做，保存导出 PNG。
 *
 * 交互用 pointer 事件 + pointerleave 结束 + window pointerup 兜底：不用 setPointerCapture，
 * 避免捕获未释放导致按钮点击被吞；拖出画布即结束本笔，窗口内任意位置释放也兜底结束。
 */
import { ref, nextTick, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps<{ src: string; srcWidth: number; srcHeight: number }>()
const emit = defineEmits<{ (e: 'save', dataUrl: string): void; (e: 'cancel'): void }>()

const stageCanvas = ref<HTMLCanvasElement | null>(null)
const editCanvas = ref<HTMLCanvasElement | null>(null)

const phase = ref<'select' | 'edit'>('select')
const tool = ref<'pen' | 'arrow' | 'rect' | 'ellipse' | 'text'>('pen')
const color = ref('#ff4444')

// 文字工具：点击画布放置内联输入框（Electron 下 window.prompt 不弹，改用 DOM 输入框）
const textDraft = ref<{ active: boolean; text: string; px: number; py: number; left: number; top: number }>({
  active: false,
  text: '',
  px: 0,
  py: 0,
  left: 0,
  top: 0
})
const textInputRef = ref<HTMLTextAreaElement | null>(null)

const COLORS = ['#ff4444', '#ff8a00', '#ffd400', '#2ee62e', '#00c8ff', '#3b6bff', '#a43bff', '#ff3bd6', '#ffffff', '#000000']
const TOOL_NAMES: Record<string, string> = { pen: '画笔', arrow: '箭头', rect: '矩形', ellipse: '椭圆', text: '文字' }

let img: HTMLImageElement | null = null
let sel: { x: number; y: number; w: number; h: number } | null = null // select 阶段选框（源像素）
let editing = false
let anchor: { x: number; y: number } | null = null
let pts: { x: number; y: number }[] = [] // 画笔：本笔路径点集
let undoStack: ImageData[] = []
let redoStack: ImageData[] = []

function canvasPixel(c: HTMLCanvasElement, e: PointerEvent): { x: number; y: number } {
  const r = c.getBoundingClientRect()
  return {
    x: Math.round((e.clientX - r.left) * (c.width / r.width)),
    y: Math.round((e.clientY - r.top) * (c.height / r.height))
  }
}

/* ---------- 阶段一：框选 ---------- */
function setupStage(): void {
  const c = stageCanvas.value
  if (!c || !img) return
  c.width = props.srcWidth
  c.height = props.srcHeight
  const g = c.getContext('2d')
  if (!g) return
  g.drawImage(img, 0, 0, props.srcWidth, props.srcHeight)
}
function onSelDown(e: PointerEvent): void {
  if (!stageCanvas.value) return
  editing = true
  anchor = canvasPixel(stageCanvas.value, e)
}
function onSelMove(e: PointerEvent): void {
  if (!editing || !anchor || !stageCanvas.value || !img) return
  const p = canvasPixel(stageCanvas.value, e)
  const x = Math.min(anchor.x, p.x)
  const y = Math.min(anchor.y, p.y)
  sel = { x, y, w: Math.abs(p.x - anchor.x), h: Math.abs(p.y - anchor.y) }
  const g = stageCanvas.value.getContext('2d')
  if (!g) return
  g.drawImage(img, 0, 0, props.srcWidth, props.srcHeight)
  if (sel.w > 1 || sel.h > 1) {
    g.fillStyle = 'rgba(0,120,255,0.15)'
    g.fillRect(sel.x, sel.y, sel.w, sel.h)
    g.strokeStyle = '#0084ff'
    g.lineWidth = Math.max(1, Math.round(Math.min(props.srcWidth, props.srcHeight) / 1200))
    g.strokeRect(sel.x + 0.5, sel.y + 0.5, sel.w, sel.h)
  }
}
function onSelUp(e: PointerEvent): void {
  void e
  if (!editing) return
  editing = false
  if (!sel || sel.w < 4 || sel.h < 4) {
    selectAll()
    return
  }
  enterEdit()
}
function selectAll(): void {
  sel = { x: 0, y: 0, w: props.srcWidth, h: props.srcHeight }
  enterEdit()
}
function enterEdit(): void {
  if (!sel) return
  phase.value = 'edit'
  const c = editCanvas.value
  if (!c || !img) return
  c.width = sel.w
  c.height = sel.h
  const g = c.getContext('2d')
  if (!g) return
  g.drawImage(img, sel.x, sel.y, sel.w, sel.h, 0, 0, sel.w, sel.h)
  undoStack = []
  redoStack = []
}

/* ---------- 阶段二：编辑 ---------- */
function lw(): number {
  if (!editCanvas.value) return 4
  return Math.max(2, Math.round(Math.min(editCanvas.value.width, editCanvas.value.height) / 300))
}
function snapshot(): void {
  const c = editCanvas.value
  const g = c?.getContext('2d')
  if (!c || !g) return
  if (undoStack.length > 25) undoStack.shift()
  undoStack.push(g.getImageData(0, 0, c.width, c.height))
  redoStack = []
}
function undo(): void {
  const c = editCanvas.value
  const g = c?.getContext('2d')
  if (!c || !g || !undoStack.length) return
  redoStack.push(g.getImageData(0, 0, c.width, c.height))
  g.putImageData(undoStack.pop()!, 0, 0)
}
function redo(): void {
  const c = editCanvas.value
  const g = c?.getContext('2d')
  if (!c || !g || !redoStack.length) return
  undoStack.push(g.getImageData(0, 0, c.width, c.height))
  g.putImageData(redoStack.pop()!, 0, 0)
}
function onEditDown(e: PointerEvent): void {
  const c = editCanvas.value
  if (!c) return
  anchor = canvasPixel(c, e)
  editing = true
  if (tool.value === 'pen') pts = [{ ...anchor }]
  if (tool.value === 'text') {
    // 在点击处放置内联输入框。输入框挂到 mask 下（position:absolute），
    // mask 为 fixed inset:0 覆盖视口，故 left/top 直接取视口 client 坐标即可。
    textDraft.value = {
      active: true,
      text: '',
      px: anchor.x,
      py: anchor.y,
      left: e.clientX,
      top: e.clientY
    }
    void nextTick(() => textInputRef.value?.focus())
    editing = false
  }
}
function commitText(): void {
  const d = textDraft.value
  if (!d.active) return
  const t = d.text.trim()
  d.active = false
  if (!t) return
  const c = editCanvas.value
  const g = c?.getContext('2d')
  if (!c || !g) return
  const r = c.getBoundingClientRect()
  const scale = c.width / r.width
  snapshot()
  g.fillStyle = color.value
  g.font = `600 ${Math.round(20 * scale)}px sans-serif`
  g.textBaseline = 'top'
  g.fillText(t, d.px, d.py)
}
function cancelText(): void {
  textDraft.value = { ...textDraft.value, active: false }
}
function onEditMove(e: PointerEvent): void {
  if (!editing || !anchor || tool.value === 'text') return
  const c = editCanvas.value
  const g = c?.getContext('2d')
  if (!c || !g) return
  const p = canvasPixel(c, e)
  // 恢复进入本笔前的画面（撤销本笔已画的临时内容）
  if (undoStack.length) g.putImageData(undoStack[undoStack.length - 1], 0, 0)
  g.strokeStyle = color.value
  g.fillStyle = color.value
  g.lineWidth = lw()
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const a = anchor
  if (tool.value === 'pen') {
    // 画笔：累积路径点集，恢复快照后重画整条折线（不能只画最后一段，否则只剩点/短线）
    pts.push(p)
    g.beginPath()
    g.moveTo(pts[0].x, pts[0].y)
    for (let i = 1; i < pts.length; i++) g.lineTo(pts[i].x, pts[i].y)
    g.stroke()
    return
  }
  if (tool.value === 'arrow') {
    drawArrow(g, a, p)
  } else if (tool.value === 'rect') {
    g.strokeRect(Math.min(a.x, p.x), Math.min(a.y, p.y), Math.abs(p.x - a.x), Math.abs(p.y - a.y))
  } else if (tool.value === 'ellipse') {
    g.beginPath()
    g.ellipse((a.x + p.x) / 2, (a.y + p.y) / 2, Math.abs(p.x - a.x) / 2, Math.abs(p.y - a.y) / 2, 0, 0, Math.PI * 2)
    g.stroke()
  }
}
function onEditUp(e: PointerEvent): void {
  void e
  if (!editing) return
  editing = false
  pts = []
  snapshot()
}
/** 指针离开画布（拖出窗口/拖到工具栏）立即结束本笔，防止卡死，同时不吞按钮事件 */
function onLeave(e: PointerEvent): void {
  void e
  if (phase.value === 'select') {
    editing = false
    return
  }
  const c = editCanvas.value
  if (!editing || !c) return
  editing = false
  pts = []
  snapshot()
}
function onCancel(e: PointerEvent): void {
  void e
  editing = false
  pts = []
}
/** 全局兜底：任何位置释放指针都结束当前绘制（避免窗口内拖到别处释放卡住） */
function onGlobalUp(e: PointerEvent): void {
  if (phase.value === 'select') onSelUp(e)
  else onEditUp(e)
}
function drawArrow(g: CanvasRenderingContext2D, a: { x: number; y: number }, p: { x: number; y: number }): void {
  g.beginPath()
  g.moveTo(a.x, a.y)
  g.lineTo(p.x, p.y)
  g.stroke()
  const ang = Math.atan2(p.y - a.y, p.x - a.x)
  const hs = lw() * 3.2
  const ha = Math.PI / 7
  g.beginPath()
  g.moveTo(p.x, p.y)
  g.lineTo(p.x - hs * Math.cos(ang - ha), p.y - hs * Math.sin(ang - ha))
  g.moveTo(p.x, p.y)
  g.lineTo(p.x - hs * Math.cos(ang + ha), p.y - hs * Math.sin(ang + ha))
  g.stroke()
}
function save(): void {
  const c = editCanvas.value
  if (!c) return
  emit('save', c.toDataURL('image/png'))
}

/* 键盘：Esc 取消，Enter 保存，Ctrl+Z 撤销 */
function onKey(e: KeyboardEvent): void {
  // 文字输入框聚焦时，全局快捷键停用（Esc/Enter/Ctrl+Z 已由输入框自行处理）
  if (textDraft.value.active) return
  if (e.key === 'Escape') emit('cancel')
  else if (e.key === 'Enter') save()
  else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    e.shiftKey ? redo() : undo()
  }
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('pointerup', onGlobalUp)
  img = new Image()
  img.onload = setupStage
  img.src = props.src
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('pointerup', onGlobalUp)
})
</script>

<template>
  <div class="shot-mask">
    <!-- 顶部工具栏行：作为 mask 的第一个文档流行（flex column 顶部），天然在预览区之上，整条可点 -->
    <div class="shot-toolbar-wrap">
      <!-- 框选工具栏 -->
      <div v-if="phase === 'select'" class="shot-toolbar">
        <button class="shot-btn" @click="selectAll"><i class="fas fa-expand"></i> 全屏</button>
        <span class="shot-hint">拖拽框选区域，或点“全屏”</span>
        <button class="shot-btn" @click="emit('cancel')"><i class="fas fa-times"></i> 取消</button>
      </div>

      <!-- 编辑工具栏 -->
      <div v-else class="shot-toolbar">
        <button
          v-for="t in (['pen', 'arrow', 'rect', 'ellipse', 'text'] as const)"
          :key="t"
          class="shot-btn"
          :class="{ active: tool === t }"
          :title="TOOL_NAMES[t]"
          @click="tool = t"
        >
          <i v-if="t === 'pen'" class="fas fa-pen-nib"></i>
          <i v-else-if="t === 'arrow'" class="fas fa-arrow-right"></i>
          <i v-else-if="t === 'rect'" class="fas fa-square"></i>
          <i v-else-if="t === 'ellipse'" class="fas fa-circle"></i>
          <i v-else class="fas fa-font"></i>
        </button>
        <span class="shot-sep"></span>
        <button
          v-for="c in COLORS"
          :key="c"
          class="shot-color"
          :style="{ background: c }"
          :class="{ active: color === c }"
          @click="color = c"
        ></button>
        <span class="shot-sep"></span>
        <button class="shot-btn" title="撤销 (Ctrl+Z)" @click="undo"><i class="fas fa-undo"></i></button>
        <button class="shot-btn" title="重做 (Ctrl+Shift+Z)" @click="redo"><i class="fas fa-redo"></i></button>
        <span class="shot-sep"></span>
        <button class="shot-btn" @click="emit('cancel')"><i class="fas fa-times"></i> 取消</button>
        <button class="shot-btn primary" @click="save"><i class="fas fa-check"></i> 保存发送</button>
      </div>
    </div>

    <div class="shot-stage">
      <canvas
        ref="stageCanvas"
        v-show="phase === 'select'"
        class="shot-canvas"
        @pointerdown="onSelDown"
        @pointermove="onSelMove"
        @pointerup="onSelUp"
        @pointerleave="onLeave"
        @pointercancel="onCancel"
      ></canvas>
      <canvas
        ref="editCanvas"
        v-show="phase === 'edit'"
        class="shot-canvas"
        @pointerdown="onEditDown"
        @pointermove="onEditMove"
        @pointerup="onEditUp"
        @pointerleave="onLeave"
        @pointercancel="onCancel"
      ></canvas>
    </div>

    <!-- 文字输入框：点击画布(文字工具)时出现，回车/失焦提交绘制，Esc 取消 -->
    <textarea
      v-if="textDraft.active"
      ref="textInputRef"
      class="shot-text-input"
      :style="{ left: textDraft.left + 'px', top: textDraft.top + 'px', color }"
      v-model="textDraft.text"
      rows="1"
      placeholder="输入文字…"
      @keydown.enter.prevent="commitText"
      @keydown.esc.stop.prevent="cancelText"
      @blur="commitText"
    ></textarea>
  </div>
</template>

<style scoped>
.shot-mask {
  position: fixed;
  inset: 0;
  z-index: 99999;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  cursor: crosshair;
  /* 关键：主窗口顶部有隐形标题栏拖拽区(-webkit-app-region: drag)，
     会拦截落在其上的点击/框选/绘制。截图遮罩必须声明 no-drag，
     使整块区域(含顶部工具栏)都能正常交互，不再被当作窗口拖拽。 */
  -webkit-app-region: no-drag;
  user-select: none;
}
.shot-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  box-sizing: border-box;
}
.shot-canvas {
  max-width: 100%;
  max-height: 100%;
  box-shadow: 0 6px 30px rgba(0, 0, 0, 0.5);
  background: #000;
  cursor: crosshair;
  touch-action: none;
}
.shot-toolbar-wrap {
  flex-shrink: 0;
  display: flex;
  justify-content: center;
  padding: 12px 0 4px;
  pointer-events: auto;
}
.shot-toolbar {
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(30, 30, 34, 0.95);
  border-radius: 10px;
  padding: 6px 10px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  pointer-events: auto;
  user-select: none;
}
.shot-text-input {
  position: absolute;
  z-index: 1000;
  background: transparent;
  border: 1px dashed rgba(255, 255, 255, 0.85);
  font: 600 20px sans-serif;
  outline: none;
  resize: none;
  overflow: hidden;
  min-width: 60px;
  min-height: 26px;
  padding: 2px 4px;
  line-height: 1.2;
  text-shadow: 0 0 3px rgba(0, 0, 0, 0.6);
  -webkit-app-region: no-drag;
  user-select: text;
}
.shot-text-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
  text-shadow: none;
}
.shot-hint {
  color: #cfcfd4;
  font-size: 13px;
  padding: 0 8px;
  white-space: nowrap;
}
.shot-btn {
  min-width: 34px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: #e8e8ea;
  font-size: 14px;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  user-select: none;
}
.shot-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}
.shot-btn.active {
  background: #1677ff;
  color: #fff;
}
.shot-btn.primary {
  background: #1677ff;
  color: #fff;
}
.shot-btn.primary:hover {
  background: #3a8bff;
}
.shot-sep {
  width: 1px;
  height: 20px;
  background: rgba(255, 255, 255, 0.18);
  margin: 0 2px;
}
.shot-color {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
  box-sizing: border-box;
  padding: 0;
}
.shot-color.active {
  border-color: #fff;
}
</style>
