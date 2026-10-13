/**
 * DrawingML 形状几何共享工具：custGeom 求值器 + 高频 prstGeom → SVG path + 填充/描边解析。
 *
 * 同时被 DocxPreview（wps:wsp / VML 形状）和 SheetPreview（xdr:sp / xdr:cxnSp）复用。
 * 原理依据：office-render-knowledge 03/04/05 篇；LO 源码 customshapegeometry.cxx、
 * customshapepresetdata.cxx、presetShapeDefinitions.xml。
 *
 * 约定：
 *  - 内部坐标系 w×h（w=外接框宽，h=外接框高，y 轴向下为正）。
 *  - 输出的 SVG path d 字符串在 viewBox="0 0 w h" 下使用，再 CSS 拉伸到元素像素框。
 *  - EMU→pt：1 pt = 12700 EMU。
 */

const A_NS = 'http://schemas.openxmlformats.org/drawingml/2006/main'

/** 1 pt = 12700 EMU */
export const EMU_PER_PT = 12700

/** Office 2010+ 主题色兜底（theme1.xml 缺失时的 Office 默认配色） */
export const THEME_COLORS: Record<string, string> = {
  dk1: '#000000', lt1: '#FFFFFF',
  dk2: '#44546A', lt2: '#E7E6E6',
  accent1: '#4472C4', accent2: '#ED7D31', accent3: '#A5A5A5',
  accent4: '#FFC000', accent5: '#5B9BD5', accent6: '#70AD47',
  hlink: '#0563C1', folHlink: '#954F72'
}

/** 从 spPr（或 wps:spPr）解析填充色 CSS 字符串。返回 null 表示无填充。 */
export function resolveSolidFill(spPr: Element | null | undefined): string | null {
  if (!spPr) return null
  if (spPr.getElementsByTagNameNS(A_NS, 'noFill').length > 0) return null
  const sf = spPr.getElementsByTagNameNS(A_NS, 'solidFill')[0]
  if (!sf) return null
  const srgb = sf.getElementsByTagNameNS(A_NS, 'srgbClr')[0]
  if (srgb) return '#' + (srgb.getAttribute('val') ?? '000000')
  const scheme = sf.getElementsByTagNameNS(A_NS, 'schemeClr')[0]
  if (scheme) {
    const name = scheme.getAttribute('val') ?? ''
    // schemeClr 可叠加 lumMod/lumOff/tint/shade，此处简化：直接用主题色
    return THEME_COLORS[name] ?? null
  }
  return null
}

/** 从 spPr 解析描边。返回 { color, widthPt }，无描边返回 null。 */
export function resolveLine(spPr: Element | null | undefined): { color: string; widthPt: number } | null {
  if (!spPr) return null
  const ln = spPr.getElementsByTagNameNS(A_NS, 'ln')[0]
  if (!ln) return null
  if (ln.getElementsByTagNameNS(A_NS, 'noFill').length > 0) return null
  const wAttr = ln.getAttribute('w')
  const widthPt = wAttr ? Number(wAttr) / EMU_PER_PT : 0.75
  const srgb = ln.getElementsByTagNameNS(A_NS, 'srgbClr')[0]
  const scheme = ln.getElementsByTagNameNS(A_NS, 'schemeClr')[0]
  const color = srgb
    ? '#' + (srgb.getAttribute('val') ?? '000000')
    : scheme
      ? THEME_COLORS[scheme.getAttribute('val') ?? ''] ?? '#000000'
      : '#000000'
  return { color, widthPt }
}

/** custGeom 求值结果 */
export interface CustGeomResult {
  /** SVG path d 字符串数组（在 w×h 坐标系内） */
  paths: string[]
  /** 路径坐标系宽（默认 1） */
  w: number
  /** 路径坐标系高 */
  h: number
  /** 填充色（来自 spPr solidFill） */
  fill: string
}

/**
 * 解析 a:custGeom → SVG path。
 * custGeom = gdLst(guide 公式) + pathLst(moveTo/lnTo/cubicBezTo/quadBezTo/arcTo/close)。
 * 坐标是 path w/h 归一化空间内的数值。
 */
