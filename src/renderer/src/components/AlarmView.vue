<script setup lang="ts">
import { ref, computed } from 'vue'
import { Alarm, AlarmRepeat, loadAlarms, saveAlarms, newAlarmId } from '../utils/alarms'

const alarms = ref<Alarm[]>(loadAlarms())
function refresh(): void {
  alarms.value = loadAlarms()
}

// ─── 表单 ───
const showForm = ref(false)
const editingId = ref<string | null>(null)
const fTime = ref('08:00')
const fName = ref('')
const fRepeat = ref<AlarmRepeat>('once')
const fWeekdays = ref<number[]>([1, 2, 3, 4, 5])
const fRing = ref('')
const fUseRing = ref(true)
const fNotify = ref(true)
const fCommand = ref('')
const weekdayNames = ['日', '一', '二', '三', '四', '五', '六']

function openAdd(): void {
  editingId.value = null
  fTime.value = '08:00'
  fName.value = ''
  fRepeat.value = 'once'
  fWeekdays.value = [1, 2, 3, 4, 5]
  fRing.value = ''
  fUseRing.value = true
  fNotify.value = true
  fCommand.value = ''
  showForm.value = true
}
function openEdit(a: Alarm): void {
  editingId.value = a.id
  fTime.value = a.time
  fName.value = a.name
  fRepeat.value = a.repeat
  fWeekdays.value = [...a.weekdays]
  fRing.value = a.ring
  fUseRing.value = a.useRing
  fNotify.value = a.notify
  fCommand.value = a.command ?? ''
  showForm.value = true
}
function closeForm(): void {
  showForm.value = false
  editingId.value = null
}

async function pickRing(): Promise<void> {
  const p = await window.pantry.pickFile('audio')
  if (p) fRing.value = p
}
const ringName = computed(() => {
  if (!fRing.value) return ''
  const parts = fRing.value.split(/[\\/]/)
  return parts[parts.length - 1]
})

async function pickCommand(): Promise<void> {
  const p = await window.pantry.pickFile()
  if (p) fCommand.value = p
}

function toggleWeekday(d: number): void {
  fWeekdays.value = fWeekdays.value.includes(d)
    ? fWeekdays.value.filter((x) => x !== d)
    : [...fWeekdays.value, d]
}

function saveForm(): void {
  const time = fTime.value.trim()
  if (!/^\d{2}:\d{2}$/.test(time)) return
  const existing = alarms.value.find((a) => a.id === editingId.value)
  const alarm: Alarm = {
    id: existing?.id ?? newAlarmId(),
    time,
    name: fName.value.trim(),
    repeat: fRepeat.value,
    weekdays: fRepeat.value === 'weekly' ? fWeekdays.value.slice().sort() : [],
    ring: fRing.value,
    useRing: fUseRing.value,
    notify: fNotify.value,
    command: fCommand.value.trim(),
    enabled: existing?.enabled ?? true
  }
  const list = existing
    ? alarms.value.map((a) => (a.id === existing.id ? alarm : a))
    : [...alarms.value, alarm]
  saveAlarms(list)
  refresh()
  closeForm()
}

function removeAlarm(id: string): void {
  saveAlarms(alarms.value.filter((a) => a.id !== id))
  refresh()
}
function toggleAlarm(a: Alarm): void {
  a.enabled = !a.enabled
  saveAlarms(alarms.value)
  refresh()
}

function repeatLabel(a: Alarm): string {
  if (a.repeat === 'once') return '一次'
  if (a.repeat === 'daily') return '每天'
  return a.weekdays.map((d) => `周${weekdayNames[d]}`).join('、') || '每周'
}
</script>

