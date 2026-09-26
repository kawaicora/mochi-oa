<script lang="ts">
export type ContactsScope = 'friends' | 'newfriend' | 'invites' | 'create' | 'org' | 'groups'
</script>

<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import type { Department, OrgMember } from '@shared/server-types'
import UserAvatar from './UserAvatar.vue'

const props = defineProps<{ scope: ContactsScope }>()
const emit = defineEmits<{
  (e: 'scope', v: ContactsScope): void
  (e: 'dept', deptId: number | null): void
}>()

const app = useAppStore()

// 2.2.1 子标签
const subTabs: { key: ContactsScope; label: string; icon: string }[] = [
  { key: 'groups', label: '群聊', icon: 'fas fa-users' },
  { key: 'friends', label: '我的好友', icon: 'far fa-heart' },
  { key: 'newfriend', label: '新的好友', icon: 'fas fa-user-plus' },
  { key: 'invites', label: '企业/团队邀请', icon: 'far fa-envelope' },
  { key: 'create', label: '创建或加入企业/团队', icon: 'fas fa-building' }
]

// 2.2.2 企业内组织架构：公司切换
const companyMenu = ref(false)

// 部门树
interface DeptNode extends Department { children: DeptNode[] }
const tree = computed<DeptNode[]>(() => {
  const map = new Map<number, DeptNode>()
  app.departments.forEach((d) => map.set(d.id, { ...d, children: [] }))
  const roots: DeptNode[] = []
  map.forEach((n) => {
    if (n.parentId != null && map.has(n.parentId)) map.get(n.parentId)!.children.push(n)
    else roots.push(n)
  })
  return roots
})
const openDept = ref<Set<number>>(new Set())
// 部门成员缓存：展开时按需从服务端加载（与组织架构页一致）
const deptMembers = ref<Record<number, OrgMember[]>>({})
function toggleDept(id: number): void {
  const s = new Set(openDept.value)
  if (s.has(id)) {
    s.delete(id)
  } else {
    s.add(id)
    if (!deptMembers.value[id]) {
      void app.loadDepartmentMembers(id).then((ms) => { deptMembers.value[id] = ms ?? [] })
    }
  }
  openDept.value = s
}
// 点击部门 → 切到「组织架构」内容并选中该部门
function pickDept(id: number): void {
  emit('scope', 'org')
  emit('dept', id)
}
// 点击公司（组织架构）→ 选中公司、清空部门
function pickCompany(id: number): void {
  app.switchCompany(id)
  companyMenu.value = false
  emit('scope', 'org')
  emit('dept', null)
}
</script>

