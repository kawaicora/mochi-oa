/**
 * 通知正文 HTML 消毒。
 *
 * 口径：保留所有「不可执行」的排版标签与内联 CSS（style 属性、class、文字样式等），
 * 剥离一切可执行入口：
 *   - 危险标签：script / iframe / object / embed / link / meta / base / form / 表单控件 / noscript / template / style 标签；
 *   - 事件属性：所有 on*（onclick / onload / onerror …）；
 *   - 危险协议：href/src 上的 javascript: / vbscript: / 非图片 data:；
 *   - 其余未在白名单内的属性一律移除，避免夹带自定义事件属性。
 *
 * 注意：这是渲染层本地消毒，不能替代服务端输入校验；内容来源不可信时仍应在服务端收口。
 */

/** 直接移除的可执行/交互标签（小写标签名） */
const EXEC_TAGS = new Set([
  'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'option', 'optgroup',
  'label', 'noscript', 'template', 'style'
])

/** 允许保留的属性；style/class/id 等排版属性放行，事件与危险协议在下面单独清 */
const ALLOWED_ATTR = new Set([
  'style', 'class', 'id', 'title', 'alt', 'href', 'src', 'target', 'rel',
  'width', 'height', 'colspan', 'rowspan', 'align', 'color', 'bgcolor', 'face', 'size'
])

const DANGEROUS_PROTOCOL = /^\s*(javascript|vbscript|livescript|data)\s*:/i
const IMAGE_DATA_URL = /^data:image\//i

function stripElement(el: Element): void {
  const tag = el.tagName.toLowerCase()
  if (EXEC_TAGS.has(tag)) {
    el.remove()
    return
  }
  stripAttributes(el)
  Array.from(el.children).forEach((child) => stripElement(child as Element))
}

function stripAttributes(el: Element): void {
  Array.from(el.attributes).forEach((attr) => {
    const name = attr.name.toLowerCase()
    if (name.startsWith('on')) {
      el.removeAttribute(attr.name)
      return
    }
    if ((name === 'href' || name === 'src' || name === 'xlink:href') && DANGEROUS_PROTOCOL.test(attr.value)) {
      // src 上的图片 data: URL 放行，其余 data: 一律剥掉
      if (!(name === 'src' && IMAGE_DATA_URL.test(attr.value))) {
        el.removeAttribute(attr.name)
      }
      return
    }
    if (!ALLOWED_ATTR.has(name)) el.removeAttribute(attr.name)
  })
}

/** 消毒一段 HTML，返回可安全 v-html 的字符串；入参为空返回空串 */
export function sanitizeHtml(input: string | null | undefined): string {
  if (!input) return ''
  const doc = new DOMParser().parseFromString(`<div>${input}</div>`, 'text/html')
  const root = doc.body.firstElementChild
  if (!root) return ''
  Array.from(root.children).forEach((child) => stripElement(child as Element))
  return root.innerHTML
}

/** 纯文本转义（不允许 HTML 时使用） */
export function escapeHtml(input: string | null | undefined): string {
  if (input == null) return ''
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
