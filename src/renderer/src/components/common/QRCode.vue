<script setup lang="ts">
import { ref, watch, onMounted } from 'vue'
import QRCode from 'qrcode'

/**
 * 通用二维码渲染组件（公共基础件）。
 * props: text（编码内容） / size（像素边长，默认 160）。
 * 内部用 qrcode 库生成 dataURL 渲染为 <img>。
 */
const props = defineProps<{ text: string; size?: number }>()
const emit = defineEmits<{ (e: 'error', err: unknown): void }>()

const url = ref('')
async function render(): Promise<void> {
  if (!props.text) { url.value = ''; return }
  try {
    url.value = await QRCode.toDataURL(props.text, { width: props.size || 160, margin: 1 })
  } catch (e) {
    console.error('[QRCode] 生成失败', e)
    emit('error', e)
  }
}
watch(() => props.text, render)
onMounted(render)
</script>

<template>
  <img v-if="url" :src="url" :width="size || 160" :height="size || 160" class="qr" alt="二维码" />
</template>

<style scoped>
.qr { display: block; }
</style>
