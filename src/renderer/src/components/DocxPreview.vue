<script setup lang="ts">
/**
 * Word（.docx）预览（docx-preview）。
 * 通过 IPC 读取本地 .docx 字节 → docx-preview 解析为带样式的 DOM（保留字体/段落/表格/图片）：
 *  - 缩放：工具栏 ±、百分比复位、适应宽度、Ctrl+滚轮（CSS zoom，Chromium 下布局同步缩放）
 *  - 旧版二进制 .doc / 非 OOXML 文件给出明确提示
 *  - Esc 关闭、打开文件所在路径
 */
import { ref, onMounted, onBeforeUnmount, nextTick } from 'vue'

const props = defineProps<{ path: string; name: string; standalone?: boolean }>()
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
const WP_NS = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'
const WORD_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const EMU_PT = 12700

/** 页眉/页脚里的锚定图片（Word 里常见的「整页背景图」实现方式） */
interface HeaderImage {
  src: string
  hAlign: string
  vAlign: string
  w: number
  h: number
  behind: boolean
  part: string
  /** 页眉类型：default=除首页外的各页，first=仅首页，even=偶数页 */
  type: 'default' | 'first' | 'even'
}

/** JSZip 实例类型（jszip 的类型是 export = JSZip，没有 default） */
type JSZipType = Awaited<ReturnType<(typeof import('jszip'))['loadAsync']>>

/**
 * DrawingML 浮动对象的锚点信息（长度单位 pt）。
 * docx-preview 对 wp:anchor 的处理是：把图片塞进一个 0×0 的 inline-block，
 * 再用 position:relative + left/top 做偏移 —— 偏移是相对「文档流位置」而不是
 * 页面/页边距参照系，也不产生真正的浮动，所以位置会偏、文字也不会环绕。
 * 这里把锚点信息在解析前抽出来，渲染后再据此改成绝对定位。
 */
interface DrawingAnchor {
  /** inline=随文；anchor=浮动；shape=docx-preview 不渲染的 wps 形状（需自绘） */
  kind: 'inline' | 'anchor' | 'shape'
  hRef: string
  hOff: number
  hAlign: string
  vRef: string
  vOff: number
  vAlign: string
  w: number
  h: number
  behind: boolean
  wrap: string
  geom: string
  /** 自绘形状的填充/描边 */
  fill?: string
  line?: string
  /** 描边宽度（EMU→pt），line 形状高度用它 */
  lnW?: number
  /** custGeom 自定义几何图标（docx-preview 不渲染 → 按 OOXML 转 SVG path） */
  cust?: {
    paths: { d: string; w: string; h: string; fill: string; stroke: string }[]
    fill: string
    xOff: number
    yOff: number
    w: number
    h: number
  } | null
  /** 是否含图片（用于与渲染出的 <img> 按文档顺序配对） */
  hasPic: boolean
}

/**
 * 按 OOXML 标准解析 a:custGeom（自定义几何路径）→ SVG path。
 * custGeom = gdLst(guide公式) + pathLst(moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close, pt坐标)
 * 坐标是 path w/h 归一化空间内的数值；填充来自 spPr 的 solidFill。
 * spPr 可能用 a:spPr（独立 Freeform）或 wps:spPr（组合内子形状），两者都兼容。
 */
