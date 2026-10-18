<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useAppStore } from '../stores/app'
import type { OrgMember, Department } from '../../shared/server-types'

/**
 * 公司通讯录选人弹窗（统一组件）。
 *
 * 数据源：当前切换公司（app.activeCompanyId）下的部门 + 成员。
 * 分组：按部门分组显示成员；未归属任何部门的成员归入「未分组」。
 * 语义：多选（复选框），v-model 绑定 number[]（已选 userId）。
 *
 * 两种使用方式：
 *  1) 触发按钮模式（默认）：渲染一个带已选标签的按钮，点击弹窗。
 *     <CompanyContactPicker v-model="ids" placeholder="选择审批人" />
 *  2) 受控弹窗模式（controlled=true）：只渲染弹窗本身，由父组件用 open 控制显隐。
 *     <CompanyContactPicker v-model="ids" :open="open" @update:open="open=$event" controlled />
 *
 * 确认后通过 update:modelValue 同步所选 userId 数组；同时 confirm 事件回传
 * 所选成员对象（含 userId + 姓名），方便父组件直接展示姓名。
 */
const props = withDefaults(
  defineProps<{
    /** 已选 userId 数组（v-model） */
    modelValue: number[]
    /** 触发按钮占位文案 */
    placeholder?: string
    /** 弹窗标题 */
    title?: string
    /** 最多可选人数，0=不限 */
    max?: number
    /** 受控模式：为 true 时不渲染触发按钮，仅渲染弹窗，由 open 控制显隐 */
    controlled?: boolean
    /** 受控模式下的显隐 */
    open?: boolean
  }>(),
  {
    placeholder: '选择成员',
    title: '选择成员',
    max: 0,
    controlled: false,
    open: undefined
  }
)
const emit = defineEmits<{
  (e: 'update:modelValue', ids: number[]): void
  (e: 'update:open', v: boolean): void
  (e: 'close'): void
  (e: 'confirm', members: OrgMember[]): void
}>()

const app = useAppStore()

// 非受控模式下的内部显隐
const innerOpen = ref(false)
// 实际生效的显隐（受控用 props.open，否则用 innerOpen）
const isOpen = computed(() => (props.controlled ? !!props.open : innerOpen.value))

const keyword = ref('')
// 弹窗内临时勾选（点确定才同步回 modelValue）
const tempSel = ref<number[]>([])

interface Group {
  key: string
  name: string
  members: OrgMember[]
}
const groups = ref<Group[]>([])
const loading = ref(false)

// 当前公司 id（company_id 隔离：只展示当前公司成员）
const companyId = computed(() => app.activeCompanyId)

// 触发按钮上展示的已选成员对象
const selectedMembers = computed<OrgMember[]>(() =>
  props.modelValue
    .map((id) => app.members.find((m) => m.userId === id))
    .filter(Boolean) as OrgMember[]
)

/** 打开弹窗时加载分组数据 */
async function buildGroups(): Promise<void> {
  loading.value = true
  groups.value = []
  try {
    // 确保数据是当前公司的（switchCompany 后已刷新，这里兜底再拉一次）
    if (!companyId.value) {
      groups.value = []
      return
    }
    const depts: Department[] = app.departments || []
    const used = new Set<number>()
    const out: Group[] = []
    for (const d of depts) {
      try {
        const ms = await app.loadDepartmentMembers(d.id)
        if (ms.length) {
          out.push({ key: 'd-' + d.id, name: d.name, members: ms })
          ms.forEach((m) => used.add(m.userId))
        }
      } catch (e) {
        console.error('[选人] 加载部门成员失败', d.name, e)
      }
    }
    // 未归属任何部门的成员 → 未分组
    const rootMembers = (app.members || []).filter((m) => !used.has(m.userId))
    if (rootMembers.length) out.unshift({ key: 'root', name: '未分组', members: rootMembers })
    groups.value = out
  } catch (e) {
    console.error('[选人] 构建通讯录分组失败', e)
    groups.value = []
  } finally {
    loading.value = false
  }
}

/** 搜索关键字过滤后的分组 */
const filteredGroups = computed<Group[]>(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return groups.value
  return groups.value
    .map((g) => ({
      ...g,
      members: g.members.filter((m) => (m.nick || m.username || '').toLowerCase().includes(kw))
    }))
    .filter((g) => g.members.length > 0)
})

function openModal(): void {
  tempSel.value = [...props.modelValue]
  keyword.value = ''
  innerOpen.value = true
  void buildGroups()
}
function closeModal(): void {
  if (props.controlled) emit('update:open', false)
  else innerOpen.value = false
  emit('close')
}

function toggle(userId: number): void {
  const i = tempSel.value.indexOf(userId)
  if (i >= 0) {
    tempSel.value.splice(i, 1)
  } else {
    if (props.max > 0 && tempSel.value.length >= props.max) return
    tempSel.value.push(userId)
  }
}
function isTempSel(userId: number): boolean {
  return tempSel.value.includes(userId)
}

function removeTrigger(userId: number, ev: MouseEvent): void {
  ev.stopPropagation()
  emit('update:modelValue', props.modelValue.filter((x) => x !== userId))
}

function confirm(): void {
  const ids = [...tempSel.value]
  emit('update:modelValue', ids)
  // 回传所选成员对象（含姓名）
  const objs = ids
    .map((id) => app.members.find((m) => m.userId === id))
    .filter(Boolean) as OrgMember[]
  emit('confirm', objs)
  closeModal()
}

