<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { Lunar } from 'lunar-javascript'
import { useAppStore } from '../stores/app'

interface Cell { date: string; day: number; inMonth: boolean }

const pad = (n: number) => String(n).padStart(2, '0')

const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth())
const selectedDate = ref(fmt(new Date()))

function fmt(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// ─── 事件：localStorage 持久化（本机） ───
const STORE_KEY = 'mochi_calendar_events'
const events = ref<Record<string, string[]>>(load())
function load(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}
function save(): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(events.value))
}
function dayEvents(date: string): string[] {
  return events.value[date] ?? []
}
const newEventTitle = ref('')
function addEvent(): void {
  const t = newEventTitle.value.trim()
  if (!t || !selectedDate.value) return
  events.value[selectedDate.value] = [...(events.value[selectedDate.value] ?? []), t]
  newEventTitle.value = ''
  save()
}
function delEvent(date: string, idx: number): void {
  const list = (events.value[date] ?? []).filter((_, i) => i !== idx)
  if (list.length) events.value[date] = list
  else delete events.value[date]
  save()
}
function hasEvent(date: string): boolean {
  return (events.value[date] ?? []).length > 0
}

// ─── 农历 / 节日 / 法定假期（服务端同步，可修改） ───
const app = useAppStore()
const holidays = ref<Record<string, { name: string; type: string }>>({})
async function loadHolidays(): Promise<void> {
  const list = await app.fetchHolidays()
  const map: Record<string, { name: string; type: string }> = {}
  for (const h of list) map[h.date] = { name: h.name, type: h.type }
  holidays.value = map
}
function holidayOf(date: string): { name: string; type: string } | null {
  return holidays.value[date] ?? null
}
function holidayType(date: string): string {
  return holidayOf(date)?.type ?? ''
}
const typeLabel: Record<string, string> = { legal: '法定假期', workday: '调休补班', custom: '自定义' }

function lunarOf(date: string): ReturnType<typeof Lunar.fromDate> {
  const [y, m, d] = date.split('-').map(Number)
  return Lunar.fromDate(new Date(y, m - 1, d))
}
/** 格子里的农历/节日/节气标签（节气 > 节日 > 农历日） */
function lunarLabel(date: string): string {
  const l = lunarOf(date)
  const jq = l.getJieQi()
  if (jq) return jq
  const f = [...(l.getFestivals() ?? []), ...(l.getOtherFestivals() ?? [])][0]
  if (f) return f
  return l.getDayInChinese()
}
function lunarFull(date: string): string {
  const l = lunarOf(date)
  return `${l.getYearInChinese()}年${l.getMonthInChinese()}月${l.getDayInChinese()}`
}
function festivalsOf(date: string): string[] {
  const l = lunarOf(date)
  return [...(l.getFestivals() ?? []), ...(l.getOtherFestivals() ?? [])]
}

const holidayName = ref('')
function initHolidayName(): void {
  const h = holidayOf(selectedDate.value)
  holidayName.value = h?.name ?? festivalsOf(selectedDate.value)[0] ?? ''
}
async function setHoliday(type: 'legal' | 'workday'): Promise<void> {
  if (!selectedDate.value) return
  const name = holidayName.value.trim() || (type === 'legal' ? '法定假期' : '调休补班')
  await app.addHoliday(selectedDate.value, name, type)
  await loadHolidays()
  initHolidayName()
}
async function clearHoliday(): Promise<void> {
  if (!selectedDate.value) return
  await app.removeHoliday(selectedDate.value)
  await loadHolidays()
  initHolidayName()
}

