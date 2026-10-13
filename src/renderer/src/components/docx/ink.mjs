// InkML 墨迹解析 + 渲染（依据 office-render-knowledge 07 篇）。
// 纯函数：输入兼容 DOM 元素（getAttribute/textContent/children/localName），输出 SVG 路径描述。
// 浏览器与 node(jsdom) 均可运行，便于单元测试。
//
// 命名空间用 localName 匹配（2006/ink 与 2014/ink 前缀不同，结构一致）。
// ink:stroke 文本 = 空格/制表符分隔的数值串，按 traceFormat(X, Y[, P][, W]) 分列。
// LO 对 InkML 零支持（07 篇 §5.1 证据链），故必须自己解析。

import { inkTraceToSvg } from './geom.mjs'

/** 按 localName 取属性：兼容 traceFormat 与 ink:traceFormat 两种写法（前缀不同）。 */
function attr(el, name) {
  const direct = el.getAttribute(name)
  if (direct != null && direct !== '') return direct
  for (const a of Array.from(el.attributes || [])) {
    if (a.localName === name) return a.value
  }
  return null
}

/**
 * 解析一个 ink:strokes 容器。
 * @param {Element} strokesEl  ink:strokes 元素
 * @returns {{strokes:Array<{pts:Array<[number,number]>,color:string,width:number}>,
 *            bbox:{minX:number,minY:number,maxX:number,maxY:number}}|null}
 */
export function parseInkStrokes(strokesEl) {
  if (!strokesEl) return null
  const trace = (attr(strokesEl, 'traceFormat') || 'X,Y')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean)
  const defColor = attr(strokesEl, 'color') || '#000000'
  const defWidth = parseFloat(attr(strokesEl, 'width') || '2') || 2
  const strokes = []
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const child of Array.from(strokesEl.children)) {
    if (child.localName !== 'stroke') continue
    const nums = (child.textContent || '').trim().split(/\s+/).filter(Boolean).map(Number)
    const cols = trace.length
    if (!cols || nums.length % cols !== 0) continue
    const pts = []
    for (let i = 0; i < nums.length; i += cols) {
      const x = nums[i], y = nums[i + 1]
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      pts.push([x, y])
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
    if (!pts.length) continue
    strokes.push({ pts, color: attr(child, 'color') || defColor, width: defWidth })
  }
  if (!strokes.length) return null
  return { strokes, bbox: { minX, minY, maxX, maxY } }
}

/**
 * 在一个文档/片段里找到所有 ink:ink 根，并解析出 strokes。
 * @param {Document} doc 已解析的 document.xml DOM
 * @returns {Array<{parse:ReturnType<parseInkStrokes>, host:Element}>}
 */
export function collectInk(doc) {
  const out = []
  // 用 localName 匹配：ink 命名空间 2006/2014 两种
  const all = Array.from(doc.getElementsByTagName('*')).filter((e) => e.localName === 'strokes')
  for (const strokesEl of all) {
    const parse = parseInkStrokes(strokesEl)
    if (parse) out.push({ parse, host: strokesEl })
  }
  return out
}

/**
 * 把解析结果渲染成 SVG 路径数组（在 outW×outH 的 viewBox 内）。
 * @param {ReturnType<parseInkStrokes>} parsed
 * @param {number} outW viewBox 宽
 * @param {number} outH viewBox 高
 */
export function inkToSvgPaths(parsed, outW, outH) {
  if (!parsed) return []
  const pad = Math.min(outW, outH) * 0.02
  return parsed.strokes.map((s) => ({
    d: inkTraceToSvg(s.pts, parsed.bbox, outW, outH, pad),
    color: s.color,
    width: s.width
  }))
}
