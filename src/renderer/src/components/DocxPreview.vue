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

const SVG_NS = 'http://www.w3.org/2000/svg'
const VML_NS = 'urn:schemas-microsoft-com:vml'

/** 解析 VML style 字符串为键值表 */
function styleMap(el: Element): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':')
    if (i < 0) continue
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim()
  }
  return out
}

/** VML 长度（pt/in/cm/mm/px/pc，缺省按 pt）→ 磅 */
function toPt(value: string | undefined): number | null {
  if (!value) return null
  const m = /^(-?[\d.]+)(pt|in|cm|mm|px|pc)?$/.exec(value.trim())
  if (!m) return null
  const n = parseFloat(m[1])
  switch ((m[2] ?? 'pt').toLowerCase()) {
    case 'in': return n * 72
    case 'cm': return n * 28.3465
    case 'mm': return n * 2.83465
    case 'px': return n * 0.75
    case 'pc': return n * 12
    default: return n
  }
}

/** 组内坐标（无单位）→ 数值 */
function toNum(value: string | undefined): number {
  const m = /^(-?[\d.]+)/.exec((value ?? '').trim())
  return m ? parseFloat(m[1]) : 0
}

function pair(value: string | null): [number, number] {
  const p = (value ?? '').split(',')
  return [toNum(p[0]), toNum(p[1])]
}

const fmtPt = (n: number): string => (Math.round(n * 100) / 100).toString()

/** 形状在页面上的绝对盒模型（pt） */
interface Ctx {
  x: number
  y: number
  w: number
  h: number
  /** 子元素单位 → pt 的换算比例与该坐标系原点（仅 v:group 有意义） */
  sx: number
  sy: number
  ox: number
  oy: number
  z: string
}

/**
 * 页面边距（pt）：VML 的水平定位默认相对「页边距/栏」（mso-position-horizontal-relative 缺省），
 * 垂直定位在本文档中显式声明为 page。取 w:pgMar（缇 → 磅）作为换算基准。
 */
function readPageMargins(doc: Document): { left: number; top: number } {
  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const el = doc.getElementsByTagNameNS(W_NS, 'pgMar')[0]
  if (!el) return { left: 0, top: 0 }
  const tw = (name: string): number => {
    const v = el.getAttributeNS(W_NS, name) ?? el.getAttribute(`w:${name}`)
    return v ? Number(v) / 20 : 0
  }
  return { left: tw('left'), top: tw('top') }
}

