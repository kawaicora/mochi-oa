<script setup lang="ts">
/**
 * Word（.docx）预览（docx-preview）。
 * 通过 IPC 读取本地 .docx 字节 → docx-preview 解析为带样式的 DOM（保留字体/段落/表格/图片）：
 *  - 缩放：工具栏 ±、百分比复位、适应宽度、Ctrl+滚轮（CSS zoom，Chromium 下布局同步缩放）
 *  - 旧版二进制 .doc / 非 OOXML 文件给出明确提示
 *  - Esc 关闭、打开文件所在路径
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps<{ path: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

const scrollEl = ref<HTMLElement | null>(null)
const hostEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref('')
/** 渲染出的“页”数（docx-preview 的 section.docx） */
const pages = ref(0)
const zoom = ref(1)

const MIN_ZOOM = 0.2
const MAX_ZOOM = 4

let destroyed = false

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

function setZoom(z: number): void {
  zoom.value = clamp(Number.isFinite(z) ? z : 1, MIN_ZOOM, MAX_ZOOM)
}

/**
 * 取第一个 section 的「未缩放」页面宽度。
 * 注意：Chromium 下 zoom 子树内元素的 getBoundingClientRect 返回的是**自身坐标系**尺寸
 * （实测不乘 zoom，例如 100px 元素在 zoom:2 下仍是 100），所以这里直接就是原始宽度。
 */
function rawPageWidth(): number {
  const section = hostEl.value?.querySelector('section.docx') as HTMLElement | null
  if (!section) return 0
  const w = section.getBoundingClientRect().width
  return w > 0 ? w : 0
}

/** 适应宽度：让「页面宽度 × zoom」不超过容器可用宽度，且最多放大到 100% */
function fitWidth(): void {
  const scroller = scrollEl.value
  const raw = rawPageWidth()
  if (!scroller || !raw) return
  const avail = scroller.clientWidth - 32
  setZoom(Math.min(1, avail / raw))
}

function zoomBy(factor: number): void {
  setZoom(zoom.value * factor)
}

/** 读取 ZIP 魔数（docx 是 OOXML=zip 包）；旧版 .doc 为 OLE 复合文档 */
function isZip(buf: ArrayBuffer): boolean {
  const b = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
  return b[0] === 0x50 && b[1] === 0x4b
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/zip|end of central directory|corrupt/i.test(msg)) return '文件不是有效的 .docx（可能已损坏或被加密）'
  return `Word 解析失败：${msg || '未知错误'}`
}

function onWheel(e: WheelEvent): void {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  zoomBy(e.deltaY < 0 ? 1.1 : 1 / 1.1)
}

function onKey(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    emit('close')
    return
  }
  const tag = (e.target as HTMLElement | null)?.tagName ?? ''
  if (tag === 'INPUT' || tag === 'TEXTAREA') return
  if ((e.ctrlKey || e.metaKey) && (e.key === '=' || e.key === '+')) {
    e.preventDefault()
    zoomBy(1.2)
  } else if ((e.ctrlKey || e.metaKey) && e.key === '-') {
    e.preventDefault()
    zoomBy(1 / 1.2)
  }
}

async function openLocation(): Promise<void> {
  await window.pantry.openFileLocation(props.path)
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  scrollEl.value?.addEventListener('wheel', onWheel, { passive: false })

  const r = await window.pantry.serverReadFileBytes(props.path)
  if (destroyed) return
  if (!r.ok || !r.data) {
    loading.value = false
    error.value = r.error || '读取 Word 文件失败'
    return
  }
  if (!isZip(r.data)) {
    loading.value = false
    error.value = '该文件不是 .docx（OOXML）格式，无法预览。旧版 .doc 请先用 Word 另存为 .docx。'
    return
  }
  const host = hostEl.value
  if (!host) {
    loading.value = false
    error.value = '预览容器初始化失败'
    return
  }
  try {
    const { renderAsync } = await import('docx-preview')
    if (destroyed) return
    const blob = new Blob([r.data], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })
    await renderAsync(blob, host, undefined, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      experimental: true,
      // 图片转 data URL，避免依赖 blob 生命周期
      useBase64URL: true,
      renderHeaders: true,
      renderFooters: true,
      renderFootnotes: true,
      renderEndnotes: true,
      renderComments: true,
      renderChanges: true,
      renderAltChunks: true,
      hideWrapperOnPrint: true,
      trimXmlDeclaration: true,
      debug: false
    })
    if (destroyed) return
    pages.value = host.querySelectorAll('section.docx').length
    loading.value = false
    await nextTick()
    fitWidth()
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
  // docx-preview 会挂载样式与 DOM，随组件卸载一起销毁
  hostEl.value?.replaceChildren()
})
</script>

