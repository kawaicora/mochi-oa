<script setup lang="ts">
import { ref, computed, watch, onMounted } from 'vue'
import CalendarMonth from './common/CalendarMonth.vue'
import { useAppStore } from '../stores/app'
import { toPlain } from '../utils/plain'

// ── 类型（与服务端冻结协议对齐）──
interface CheckinItem {
  id: number
  companyId: number
  userId: number
  checkDate: string // YYYY-MM-DD
  checkTime: string // YYYY-MM-DD HH:mm:ss
  ip: string
  mac: string
  createdAt: string
  nick?: string
  username?: string
}
interface CheckinDay {
  date: string // YYYY-MM-DD
  count: number
  firstTime: string | null
  lastTime: string | null
  records: CheckinItem[]
}
// 当月考勤申请（用于日历紫点判断）
interface MonthAtt { date: string; type: string }

const app = useAppStore()
const companyId = computed(() => app.activeCompanyId)

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

// 某日期状态点 class：blue 正常(>=2) / yellow 异常(=1 或白名单拒) / purple 当天有申请
type DotKind = 'none' | 'blue' | 'yellow' | 'purple'
function dotOf(dateStr: string): DotKind {
  const day = dayMap.value.get(dateStr)
  const hasAtt = monthAtts.value.some((a) => a.date === dateStr)
  if (day && day.count >= 2) return 'blue'
  if ((day && day.count === 1) || rejectedDays.value.has(dateStr)) return 'yellow'
  if (hasAtt) return 'purple'
  return 'none'
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
  return '再打卡（覆盖下班）'
})

// ── 当天状态（checkin:status:get）──
type StatusKind = 'rest' | 'none' | 'normal' | 'late' | 'early' | 'late_early'
interface DayStatus { date: string; rest: boolean; workStart: string | null; workEnd: string | null; punchIn: string | null; punchOut: string | null; status: StatusKind; mode: string }
const dayStatus = ref<DayStatus | null>(null)
const statusLabel: Record<StatusKind, string> = {
  rest: '休息日', none: '暂无打卡记录', normal: '正常', late: '迟到', early: '早退', late_early: '迟到+早退'
}
const statusCls: Record<StatusKind, string> = {
  rest: 'rest', none: 'none', normal: 'ok', late: 'warn', early: 'warn', late_early: 'warn'
}
async function loadStatus(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinStatusGet({ companyId: companyId.value, date: todayStr })
    if (ack.ok) dayStatus.value = ((ack.data as { status?: DayStatus })?.status ?? null) as DayStatus | null
    else console.error('[打卡] 当天状态加载失败', ack.error)
  } catch (e) { console.error('[打卡] 当天状态加载异常', e) }
}

