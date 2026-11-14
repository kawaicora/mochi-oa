/**
 * 文件发送相关纯逻辑（不碰 DOM / IPC，可在 node 下直接跑）。
 *
 * 覆盖：
 * - 路径取 basename（兼容 / 与 \）；
 * - 按后缀判定消息类型 video / image / audio / file；
 * - 上传文件名解析：优先本次上传原名，空白才回退路径 basename；
 * - 从文件 URL 末段取展示名（百分号解码）。
 */
import type { MessageKind } from '../../../shared/server-types'

/** 取路径 basename，兼容 / 与 \ 分隔；空路径原样返回 */
export function baseNameOf(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

/** 按后缀判定消息类型；不命中音视频/图片后缀一律归为 file */
export function fileKindOf(p: string): MessageKind {
  if (/\.(mp4|webm|mov|mkv|avi|m4v|flv)$/i.test(p)) return 'video'
  if (/\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(p)) return 'image'
  if (/\.(mp3|wav|flac|aac|ogg|oga|opus|weba|m4a|m4b|wma|ac3|aiff|aif|au|amr|alac|mka|mid|midi|cda|cue)$/i.test(p)) return 'audio'
  return 'file'
}

/**
 * 上传文件名：优先本次上传带来的原名（去空白）；原名为空才回退文件路径的 basename。
 * 不从 MIME 推断扩展名，无后缀文件保持无后缀。
 */
export function resolveFileName(originalName: string, filePath: string): string {
  return originalName.trim() || baseNameOf(filePath)
}

/** 从文件 URL 末段取展示名（百分号解码）；末段为空返回空串 */
export function fileNameOf(url: string): string {
  const seg = url.split('/').pop() || ''
  return decodeURIComponent(seg)
}
