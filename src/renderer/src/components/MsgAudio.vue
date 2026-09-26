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

/** 本地缓存路径 → fetch app-file → blob → 可 seek 的 objectURL（app-file range 支持差，故转 blob） */
async function load(): Promise<void> {
  const path = app.localCache[props.m.id]?.path
  if (!path) {
    src.value = ''
    return
  }
  try {
    const res = await fetch('app-file:///' + encodeURIComponent(path))
    if (!res.ok) {
      src.value = ''
      return
    }
    const blob = await res.blob()
    if (objUrl) URL.revokeObjectURL(objUrl)
    objUrl = URL.createObjectURL(blob)
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
    <i class="fas fa-music msg-audio-icon"></i>
    <!-- 原生可播放：内联播放器 -->
    <audio v-if="src && !err" :src="src" controls preload="metadata" class="msg-audio-el" @error="err = true"></audio>
    <!-- 浏览器不支持该格式（ac3/cda/cue 等）：显示文件名 + 提示（后续接 ffmpeg 转码） -->
    <template v-else-if="err">
      <span class="msg-audio-name" :title="nameOf()">{{ nameOf() }}</span>
      <span class="msg-audio-err">该格式暂不支持内联播放</span>
    </template>
    <span v-else class="msg-audio-loading">音频加载中…</span>
  </div>
</template>

<style scoped>
.msg-audio {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 240px;
}
.msg-audio-icon {
  color: var(--dt-primary);
  font-size: 18px;
  flex-shrink: 0;
}
.msg-audio-el {
  max-width: 220px;
  height: 38px;
}
.msg-audio-name {
  font-size: 13px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
}
.msg-audio-err {
  font-size: 12px;
  color: var(--dt-danger);
  flex-shrink: 0;
}
.msg-audio-loading {
  font-size: 12px;
  color: var(--dt-text-3);
}
</style>
