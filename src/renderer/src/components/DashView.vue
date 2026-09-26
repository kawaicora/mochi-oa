<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import { useAppStore } from '../stores/app'

const props = defineProps<{ projectId?: number }>()
const app = useAppStore()

type Stats = { newRequirement30d: number; overdueRequirement: number; bugResolveRate: number; unresolvedBug: number; requirementByStatus: Record<string, number>; bugBySeverity: Record<string, number> }
const stats = ref<Stats | null>(null)
const err = ref('')

async function load(): Promise<void> {
  try { stats.value = await app.fetchDashboard(props.projectId) } catch { err.value = '加载仪表盘失败' }
}
watch(() => props.projectId, () => void load())
onMounted(load)

const REQ = { planning: '待规划', in_progress: '进行中', done: '完成', closed: '已关闭' }
const SEV = { minor: '轻微', normal: '一般', major: '严重', critical: '致命' }

function bars(map: Record<string, number> | undefined, labels: Record<string, string>): Array<{ k: string; label: string; v: number; pct: number }> {
  const m = map ?? {}
  const keys = Object.keys(labels)
  const total = keys.reduce((s, k) => s + (m[k] ?? 0), 0)
  return keys.filter((k) => (m[k] ?? 0) > 0).map((k) => ({ k, label: labels[k], v: m[k] ?? 0, pct: total ? ((m[k] ?? 0) / total) * 100 : 0 }))
}
</script>

<template>
  <div class="dash">
    <div v-if="err" class="pm-err">{{ err }}</div>
    <div class="dash-cards">
      <div class="dash-card"><div class="dc-num">{{ stats?.newRequirement30d ?? 0 }}</div><div class="dc-lab">近30天新增需求</div></div>
      <div class="dash-card warn"><div class="dc-num">{{ stats?.overdueRequirement ?? 0 }}</div><div class="dc-lab">已延期需求</div></div>
      <div class="dash-card ok"><div class="dc-num">{{ (stats?.bugResolveRate ?? 0) }}%</div><div class="dc-lab">缺陷解决率</div></div>
      <div class="dash-card danger"><div class="dc-num">{{ stats?.unresolvedBug ?? 0 }}</div><div class="dc-lab">未解决缺陷</div></div>
    </div>

    <div class="dash-row">
      <div class="dash-panel">
        <div class="dp-head">需求状态分布</div>
        <div v-if="!bars(stats?.requirementByStatus, REQ).length" class="dp-empty">暂无数据</div>
        <div v-else class="dp-bars">
          <div v-for="b in bars(stats?.requirementByStatus, REQ)" :key="b.k" class="dp-bar">
            <span class="dp-bar-lab">{{ b.label }}</span>
            <div class="dp-bar-track"><div class="dp-bar-fill" :class="b.k" :style="{ width: b.pct + '%' }"></div></div>
            <span class="dp-bar-num">{{ b.v }}</span>
          </div>
        </div>
      </div>
      <div class="dash-panel">
        <div class="dp-head">缺陷严重程度分布</div>
        <div v-if="!bars(stats?.bugBySeverity, SEV).length" class="dp-empty">暂无数据</div>
        <div v-else class="dp-bars">
          <div v-for="b in bars(stats?.bugBySeverity, SEV)" :key="b.k" class="dp-bar">
            <span class="dp-bar-lab">{{ b.label }}</span>
            <div class="dp-bar-track"><div class="dp-bar-fill" :class="b.k" :style="{ width: b.pct + '%' }"></div></div>
            <span class="dp-bar-num">{{ b.v }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dash { padding: 18px; overflow: auto; height: 100%; }
.pm-err { padding: 0 0 10px; color: #d92b3a; font-size: 13px; }
.dash-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; }
.dash-card { background: #fff; border: 1px solid var(--dt-border-light); border-radius: 10px; padding: 18px; text-align: center; }
.dc-num { font-size: 30px; font-weight: 800; color: var(--dt-primary); }
.dc-lab { margin-top: 6px; font-size: 13px; color: var(--dt-text-3); }
.dash-card.warn .dc-num { color: #d46b08; }
.dash-card.ok .dc-num { color: #2fbb6b; }
.dash-card.danger .dc-num { color: #d92b3a; }
.dash-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-top: 14px; }
.dash-panel { background: #fff; border: 1px solid var(--dt-border-light); border-radius: 10px; padding: 16px; }
.dp-head { font-weight: 700; font-size: 14px; margin-bottom: 12px; }
.dp-empty { color: var(--dt-text-4); font-size: 13px; text-align: center; padding: 20px 0; }
.dp-bars { display: flex; flex-direction: column; gap: 10px; }
.dp-bar { display: flex; align-items: center; gap: 10px; }
.dp-bar-lab { width: 70px; font-size: 13px; color: var(--dt-text-2); flex-shrink: 0; }
.dp-bar-track { flex: 1; height: 14px; background: #f0f2f5; border-radius: 7px; overflow: hidden; }
.dp-bar-fill { height: 100%; border-radius: 7px; }
.dp-bar-fill.planning, .dp-bar-fill.minor, .dp-bar-fill.normal { background: #b8c2cc; }
.dp-bar-fill.in_progress, .dp-bar-fill.major { background: #ffb25a; }
.dp-bar-fill.done, .dp-bar-fill.closed { background: #2fbb6b; }
.dp-bar-fill.critical { background: #d92b3a; }
.dp-bar-num { width: 30px; text-align: right; font-size: 13px; font-weight: 600; }
</style>