/** 递归展开一个 VML 形状/组合，把叶子形状按绝对 pt 坐标收集到 out */
function walkShape(
  el: Element,
  parent: Ctx | null,
  out: Element[],
  margins: { left: number; top: number },
  inheritZ: string
): void {
  const st = styleMap(el)
  let ctx: Ctx
  if (!parent) {
    // 顶层形状：left/top 一般是 0pt，真实偏移写在 margin-left/margin-top
    const horizRel = st['mso-position-horizontal-relative'] ?? 'margin'
    const vertRel = st['mso-position-vertical-relative'] ?? 'margin'
    ctx = {
      x: (horizRel === 'page' ? 0 : margins.left) + (toPt(st['margin-left']) ?? 0) + (toPt(st['left']) ?? 0),
      y: (vertRel === 'page' ? 0 : margins.top) + (toPt(st['margin-top']) ?? 0) + (toPt(st['top']) ?? 0),
      w: toPt(st['width']) ?? 0,
      h: toPt(st['height']) ?? 0,
      sx: 1,
      sy: 1,
      ox: 0,
      oy: 0,
      z: st['z-index'] ?? inheritZ
    }
  } else {
    // 组内形状：left/top/width/height 都是父组合坐标系里的单位
    ctx = {
      x: parent.x + (toNum(st['left'] ?? st['margin-left']) - parent.ox) * parent.sx,
      y: parent.y + (toNum(st['top'] ?? st['margin-top']) - parent.oy) * parent.sy,
      w: toNum(st['width']) * parent.sx,
      h: toNum(st['height']) * parent.sy,
      sx: 1,
      sy: 1,
      ox: 0,
      oy: 0,
      z: st['z-index'] ?? inheritZ
    }
  }

  if (el.localName === 'group') {
    const [csW, csH] = pair(el.getAttribute('coordsize'))
    const [coX, coY] = pair(el.getAttribute('coordorigin'))
    const childCtx: Ctx = {
      ...ctx,
      sx: csW > 0 ? ctx.w / csW : 1,
      sy: csH > 0 ? ctx.h / csH : 1,
      ox: coX,
      oy: coY
    }
    for (const child of Array.from(el.children)) walkShape(child, childCtx, out, margins, ctx.z)
    return
  }

  // 叶子形状：克隆后改写成显式绝对定位
  // 注意：必须写 left/top 而不是 margin-left/top —— 否则 CSS 会把 top:auto 解析为「流内静态位置」，
  // 使形状落到其锚定段落所在的文档流位置，而不是页面上声明的绝对位置。
  const clone = el.cloneNode(true) as Element
  clone.removeAttribute('o:gfxdata')
  clone.removeAttribute('o:spid')
  const keep: string[] = []
  for (const k of ['flip', 'rotation', 'mso-wrap-style', 'mso-wrap-distance-left', 'v-text-anchor']) {
    if (st[k]) keep.push(`${k}:${st[k]}`)
  }
  // VML 文本框内边距：docx-preview 不处理 inset 属性，这里编码进 style，
  // 由渲染后的 DOM 修复阶段读取并转成实际 padding（inset 缺省 = 左右 0.1in / 上下 0.05in）
  const insets = readTextboxInset(el)
  keep.push(`mso-inset-left:${fmtPt(insets.l)}pt`, `mso-inset-top:${fmtPt(insets.t)}pt`, `mso-inset-right:${fmtPt(insets.r)}pt`, `mso-inset-bottom:${fmtPt(insets.b)}pt`)
  clone.setAttribute(
    'style',
    `position:absolute;left:${fmtPt(ctx.x)}pt;top:${fmtPt(ctx.y)}pt;width:${fmtPt(ctx.w)}pt;height:${fmtPt(
      ctx.h
    )}pt;z-index:${ctx.z || '0'};margin:0;${keep.join(';')}`
  )
  out.push(clone)
}

/** 读取 v:textbox 的 inset（VML：left,top,right,bottom；两值写法为 x,y）；缺省 = 左右 0.1in、上下 0.05in */
function readTextboxInset(el: Element): { l: number; t: number; r: number; b: number } {
  const tb = Array.from(el.children).find((c) => c.localName === 'textbox')
  const raw = tb?.getAttribute('inset')
  if (raw == null) return { l: 7.2, t: 3.6, r: 7.2, b: 3.6 }
  const parts = raw.split(',').map((s) => toPt(s.trim()) ?? 0)
  if (parts.length >= 4) return { l: parts[0], t: parts[1], r: parts[2], b: parts[3] }
  if (parts.length === 2) return { l: parts[0], t: parts[1], r: parts[0], b: parts[1] }
  if (parts.length === 1) return { l: parts[0], t: parts[0], r: parts[0], b: parts[0] }
  return { l: 0, t: 0, r: 0, b: 0 }
}

/**
 * 预处理 VML 形状定位：
 *  1) 把 v:group 递归摊平成顶层形状（docx-preview 不解析组合，组内内容会被整体丢弃）；
 *  2) 把每个形状的定位改写为**显式绝对 left/top**，并补上水平方向的页边距偏移。
 *
 * 依据（用无头 LibreOffice 渲染同一文档取得的坐标反推验证）：
 *  - 该文档所有形状都写了 mso-position-vertical-relative:page，但**没有**写
 *    mso-position-horizontal-relative（VML 缺省 = 相对页边距/栏），
 *    所以 x = 页左边距 + margin-left，y = margin-top（不再叠加页上边距）。
 */
function normalizeVmlPositioning(xml: string): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const picts = Array.from(doc.getElementsByTagNameNS(W_NS, 'pict'))
  if (picts.length === 0) return xml
  const margins = readPageMargins(doc)
  let changed = 0
  for (const pict of picts) {
    for (const child of Array.from(pict.children)) {
      const ln = child.localName
      if (ln !== 'shape' && ln !== 'rect' && ln !== 'group') continue
      const out: Element[] = []
      walkShape(child, null, out, margins, styleMap(child)['z-index'] ?? '0')
      for (const el of out) pict.insertBefore(el, child)
      pict.removeChild(child)
      changed += 1
    }
  }
  if (changed === 0) return xml
  return new XMLSerializer().serializeToString(doc)
}

