<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue'
import MsgVideo from '../MsgVideo.vue'

const props = defineProps<{
  src: string
  content?: string
  name?: string
  path?: string
}>()
const emit = defineEmits<{ close: [] }>()

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') emit('close')
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKeydown)
})
</script>

<template>
  <div class="vv-mask" @click.self="emit('close')">
    <button class="vv-close" title="关闭 (Esc)" @click="emit('close')">
      <i class="fas fa-times"></i>
    </button>
    <div class="vv-body">
      <MsgVideo
        :src="src"
        :content="content || src"
        :name="name || 'video'"
        :path="path"
        big
      />
    </div>
  </div>
</template>

<style scoped>
.vv-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.93);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 500;
}
.vv-body {
  width: 96vw;
  height: 88vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.vv-close {
  position: fixed;
  top: 20px;
  right: 24px;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.12);
  border: none;
  color: #fff;
  font-size: 18px;
  cursor: pointer;
  z-index: 510;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}
.vv-close:hover { background: rgba(255, 80, 80, 0.7); }
</style>
