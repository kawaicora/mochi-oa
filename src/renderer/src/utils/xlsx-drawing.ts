/**
 * xlsx 绘图层解析（图片 / 图形 / 图表占位 / 连接线 / 组合）。
 *
 * SheetJS 社区版不解析 xl/drawings/*，因此这里直接解析：
 *   xl/worksheets/_rels/sheetN.xml.rels  → 该工作表对应的 drawing 部件
 *   xl/drawings/drawingN.xml             → 锚点（from/to 单元格 + EMU 偏移）与对象类型
 *   xl/drawings/_rels/drawingN.xml.rels  → r:embed → media 文件
 *
 * 锚定规则（依据 11-excel-objects.md §1-§2 + LO drawingbase.cxx:190-302）：
 *   - twoCellAnchor：宽高 = (to.col+to.colOff) − (from.col+from.colOff) 在渲染后行列上算像素；
 *     忽略对象自身 a:xfrm/a:ext（那只是"原始"尺寸，不是显示尺寸）。
 *   - oneCellAnchor：from 单元格 + <xdr:ext cx cy>（固定尺寸）。
 *   - absoluteAnchor：<xdr:pos x y/> + <xdr:ext cx cy/>（EMU 绝对坐标，从 A1 左上角起算）。
 *   - colOff/rowOff：EMU ÷ 9525 = px。
 *
 * 形状几何复用 utils/drawingml-shapes.ts（custGeom 求值器 + 高频 prstGeom → SVG）。
 */

import {
  resolveSolidFill,
  resolveLine,
  custGeomToSvg,
  type CustGeomResult
} from './drawingml-shapes'
import type JSZipType from 'jszip'

const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006'

/** 1 像素 = 9525 EMU（96 DPI） */
const EMU_PER_PX = 9525

/** 锚点端点：col/row 为 0 基，dx/dy 为该单元格内的像素偏移 */
export interface AnchorPoint {
  col: number
  row: number
  dx: number
  dy: number
}

/** 绘图层对象 */
export interface DrawingItem {
  kind: 'pic' | 'shape' | 'chart' | 'cxnSp' | 'grpSp' | 'placeholder'
  /** 对象名（诊断/tooltip 用） */
  name: string
  /** 锚定类型 */
  anchorType: 'twoCell' | 'oneCell' | 'absolute'
  /** 单元格锚点（twoCell/oneCell 用） */
  from: AnchorPoint
  to: AnchorPoint
  /** absoluteAnchor 的 pos（EMU，从 A1 左上角起算） */
  absXEmu?: number
  absYEmu?: number
  /** 形状：prstGeom 名称（如 ellipse/roundRect/triangle） */
  prst?: string
  /** 形状：custGeom 自定义路径（优先于 prst） */
  cust?: CustGeomResult | null
  /** 形状填充 CSS 色 */
  fill?: string | null
  /** 形状描边 */
  line?: { color: string; widthPt: number }
  /** 是否无填充 */
  noFill?: boolean
  /** 形状内文本（Excel 文字不随对象缩放） */
  text?: string
  /** 旋转角度（顺时针，度） */
  rot?: number
  /** 图片数据 URL */
  src?: string
  /** 组合子对象（grpSp 用，坐标相对组） */
  children?: DrawingItem[]
  /** 识别到但暂不渲染的类型名（诊断用） */
  note?: string
}

function px(emu: string | null | undefined): number {
  const n = Number(emu ?? 0)
  return Number.isFinite(n) ? n / EMU_PER_PX : 0
}

function child(el: Element | null, ns: string, name: string): Element | null {
  if (!el) return null
  for (const c of Array.from(el.children)) if (c.localName === name && (ns === '' || c.namespaceURI === ns)) return c
  return null
}

function textOf(el: Element | null): string | null {
  return el ? el.textContent : null
}

function parsePoint(anchor: Element, which: 'from' | 'to'): AnchorPoint | null {
  const p = child(anchor, XDR_NS, which)
  if (!p) return null
  return {
    col: Number(textOf(child(p, XDR_NS, 'col')) ?? 0),
    row: Number(textOf(child(p, XDR_NS, 'row')) ?? 0),
    dx: px(textOf(child(p, XDR_NS, 'colOff'))),
    dy: px(textOf(child(p, XDR_NS, 'rowOff')))
  }
}

