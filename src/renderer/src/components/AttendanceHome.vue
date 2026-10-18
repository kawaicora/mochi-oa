<script setup lang="ts">
import { ref } from 'vue'
import CheckinView from './CheckinView.vue'
import AttendanceView from './AttendanceView.vue'

/**
 * 考勤主页：拆两个子页签
 *  - 打卡（CheckinView，默认）：月历 + 状态点 + 圆形打卡按钮
 *  - 申请（AttendanceView）：补卡/请假/调休 + 审批 + 流程设置
 */
const sub = ref<'checkin' | 'apply'>('checkin')
</script>

<template>
  <div class="ah">
    <div class="ah-tabs">
      <button :class="{ on: sub === 'checkin' }" @click="sub = 'checkin'">
        <i class="fas fa-user-clock"></i> 打卡
      </button>
      <button :class="{ on: sub === 'apply' }" @click="sub = 'apply'">
        <i class="fas fa-edit"></i> 申请
      </button>
    </div>
    <div class="ah-body">
      <CheckinView v-if="sub === 'checkin'" />
      <AttendanceView v-else />
    </div>
  </div>
</template>

<style scoped>
.ah { flex: 1; width: 100%; display: flex; flex-direction: column; overflow: hidden; }
.ah-tabs { display: flex; gap: 4px; padding: 8px 18px 0; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.ah-tabs button { border: none; background: transparent; padding: 8px 14px; font-size: 14px; cursor: pointer; color: var(--dt-text-3); border-bottom: 2px solid transparent; }
.ah-tabs button.on { color: var(--dt-primary); font-weight: 700; border-bottom-color: var(--dt-primary); }
.ah-body { flex: 1; overflow: hidden; display: flex; flex-direction: column; }
</style>