// 受控模式下：open 变 true 时初始化临时选择并拉数据
watch(
  () => props.open,
  (v) => {
    if (props.controlled && v) {
      tempSel.value = [...props.modelValue]
      keyword.value = ''
      void buildGroups()
    }
  }
)

// 弹窗关闭时清空搜索
watch(isOpen, (v) => {
  if (!v) keyword.value = ''
})
</script>

<template>
  <!-- 触发按钮（非受控模式才渲染） -->
  <button v-if="!controlled" class="ccp-trigger" @click="openModal">
    <i class="fas fa-user-check"></i>
    <span v-if="!selectedMembers.length" class="ccp-ph">{{ placeholder }}</span>
    <span v-else class="ccp-tags">
      <span v-for="m in selectedMembers" :key="m.userId" class="ccp-tag">
        {{ m.nick || m.username }}
        <i class="ccp-x" @click="removeTrigger(m.userId, $event)">×</i>
      </span>
    </span>
    <i v-if="selectedMembers.length" class="ccp-count">{{ selectedMembers.length }}</i>
  </button>

  <!-- 弹窗 -->
  <div v-if="isOpen" class="ccp-mask" @click.self="closeModal">
    <div class="ccp-modal">
      <div class="ccp-head">
        <span class="ccp-title">{{ title }}</span>
        <input v-model="keyword" class="srv-input ccp-search" placeholder="搜索姓名…" />
        <button class="ccp-close" @click="closeModal" aria-label="关闭">×</button>
      </div>
      <div class="ccp-body">
        <div v-if="loading" class="ccp-empty">加载中…</div>
        <div v-else-if="!filteredGroups.length" class="ccp-empty">
          {{ companyId ? '无成员' : '未选择公司' }}
        </div>
        <template v-else>
          <div v-for="g in filteredGroups" :key="g.key" class="ccp-group">
            <div class="ccp-gname">{{ g.name }}（{{ g.members.length }}）</div>
            <label v-for="m in g.members" :key="m.userId" class="ccp-item">
              <input
                type="checkbox"
                :checked="isTempSel(m.userId)"
                @change="toggle(m.userId)"
                :disabled="!isTempSel(m.userId) && max > 0 && tempSel.length >= max"
              />
              <span class="ccp-item-name">{{ m.nick || m.username }}</span>
              <span v-if="m.role === 'owner'" class="ccp-role owner">创建人</span>
              <span v-else-if="m.role === 'admin'" class="ccp-role admin">管理员</span>
            </label>
          </div>
        </template>
      </div>
      <div class="ccp-foot">
        <span class="ccp-foot-count">已选 {{ tempSel.length }} 人</span>
        <button class="dt-btn" @click="closeModal">取消</button>
        <button class="dt-btn dt-btn-primary" @click="confirm">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ccp-trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--dt-border-light);
  background: #fff;
  border-radius: 8px;
  padding: 5px 10px;
  font-size: 13px;
  cursor: pointer;
  max-width: 100%;
}
.ccp-ph { color: var(--dt-text-4); }
.ccp-tags { display: inline-flex; flex-wrap: wrap; gap: 4px; }
.ccp-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: #eef4ff;
  color: var(--dt-primary);
  padding: 1px 8px;
  border-radius: 20px;
  font-size: 12px;
}
.ccp-x { cursor: pointer; font-style: normal; }
.ccp-count {
  background: var(--dt-primary);
  color: #fff;
  border-radius: 20px;
  padding: 0 6px;
  font-size: 11px;
}

.ccp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 120;
  padding: 16px;
}
.ccp-modal {
  width: 480px;
  max-width: 100%;
  max-height: 80vh;
  background: #fff;
  border-radius: 10px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
}
.ccp-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--dt-border-light);
}
.ccp-title { font-weight: 700; font-size: 14px; flex-shrink: 0; }
.ccp-search { flex: 1; height: 30px; min-width: 0; }
.ccp-close {
  flex-shrink: 0;
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: var(--dt-text-3);
  cursor: pointer;
  padding: 0 4px;
}
.ccp-close:hover { color: var(--dt-text); }

.ccp-body { flex: 1; overflow: auto; padding: 8px 14px; }
.ccp-empty { color: var(--dt-text-4); text-align: center; padding: 20px 0; font-size: 13px; }
.ccp-group { margin-bottom: 10px; }
.ccp-gname {
  font-size: 12px;
  color: var(--dt-text-3);
  font-weight: 700;
  margin: 8px 0 4px;
}
.ccp-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 6px;
  font-size: 13px;
  cursor: pointer;
  border-radius: 6px;
}
.ccp-item:hover { background: #f6f8fb; }
.ccp-item input[type='checkbox'] { margin: 0; cursor: pointer; }
.ccp-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ccp-role { font-size: 11px; border: 1px solid currentColor; border-radius: 4px; padding: 0 4px; flex-shrink: 0; }
.ccp-role.owner { color: #d92b3a; }
.ccp-role.admin { color: #7a5af5; }

.ccp-foot {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border-top: 1px solid var(--dt-border-light);
}
.ccp-foot-count { flex: 1; font-size: 13px; color: var(--dt-text-3); }
</style>
