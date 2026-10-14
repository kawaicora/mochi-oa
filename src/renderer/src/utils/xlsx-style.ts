/**
 * xlsx 单元格样式解析。
 *
 * 背景：SheetJS 社区版读取 xlsx 时，单元格的 `s` 只会解析出填充色（{patternType, fgColor, bgColor}），
 * 字体、边框、对齐、字号等信息拿不到；而 Excel 预览要还原得像 Office，恰恰需要这些。
 * 因此这里直接解析 OOXML 的三个部件并自行解析样式引用：
 *   xl/styles.xml                 → fonts / fills / borders / cellXfs
 *   xl/theme/theme1.xml           → 主题色（rgb / theme / indexed 三种取色方式都要支持）
 *   xl/worksheets/sheetN.xml      → 单元格地址 → 样式索引（含 cellXfs 的 xfId 继承）
 * 工作表名 → 部件路径 通过 xl/workbook.xml + xl/_rels/workbook.xml.rels 解析。
 */

/** 解析后的单元格样式（只保留渲染需要的字段） */
export interface CellStyle {
  bg?: string
  color?: string
  bold?: boolean
  italic?: boolean
  underline?: boolean
  /** 磅值 */
  fontSize?: number
  fontFamily?: string
  align?: 'left' | 'center' | 'right'
  valign?: 'top' | 'middle' | 'bottom'
  wrap?: boolean
  /** 四边框 CSS 简写值，如 '1px solid #d0d7de' */
  border?: { top?: string; right?: string; bottom?: string; left?: string }
}

/** 工作表名 → (单元格地址 → 样式) */
export type SheetStyleMap = Map<string, Map<string, CellStyle>>

interface RawFont {
  name?: string
  size?: number
  bold?: boolean
  italic?: boolean
  underline?: boolean
  color?: string
}

interface RawFill {
  bg?: string
}

interface RawBorderSide {
  style?: string
  color?: string
}

interface RawBorder {
  top?: RawBorderSide
  right?: RawBorderSide
  bottom?: RawBorderSide
  left?: RawBorderSide
}

interface RawXf {
  fontId: number
  fillId: number
  borderId: number
  applyFont?: boolean
  applyFill?: boolean
  applyBorder?: boolean
  applyAlignment?: boolean
  align?: CellStyle['align']
  valign?: CellStyle['valign']
  wrap?: boolean
  /** 继承自 cellStyleXfs 的 xfId */
  xfId?: number
}

const DRAWING_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const SS_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function parseXml(xml: string): Document {
  return new DOMParser().parseFromString(xml, 'application/xml')
}

function child(el: Element | Document, ns: string, name: string): Element | null {
  for (const c of Array.from(el.getElementsByTagNameNS(ns, name))) {
    if (c.parentNode === el || el.nodeType === 9) return c
  }
  return null
}

/** 规范颜色为 #rrggbb；支持 rgb / theme / indexed 三种写法 */
function normalizeColor(el: Element | null, theme: string[]): string | undefined {
  if (!el) return undefined
  const rgb = el.getAttribute('rgb')
  if (rgb) {
    const hex = rgb.length === 8 ? rgb.slice(2) : rgb
    return '#' + hex.toLowerCase()
  }
  const indexed = el.getAttribute('indexed')
  if (indexed != null) {
    const c = INDEXED_COLORS[Number(indexed)]
    if (c) return c
  }
  const themeIdx = el.getAttribute('theme')
  if (themeIdx != null) {
    const base = theme[Number(themeIdx)]
    if (base) return applyTint(base, el.getAttribute('tint'))
  }
  return undefined
}