function custGeomToSvg(sp: Element): DrawingAnchor['cust'] {
  const cust = sp.getElementsByTagNameNS(A_NS, 'custGeom')[0]
  if (!cust) return null
  const pathLst = cust.getElementsByTagNameNS(A_NS, 'pathLst')[0]
  if (!pathLst) return null
  // --- gdLst 几何公式表（name -> fmla）---
  const guides: Record<string, string> = {}
  const gdLst = cust.getElementsByTagNameNS(A_NS, 'gdLst')[0]
  if (gdLst) for (const g of Array.from(gdLst.getElementsByTagNameNS(A_NS, 'gd'))) guides[g.getAttribute('name') ?? ''] = g.getAttribute('fmla') || '0'
  // --- avLst 调整值（$0,$1..；fmla 或直接数字）---
  const av: string[] = []
  const avLst = cust.getElementsByTagNameNS(A_NS, 'avLst')[0]
  if (avLst) for (const g of Array.from(avLst.getElementsByTagNameNS(A_NS, 'gd'))) av.push(g.getAttribute('fmla') || '0')
  // --- 预定义坐标 token（GetAdjCoordinate）---
  const builtin = (tok: string, W: number, H: number): number | undefined => {
    const mn = Math.min(W, H), mx = Math.max(W, H)
    switch (tok) {
      case 'w': case 'r': case 'logwidth': return W
      case 'h': case 'b': case 'logheight': return H
      case 'l': case 't': return 0
      case 'ls': return mx
      case 'ss': return mn
      case '3cd4': return 270 * 60000
      case '3cd8': return 135 * 60000
      case '5cd8': return 225 * 60000
      case '7cd8': return 315 * 60000
      case 'cd2': return 180 * 60000
      case 'cd3': return 120 * 60000
      case 'cd4': return 90 * 60000
      case 'cd8': return 45 * 60000
      case 'hd10': return H / 10
      case 'hd8': return H / 8
      case 'hd6': return H / 6
      case 'hd5': return H / 5
      case 'hd4': return H / 4
      case 'hd3': return H / 3
      case 'hd2': case 'vc': return H / 2
      case 'wd32': return W / 32
      case 'wd12': return W / 12
      case 'wd10': return W / 10
      case 'wd8': return W / 8
      case 'wd6': return W / 6
      case 'wd5': return W / 5
      case 'wd4': return W / 4
      case 'wd3': return W / 3
      case 'wd2': case 'hc': return W / 2
      case 'ssd32': return mn / 32
      case 'ssd16': return mn / 16
      case 'ssd8': return mn / 8
      case 'ssd6': return mn / 6
      case 'ssd4': return mn / 4
      case 'ssd2': return mn / 2
      default: return undefined
    }
  }
  const evalFmla = (fmla: string, W: number, H: number, stack: Set<string>): number => {
    const t = String(fmla || '0').trim().split(/\s+/)
    const op = t[0]
    const p = t.slice(1, 4).map((x) => resolve(x, W, H, stack))
    switch (op) {
      case '*/': return p.length > 2 ? (p[0] / (p[1] || 1)) * p[2] : 0
      case '+-': return p.length > 2 ? p[0] + p[1] - p[2] : 0
      case '+/': return p.length > 2 ? (p[0] + p[1]) / (p[2] || 1) : 0
      case '+': return (p[0] || 0) + (p[1] || 0)
      case '-': return (p[0] || 0) - (p[1] || 0)
      case '*': return (p[0] || 0) * (p[1] || 0)
      case '/': return (p[1] || 0) ? (p[0] || 0) / p[1] : 0
      case 'abs': return Math.abs(p[0] || 0)
      case 'at2': return Math.atan2(p[0] || 0, p[1] || 0)
      case 'cos': return (p[0] || 0) + (p[1] || 0) * Math.cos(((p[2] || 0) * Math.PI) / 180)
      case 'sin': return (p[0] || 0) + (p[1] || 0) * Math.sin(((p[2] || 0) * Math.PI) / 180)
      case 'tan': return (p[0] || 0) + (p[1] || 0) * Math.tan(((p[2] || 0) * Math.PI) / 180)
      case 'max': return Math.max(p[0] || 0, p[1] || 0)
      case 'min': return Math.min(p[0] || 0, p[1] || 0)
      case 'mod': return (p[0] || 0) % (p[1] || 1)
      case 'pin': return Math.max(p[0] || 0, Math.min(p[1] || 0, p[2] || 0))
      case 'sqrt': return Math.sqrt(Math.abs(p[0] || 0))
      case 'cat2': return Math.atan2((p[2] || 0) - (p[0] || 0), (p[3] || 0) - (p[1] || 0))
      default: return 0
    }
  }
  const resolve = (tok: string | null | undefined, W: number, H: number, stack: Set<string>): number => {
    if (tok === null || tok === undefined) return 0
    if (typeof tok === 'number') return tok
    const s = String(tok).trim()
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return parseFloat(s)
    if (s[0] === '$') { const i = parseInt(s.slice(1), 10); return resolve(av[i], W, H, stack) }
    const b = builtin(s, W, H)
    if (b !== undefined) return b
    if (Object.prototype.hasOwnProperty.call(guides, s)) {
      if (stack && stack.has(s)) return 0
      const ns = stack ? new Set(stack) : new Set<string>(); ns.add(s)
      return evalFmla(guides[s], W, H, ns)
    }
    return 0
  }
  const coord = (v: string | null | undefined, W: number, H: number): number => {
    if (v === null || v === undefined) return 0
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(String(v).trim())) return parseFloat(v)
    return resolve(v, W, H, new Set<string>())
  }
  // arcTo：椭圆弧。OOXML stAng/swAng = 60000 分之一度，逆时针，0 指向 +x（y 轴向下）。
  // 圆心 = 当前点沿主轴 +x 偏移 wR、+y 偏移 hR；弧从 stAng 起扫 swAng（ECMA-376 §20.1.9.8）
  const arcToCmd = (cur: { x: number; y: number }, wR: number, hR: number, stAng: number, swAng: number): string => {
    const st = (stAng / 60000) * Math.PI / 180
    const sw = (swAng / 60000) * Math.PI / 180
    const end = st + sw
    const cx = cur.x, cy = cur.y + hR
    const x2 = cx + wR * Math.cos(end)
    const y2 = cy + hR * Math.sin(end)
    const large = Math.abs(sw) > Math.PI ? 1 : 0
    const sweep = sw > 0 ? 1 : 0
    return `A ${wR} ${hR} 0 ${large} ${sweep} ${x2} ${y2} `
  }
  const WPS_NS = 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape'
  const findSpPr = (el: Element) =>
    el.getElementsByTagNameNS(A_NS, 'spPr')[0] || el.getElementsByTagNameNS(WPS_NS, 'spPr')[0] || null
  const SCHEME: Record<string, string> = { bg1: '#FFFFFF', bg2: '#F2F2F2', dk1: '#000000', lt1: '#FFFFFF', dk2: '#000000', lt2: '#000000', tx1: '#000000', tx2: '#000000', accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5', accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47', hlink: '#0563C1', folHlink: '#954F72' }
  let fill = '#000000'
  const spPr = findSpPr(sp)
  if (spPr) {
    const sf = spPr.getElementsByTagNameNS(A_NS, 'solidFill')[0]
    if (sf) {
      const sc = sf.getElementsByTagNameNS(A_NS, 'srgbClr')[0]
      const sch = sf.getElementsByTagNameNS(A_NS, 'schemeClr')[0]
      if (sc) fill = '#' + sc.getAttribute('val')
      else if (sch) fill = SCHEME[sch.getAttribute('val') ?? ''] || '#000000'
    }
  }
  const paths: { d: string; w: string; h: string; fill: string; stroke: string }[] = []
  for (const path of Array.from(pathLst.getElementsByTagNameNS(A_NS, 'path'))) {
    const pW = parseFloat(path.getAttribute('w') || '') || 1
    const pH = parseFloat(path.getAttribute('h') || '') || 1
    let d = ''
    let cur = { x: 0, y: 0 }
    for (let ci = 0; ci < path.childNodes.length; ci++) {
      const el = path.childNodes[ci]
      if (el.nodeType !== 1) continue
      const ln = (el as Element).localName
      const pts = Array.from(el.getElementsByTagNameNS(A_NS, 'pt'))
      const P = (q: Element | null) => (q ? { x: coord(q.getAttribute('x'), pW, pH), y: coord(q.getAttribute('y'), pW, pH) } : null)
      if (ln === 'moveTo' || ln === 'lnTo') {
        const p = P(pts[0] ?? null)
        if (p) { d += (ln === 'moveTo' ? 'M' : 'L') + p.x + ' ' + p.y + ' '; cur = p }
      } else if (ln === 'cubicBezTo') {
        if (pts.length >= 3) { const a = P(pts[0]), b = P(pts[1]), c = P(pts[2]); d += 'C' + a!.x + ' ' + a!.y + ' ' + b!.x + ' ' + b!.y + ' ' + c!.x + ' ' + c!.y + ' '; cur = c! }
      } else if (ln === 'quadBezTo') {
        if (pts.length >= 2) { const a = P(pts[0]), c = P(pts[1]); d += 'Q' + a!.x + ' ' + a!.y + ' ' + c!.x + ' ' + c!.y + ' '; cur = c! }
      } else if (ln === 'arcTo') {
        const wR = coord(el.getAttribute('wR'), pW, pH)
        const hR = coord(el.getAttribute('hR'), pW, pH)
        const stAng = coord(el.getAttribute('stAng'), pW, pH)
        const swAng = coord(el.getAttribute('swAng'), pW, pH)
        d += arcToCmd(cur, wR, hR, stAng, swAng)
      } else if (ln === 'close') {
        d += 'Z '
      }
    }
    if (!d.trim()) continue
    const pfill = path.getAttribute('fill') || 'norm'
    const pstroke = path.getAttribute('stroke') ?? 'true'
    paths.push({ d: d.trim(), w: String(pW), h: String(pH), fill: pfill, stroke: pstroke })
  }
  if (!paths.length) return null
  // 图标自身的位置与尺寸（xfrm off/ext，EMU→pt；组合内子形状以此相对 anchor 定位）
  let xOff = 0, yOff = 0, iw = 0, ih = 0
  const xfrm = spPr?.getElementsByTagNameNS(A_NS, 'xfrm')[0]
  if (xfrm) {
    const off = xfrm.getElementsByTagNameNS(A_NS, 'off')[0]
    const ext = xfrm.getElementsByTagNameNS(A_NS, 'ext')[0]
    if (off) { xOff = Number(off.getAttribute('x') || 0) / EMU_PT; yOff = Number(off.getAttribute('y') || 0) / EMU_PT }
    if (ext) { iw = Number(ext.getAttribute('cx') || 0) / EMU_PT; ih = Number(ext.getAttribute('cy') || 0) / EMU_PT }
  }
  return { paths, fill, xOff, yOff, w: iw, h: ih }
}

