<script setup lang="ts">
defineProps<{ title: string; icon: string; mode: 'nav' | 'content' }>()
</script>

<template>
  <div v-if="mode === 'nav'" class="ph-nav">
    <div class="ph-sub"><i :class="icon"></i> {{ title }}</div>
    <div class="ph-hint">该模块建设中</div>
  </div>
  <div v-else class="ph-content">
    <div class="ph-big"><i :class="icon"></i></div>
    <div class="ph-text">{{ title }}功能即将上线</div>
  </div>
</template>

<style scoped>
.ph-nav { width: 230px; height: 100%; flex-shrink: 0; background: #fff; border-right: 1px solid var(--dt-border-light); padding: 14px; display: flex; flex-direction: column; gap: 12px; }
.ph-sub { font-size: 15px; font-weight: 600; display: flex; align-items: center; gap: 8px; color: var(--dt-text); }
.ph-hint { font-size: 12px; color: var(--dt-text-4); }
.ph-content { width: 100%; height: 100%; background: var(--dt-bg-app); display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; color: var(--dt-text-4); }
.ph-big { width: 56px; height: 56px; border-radius: 14px; background: var(--dt-bg-hover); display: flex; align-items: center; justify-content: center; font-size: 26px; }
.ph-text { font-size: 14px; }
</style>