// ─── 多选 / 批量 / 恢复默认 ───
const isMulti = ref(false)
const multiDates = ref<string[]>([])
function onCellClick(c: Cell): void {
  if (isMulti.value) {
    multiDates.value = multiDates.value.includes(c.date)
      ? multiDates.value.filter((d) => d !== c.date)
      : [...multiDates.value, c.date]
  } else {
    selectedDate.value = c.date
  }
}
function isMultiSel(date: string): boolean {
  return multiDates.value.includes(date)
}
function toggleMultiMode(): void {
  isMulti.value = !isMulti.value
  if (!isMulti.value) multiDates.value = []
}
function exitMulti(): void {
  isMulti.value = false
  multiDates.value = []
}
async function bulkSet(type: 'legal' | 'workday'): Promise<void> {
  if (!multiDates.value.length) return
  const defaultName = type === 'legal' ? '法定假期' : '调休上班'
  const name = holidayName.value.trim() || defaultName
  const items = multiDates.value.map((date) => ({ date, name, type }))
  await app.addHolidays(items)
  await loadHolidays()
  exitMulti()
}
async function bulkClear(): Promise<void> {
  if (!multiDates.value.length) return
  await app.removeHolidays(multiDates.value)
  await loadHolidays()
  exitMulti()
}
async function resetDefault(): Promise<void> {
  if (!window.confirm('将清空全部假期并恢复为官方法定安排（会移除你的自定义与修改），确定恢复默认？')) return
  const r = await app.resetHolidays()
  if (r.ok) {
    await loadHolidays()
    initHolidayName()
  } else {
    window.alert(r.error || '恢复默认失败')
  }
}

let offHolidays: (() => void) | null = null
onMounted(async () => {
  await loadHolidays()
  initHolidayName()
  offHolidays = window.pantry.onHolidaysUpdated(() => {
    void loadHolidays()
  })
})
onUnmounted(() => {
  offHolidays?.()
  offHolidays = null
})

// ─── 月历 ───
const cells = computed<Cell[]>(() => {
  const y = viewYear.value
  const m = viewMonth.value
  const firstDow = new Date(y, m, 1).getDay()
  const daysInMonth = new Date(y, m + 1, 0).getDate()
  const prevDays = new Date(y, m, 0).getDate()
  const out: Cell[] = []
  for (let i = 0; i < 42; i++) {
    const d = i - firstDow + 1
    let yy = y
    let mm = m
    let dd = d
    if (d <= 0) {
      mm -= 1
      if (mm < 0) { mm = 11; yy -= 1 }
      dd = prevDays + d
    } else if (d > daysInMonth) {
      mm += 1
      if (mm > 11) { mm = 0; yy += 1 }
      dd = d - daysInMonth
    }
    out.push({ date: `${yy}-${pad(mm + 1)}-${pad(dd)}`, day: dd, inMonth: d >= 1 && d <= daysInMonth })
  }
  return out
})

const todayStr = fmt(new Date())

function go(offset: number): void {
  viewMonth.value += offset
  if (viewMonth.value < 0) { viewMonth.value = 11; viewYear.value -= 1 }
  if (viewMonth.value > 11) { viewMonth.value = 0; viewYear.value += 1 }
}
function goToday(): void {
  viewYear.value = now.getFullYear()
  viewMonth.value = now.getMonth()
  selectedDate.value = todayStr
}
</script>