/** 从 DrawingML 文档里抽取锚点列表（按文档顺序） */
function collectDrawingAnchors(xml: string): DrawingAnchor[] {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const out: DrawingAnchor[] = []
  // 注意：<w:drawing> 属于 WordprocessingML 命名空间，其子节点 wp:inline/wp:anchor 才是 wp 命名空间
  const drawings = Array.from(doc.getElementsByTagNameNS(WORD_NS, 'drawing'))
  const numPt = (v: string | null | undefined): number => (v ? Number(v) / EMU_PT : 0)
  for (const d of drawings) {
    const inline = d.getElementsByTagNameNS(WP_NS, 'inline')[0]
    const anchor = d.getElementsByTagNameNS(WP_NS, 'anchor')[0]
    const node = inline ?? anchor
    if (!node) continue
    const ext = node.getElementsByTagNameNS(WP_NS, 'extent')[0]
    const w = numPt(ext?.getAttribute('cx'))
    const h = numPt(ext?.getAttribute('cy'))
    const readPos = (tag: string): { ref: string; off: number; align: string } => {
      const el = node.getElementsByTagNameNS(WP_NS, tag)[0]
      if (!el) return { ref: '', off: 0, align: '' }
      const offEl = el.getElementsByTagNameNS(WP_NS, 'posOffset')[0]
      const alignEl = el.getElementsByTagNameNS(WP_NS, 'align')[0]
      return {
        ref: el.getAttribute('relativeFrom') ?? '',
        off: numPt(offEl?.textContent),
        align: alignEl?.textContent ?? ''
      }
    }
    const posH = readPos('positionH')
    const posV = readPos('positionV')
    const pic = d.getElementsByTagNameNS(A_NS, 'blip').length > 0
    // wps 形状（文本框/几何图形）：docx-preview 不渲染，需要自绘
    const sp = d.getElementsByTagName('wps:wsp')[0] ?? null
    const solidFill = sp?.getElementsByTagNameNS(A_NS, 'solidFill')[0]
    const ln = sp?.getElementsByTagNameNS(A_NS, 'ln')[0]
    out.push({
      kind: anchor ? 'anchor' : inline ? 'inline' : 'shape',
      hRef: posH.ref,
      hOff: posH.off,
      hAlign: posH.align,
      vRef: posV.ref,
      vOff: posV.off,
      vAlign: posV.align,
      w,
      h,
      behind: anchor?.getAttribute('behindDoc') === '1',
      wrap: (anchor?.getElementsByTagNameNS(WP_NS, 'wrapThrough').length ? 'through' : '') ||
        (anchor?.getElementsByTagNameNS(WP_NS, 'wrapSquare').length ? 'square' : '') ||
        (anchor?.getElementsByTagNameNS(WP_NS, 'wrapTopAndBottom').length ? 'topAndBottom' : '') ||
        (anchor?.getElementsByTagNameNS(WP_NS, 'wrapNone').length ? 'none' : ''),
      geom: d.getElementsByTagNameNS(A_NS, 'prstGeom')[0]?.getAttribute('prst') ?? '',
      fill: solidFill?.getElementsByTagNameNS(A_NS, 'srgbClr')[0]?.getAttribute('val')
        ? '#' + solidFill.getElementsByTagNameNS(A_NS, 'srgbClr')[0].getAttribute('val')
        : undefined,
      line: ln?.getElementsByTagNameNS(A_NS, 'srgbClr')[0]?.getAttribute('val')
        ? '#' + ln.getElementsByTagNameNS(A_NS, 'srgbClr')[0].getAttribute('val')
        : undefined,
      lnW: ln ? Number(ln.getAttribute('w') || 0) / EMU_PT : undefined,
      // custGeom 自定义几何图标（wps 组合内子形状也能取到 spPr）
      cust: sp ? custGeomToSvg(sp) : null,
      hasPic: pic
    })
  }
  return out
}

/**
 * 把 SVG 图片接上：Word 的矢量图标写在 mc:AlternateContent 的 a:extLst/asvg:svgBlip 里，
 * 外层 a:blip 指向的是 PNG 回退图。docx-preview 只认 a:blip，所以图标只会以位图回退图呈现。
 * 这里直接把 a:blip 的 r:embed 改成 SVG 的关系 id，让矢量图生效。
 */
function preferSvgBlips(xml: string): string {
  if (!xml.includes('svgBlip')) return xml
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const svgBlips = Array.from(doc.getElementsByTagNameNS('http://schemas.microsoft.com/office/drawing/2016/SVG/main', 'svgBlip'))
  let n = 0
  for (const svg of svgBlips) {
    const rid = svg.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'embed') ?? svg.getAttribute('r:embed')
    if (!rid) continue
    // 该 svgBlip 所属的 a:blip（同一 a:extLst 的兄弟链上找最近的 blip）
    let host: Element | null = svg.parentElement
    while (host && host.localName !== 'blip') host = host.parentElement
    if (!host) continue
    host.setAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'r:embed', rid)
    n += 1
  }
  return n > 0 ? new XMLSerializer().serializeToString(doc) : xml
}

/** prstGeom 预设几何 → CSS 裁剪。
 *  取值依据 LibreOffice oox/source/drawingml/customshapes/presetShapeDefinitions.xml：
 *  snip2DiagRect 剪掉「右上 + 左下」两个角，剪切量 = 短边 × adj2/100000（adj2 默认 16667 = 1/6），
 *  且 x/y 用同一个绝对长度；roundRect 圆角 = 短边 × 1/6。 */
