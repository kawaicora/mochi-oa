/**
 * 考勤/打卡 纯判定逻辑（无 Vue/pinia 依赖，便于单测）。
 *
 * 从 CheckinView.vue / AttendanceView.vue 抽取：状态点、补卡资格、补卡槽位/时间预填、
 * 打卡按钮文案、加班展示与默认时间、申请提交载荷。组件 import 本模块，测试直接测真实逻辑。
 */
import { fmtTime, fmtDate } from './time'

// state 位掩码（与服务端 checkins.state 一致）：1上班 2下班 4缺卡 8补卡 16请假 32调休。
export const S_WORK = 1
export const S_OFF = 2
export const S_MISS = 4
export const S_MAKEUP = 8
export const S_LEAVE = 16
export const S_COMP = 32

export type DotKind = 'blue' | 'yellow' | 'purple'
export type AttType = 'make_up' | 'leave' | 'comp_time' | 'overtime'

/** 打卡记录最小结构（测试与组件共用）。 */
export interface CheckinRecordLike {
  checkDate?: string
  checkTime?: string
  state?: number
  label?: string
  stdStart?: string
  stdEnd?: string
}

/** 当月考勤申请最小结构。 */
export interface MonthAttLike {
  date: string
  type: string
  status: string
}

/** 加班展示最小结构。 */
export interface OvertimeLike {
  startTime: string
  endTime: string
  durationHours: number
}

/** 聚合当天所有打卡记录的状态位（OR）。 */
export function dayStateOf(records: CheckinRecordLike[] | undefined): number {
  let s = 0
  for (const r of records ?? []) s |= (r.state || 0)
  return s
}

/**
 * 某日期状态点（可并排多个）。按【上班/下班两个槽位】逐一判定异常是否已被解决：
 * - 上班异常 = 缺上班卡，或上班卡迟到且未补（补上班卡未落库）
 * - 下班异常 = 缺下班卡，或下班卡早退且未补（补下班卡未落库）
 * - 槽位被补卡解决（state 含对应位 + S_MAKEUP）→ 该槽位不再计异常；整天申请(请假/调休通过) → 全部解决
 * - 仍有任一异常 → 黄点；已通过申请 → 叠加紫点；全部解决且有打卡 → 蓝点（可蓝+紫）
 * - 待审申请 → 追加紫点
 * 示例：只补上班迟到、下班仍早退 → 黄+紫（黄不消失）；上班下班都补完 → 蓝+紫（黄消失）。
 */
export function dotsOf(opts: {
  dateStr: string
  dayMap: Map<string, { records?: CheckinRecordLike[]; status?: string }>
  monthAtts: MonthAttLike[]
  rejectedDays: Set<string>
}): DotKind[] {
  const { dateStr, dayMap, monthAtts, rejectedDays } = opts
  const day = dayMap.get(dateStr)
  const recs = day?.records ?? []
  const ds = dayStateOf(recs)
  const hasWork = (ds & S_WORK) !== 0
  const hasOff = (ds & S_OFF) !== 0
  const atts = monthAtts.filter((a) => a.date === dateStr)
  const approved = atts.filter((a) => a.status === 'approved')
  const rest = day?.status === 'rest'
  // 整天申请（请假/调休通过）→ 覆盖整天，不计异常
  const fullCovered = approved.some((a) => a.type === 'leave' || a.type === 'comp_time')
  // 补卡是否已落库（state 同时含槽位位 + S_MAKEUP）：补上班=9，补下班=10
  const workMakeupApplied = recs.some((r) => ((r.state ?? 0) & S_WORK) !== 0 && ((r.state ?? 0) & S_MAKEUP) !== 0)
  const offMakeupApplied = recs.some((r) => ((r.state ?? 0) & S_OFF) !== 0 && ((r.state ?? 0) & S_MAKEUP) !== 0)
  // 原始打卡记录（不含补卡位）
  const hasRawWork = recs.some((r) => ((r.state ?? 0) & S_WORK) !== 0 && ((r.state ?? 0) & S_MAKEUP) === 0)
  const hasRawOff = recs.some((r) => ((r.state ?? 0) & S_OFF) !== 0 && ((r.state ?? 0) & S_MAKEUP) === 0)
  const workLate = recs.some((r) => ((r.state ?? 0) & S_WORK) !== 0 && ((r.state ?? 0) & S_MAKEUP) === 0 && r.label === '迟到')
  const offEarly = recs.some((r) => ((r.state ?? 0) & S_OFF) !== 0 && ((r.state ?? 0) & S_MAKEUP) === 0 && r.label === '早退')
  // 各槽位异常：补卡已落库即视为解决；整天申请视为解决
  const workAbnormal = !rest && !fullCovered && !workMakeupApplied && (!hasRawWork || workLate)
  const offAbnormal = !rest && !fullCovered && !offMakeupApplied && (!hasRawOff || offEarly)
  const abnormal = workAbnormal || offAbnormal || rejectedDays.has(dateStr)
  const out: DotKind[] = []
  if (!abnormal && (hasWork || hasOff)) out.push('blue')
  else if (abnormal) out.push('yellow')
  if (approved.length > 0 || atts.some((a) => a.status === 'pending')) out.push('purple')
  return out
}

