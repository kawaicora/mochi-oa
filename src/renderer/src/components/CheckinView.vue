<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import CalendarMonth from './common/CalendarMonth.vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import { toPlain } from '../utils/plain'
import { fmtTime, fmtDate } from '../utils/time'

// ── 类型（与服务端冻结协议对齐）──
interface CheckinItem {
  id: number
  companyId: number
  userId: number
  checkDate: string // YYYY-MM-DD
  checkTime: string // YYYY-MM-DD HH:mm:ss
  ip: string
  mac: string
  stdStart?: string // 打卡时排班快照
  stdEnd?: string
  state?: number // 位掩码：1上班 2下班 4缺卡 8补卡 16请假 32调休（补上班=9 补下班=10）
  label?: string // 逐条类型标签：上班/下班/迟到/早退/补上班/补下班/请假/调休
  createdAt: string
  nick?: string
  username?: string
}
interface OvertimeItem {
  startTime: string // 完整 YYYY-MM-DD HH:mm:ss
  endTime: string
  durationHours: number
}
interface CheckinDay {
  date: string // YYYY-MM-DD
  count: number
  firstTime: string | null
  lastTime: string | null
  status?: 'rest' | 'none' | 'normal' | 'late' | 'early' | 'late_early' | string
  records: CheckinItem[]
  overtimes?: OvertimeItem[] // 当天通过加班申请（申请通过才显示）
}
// 当月考勤申请（用于日历紫点判断）
interface MonthAtt { date: string; type: string; status: string }

const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)

// ── 月度考勤统计（管理员查看/下载当月已生成的 CSV）──
interface StatFile { name: string; url: string }
const statFiles = ref<StatFile[]>([])
const statMonth = ref('')
async function loadStatFiles(): Promise<void> {
  if (!companyId.value || !app.isAdmin) return
  try {
    const ack = await window.pantry.serverAttendanceStatList({ companyId: companyId.value })
    if (!ack.ok) { console.error('[打卡] 考勤统计列表失败', ack.error); return }
    const data = (ack.data ?? {}) as { files?: StatFile[]; month?: string }
    statFiles.value = data.files ?? []
    statMonth.value = data.month ?? ''
  } catch (e) { console.error('[打卡] 考勤统计列表异常', e) }
}
async function downloadStat(f: StatFile): Promise<void> {
  try {
    const abs = server.absFileUrl(f.url)
    const r = await window.pantry.serverDownloadFile(abs)
    console.log('[打卡] 下载考勤统计', f.name, r)
  } catch (e) { console.error('[打卡] 下载考勤统计失败', e) }
}