/** OOXML tint 变换（正数变亮、负数变暗） */
function applyTint(hex: string, tint: string | null): string {
  if (!tint) return hex
  const t = parseFloat(tint)
  if (!Number.isFinite(t) || t === 0) return hex
  const n = parseInt(hex.slice(1), 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  const out = ch.map((v) => {
    const s = v / 255
    const r = t < 0 ? s * (1 + t) : s * (1 - t) + t
    return Math.max(0, Math.min(255, Math.round(r * 255)))
  })
  return '#' + out.map((v) => v.toString(16).padStart(2, '0')).join('')
}

/** Excel 索引色板（indexed 取色用，取常用前 64 项的标准调色板） */
const INDEXED_COLORS: string[] = [
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#000000', '#ffffff', '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#ff00ff', '#00ffff',
  '#800000', '#008000', '#000080', '#808000', '#800080', '#008080', '#c0c0c0', '#808080',
  '#9999ff', '#993366', '#ffffcc', '#ccffff', '#660066', '#ff8080', '#0066cc', '#ccccff',
  '#000080', '#ff00ff', '#ffff00', '#00ffff', '#800080', '#800000', '#008080', '#0000ff',
  '#00ccff', '#ccffff', '#ccffcc', '#ffff99', '#99ccff', '#ff99cc', '#cc99ff', '#ffcc99',
  '#3366ff', '#33cccc', '#99cc00', '#ffcc00', '#ff9900', '#ff6600', '#666699', '#969696',
  '#003366', '#339966', '#003300', '#333300', '#993300', '#993366', '#333399', '#333333'
]

/** 从 theme1.xml 解析 clrScheme；顺序按 OOXML 主题索引：lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink */
function parseTheme(xml: string | null): string[] {
  const fallback = [
    '#ffffff', '#000000', '#e7e6e6', '#44546a', '#4472c4', '#ed7d31',
    '#a5a5a5', '#ffc000', '#5b9bd5', '#70ad47', '#0563c1', '#954f72'
  ]
  if (!xml) return fallback
  try {
    const doc = parseXml(xml)
    const scheme = doc.getElementsByTagNameNS(DRAWING_NS, 'clrScheme')[0]
    if (!scheme) return fallback
    const pick = (name: string): string | undefined => {
      const el = scheme.getElementsByTagNameNS(DRAWING_NS, name)[0]
      if (!el) return undefined
      const srgb = el.getElementsByTagNameNS(DRAWING_NS, 'srgbClr')[0]
      if (srgb) return '#' + (srgb.getAttribute('val') ?? '').toLowerCase()
      const sys = el.getElementsByTagNameNS(DRAWING_NS, 'sysClr')[0]
      if (sys) return '#' + (sys.getAttribute('lastClr') ?? '000000').toLowerCase()
      return undefined
    }
    const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']
    const out = order.map((n, i) => pick(n) ?? fallback[i])
    return out
  } catch {
    return fallback
  }
}

const BORDER_STYLE: Record<string, string> = {
  thin: '1px solid',
  medium: '2px solid',
  thick: '3px solid',
  dashed: '1px dashed',
  dotted: '1px dotted',
  double: '3px double',
  hair: '1px solid',
  mediumDashed: '2px dashed',
  dashDot: '1px dashed',
  mediumDashDot: '2px dashed',
  dashDotDot: '1px dotted',
  mediumDashDotDot: '2px dotted',
  slantDashDot: '1px dashed'
}

function sideCss(side: RawBorderSide | undefined, defaultColor: string): string | undefined {
  if (!side || !side.style || side.style === 'none') return undefined
  const line = BORDER_STYLE[side.style] ?? '1px solid'
  return `${line} ${side.color ?? defaultColor}`
}

function alignToCss(a: string | null | undefined): CellStyle['align'] {
  if (a === 'center' || a === 'centerContinuous') return 'center'
  if (a === 'right') return 'right'
  if (a === 'left' || a === 'justify') return 'left'
  return undefined
}

function valignToCss(a: string | null | undefined): CellStyle['valign'] {
  if (a === 'center') return 'middle'
  if (a === 'top') return 'top'
  if (a === 'bottom') return 'bottom'
  return undefined
}

/**
 * 解析 xlsx 字节，返回「工作表名 → 单元格地址 → 样式」。
 * 任意步骤失败都返回空 Map（不影响值渲染）。
 */
export async function readXlsxStyles(data: ArrayBuffer): Promise<SheetStyleMap> {
  const result: SheetStyleMap = new Map()
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(data)
    const read = async (name: string): Promise<string | null> => {
      const f = zip.file(name)
      return f ? await f.async('string') : null
    }

    const stylesXml = await read('xl/styles.xml')
    const theme = parseTheme(await read('xl/theme/theme1.xml'))

    // ── styles.xml ──
    const fonts: RawFont[] = []
    const fills: RawFill[] = []
    const borders: RawBorder[] = []
    const cellXfs: RawXf[] = []
    const styleXfs: RawXf[] = []
    if (stylesXml) {
      const doc = parseXml(stylesXml)
      for (const f of Array.from(doc.getElementsByTagNameNS(SS_NS, 'font'))) {
        const sz = f.getElementsByTagNameNS(SS_NS, 'sz')[0]
        const name = f.getElementsByTagNameNS(SS_NS, 'name')[0]
        fonts.push({
          name: name?.getAttribute('val') ?? undefined,
          size: sz ? Number(sz.getAttribute('val')) : undefined,
          bold: !!f.getElementsByTagNameNS(SS_NS, 'b')[0],
          italic: !!f.getElementsByTagNameNS(SS_NS, 'i')[0],
          underline: !!f.getElementsByTagNameNS(SS_NS, 'u')[0],
          color: normalizeColor(f.getElementsByTagNameNS(SS_NS, 'color')[0] ?? null, theme)
        })
      }
      for (const f of Array.from(doc.getElementsByTagNameNS(SS_NS, 'fill'))) {
        const pf = f.getElementsByTagNameNS(SS_NS, 'patternFill')[0]
        const type = pf?.getAttribute('patternType')
        if (!pf || !type || type === 'none') {
          fills.push({})
          continue
        }
        const fg = normalizeColor(pf.getElementsByTagNameNS(SS_NS, 'fgColor')[0] ?? null, theme)
        const bg = normalizeColor(pf.getElementsByTagNameNS(SS_NS, 'bgColor')[0] ?? null, theme)
        // solid 填充用 fgColor；gray125 之类的图案填充用 bgColor 兜底
        fills.push({ bg: type === 'solid' ? (fg ?? bg) : (fg ?? bg) })
      }
      const parseBorder = (b: Element): RawBorder => {
        const side = (n: string): RawBorderSide => {
          const el = b.getElementsByTagNameNS(SS_NS, n)[0]
          if (!el) return {}
          return { style: el.getAttribute('style') ?? undefined, color: normalizeColor(el.getElementsByTagNameNS(SS_NS, 'color')[0] ?? null, theme) }
        }
        return { top: side('top'), right: side('right'), bottom: side('bottom'), left: side('left') }
      }
      for (const b of Array.from(doc.getElementsByTagNameNS(SS_NS, 'border'))) borders.push(parseBorder(b))
      const parseXf = (x: Element): RawXf => {
        const al = x.getElementsByTagNameNS(SS_NS, 'alignment')[0]
        return {
          fontId: Number(x.getAttribute('fontId') ?? 0),
          fillId: Number(x.getAttribute('fillId') ?? 0),
          borderId: Number(x.getAttribute('borderId') ?? 0),
          xfId: x.getAttribute('xfId') != null ? Number(x.getAttribute('xfId')) : undefined,
          applyFont: x.getAttribute('applyFont') === '1',
          applyFill: x.getAttribute('applyFill') === '1',
          applyBorder: x.getAttribute('applyBorder') === '1',
          applyAlignment: x.getAttribute('applyAlignment') === '1',
          align: alignToCss(al?.getAttribute('horizontal')),
          valign: valignToCss(al?.getAttribute('vertical')),
          wrap: al?.getAttribute('wrapText') === '1'
        }
      }
      for (const x of Array.from(doc.getElementsByTagNameNS(SS_NS, 'cellStyleXfs')[0]?.getElementsByTagNameNS(SS_NS, 'xf') ?? [])) {
        styleXfs.push(parseXf(x))
      }
      for (const x of Array.from(doc.getElementsByTagNameNS(SS_NS, 'cellXfs')[0]?.getElementsByTagNameNS(SS_NS, 'xf') ?? [])) {
        cellXfs.push(parseXf(x))
      }
    }

    const resolveXf = (xf: RawXf | undefined, seen = 0): CellStyle => {
      if (!xf || seen > 4) return {}
      const base = xf.xfId != null && styleXfs[xf.xfId] ? resolveXf(styleXfs[xf.xfId], seen + 1) : {}
      const font = fonts[xf.fontId]
      const fill = fills[xf.fillId]
      const border = borders[xf.borderId]
      const out: CellStyle = { ...base }
      if (font) {
        if (font.bold) out.bold = true
        if (font.italic) out.italic = true
        if (font.underline) out.underline = true
        if (font.size) out.fontSize = font.size
        if (font.name) out.fontFamily = font.name
        if (font.color) out.color = font.color
      }
      if (fill?.bg) out.bg = fill.bg
      if (border) {
        const b: NonNullable<CellStyle['border']> = {}
        const top = sideCss(border.top, '#000000')
        const right = sideCss(border.right, '#000000')
        const bottom = sideCss(border.bottom, '#000000')
        const left = sideCss(border.left, '#000000')
        if (top) b.top = top
        if (right) b.right = right
        if (bottom) b.bottom = bottom
        if (left) b.left = left
        if (Object.keys(b).length) out.border = b
      }
      if (xf.align) out.align = xf.align
      if (xf.valign) out.valign = xf.valign
      if (xf.wrap) out.wrap = true
      return out
    }

    // ── 工作表名 → 部件路径 ──
    const wbXml = await read('xl/workbook.xml')
    const relsXml = await read('xl/_rels/workbook.xml.rels')
    const relMap = new Map<string, string>()
    if (relsXml) {
      for (const r of Array.from(parseXml(relsXml).getElementsByTagName('Relationship'))) {
        const id = r.getAttribute('Id')
        const target = r.getAttribute('Target')
        if (id && target) relMap.set(id, target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, ''))
      }
    }
    const sheets: Array<{ name: string; path: string }> = []
    if (wbXml) {
      for (const sh of Array.from(parseXml(wbXml).getElementsByTagNameNS(SS_NS, 'sheet'))) {
        const name = sh.getAttribute('name') ?? ''
        const rid = sh.getAttributeNS(REL_NS, 'id') ?? sh.getAttribute('r:id') ?? ''
        const path = relMap.get(rid)
        if (name && path) sheets.push({ name, path })
      }
    }

    for (const sh of sheets) {
      const xml = await read(sh.path)
      if (!xml) continue
      const map = new Map<string, CellStyle>()
      const doc = parseXml(xml)
      for (const c of Array.from(doc.getElementsByTagNameNS(SS_NS, 'c'))) {
        const ref = c.getAttribute('r')
        const s = c.getAttribute('s')
        if (!ref || s == null) {
          // 无样式索引：仍记录空样式，避免 undefined 判断
          continue
        }
        const xf = cellXfs[Number(s)]
        if (!xf) continue
        const st = resolveXf(xf)
        if (Object.keys(st).length === 0) continue
        map.set(ref, st)
      }
      result.set(sh.name, map)
    }
  } catch (e) {
    console.warn('[xlsx] 样式解析失败，按无样式渲染', e)
  }
  return result
}
