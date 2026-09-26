<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useAppStore } from '../stores/app'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()

type M = { userId: number; nick: string; username: string; total: number; completed: number; inProgress: number; overdue: number }
const list = ref<M[]>([])
const err = ref('')
async function load(): Promise<void> {
  try { list.value = await app.fetchMemberTracking(props.projectId) } catch { err.value = '加载成员跟踪失败' }
}
watch(() => props.projectId, () => void load())
onMounted(load)

function rate(m: M): number { return m.total ? Math.round((m.completed / m.total) * 100) : 0 }
</script>

<template>
  <div class="mt">
    <div class="pm-bar">
      <span class="pm-title"><i class="fas fa-users"></i> 成员任务跟踪</span>
    </div>
    <div v-if="err" class="pm-err">{{ err }}</div>
    <div class="pm-table-wrap">
      <div v-if="!list.length" class="pm-empty">暂无成员任务数据</div>
      <table v-else class="pm-table">
        <thead><tr><th>成员</th><th>任务总数</th><th>已完成</th><th>进行中</th><th>已延期</th><th>完成率</th></tr></thead>
        <tbody>
          <tr v-for="m in list" :key="m.userId">
            <td class="pm-name">{{ m.nick || m.username }}</td>
            <td>{{ m.total }}</td>
            <td class="c-ok">{{ m.completed }}</td>
            <td class="c-run">{{ m.inProgress }}</td>
            <td class="c-warn">{{ m.overdue }}</td>
            <td>
              <div class="rate"><div class="rate-track"><div class="rate-fill" :style="{ width: rate(m) + '%' }"></div></div><span>{{ rate(m) }}%</span></div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.mt { height: 100%; display: flex; flex-direction: column; }
.pm-bar { display: flex; align-items: center; padding: 12px 18px; border-bottom: 1px solid var(--dt-border-light); flex-shrink: 0; }
.pm-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
.pm-err { padding: 8px 18px; color: #d92b3a; font-size: 13px; }
.pm-table-wrap { flex: 1; overflow: auto; padding: 12px 18px; }
.pm-empty { color: var(--dt-text-4); text-align: center; padding: 40px 0; font-size: 14px; }
.pm-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.pm-table th, .pm-table td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--dt-border-light); }
.pm-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.pm-table tbody tr:hover { background: #f6f8fb; }
.pm-name { font-weight: 600; }
.c-ok { color: #2fbb6b; }
.c-run { color: var(--dt-primary); }
.c-warn { color: #d46b08; }
.rate { display: flex; align-items: center; gap: 8px; }
.rate-track { width: 120px; height: 10px; background: #f0f2f5; border-radius: 5px; overflow: hidden; }
.rate-fill { height: 100%; background: #2fbb6b; border-radius: 5px; }
</style>
