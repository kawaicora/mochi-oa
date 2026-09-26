<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue'
import { Lunar } from 'lunar-javascript'
import { useAppStore } from '../stores/app'

const app = useAppStore()
const STORE_KEY = 'mochi_calendar_events'
const pad = (n: number) => String(n).padStart(2, '0')
const today = new Date()
const todayStr = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`
const weekNames = ['日', '一', '二', '三', '四', '五', '六']
const weekday = `星期${weekNames[today.getDay()]}`
const todayLabel = `${today.getFullYear()} 年 ${today.getMonth() + 1} 月 ${today.getDate()} 日`

const todayLunar = (() => {
  const l = Lunar.fromDate(today)
  return `${l.getYearInChinese()}年${l.getMonthInChinese()}月${l.getDayInChinese()}`
})()
const todayFestival = (() => {
  const l = Lunar.fromDate(today)
  return [...(l.getFestivals() ?? []), ...(l.getOtherFestivals() ?? [])][0] ?? ''
})()

const todayHoliday = ref<{ name: string; type: string } | null>(null)
async function loadHolidays(): Promise<void> {
  const list = await app.fetchHolidays()
  const hit = list.find((h) => h.date === todayStr)
  todayHoliday.value = hit ? { name: hit.name, type: hit.type } : null
}
let offHolidays: (() => void) | null = null
onMounted(async () => {
  await loadHolidays()
  offHolidays = window.pantry.onHolidaysUpdated(() => void loadHolidays())
})
onUnmounted(() => {
  offHolidays?.()
  offHolidays = null
})

function load(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {}
  } catch {
    return {}
  }
}
const allEvents = load()
const todayEvents = allEvents[todayStr] ?? []
const monthKey = todayStr.slice(0, 7)
const monthCount = computed(() =>
  Object.entries(allEvents).reduce((s, [date, list]) => (date.startsWith(monthKey) ? s + list.length : s), 0)
)
</script>

<template>
  <section class="cal-side">
    <div class="cal-side-hero">
      <div class="cal-side-overlay"></div>
      <div class="cal-side-date">
        <span class="cal-side-day">{{ today.getDate() }}</span>
        <div class="cal-side-yw">
          <span class="cal-side-ym">{{ today.getFullYear() }} 年 {{ today.getMonth() + 1 }} 月</span>
          <span class="cal-side-wd">{{ weekday }}</span>
        </div>
      </div>
    </div>

    <div class="cal-side-section">
      <div class="cal-side-title"><i class="fas fa-moon"></i> 今日农历</div>
      <div class="cal-side-lunar">{{ todayLunar }}</div>
      <div class="cal-side-lunar-sub">
        <span v-if="todayFestival" class="cal-side-festival">{{ todayFestival }}</span>
        <span v-else>节气 / 平日</span>
        <span v-if="todayHoliday" class="cal-side-hd" :class="todayHoliday.type">{{ todayHoliday.name }} · {{ todayHoliday.type === 'legal' ? '法定假期' : todayHoliday.type === 'workday' ? '调休补班' : '自定义' }}</span>
      </div>
    </div>

    <div class="cal-side-section">
      <div class="cal-side-title"><i class="far fa-calendar-check"></i> 今日日程</div>
      <div v-if="todayEvents.length" class="cal-side-list">
        <div v-for="(t, i) in todayEvents" :key="i" class="cal-side-item">
          <span class="cal-side-dot"></span>
          <span class="cal-side-text">{{ t }}</span>
        </div>
      </div>
      <div v-else class="cal-side-empty">今天还没有日程</div>
    </div>

    <div class="cal-side-section">
      <div class="cal-side-title"><i class="fas fa-list-ul"></i> 本月概览</div>
      <div class="cal-side-stat">
        <div class="cal-side-stat-num">{{ monthCount }}</div>
        <div class="cal-side-stat-label">条日程（{{ monthKey }}-*）</div>
      </div>
    </div>

    <div class="cal-side-tip">
      <i class="far fa-smile"></i> 在右侧日历点击日期即可添加日程
    </div>
  </section>
</template>

<style scoped>
.cal-side {
  width: 240px;
  flex-shrink: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid var(--dt-border-light);
  overflow-y: auto;
}
.cal-side-hero {
  position: relative;
  height: 150px;
  background: url('../assets/img/calendar-side.jpg') center/cover no-repeat;
  flex-shrink: 0;
}
.cal-side-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(180deg, rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.35));
}
.cal-side-date {
  position: absolute;
  left: 16px;
  bottom: 14px;
  display: flex;
  align-items: flex-end;
  gap: 12px;
  color: #fff;
}
.cal-side-day { font-size: 44px; font-weight: 800; line-height: 1; text-shadow: 0 2px 8px rgba(0, 0, 0, 0.3); }
.cal-side-yw { display: flex; flex-direction: column; }
.cal-side-ym { font-size: 14px; font-weight: 600; }
.cal-side-wd { font-size: 12px; opacity: 0.9; }
.cal-side-section { padding: 14px; border-bottom: 1px solid var(--dt-border-light); }
.cal-side-lunar { font-size: 18px; font-weight: 700; color: var(--dt-text); }
.cal-side-lunar-sub { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--dt-text-3); flex-wrap: wrap; }
.cal-side-festival { color: #d92b3a; font-weight: 600; }
.cal-side-hd { padding: 1px 8px; border-radius: 20px; font-weight: 600; }
.cal-side-hd.legal { background: #ffe3e6; color: #d92b3a; }
.cal-side-hd.workday { background: #fff1d6; color: #d46b08; }
.cal-side-hd.custom { background: #e8f3ff; color: var(--dt-primary); }
.cal-side-title { font-size: 14px; font-weight: 600; color: var(--dt-text); display: flex; align-items: center; gap: 6px; margin-bottom: 10px; }
.cal-side-list { display: flex; flex-direction: column; gap: 8px; }
.cal-side-item { display: flex; align-items: flex-start; gap: 8px; }
.cal-side-dot { width: 8px; height: 8px; border-radius: 50%; background: #ff9db3; margin-top: 4px; flex-shrink: 0; }
.cal-side-text { font-size: 13px; color: var(--dt-text-2); line-height: 1.5; }
.cal-side-empty { font-size: 13px; color: var(--dt-text-4); }
.cal-side-stat { text-align: center; padding: 8px 0 4px; }
.cal-side-stat-num { font-size: 30px; font-weight: 800; color: var(--dt-primary); }
.cal-side-stat-label { font-size: 12px; color: var(--dt-text-3); margin-top: 2px; }
.cal-side-tip { padding: 14px; font-size: 12px; color: var(--dt-text-4); display: flex; align-items: center; gap: 6px; }
</style>
