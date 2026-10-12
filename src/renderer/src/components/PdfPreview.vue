<script setup lang="ts">
/**
 * PDF 预览（pdfjs-dist）。
 * 通过 IPC 读取已下载到本地的 PDF 字节 → pdf.js 渲染到 canvas：
 *  - 连续滚动 + 视口懒渲染：只渲染视口附近的页；滚远后释放 canvas，避免大文档内存暴涨
 *  - 工具栏：翻页 / 页码跳转 / 缩小放大 / 适应宽度 / 适应页面 / 旋转 / 打开本地位置
 *  - 交互：Ctrl+滚轮缩放、Esc 关闭、←/→ 翻页、滚轮滚动
 */
import { ref, onMounted, onBeforeUnmount, nextTick, watch } from 'vue'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PDFDocumentProxy } from 'pdfjs-dist'

const props = defineProps<{ path: string; name: string; standalone?: boolean }>()
const emit = defineEmits<{ close: [] }>()

/** 渲染任务最小接口（仅用于取消） */
interface RenderTaskLike {
  cancel: () => void
  promise: Promise<void>
}

/** 单页占位：先按原始比例撑开高度，进入视口后再渲染 canvas */
interface PageSlot {
  num: number
  /** scale=1（含当前旋转）时的显示宽高 */
  w: number
  h: number
  rendered: boolean
  /** 已渲染 canvas 对应的缩放比；与当前 zoom 不一致时需要重渲染 */
  renderedZoom: number
  task: RenderTaskLike | null
}

const scrollEl = ref<HTMLElement | null>(null)

const loading = ref(true)
const error = ref('')
const pageCount = ref(0)
const slots = ref<PageSlot[]>([])
const curPage = ref(1)
const pageInput = ref('1')
const zoom = ref(1)
const rotation = ref(0)
/** 缩放模式：width=适应宽度，page=适应页面，none=手动 */
const fitMode = ref<'width' | 'page' | 'none'>('width')

const MIN_ZOOM = 0.2
const MAX_ZOOM = 6
/** 视口上下各多少像素内的页面参与渲染 */
const RENDER_MARGIN = 480
/** 超过该距离的已渲染页面释放 canvas */
const RELEASE_MARGIN = 2600
/** 同时渲染的最大页数 */
const MAX_CONCURRENCY = 3
/** 页面左右留白（与样式 .pdf-pages padding 保持一致） */
const PAGE_PAD = 20

let doc: PDFDocumentProxy | null = null
let destroyed = false
/** 页面 canvas 宿主元素缓存（按页序，下标 = num-1） */
let hosts: HTMLElement[] = []
let scrollRaf = 0

const pending = new Set<number>()
let activeCount = 0

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function errText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? ''
  if (name === 'PasswordException') return '该 PDF 已加密，需要密码，暂不支持预览'
  if (name === 'InvalidPDFException') return 'PDF 文件已损坏或格式不正确'
  if (name === 'MissingPDFException') return 'PDF 文件不存在或已被删除'
  const msg = e instanceof Error ? e.message : String(e)
  return `PDF 解析失败：${msg || '未知错误'}`
}

// ─── 渲染调度 ───

function refreshHostCache(): void {
  hosts = Array.from(scrollEl.value?.querySelectorAll<HTMLElement>('.pdf-canvas-host') ?? [])
}

function hostOf(num: number): HTMLElement | null {
  return hosts[num - 1] ?? null
}

function cancelSlot(slot: PageSlot): void {
  try {
    slot.task?.cancel()
  } catch {
    /* 已结束的任务取消会抛错，忽略 */
  }
  slot.task = null
  slot.rendered = false
  slot.renderedZoom = 0
  hostOf(slot.num)?.replaceChildren()
}

/** 请求渲染某页（已渲染且缩放一致时跳过） */
function queueRender(num: number): void {
  const slot = slots.value[num - 1]
  if (!slot || destroyed || !doc) return
  if (slot.rendered && slot.renderedZoom === zoom.value) return
  if (pending.has(num)) return
  pending.add(num)
  pump()
}

function pump(): void {
  while (activeCount < MAX_CONCURRENCY && pending.size > 0) {
    const num = pending.values().next().value as number
    pending.delete(num)
    activeCount += 1
    void renderPage(num).finally(() => {
      activeCount -= 1
      pump()
    })
  }
}