function applyGeometryMask(el: HTMLElement, geom: string, w: number, h: number): void {
  // w/h 单位为 pt，剪切量同理用 pt
  const s = Math.min(w, h) / 6
  switch (geom) {
    case 'snip2DiagRect':
      el.style.clipPath = `polygon(0 0, calc(100% - ${s}pt) 0, 100% ${s}pt, 100% 100%, ${s}pt 100%, 0 calc(100% - ${s}pt))`
      break
    case 'snip1Rect':
      el.style.clipPath = `polygon(0 0, calc(100% - ${s}pt) 0, 100% ${s}pt, 100% 100%, 0 100%)`
      break
    case 'snip2SameRect':
      el.style.clipPath = `polygon(${s}pt 0, calc(100% - ${s}pt) 0, 100% ${s}pt, 100% 100%, ${s}pt 100%, 0 calc(100% - ${s}pt), 0 ${s}pt)`
      break
    case 'roundRect':
      el.style.borderRadius = `${s}pt`
      break
    case 'ellipse':
    case 'circle':
      el.style.borderRadius = '50%'
      break
    default:
      break
  }
}

/**
 * 渲染后把 DrawingML 浮动对象改成真正的绝对定位：
 *  - 参照系：H 的 margin/column → 页左边距 + 偏移；page → 偏移；align → 按页宽算
 *  - V 的 paragraph → 「段落顶部 + 偏移」，段落顶部由 DOM 实测（Word 的 paragraph 参照系语义）
 *  - behindDoc=1 → z-index:-1：按 CSS 绘制顺序，负 z-index 子元素画在元素自身背景之后、
 *    正文内容之前，正好等价于「图片垫在文字底下」
 *  - 应用 prstGeom 遮罩；对 docx-preview 完全不渲染的 wps 形状按锚点自绘
 */
function applyDrawingAnchors(host: HTMLElement, anchors: DrawingAnchor[]): number {
  const section = host.querySelector('section.docx') as HTMLElement | null
  if (!section || anchors.length === 0) return 0
  const secRect = section.getBoundingClientRect()
  const cs = getComputedStyle(section)
  const PT2PX = 96 / 72
  const padL = (parseFloat(cs.paddingLeft) || 0) / PT2PX
  const padT = (parseFloat(cs.paddingTop) || 0) / PT2PX
  const padR = (parseFloat(cs.paddingRight) || 0) / PT2PX
  const pageWpt = section.clientWidth / PT2PX

  const imgs = Array.from(host.querySelectorAll('img')) as HTMLImageElement[]
  let applied = 0
  let imgIdx = 0

  for (const a of anchors) {
    // 目标元素：有图 → 对应的 <img> 外层容器；无图（wps 形状）→ 自绘
    let box: HTMLElement | null = null
    let target: HTMLElement | null = null
    if (a.hasPic) {
      const img = imgs[imgIdx]
      imgIdx += 1
      if (!img) continue
      target = img
      box = (img.parentElement as HTMLElement | null) ?? img
    }

    // 位置换算（pt）
    let leftPt: number
    if (a.hAlign === 'center') leftPt = (pageWpt - a.w) / 2
    else if (a.hAlign === 'right') leftPt = pageWpt - padR - a.w
    else leftPt = (a.hRef === 'page' ? 0 : padL) + a.hOff

    let topPt: number | null = null
    if (a.vAlign === 'center' || a.vAlign === 'bottom') {
      const pageHpt = section.clientHeight / PT2PX
      topPt = a.vAlign === 'center' ? (pageHpt - a.h) / 2 : pageHpt - (parseFloat(cs.paddingBottom) || 0) / PT2PX - a.h
    } else if (a.vRef === 'paragraph' || a.vRef === 'line') {
      // 段落顶部由 DOM 实测，再把偏移加上
      const para = box?.closest('p') as HTMLElement | null
      const paraTopPt = para ? (para.getBoundingClientRect().top - secRect.top) / PT2PX : 0
      topPt = paraTopPt + a.vOff
    } else {
      topPt = (a.vRef === 'page' ? 0 : padT) + a.vOff
    }

    if (a.kind === 'inline') {
      // 随文图片本来就在流里，只处理遮罩
      if (target && a.geom) applyGeometryMask(target, a.geom, a.w, a.h)
      continue
    }

    if (!box) {
      if (a.cust && a.cust.w > 0 && a.cust.h > 0) {
        // custGeom 自定义几何图标：按 xfrm 的 off/ext 相对 anchor 定位，画 SVG 路径（OOXML 标准）
        const svgBox = document.createElement('div')
        svgBox.style.cssText = `position:absolute;left:${leftPt + a.cust.xOff}pt;top:${topPt + a.cust.yOff}pt;width:${a.cust.w}pt;height:${a.cust.h}pt;`
        // 图标应绘制在正文之上、背后背景之上；behindDoc=1 的衬于文字下方 → 0
        svgBox.style.zIndex = a.behind ? '0' : '2'
        const svg = document.createElementNS(SVG_NS, 'svg')
        svg.setAttribute('viewBox', `0 0 ${a.cust.paths[0].w} ${a.cust.paths[0].h}`)
        svg.setAttribute('preserveAspectRatio', 'none')
        svg.style.cssText = 'position:absolute;left:0;top:0;width:100%;height:100%;display:block;overflow:visible'
        for (const p of a.cust.paths) {
          const pathEl = document.createElementNS(SVG_NS, 'path')
          pathEl.setAttribute('d', p.d)
          pathEl.setAttribute('fill', p.fill === 'none' ? 'none' : a.cust.fill)
          pathEl.setAttribute('fill-rule', 'nonzero')
          pathEl.setAttribute('stroke', 'none')
          svg.appendChild(pathEl)
        }
        svgBox.appendChild(svg)
        section.appendChild(svgBox)
        applied += 1
        continue
      }
      // docx-preview 未渲染的 wps 形状：按锚点自绘一个盒子
      box = document.createElement('div')
      // geom=line 的形状（直线/连接符）：高度取描边宽度 lnW，颜色取 ln 描边色（XML 数据，非猜测）
      const isLine = a.geom === 'line'
      const boxH = isLine && a.lnW ? a.lnW : a.h
      box.style.cssText = `position:absolute;left:${leftPt}pt;top:${topPt}pt;width:${a.w}pt;height:${boxH}pt;`
      if (isLine) { if (a.line) box.style.background = a.line }
      else {
        if (a.fill) box.style.background = a.fill
        if (a.line) box.style.border = `1px solid ${a.line}`
        if (a.geom) applyGeometryMask(box, a.geom, a.w, a.h)
      }
      // 普通自绘形状：behindDoc=1 的背景矩形垫底(z=0，正文文字在其上可见)；其余形状 z=2
      box.style.zIndex = a.behind ? '0' : '2'
      section.appendChild(box)
      applied += 1
      continue
    }

    // 浮动对象 → 绝对定位
    box.style.position = 'absolute'
    box.style.left = `${leftPt}pt`
    box.style.top = `${topPt}pt`
    box.style.width = `${a.w}pt`
    box.style.height = `${a.h}pt`
    box.style.margin = '0'
    box.style.float = 'none'
    // z-index:-1 → 绘制在正文之下、页面底色之上
    box.style.zIndex = a.behind ? '0' : '2'
    if (target) {
      target.style.position = 'static'
      target.style.left = '0'
      target.style.top = '0'
      target.style.width = '100%'
      target.style.height = '100%'
      // docx-preview 会把 behind 图渲染成 z-index:-1（落到页面白底背景之后不可见），
      // 这里把图片本体也提升到纸面之上
      target.style.zIndex = a.behind ? '0' : '2'
      if (a.geom) applyGeometryMask(target, a.geom, a.w, a.h)
    }
    applied += 1
  }
  return applied
}

