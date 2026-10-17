<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'

/**
 * 通用公司成员多选选择器（审批人/抄送人/报表接收人复用）。
 * 直接列出公司通讯录（app.members），支持按姓名搜索过滤。
 * v-model: number[]（已选 userId）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number[]
    placeholder?: string
    /** 最多可选人数，0=不限 */
    max?: number
    /** 是否显示搜索框（默认 true） */
    showSearch?: boolean
  }>(),
  { placeholder: '选择成员', max: 0, showSearch: true }
)
const emit = defineEmits<{ (e: 'update:modelValue', ids: number[]): void }>()

const app = useAppStore()
const open = ref(false)
const keyword = ref('')

// 成员列表（按搜索过滤）
const list = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  const ms = app.members
  if (!kw) return ms
  return ms.filter((m) => (m.nick || m.username).toLowerCase().includes(kw))
})

// 已选成员展示名
const selectedNames = computed(() =>
  props.modelValue
    .map((id) => app.members.find((m) => m.userId === id))
    .filter(Boolean)
    .map((m) => m!.nick || m!.username)
)

function toggle(userId: number): void {
  const i = props.modelValue.indexOf(userId)
  if (i >= 0) {
    emit('update:modelValue', props.modelValue.filter((x) => x !== userId))
  } else {
    // 达上限则不再追加
    if (props.max > 0 && props.modelValue.length >= props.max) return
    emit('update:modelValue', [...props.modelValue, userId])
  }
}
function isSel(userId: number): boolean { return props.modelValue.includes(userId) }
</script>

<template>
  <div class="mp">
    <button class="mp-trigger" @click="open = !open">
      <i class="fas fa-user-check"></i>
      <span v-if="!selectedNames.length" class="mp-ph">{{ placeholder }}</span>
      <span v-else class="mp-tags">
        <span v-for="n in selectedNames" :key="n" class="mp-tag">{{ n }}</span>
      </span>
      <i class="fas fa-chevron-down mp-caret"></i>
    </button>
    <div v-if="open" class="mp-panel">
      <input v-if="showSearch" v-model="keyword" class="srv-input mp-search" placeholder="搜索姓名…" />
      <div class="mp-list">
        <label v-for="m in list" :key="m.userId" class="mp-item">
          <input type="checkbox" :checked="isSel(m.userId)" @change="toggle(m.userId)" />
          <span>{{ m.nick || m.username }}</span>
        </label>
        <div v-if="!list.length" class="mp-empty">无成员</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp { position: relative; display: inline-block; min-width: 200px; }
.mp-trigger { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dt-border-light); background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 13px; cursor: pointer; max-width: 100%; }
.mp-ph { color: var(--dt-text-4); }
.mp-caret { margin-left: 4px; font-size: 11px; color: var(--dt-text-4); }
.mp-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.mp-tag { background: #eef4ff; color: var(--dt-primary); padding: 1px 8px; border-radius: 20px; font-size: 12px; }
.mp-panel { position: absolute; z-index: 30; top: calc(100% + 4px); left: 0; min-width: 240px; max-height: 260px; display: flex; flex-direction: column; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,.12); padding: 6px; }
.mp-search { margin-bottom: 6px; }
.mp-list { overflow: auto; }
.mp-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 13px; cursor: pointer; border-radius: 6px; }
.mp-item:hover { background: #f6f8fb; }
.mp-empty { color: var(--dt-text-4); text-align: center; padding: 16px 0; font-size: 12px; }
</style>