<template>
  <section class="cal-panel">
    <div class="cal-top">
      <div class="cal-nav">
        <button class="cal-nav-btn" title="上个月" @click="go(-1)"><i class="fas fa-chevron-left"></i></button>
        <button class="cal-nav-btn" @click="goToday">今天</button>
        <button class="cal-nav-btn" title="下个月" @click="go(1)"><i class="fas fa-chevron-right"></i></button>
      </div>
      <div class="cal-ym">{{ viewYear }} 年 {{ viewMonth + 1 }} 月</div>
      <div class="cal-ops">
        <button class="cal-op-btn" :class="{ active: isMulti }" @click="toggleMultiMode">
          <i class="fas fa-object-group"></i> 多选{{ isMulti ? '中' : '' }}
        </button>
        <button class="cal-op-btn" title="清空并恢复为官方法定安排" @click="resetDefault">
          <i class="fas fa-undo"></i> 恢复默认
        </button>
      </div>
    </div>

    <div v-if="isMulti" class="cal-multi-bar">
      <span class="cal-multi-count"><i class="fas fa-check-circle"></i> 已选 {{ multiDates.length }} 天</span>
      <input v-model="holidayName" class="cal-multi-input" placeholder="假期名称（可空：默认法定假期/调休上班）" maxlength="20" @keyup.enter="bulkSet('legal')" />
      <button class="cal-multi-btn legal" @click="bulkSet('legal')"><i class="fas fa-sun"></i> 设为法定假期</button>
      <button class="cal-multi-btn workday" @click="bulkSet('workday')"><i class="fas fa-briefcase"></i> 设为补班</button>
      <button class="cal-multi-btn clear" @click="bulkClear"><i class="fas fa-trash"></i> 取消假期</button>
      <button class="cal-multi-btn exit" @click="exitMulti"><i class="fas fa-times"></i> 退出</button>
    </div>

    <div class="cal-week">
      <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
    </div>

    <div class="cal-grid">
      <div
        v-for="c in cells"
        :key="c.date"
        class="cal-cell"
        :class="{ out: !c.inMonth, today: c.date === todayStr, sel: c.date === selectedDate && !isMulti, legal: holidayType(c.date) === 'legal', workday: holidayType(c.date) === 'workday', multi: isMultiSel(c.date) }"
        @click="onCellClick(c)"
      >
        <span class="cal-day">{{ c.day }}</span>
        <div class="cal-lunar">{{ lunarLabel(c.date) }}</div>
        <div class="cal-dots">
          <i v-for="n in Math.min(dayEvents(c.date).length, 3)" :key="n" class="cal-dot" :class="{ more: dayEvents(c.date).length > 3 && n === 3 }"></i>
        </div>
      </div>
    </div>

    <div class="cal-events">
      <div class="cal-holiday">
        <div class="cal-holiday-head">
          <span class="cal-holiday-title"><i class="fas fa-sun"></i> 假期 / 节日</span>
          <span v-if="holidayOf(selectedDate)" class="cal-holiday-badge" :class="holidayType(selectedDate)">
            {{ holidayOf(selectedDate)?.name }} · {{ typeLabel[holidayType(selectedDate)] ?? '假期' }}
          </span>
          <span v-else class="cal-holiday-none">当天无假期</span>
        </div>
        <div class="cal-holiday-info">
          <span>农历：{{ lunarFull(selectedDate) }}</span>
          <span v-if="festivalsOf(selectedDate).length" class="cal-holiday-festival">{{ festivalsOf(selectedDate).join(' / ') }}</span>
        </div>
        <div class="cal-holiday-actions">
          <input v-model="holidayName" class="cal-holiday-input" placeholder="假期名称（如 国庆节）" maxlength="20" @keyup.enter="setHoliday('legal')" />
          <button class="cal-holiday-btn legal" @click="setHoliday('legal')"><i class="fas fa-sun"></i> 设为法定假期</button>
          <button class="cal-holiday-btn workday" @click="setHoliday('workday')"><i class="fas fa-briefcase"></i> 设为补班</button>
          <button v-if="holidayOf(selectedDate)" class="cal-holiday-btn clear" @click="clearHoliday"><i class="fas fa-trash"></i> 取消</button>
        </div>
      </div>

      <div class="cal-events-head">
        <span>日程（{{ selectedDate }}）</span>
        <span v-if="dayEvents(selectedDate).length" class="cal-events-count">{{ dayEvents(selectedDate).length }} 条</span>
      </div>
      <div v-if="dayEvents(selectedDate).length" class="cal-events-list">
        <div v-for="(t, i) in dayEvents(selectedDate)" :key="i" class="cal-ev">
          <span class="cal-ev-dot"></span>
          <span class="cal-ev-title">{{ t }}</span>
          <button class="cal-ev-del" title="删除" @click="delEvent(selectedDate, i)"><i class="fas fa-times"></i></button>
        </div>
      </div>
      <div v-else class="cal-ev-empty">当天暂无日程，添加一条吧～</div>
      <div class="cal-ev-add">
        <input v-model="newEventTitle" class="cal-ev-input" placeholder="添加日程，回车保存" maxlength="80" @keyup.enter="addEvent" />
        <button class="dt-btn dt-btn-primary cal-ev-btn" :disabled="!newEventTitle.trim()" @click="addEvent">添加</button>
      </div>
    </div>
  </section>
</template>

