// pagination.mjs —— 自动分页 + 字体 fallback（DOM 操作模块）
// 与 geom.mjs 同为可独立被 node/jsdom 测试 import 的模块。
// getComputedStyle / document.fonts 作为依赖从 globalThis 取，测试时可传入 mock。

export const FALLBACK_FONT_CHAIN = ', "DengXian", "Microsoft YaHei", "MS Gothic", "Yu Gothic", sans-serif'

/**
 * A 组：字体 fallback。首字体缺失（document.fonts.check 返回 false）时追加 fallback 链。
 * 只追加、不改首字体；已有 DengXian 的跳过；无 FontFace API（jsdom）时视为可用、不改样式。
 * opts.fonts：可注入 mock 的 document.fonts。
 */
export function applyFontFallback(host, opts = {}) {
  const fonts = opts.fonts ?? (typeof document !== 'undefined' ? document.fonts : undefined)
  let fixed = 0
  const cache = new Map() // 字体名 → 可用性（避免对同字体重复 check，大文档会卡）
  for (const el of Array.from(host.querySelectorAll('[style*="font-family"]'))) {
    const ff = el.style?.fontFamily
    if (!ff || ff.includes('DengXian')) continue
    const first = (ff.split(',')[0] || '').trim().replace(/^["']+|["']+$/g, '')
    if (!first) continue
    let available = cache.get(first)
    if (available === undefined) {
      try {
        available = !!(fonts && typeof fonts.check === 'function') ? fonts.check(`16px "${first}"`) : true
      } catch { available = false }
      cache.set(first, available)
    }
    if (available) continue
    el.style.fontFamily = ff + FALLBACK_FONT_CHAIN
    fixed += 1
  }
  return fixed
}

/**
 * B 组：对单个 section 分页，返回新增 section 数。
 * 红线：内容不超页高 → 不克隆不迁移（返回 0）。
 * 边界：累计底部 > 可用高 才切（恰好等于不切）；acc>0 避免首块超高切出空页。
 *
 * 测量约定（真实浏览器）：
 * - 页高：section.style.minHeight 是长度字符串（docx-preview 写的是 "841.9pt" 等），
 *   必须换算为 px（96/72）后与 offsetHeight(px) 比较，绝不可拿 pt 值当 px 用。
 * - 块位置：用 offsetHeight 逐块累加（docx-preview 的 p margin:0pt，块间无 margin），
 *   不用 offsetTop（其基准受 padding/positioned 祖先影响，累计会偏）。
 * - 防呆：单轮最多切 50 页，防止异常布局下无限克隆。
 */
const PT2PX = 96 / 72
const IN2PX = 96
const MM2PX = 96 / 25.4
const CM2PX = 96 / 2.54

export function cssLenToPx(v) {
  if (v == null) return 0
  const n = parseFloat(v)
  if (!(n > 0)) return 0
  if (/pt$/i.test(v)) return n * PT2PX
  if (/in$/i.test(v)) return n * IN2PX
  if (/mm$/i.test(v)) return n * MM2PX
  if (/cm$/i.test(v)) return n * CM2PX
  return n // 裸数字或无单位按 px
}

/**
 * 行级拆分：单个块（段落）超过可用高时，按行（offsetTop 变化）切成多个段落。
 * 复制原段落的属性/class/内联样式（不含子节点），把超出的行移到新段落。
 * 返回新段落；若新段落仍超高，调用方循环调用直至放得下（或不可再拆）。
 */
/** 元素占用的行数：getClientRects 每个矩形 = 一行（跨行 span 返回多个 rect）。 */
function spanLines(el) {
  if (typeof el.getClientRects === 'function') {
    try {
      const rs = el.getClientRects()
      return rs.length || 1
    } catch { return 1 }
  }
  return 1
}

/**
 * 行级拆分：单个块（段落）超过可用高时，按行切成两个段落。
 * 行数 = 子元素 getClientRects 之和（跨行 span 计多行）；行高 = 段落高 / 总行数。
 * 保留头部 (总行数 - 需移走行数) 行，其余子元素移到新段落（复制段落属性，不含子节点）。
 * 返回新段落；若新段落仍超高，调用方循环调用直至放得下（或不可再拆）。
 */
export function splitOverflowParagraph(p, availH) {
  const kids = Array.from(p.children)
  if (kids.length === 0) return null
  const totalLines = kids.reduce((a, el) => a + spanLines(el), 0)
  if (totalLines <= 1) return null
  const lineH = p.offsetHeight / totalLines
  if (!(lineH > 0)) return null
  const needLines = Math.ceil((p.offsetHeight - availH) / lineH) // 需移走的行数
  if (!(needLines > 0)) return null
  const keepLines = totalLines - needLines
  if (keepLines < 1) return null // 留不下至少一行 → 拆不动
  let acc = 0
  let cut = -1
  for (let i = 0; i < kids.length; i++) {
    acc += spanLines(kids[i])
    if (acc >= keepLines && i > 0) { cut = i; break }
  }
  if (cut < 0) return null
  const newP = p.cloneNode(false) // 复制段落属性/class/内联样式，不含子节点
  for (let j = cut; j < kids.length; j++) newP.appendChild(kids[j])
  p.after(newP)
  return newP
}

export function paginateSection(section, getComputedStyle) {
  const gcs = getComputedStyle ?? globalThis.getComputedStyle
  const article = section.querySelector('article') ?? section
  const cs = gcs(section)
  // 页高优先取计算样式 min-height（docx-preview 可能走样式表而非内联；style.minHeight 读不到时
  // 会回退到已溢出的 clientHeight，导致可用高被撑大、分页失效——见 tools/render-test REPORT 错误#1）。
  let pageH = cssLenToPx(cs.minHeight) || cssLenToPx(section.style.minHeight)
  if (!(pageH > 0)) pageH = section.clientHeight || 0
  if (!(pageH > 0)) return 0
  const availH = pageH - cssLenToPx(cs.paddingTop) - cssLenToPx(cs.paddingBottom)
  if (!(availH > 0)) return 0

  const children = Array.from(article.children)
  let acc = 0
  let splitCount = 0
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const pos = child.style.position || gcs(child).position
    if (pos === 'absolute' || pos === 'fixed') continue
    acc += child.offsetHeight || 0
    if (acc > availH) {
      const prevAcc = acc - (child.offsetHeight || 0)
      if (prevAcc === 0 && child.tagName === 'P') {
        // 首块超高（如 40 行的单个段落）：行级拆分一次，重入收敛（前段若仍略超会再拆，新段走切页）
        const before = article.children.length
        splitOverflowParagraph(child, availH)
        if (article.children.length !== before) {
          return paginateSection(section, gcs)
        }
        // 拆不动（单行超高）→ 保持原行为：不切，跳过该块
        acc = child.offsetHeight || 0
        continue
      }
      if (prevAcc > 0) {
        const clone = section.cloneNode(true)
        const cloneArticle = clone.querySelector('article') ?? clone
        while (cloneArticle.firstChild) cloneArticle.removeChild(cloneArticle.firstChild)
        for (let j = i; j < children.length; j++) cloneArticle.appendChild(children[j])
        section.after(clone)
        splitCount += 1
        if (splitCount >= 50) return splitCount // 防呆：异常布局最多 50 页
        splitCount += paginateSection(clone, gcs)
        return splitCount
      }
    }
  }
  return 0
}

/** 对 host 内所有 section.docx 分页，返回新增 section 总数。 */
export function applyAutoPagination(host, getComputedStyle) {
  const sections = Array.from(host.querySelectorAll('section.docx'))
  let added = 0
  for (const section of sections) added += paginateSection(section, getComputedStyle)
  return added
}
