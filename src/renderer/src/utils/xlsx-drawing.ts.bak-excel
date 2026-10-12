/**
 * xlsx 绘图层解析（图片 / 图形 / 图表占位）。
 *
 * SheetJS 社区版不解析 xl/drawings/*，单元格样式之外的内容（贴图、形状、图表）拿不到，
 * 因此这里直接解析：
 *   xl/worksheets/_rels/sheetN.xml.rels  → 该工作表对应的 drawing 部件
 *   xl/drawings/drawingN.xml             → 锚点（from/to 单元格 + EMU 偏移）与对象类型
 *   xl/drawings/_rels/drawingN.xml.rels  → r:embed → media 文件
 * 坐标以「单元格 + 偏移」返回，由组件按实际渲染出的行列几何换算成像素，
 * 避免自己在列宽/行高的换算上出错。
 */

const XDR_NS = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing'
const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships'

/** 1 像素 = 9525 EMU（OOXML 约定） */
const EMU_PER_PX = 9525

/** 锚点端点：col/row 为 0 基，dx/dy 为该单元格内的像素偏移 */
export interface AnchorPoint {
  col: number
  row: number
  dx: number
  dy: number
}

export interface DrawingItem {
  kind: 'pic' | 'shape' | 'chart'
  /** 对象名（诊断用） */
  name: string
  from: AnchorPoint
  to: AnchorPoint
  /** 图形填充/描边（仅 shape） */
  fill?: string
  line?: string
  /** 圆角半径（仅 roundRect，px 由组件按尺寸推导） */
  round?: boolean
  /** 图片数据 URL（仅 pic） */
  src?: string
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
    /** 把相对 target 规范化到包内绝对路径 */
    const resolvePart = (baseDir: string, target: string): string => {
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

    const MIME: Record<string, string> = {
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      svg: 'image/svg+xml',
      emf: 'image/emf',
      wmf: 'image/wmf'
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
        if (anchor.localName !== 'twoCellAnchor' && anchor.localName !== 'oneCellAnchor' && anchor.localName !== 'absoluteAnchor') continue
        const from = parsePoint(anchor, 'from')
        let to = parsePoint(anchor, 'to')
        if (!from) continue
        // 对象自身声明的尺寸（a:xfrm/a:ext）优先于 to 锚点：
        // editAs="oneCell" 的对象尺寸是固定的，to 单元格只表示初始拖拽范围，
        // 用 to 换算在某些列宽组合下会得到负宽度（对象被整段跳过）。
        const extEl = anchor.getElementsByTagNameNS(A_NS, 'ext')[0]
        const extW = px(extEl?.getAttribute('cx'))
        const extH = px(extEl?.getAttribute('cy'))
        if (extW > 0 && extH > 0) {
          to = { col: from.col, row: from.row, dx: from.dx + extW, dy: from.dy + extH }
        } else if (!to) {
          to = { col: from.col, row: from.row, dx: from.dx, dy: from.dy }
        }

        const pic = anchor.getElementsByTagNameNS(XDR_NS, 'pic')[0]
        const sp = anchor.getElementsByTagNameNS(XDR_NS, 'sp')[0]
        const frame = anchor.getElementsByTagNameNS(XDR_NS, 'graphicFrame')[0]
        const nvName =
          anchor.getElementsByTagNameNS(XDR_NS, 'cNvPr')[0]?.getAttribute('name') ??
          anchor.getElementsByTagNameNS(XDR_NS, 'cNvPr')[0]?.getAttribute('descr') ??
          ''

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
              src = URL.createObjectURL(new Blob([buf as unknown as BlobPart], { type: MIME[ext] ?? 'application/octet-stream' }))
            }
          }
          items.push({ kind: 'pic', name: nvName, from, to, src })
          continue
        }
        if (sp) {
          const geom = sp.getElementsByTagNameNS(A_NS, 'prstGeom')[0]?.getAttribute('prst') ?? ''
          const solidFill = sp.getElementsByTagNameNS(A_NS, 'solidFill')[0]
          const srgb = solidFill?.getElementsByTagNameNS(A_NS, 'srgbClr')[0]?.getAttribute('val')
          const scheme = solidFill?.getElementsByTagNameNS(A_NS, 'schemeClr')[0]?.getAttribute('val')
          const ln = sp.getElementsByTagNameNS(A_NS, 'ln')[0]
          const lnColor = ln?.getElementsByTagNameNS(A_NS, 'srgbClr')[0]?.getAttribute('val')
          items.push({
            kind: 'shape',
            name: nvName,
            from,
            to,
            fill: srgb ? `#${srgb}` : scheme ? undefined : undefined,
            line: lnColor ? `#${lnColor}` : undefined,
            round: geom === 'roundRect'
          })
          continue
        }
        if (frame) {
          items.push({ kind: 'chart', name: nvName, from, to })
        }
      }
      if (items.length) result.set(sh.name, items)
    }
  } catch (e) {
    console.warn('[xlsx] 绘图层解析失败', e)
  }
  return result
}