export function custGeomToSvg(sp: Element): CustGeomResult | null {
  const cust = sp.getElementsByTagNameNS(A_NS, 'custGeom')[0]
  if (!cust) return null
  const pathLst = cust.getElementsByTagNameNS(A_NS, 'pathLst')[0]
  if (!pathLst) return null

  // --- gdLst 几何公式表 ---
  const guides: Record<string, string> = {}
  const gdLst = cust.getElementsByTagNameNS(A_NS, 'gdLst')[0]
  if (gdLst) for (const g of Array.from(gdLst.getElementsByTagNameNS(A_NS, 'gd'))) {
    guides[g.getAttribute('name') ?? ''] = g.getAttribute('fmla') || '0'
  }
  // --- avLst 调整值（$0,$1..） ---
  const av: string[] = []
  const avLst = cust.getElementsByTagNameNS(A_NS, 'avLst')[0]
  if (avLst) for (const g of Array.from(avLst.getElementsByTagNameNS(A_NS, 'gd'))) {
    av.push(g.getAttribute('fmla') || '0')
  }

  const builtin = (tok: string, W: number, H: number): number | undefined => {
    const mn = Math.min(W, H)
    switch (tok) {
      case 'w': case 'r': return W
      case 'h': case 'b': return H
      case 'l': case 't': return 0
      case 'ss': return mn
      case 'sd2': case 'ssd2': return mn / 2
      case 'cd2': return 180 * 60000
      case 'cd4': return 90 * 60000
      case '3cd4': return 270 * 60000
      case 'hd2': case 'vc': return H / 2
      case 'hd3': return H / 3
      case 'hd4': return H / 4
      case 'wd2': case 'hc': return W / 2
      case 'wd3': return W / 3
      case 'wd4': return W / 4
      default: return undefined
    }
  }

  const resolve = (tok: string | null | undefined, W: number, H: number, stack: Set<string>): number => {
    if (tok == null) return 0
    const s = String(tok).trim()
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(s)) return parseFloat(s)
    if (s[0] === '$') {
      const i = parseInt(s.slice(1), 10)
      return resolve(av[i], W, H, stack)
    }
    const b = builtin(s, W, H)
    if (b !== undefined) return b
    if (Object.prototype.hasOwnProperty.call(guides, s)) {
      if (stack.has(s)) return 0
      const ns = new Set(stack); ns.add(s)
      return evalFmla(guides[s], W, H, ns)
    }
    return 0
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
      case '/': return p[1] ? p[0] / p[1] : 0
      case 'abs': return Math.abs(p[0] || 0)
      case 'max': return Math.max(p[0] || 0, p[1] || 0)
      case 'min': return Math.min(p[0] || 0, p[1] || 0)
      case 'pin': return Math.max(p[0] || 0, Math.min(p[1] || 0, p[2] || 0))
      case 'sqrt': return Math.sqrt(Math.abs(p[0] || 0))
      case 'mod': return (p[0] || 0) % (p[1] || 1)
      case 'cos': return (p[0] || 0) + (p[1] || 0) * Math.cos(((p[2] || 0) * Math.PI) / 180)
      case 'sin': return (p[0] || 0) + (p[1] || 0) * Math.sin(((p[2] || 0) * Math.PI) / 180)
      case 'tan': return (p[0] || 0) + (p[1] || 0) * Math.tan(((p[2] || 0) * Math.PI) / 180)
      default: return 0
    }
  }

  const coord = (v: string | null | undefined, W: number, H: number): number => {
    if (v == null) return 0
    if (/^-?[0-9]+(\.[0-9]+)?$/.test(String(v).trim())) return parseFloat(v)
    return resolve(v, W, H, new Set<string>())
  }

  // arcTo：椭圆弧，stAng/swAng 单位 60000 分之一度
  const arcToCmd = (cur: { x: number; y: number }, wR: number, hR: number, stAng: number, swAng: number): string => {
    const st = (stAng / 60000) * Math.PI / 180
    const sw = (swAng / 60000) * Math.PI / 180
    const end = st + sw
    const cx = cur.x, cy = cur.y + hR
    const x2 = cx + wR * Math.cos(end)
    const y2 = cy + hR * Math.sin(end)
    const large = Math.abs(sw) > Math.PI ? 1 : 0
    const sweep = sw > 0 ? 1 : 0
    return `A ${wR.toFixed(2)} ${hR.toFixed(2)} 0 ${large} ${sweep} ${x2.toFixed(2)} ${y2.toFixed(2)}`
  }

  // 填充色
  const spPr = sp.getElementsByTagNameNS(A_NS, 'spPr')[0]
  const fill = resolveSolidFill(spPr) ?? '#000000'

  const paths: string[] = []
  let pW = 1, pH = 1
  for (const path of Array.from(pathLst.getElementsByTagNameNS(A_NS, 'path'))) {
    pW = parseFloat(path.getAttribute('w') || '') || 1
    pH = parseFloat(path.getAttribute('h') || '') || 1
    let d = ''
    let cur = { x: 0, y: 0 }
    for (let ci = 0; ci < path.childNodes.length; ci++) {
      const el = path.childNodes[ci] as Element
      if (el.nodeType !== 1) continue
      const ln = el.localName
      const pts = Array.from(el.getElementsByTagNameNS(A_NS, 'pt'))
      const P = (q: Element | null) => (q ? { x: coord(q.getAttribute('x'), pW, pH), y: coord(q.getAttribute('y'), pW, pH) } : null)
      if (ln === 'moveTo' || ln === 'lnTo') {
        const p = P(pts[0] ?? null)
        if (p) { d += (ln === 'moveTo' ? 'M' : 'L') + p.x.toFixed(2) + ' ' + p.y.toFixed(2) + ' '; cur = p }
      } else if (ln === 'cubicBezTo') {
        if (pts.length >= 3) {
          const a = P(pts[0])!, b = P(pts[1])!, c = P(pts[2])!
          d += `C${a.x.toFixed(2)} ${a.y.toFixed(2)} ${b.x.toFixed(2)} ${b.y.toFixed(2)} ${c.x.toFixed(2)} ${c.y.toFixed(2)} `
          cur = c
        }
      } else if (ln === 'quadBezTo') {
        if (pts.length >= 2) {
          const a = P(pts[0])!, c = P(pts[1])!
          d += `Q${a.x.toFixed(2)} ${a.y.toFixed(2)} ${c.x.toFixed(2)} ${c.y.toFixed(2)} `
          cur = c
        }
      } else if (ln === 'arcTo') {
        const wR = coord(el.getAttribute('wR'), pW, pH)
        const hR = coord(el.getAttribute('hR'), pW, pH)
        const stAng = coord(el.getAttribute('stAng'), pW, pH)
        const swAng = coord(el.getAttribute('swAng'), pW, pH)
        d += arcToCmd(cur, wR, hR, stAng, swAng) + ' '
      } else if (ln === 'close') {
        d += 'Z '
      }
    }
    if (d.trim()) paths.push(d.trim())
  }
  if (!paths.length) return null
  return { paths, w: pW, h: pH, fill }
}

