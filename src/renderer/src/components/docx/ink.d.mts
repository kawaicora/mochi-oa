/**
 * ink.mjs 的类型声明（InkML 墨迹解析）。
 *
 * 原模块是纯函数 JS（输入只要求 getAttribute/textContent/children/localName，兼容 jsdom），
 * 不参与 TS 编译，这里只描述对外契约。文件名必须是 .d.mts 才能匹配 './docx/ink.mjs'。
 */

/** 解析出的墨迹：笔画点集 + 包围盒（原始坐标空间） */
export interface InkStrokes {
  strokes: Array<{ pts: Array<[number, number]>; color: string; width: number }>
  bbox: { minX: number; minY: number; maxX: number; maxY: number }
}

/** 解析一个 ink:strokes 容器（无有效笔画返回 null） */
export function parseInkStrokes(strokesEl: Element | null | undefined): InkStrokes | null

/** 在文档/片段里找所有 ink:ink 根（按 localName 匹配 2006/2014 两种命名空间）并解析 */
export function collectInk(doc: ParentNode): Array<{ parse: InkStrokes; host: Element }>

/** 解析结果 → outW×outH 的 viewBox 内的 SVG 路径数组 */
export function inkToSvgPaths(
  parsed: InkStrokes | null | undefined,
  outW: number,
  outH: number
): Array<{ d: string; color: string; width: number }>
