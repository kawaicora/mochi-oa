/**
 * pagination.mjs 的类型声明。
 *
 * 原模块是 DOM 操作模块（getComputedStyle / document.fonts 从 globalThis 取，单测可注入 mock），
 * 不参与 TS 编译，这里只描述对外契约。文件名必须是 .d.mts 才能匹配 './docx/pagination.mjs'。
 */

/** 首字体缺失时追加的中文字体 fallback 链 */
export const FALLBACK_FONT_CHAIN: string

/**
 * A 组：字体 fallback。首字体缺失（fonts.check 返回 false）时追加 fallback 链，只追加不改首字体。
 * 返回被修正的元素数。opts.fonts 可注入 mock 的 document.fonts（无 FontFace API 时视为可用、不改样式）。
 */
export function applyFontFallback(
  host: ParentNode,
  opts?: { fonts?: { check(font: string): boolean } | null }
): number

/** CSS 长度串 → px（支持 pt/in/mm/cm，裸数字按 px）；无法解析返回 0 */
export function cssLenToPx(v: string | number | null | undefined): number

/** 行级拆分超高段落：把超出的行移到新段落（复制段落属性、不含子节点）；拆不动返回 null */
export function splitOverflowParagraph(p: HTMLElement, availH: number): HTMLElement | null

/** 对单个 section 分页，返回新增 section 数（内容不超页高时返回 0，零 DOM 变更） */
export function paginateSection(
  section: Element,
  getComputedStyle?: ((el: Element) => CSSStyleDeclaration) | null
): number

/** 对 host 内所有 section.docx 分页，返回新增 section 总数 */
export function applyAutoPagination(
  host: ParentNode,
  getComputedStyle?: ((el: Element) => CSSStyleDeclaration) | null
): number