<template>
  <div class="docx-mask" @click.self="emit('close')">
    <div class="docx-box">
      <div class="docx-head">
        <span class="docx-title"><i class="fas fa-file-word"></i>&nbsp;Word 预览</span>
        <div class="docx-name" :title="name">{{ name }}</div>
        <button class="docx-x" title="关闭 (Esc)" @click="emit('close')"><i class="fas fa-times"></i></button>
      </div>

      <div class="docx-tool">
        <button class="docx-btn" title="缩小" @click="zoomBy(1 / 1.1)"><i class="fas fa-search-minus"></i></button>
        <button class="docx-btn docx-zoom-label" title="重置为 100%" @click="setZoom(1)">{{ Math.round(zoom * 100) }}%</button>
        <button class="docx-btn" title="放大" @click="zoomBy(1.1)"><i class="fas fa-search-plus"></i></button>
        <span class="docx-sep"></span>
        <button class="docx-btn" title="适应宽度" @click="fitWidth"><i class="fas fa-arrows-alt-h"></i></button>
        <span class="docx-spacer"></span>
        <span v-if="pages" class="docx-pages">共 {{ pages }} 页</span>
        <button class="docx-btn" title="打开文件所在路径" @click="openLocation"><i class="far fa-folder-open"></i></button>
      </div>

      <div ref="scrollEl" class="docx-scroll">
        <!-- docx-preview 把渲染结果写入该容器 -->
        <div ref="hostEl" class="docx-host" :style="{ zoom: zoom }"></div>

        <div v-if="loading" class="docx-status"><i class="fas fa-spinner fa-spin"></i>&nbsp;正在解析 Word 文档…</div>
        <div v-else-if="error" class="docx-status docx-status-err">
          <i class="fas fa-exclamation-triangle"></i>&nbsp;{{ error }}
        </div>
      </div>

      <div class="docx-foot">
        <span class="docx-hint">滚轮滚动 · Ctrl+滚轮缩放 · Esc 关闭</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.docx-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 145;
}
.docx-box {
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
.docx-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dt-border-light);
  flex-shrink: 0;
}
.docx-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dt-text);
  flex-shrink: 0;
}
.docx-title .fa-file-word {
  color: #2b579a;
}
.docx-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--dt-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.docx-x {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
  flex-shrink: 0;
}
.docx-x:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.docx-tool {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dt-border-light);
  background: #fafbfc;
  flex-shrink: 0;
}
.docx-btn {
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
.docx-btn:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.docx-zoom-label {
  min-width: 52px;
  font-variant-numeric: tabular-nums;
}
.docx-sep {
  width: 1px;
  height: 18px;
  background: var(--dt-border-light);
  margin: 0 4px;
}
.docx-spacer {
  flex: 1;
}
.docx-pages {
  font-size: 12px;
  color: var(--dt-text-3);
  margin-right: 8px;
}
.docx-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f0f2f5;
  position: relative;
}
.docx-host {
  transform-origin: top left;
}
.docx-status {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  color: var(--dt-text-3);
  font-size: 14px;
}
.docx-status-err {
  color: var(--dt-danger);
  text-align: center;
  padding: 0 24px;
  max-width: 80%;
  line-height: 1.6;
}
.docx-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--dt-border-light);
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.docx-hint {
  font-size: 12px;
  color: var(--dt-text-4);
}
/* docx-preview 生成的内容在 scoped 样式外，这里只做外层排版兜底 */
.docx-host :deep(.docx-wrapper) {
  background: transparent;
  padding: 16px;
}
.docx-host :deep(section.docx) {
  box-shadow: 0 1px 6px rgba(0, 0, 0, 0.18);
  margin-bottom: 16px;
}
</style>