/**
 * 收集页眉/页脚里的锚定图片。
 *
 * Word 里"整页背景图"通常不是 w:background，而是放在页眉里的锚定图片
 * （对齐方式常为 page + center）。docx-preview 不会渲染页眉里的锚定图，
 * 所以这里单独取出来，渲染后按页面参照系自行定位。
 */
async function collectHeaderImages(zip: JSZipType, docXml: string): Promise<HeaderImage[]> {
  // 页眉类型：由 document.xml 的 w:headerReference / w:footerReference 决定
  const typeByPart = new Map<string, HeaderImage['type']>()
  {
    const doc = new DOMParser().parseFromString(docXml, 'application/xml')
    const wbRels = zip.file('word/_rels/document.xml.rels')
    const relMap = new Map<string, string>()
    if (wbRels) {
      const rx = new DOMParser().parseFromString(await wbRels.async('string'), 'application/xml')
      for (const r of Array.from(rx.getElementsByTagName('Relationship'))) {
        const id = r.getAttribute('Id')
        const t = r.getAttribute('Target')
        if (id && t) relMap.set(id, t.replace(/^\.\//, ''))
      }
    }
    for (const ref of Array.from(doc.getElementsByTagNameNS(WORD_NS, 'headerReference')).concat(
      Array.from(doc.getElementsByTagNameNS(WORD_NS, 'footerReference'))
    )) {
      const rid = ref.getAttributeNS(REL_NS, 'id') ?? ref.getAttribute('r:id') ?? ''
      const target = relMap.get(rid)
      if (!target) continue
      const t = (ref.getAttributeNS(WORD_NS, 'type') ?? ref.getAttribute('w:type') ?? 'default') as HeaderImage['type']
      typeByPart.set('word/' + target, t)
    }
  }
  const out: HeaderImage[] = []
  const MIME: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
    bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml'
  }
  const resolvePart = (baseDir: string, target: string): string => {
    if (target.startsWith('/')) return target.slice(1)
    const parts = (baseDir + '/' + target).split('/')
    const stack: string[] = []
    for (const p of parts) {
      if (p === '.' || p === '') continue
      if (p === '..') stack.pop()
      else stack.push(p)
    }
    return stack.join('/')
  }
  const parts = Object.keys(zip.files).filter((n) => !zip.files[n].dir && /^word\/(header|footer)\d*\.xml$/.test(n))
  for (const part of parts) {
    const entry = zip.file(part)
    if (!entry) continue
    const xml = await entry.async('string')
    const relsPath = part.replace(/^word\//, 'word/_rels/') + '.rels'
    const relsEntry = zip.file(relsPath)
    const relMap = new Map<string, string>()
    if (relsEntry) {
      const relsDoc = new DOMParser().parseFromString(await relsEntry.async('string'), 'application/xml')
      for (const r of Array.from(relsDoc.getElementsByTagName('Relationship'))) {
        const id = r.getAttribute('Id')
        const t = r.getAttribute('Target')
        if (id && t) relMap.set(id, t)
      }
    }
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    for (const d of Array.from(doc.getElementsByTagNameNS(WORD_NS, 'drawing'))) {
      const node = d.getElementsByTagNameNS(WP_NS, 'anchor')[0] ?? d.getElementsByTagNameNS(WP_NS, 'inline')[0]
      if (!node) continue
      const ext = node.getElementsByTagNameNS(WP_NS, 'extent')[0]
      const w = Number(ext?.getAttribute('cx') ?? 0) / EMU_PT
      const h = Number(ext?.getAttribute('cy') ?? 0) / EMU_PT
      const align = (tag: string): string =>
        node.getElementsByTagNameNS(WP_NS, tag)[0]?.getElementsByTagNameNS(WP_NS, 'align')[0]?.textContent ?? ''
      const blip = d.getElementsByTagNameNS(A_NS, 'blip')[0]
      const rid = blip?.getAttributeNS(REL_NS, 'embed') ?? blip?.getAttribute('r:embed') ?? ''
      const target = relMap.get(rid)
      if (!target) continue
      const mediaPath = resolvePart('word', target)
      const mediaEntry = zip.file(mediaPath)
      if (!mediaEntry) continue
      const ext2 = (mediaPath.split('.').pop() ?? '').toLowerCase()
      const bytes = await mediaEntry.async('uint8array')
      out.push({
        src: URL.createObjectURL(new Blob([bytes as unknown as BlobPart], { type: MIME[ext2] ?? 'application/octet-stream' })),
        hAlign: align('positionH'),
        vAlign: align('positionV'),
        w,
        h,
        behind: node.getElementsByTagNameNS(WP_NS, 'anchor')[0]?.getAttribute('behindDoc') === '1',
        part,
        type: typeByPart.get(part) ?? 'default'
      })
    }
  }
  return out
}

/**
 * 把页眉/页脚图片铺到页面上。
 * 按 LibreOffice 的分层语义：页眉/页脚是独立于正文的一层，其内容位于正文之下，
 * 这里用 z-index:-1 —— 按 CSS 绘制顺序，负 z-index 子元素画在元素自身背景之后、
 * 正文内容之前，正好等价。
 */
function applyHeaderImages(host: HTMLElement, images: HeaderImage[]): number {
  if (images.length === 0) return 0
  const sections = Array.from(host.querySelectorAll('section.docx')) as HTMLElement[]
  if (sections.length === 0) return 0
  let applied = 0
  // 有首页页眉时，default 页眉不作用于首页（与 Word 的页眉类型语义一致）
  const hasFirst = images.some((i) => i.type === 'first')
  for (const im of images) {
    let targets: HTMLElement[]
    if (im.type === 'first') targets = sections.slice(0, 1)
    else if (im.type === 'even') targets = sections.filter((_, i) => i % 2 === 1)
    else targets = hasFirst ? sections.slice(1) : sections
    for (const section of targets) {
      const PT2PX = 96 / 72
      const pageW = section.clientWidth / PT2PX
      const pageH = section.clientHeight / PT2PX
      const el = document.createElement('img')
      el.src = im.src
      el.alt = ''
      el.style.position = 'absolute'
      el.style.width = `${im.w}pt`
      el.style.height = `${im.h}pt`
      el.style.left =
        (im.hAlign === 'center' ? (pageW - im.w) / 2 : im.hAlign === 'right' ? pageW - im.w : 0) + 'pt'
      el.style.top =
        (im.vAlign === 'center' ? (pageH - im.h) / 2 : im.vAlign === 'bottom' ? pageH - im.h : 0) + 'pt'
      // 页眉图不设负 z-index：-1 会被页面 section 的白底背景盖住（与验证页 applyHeaderImages 保持一致，保持默认层级可见）
      el.style.pointerEvents = 'none'
      el.dataset.headerType = im.type
      section.appendChild(el)
      applied += 1
    }
  }
  return applied
}

/**
 * 解码 VML 自由形状（o:spt="100"）的真实轮廓。
 * Word 把这类形状的几何放在 o:gfxdata 里：base64 → zip → drs/e2oDoc.xml，
 * 其中是 DrawingML 的 a:custGeom/a:pathLst。转成 SVG 的 d 字符串后按路径绘制，
 * 否则只能画成矩形（图标会变成方块）。
 */
async function decodeGfxPath(b64: string): Promise<string> {
  try {
    const JSZip = (await import('jszip')).default
    const clean = b64.replace(/&#10;/g, '').replace(/\s/g, '')
    // 渲染进程没有 Buffer，用 atob 转成字节数组
    const bin = atob(clean)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const zip = await JSZip.loadAsync(bytes)
    const entry = zip.file('drs/e2oDoc.xml')
    if (!entry) return ''
    const xml = await entry.async('string')
    const doc = new DOMParser().parseFromString(xml, 'application/xml')
    const pathEl = doc.getElementsByTagNameNS(A_NS, 'path')[0]
    if (!pathEl) return ''
    const w = Number(pathEl.getAttribute('w') ?? 0)
    const h = Number(pathEl.getAttribute('h') ?? 0)
    if (!(w > 0) || !(h > 0)) return ''
    const parts: string[] = []
    let curX = 0
    let curY = 0
    const f2 = (n: number): string => (Math.round(n * 100) / 100).toString()
    for (const cmd of Array.from(pathEl.children)) {
      const pts = Array.from(cmd.getElementsByTagNameNS(A_NS, 'pt')).map(
        (p) => `${p.getAttribute('x')} ${p.getAttribute('y')}`
      )
      switch (cmd.localName) {
        case 'moveTo':
          if (pts[0]) {
            parts.push(`M ${pts[0]}`)
            curX = Number(cmd.getElementsByTagNameNS(A_NS, 'pt')[0]?.getAttribute('x') ?? 0)
            curY = Number(cmd.getElementsByTagNameNS(A_NS, 'pt')[0]?.getAttribute('y') ?? 0)
          }
          break
        case 'lnTo':
          if (pts[0]) {
            parts.push(`L ${pts[0]}`)
            const p = cmd.getElementsByTagNameNS(A_NS, 'pt')[0]
            curX = Number(p?.getAttribute('x') ?? 0)
            curY = Number(p?.getAttribute('y') ?? 0)
          }
          break
        case 'cubicBezTo':
          if (pts.length === 3) {
            parts.push(`C ${pts.join(' ')}`)
            const p = cmd.getElementsByTagNameNS(A_NS, 'pt')[2]
            curX = Number(p?.getAttribute('x') ?? 0)
            curY = Number(p?.getAttribute('y') ?? 0)
          }
          break
        case 'quadBezTo':
          if (pts.length === 2) {
            parts.push(`Q ${pts.join(' ')}`)
            const p = cmd.getElementsByTagNameNS(A_NS, 'pt')[1]
            curX = Number(p?.getAttribute('x') ?? 0)
            curY = Number(p?.getAttribute('y') ?? 0)
          }
          break
        case 'arcTo': {
          // DrawingML 的弧：当前点即弧起点（LO 的 arc 预设先 moveTo 到起点再 arcTo），
          // 圆心 = 当前点 - (wR·cos stAng, hR·sin stAng)；角度单位为 1/60000 度。
          // 用三次贝塞尔分段逼近（每段 ≤ 90°），避免 SVG A 命令的起点/终点语义差异。
          const wR = Number(cmd.getAttribute('wR') ?? 0)
          const hR = Number(cmd.getAttribute('hR') ?? 0)
          const stAng = ((Number(cmd.getAttribute('stAng') ?? 0) / 60000) * Math.PI) / 180
          const swAng = ((Number(cmd.getAttribute('swAng') ?? 0) / 60000) * Math.PI) / 180
          if (wR > 0 && hR > 0 && Math.abs(swAng) > 1e-9) {
            const cx = curX - wR * Math.cos(stAng)
            const cy = curY - hR * Math.sin(stAng)
            const segs = Math.max(1, Math.ceil(Math.abs(swAng) / (Math.PI / 2)))
            const delta = swAng / segs
            const k = (4 / 3) * Math.tan(delta / 4)
            let a0 = stAng
            for (let s = 0; s < segs; s++) {
              const a1 = a0 + delta
              const p0x = cx + wR * Math.cos(a0)
              const p0y = cy + hR * Math.sin(a0)
              const p1x = cx + wR * Math.cos(a1)
              const p1y = cy + hR * Math.sin(a1)
              const c1x = p0x - k * wR * Math.sin(a0)
              const c1y = p0y + k * hR * Math.cos(a0)
              const c2x = p1x + k * wR * Math.sin(a1)
              const c2y = p1y - k * hR * Math.cos(a1)
              parts.push(`C ${f2(c1x)} ${f2(c1y)} ${f2(c2x)} ${f2(c2y)} ${f2(p1x)} ${f2(p1y)}`)
              curX = p1x
              curY = p1y
              a0 = a1
            }
          }
          break
        }
        case 'close':
          parts.push('Z')
          break
        default:
          break
      }
    }
    if (parts.length === 0) return ''
    // 用 "-" 分隔坐标空间与 d，避免占用 CSS 里的 ":" 和 ";"（d 里已用空格/逗号）
    return `${w},${h}-${parts.join(' ')}`
  } catch {
    return ''
  }
}

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
  inheritZ: string,
  pathMap?: Map<string, string>
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
  // 把 VML 原始形状类型带进渲染结果：docx-preview 会把 v:oval / v:roundrect 都输出成 <image>，
  // 修复阶段补底色时需要知道该补椭圆还是矩形，否则图标会被画成方块。
  keep.push(`mso-vml-shape:${el.localName}`)
  const arc = el.getAttribute('arcsize')
  if (arc) keep.push(`mso-arcsize:${arc}`)
  // VML 形状预设编号（o:spt）：20=直线，1=矩形，202=文本框，100=自由形状，203=组合
  const spt = el.getAttribute('o:spt')
  if (spt) keep.push(`mso-spt:${spt}`)
  // 描边色：直线类形状没有填充色，只有 strokecolor
  const strokeColor = el.getAttribute('strokecolor')
  if (strokeColor) keep.push(`mso-vml-stroke:${(strokeColor.match(/^#?[0-9a-fA-F]{6}/) ?? [strokeColor])[0]}`)
  const strokeW = el.getAttribute('strokeweight')
  if (strokeW) keep.push(`mso-vml-strokew:${strokeW}`)
  // 自由形状的真实轮廓（来自 o:gfxdata → e2oDoc 的 custGeom 路径）
  const gfx = el.getAttribute('o:gfxdata')
  const shapePath = gfx ? pathMap?.get(gfxKey(gfx)) : ''
  if (shapePath) keep.push(`mso-vml-path:${shapePath}`)
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
function normalizeVmlPositioning(xml: string, pathMap?: Map<string, string>): string {
  const doc = new DOMParser().parseFromString(xml, 'application/xml')
  const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  const picts = Array.from(doc.getElementsByTagNameNS(W_NS, 'pict'))
  if (picts.length === 0) return xml
  const margins = readPageMargins(doc)
  let changed = 0
  for (const pict of picts) {
    for (const child of Array.from(pict.children)) {
      const ln = child.localName
      if (ln !== 'shape' && ln !== 'rect' && ln !== 'group' && ln !== 'oval' && ln !== 'roundrect') continue
      const out: Element[] = []
      walkShape(child, null, out, margins, styleMap(child)['z-index'] ?? '0', pathMap)
      for (const el of out) pict.insertBefore(el, child)
      pict.removeChild(child)
      changed += 1
    }
  }
  if (changed === 0) return xml
  return new XMLSerializer().serializeToString(doc)
}

/** o:gfxdata 的归一化键：原始 XML 里含 &#10; 实体，getAttribute 返回的是解码后的值，两侧要统一 */
function gfxKey(s: string): string {
  return s.replace(/&#10;/g, '').replace(/\s/g, '')
}

/** 预先解码文档里所有 o:gfxdata（同一份数据只解一次） */
async function buildGfxPathMap(xml: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  if (!xml.includes('o:gfxdata')) return map
  const seen = new Set<string>()
  const re = /o:gfxdata="([^"]+)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml))) {
    const key = gfxKey(m[1])
    if (seen.has(key)) continue
    seen.add(key)
    const d = await decodeGfxPath(m[1])
    if (d) map.set(key, d)
  }
  return map
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
  const made = { rect: 0, ellipse: 0, path: 0, line: 0 }
  for (const svg of Array.from(host.querySelectorAll('svg'))) {
    // 读取由 XML 预处理写入的 VML 文本框内边距
    const svgStyle = svg.getAttribute('style') ?? ''
    const ins = (name: string): number => {
      const m = new RegExp(`mso-inset-${name}:\\s*(-?[\\d.]+)pt`).exec(svgStyle)
      return m ? parseFloat(m[1]) : 0
    }
    const pad = { l: ins('left'), t: ins('top'), r: ins('right'), b: ins('bottom') }
    // 自由形状轮廓（坐标空间与 d 之间用 "-" 分隔）
    const pathData = (new RegExp('mso-vml-path:([^;]*)').exec(svgStyle)?.[1] ?? '').trim()
    for (const img of Array.from(svg.children)) {
      if (img.tagName.toLowerCase() !== 'image') continue
      if (img.getAttribute('href') || img.getAttribute('xlink:href')) continue // 真图片，保留
      // VML 的 fillcolor 常带主题索引后缀（如 "#FFFFFF [3212]"），SVG 只认颜色本身，
      // 原样写入会成为非法值导致图形完全不绘制。只取 #RRGGBB 部分。
      const rawFill = img.getAttribute('fill')
      const fillMatch = rawFill ? /^#?([0-9a-fA-F]{6})/.exec(rawFill.trim()) : null
      const fill = fillMatch ? '#' + fillMatch[1].toLowerCase() : rawFill
      const hasFill = !!fill && fill !== 'none' && fill !== 'null'
      // 直线类形状（VML o:spt="20"）没有填充、只有描边，必须单独画，否则整条线丢失
      const spt = new RegExp('mso-spt:(\\d+)').exec(svgStyle)?.[1] ?? ''
      const strokeRaw = new RegExp('mso-vml-stroke:(#[0-9a-fA-F]{6})').exec(svgStyle)?.[1] ?? ''
      if (spt === '20' || spt === 'line') {
        const box = svg.getBoundingClientRect()
        const line = document.createElementNS(SVG_NS, 'line')
        if (box.width >= box.height) {
          line.setAttribute('x1', '0')
          line.setAttribute('y1', '50%')
          line.setAttribute('x2', '100%')
          line.setAttribute('y2', '50%')
        } else {
          line.setAttribute('x1', '50%')
          line.setAttribute('y1', '0')
          line.setAttribute('x2', '50%')
          line.setAttribute('y2', '100%')
        }
        line.setAttribute('stroke', strokeRaw || '#000000')
        line.setAttribute('stroke-width', '1')
        svg.insertBefore(line, img)
        made.line = (made.line ?? 0) + 1
        img.remove()
        fixed += 1
        continue
      }
      const children = Array.from(img.children)
      if (!hasFill && children.length === 0 && !img.getAttribute('width')) continue
      if (hasFill || pathData) {
        // 按 VML 原始形状类型补图形：有 custGeom 路径 → 画真实轮廓；
        // 椭圆用 <ellipse>、圆角矩形带 rx、其余才是矩形
        const shapeKind = (new RegExp('mso-vml-shape:([a-z]+)').exec(svgStyle)?.[1] ?? '').toLowerCase()
        let fillShape: Element
        if (pathData) {
          const [space, ...rest] = pathData.split('-')
          const [pw, ph] = space.split(',').map(Number)
          const d = rest.join('-')
          // 用实测尺寸而不是 width/height 属性：docx-preview 对部分形状不写这两个属性
          const box = svg.getBoundingClientRect()
          const wpt = ((m) => (m ? parseFloat(m[1]) : 0))(/width:([\d.]+)pt/.exec(svgStyle))
          const hpt = ((m) => (m ? parseFloat(m[1]) : 0))(/height:([\d.]+)pt/.exec(svgStyle))
          const sw = box.width || wpt * (4 / 3) || 1
          const sh = box.height || hpt * (4 / 3) || 1
          fillShape = document.createElementNS(SVG_NS, 'path')
          fillShape.setAttribute('d', d)
          if (pw > 0 && ph > 0) fillShape.setAttribute('transform', `scale(${sw / pw},${sh / ph})`)
        } else if (shapeKind === 'oval' || shapeKind === 'circle') {
          fillShape = document.createElementNS(SVG_NS, 'ellipse')
          fillShape.setAttribute('cx', '50%')
          fillShape.setAttribute('cy', '50%')
          fillShape.setAttribute('rx', '50%')
          fillShape.setAttribute('ry', '50%')
        } else {
          fillShape = document.createElementNS(SVG_NS, 'rect')
          fillShape.setAttribute('x', '0')
          fillShape.setAttribute('y', '0')
          fillShape.setAttribute('width', '100%')
          fillShape.setAttribute('height', '100%')
          if (shapeKind === 'roundrect') {
            // VML arcsize 为千分比（默认 16667→ 实际是 1/6），按短边取圆角
            const arc = Number(new RegExp('mso-arcsize:([\\d.]+)').exec(svgStyle)?.[1] ?? '')
            const frac = Number.isFinite(arc) && arc > 0 ? Math.min(arc, 50000) / 100000 : 1 / 6
            const w = parseFloat(svg.getAttribute('width') ?? '0') || 0
            const h = parseFloat(svg.getAttribute('height') ?? '0') || 0
            fillShape.setAttribute('rx', String(Math.min(w, h) * frac))
          }
        }
        fillShape.setAttribute('fill', fill as string)
        svg.insertBefore(fillShape, img)
        if (fillShape.tagName.toLowerCase() === 'path') made.path += 1
        else if (fillShape.tagName.toLowerCase() === 'ellipse') made.ellipse += 1
        else made.rect += 1
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
  if (fixed) console.log(`[docx] 修复 VML 形状 ${fixed} 个（path=${made.path} ellipse=${made.ellipse} rect=${made.rect} line=${made.line}）`)
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
 * 预处理 .docx：
 *  1) 摊平 VML 组合（v:group）并把 VML 形状归一化为绝对定位；
 *  2) 收集 DrawingML 浮动对象的锚点信息（渲染后据此做绝对定位/遮罩/z 序）；
 *  3) 把 SVG 图标（asvg:svgBlip）接到 a:blip 上，避免只显示位图回退图。
 * 预处理失败时回退为原始文件，保证预览本身不受影响。
 */