<style scoped>
.cal-panel {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  position: relative;
  overflow-y: auto;
}
.cal-panel::before {
  content: '';
  position: fixed;
  inset: 0;
  z-index: -1;
  background: url('../assets/img/calendar-bg.jpg') center/cover no-repeat;
  opacity: 0.3;
  pointer-events: none;
}

.cal-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px 8px;
}
.cal-ops { display: flex; align-items: center; gap: 8px; }
.cal-op-btn {
  height: 30px; padding: 0 12px; border-radius: 8px; font-size: 13px; color: var(--dt-text-2);
  border: 1px solid var(--dt-border-light); background: #fff;
  display: inline-flex; align-items: center; gap: 5px;
}
.cal-op-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.cal-op-btn.active { background: var(--dt-primary); border-color: var(--dt-primary); color: #fff; }

.cal-multi-bar {
  display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
  margin: 0 20px 8px; padding: 8px 12px; border-radius: 10px;
  background: #e8f3ff; border: 1px solid #b8d9ff;
}
.cal-multi-count { font-size: 13px; font-weight: 700; color: var(--dt-primary); display: flex; align-items: center; gap: 6px; }
.cal-multi-input {
  height: 28px; border: 1px solid var(--dt-border); border-radius: 8px;
  padding: 0 10px; font-size: 12px; color: var(--dt-text); outline: none; background: #fff; min-width: 160px;
}
.cal-multi-input:focus { border-color: var(--dt-primary); }
.cal-multi-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; font-size: 12px;
  display: inline-flex; align-items: center; gap: 5px; border: 1px solid var(--dt-border-light); background: #fff; color: var(--dt-text-2);
}
.cal-multi-btn.legal:hover { color: #d92b3a; border-color: #ff5f6d; background: #fff2f3; }
.cal-multi-btn.workday:hover { color: #d46b08; border-color: #ffa940; background: #fff7e6; }
.cal-multi-btn.clear:hover { color: var(--dt-danger); border-color: var(--dt-danger); background: #fff0f0; }
.cal-multi-btn.exit { color: var(--dt-text-3); }
.cal-multi-btn.exit:hover { color: var(--dt-text); border-color: var(--dt-text-3); }
.cal-nav { display: flex; align-items: center; gap: 8px; }
.cal-nav-btn {
  height: 30px; padding: 0 12px; border-radius: 8px;
  font-size: 13px; color: var(--dt-text-2);
  border: 1px solid var(--dt-border-light); background: #fff;
  display: inline-flex; align-items: center; gap: 4px;
}
.cal-nav-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.cal-ym { font-size: 18px; font-weight: 700; color: var(--dt-text); }

.cal-week {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  padding: 4px 20px 6px;
}
.cal-week span {
  text-align: center; font-size: 13px; color: var(--dt-text-3);
  font-weight: 600;
}

.cal-grid {
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 6px;
  padding: 0 20px;
  flex: 1;
}
.cal-cell {
  position: relative;
  min-height: 62px;
  border-radius: 10px;
  border: 1px solid var(--dt-border-light);
  background: rgba(255, 255, 255, 0.72);
  padding: 5px 8px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
}
.cal-cell:hover { background: #fff; transform: translateY(-1px); }
.cal-cell.out { opacity: 0.4; }
.cal-cell.today { border-color: var(--dt-primary); box-shadow: 0 0 0 1px var(--dt-primary); }
.cal-cell.sel { background: #e8f3ff; border-color: var(--dt-primary); }
.cal-cell.multi { background: #dbeefe; border-color: var(--dt-primary); box-shadow: 0 0 0 2px rgba(22, 119, 255, 0.35); }
.cal-cell.multi .cal-day { color: var(--dt-primary); font-weight: 800; }
.cal-cell.legal { border-color: #ff5f6d; background: rgba(255, 95, 109, 0.08); }
.cal-cell.legal .cal-day { color: #d92b3a; }
.cal-cell.workday { border-color: #ffa940; background: rgba(255, 169, 64, 0.08); }
.cal-cell.workday .cal-day { color: #d46b08; }
.cal-day { font-size: 15px; font-weight: 600; color: var(--dt-text); }
.cal-cell.today .cal-day { color: var(--dt-primary); }
.cal-lunar {
  font-size: 11px; line-height: 1; color: var(--dt-text-3);
  margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.cal-cell.legal .cal-lunar { color: #d92b3a; }
.cal-cell.workday .cal-lunar { color: #d46b08; }
.cal-dots { display: flex; gap: 4px; margin-top: 6px; }
.cal-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: #8ec9ff;
}
.cal-dot.more { background: #1677ff; }

.cal-events {
  margin: 12px 20px 16px;
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.92);
  border: 1px solid var(--dt-border-light);
  padding: 12px 16px;
}
.cal-holiday {
  border: 1px dashed #f3d19b;
  background: #fffdf5;
  border-radius: 10px;
  padding: 10px 12px;
  margin-bottom: 12px;
}
.cal-holiday-head { display: flex; align-items: center; gap: 8px; }
.cal-holiday-title { font-size: 13px; font-weight: 600; color: var(--dt-text); display: flex; align-items: center; gap: 6px; }
.cal-holiday-badge {
  font-size: 12px; padding: 1px 8px; border-radius: 20px; font-weight: 600;
}
.cal-holiday-badge.legal { background: #ffe3e6; color: #d92b3a; }
.cal-holiday-badge.workday { background: #fff1d6; color: #d46b08; }
.cal-holiday-badge.custom { background: #e8f3ff; color: var(--dt-primary); }
.cal-holiday-none { font-size: 12px; color: var(--dt-text-4); }
.cal-holiday-info { display: flex; align-items: center; gap: 12px; margin-top: 6px; font-size: 12px; color: var(--dt-text-3); }
.cal-holiday-festival { color: #d92b3a; font-weight: 600; }
.cal-holiday-actions { display: flex; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
.cal-holiday-input {
  height: 30px; border: 1px solid var(--dt-border); border-radius: 8px;
  padding: 0 10px; font-size: 12px; color: var(--dt-text); outline: none; background: #fff; min-width: 140px;
}
.cal-holiday-input:focus { border-color: var(--dt-primary); }
.cal-holiday-btn {
  height: 30px; padding: 0 12px; border-radius: 8px; font-size: 12px;
  display: inline-flex; align-items: center; gap: 5px; color: var(--dt-text-2); border: 1px solid var(--dt-border-light); background: #fff;
}
.cal-holiday-btn.legal:hover { color: #d92b3a; border-color: #ff5f6d; background: #fff2f3; }
.cal-holiday-btn.workday:hover { color: #d46b08; border-color: #ffa940; background: #fff7e6; }
.cal-holiday-btn.clear:hover { color: var(--dt-danger); border-color: var(--dt-danger); background: #fff0f0; }
.cal-events-head { font-size: 14px; font-weight: 600; color: var(--dt-text); display: flex; align-items: center; gap: 8px; }
.cal-events-count { font-size: 12px; color: var(--dt-text-3); font-weight: 400; }
.cal-events-list { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; max-height: 120px; overflow-y: auto; }
.cal-ev {
  display: flex; align-items: center; gap: 8px;
  padding: 7px 10px; border-radius: 8px; background: var(--dt-bg-app);
}
.cal-ev-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff9db3; flex-shrink: 0; }
.cal-ev-title { flex: 1; font-size: 13px; color: var(--dt-text-2); }
.cal-ev-del {
  width: 22px; height: 22px; border-radius: 6px; color: var(--dt-text-4);
  display: inline-flex; align-items: center; justify-content: center; font-size: 12px;
}
.cal-ev-del:hover { color: var(--dt-danger); background: #fff0f0; }
.cal-ev-empty { font-size: 13px; color: var(--dt-text-4); margin-top: 10px; }
.cal-ev-add { display: flex; gap: 8px; margin-top: 10px; }
.cal-ev-input {
  flex: 1; height: 34px; border: 1px solid var(--dt-border); border-radius: 8px;
  padding: 0 12px; font-size: 13px; color: var(--dt-text); outline: none; background: #fff;
}
.cal-ev-input:focus { border-color: var(--dt-primary); }
.cal-ev-btn { height: 34px; padding: 0 16px; }
.cal-ev-btn:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
