<script setup lang="ts">
import { computed } from 'vue'
import { useAppStore } from '../stores/app'
import ImageViewer from './common/ImageViewer.vue'
import VideoViewer from './common/VideoViewer.vue'
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
  <ImageViewer v-if="kind === 'image'" :src="previewSrc" :alt="m.content" @close="emit('close')" />
  <VideoViewer
    v-else
    :src="m.content"
    :content="m.content"
    :name="m.content"
    @close="emit('close')"
  />
</template>
