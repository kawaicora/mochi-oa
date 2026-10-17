<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAppStore } from '../../stores/app'
import type { OrgMember, Department } from '@shared/server-types'

/**
 * 通用公司成员多选选择器（审批人/抄送人/报表接收人复用）。
 * 交互：点触发按钮 → 弹出 modal → 按部门分组列出成员，未分组成员在「根」→ 勾选多选 → 确定回显。
 * v-model: number[]（已选 userId）。
 */
const props = withDefaults(
  defineProps<{
    modelValue: number[]
    placeholder?: string
    /** 最多可选人数，0=不限 */
    max?: number
  }>(),
  { placeholder: '选择成员', max: 0 }
)
const emit = defineEmits<{ (e: 'update:modelValue', ids: number[]): void }>()

const app = useAppStore()
const open = ref(false)
const keyword = ref('')
// 弹窗内的临时勾选（确定后才同步回 modelValue）
const tempSel = ref<number[]>([])
// 按部门分组后的成员：{ deptId: 0=根, name, members }
interface Group { deptId: number; name: string; members: OrgMember[] }
const groups = ref<Group[]>([])

// 触发按钮上的已选成员对象
const selectedMembers = computed(() =>
  props.modelValue
    .map((id) => app.members.find((m) => m.userId === id))
    .filter(Boolean) as OrgMember[]
)

// 打开弹窗 → 加载部门与分组
async function openModal(): Promise<void> {
  open.value = true
  tempSel.value = [...props.modelValue]
  await buildGroups()
}
// 按搜索关键字过滤后的分组
const filteredGroups = computed<Group[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return groups.value
  return groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => (m.nick || m.username).toLowerCase().includes(kw)) }))
    .filter((g) => g.members.length > 0)
})

/** 拉部门 → 每部门成员；未归属任何部门的成员归「根」 */
async function buildGroups(): Promise<void> {
  const depts: Department[] = app.departments || []
  const used = new Set<number>()
  const out: Group[] = []
  for (const d of depts) {
    try {
      const ms = await app.loadDepartmentMembers(d.id)
      if (ms.length) {
        out.push({ deptId: d.id, name: d.name, members: ms })
        ms.forEach((m) => used.add(m.userId))
      }
    } catch (e) {
      console.error('[选人] 加载部门成员失败', d.name, e)
    }
  }
  // 未分组成员 → 根
  const rootMembers = app.members.filter((m) => !used.has(m.userId))
  if (rootMembers.length) out.unshift({ deptId: 0, name: '根', members: rootMembers })
  groups.value = out
}

function toggle(userId: number): void {
  const i = tempSel.value.indexOf(userId)
  if (i >= 0) tempSel.value.splice(i, 1)
  else {
    if (props.max > 0 && tempSel.value.length >= props.max) return
    tempSel.value.push(userId)
  }
}
function isTempSel(userId: number): boolean { return tempSel.value.includes(userId) }

// 移除触发按钮上的已选
function remove(userId: number, ev: MouseEvent): void {
  ev.stopPropagation()
  emit('update:modelValue', props.modelValue.filter((x) => x !== userId))
}
// 确定 → 同步临时选择
function confirm(): void {
  emit('update:modelValue', [...tempSel.value])
  open.value = false
}
watch(open, (v) => { if (!v) keyword.value = '' })
</script>

<template>
  <div class="mp">
    <!-- 触发按钮：已选标签 + 数量 -->
    <button class="mp-trigger" @click="openModal">
      <i class="fas fa-user-check"></i>
      <span v-if="!selectedMembers.length" class="mp-ph">{{ placeholder }}</span>
      <span v-else class="mp-tags">
        <span v-for="m in selectedMembers" :key="m.userId" class="mp-tag">
          {{ m.nick || m.username }}
          <i class="mp-x" @click="remove(m.userId, $event)">×</i>
        </span>
      </span>
      <i v-if="selectedMembers.length" class="mp-count">{{ selectedMembers.length }}</i>
    </button>

    <!-- 弹窗：按部门分组多选 -->
    <div v-if="open" class="mp-mask" @click.self="open = false">
      <div class="mp-modal">
        <div class="mp-head">
          <span>选择成员</span>
          <input v-model="keyword" class="srv-input mp-search" placeholder="搜索姓名…" />
        </div>
        <div class="mp-body">
          <div v-if="!filteredGroups.length" class="mp-empty">无成员</div>
          <div v-for="g in filteredGroups" :key="g.deptId" class="mp-group">
            <div class="mp-gname">{{ g.name }}</div>
            <label v-for="m in g.members" :key="m.userId" class="mp-item">
              <input type="checkbox" :checked="isTempSel(m.userId)" @change="toggle(m.userId)" />
              <span>{{ m.nick || m.username }}</span>
            </label>
          </div>
        </div>
        <div class="mp-foot">
          <span class="mp-foot-count">已选 {{ tempSel.length }} 人</span>
          <button class="dt-btn" @click="open = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="confirm">确定</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mp { display: inline-block; }
.mp-trigger { display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--dt-border-light); background: #fff; border-radius: 8px; padding: 5px 10px; font-size: 13px; cursor: pointer; max-width: 100%; }
.mp-ph { color: var(--dt-text-4); }
.mp-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.mp-tag { display: inline-flex; align-items: center; gap: 4px; background: #eef4ff; color: var(--dt-primary); padding: 1px 8px; border-radius: 20px; font-size: 12px; }
.mp-x { cursor: pointer; font-style: normal; }
.mp-count { background: var(--dt-primary); color: #fff; border-radius: 20px; padding: 0 6px; font-size: 11px; }
.mp-mask { position: fixed; inset: 0; background: rgba(0,0,0,.4); display: flex; align-items: center; justify-content: center; z-index: 120; }
.mp-modal { width: 480px; max-height: 70vh; background: #fff; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; }
.mp-head { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--dt-border-light); font-weight: 700; }
.mp-search { width: 200px; height: 30px; }
.mp-body { flex: 1; overflow: auto; padding: 8px 14px; }
.mp-empty { color: var(--dt-text-4); text-align: center; padding: 20px 0; font-size: 13px; }
.mp-group { margin-bottom: 10px; }
.mp-gname { font-size: 12px; color: var(--dt-text-3); font-weight: 700; margin: 8px 0 4px; }
.mp-item { display: flex; align-items: center; gap: 6px; padding: 4px 6px; font-size: 13px; cursor: pointer; border-radius: 6px; }
.mp-item:hover { background: #f6f8fb; }
.mp-foot { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-top: 1px solid var(--dt-border-light); }
.mp-foot-count { flex: 1; font-size: 13px; color: var(--dt-text-3); }
</style>
