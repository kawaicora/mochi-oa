<script setup lang="ts">
import { computed } from 'vue'
import { useServerStore } from '../stores/server'

const props = withDefaults(
  defineProps<{ nick?: string; avatar?: string; size?: number }>(),
  { size: 36 }
)

const server = useServerStore()
// 头像可能是服务端返回的相对路径（/files/...）→ 自动用当前 serverUrl 拼成绝对地址（同源可达）
const hasAvatar = computed(() => typeof props.avatar === 'string' && props.avatar.length > 0)
const src = computed(() => server.absFileUrl(props.avatar ?? ''))
const initial = computed(() => (props.nick ? props.nick.slice(0, 1) : '?'))
</script>

<template>
  <div
    class="user-avatar"
    :style="{ width: size + 'px', height: size + 'px' }"
  >
    <img
      v-if="hasAvatar"
      :src="src"
      :style="{ width: size + 'px', height: size + 'px', borderRadius: '50%', objectFit: 'cover' }"
      alt=""
    />
    <div
      v-else
      class="avatar-fallback"
      :style="{
        width: size + 'px',
        height: size + 'px',
        background: 'linear-gradient(135deg, #1677ff, #5cb6ff)',
        fontSize: Math.round(size * 0.4) + 'px'
      }"
    >
      {{ initial }}
    </div>
  </div>
</template>

<style scoped>
.user-avatar {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  overflow: hidden;
  flex-shrink: 0;
}
.avatar-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  color: #fff;
  font-weight: 500;
}
</style>
