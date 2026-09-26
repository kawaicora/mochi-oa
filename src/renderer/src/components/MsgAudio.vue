<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue'
import { useAppStore } from '../stores/app'
import type { ServerChatMessage } from '@shared/server-types'

const props = defineProps<{ m: ServerChatMessage }>()
const app = useAppStore()

const src = ref('')
let objUrl = ''

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
  () => void load(),
  { immediate: true }
)

onBeforeUnmount(() => {
  if (objUrl) URL.revokeObjectURL(objUrl)
})
</script>

<template>
  <div class="msg-audio">
    <i class="fas fa-music msg-audio-icon"></i>
    <audio v-if="src" :src="src" controls preload="metadata" class="msg-audio-el"></audio>
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
.msg-audio-loading {
  font-size: 12px;
  color: var(--dt-text-3);
}
</style>
