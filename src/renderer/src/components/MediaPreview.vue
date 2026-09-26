<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import MsgVideo from './MsgVideo.vue'
import type { ServerChatMessage } from '@shared/server-types'

const props = defineProps<{
  kind: 'image' | 'video'
  m: ServerChatMessage
}>()
const emit = defineEmits<{ close: [] }>()

const app = useAppStore()
const previewSrc = computed(() => (props.kind === 'image' ? app.localPreviewUrl(props.m) : props.m.content))
</script>

<template>
  <div class="mp-mask" @click.self="emit('close')">
    <button class="mp-close" title="关闭 (Esc)" @click="emit('close')"><i class="fas fa-times"></i></button>
    <div class="mp-body">
      <img v-if="kind === 'image'" :src="previewSrc" class="mp-img" alt="预览" />
      <MsgVideo
        v-else
        :src="m.content"
        :content="m.content"
        :name="m.content"
        big
      />
    </div>
  </div>
</template>

<style scoped>
.mp-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.92);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
}
.mp-body {
  max-width: 92vw;
  max-height: 92vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.mp-img {
  max-width: 92vw;
  max-height: 92vh;
  object-fit: contain;
  border-radius: 6px;
}
.mp-close {
  position: fixed;
  top: 18px;
  right: 24px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.14);
  border: none;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  z-index: 310;
}
.mp-close:hover {
  background: rgba(255, 255, 255, 0.28);
}
</style>