/** 从 sp 元素提取形状属性（fill/line/prst/cust/text/rot） */
function parseShapeProps(sp: Element): Pick<DrawingItem, 'prst' | 'cust' | 'fill' | 'line' | 'noFill' | 'text' | 'rot'> {
  const spPr = sp.getElementsByTagNameNS(A_NS, 'spPr')[0] ?? null
  const prstGeom = sp.getElementsByTagNameNS(A_NS, 'prstGeom')[0]
  const prst = prstGeom?.getAttribute('prst') ?? ''
  const cust = sp.getElementsByTagNameNS(A_NS, 'custGeom').length > 0 ? custGeomToSvg(sp) : null
  const fill = resolveSolidFill(spPr)
  const noFill = spPr ? spPr.getElementsByTagNameNS(A_NS, 'noFill').length > 0 : false
  const line = resolveLine(spPr) ?? undefined

  // 旋转：a:xfrm@rot（60000 分之一度，顺时针）
  let rot: number | undefined
  const xfrm = spPr?.getElementsByTagNameNS(A_NS, 'xfrm')[0]
  if (xfrm?.getAttribute('rot')) rot = Number(xfrm.getAttribute('rot')) / 60000

  // 文本：a:txBody/a:p/a:r/a:t
  let text: string | undefined
  const tEls = sp.getElementsByTagNameNS(A_NS, 't')
  if (tEls.length) text = Array.from(tEls).map((t) => t.textContent ?? '').join('')

  return { prst: prst || undefined, cust, fill, noFill, line, text, rot }
}

/** 解析一个锚点下的对象（pic / sp / cxnSp / grpSp / graphicFrame） */
async function parseAnchorObject(anchor: Element, dRels: Map<string, string>, zip: JSZipType, dDir: string): Promise<DrawingItem | null> {
  const nvName =
    anchor.getElementsByTagNameNS(XDR_NS, 'cNvPr')[0]?.getAttribute('name') ??
    anchor.getElementsByTagNameNS(XDR_NS, 'cNvPr')[0]?.getAttribute('descr') ??
    ''

  // --- 图片 ---
  const pic = anchor.getElementsByTagNameNS(XDR_NS, 'pic')[0]
  if (pic) {
    const blip = pic.getElementsByTagNameNS(A_NS, 'blip')[0]
    const rid = blip?.getAttributeNS(REL_NS, 'embed') ?? blip?.getAttribute('r:embed') ?? ''
    const target = dRels.get(rid)
    let src: string | undefined
    if (target) {
      const mediaPath = resolvePart(dDir, target)
      const entry = zip.file(mediaPath)
      if (entry) {
        const buf = await entry.async('uint8array')
        const ext = (mediaPath.split('.').pop() ?? '').toLowerCase()
        const MIME: Record<string, string> = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
          bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml',
          emf: 'image/emf', wmf: 'image/wmf'
        }
        src = URL.createObjectURL(new Blob([buf as unknown as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }))
      }
    }
    return { kind: 'pic', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 }, src }
  }

  // --- 形状 sp ---
  const sp = anchor.getElementsByTagNameNS(XDR_NS, 'sp')[0]
  if (sp) {
    return { kind: 'shape', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 }, ...parseShapeProps(sp) }
  }

  // --- 连接线 cxnSp ---
  const cxn = anchor.getElementsByTagNameNS(XDR_NS, 'cxnSp')[0]
  if (cxn) {
    const props = parseShapeProps(cxn)
    return { kind: 'cxnSp', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 }, ...props }
  }

  // --- 组合 grpSp（递归解析子对象） ---
  const grp = anchor.getElementsByTagNameNS(XDR_NS, 'grpSp')[0]
  if (grp) {
    // TODO: 递归解析子对象，坐标相对组的 chOff/chExt。当前先返回占位。
    return { kind: 'grpSp', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 }, note: '组合(未递归)' }
  }

  // --- 图表 graphicFrame ---
  const frame = anchor.getElementsByTagNameNS(XDR_NS, 'graphicFrame')[0]
  if (frame) {
    return { kind: 'chart', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 } }
  }

  // --- mc:AlternateContent（wps:wsp 涂鸦/墨迹等扩展） ---
  const alt = anchor.getElementsByTagNameNS(MC_NS, 'AlternateContent')[0]
  if (alt) {
    return { kind: 'placeholder', name: nvName, anchorType: 'twoCell', from: { col: 0, row: 0, dx: 0, dy: 0 }, to: { col: 0, row: 0, dx: 0, dy: 0 }, note: 'AlternateContent' }
  }

  return null
}

/** 把相对 target 规范化到包内绝对路径 */
function resolvePart(baseDir: string, target: string): string {
  if (target.startsWith('/')) return target.slice(1)
  const parts = (baseDir + '/' + target).split('/')
  const out: string[] = []
  for (const p of parts) {
    if (p === '.' || p === '') continue
    if (p === '..') out.pop()
    else out.push(p)
  }
  return out.join('/')
}

