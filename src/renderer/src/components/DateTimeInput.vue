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
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  border-radius: 10px;
  border: 1px solid var(--dt-border-light);
  font-family: var(--dt-font);
  overflow: hidden;
}
:global(.flatpickr-day.selected),
:global(.flatpickr-day.selected:hover) {
  background: var(--dt-primary);
  border-color: var(--dt-primary);
}
:global(.flatpickr-confirm) {
  color: var(--dt-primary);
  font-weight: 600;
  border-top: 1px solid var(--dt-border-light);
}
:global(.flatpickr-confirm:hover) {
  background: var(--dt-active);
}
:global(.flatpickr-clear) {
  color: var(--dt-danger);
}
</style>