async function renderPage(num: number): Promise<void> {
  const slot = slots.value[num - 1]
  const host = hostOf(num)
  if (destroyed || !doc || !slot || !host) return
  const z = zoom.value
  if (slot.rendered && slot.renderedZoom === z) return
  if (slot.task) return
  try {
    const page = await doc.getPage(num)
    if (destroyed || !doc) return
    // 等待期间缩放已变化：让位给新任务
    if (Math.abs(zoom.value - z) > 1e-6) {
      queueRender(num)
      return
    }
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    const viewport = page.getViewport({ scale: z * dpr, rotation: rotation.value })
    const canvas = document.createElement('canvas')
    canvas.className = 'pdf-canvas'
    canvas.width = Math.max(1, Math.floor(viewport.width))
    canvas.height = Math.max(1, Math.floor(viewport.height))
    canvas.style.width = `${viewport.width / dpr}px`
    canvas.style.height = `${viewport.height / dpr}px`
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      page.cleanup()
      return
    }
    host.replaceChildren(canvas)
    const task = page.render({ canvasContext: ctx, viewport }) as unknown as RenderTaskLike
    slot.task = task
    try {
      await task.promise
    } catch {
      /* 渲染被取消或失败：下方按 task 归属判断是否回滚 */
    }
    if (destroyed) return
    if (slot.task === task) {
      slot.task = null
      slot.rendered = true
      slot.renderedZoom = z
    }
    page.cleanup()
  } catch (e) {
    if (!destroyed) console.warn('[pdf] 渲染失败 page=' + num, e)
  }
}

/** 缩放/旋转变化：取消并清空全部已渲染页，再按可视区重建 */
function resetRenders(): void {
  pending.clear()
  for (const slot of slots.value) {
    if (slot.task || slot.rendered) cancelSlot(slot)
    else slot.renderedZoom = 0
  }
  void nextTick(() => {
    refreshHostCache()
    refreshVisible()
  })
}

/** 渲染视口附近页面 + 释放过远页面 + 更新当前页码 */
function refreshVisible(): void {
  const el = scrollEl.value
  if (!el) return
  const top = el.scrollTop - RENDER_MARGIN
  const bottom = el.scrollTop + el.clientHeight + RENDER_MARGIN
  const relTop = el.scrollTop - RELEASE_MARGIN
  const relBottom = el.scrollTop + el.clientHeight + RELEASE_MARGIN
  for (const slot of slots.value) {
    const box = hostOf(slot.num)?.parentElement
    if (!box) continue
    const y = box.offsetTop
    const h = box.offsetHeight
    if (y + h >= top && y <= bottom) {
      queueRender(slot.num)
    } else if (slot.rendered && (y + h < relTop || y > relBottom)) {
      cancelSlot(slot)
    }
  }
}

/** 当前页码：视口顶部往下 1/3 处所在的页 */
function updateCurPage(): void {
  const el = scrollEl.value
  if (!el) return
  const probe = el.scrollTop + Math.min(120, el.clientHeight / 3)
  let n = 1
  for (const slot of slots.value) {
    const box = hostOf(slot.num)?.parentElement
    if (!box) continue
    if (box.offsetTop <= probe) n = slot.num
    else break
  }
  curPage.value = n
}

function onScroll(): void {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    refreshVisible()
    updateCurPage()
  })
}

// ─── 布局 / 缩放 ───

async function applyLayout(): Promise<void> {
  if (!doc) return
  const list: PageSlot[] = []
  for (let n = 1; n <= doc.numPages; n += 1) {
    const page = await doc.getPage(n)
    if (destroyed || !doc) return
    const vp = page.getViewport({ scale: 1, rotation: rotation.value })
    list.push({ num: n, w: vp.width, h: vp.height, rendered: false, renderedZoom: 0, task: null })
  }
  slots.value = list
  await nextTick()
  refreshHostCache()
  applyFit()
  await nextTick()
  refreshHostCache()
  refreshVisible()
  updateCurPage()
}

function applyFit(): void {
  const el = scrollEl.value
  const first = slots.value[0]
  if (!el || !first) return
  const availW = Math.max(120, el.clientWidth - PAGE_PAD * 2)
  const availH = Math.max(120, el.clientHeight - PAGE_PAD * 2)
  if (fitMode.value === 'width') zoom.value = clamp(availW / first.w, MIN_ZOOM, MAX_ZOOM)
  else if (fitMode.value === 'page') zoom.value = clamp(Math.min(availW / first.w, availH / first.h), MIN_ZOOM, MAX_ZOOM)
}

/** 设置缩放：mode=none 表示手动缩放（退出适应模式） */
function setZoom(z: number, mode: 'width' | 'page' | 'none' = 'none'): void {
  const nz = clamp(Number.isFinite(z) ? z : 1, MIN_ZOOM, MAX_ZOOM)
  fitMode.value = mode
  if (Math.abs(nz - zoom.value) < 1e-6) return
  zoom.value = nz
  resetRenders()
}