/** 解析 xlsx 里所有工作表的绘图层 */
export async function readXlsxDrawings(data: ArrayBuffer): Promise<Map<string, DrawingItem[]>> {
  const result = new Map<string, DrawingItem[]>()
  try {
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(data)
    const readText = async (name: string): Promise<string | null> => {
      const f = zip.file(name)
      return f ? await f.async('string') : null
    }
    const parseRels = (xml: string | null): Map<string, string> => {
      const m = new Map<string, string>()
      if (!xml) return m
      const doc = new DOMParser().parseFromString(xml, 'application/xml')
      for (const r of Array.from(doc.getElementsByTagNameNS(PKG_REL_NS, 'Relationship'))) {
        const id = r.getAttribute('Id')
        const target = r.getAttribute('Target')
        if (id && target) m.set(id, target)
      }
      return m
    }

    // 工作表名 → 部件路径
    const wbXml = await readText('xl/workbook.xml')
    const wbRels = parseRels(await readText('xl/_rels/workbook.xml.rels'))
    const sheets: Array<{ name: string; path: string }> = []
    if (wbXml) {
      const doc = new DOMParser().parseFromString(wbXml, 'application/xml')
      for (const sh of Array.from(doc.getElementsByTagNameNS('http://schemas.openxmlformats.org/spreadsheetml/2006/main', 'sheet'))) {
        const name = sh.getAttribute('name') ?? ''
        const rid = sh.getAttributeNS(REL_NS, 'id') ?? sh.getAttribute('r:id') ?? ''
        const target = wbRels.get(rid)
        if (name && target) sheets.push({ name, path: resolvePart('xl', target) })
      }
    }

    for (const sh of sheets) {
      const sheetDir = sh.path.slice(0, sh.path.lastIndexOf('/'))
      const sheetRels = parseRels(await readText(`${sheetDir}/_rels/${sh.path.slice(sh.path.lastIndexOf('/') + 1)}.rels`))
      // 找 drawing 关系
      let drawingPath: string | null = null
      for (const t of sheetRels.values()) {
        if (t.includes('drawings/')) {
          drawingPath = resolvePart(sheetDir, t)
          break
        }
      }
      if (!drawingPath) continue
      const dXml = await readText(drawingPath)
      if (!dXml) continue
      const dDir = drawingPath.slice(0, drawingPath.lastIndexOf('/'))
      const dRels = parseRels(await readText(`${dDir}/_rels/${drawingPath.slice(drawingPath.lastIndexOf('/') + 1)}.rels`))

      const doc = new DOMParser().parseFromString(dXml, 'application/xml')
      const items: DrawingItem[] = []

      for (const anchor of Array.from(doc.getElementsByTagNameNS(XDR_NS, '*'))) {
        const aType = anchor.localName
        if (aType !== 'twoCellAnchor' && aType !== 'oneCellAnchor' && aType !== 'absoluteAnchor') continue

        const from = parsePoint(anchor, 'from')
        const to = parsePoint(anchor, 'to')

        // --- 按锚定类型确定 from/to/尺寸 ---
        let item: DrawingItem | null = await parseAnchorObject(anchor, dRels, zip, dDir)
        if (!item) continue

        if (aType === 'twoCellAnchor') {
          if (!from || !to) continue
          item.anchorType = 'twoCell'
          item.from = from
          item.to = to
        } else if (aType === 'oneCellAnchor') {
          if (!from) continue
          // oneCellAnchor：from + <xdr:ext cx cy>（XDR 命名空间的 ext）
          const extEl = child(anchor, XDR_NS, 'ext')
          const extW = px(extEl?.getAttribute('cx'))
          const extH = px(extEl?.getAttribute('cy'))
          item.anchorType = 'oneCell'
          item.from = from
          item.to = { col: from.col, row: from.row, dx: from.dx + extW, dy: from.dy + extH }
        } else {
          // absoluteAnchor：<xdr:pos x y/> + <xdr:ext cx cy/>
          const posEl = child(anchor, XDR_NS, 'pos')
          const extEl = child(anchor, XDR_NS, 'ext')
          item.anchorType = 'absolute'
          item.absXEmu = posEl ? Number(posEl.getAttribute('x') ?? 0) : 0
          item.absYEmu = posEl ? Number(posEl.getAttribute('y') ?? 0) : 0
          const extW = px(extEl?.getAttribute('cx'))
          const extH = px(extEl?.getAttribute('cy'))
          item.from = { col: 0, row: 0, dx: 0, dy: 0 }
          item.to = { col: 0, row: 0, dx: extW, dy: extH }
        }
        items.push(item)
      }
      if (items.length) result.set(sh.name, items)
    }
  } catch (e) {
    console.warn('[xlsx] 绘图层解析失败', e)
  }
  return result
}
