<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import flatpickr from 'flatpickr'
import type { Instance } from 'flatpickr/dist/types/instance'
import 'flatpickr/dist/flatpickr.css'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import confirmDatePlugin from 'flatpickr/dist/plugins/confirmDate/confirmDate.js'

/**
 * 通用日期/时间选择器（公共基础件，基于 flatpickr 封装）。
 * 报表周期、考勤时间、任务时间等所有日期场景统一引用本组件。
 * props:
 *   modelValue  值字符串（time=true → 'YYYY-MM-DDTHH:mm'；否则 'YYYY-MM-DD'）
 *   time        true 选择到时间（默认 true）；false 仅日期
 *   placeholder 占位提示
 *   min/max     禁选范围边界（'YYYY-MM-DD' 或 Date），早于 min / 晚于 max 的日期不可选
 *   clearable   是否显示"清除"按钮（confirmDate 插件自带，默认 true）
 * events:
 *   update:modelValue  值变化
 *   change            选中时抛出 (selectedDates, dateStr)
 */
const props = withDefaults(
  defineProps<{
    modelValue?: string
    time?: boolean
    placeholder?: string
    min?: string | Date
    max?: string | Date
    clearable?: boolean
  }>(),
  { time: true, clearable: true }
)
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
  (e: 'change', selectedDates: Date[], dateStr: string): void
}>()

const el = ref<HTMLInputElement | null>(null)
let fp: Instance | null = null

onMounted(() => {
  if (!el.value) return
  const opts: any = {
    enableTime: props.time,
    dateFormat: props.time ? 'Y-m-dTH:i' : 'Y-m-d',
    time_24hr: true,
    minuteIncrement: 1,
    closeOnSelect: false,
    // 禁选范围
    minDate: props.min || undefined,
    maxDate: props.max || undefined,
    plugins: [
      confirmDatePlugin({
        confirmText: '确认',
        clearText: '清除',
        showAlways: false
      } as any)
    ],
    onChange: (selectedDates: Date[], dateStr: string) => {
      emit('update:modelValue', dateStr)
      emit('change', selectedDates, dateStr)
    }
  }
  fp = flatpickr(el.value, opts)
  if (props.modelValue) {
    try { fp.setDate(props.modelValue, false) } catch { /* 忽略非法值 */ }
  }
})

watch(
  () => props.modelValue,
  (v) => {
    if (fp) {
      try { fp.setDate(v ?? '', false) } catch { /* 忽略 */ }
    }
  }
)
// 禁选范围动态变化时同步
watch(
  () => [props.min, props.max],
  ([mn, mx]) => {
    if (!fp) return
    try {
      fp.set('minDate', (mn as string) || undefined)
      fp.set('maxDate', (mx as string) || undefined)
    } catch (e) { console.error('[DateTimePicker] 禁选范围更新失败', e) }
  }
)

onBeforeUnmount(() => {
  fp?.destroy()
  fp = null
})
</script>

<template>
  <input ref="el" class="srv-input" :placeholder="placeholder || (time ? '选择时间' : '选择日期')" readonly />
</template>


<style scoped>
:global(.flatpickr-calendar) {
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.18);
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  font-size: 13px;
  font-family: inherit;
  /* 加宽到内容完整显示（周几/7列网格/时间列不截断） */
  width: 320px;
  min-width: 320px;
  overflow: visible;
  background: #fff;
}
:global(.flatpickr-calendar.arrowTop:before) { border-bottom-color: #e5e7eb; }
:global(.flatpickr-calendar.arrowTop:after) { border-bottom-color: #fff; }
:global(.flatpickr-months) { padding: 12px 14px 2px; }
:global(.flatpickr-current-month) { font-size: 14px; font-weight: 700; color: #1f2937; }
:global(.flatpickr-current-month .cur-month:hover) { background: transparent; }
:global(.flatpickr-monthDropdown-months) { font-size: 14px; font-weight: 700; color: #1f2937; }
:global(.flatpickr-prev-month), :global(.flatpickr-next-month) { border-radius: 6px; top: 12px; }
:global(.flatpickr-prev-month:hover), :global(.flatpickr-next-month:hover) { background: #f3f4f6; color: var(--dt-primary); }
:global(.flatpickr-weekdays) { padding: 6px 12px 2px; }
:global(.flatpickr-weekday) { color: #6b7280; font-size: 11px; font-weight: 600; padding: 0 2px; }
:global(.flatpickr-days) { padding: 2px 12px 8px; }
:global(.flatpickr-day) {
  border: none;
  border-radius: 8px;
  color: #374151;
  line-height: 36px;
  height: 36px;
  max-width: 36px;
  margin: 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
}
:global(.flatpickr-day:hover) { background: #eef2ff; color: var(--dt-primary); }
:global(.flatpickr-day.selected), :global(.flatpickr-day.selected:hover) {
  background: var(--dt-primary);
  color: #fff;
  box-shadow: 0 2px 8px rgba(22, 119, 255, 0.35);
  font-weight: 600;
}
:global(.flatpickr-day.today) { border: 1px solid var(--dt-primary); color: var(--dt-primary); }
:global(.flatpickr-day.today.selected) { color: #fff; }
:global(.flatpickr-day.prevMonthDay), :global(.flatpickr-day.nextMonthDay) { color: #d1d5db; }
:global(.flatpickr-day.flatpickr-disabled), :global(.flatpickr-day.notAllowed) { color: #e5e7eb; cursor: not-allowed; }
:global(.flatpickr-time) { border-top: 1px solid #f3f4f6; padding: 10px; }
:global(.flatpickr-time input) { font-size: 13px; color: #374151; border-radius: 6px; }
:global(.flatpickr-time input:hover), :global(.flatpickr-time input:focus) { background: #f9fafb; }
:global(.flatpickr-time .flatpickr-am-pm) { font-weight: 600; color: #6b7280; }
:global(.flatpickr-confirm) {
  color: var(--dt-primary);
  font-weight: 700;
  border-top: 1px solid #f3f4f6;
  padding: 11px 0;
  cursor: pointer;
  text-align: center;
  transition: background 0.15s;
}
:global(.flatpickr-confirm:hover) { background: #eef2ff; }
:global(.flatpickr-clear) { color: #dc2626; font-weight: 600; }
:global(.flatpickr-clear:hover) { background: #fef2f2; }
</style>
