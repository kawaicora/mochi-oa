<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useAppStore } from '../stores/app'
import type { ServerChatMessage } from '@shared/server-types'

const props = defineProps<{ m: ServerChatMessage }>()
const app = useAppStore()

const src = ref('')
const err = ref(false)
let objUrl = ''

function nameOf(): string {
  const seg = props.m.content.split('/').pop() || ''
  return decodeURIComponent(seg)
}

/** 本地缓存路径 → 主进程 IPC 读文件字节 → blob → 可 seek 的 objectURL（绕开 app-file 协议） */
async function load(): Promise<void> {
  const path = app.localCache[props.m.id]?.path
  if (!path) {
    src.value = ''
    return
  }
  try {
    const r = await window.pantry.readAudioFile(path)
    if (!r.ok || !r.data) {
      src.value = ''
      return
    }
    if (objUrl) URL.revokeObjectURL(objUrl)
    objUrl = URL.createObjectURL(new Blob([r.data]))
    src.value = objUrl
  } catch {
    src.value = ''
  }
}

watch(
  () => app.localCache[props.m.id]?.path,
  () => {
    err.value = false
    void load()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (objUrl) URL.revokeObjectURL(objUrl)
})
</script>

<template>
  <div class="msg-audio">
    <!-- 文件名 + 图标一行，播放器一行 -->
    <div class="msg-audio-top">
      <i class="fas fa-music msg-audio-icon"></i>
      <span class="msg-audio-name" :title="nameOf()">{{ nameOf() }}</span>
    </div>
    <!-- 原生可播放：内联播放器 -->
    <audio v-if="src && !err" :src="src" controls preload="metadata" class="msg-audio-el" @error="err = true"></audio>
    <!-- 浏览器不支持该格式（ac3/cda/cue 等） -->
    <span v-else-if="err" class="msg-audio-err">该格式暂不支持内联播放</span>
    <span v-else class="msg-audio-loading">音频加载中…</span>
  </div>
</template>

<style scoped>
.msg-audio {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 260px;
}
.msg-audio-top {
  display: flex;
  align-items: center;
  gap: 6px;
}
.msg-audio-icon {
  color: var(--dt-primary);
  font-size: 14px;
  flex-shrink: 0;
}
.msg-audio-name {
  font-size: 12px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.msg-audio-el {
  width: 260px;
  height: 38px;
}
.msg-audio-err {
  font-size: 12px;
  color: var(--dt-danger);
}
.msg-audio-loading {
  font-size: 12px;
  color: var(--dt-text-3);
}
</style>
