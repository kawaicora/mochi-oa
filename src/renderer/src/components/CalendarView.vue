<script setup lang="ts">
import { ref, computed } from 'vue'

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
    </div>

    <div class="cal-week">
      <span v-for="w in ['日', '一', '二', '三', '四', '五', '六']" :key="w">{{ w }}</span>
    </div>

    <div class="cal-grid">
      <div
        v-for="c in cells"
        :key="c.date"
        class="cal-cell"
        :class="{ out: !c.inMonth, today: c.date === todayStr, sel: c.date === selectedDate }"
        @click="selectedDate = c.date"
      >
        <span class="cal-day">{{ c.day }}</span>
        <div class="cal-dots">
          <i v-for="n in Math.min(dayEvents(c.date).length, 3)" :key="n" class="cal-dot" :class="{ more: dayEvents(c.date).length > 3 && n === 3 }"></i>
        </div>
      </div>
    </div>

    <div class="cal-events">
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
  min-height: 58px;
  border-radius: 10px;
  border: 1px solid var(--dt-border-light);
  background: rgba(255, 255, 255, 0.72);
  padding: 6px 8px;
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, transform 0.12s;
}
.cal-cell:hover { background: #fff; transform: translateY(-1px); }
.cal-cell.out { opacity: 0.4; }
.cal-cell.today { border-color: var(--dt-primary); box-shadow: 0 0 0 1px var(--dt-primary); }
.cal-cell.sel { background: #e8f3ff; border-color: var(--dt-primary); }
.cal-day { font-size: 15px; font-weight: 600; color: var(--dt-text); }
.cal-cell.today .cal-day { color: var(--dt-primary); }
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
