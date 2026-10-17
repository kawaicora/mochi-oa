<script setup lang="ts">
import { computed } from 'vue'

/**
 * 通用月历网格（公共基础组件，未来可复用/可拖拉）。
 * 仅负责渲染星期头 + 7 列日期格；每格内容由调用方通过 #day 插槽自定义（如状态点）。
 * props: year / month(1-12) / today(YYYY-MM-DD，可选高亮)
 * emit: select(dateStr: 'YYYY-MM-DD')
 */
const props = defineProps<{
  year: number
  month: number // 1-12
  today?: string
}>()
const emit = defineEmits<{ (e: 'select', dateStr: string): void }>()

interface Cell { dateStr: string; day: number; inMonth: boolean; isToday: boolean }
const p = (n: number) => String(n).padStart(2, '0')
const cells = computed<Cell[]>(() => {
  const first = new Date(props.year, props.month - 1, 1)
  const startWeekday = first.getDay()
  const daysInMonth = new Date(props.year, props.month, 0).getDate()
  const out: Cell[] = []
  for (let i = 0; i < startWeekday; i++) out.push({ dateStr: '', day: 0, inMonth: false, isToday: false })
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${props.year}-${p(props.month)}-${p(d)}`
    out.push({ dateStr: ds, day: d, inMonth: true, isToday: ds === props.today })
  }
  return out
})
function pick(c: Cell): void { if (c.inMonth) emit('select', c.dateStr) }
</script>

<template>
  <div class="cm">
    <div class="cm-week">
      <span v-for="w in ['日','一','二','三','四','五','六']" :key="w" class="cm-w">{{ w }}</span>
    </div>
    <div class="cm-grid">
      <div v-for="(c, i) in cells" :key="i" class="cm-cell" :class="{ empty: !c.inMonth, today: c.isToday }" @click="pick(c)">
        <span class="cm-day">{{ c.inMonth ? c.day : '' }}</span>
        <!-- 调用方插槽：自定义每格内容（状态点等），传入 dateStr -->
        <slot v-if="c.inMonth" :date="c.dateStr" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.cm-week, .cm-grid { display: grid; grid-template-columns: repeat(7, 1fr); }
.cm-w { text-align: center; font-size: 12px; color: var(--dt-text-3); padding: 4px 0; }
.cm-cell { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; height: 52px; border: 1px solid var(--dt-border-light); border-radius: 8px; margin: 2px; cursor: pointer; background: #fff; }
.cm-cell.empty { visibility: hidden; }
.cm-cell.today { background: #eef4ff; }
.cm-cell:hover { background: #f6f8fb; }
.cm-day { font-size: 13px; }
</style>