/** 打卡按钮文案：0=上班打卡；1=下班打卡；≥2=再打卡覆盖下班。 */
export function punchLabel(todayCount: number, punching: boolean): string {
  if (punching) return '打卡中…'
  if (todayCount <= 0) return '上班打卡'
  if (todayCount === 1) return '下班打卡'
  return '下班打卡（覆盖）'
}

/** "HH:MM" → 当天分钟数。 */
export function hm(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return (h || 0) * 60 + (m || 0)
}

/** MAC 白名单文本（逗号/换行分隔）→ 数组。 */
export function parseMacText(text: string): string[] {
  return text.split(/[\n,，;；]+/).map((s) => s.trim()).filter(Boolean)
}

/** 当天通过加班申请 → 展示文案（仅申请通过才显示）。 */
export function fmtOvertime(o: OvertimeLike): string {
  const h = Math.round(o.durationHours * 100) / 100
  return `加班 ${fmtTime(o.startTime)} - ${fmtTime(o.endTime)} ${h}小时`
}

/** 记录标签着色：迟到/早退红、补卡蓝、请假/调休紫、上班/下班灰。 */
export function recCls(label?: string): string {
  if (!label) return 'ci-rec-lbl'
  if (label === '迟到' || label === '早退') return 'ci-rec-lbl warn'
  if (label === '补上班' || label === '补下班') return 'ci-rec-lbl make'
  if (label === '请假' || label === '调休') return 'ci-rec-lbl leave'
  return 'ci-rec-lbl'
}

/**
 * 补卡资格判定（是否显示「补卡」按钮）。
 * - 历史日期(<今天)：可补；但目标槽位已补过则不可再补。
 * - 今天迟到/缺上班卡(已过上班时间) → 可补上班卡；
 * - 今天缺下班/早退(已过下班时间) → 可补下班卡；
 * - 未到对应时间 → 不提供补卡。
 */
export function canMakeup(opts: {
  date: string
  todayStr: string
  records: CheckinRecordLike[]
  dayStatus: {
    status?: string
    missingWork?: boolean
    missingOff?: boolean
  } | null
  measureInfo?: { date: string; stdStart: string; stdEnd: string } | null
  now?: Date
}): boolean {
  const { date, todayStr, records, dayStatus, measureInfo } = opts
  const ds = dayStateOf(records)
  const hasWork = (ds & S_WORK) !== 0
  const hasOff = (ds & S_OFF) !== 0
  const targetOff = hasWork && !hasOff
  const alreadyWorkMakeup = (ds & (S_WORK | S_MAKEUP)) === (S_WORK | S_MAKEUP)
  const alreadyOffMakeup = (ds & (S_OFF | S_MAKEUP)) === (S_OFF | S_MAKEUP)
  if (date < todayStr) {
    if (targetOff && alreadyOffMakeup) return false
    if (!targetOff && alreadyWorkMakeup) return false
    return true
  }
  const mi = measureInfo, st = dayStatus
  if (!mi || !st) return false
  const nowMin = (opts.now ?? new Date()).getHours() * 60 + (opts.now ?? new Date()).getMinutes()
  const ws = hm(mi.stdStart || '09:00')
  const we = hm(mi.stdEnd || '18:00')
  const todayTargetOff = !(mi.date === todayStr && st.status === 'late') && hasWork
  if (todayTargetOff && alreadyOffMakeup) return false
  if (!todayTargetOff && alreadyWorkMakeup) return false
  if (st.status === 'late') return true
  if (st.missingWork) return nowMin > ws
  if (st.missingOff || st.status === 'early' || st.status === 'late_early') return nowMin > we
  return false
}

/**
 * 补卡预填的槽位与时间（measureOpenApply → apply 预填参数）。
 * - 今天迟到 → 补上班卡(填当日上班时间)；
 * - 当天无上班卡 → 补上班卡(填当日上班时间)；
 * - 当天已有上班卡但缺下班 → 补下班卡(填当日下班时间)。
 */
