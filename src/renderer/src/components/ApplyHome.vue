<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import AttendanceView from './AttendanceView.vue'
import ProxyView from './ProxyView.vue'
import ExpenseView from './ExpenseView.vue'
import AdvanceView from './AdvanceView.vue'
import { proxyDeepLinkId } from '../utils/proxy-deeplink'
import { expenseDeepLinkId } from '../utils/expense-deeplink'
import { advanceDeepLinkId } from '../utils/advance-deeplink'
import { attendanceDeepLinkId } from '../utils/attendance-deeplink'

type ApplyTab = 'attendance' | 'proxy' | 'expense' | 'advance'

// 深链联动：消息卡片点击会 dispatch 'apply' 并置好对应 deepLinkId。
// 在 setup（渲染前）根据哪个 deepLinkId 有值决定内层 tab，
// 这样 ExpenseView/AdvanceView/ProxyView mount 时即落在正确分组，再自行定位高亮。
const initialTab = ((): ApplyTab => {
  if (attendanceDeepLinkId.value != null) return 'attendance'
  if (expenseDeepLinkId.value != null) return 'expense'
  if (advanceDeepLinkId.value != null) return 'advance'
  if (proxyDeepLinkId.value != null) return 'proxy'
  return 'attendance'
})()
const tab = ref<ApplyTab>(initialTab)

// 打卡页异常日期 → 补卡/请假：切到考勤申请 tab（AttendanceView 收到 openApply 事件后自行预填）。
function onOpenApply(e: Event): void {
  const d = (e as CustomEvent).detail
  if (d && (d.type === 'make_up' || d.type === 'leave')) tab.value = 'attendance'
}
onMounted(() => window.addEventListener('mochi:attendance:openApply', onOpenApply))
onBeforeUnmount(() => window.removeEventListener('mochi:attendance:openApply', onOpenApply))
</script>

<template>
  <div class="apply-home">
    <div class="ah-tabs">
      <button :class="{ on: tab === 'attendance' }" @click="tab = 'attendance'"><i class="fas fa-calendar-check"></i> 考勤申请</button>
      <button :class="{ on: tab === 'proxy' }" @click="tab = 'proxy'"><i class="fas fa-globe"></i> 网络申请</button>
      <button :class="{ on: tab === 'expense' }" @click="tab = 'expense'"><i class="fas fa-receipt"></i> 报销申请</button>
      <button :class="{ on: tab === 'advance' }" @click="tab = 'advance'"><i class="fas fa-hand-holding-usd"></i> 备用金申请</button>
    </div>
    <div class="ah-body">
      <AttendanceView v-show="tab === 'attendance'" />
      <ProxyView v-show="tab === 'proxy'" />
      <ExpenseView v-show="tab === 'expense'" />
      <AdvanceView v-show="tab === 'advance'" />
    </div>
  </div>
</template>

<style scoped>
.apply-home { display: flex; flex-direction: column; flex: 1; min-height: 0; width: 100%; background: #f8fafc; }
.ah-tabs { display: flex; gap: 4px; padding: 10px 16px 0; border-bottom: 1px solid #eef0f3; }
.ah-tabs button { border: none; background: transparent; padding: 9px 16px; cursor: pointer; font-size: 13px; color: #6b7280; border-bottom: 2px solid transparent; }
.ah-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.ah-body { flex: 1; min-height: 0; display: flex; flex-direction: column; }
</style>