function fitTo(mode: 'width' | 'page'): void {
  fitMode.value = mode
  applyFit()
  resetRenders()
}

function zoomBy(factor: number): void {
  setZoom(zoom.value * factor)
}

function rotate(): void {
  rotation.value = (rotation.value + 90) % 360
  void applyLayout()
}

function gotoPage(n: number): void {
  const target = clamp(Math.round(n) || 1, 1, Math.max(1, pageCount.value))
  const box = hostOf(target)?.parentElement
  const el = scrollEl.value
  if (!box || !el) return
  el.scrollTop = Math.max(0, box.offsetTop - PAGE_PAD)
  curPage.value = target
  onScroll()
}

watch(curPage, (n) => {
  pageInput.value = String(n)
})

// ─── 交互 ───

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.12 : 1 / 1.12)
}

function onKey(e: KeyboardEvent): void {
  const tag = (e.target as HTMLElement | null)?.tagName ?? ''
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
    e.preventDefault()
    gotoPage(curPage.value - 1)
  } else if (e.key === 'ArrowRight' || e.key === 'PageDown') {
    e.preventDefault()
    gotoPage(curPage.value + 1)
  } else if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    zoomBy(1.2)
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault()
    zoomBy(1 / 1.2)
  }
}

function onPageInput(): void {
  gotoPage(Number(pageInput.value))
  pageInput.value = String(curPage.value)
}

async function openLocation(): Promise<void> {
  await window.pantry.openFileLocation(props.path)
}

// ─── 生命周期 ───

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  scrollEl.value?.addEventListener('wheel', onWheel, { passive: false })

  const r = await window.pantry.serverReadFileBytes(props.path)
  if (destroyed) return
  if (!r.ok || !r.data) {
    loading.value = false
    error.value = r.error || '读取 PDF 文件失败'
    return
  }
  try {
    const pdfjs = await import('pdfjs-dist')
    if (destroyed) return
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    // data 会被 pdf.js 转移（detach），必须传副本；isEvalSupported=false 规避 CSP 无 unsafe-eval
    const data = new Uint8Array(r.data.slice(0))
    const task = pdfjs.getDocument({ data, isEvalSupported: false })
    doc = await task.promise
    if (destroyed) {
      void doc.destroy()
      doc = null
      return
    }
    pageCount.value = doc.numPages
    await applyLayout()
    if (!destroyed) loading.value = false
  } catch (e) {
    if (destroyed) return
    loading.value = false
    error.value = errText(e)
  }
})

onBeforeUnmount(() => {
  destroyed = true
  window.removeEventListener('keydown', onKey)
  scrollEl.value?.removeEventListener('wheel', onWheel)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
  pending.clear()
  for (const slot of slots.value) {
    try {
      slot.task?.cancel()
    } catch {
      /* 忽略 */
    }
    slot.task = null
    slot.rendered = false
  }
  hosts = []
  if (doc) {
    const d = doc
    doc = null
    void d.destroy()
  }
})
</script>