<template>
  <section class="alarm-panel">
    <div class="alarm-head">
      <span class="alarm-title"><i class="fas fa-bell"></i> 闹钟</span>
      <button class="alarm-add" @click="openAdd"><i class="fas fa-plus"></i> 添加闹钟</button>
    </div>

    <div v-if="!alarms.length" class="alarm-empty">
      <i class="far fa-clock alarm-empty-icon"></i>
      <span>还没有闹钟，点击「添加闹钟」新建一个～</span>
    </div>

    <div v-else class="alarm-list">
      <div v-for="a in alarms" :key="a.id" class="alarm-card" :class="{ off: !a.enabled }">
        <div class="alarm-time">{{ a.time }}</div>
        <div class="alarm-meta">
          <div class="alarm-name">{{ a.name || '闹钟' }}</div>
          <div class="alarm-tags">
            <span class="alarm-tag" :class="a.repeat === 'once' ? 'once' : a.repeat === 'daily' ? 'daily' : 'weekly'">{{ repeatLabel(a) }}</span>
            <span v-if="a.useRing && a.ring" class="alarm-tag ring"><i class="fas fa-music"></i> {{ a.ring.split(/[\\/]/).pop() }}</span>
            <span v-if="a.notify" class="alarm-tag nore"><i class="fas fa-bell"></i> 系统通知</span>
            <span v-if="a.command && a.command.trim()" class="alarm-tag cmd"><i class="fas fa-terminal"></i> {{ a.command.split(/[\\/]/).pop() }}</span>
            <span v-if="!a.useRing && !a.notify && !(a.command && a.command.trim())" class="alarm-tag nore"><i class="fas fa-bell-slash"></i> 无动作</span>
          </div>
        </div>
        <div class="alarm-actions">
          <button class="alarm-toggle" :class="{ on: a.enabled }" :title="a.enabled ? '已开启' : '已关闭'" @click="toggleAlarm(a)">
            <i class="fas" :class="a.enabled ? 'fa-toggle-on' : 'fa-toggle-off'"></i>
          </button>
          <button class="alarm-icon-btn" title="编辑" @click="openEdit(a)"><i class="fas fa-pen"></i></button>
          <button class="alarm-icon-btn danger" title="删除" @click="removeAlarm(a.id)"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单 -->
    <div v-if="showForm" class="alarm-form-mask" @click.self="closeForm">
      <div class="alarm-form">
        <div class="alarm-form-title">{{ editingId ? '编辑闹钟' : '添加闹钟' }}</div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">时间</span>
          <input v-model="fTime" type="time" class="alarm-form-input alarm-time-input" />
        </div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">名称</span>
          <input v-model="fName" class="alarm-form-input" placeholder="闹钟名称（可空）" maxlength="20" />
        </div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">重复</span>
          <div class="alarm-repeat">
            <button class="alarm-seg" :class="{ on: fRepeat === 'once' }" @click="fRepeat = 'once'">一次</button>
            <button class="alarm-seg" :class="{ on: fRepeat === 'daily' }" @click="fRepeat = 'daily'">每天</button>
            <button class="alarm-seg" :class="{ on: fRepeat === 'weekly' }" @click="fRepeat = 'weekly'">每周</button>
          </div>
        </div>
        <div v-if="fRepeat === 'weekly'" class="alarm-form-row">
          <span class="alarm-form-label">周几</span>
          <div class="alarm-weekdays">
            <button
              v-for="(w, d) in weekdayNames"
              :key="d"
              class="alarm-wd"
              :class="{ on: fWeekdays.includes(d) }"
              @click="toggleWeekday(d)"
            >{{ w }}</button>
          </div>
        </div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">铃声</span>
          <div class="alarm-ring">
            <label class="alarm-switch"><input v-model="fUseRing" type="checkbox" /><span class="alarm-sw-slider"></span></label>
            <button class="alarm-ring-btn" :disabled="!fUseRing" @click="pickRing"><i class="fas fa-music"></i> 选择本地音乐</button>
            <span v-if="fUseRing && ringName" class="alarm-ring-name" :title="fRing">{{ ringName }}</span>
            <span v-else-if="fUseRing" class="alarm-ring-none">未选择音乐</span>
          </div>
        </div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">系统通知</span>
          <label class="alarm-switch"><input v-model="fNotify" type="checkbox" /><span class="alarm-sw-slider"></span></label>
          <span class="alarm-sw-hint">到点弹系统通知（可关闭，若你的程序自带提示）</span>
        </div>
        <div class="alarm-form-row">
          <span class="alarm-form-label">执行操作</span>
          <div class="alarm-ring">
            <input v-model="fCommand" class="alarm-form-input" placeholder="如 D:\\app.exe /r  或  /home/user/run.sh 或 node x.js" />
            <button class="alarm-ring-btn" @click="pickCommand"><i class="fas fa-terminal"></i> 选择程序/脚本</button>
          </div>
        </div>
        <div class="alarm-form-actions">
          <button class="alarm-save" @click="saveForm"><i class="fas fa-check"></i> 保存</button>
          <button class="alarm-cancel" @click="closeForm">取消</button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.alarm-panel {
  flex: 1;
  min-width: 0;
  height: 100%;
  display: flex;
  flex-direction: column;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.95), #f7f9ff);
  position: relative;
}
.alarm-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: 16px 20px 8px;
}
.alarm-title { font-size: 18px; font-weight: 700; color: var(--dt-text); display: flex; align-items: center; gap: 8px; }
.alarm-add {
  height: 32px; padding: 0 14px; border-radius: 8px; background: var(--dt-primary); color: #fff;
  font-size: 13px; display: inline-flex; align-items: center; gap: 6px; border: none;
}
.alarm-add:hover { opacity: 0.9; }
.alarm-empty { margin: 40px auto; text-align: center; color: var(--dt-text-4); font-size: 14px; }
.alarm-empty-icon { font-size: 48px; display: block; margin-bottom: 12px; color: var(--dt-text-4); }
.alarm-list { padding: 8px 20px; display: flex; flex-direction: column; gap: 10px; overflow-y: auto; }
.alarm-card {
  display: flex; align-items: center; gap: 16px;
  background: #fff; border: 1px solid var(--dt-border-light); border-radius: 12px;
  padding: 14px 16px;
}
.alarm-card.off { opacity: 0.55; }
.alarm-time { font-size: 30px; font-weight: 800; color: var(--dt-text); font-variant-numeric: tabular-nums; width: 88px; }
.alarm-card.off .alarm-time { color: var(--dt-text-3); }
.alarm-meta { flex: 1; min-width: 0; }
.alarm-name { font-size: 14px; font-weight: 600; color: var(--dt-text); }
.alarm-tags { display: flex; gap: 6px; margin-top: 5px; flex-wrap: wrap; }
.alarm-tag { font-size: 11px; padding: 1px 8px; border-radius: 20px; }
.alarm-tag.once { background: #e8f3ff; color: var(--dt-primary); }
.alarm-tag.daily { background: #eefbe7; color: #3c9a1f; }
.alarm-tag.weekly { background: #fff1d6; color: #d46b08; }
.alarm-tag.ring { background: #f3e8ff; color: #8a2be2; }
.alarm-tag.nore { background: #f1f3f5; color: var(--dt-text-3); }
.alarm-tag.cmd { background: #e6f4ea; color: #188038; }
.alarm-actions { display: flex; align-items: center; gap: 6px; }
.alarm-toggle { font-size: 24px; color: var(--dt-border); display: inline-flex; padding: 0; }
.alarm-toggle.on { color: var(--dt-primary); }
.alarm-icon-btn { width: 28px; height: 28px; border-radius: 8px; color: var(--dt-text-3); display: inline-flex; align-items: center; justify-content: center; font-size: 13px; }
.alarm-icon-btn:hover { color: var(--dt-text); background: var(--dt-bg-app); }
.alarm-icon-btn.danger:hover { color: var(--dt-danger); background: #fff0f0; }

/* 表单 */
.alarm-form-mask {
  position: absolute; inset: 0; background: rgba(255, 255, 255, 0.5);
  display: flex; align-items: center; justify-content: center; z-index: 20;
}
.alarm-form {
  width: 420px; background: #fff; border: 1px solid var(--dt-border-light);
  border-radius: 14px; padding: 20px; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.12);
}
.alarm-form-title { font-size: 16px; font-weight: 700; color: var(--dt-text); margin-bottom: 16px; }
.alarm-form-row { display: flex; align-items: center; gap: 12px; margin-bottom: 14px; }
.alarm-form-label { width: 48px; font-size: 13px; color: var(--dt-text-2); flex-shrink: 0; }
.alarm-form-input {
  flex: 1; height: 34px; border: 1px solid var(--dt-border); border-radius: 8px;
  padding: 0 12px; font-size: 14px; color: var(--dt-text); outline: none; background: #fff;
}
.alarm-form-input:focus { border-color: var(--dt-primary); }
.alarm-time-input { width: 140px; flex: none; }
.alarm-repeat { display: flex; gap: 8px; }
.alarm-seg { height: 32px; padding: 0 16px; border-radius: 8px; font-size: 13px; border: 1px solid var(--dt-border-light); color: var(--dt-text-2); background: #fff; }
.alarm-seg.on { background: var(--dt-primary); border-color: var(--dt-primary); color: #fff; }
.alarm-weekdays { display: flex; gap: 6px; }
.alarm-wd {
  width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--dt-border-light);
  color: var(--dt-text-2); font-size: 13px; background: #fff;
}
.alarm-wd.on { background: var(--dt-primary); border-color: var(--dt-primary); color: #fff; }
.alarm-ring { display: flex; align-items: center; gap: 10px; flex: 1; }
.alarm-ring .alarm-form-input { flex: 1; min-width: 0; }
.alarm-ring-btn { height: 32px; padding: 0 12px; border-radius: 8px; font-size: 13px; border: 1px solid var(--dt-border-light); color: var(--dt-text-2); background: #fff; display: inline-flex; align-items: center; gap: 6px; flex-shrink: 0; }
.alarm-ring-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.alarm-ring-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.alarm-ring-name { font-size: 12px; color: var(--dt-text-2); max-width: 180px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.alarm-ring-none { font-size: 12px; color: var(--dt-text-4); }
.alarm-switch { position: relative; display: inline-flex; flex-shrink: 0; }
.alarm-switch input { position: absolute; opacity: 0; width: 0; height: 0; }
.alarm-sw-slider {
  width: 36px; height: 20px; border-radius: 20px; background: var(--dt-border);
  position: relative; cursor: pointer; transition: background 0.15s;
}
.alarm-sw-slider::before {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: #fff; transition: transform 0.15s; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
}
.alarm-switch input:checked + .alarm-sw-slider { background: var(--dt-primary); }
.alarm-switch input:checked + .alarm-sw-slider::before { transform: translateX(16px); }
.alarm-sw-hint { font-size: 12px; color: var(--dt-text-4); }
.alarm-form-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
.alarm-save { height: 32px; padding: 0 18px; border-radius: 8px; background: var(--dt-primary); color: #fff; font-size: 13px; border: none; }
.alarm-cancel { height: 32px; padding: 0 16px; border-radius: 8px; border: 1px solid var(--dt-border-light); color: var(--dt-text-2); background: #fff; font-size: 13px; }
</style>