async function prepareDocxBlob(
  data: ArrayBuffer,
  mime: string
): Promise<{ blob: Blob; anchors: DrawingAnchor[]; headerImages: HeaderImage[] }> {
  const fallback = {
    blob: new Blob([data], { type: mime }),
    anchors: [] as DrawingAnchor[],
    headerImages: [] as HeaderImage[]
  }
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(data)
    const docEntry = zip.file('word/document.xml')
    const docXml = docEntry ? await docEntry.async('string') : ''
    // 页眉/页脚里的锚定图（整页背景图）单独收集，并按 w:type 区分首页/默认
    const headerImages = await collectHeaderImages(zip, docXml)
    const targets = Object.keys(zip.files).filter((n) => /^word\/(document|header\d*|footer\d*)\.xml$/.test(n))
    const anchors: DrawingAnchor[] = []
    let changed = false
    for (const name of targets) {
      const entry = zip.file(name)
      if (!entry) continue
      let xml = await entry.async('string')
      const before = xml
      xml = preferSvgBlips(xml)
      const pathMap = await buildGfxPathMap(xml)
      xml = normalizeVmlPositioning(xml, pathMap)
      if (name === 'word/document.xml') anchors.push(...collectDrawingAnchors(xml))
      if (xml !== before) {
        zip.file(name, xml)
        changed = true
      }
    }
    if (!changed) return { blob: fallback.blob, anchors, headerImages }
    return { blob: await zip.generateAsync({ type: 'blob', mimeType: mime }), anchors, headerImages }
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
    // 预处理：摊平/归一化 VML，收集 DrawingML 锚点，接上 SVG 图标
    const { blob, anchors, headerImages } = await prepareDocxBlob(r.data, mime)
    if (destroyed) return
    await renderAsync(blob, host, undefined, {
      className: 'docx',
      inWrapper: true,
      ignoreWidth: false,
      ignoreHeight: false,
      ignoreFonts: false,
      breakPages: true,
      ignoreLastRenderedPageBreak: true,
      // experimental:true 会把制表符(tab)改走 tabStopClass 定位，列表项(圆点后的 tab)会产生多余大空格；
      // 关闭（与网页版验证页默认一致）后 tab 渲染为紧凑的 \u2003，避免"圆点后面出现空格"。
      experimental: false,
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
    // DrawingML 浮动对象：按锚点改为绝对定位 + 遮罩 + z 序（behindDoc）
    const anchored = applyDrawingAnchors(host, anchors)
    if (anchored) console.log(`[docx] 已按锚点定位 ${anchored} 个浮动对象`)
    // 页眉/页脚里的整页背景图
    const heads = applyHeaderImages(host, headerImages)
    if (heads) console.log(`[docx] 已渲染 ${heads} 张页眉/页脚图片`)
    // 兜底：docx-preview 给 behind 背景图设的内联 z-index:-1 会被页面白底背景盖住（视觉不可见），
    // 统一提升到纸面之上（内联样式检测，避免 getComputedStyle 时序差异）
    for (const img of host.querySelectorAll('img')) {
      if ((img.style.zIndex || '') === '-1') img.style.zIndex = '0'
    }
    pages.value = host.querySelectorAll('section.docx').length
    loading.value = false
    await nextTick()
    // 初始保持 1:1 原始尺寸渲染（与验证页一致），避免自动 fitWidth 缩放页面造成边缘/页面间空白；
    // 用户可随时点工具栏「适应宽度」手动缩放。
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
  <div class="docx-mask" :class="{ 'docx-mask--standalone': standalone }" @click.self="emit('close')">
    <div class="docx-box">
      <div v-if="!standalone" class="docx-head">
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
.docx-mask--standalone {
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
.docx-mask--standalone .docx-box {
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  border-radius: 0;
  box-shadow: none;
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
  /* 建立层叠上下文：否则 z-index:-1 的页眉背景图/垫底图会画到页面白底之后（肉眼不可见），
     而不是"元素背景之后、正文之前"。isolation 只影响层叠，不改布局。 */
  isolation: isolate;
}
</style>
