/**
 * geom.mjs 的类型声明。
 *
 * 原模块是「可被 node/jsdom 单测直接 import」的纯 JS（无 DOM 依赖），不参与 TS 编译，
 * 所以这里只描述对外契约；语义细节看 geom.mjs 顶部注释与 office-render-knowledge 03/04 篇。
 * 注意文件名必须是 .d.mts：`import './docx/geom.mjs'` 会优先解析到同名的 geom.d.mts。
 */

/** presets.json 里的一个预设条目（DrawingML 预设几何的求值数据）。字段可为 null：模块内按 `x || []` 兜底 */
export interface GeomPreset {
  /** 可调值默认：[[名称, 'val', 值串], ...] */
  av?: string[][] | null
  /** 参考线公式：[[名称, 运算符, 参数...], ...] */
  gd?: string[][] | null
  /** 文本矩形（逻辑坐标 token，如 { l:'l', t:'t', r:'r', b:'b' }）；presets.json 里有 5 个为 null */
  rect?: { l: string; t: string; r: string; b: string } | null
  /** 轮廓路径：每个 path 自带一套逻辑坐标系（通常 21600×21600） */
  paths?: Array<{ w: number; h: number; fill?: string; stroke?: string; segs: string[][] }> | null
}

/** renderPreset 的求值结果 */
export interface RenderedPreset {
  /** 逻辑坐标系尺寸 [w, h] */
  viewBox: [number, number]
  /** SVG path 轮廓 */
  paths: Array<{ d: string; fill?: string; stroke?: string }>
  /** 文本矩形 [l, t, r, b]（与 viewBox 同坐标系）；预设没有 rect 时为 null */
  textRect: [number, number, number, number] | null
}

/** 求值一个预设几何 → SVG path 轮廓；userAv 覆盖预设默认可调值 */
export function renderPreset(preset: GeomPreset, userAv?: Record<string, number> | null): RenderedPreset

/** 公式求值：fmla = [运算符, 参数...]（val、乘除、加减、abs、sqrt、at2、pin、if 等，见 geom.mjs） */
export function evalFmla(fmla: string[], ctx: Record<string, unknown>, visiting?: Set<string>): number

/** 单个 token 求值（数字、token 名如 'l'/'r'/'cd4'、或参考线名） */
export function resolveArg(tok: unknown, ctx: Record<string, unknown>, visiting: Set<string>): number

/** arcTo → SVG 圆弧参数（A 命令的 7 个参数 + 终点） */
export function arcToToSvg(
  cur: [number, number],
  wR: number,
  hR: number,
  stAng: number,
  swAng: number
): { args: [number, number, number, number, number, number, number]; end: [number, number] }

/** 合并预设默认可调值与用户覆盖 → { 可调值名: 数值 } */
export function buildAdj(presetAv: string[][] | null | undefined, userAv?: Record<string, number> | null): Record<string, number>

/** srcRect 裁边几何：外层 overflow:hidden 盒 + 内层 <img> 的尺寸/偏移（单位 pt） */
export function srcRectCss(
  l?: number,
  t?: number,
  r?: number,
  b?: number,
  dwPt?: number,
  dhPt?: number
): { imgW: number; imgH: number; imgLeft: number; imgTop: number; visW: number; visH: number }

/** a:outerShdw → CSS filter: drop-shadow(...)；无阴影返回 '' */
export function outerShdwCss(
  sh: { blurRad?: number; dist?: number; dir?: number; algn?: string; color?: string; alpha?: number } | null | undefined
): string

/** 预设遮罩轮廓的闭合多边形顶点（pt 坐标）；非多边形预设（rect/roundRect/ellipse/circle）返回 null */
export function maskPolygonPts(geom: string, w: number, h: number): Array<[number, number]> | null

/** wp:wrapPolygon 在对象垂直中线处的左右内缩（pt）；点数不足 3 返回全 0 */
export function wrapInsetAtMid(
  wrapPts: Array<[number, number]> | null | undefined,
  w: number,
  h: number
): { insetL: number; insetR: number }

/** InkML trace → SVG path d（按 bbox 归一化到 outW×outH，pad 为四周留白） */
export function inkTraceToSvg(
  points: Array<[number, number]> | null | undefined,
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  outW?: number,
  outH?: number,
  pad?: number
): string
