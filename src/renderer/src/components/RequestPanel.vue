<script setup lang="ts">
import { computed } from 'vue'
import type { RequestPanelItem, RequestPanelButton } from '../stores/app'

const props = defineProps<{ item: RequestPanelItem }>()
const emit = defineEmits<{ (e: 'select', index: number): void }>()

const icon = computed(() => {
  switch (props.item.kind) {
    case 'friend':
      return 'fas fa-user-plus'
    case 'groupInvite':
      return 'fas fa-users'
    case 'companyInvite':
      return 'fas fa-building'
    default:
      return 'far fa-envelope'
  }
})

function btnClass(btn: RequestPanelButton): string {
  const base = 'rp-btn'
  if (btn.role === 'primary') return `${base} rp-primary`
  if (btn.role === 'danger') return `${base} rp-danger`
  return base
}

function select(index: number): void {
  emit('select', index)
}
</script>

<template>
  <div class="rp-mask" @click.self>
    <div class="rp-card" role="dialog" aria-modal="true">
      <div class="rp-head">
        <i :class="icon"></i>
        <span class="rp-title">{{ item.title }}</span>
      </div>
      <div class="rp-body">
        <p class="rp-text">{{ item.body }}</p>
      </div>
      <div class="rp-foot">
        <button
          v-for="(btn, i) in item.buttons"
          :key="i"
          :class="btnClass(btn)"
          @click="select(i)"
        >
          {{ btn.label }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.rp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.rp-card {
  width: 380px;
  max-width: calc(100vw - 40px);
  background: #fff;
  border-radius: 12px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.18);
  overflow: hidden;
}
.rp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--dt-border-light, #eee);
  font-size: 15px;
  font-weight: 600;
  color: var(--dt-text);
}
.rp-head i { color: var(--dt-primary); width: 18px; text-align: center; }
.rp-body { padding: 18px 20px; }
.rp-text { margin: 0; font-size: 13px; color: var(--dt-text-2); line-height: 1.5; }
.rp-foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--dt-border-light, #eee);
}
.rp-btn {
  height: 36px;
  padding: 0 16px;
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid var(--dt-border, #e3e6eb);
  background: #fff;
  color: var(--dt-text-2);
  cursor: pointer;
}
.rp-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.rp-primary {
  background: var(--dt-primary);
  color: #fff;
  border-color: var(--dt-primary);
}
.rp-primary:hover { color: #fff; opacity: 0.9; }
.rp-danger {
  background: var(--dt-danger, #e34d59);
  color: #fff;
  border-color: var(--dt-danger, #e34d59);
}
.rp-danger:hover { color: #fff; opacity: 0.9; }
</style>
