/**
 * 文件名 / 路径的 URL 解码工具。
 *
 * 服务端返回的文件地址与相对路径常常是百分号编码的（例如
 * `/files/1/%E7%8E%84%E6%9C%88%E5%B7%A5%E8%B5%84MVP%E7%BB%93%E7%AE%97%E8%A1%A8.xlsx`）。
 * 若直接取 URL 末段当作落盘文件名，磁盘上就会出现一串 %XX 的名字，
 * 而且同名去重还会在乱名后面继续叠加，变成 "xxx (6) (6).xlsx" 这种结果。
 * 这里统一在落盘前还原成中文原文。
 */

/** 解码单个文件名片段；非法编码（文件名里本来带 % ）时按原样返回 */
export function decodeUrlName(name: string): string {
  const s = String(name ?? '')
  if (!s || !s.includes('%')) return s
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** 逐段解码路径（按 '/' 切分，避免 %2F 被解成路径分隔符改变目录层级） */
export function decodeUrlPath(p: string): string {
  return String(p ?? '')
    .split('/')
    .map(decodeUrlName)
    .join('/')
}