<template>
  <div class="pdf-mask" :class="{ 'pdf-mask--standalone': standalone }" @click.self="emit('close')">
    <div class="pdf-box">
      <div class="pdf-head">
        <span class="pdf-title"><i class="fas fa-file-pdf"></i>&nbsp;PDF 预览</span>
        <div class="pdf-name" :title="name">{{ name }}</div>
        <button class="pdf-x" title="关闭 (Esc)" @click="emit('close')"><i class="fas fa-times"></i></button>
      </div>

      <div class="pdf-tool">
        <button class="pdf-btn" title="上一页 (←)" :disabled="curPage <= 1" @click="gotoPage(curPage - 1)">
          <i class="fas fa-chevron-left"></i>
        </button>
        <input
          v-model="pageInput"
          class="pdf-page-input"
          type="text"
          inputmode="numeric"
          :disabled="!pageCount"
          @change="onPageInput"
          @keydown.enter.prevent="onPageInput"
        />
        <span class="pdf-page-total">/ {{ pageCount || '-' }}</span>
        <button class="pdf-btn" title="下一页 (→)" :disabled="!pageCount || curPage >= pageCount" @click="gotoPage(curPage + 1)">
          <i class="fas fa-chevron-right"></i>
        </button>

        <span class="pdf-sep"></span>

        <button class="pdf-btn" title="缩小" @click="zoomBy(1 / 1.2)"><i class="fas fa-search-minus"></i></button>
        <button class="pdf-btn pdf-zoom-label" title="重置为 100%" @click="setZoom(1)">{{ Math.round(zoom * 100) }}%</button>
        <button class="pdf-btn" title="放大" @click="zoomBy(1.2)"><i class="fas fa-search-plus"></i></button>

        <span class="pdf-sep"></span>

        <button class="pdf-btn" :class="{ on: fitMode === 'width' }" title="适应宽度" @click="fitTo('width')">
          <i class="fas fa-arrows-alt-h"></i>
        </button>
        <button class="pdf-btn" :class="{ on: fitMode === 'page' }" title="适应页面" @click="fitTo('page')">
          <i class="fas fa-expand"></i>
        </button>
        <button class="pdf-btn" title="旋转 90°" @click="rotate"><i class="fas fa-redo"></i></button>

        <span class="pdf-spacer"></span>

        <button class="pdf-btn" title="打开文件所在路径" @click="openLocation"><i class="far fa-folder-open"></i></button>
      </div>

      <div ref="scrollEl" class="pdf-pages" @scroll="onScroll">
        <div
          v-for="s in slots"
          :key="s.num"
          class="pdf-page"
          :style="{ width: s.w * zoom + 'px', height: s.h * zoom + 'px' }"
        >
          <div class="pdf-canvas-host"></div>
          <div v-if="!s.rendered" class="pdf-ph"><i class="fas fa-spinner fa-spin"></i></div>
          <span class="pdf-page-no">{{ s.num }}</span>
        </div>

        <div v-if="loading" class="pdf-status"><i class="fas fa-spinner fa-spin"></i>&nbsp;正在解析 PDF…</div>
        <div v-else-if="error" class="pdf-status pdf-status-err"><i class="fas fa-exclamation-triangle"></i>&nbsp;{{ error }}</div>
      </div>

      <div class="pdf-foot">
        <span class="pdf-hint">滚轮滚动 · Ctrl+滚轮缩放 · ←/→ 翻页 · Esc 关闭</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pdf-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 145;
}
.pdf-box {
  width: 900px;
  max-width: 94vw;
  height: 720px;
  max-height: 92vh;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.pdf-mask--standalone {
  background: #f0f2f5;
  align-items: stretch;
  justify-content: stretch;
  padding: 0;
  position: static;
  inset: auto;
  width: 100%;
  height: 100%;
  flex: 1;
  z-index: auto;
}
.pdf-mask--standalone .pdf-box {
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  border-radius: 0;
  box-shadow: none;
}
.pdf-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dt-border-light);
  flex-shrink: 0;
}
.pdf-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dt-text);
  flex-shrink: 0;
}
.pdf-title .fa-file-pdf {
  color: #e2574c;
}
.pdf-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--dt-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.pdf-x {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
  flex-shrink: 0;
}
.pdf-x:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.pdf-tool {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dt-border-light);
  background: #fafbfc;
  flex-shrink: 0;
}
.pdf-btn {
  min-width: 30px;
  height: 30px;
  padding: 0 6px;
  border-radius: 6px;
  color: var(--dt-text-2);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pdf-btn:hover:not(:disabled) {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.pdf-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.pdf-btn.on {
  background: var(--dt-active);
  color: var(--dt-primary);
}
.pdf-zoom-label {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}
.pdf-page-input {
  width: 46px;
  height: 26px;
  text-align: center;
  border: 1px solid var(--dt-border-light);
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-text);
  outline: none;
  background: #fff;
}
.pdf-page-input:focus {
  border-color: var(--dt-primary);
}
.pdf-page-total {
  font-size: 12px;
  color: var(--dt-text-3);
  margin-right: 4px;
  font-variant-numeric: tabular-nums;
}
.pdf-sep {
  width: 1px;
  height: 18px;
  background: var(--dt-border-light);
  margin: 0 4px;
}
.pdf-spacer {
  flex: 1;
}
.pdf-pages {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 20px;
  background: #f0f2f5;
  position: relative;
  text-align: center;
}
.pdf-page {
  position: relative;
  margin: 0 auto 14px;
  background: #fff;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.16);
  overflow: hidden;
  display: block;
}
.pdf-canvas-host {
  width: 100%;
  height: 100%;
}
.pdf-canvas-host :deep(canvas) {
  display: block;
}
.pdf-ph {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #c8ccd4;
  font-size: 20px;
}
.pdf-page-no {
  position: absolute;
  right: 6px;
  bottom: 6px;
  font-size: 11px;
  color: #9099a8;
  background: rgba(255, 255, 255, 0.85);
  border-radius: 4px;
  padding: 0 5px;
  pointer-events: none;
}
.pdf-status {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  color: var(--dt-text-3);
  font-size: 14px;
}
.pdf-status-err {
  color: var(--dt-danger);
  text-align: center;
  padding: 0 24px;
  max-width: 80%;
  line-height: 1.6;
}
.pdf-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--dt-border-light);
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.pdf-hint {
  font-size: 12px;
  color: var(--dt-text-4);
}
</style>
