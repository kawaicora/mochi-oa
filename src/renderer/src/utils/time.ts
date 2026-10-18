/**
 * 客户端时间展示统一工具：一律 new Date(iso) 后按系统本地时区格式化。
 * 服务端返回带偏移无 Z 的 ISO（如 2026-10-18T14:39:08+08:00），new Date 正确解析。
 * 禁止用 toISOString() 做展示（强制 UTC 带 Z）。
 */
const pad = (n: number): string => String(n).padStart(2, '0')

/** 日期时间：yyyy-MM-dd HH:mm */
export function fmtLocal(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 日期时间（带秒）：yyyy-MM-dd HH:mm:ss */
export function fmtLocalSec(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 仅日期：yyyy-MM-dd */
export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 仅时间：HH:mm */
export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 人性化：今天 HH:mm / 昨天 HH:mm / 昨天之前 yyyy-MM-dd HH:mm */
export function fmtHuman(iso: string | null | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return String(iso)
  const now = new Date()
  const startOfDay = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const today = startOfDay(now)
  const that = startOfDay(d)
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`
  const diffDays = Math.round((today - that) / 86400000)
  if (diffDays === 0) return `今天 ${hm}`
  if (diffDays === 1) return `昨天 ${hm}`
  if (diffDays === -1) return `明天 ${hm}`
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`
}