<template>
  <div class="c-nav">
    <!-- 2.2.1 子标签 -->
    <div class="sub-tabs">
      <button
        v-for="t in subTabs"
        :key="t.key"
        class="sub-tab"
        :class="{ active: scope === t.key }"
        @click="emit('scope', t.key)"
      >
        <i :class="t.icon"></i>
        <span>{{ t.label }}</span>
      </button>
    </div>

    <!-- 2.2.2 企业内 [公司名] 组织架构 -->
    <div class="org-sec" :class="{ active: scope === 'org' }" @click="emit('scope', 'org')">
      <div class="org-head">
        <span class="org-title"><i class="fas fa-building"></i> 企业内 · 组织架构</span>
      </div>

      <!-- 公司切换 -->
      <div class="company-bar" @click.stop>
        <button class="company-switch" @click.stop="companyMenu = !companyMenu">
          <i class="fas fa-briefcase"></i>
          <span class="company-name">{{ app.activeCompany?.name || '未加入公司' }}</span>
          <i class="fas fa-caret-down"></i>
        </button>
        <div v-if="companyMenu" class="company-dropdown">
          <button
            v-for="c in app.companies"
            :key="c.company.id"
            class="company-opt"
            :class="{ active: c.company.id === app.activeCompanyId }"
            @click="pickCompany(c.company.id)"
          >{{ c.company.name }}（{{ app.roleLabel(c.role) }}）</button>
          <div class="company-drop-actions">
            <button @click="emit('scope', 'create'); companyMenu = false"><i class="fas fa-plus"></i> 创建</button>
            <button @click="emit('scope', 'create'); companyMenu = false"><i class="fas fa-sign-in-alt"></i> 加入</button>
          </div>
        </div>
      </div>

      <!-- 部门树 -->
      <div class="dept-tree">
        <div v-if="tree.length" v-for="dept in tree" :key="dept.id" class="dept-node">
          <div class="dept-row" @click.stop="toggleDept(dept.id)">
            <i class="fas" :class="openDept.has(dept.id) ? 'fa-caret-down' : 'fa-caret-right'"></i>
            <i class="fas fa-folder"></i>
            <span>{{ dept.name }}</span>
          </div>
          <div v-if="openDept.has(dept.id)" class="dept-children">
            <div v-for="child in dept.children" :key="child.id" class="dept-row child" @click.stop="pickDept(child.id)">
              <i class="fas fa-folder"></i><span>{{ child.name }}</span>
            </div>
            <!-- 该部门成员（与右侧组织架构一致） -->
            <div v-if="deptMembers[dept.id]?.length" v-for="m in deptMembers[dept.id]" :key="m.userId" class="dept-member" @click.stop="pickDept(dept.id)">
              <UserAvatar :nick="m.nick || m.username" :avatar="m.avatar" :size="26" />
              <span class="dept-member-name">{{ m.nick || m.username }}</span>
            </div>
            <div v-else-if="!deptMembers[dept.id]" class="dept-hint">加载中…</div>
            <div v-else class="dept-hint">（空部门）</div>
          </div>
        </div>
        <div v-else class="dept-hint">暂无部门</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.c-nav {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  background: #fff;
  border-right: 1px solid var(--dt-border-light);
  overflow: hidden;
}
.sub-tabs {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  padding: 8px 6px;
  border-bottom: 1px solid var(--dt-border-light);
}
.sub-tab {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border-radius: 6px;
  font-size: 14px;
  color: var(--dt-text-2);
  text-align: left;
  transition: background 0.15s, color 0.15s;
}
.sub-tab i { width: 16px; text-align: center; color: var(--dt-text-3); }
.sub-tab:hover { background: var(--dt-hover); }
.sub-tab.active { background: var(--dt-active); color: var(--dt-primary); }
.sub-tab.active i { color: var(--dt-primary); }

.dept-member {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 12px 5px 28px;
  font-size: 13px;
  color: var(--dt-text-1);
  cursor: pointer;
  border-radius: 4px;
}
.dept-member:hover { background: var(--dt-hover); }
.dept-member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.org-sec {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--dt-border-light);
}
.org-sec.active { background: var(--dt-active-weak, #f7faff); }
.org-head {
  flex-shrink: 0;
  padding: 10px 12px 4px;
}
.org-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--dt-text-3);
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.company-bar {
  position: relative;
  flex-shrink: 0;
  padding: 4px 8px;
}
.company-switch {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 8px 8px;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  color: var(--dt-text);
}
.company-switch:hover { background: var(--dt-hover); }
.company-switch .fa-briefcase { color: var(--dt-primary); }
.company-name { flex: 1; text-align: left; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.company-dropdown {
  position: absolute;
  top: 44px;
  left: 8px;
  right: 8px;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  z-index: 40;
  padding: 6px;
}
.company-opt { display: block; width: 100%; text-align: left; padding: 9px 12px; border-radius: 6px; font-size: 14px; color: var(--dt-text); }
.company-opt:hover { background: var(--dt-hover); }
.company-opt.active { background: var(--dt-active); color: var(--dt-primary); }
.company-drop-actions { border-top: 1px solid var(--dt-border-light); margin-top: 4px; padding-top: 6px; display: flex; gap: 6px; }
.company-drop-actions button { flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: 6px; padding: 8px; border-radius: 6px; font-size: 13px; color: var(--dt-text-2); }
.company-drop-actions button:hover { background: var(--dt-hover); color: var(--dt-text); }

.dept-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 8px 12px;
}
.dept-row { display: flex; align-items: center; gap: 6px; padding: 7px 6px; border-radius: 6px; font-size: 14px; color: var(--dt-text); cursor: pointer; }
.dept-row:hover { background: var(--dt-hover); }
.dept-row .fa-folder { color: var(--dt-text-3); }
.dept-children { margin-left: 16px; }
.dept-row.child { font-size: 13px; color: var(--dt-text-2); }
.dept-hint { font-size: 12px; color: var(--dt-text-4); padding: 6px 8px; }
</style>
