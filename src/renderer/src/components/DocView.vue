<script setup lang="ts">
import { ref, watch, onMounted, computed } from 'vue'
import { useAppStore } from '../stores/app'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()

type Doc = { id: number; companyId: number; projectId: number | null; title: string; content: string; creatorId: number; createdAt: string; updatedAt: string }

const list = ref<Doc[]>([])
const selected = ref<number | null>(null)
const err = ref('')
const draft = ref({ title: '', content: '' })

async function load(): Promise<void> {
  try { list.value = await app.fetchDocs(props.projectId) } catch { err.value = '加载文档失败' }
  if (selected.value === null && list.value.length) select(list.value[0].id)
}
function select(id: number): void {
  selected.value = id
  const d = list.value.find((x) => x.id === id)
  if (d) { draft.value = { title: d.title, content: d.content } }
}
watch(() => props.projectId, () => void load())
onMounted(load)

const isAdmin = computed(() => app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'owner' || app.companies.find((c) => c.company.id === app.activeCompanyId)?.role === 'admin')

const showNew = ref(false)
const newTitle = ref('')
async function createDoc(): Promise<void> {
  if (!newTitle.value.trim()) { err.value = '标题不能为空'; return }
  const r = await app.createDoc({ projectId: props.projectId, title: newTitle.value.trim(), content: '' })
  showNew.value = false
  newTitle.value = ''
  if (!r.ok) { err.value = r.error || '创建失败'; return }
  await load()
  if (r.doc) select(r.doc.id)
}
async function save(): Promise<void> {
  if (selected.value === null) return
  const r = await app.updateDoc({ id: selected.value, title: draft.value.title, content: draft.value.content })
  if (!r.ok) { err.value = r.error || '保存失败'; return }
  await load()
}
async function onDelete(): Promise<void> {
  if (selected.value === null) return
  if (!confirm('删除该文档？')) return
  const res = await app.deleteDoc(selected.value)
  selected.value = null
  if (!res.ok) { err.value = res.error || '删除失败'; return }
  await load()
}
</script>

<template>
  <div class="pd">
    <div class="pd-side">
      <div class="pd-side-head">
        <span>文档</span>
        <button v-if="isAdmin" class="pm-op" @click="showNew = true"><i class="fas fa-plus"></i></button>
      </div>
      <div v-if="!list.length" class="pd-empty">暂无文档</div>
      <div v-for="d in list" :key="d.id" class="pd-item" :class="{ on: selected === d.id }" @click="select(d.id)">
        <i class="fas fa-file-alt"></i> {{ d.title }}
      </div>
    </div>
    <div class="pd-main">
      <template v-if="selected !== null">
        <div class="pd-editor-head">
          <input v-model="draft.title" class="srv-input pd-title-input" placeholder="文档标题" :disabled="!isAdmin" />
          <div class="pd-head-ops">
            <button v-if="isAdmin" class="dt-btn dt-btn-primary" @click="save"><i class="fas fa-save"></i> 保存</button>
            <button v-if="isAdmin" class="dt-btn danger-btn" @click="onDelete"><i class="fas fa-trash"></i> 删除</button>
          </div>
        </div>
        <textarea v-model="draft.content" class="pd-content" :disabled="!isAdmin" placeholder="在此输入文档内容…"></textarea>
      </template>
      <div v-else class="pd-empty-big">选择左侧文档进行编辑</div>
    </div>

    <div v-if="showNew" class="modal-mask" @click.self="showNew = false">
      <div class="modal pd-modal">
        <div class="modal-head">新建文档</div>
        <div class="modal-body"><input v-model="newTitle" class="srv-input" placeholder="文档标题" @keydown.enter="createDoc" /></div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showNew = false">取消</button>
          <button class="dt-btn dt-btn-primary" @click="createDoc">创建</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.pd { height: 100%; display: flex; }
.pd-side { width: 240px; flex-shrink: 0; border-right: 1px solid var(--dt-border-light); display: flex; flex-direction: column; background: #fafbfc; overflow-y: auto; }
.pd-side-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; font-weight: 700; font-size: 14px; border-bottom: 1px solid var(--dt-border-light); }
.pm-op { border: none; background: transparent; color: var(--dt-primary); font-size: 13px; cursor: pointer; padding: 3px 8px; border-radius: 6px; }
.pm-op:hover { background: #eef4ff; }
.pd-empty { padding: 14px; color: var(--dt-text-4); font-size: 13px; }
.pd-item { padding: 9px 14px; font-size: 13px; cursor: pointer; display: flex; align-items: center; gap: 8px; color: var(--dt-text-2); }
.pd-item:hover { background: #f0f3f6; }
.pd-item.on { background: #e8f3ff; color: var(--dt-primary); font-weight: 600; }
.pd-main { flex: 1; display: flex; flex-direction: column; padding: 16px; }
.pd-editor-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.pd-title-input { flex: 1; font-size: 18px; font-weight: 700; border: none; background: transparent; }
.pd-head-ops { display: flex; gap: 8px; }
.danger-btn { color: #d92b3a; border-color: #f2c4c4; }
.pd-content { flex: 1; resize: none; border: 1px solid var(--dt-border-light); border-radius: 8px; padding: 12px; font-size: 14px; line-height: 1.7; font-family: inherit; }
.pd-empty-big { color: var(--dt-text-4); text-align: center; padding: 60px 0; font-size: 14px; }
.pd-modal { width: 420px; }
</style>
