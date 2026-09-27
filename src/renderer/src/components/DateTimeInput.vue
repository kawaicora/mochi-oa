<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import flatpickr from 'flatpickr'
import type { Instance } from 'flatpickr/dist/types/instance'
import 'flatpickr/dist/flatpickr.css'
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
import confirmDatePlugin from 'flatpickr/dist/plugins/confirmDate/confirmDate.js'

const props = defineProps<{
  /** 值格式：datetime → 'YYYY-MM-DDTHH:mm'；date → 'YYYY-MM-DD' */
  modelValue?: string
  /** true 选择到时间；false/省略 仅日期 */
  time?: boolean
  /** 占位提示 */
  placeholder?: string
}>()
const emit = defineEmits<{
  (e: 'update:modelValue', v: string): void
}>()

const el = ref<HTMLInputElement | null>(null)
let fp: Instance | null = null

onMounted(() => {
  if (!el.value) return
  fp = flatpickr(el.value, {
    enableTime: props.time !== false,
    dateFormat: props.time !== false ? 'Y-m-dTH:i' : 'Y-m-d',
    time_24hr: true,
    minuteIncrement: 1,
    closeOnSelect: false,
    plugins: [
      confirmDatePlugin({
        confirmText: '确认',
        clearText: '清除',
        showAlways: false
      } as any)
    ],
    onChange: (selectedDates, dateStr) => {
      emit('update:modelValue', dateStr)
    }
  })
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

onBeforeUnmount(() => {
  fp?.destroy()
  fp = null
})
</script>

<template>
  <input ref="el" class="srv-input" :placeholder="placeholder || (time !== false ? '选择时间' : '选择日期')" readonly />
</template>


<style scoped>
:global(.flatpickr-calendar) {
  box-shadow: 0 16px 48px rgba(15, 23, 42, 0.18);
  border-radius: 12px;
  border: 1px solid #e5e7eb;
  font-size: 13px;
  font-family: inherit;
  width: 284px;
  overflow: hidden;
  background: #fff;
}
:global(.flatpickr-calendar.arrowTop:before) { border-bottom-color: #e5e7eb; }
:global(.flatpickr-calendar.arrowTop:after) { border-bottom-color: #fff; }
:global(.flatpickr-months) { padding: 12px 10px 2px; }
:global(.flatpickr-current-month) { font-size: 14px; font-weight: 700; color: #1f2937; }
:global(.flatpickr-current-month .cur-month:hover) { background: transparent; }
:global(.flatpickr-monthDropdown-months) { font-size: 14px; font-weight: 700; color: #1f2937; }
:global(.flatpickr-prev-month), :global(.flatpickr-next-month) { border-radius: 6px; top: 12px; }
:global(.flatpickr-prev-month:hover), :global(.flatpickr-next-month:hover) { background: #f3f4f6; color: var(--dt-primary); }
:global(.flatpickr-weekdays) { padding: 6px 8px 2px; }
:global(.flatpickr-weekday) { color: #6b7280; font-size: 11px; font-weight: 600; }
:global(.flatpickr-days) { padding: 2px 8px 8px; }
:global(.flatpickr-day) {
  border: none;
  border-radius: 8px;
  color: #374151;
  line-height: 1;
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