// ── 打卡规则弹窗（admin/owner）──
const showRules = ref(false)
interface WeekRule { dow: number; start: string; end: string; rest: boolean }
interface RulesForm { mode: string; grace_late_min: number; grace_early_min: number; week_rules: WeekRule[]; alt_rule: { dow: number; altStart: string; altEnd: string } | null }
const rulesForm = ref<RulesForm | null>(null)
const WEEK_NAMES = ['周日','周一','周二','周三','周四','周五','周六']
async function openRules(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverCheckinRulesGet(companyId.value)
    if (!ack.ok) { console.error('[打卡] 规则加载失败', ack.error); return }
    const d = (ack.data as { rules?: RulesForm })?.rules
    if (d) {
      const f = JSON.parse(JSON.stringify(d)) as RulesForm
      if (!f.alt_rule) f.alt_rule = { dow: 6, altStart: '09:00', altEnd: '18:00' }
      rulesForm.value = f
    }
    showRules.value = true
  } catch (e) { console.error('[打卡] 规则加载异常', e) }
}
async function saveRules(): Promise<void> {
  if (!companyId.value || !rulesForm.value) return
  try {
    const ack = await window.pantry.serverCheckinRulesSave(toPlain({ companyId: companyId.value, ...rulesForm.value }))
    if (!ack.ok) { console.error('[打卡] 规则保存失败', ack.error); return }
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
      punchMsg.value = kind === 'first' ? '已记录上班时间'
        : kind === 'second' ? '已记录下班时间'
        : kind === 'override' ? '已更新下班时间'
        : '打卡成功'
      await loadData()
      await loadStatus()
    }
  } catch (e) {
    console.error('[打卡] 打卡异常', e)
    punchErr.value = '打卡异常'
  }
  punching.value = false
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
    const reqs = (ack.data as { requests?: Array<{ startTime?: string | null; createdAt: string; type: string }> })?.requests ?? []
    const out: MonthAtt[] = []
    for (const r of reqs) {
      const ds = r.startTime ? r.startTime.slice(0, 10) : r.createdAt.slice(0, 10)
      out.push({ date: ds, type: r.type })
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
onMounted(async () => { await Promise.all([loadMac(), loadData(), loadMonthAtts(), loadStatus()]) })
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
    <CalendarMonth :year="cur.getFullYear()" :month="cur.getMonth() + 1" :today="todayStr" @select="(ds) => (selected = ds)">
      <template #day="{ date }">
        <i v-if="dotOf(date) !== 'none'" class="dot" :class="dotOf(date)"></i>
      </template>
    </CalendarMonth>

    <!-- 打卡按钮区 -->
    <div class="ci-actions">
      <!-- 当天状态卡 -->
      <div v-if="dayStatus" class="ci-status" :class="statusCls[dayStatus.status]">
        <div class="ci-st-head">
          <span class="ci-st-title">{{ dayStatus.date }} · {{ statusLabel[dayStatus.status] }}</span>
          <button v-if="app.isAdmin" class="ci-st-cfg" @click="openRules"><i class="fas fa-cog"></i> 规则设置</button>
        </div>
        <div class="ci-st-row">
          <span>上班：{{ dayStatus.workStart || '--' }}</span>
          <span>打卡：{{ dayStatus.punchIn || '未打' }}</span>
        </div>
        <div class="ci-st-row">
          <span>下班：{{ dayStatus.workEnd || '--' }}</span>
          <span>打卡：{{ dayStatus.punchOut || '未打' }}</span>
        </div>
      </div>

      <div v-if="punchMsg" class="ci-ok">{{ punchMsg }}</div>
      <div v-if="punchErr" class="ci-warn">{{ punchErr }}</div>
      <button class="ci-punch" :disabled="punching" @click="doCheckin">
        {{ punchLabel }}
      </button>
      <div class="ci-mac">本机 MAC：{{ mac || '（未取到）' }}</div>
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
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showRules = false">取消</button>
          <button class="dt-btn primary" @click="saveRules">保存</button>
        </div>
      </div>
    </div>

    <!-- 当天详情弹窗 -->
    <div v-if="selected" class="modal-mask" @click.self="selected = ''">
      <div class="modal">
        <div class="modal-head">{{ selected }} 打卡详情</div>
        <div class="modal-body">
          <div v-if="selectedDay && selectedDay.records.length">
            <div v-for="r in selectedDay.records" :key="r.id" class="ci-rec">
              <span class="ci-rec-time">{{ r.checkTime.slice(11) }}</span>
              <span class="ci-rec-ip">{{ r.ip }}</span>
            </div>
            <div class="ci-rec-summary">共 {{ selectedDay.count }} 次　首 {{ selectedDay.firstTime?.slice(11) }}　末 {{ selectedDay.lastTime?.slice(11) }}</div>
          </div>
          <div v-else class="ci-rec-empty">当天无打卡记录</div>
          <div v-if="selectedAtts.length" class="ci-day-att">
            <div class="ci-att-t">当天考勤申请</div>
            <div v-for="(a, i) in selectedAtts" :key="i" class="ci-att-item">
              {{ a.type === 'make_up' ? '补卡' : a.type === 'leave' ? '请假' : '调休' }}
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
.dot.blue { background: #3b82f6; }
.dot.yellow { background: #f59e0b; }
.dot.purple { background: #8b5cf6; }
.ci-actions { display: flex; flex-direction: column; align-items: center; gap: 8px; margin-top: 12px; }
.ci-punch { width: 96px; height: 96px; border-radius: 50%; border: none; background: var(--dt-primary); color: #fff; font-size: 18px; font-weight: 700; cursor: pointer; box-shadow: 0 4px 14px rgba(59,130,246,.4); }
.ci-punch:disabled { opacity: .6; cursor: not-allowed; }
.ci-ok { color: #2fbb6b; font-size: 13px; }
.ci-warn { color: #d92b3a; font-size: 13px; }
.ci-mac { font-size: 11px; color: var(--dt-text-4); }
.ci-rec { display: flex; justify-content: space-between; padding: 4px 0; border-bottom: 1px dashed var(--dt-border-light); font-size: 13px; }
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
</style>
