<script setup lang="ts">
import { ref } from 'vue'
import AttendanceView from './AttendanceView.vue'
import ProxyView from './ProxyView.vue'

const tab = ref<'attendance' | 'proxy'>('attendance')
</script>

<template>
  <div class="apply-home">
    <div class="ah-tabs">
      <button :class="{ on: tab === 'attendance' }" @click="tab = 'attendance'"><i class="fas fa-calendar-check"></i> 考勤申请</button>
      <button :class="{ on: tab === 'proxy' }" @click="tab = 'proxy'"><i class="fas fa-globe"></i> 网络申请</button>
    </div>
    <div class="ah-body">
      <AttendanceView v-show="tab === 'attendance'" />
      <ProxyView v-show="tab === 'proxy'" />
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
