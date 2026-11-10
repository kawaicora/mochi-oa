<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted } from 'vue'

const props = defineProps<{ deviceId: string; deviceName: string }>()

const output = ref<string[]>([])
const input = ref('')
const inputRef = ref<HTMLInputElement | null>(null)
const outputRef = ref<HTMLDivElement | null>(null)
let history: string[] = []
let historyIdx = -1
const running = ref(false)
let unsub: (() => void) | null = null

const isLocal = props.deviceId === 'local'

function prompt(): string {
  return isLocal ? 'server:~$' : `${props.deviceName}:~$`
}

async function exec(): Promise<void> {
  const cmd = input.value.trim()
  if (!cmd || running.value) return
  output.value.push(`${prompt()} ${cmd}`)
  history.push(cmd)
  historyIdx = history.length
  input.value = ''
  if (!isLocal) {
    running.value = true
    await nextTick()
    scrollBottom()
  }
  try {
    if (isLocal) {
      const ack = await window.pantry.serverAdminSysExec(cmd)
      if (ack.ok) {
        const d = ack.data
        const out = (d.stdout || '').replace(/\r\n/g, '\n').trim()
        const err = (d.stderr || '').replace(/\r\n/g, '\n').trim()
        if (out) output.value.push(out)
        if (err) output.value.push(err)
      } else {
        output.value.push(`错误: ${ack.error || '未知'}`)
      }
    } else {
      // 远程：发命令后等 dev:execResult 事件
      await window.pantry.serverAdminDevExec(props.deviceId, cmd)
    }
  } catch (e: any) {
    output.value.push(`错误: ${e?.message || '网络错误'}`)
  } finally {
    running.value = false
    await nextTick()
    scrollBottom()
  }
}

function scrollBottom(): void {
  if (outputRef.value) outputRef.value.scrollTop = outputRef.value.scrollHeight
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Enter') { void exec() }
  else if (e.key === 'ArrowUp') {
    e.preventDefault()
    if (historyIdx > 0) { historyIdx--; input.value = history[historyIdx] }
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (historyIdx < history.length - 1) { historyIdx++; input.value = history[historyIdx] }
    else { historyIdx = history.length; input.value = '' }
  }
}

onMounted(() => {
  output.value.push(`已连接到 ${props.deviceName} (${isLocal ? '服务器本机' : '远程设备'})`)
  output.value.push('输入命令，回车执行。↑↓ 翻历史记录。')
  if (!isLocal) {
    unsub = window.pantry.onDevExecResult((d) => {
      if (d.deviceId !== props.deviceId) return
      const out = (d.stdout || '').replace(/\r\n/g, '\n').trim()
      const err = (d.stderr || '').replace(/\r\n/g, '\n').trim()
      if (out) output.value.push(out)
      if (err) output.value.push(err)
      running.value = false
      nextTick(scrollBottom)
    })
  }
  inputRef.value?.focus()
})

onUnmounted(() => { unsub?.() })
</script>

<template>
  <div class="term">
    <div class="term-titlebar">
      <span class="term-title"><i class="fas fa-terminal"></i> {{ deviceName }} — 终端</span>
      <div class="term-winbtns">
        <button class="wb" @click="window.pantry.minimizeWindow()"><i class="fas fa-minus"></i></button>
        <button class="wb" @click="window.pantry.toggleMaximize()"><i class="far fa-square"></i></button>
        <button class="wb wb-close" @click="window.pantry.closeWindow()"><i class="fas fa-times"></i></button>
      </div>
    </div>
    <div ref="outputRef" class="term-output" @click="inputRef?.focus()">
      <div v-for="(line, i) in output" :key="i" class="term-line">{{ line }}</div>
    </div>
    <div class="term-input-bar">
      <span class="term-prompt">{{ prompt() }}</span>
      <input ref="inputRef" v-model="input" class="term-input" @keydown="onKeydown" @click.stop />
    </div>
  </div>
</template>

<style scoped>
.term { display: flex; flex-direction: column; height: 100vh; background: #0a0a0a; color: #d4d4d4; font-family: 'Cascadia Code', 'Consolas', monospace; font-size: 13px; overflow: hidden; }
.term-titlebar { padding: 8px 14px; background: #1a1a1a; color: #888; display: flex; align-items: center; justify-content: space-between; -webkit-app-region: drag; flex-shrink: 0; }
.term-title { font-size: 13px; }
.term-winbtns { display: flex; gap: 4px; -webkit-app-region: no-drag; }
.wb { background: none; border: none; color: #888; cursor: pointer; font-size: 12px; padding: 4px 8px; border-radius: 4px; }
.wb:hover { background: #333; color: #fff; }
.wb-close:hover { background: #e81123; }
.term-output { flex: 1; overflow-y: auto; padding: 10px 14px; cursor: text; min-height: 0; }
.term-line { white-space: pre-wrap; word-break: break-all; line-height: 1.6; }
.term-input-bar { flex-shrink: 0; padding: 8px 14px; border-top: 1px solid #222; display: flex; align-items: center; }
.term-prompt { color: #4ec9b0; margin-right: 8px; white-space: nowrap; }
.term-input { flex: 1; background: transparent; border: none; outline: none; color: #d4d4d4; font-family: inherit; font-size: inherit; caret-color: #4ec9b0; }
</style>