/**
 * 修复 docx-preview 对 VML 形状（w:pict / v:shape / v:rect）的渲染缺陷。
 *
 * 背景：docx-preview 的 supportedNamespaceURIs 是空数组，因此遇到 mc:AlternateContent 时
 * **总是选择 mc:Fallback（旧式 VML）分支**，并把 VML 形状渲染成 SVG。但它生成的 SVG 有两个问题：
 *  1) 形状被输出成 `<image>`（无 href 的空图片），而填充色写成 `<image fill="...">`；
 *     SVG 的 `<image>` 既不支持 fill 也不渲染子节点 → 色块丢失；
 *  2) 文本框内容被塞进 `<image>` 内部的 `<foreignObject>`，而浏览器会忽略 `<image>` 的子节点
 *     → 文本框里的文字**完全不可见**（整页看起来是空白）。
 *
 * 修复方式：把 `<foreignObject>` 提升为 `<svg>` 的直接子节点，并把丢失的填充色补成真正的 `<rect>`。
 * 只处理没有 href 的 `<image>`，真正的图片不受影响。
 */
function repairVmlShapes(host: HTMLElement): number {
  let fixed = 0
  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    // 读取由 XML 预处理写入的 VML 文本框内边距
    const svgStyle = svg.getAttribute('style') ?? ''
    const ins = (name: string): number => {
      const m = new RegExp(`mso-inset-${name}:\\s*(-?[\\d.]+)pt`).exec(svgStyle)
      return m ? parseFloat(m[1]) : 0
    }
    const pad = { l: ins('left'), t: ins('top'), r: ins('right'), b: ins('bottom') }
    for (const img of Array.from(svg.children)) {
      if (img.tagName.toLowerCase() !== 'image') continue
      if (img.getAttribute('href') || img.getAttribute('xlink:href')) continue // 真图片，保留
      const fill = img.getAttribute('fill')
      const hasFill = !!fill && fill !== 'none' && fill !== 'null'
      const children = Array.from(img.children)
      if (!hasFill && children.length === 0 && !img.getAttribute('width')) continue
      if (hasFill) {
        const rect = document.createElementNS(SVG_NS, 'rect')
        rect.setAttribute('x', '0')
        rect.setAttribute('y', '0')
        rect.setAttribute('width', '100%')
        rect.setAttribute('height', '100%')
        rect.setAttribute('fill', fill as string)
        svg.insertBefore(rect, img)
      }
      for (const child of children) {
        // 文本内容套一层带 padding 的 div，还原 VML 的 textbox inset
        if (child.tagName.toLowerCase() === 'foreignobject' && (pad.l || pad.t || pad.r || pad.b)) {
          const wrap = document.createElement('div')
          wrap.setAttribute(
            'style',
            `box-sizing:border-box;width:100%;height:100%;padding:${pad.t}pt ${pad.r}pt ${pad.b}pt ${pad.l}pt`
          )
          while (child.firstChild) wrap.appendChild(child.firstChild)
          child.appendChild(wrap)
        }
        svg.insertBefore(child, img)
      }
      img.remove()
      fixed += 1
    }
  }
  return fixed
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

/**
 * 预处理 .docx：把 word/*.xml 里的 VML 组合（v:group）摊平成绝对定位形状。
 * 预处理失败时回退为原始文件，保证预览本身不受影响。
 */
async function prepareDocxBlob(data: ArrayBuffer, mime: string): Promise<Blob> {
  const fallback = new Blob([data], { type: mime })
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(data)
    const targets = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
    let changed = false
    for (const name of targets) {
      const entry = zip.file(name)
      if (!entry) continue
      const xml = await entry.async('string')
      const fixed = normalizeVmlPositioning(xml)
      if (fixed && fixed !== xml) {
        zip.file(name, fixed)
        changed = true
      }
    }
    if (!changed) return fallback
    return await zip.generateAsync({ type: 'blob', mimeType: mime })
  } catch (e) {
    console.warn('[docx] 预处理失败，按原始文件渲染', e)
    return fallback
  }
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
    const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    // 先摊平 VML 组合，否则组合内的文本框会被 docx-preview 整体丢弃
    const blob = await prepareDocxBlob(r.data, mime)
    if (destroyed) return
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
    // 修复 VML 形状/文本框（见 repairVmlShapes 注释），否则浮动文本框里的文字与色块会丢失
    repairVmlShapes(host)
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