export function makeupPrefill(opts: {
  date: string
  todayStr: string
  dayStatus: { status?: string } | null
  hasIn: boolean
  stdStart: string
  stdEnd: string
}): { slot: 'work' | 'off'; time: string } {
  const { date, todayStr, dayStatus, hasIn, stdStart, stdEnd } = opts
  const lateToday = date === todayStr && !!dayStatus && dayStatus.status === 'late'
  if (lateToday || !hasIn) return { slot: 'work', time: stdStart }
  return { slot: 'off', time: stdEnd }
}

/**
 * 加班默认时间填充：开始=当日下班，结束默认 +1 小时（可跨天到次日）。
 * 传入已解析的 7 项周规则（dow 周一=0）。返回 null 表示无法填充（今天休息/规则缺失）。
 */
export function overtimeDefault(now: Date, weekRules: Array<{ dow: number; start: string; end: string; rest: boolean }> | null): { startTime: string; endTime: string } | null {
  if (!weekRules || weekRules.length !== 7) return null
  const dow = (now.getDay() + 6) % 7 // 周一=0
  const p0 = (n: number) => String(n).padStart(2, '0')
  const td = `${now.getFullYear()}-${p0(now.getMonth() + 1)}-${p0(now.getDate())}`
  const day = weekRules[dow]
  if (!day || day.rest || !day.end) return null
  const hh = day.end.slice(0, 2)
  const mm = day.end.slice(3, 5)
  if (!/^\d{2}$/.test(hh) || !/^\d{2}$/.test(mm)) return null
  const startTime = `${td}T${hh}:${mm}`
  const e = new Date(`${td}T${hh}:${mm}`)
  e.setHours(e.getHours() + 1)
  const endTime = `${e.getFullYear()}-${p0(e.getMonth() + 1)}-${p0(e.getDate())}T${p0(e.getHours())}:${p0(e.getMinutes())}`
  return { startTime, endTime }
}

/**
 * 考勤申请提交载荷构造。
 * - make_up(补卡)：只传 punchTime，不传 makeupDate/makeupSlot（服务端自动判定槽位）；
 * - leave(请假)：传 startTime/endTime/durationHours/leaveType；
 * - comp_time(调休)：传 startTime/endTime/durationHours/compType；
 * - overtime(加班)：只传时间段（时长由服务端计算），不设类型。
 */
export function buildAttendancePayload(fields: {
  tab: AttType
  punchTime: string
  startTime: string
  endTime: string
  durationHours: number | null
  leaveType: string
  compType: string
  reason: string
  approverIds: number[]
  ccIds: number[]
  companyId: number
}): Record<string, unknown> {
  const { tab, punchTime, startTime, endTime, durationHours, leaveType, compType, reason, approverIds, ccIds, companyId } = fields
  const payload: Record<string, unknown> = {
    companyId, type: tab, reason,
    approverIds, ccIds,
  }
  if (tab === 'make_up') {
    payload.punchTime = punchTime
  } else {
    payload.startTime = startTime
    payload.endTime = endTime
    payload.durationHours = durationHours
    if (tab === 'leave') payload.leaveType = leaveType
    else if (tab === 'comp_time') payload.compType = compType
  }
  return payload
}

/** 卡片正文：补卡→补卡时间；请假/调休/加班→时间段。 */
export function cardBody(tab: AttType, punchTime: string, startTime: string, endTime: string): string {
  return tab === 'make_up' ? '补卡时间 ' + (punchTime || '—') : `${startTime || '—'} ~ ${endTime || '—'}`
}

/** 补卡预填：把打卡页的 {date,time} 拼成完整 punchTime（"YYYY-MM-DDTHH:mm"）。非法 time 兜底 09:00。 */
export function applyMakeupPrefill(p: { type?: AttType; date?: string; time?: string }): { punchTime: string; okMsg: string } {
  const t = p.time && /^\d{2}:\d{2}$/.test(p.time) ? p.time : '09:00'
  const punchTime = `${p.date}T${t}`
  return { punchTime, okMsg: '已按该日期预填补卡时间，请补充事由并选择审批人' }
}

/** 补卡目标日期展示（月度考勤申请用于日历点匹配）：补卡用 makeupDate、否则 startTime/createdAt。 */
export function attDateOf(r: { makeupDate?: string | null; startTime?: string | null; createdAt: string }): string {
  return r.makeupDate ? fmtDate(r.makeupDate) : (r.startTime ? fmtDate(r.startTime) : fmtDate(r.createdAt))
}

/** 申请类型中文显示名。 */
export function attTypeLabel(type: string): string {
  switch (type) {
    case 'make_up': return '补卡'
    case 'leave': return '请假'
    case 'comp_time': return '调休'
    case 'overtime': return '加班'
    default: return '考勤'
  }
}