// ── 当前显示的月份 ──
const now = new Date()
const cur = ref(new Date(now.getFullYear(), now.getMonth(), 1))
const monthLabel = computed(() => `${cur.value.getFullYear()} 年 ${cur.value.getMonth() + 1} 月`)
// 服务端要的 'YYYY-MM'
const monthStr = computed(() => {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${cur.value.getFullYear()}-${p(cur.value.getMonth() + 1)}`
})

// ── 打卡记录（按月）──
const days = ref<CheckinDay[]>([])
const dayMap = computed(() => {
  const m = new Map<string, CheckinDay>()
  for (const d of days.value) m.set(d.date, d)
  return m
})
// 当天本会话内被白名单拒绝的日期（用于黄点提示）
const rejectedDays = ref<Set<string>>(new Set())

// ── 当月考勤申请（紫点）──
const monthAtts = ref<MonthAtt[]>([])

// ── 今天日期（高亮）──
const p0 = (n: number) => String(n).padStart(2, '0')
const todayStr = `${now.getFullYear()}-${p0(now.getMonth() + 1)}-${p0(now.getDate())}`

// 某日期状态点（可并排多个）。规则：
// - 当天有通过的考勤申请(补卡/请假/调休) → 算正常，异常黄点不显示；显示紫点(申请)
// - 整天申请(无正常打卡) → 只显示紫；正常打卡+申请 → 蓝+紫
// - 无通过申请时按打卡：正常(>=2) → 蓝；异常(缺卡/迟到/早退) → 黄
// - 异常记录如实保留：点日期弹窗可查看当天全部打卡与申请详情
type DotKind = 'blue' | 'yellow' | 'purple'
// state 位掩码（与服务端 checkins.state 一致）：1上班 2下班 4缺卡 8补卡 16请假 32调休。
const S_WORK = 1
const S_OFF = 2
const S_MISS = 4
const S_MAKEUP = 8
const S_LEAVE = 16
const S_COMP = 32
// 聚合当天所有打卡记录的状态位（OR），识别已打上班/下班/补卡槽位。
function dayStateOf(dateStr: string): number {
  let s = 0
  for (const r of dayMap.value.get(dateStr)?.records ?? []) s |= (r.state || 0)
  return s
}

function dotsOf(dateStr: string): DotKind[] {
  const day = dayMap.value.get(dateStr)
  const ds = dayStateOf(dateStr)
  const hasWork = (ds & S_WORK) !== 0 // 已打/补上班卡
  const hasOff = (ds & S_OFF) !== 0 // 已打/补下班卡
  const atts = monthAtts.value.filter((a) => a.date === dateStr)
  const approved = atts.filter((a) => a.status === 'approved')
  const hasApprovedAtt = approved.some((a) => a.type === 'make_up' || a.type === 'leave' || a.type === 'comp_time')
  const out: DotKind[] = []
  if (hasApprovedAtt) {
    // 申请通过 → 算正常(不显示异常黄)；当天有打卡(含补卡落库) → 蓝+紫两圈；整天申请无打卡 → 只紫
    if (day && (hasWork || hasOff)) out.push('blue')
    out.push('purple')
  } else {
    // 无通过申请：按当天综合状态判定。迟到/早退/缺卡/单次只上班/被拦截 → 黄；正常(上下班都打) → 蓝。
    // 缺卡/单卡用 state 位判断（上班&下班位都齐才正常），不再按打卡次数硬分。
    const st = day?.status
    const abnormal = (!!day && (st === 'late' || st === 'early' || st === 'late_early' || st === 'none' || !(hasWork && hasOff)))
      || rejectedDays.value.has(dateStr)
    if (day && !abnormal) out.push('blue')
    else if (abnormal) out.push('yellow')
    if (atts.some((a) => a.status === 'pending')) out.push('purple') // 待审申请
  }
  return out
}

// ── 当天详情弹窗 ──
const selected = ref<string>('')
const selectedDay = computed(() => dayMap.value.get(selected.value) ?? null)
const selectedAtts = computed(() => monthAtts.value.filter((a) => a.date === selected.value))

// ── 打卡按钮 ──
const mac = ref('')
const punching = ref(false)
const punchMsg = ref('') // 成功提示
const punchErr = ref('') // 白名单拒绝等异常提示
async function loadMac(): Promise<void> {
  try { mac.value = (await window.pantry.getMac()) || '' } catch (e) { console.error('[打卡] 取 MAC 失败', e); mac.value = '' }
}
// 当天打卡次数（从当月 records 里筛 today）
const todayCount = computed(() => dayMap.value.get(todayStr)?.count ?? 0)
// 按钮文案：0=上班打卡；1=下班打卡；≥2=再打卡覆盖下班
const punchLabel = computed(() => {
  if (punching.value) return '打卡中…'
  if (todayCount.value <= 0) return '上班打卡'
  if (todayCount.value === 1) return '下班打卡'
  return '下班打卡（覆盖）'
})

// ── 当天状态（checkin:status:get）──
type StatusKind = 'rest' | 'none' | 'normal' | 'late' | 'early' | 'late_early'
interface DayStatus { date: string; rest: boolean; stdStart: string | null; stdEnd: string | null; punchIn: string | null; punchOut: string | null; status: StatusKind; mode: string; missingWork: boolean; missingOff: boolean }
const dayStatus = ref<DayStatus | null>(null)
const statusLabel: Record<StatusKind, string> = {
  rest: '休息日', none: '暂无打卡记录', normal: '正常', late: '迟到', early: '早退', late_early: '迟到+早退'
}
// 记录标签着色：迟到/早退红、补卡蓝、请假/调休紫、上班/下班灰。
function recCls(label?: string): string {
  if (!label) return 'ci-rec-lbl'
  if (label === '迟到' || label === '早退') return 'ci-rec-lbl warn'
  if (label === '补上班' || label === '补下班') return 'ci-rec-lbl make'
  if (label === '请假' || label === '调休') return 'ci-rec-lbl leave'
  return 'ci-rec-lbl'
}
// 当天通过加班申请 → "加班 21:00 - 22:00 1小时"（仅申请通过才显示）。
function fmtOvertime(o: OvertimeItem): string {
  const h = Math.round(o.durationHours * 100) / 100
  return `加班 ${fmtTime(o.startTime)} - ${fmtTime(o.endTime)} ${h}小时`
}
const statusCls: Record<StatusKind, string> = {
  rest: 'rest', none: 'none', normal: 'ok', late: 'warn', early: 'warn', late_early: 'warn'
}
async function loadStatus(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinStatusGet({ companyId: companyId.value, date: todayStr })
    if (ack.ok) {
      const st = ((ack.data as { status?: DayStatus })?.status ?? null) as DayStatus | null
      if (st) {
        // 硬防御：下班=上班时间（仅打一次卡被旧数据/服务端把首末当同一次）→ 视为下班未打卡，不判早退。
        if (st.punchIn && st.punchOut && st.punchIn === st.punchOut) {
          st.punchOut = null
          if (st.status === 'late_early') st.status = 'late'
          else if (st.status === 'early') st.status = 'normal'
        }
      }
      dayStatus.value = st
    } else console.error('[打卡] 当天状态加载失败', ack.error)
  } catch (e) { console.error('[打卡] 当天状态加载异常', e) }
}

// ── 打卡规则弹窗（admin/owner）──
const showRules = ref(false)
interface WeekRule { dow: number; start: string; end: string; rest: boolean }
interface RulesForm { mode: string; grace_late_min: number; grace_early_min: number; week_rules: WeekRule[]; alt_rule: { dow: number; altStart: string; altEnd: string } | null }
const rulesForm = ref<RulesForm | null>(null)
const WEEK_NAMES = ['周日','周一','周二','周三','周四','周五','周六']

// ── 可打卡 MAC 白名单（并入规则弹窗）──
interface CheckinSettingsData { macEnabled?: boolean; macWhitelist?: string[]; ipWhitelist?: string[] }
const macEnabled = ref(false)          // 只允许指定 MAC 打卡开关
const macListText = ref('')            // MAC 列表文本（逗号/换行分隔）
const ipWhitelist = ref<string[]>([])  // 保留既有 IP 白名单，不做界面编辑
const showMacEditor = ref(false)       // MAC 列表编辑弹窗
function parseMacText(text: string): string[] {
  return text.split(/[\n,，;；]+/).map(s => s.trim()).filter(Boolean)
}
async function loadSettings(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinSettingsGet(companyId.value)
    if (!ack.ok) { console.error('[打卡] 白名单加载失败', ack.error); return }
    const s = (ack.data as { settings?: CheckinSettingsData })?.settings
    if (s) {
      macEnabled.value = !!s.macEnabled
      macListText.value = (s.macWhitelist ?? []).join(', ')
      ipWhitelist.value = s.ipWhitelist ?? []
    }
  } catch (e) { console.error('[打卡] 白名单加载异常', e) }
}
async function saveSettings(): Promise<boolean> {
  if (!companyId.value) return false
  try {
    const ack = await window.pantry.serverCheckinSettingsSave(toPlain({
      companyId: companyId.value,
      macEnabled: macEnabled.value,
      macWhitelist: parseMacText(macListText.value),
      ipWhitelist: ipWhitelist.value,
    }))
    if (!ack.ok) { console.error('[打卡] 白名单保存失败', ack.error); return false }
    return true
  } catch (e) { console.error('[打卡] 白名单保存异常', e); return false }
}
async function openRules(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinRulesGet(companyId.value)
    if (!ack.ok) { console.error('[打卡] 规则加载失败', ack.error); return }
    const d = (ack.data as { rules?: RulesForm & { week_rules: string | WeekRule[] } })?.rules
    if (d) {
      const f = JSON.parse(JSON.stringify(d)) as RulesForm & { week_rules: string | WeekRule[] }
      // 服务端 week_rules 是 JSON 字符串（DB TEXT），需 parse 成数组
      if (typeof f.week_rules === 'string') {
        try { f.week_rules = JSON.parse(f.week_rules) as WeekRule[] } catch { f.week_rules = [] }
      }
      if (!f.alt_rule) f.alt_rule = { dow: 6, altStart: '09:00', altEnd: '18:00' }
      rulesForm.value = f
    }
    await loadSettings() // 一并加载 MAC 白名单开关与列表
    showRules.value = true
  } catch (e) { console.error('[打卡] 规则加载异常', e) }
}
async function saveRules(): Promise<void> {
  if (!companyId.value || !rulesForm.value) return
  try {
    const ack = await window.pantry.serverCheckinRulesSave(toPlain({ companyId: companyId.value, ...rulesForm.value }))
    if (!ack.ok) { console.error('[打卡] 规则保存失败', ack.error); return }
    const saved = await saveSettings() // 保存 MAC 白名单开关与列表
    if (!saved) return
    showRules.value = false
    await loadStatus()
  } catch (e) { console.error('[打卡] 规则保存异常', e) }
}


async function doCheckin(): Promise<void> {
  if (!companyId.value) { punchErr.value = '尚未加入公司'; return }
  punchMsg.value = ''
  punchErr.value = ''
  punching.value = true
  try {
    const ack = await window.pantry.serverCheckinCreate({ companyId: companyId.value, mac: mac.value || undefined })
    if (!ack.ok) {
      // 白名单拦截：黄底异常提示 + 记录到当天（黄点）
      console.error('[打卡] 打卡被拒', ack.error)
      punchErr.value = ack.error || '打卡失败'
      rejectedDays.value.add(todayStr)
    } else {
      // 按回包 kind 提示：first=上班 / second=下班 / override=覆盖下班
      const kind = (ack.data as { kind?: string } | undefined)?.kind
      const kindText = kind === 'first' ? '已记录上班时间'
        : kind === 'second' ? '已记录下班时间'
        : kind === 'override' ? '已更新下班时间'
        : '打卡成功'
      await loadData()
      await loadStatus()
      // 下班/覆盖打卡后必须显示当天【综合状态】（迟到/早退/正常/休息），不得无脑提示"已记录下班时间"。
      // 全天状态 = 服务端按上下班时间+打卡规则(大小周/豁免/迟到早退判定)综合判定。
      const st = dayStatus.value
      const stText = st ? statusLabel[st.status] : ''
      punchMsg.value = st && stText ? `${kindText} · 当天状态：${stText}` : kindText
    }
  } catch (e) {
    console.error('[打卡] 打卡异常', e)
    punchErr.value = '打卡异常'
  }
  punching.value = false
}

// ── 异常/缺卡日期 → 措施弹窗（打卡 / 补卡 / 请假），按异常类型自动识别引导 ──
const measureDate = ref<string>('')
const measureInfo = ref<{ date: string; stdStart: string; stdEnd: string } | null>(null)

// "HH:MM" → 当天分钟数。
function hm(t: string): number { const [h, m] = t.split(':').map(Number); return (h || 0) * 60 + (m || 0) }

// 补卡资格：只有「已定论的异常」才提供补卡——
//   - 历史日期（< 今天）：已过上班+下班，可补；
//   - 今天迟到（上班异常，已过上班时间）→ 可补上班卡；
//   - 今天缺上班卡且已过上班时间 → 可补上班卡；
//   - 今天缺下班卡/早退且已过下班时间 → 可补下班卡；
//   - 今天未到对应时间（如正常上班但还没到下班时间）→ 不提供补卡。
function canMakeup(date: string): boolean {
  if (date < todayStr) {
    // 历史已定论，可补；但目标槽位已补过则不能再补（补上班/补下班各一次，防无限补）。
    const ds = dayStateOf(date)
    const hasWork = (ds & S_WORK) !== 0
    const hasOff = (ds & S_OFF) !== 0
    const targetOff = hasWork && !hasOff
    const alreadyWorkMakeup = (ds & (S_WORK | S_MAKEUP)) === (S_WORK | S_MAKEUP) // 补上班卡(9)已存在
    const alreadyOffMakeup = (ds & (S_OFF | S_MAKEUP)) === (S_OFF | S_MAKEUP) // 补下班卡(10)已存在
    if (targetOff && alreadyOffMakeup) return false
    if (!targetOff && alreadyWorkMakeup) return false
    return true
  }
  const mi = measureInfo.value, st = dayStatus.value
  if (!mi || !st) return false
  const ds = dayStateOf(date)
  const alreadyWorkMakeup = (ds & (S_WORK | S_MAKEUP)) === (S_WORK | S_MAKEUP) // 补上班卡(9)已存在
  const alreadyOffMakeup = (ds & (S_OFF | S_MAKEUP)) === (S_OFF | S_MAKEUP) // 补下班卡(10)已存在
  const targetOff = !(mi.date === todayStr && st.status === 'late') && (ds & S_WORK) !== 0
  // 目标槽位已补过 → 不能再补（防止一个迟到无限补卡）。
  if (targetOff && alreadyOffMakeup) return false
  if (!targetOff && alreadyWorkMakeup) return false
  const nowMin = new Date().getHours() * 60 + new Date().getMinutes()
  const ws = hm(mi.stdStart || '09:00')
  const we = hm(mi.stdEnd || '18:00')
  if (st.status === 'late') return true // 迟到已过上班时间 → 可补上班卡
  if (st.missingWork) return nowMin > ws // 缺上班卡已过上班时间 → 可补上班卡
  if (st.missingOff || st.status === 'early' || st.status === 'late_early') return nowMin > we // 缺下班/早退已过下班时间 → 可补下班卡
  return false
}
const hasInMeasure = computed(() => {
  const mi = measureInfo.value
  // 当天已打/补上班卡（state 含 1 位）才视为已有上班卡，据此决定补上班还是补下班。
  return mi ? (dayStateOf(mi.date) & S_WORK) !== 0 : false
})
// 正常日直接看详情；异常日（黄点：缺卡/迟到/早退/被拦截，且无通过申请）弹措施。
function onSelectDay(dateStr: string): void {
  if (dotsOf(dateStr).includes('yellow')) {
    // 上下班时间优先取该日打卡记录固化快照（历史判定与补卡预填按该日规则，而非今天的规则）。
    const snap = dayMap.value.get(dateStr)?.records?.[0]
    const todaySt = dayStatus.value
    measureDate.value = dateStr
    measureInfo.value = {
      date: dateStr,
      stdStart: snap?.stdStart || todaySt?.stdStart || '09:00',
      stdEnd: snap?.stdEnd || todaySt?.stdEnd || '18:00',
    }
    return
  }
  selected.value = dateStr
}
// 补卡/请假：跳到考勤申请并预填（补卡=该日期+正常上下班时间；请假=该日期区间）。
function measureOpenApply(type: 'make_up' | 'leave'): void {
  const mi = measureInfo.value
  const pending = {
    type,
    date: mi?.date || todayStr,
    slot: (() => {
      if (type !== 'make_up' || !mi) return undefined
      // 补上班还是补下班：今天迟到→补上班；无上班卡→补上班；有上班卡缺下班→补下班。
      const st = dayStatus.value
      const lateToday = mi.date === todayStr && !!st && st.status === 'late'
      return lateToday || !hasInMeasure.value ? 'work' : 'off'
    })(),
    time: (() => {
      if (type !== 'make_up' || !mi) return undefined
      // 今天迟到 → 补上班卡（把迟到补成正常上班时间）；当天无上班卡 → 补上班卡；有上班卡缺下班 → 补下班卡。
      const st = dayStatus.value
      const lateToday = mi.date === todayStr && !!st && st.status === 'late'
      return lateToday ? mi.stdStart : (hasInMeasure.value ? mi.stdEnd : mi.stdStart)
    })(),
  }
  ;(window as any).__pendingAttendanceApply = pending
  measureDate.value = ''
  measureInfo.value = null
  window.dispatchEvent(new CustomEvent('mochi:nav', { detail: 'apply' }))
  window.dispatchEvent(new CustomEvent('mochi:attendance:openApply', { detail: pending }))
}

// ── 数据加载 ──
async function loadData(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinList({ companyId: companyId.value, month: monthStr.value })
    if (!ack.ok) { console.error('[打卡] 记录加载失败', ack.error); return }
    days.value = (ack.data as { days?: CheckinDay[] })?.days ?? []
  } catch (e) { console.error('[打卡] 记录加载异常', e) }
}
// 当月考勤申请（紫点）：dateStart/dateEnd 传当月区间
async function loadMonthAtts(): Promise<void> {
  if (!companyId.value) return
  try {
    const y = cur.value.getFullYear()
    const m = cur.value.getMonth()
    const p = (n: number) => String(n).padStart(2, '0')
    const dateStart = `${y}-${p(m + 1)}-01`
    const dateEnd = `${y}-${p(m + 1)}-${new Date(y, m + 1, 0).getDate()}`
    const ack = await window.pantry.serverAttendanceList({ companyId: companyId.value, dateStart, dateEnd, page: 1, pageSize: 100 })
    if (!ack.ok) { console.error('[打卡] 当月申请加载失败', ack.error); return }
    const reqs = (ack.data as { requests?: Array<{ makeupDate?: string | null; startTime?: string | null; createdAt: string; type: string; status: string }> })?.requests ?? []
    const out: MonthAtt[] = []
    for (const r of reqs) {
      // 补卡(make_up)无 startTime，用目标日期 makeupDate（补卡落到被补那天，跨天补下班也正确匹配）；
      // 无 makeupDate/startTime 才回退 createdAt。
      const ds = r.makeupDate ? fmtDate(r.makeupDate) : (r.startTime ? fmtDate(r.startTime) : fmtDate(r.createdAt))
      out.push({ date: ds, type: r.type, status: r.status })
    }
    monthAtts.value = out
  } catch (e) { console.error('[打卡] 当月申请加载异常', e) }
}

function prevMonth(): void { cur.value = new Date(cur.value.getFullYear(), cur.value.getMonth() - 1, 1) }
function nextMonth(): void { cur.value = new Date(cur.value.getFullYear(), cur.value.getMonth() + 1, 1) }

watch(monthStr, async () => { await Promise.all([loadData(), loadMonthAtts()]) })
watch(companyId, async () => {
  if (!companyId.value) return
  await Promise.all([loadData(), loadMonthAtts(), loadStatus()])
})
onMounted(async () => {
  // 先注册事件监听（在数据加载前），避免通讯录「考勤设置」在加载期间派发的 openRules 事件丢失
  window.addEventListener('mochi:checkin:openRules', onOpenRulesEvent)
  window.addEventListener('mochi:checkin:refresh', onRefreshCheckin)
  await Promise.all([loadMac(), loadData(), loadMonthAtts(), loadStatus(), loadStatFiles()])
  // 兜底：通讯录「考勤设置」→ __pendingOpenRules 标志（不依赖事件时序），挂载后消费。
  if ((window as any).__pendingOpenRules) {
    ;(window as any).__pendingOpenRules = false
    onOpenRulesEvent()
  }
})
onBeforeUnmount(() => {
  window.removeEventListener('mochi:checkin:openRules', onOpenRulesEvent)
  window.removeEventListener('mochi:checkin:refresh', onRefreshCheckin)
})
// 通讯录企业菜单「考勤设置」→ 跳转打卡页后自动打开规则设置
function onOpenRulesEvent(): void {
  if (!app.isAdmin) return
  void openRulesWhenReady()
}
// 修复：跳转打卡页时公司上下文（activeCompanyId）可能尚未就绪，导致 openRules 静默返回、
// 规则弹窗不弹出（"界面消失"）。此处轮询等待公司就绪后再打开，最多等 2 秒兜底。
async function openRulesWhenReady(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if (companyId.value) { await openRules(); return }
    await new Promise((r) => setTimeout(r, 100))
  }
  await openRules() // 超时也尝试一次（openRules 内部有 companyId 守卫）
}
// 考勤审批通过/驳回后刷新打卡页：重载当天打卡、月度申请状态、打卡状态，使状态点黄→紫即时生效。
function onRefreshCheckin(): void {
  void Promise.all([loadData(), loadMonthAtts(), loadStatus()])
}
</script>

<template>
  <div class="ci">
    <!-- 月历头部 -->
    <div class="ci-head">
      <button class="ci-nav" @click="prevMonth"><i class="fas fa-chevron-left"></i></button>
      <span class="ci-title">{{ monthLabel }}</span>
      <button class="ci-nav" @click="nextMonth"><i class="fas fa-chevron-right"></i></button>
    </div>

    <div class="ci-legend">
      <span class="ci-lg"><i class="dot blue"></i> 上下班正常</span>
      <span class="ci-lg"><i class="dot yellow"></i> 异常/被拦截</span>
      <span class="ci-lg"><i class="dot purple"></i> 有考勤申请</span>
    </div>

    <!-- 月历（公共组件，状态点用插槽填充）-->
    <CalendarMonth :year="cur.getFullYear()" :month="cur.getMonth() + 1" :today="todayStr" @select="onSelectDay">
      <template #day="{ date }">
        <span class="ci-dots"><i v-for="(k, i) in dotsOf(date)" :key="i" class="dot" :class="k"></i></span>
      </template>
    </CalendarMonth>

    <!-- 打卡按钮区 -->
    <div class="ci-actions">
      <!-- 当天状态卡 -->
      <div v-if="dayStatus" class="ci-status" :class="statusCls[dayStatus.status]">
        <div class="ci-st-head">
          <span class="ci-st-title">{{ dayStatus.date }} · {{ statusLabel[dayStatus.status] }}</span>
        </div>
        <div class="ci-st-row">
          <span>上班：{{ dayStatus.stdStart || '--' }}</span>
          <span>打卡：{{ dayStatus.punchIn || '未打' }}</span>
        </div>
        <div class="ci-st-row">
          <span>下班：{{ dayStatus.stdEnd || '--' }}</span>
          <span>打卡：{{ dayStatus.punchOut || '未打' }}</span>
        </div>
        <div v-if="dayStatus.missingWork || dayStatus.missingOff" class="ci-miss">
          缺卡：<template v-if="dayStatus.missingWork">上班未打卡</template><template v-if="dayStatus.missingWork && dayStatus.missingOff">、</template><template v-if="dayStatus.missingOff">下班未打卡</template>
        </div>
      </div>

      <div v-if="punchMsg" class="ci-ok">{{ punchMsg }}</div>
      <div v-if="punchErr" class="ci-warn">{{ punchErr }}</div>
      <button class="ci-punch" :disabled="punching" @click="doCheckin">
        {{ punchLabel }}
      </button>
      <div class="ci-mac">本机 MAC：{{ mac || '（未取到）' }}</div>
    </div>

    <!-- 月度考勤统计（admin 查看/下载 CSV，财务人事私聊发送给员工） -->
    <div v-if="app.isAdmin" class="ci-stat">
      <div class="ci-stat-head"><i class="fas fa-chart-bar"></i> 月度考勤统计{{ statMonth ? `（${statMonth}）` : '' }}</div>
      <div v-if="!statFiles.length" class="ci-stat-empty">当月尚未生成统计（每月最后一天 23:59 自动生成）</div>
      <ul v-else class="ci-stat-list">
        <li v-for="f in statFiles" :key="f.name" class="ci-stat-item">
          <span class="ci-stat-name">{{ f.name }}</span>
          <button class="dt-btn sm" @click="downloadStat(f)"><i class="fas fa-download"></i> 下载</button>
        </li>
      </ul>
      <div class="ci-stat-tip">提示：下载后通过聊天私聊发送给对应员工（财务/人事）</div>
    </div>

    <!-- 打卡规则设置弹窗（admin） -->
    <div v-if="showRules && rulesForm" class="modal-mask" @click.self="showRules = false">
      <div class="modal" style="width:560px">
        <div class="modal-head">打卡规则设置</div>
        <div class="modal-body" style="max-height:70vh;overflow:auto">
          <div class="ci-r-row">
            <label>模式</label>
            <select v-model="rulesForm.mode">
              <option value="standard">双休</option>
              <option value="sixday">单休</option>
              <option value="nosleep">无休</option>
              <option value="bigsmall">大小周</option>
            </select>
          </div>
          <div class="ci-r-row">
            <label>迟到豁免（分钟）</label>
            <input type="number" v-model.number="rulesForm.grace_late_min" min="0" />
            <label>早退豁免（分钟）</label>
            <input type="number" v-model.number="rulesForm.grace_early_min" min="0" />
          </div>
          <div v-for="(w, i) in rulesForm.week_rules" :key="i" class="ci-r-row">
            <label>{{ WEEK_NAMES[w.dow] }}</label>
            <label class="ci-r-chk"><input type="checkbox" v-model="w.rest" /> 休息</label>
            <input v-if="!w.rest" type="time" v-model="w.start" />
            <input v-if="!w.rest" type="time" v-model="w.end" />
          </div>
          <div v-if="rulesForm.mode === 'bigsmall' && rulesForm.alt_rule" class="ci-r-row">
            <label>大小周交替日</label>
            <select v-model="rulesForm.alt_rule.dow">
              <option v-for="(n, i) in WEEK_NAMES" :key="i" :value="i">{{ n }}</option>
            </select>
            <input v-model="rulesForm.alt_rule.altStart" type="time" />
            <input v-model="rulesForm.alt_rule.altEnd" type="time" />
          </div>
          <div class="ci-r-row ci-r-mac">
            <label>MAC 限制</label>
            <label class="ci-r-chk"><input type="checkbox" v-model="macEnabled" /> 只允许指定 MAC 地址打卡</label>
            <button class="dt-btn sm" @click="showMacEditor = true"><i class="fas fa-edit"></i> 编辑可打卡 MAC 列表</button>
          </div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showRules = false">取消</button>
          <button class="dt-btn primary" @click="saveRules">保存</button>
        </div>
      </div>
    </div>

    <!-- 可打卡 MAC 地址列表编辑弹窗 -->
    <div v-if="showMacEditor" class="modal-mask" @click.self="showMacEditor = false">
      <div class="modal" style="width:480px">
        <div class="modal-head">可打卡 MAC 地址列表</div>
        <div class="modal-body">
          <textarea v-model="macListText" rows="8" style="width:100%;box-sizing:border-box;font-size:13px;resize:vertical"
            placeholder="每行一个 MAC，或用逗号分隔，例如：&#10;AA:BB:CC:DD:EE:FF&#10;11:22:33:44:55:66"></textarea>
          <div style="color:var(--dt-text-3);font-size:11px;margin-top:6px">本机 MAC：{{ mac || '未知' }}（打卡时按此匹配；开启后仅列表内 MAC 可打卡）</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showMacEditor = false">取消</button>
          <button class="dt-btn primary" @click="showMacEditor = false">确定</button>
        </div>
      </div>
    </div>

    <!-- 异常日期措施弹窗（打卡/补卡/请假） -->
    <div v-if="measureDate && measureInfo" class="modal-mask" @click.self="measureDate = ''">
      <div class="modal" style="width:440px">
        <div class="modal-head">{{ measureInfo.date }} 打卡异常处理</div>
        <div class="modal-body">
          <div class="ci-meas-tip">该日存在打卡异常，请选择处理方式：</div>
          <div class="ci-meas-btns">
            <button v-if="canMakeup(measureInfo.date)" class="dt-btn ci-meas-btn" @click="measureOpenApply('make_up')">
              <i class="fas fa-pen"></i> 补卡（预填 {{ measureInfo.date }} {{ hasInMeasure ? measureInfo.stdEnd : measureInfo.stdStart }}）
            </button>
            <button class="dt-btn ci-meas-btn" @click="measureOpenApply('leave')"><i class="fas fa-bed"></i> 请假</button>
          </div>
        </div>
        <div class="modal-foot"><button class="dt-btn" @click="measureDate = ''">取消</button></div>
      </div>
    </div>

    <!-- 当天详情弹窗 -->
    <div v-if="selected" class="modal-mask" @click.self="selected = ''">
      <div class="modal">
        <div class="modal-head">{{ selected }} 打卡详情</div>
        <div class="modal-body">
          <div v-if="selectedDay && selectedDay.records.length">
            <div v-for="r in selectedDay.records" :key="r.id" class="ci-rec">
              <span class="ci-rec-time">{{ fmtTime(r.checkTime) }}</span>
              <span v-if="r.label" :class="recCls(r.label)">{{ r.label }}</span>
              <span class="ci-rec-ip">{{ r.ip }}</span>
            </div>
            <div class="ci-rec-summary">共 {{ selectedDay.count }} 次　首 {{ fmtTime(selectedDay.firstTime) }}　末 {{ fmtTime(selectedDay.lastTime) }}</div>
          </div>
          <div v-else class="ci-rec-empty">当天无打卡记录</div>
          <!-- 当天通过加班申请（加班申请通过才显示，不靠打卡时间晚推断） -->
          <div v-if="selectedDay && selectedDay.overtimes && selectedDay.overtimes.length" class="ci-day-att ci-ot">
            <div class="ci-att-t">当天加班</div>
            <div v-for="(o, i) in selectedDay.overtimes" :key="'ot'+i" class="ci-ot-item">{{ fmtOvertime(o) }}</div>
          </div>
          <div v-if="selectedAtts.length" class="ci-day-att">
            <div class="ci-att-t">当天考勤申请</div>
            <div v-for="(a, i) in selectedAtts" :key="i" class="ci-att-item">
              {{ a.type === 'make_up' ? '补卡' : a.type === 'leave' ? '请假' : a.type === 'comp_time' ? '调休' : '加班' }}
            </div>
          </div>
        </div>
        <div class="modal-foot"><button class="dt-btn" @click="selected = ''">关闭</button></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ci { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; padding: 12px 18px; overflow: auto; }
.ci-head { display: flex; align-items: center; justify-content: center; gap: 16px; }
.ci-title { font-size: 16px; font-weight: 700; min-width: 120px; text-align: center; }
.ci-nav { border: none; background: #f0f2f5; width: 28px; height: 28px; border-radius: 50%; cursor: pointer; color: var(--dt-text-3); }
.ci-legend { display: flex; gap: 14px; justify-content: center; margin: 8px 0; font-size: 12px; color: var(--dt-text-3); }
.ci-lg { display: inline-flex; align-items: center; gap: 4px; }
.dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
.ci-dots { display: inline-flex; gap: 3px; }
.dot.blue { background: #3b82f6; }
.dot.yellow { background: #f59e0b; }
.dot.purple { background: #8b5cf6; }
.ci-actions { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 12px; }
.ci-punch { width: 96px; height: 96px; border-radius: 50%; border: none; background: var(--dt-primary); color: #fff; font-size: 18px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(59,130,246,.4); }
.ci-punch:disabled { opacity: .6; cursor: not-allowed; }
.ci-ok { color: #2fbb6b; font-size: 13px; }
.ci-warn { color: #d92b3a; font-size: 13px; }
.ci-mac { font-size: 11px; color: var(--dt-text-4); }
.ci-stat { width: 100%; max-width: 420px; margin-top: 14px; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 10px 14px; background: #fff; font-size: 13px; }
.ci-stat-head { font-weight: 600; margin-bottom: 8px; }
.ci-stat-empty { color: var(--dt-text-3); font-size: 12px; }
.ci-stat-list { list-style: none; margin: 0; padding: 0; }
.ci-stat-item { display: flex; align-items: center; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed var(--dt-border-light); }
.ci-stat-item:last-child { border-bottom: none; }
.ci-stat-name { word-break: break-all; }
.ci-stat-tip { margin-top: 6px; color: var(--dt-text-3); font-size: 11px; }
.ci-rec { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; border-bottom: 1px dashed var(--dt-border-light); font-size: 13px; }
.ci-rec-lbl { font-size: 11px; padding: 1px 6px; border-radius: 4px; background: #f0f2f5; color: var(--dt-text-3); white-space: nowrap; }
.ci-rec-lbl.warn { background: #fdf0f1; color: #d92b3a; }
.ci-rec-lbl.make { background: #eef4ff; color: #2f6bff; }
.ci-rec-lbl.leave { background: #f3eefe; color: #8b5cf6; }
.ci-ot { border-top: 1px dashed var(--dt-border-light); padding-top: 6px; }
.ci-ot-item { font-size: 13px; padding: 2px 0; color: #d97706; }
.ci-rec-summary { margin-top: 6px; font-size: 12px; color: var(--dt-text-3); }
.ci-rec-empty { color: var(--dt-text-4); font-size: 13px; }
.ci-day-att { margin-top: 10px; }
.ci-att-t { font-size: 12px; color: var(--dt-text-3); margin-bottom: 4px; }
.ci-att-item { font-size: 13px; padding: 2px 0; }
.ci-status { width: 100%; max-width: 420px; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 10px 14px; font-size: 13px; background: #fff; }
.ci-status.ok { border-color: #2fbb6b; background: #f0faf4; }
.ci-status.warn { border-color: #d92b3a; background: #fdf0f1; color: #d92b3a; }
.ci-status.rest { background: #f6f7f9; color: var(--dt-text-3); }
.ci-status.none { background: #fff; }
.ci-st-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-weight: 700; }
.ci-st-cfg { border: none; background: transparent; color: var(--dt-primary); cursor: pointer; font-size: 12px; }
.ci-st-row { display: flex; justify-content: space-between; padding: 2px 0; }
.ci-r-row { display: flex; align-items: center; gap: 10px; padding: 4px 0; font-size: 13px; }
.ci-r-row label { min-width: 90px; color: var(--dt-text-3); }
.ci-r-row input[type="number"], .ci-r-row input[type="time"], .ci-r-row select { height: 28px; border: 1px solid var(--dt-border); border-radius: 4px; padding: 0 6px; font-size: 13px; }
.ci-r-chk { min-width: 60px !important; display: flex; align-items: center; gap: 4px; }
.ci-r-row.ci-r-mac { flex-wrap: wrap; }
.ci-r-row .dt-btn.sm { height: 26px; font-size: 12px; }
.ci-r-hint { color: var(--dt-text-3); font-size: 11px; margin-left: 8px; flex: 1; }
.ci-miss { margin-top: 6px; padding: 6px 10px; background: #fff7ed; color: #d97706; border-radius: 6px; font-size: 12px; }
.ci-meas-tip { margin-bottom: 12px; font-size: 13px; color: var(--dt-text-2); }
.ci-meas-btns { display: flex; flex-direction: column; gap: 8px; }
.ci-meas-btn { width: 100%; justify-content: flex-start; }
</style>