/**
 * 高频 prstGeom → SVG path（在 w×h 坐标系内）。
 * 未覆盖的形状返回 null，由调用方降级为矩形。
 * 依据：presetShapeDefinitions.xml + 04 篇。
 */
export function prstGeomToSvgPath(prst: string, w: number, h: number): string | null {
  const W = w, H = h
  switch (prst) {
    case 'rect':
    case 'rect1':
      return `M0 0 H${W} V${H} H0 Z`
    case 'roundRect':
    case 'round1Rect': {
      const r = Math.min(W, H) * 0.1667
      return `M${r} 0 H${W - r} A${r} ${r} 0 0 1 ${W} ${r} V${H - r} A${r} ${r} 0 0 1 ${W - r} ${H} H${r} A${r} ${r} 0 0 1 0 ${H - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`
    }
    case 'ellipse':
    case 'circle':
    case 'oval':
      return `M${W / 2} 0 A${W / 2} ${H / 2} 0 1 1 ${W / 2} ${H} A${W / 2} ${H / 2} 0 1 1 ${W / 2} 0 Z`
    case 'triangle':
      return `M0 ${H} L${W / 2} 0 L${W} ${H} Z`
    case 'rtTriangle':
      return `M0 0 L${W} ${H} L0 ${H} Z`
    case 'rightArrow': {
      // 右箭头：箭头头占 40%，杆占 60%
      const hw = W * 0.4
      const hh = H * 0.55
      return `M0 ${(H - hh) / 2} L${W - hw} ${(H - hh) / 2} L${W - hw} 0 L${W} ${H / 2} L${W - hw} ${H} L${W - hw} ${(H + hh) / 2} L0 ${(H + hh) / 2} Z`
    }
    case 'leftArrow': {
      const hw = W * 0.4
      const hh = H * 0.55
      return `M${hw} ${(H - hh) / 2} L0 ${H / 2} L${hw} 0 L${hw} ${(H - hh) / 2} L${W} ${(H - hh) / 2} L${W} ${(H + hh) / 2} L${hw} ${(H + hh) / 2} Z`
    }
    case 'upArrow': {
      const hw = W * 0.55
      const hh = H * 0.4
      return `M${(W - hw) / 2} ${H} ${(W - hw) / 2} ${hh} L0 ${hh} L${W / 2} 0 L${W} ${hh} L${(W + hw) / 2} ${hh} L${(W + hw) / 2} ${H} Z`
    }
    case 'downArrow': {
      const hw = W * 0.55
      const hh = H * 0.4
      return `M${(W - hw) / 2} 0 ${(W - hw) / 2} ${H - hh} L0 ${H - hh} L${W / 2} ${H} L${W} ${H - hh} L${(W + hw) / 2} ${H - hh} L${(W + hw) / 2} 0 Z`
    }
    case 'diamond':
      return `M${W / 2} 0 L${W} ${H / 2} L${W / 2} ${H} L0 ${H / 2} Z`
    case 'hexagon': {
      const x = W * 0.25
      return `M${x} 0 L${W - x} 0 L${W} ${H / 2} L${W - x} ${H} L${x} ${H} L0 ${H / 2} Z`
    }
    case 'pentagon': {
      // 五边形（房屋形）
      return `M${W / 2} 0 L${W} ${H * 0.38} L${W * 0.8} ${H} L${W * 0.2} ${H} L0 ${H * 0.38} Z`
    }
    case 'star5': {
      // 五角星：外接圆 R=W/2, r=R*0.382
      const cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 * 0.95, r = R * 0.382
      let d = ''
      for (let i = 0; i < 10; i++) {
        const ang = (-90 + i * 36) * Math.PI / 180
        const rad = i % 2 === 0 ? R : r
        const x = cx + rad * Math.cos(ang)
        const y = cy + rad * Math.sin(ang)
        d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2) + ' '
      }
      return d + 'Z'
    }
    case 'heart': {
      // 心形（近似贝塞尔）
      const cx = W / 2
      return `M${cx} ${H * 0.3}
              C${cx * 1.5} 0, ${W * 0.9} ${H * 0.15}, ${cx} ${H * 0.65}
              C${W * 0.1} ${H * 0.15}, ${W * -0.5} 0, ${cx} ${H * 0.3} Z`
    }
    case 'plaque': {
      // 标签形：右侧带凹口
      const notch = H * 0.3
      return `M0 0 H${W - notch} L${W} ${H / 2} L${W - notch} ${H} H0 Z`
    }
    case 'line':
    case 'straightConnector1':
      return `M0 0 L${W} ${H}`
    case 'bentConnector2':
      return `M0 0 L0 ${H / 2} L${W} ${H / 2} L${W} ${H}`
    default:
      return null
  }
}
