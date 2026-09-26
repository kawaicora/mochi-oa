<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import UserAvatar from './UserAvatar.vue'
import type { ConversationItem } from '@shared/server-types'

const app = useAppStore()
const keyword = ref('')

const list = computed(() => {
  const k = keyword.value.trim().toLowerCase()
  const items = k
    ? app.conversations.filter((c) => c.name.toLowerCase().includes(k))
    : app.conversations
  return items.slice().sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0)
  )
})

function fmtTime(ts?: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const now = new Date()
  const sameDay = d.toDateString() === now.toDateString()
  const pad = (n: number) => String(n).padStart(2, '0')
  if (sameDay) return `${pad(d.getHours())}:${pad(d.getMinutes())}`
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function initials(name: string): string {
  return name ? name.slice(0, 1) : '?'
}
</script>

<template>
  <section class="conv-panel">
    <div class="conv-head">
      <div class="conv-title">消息</div>
      <button class="conv-add" title="发起会话（暂无新建入口）"><i class="fas fa-plus"></i></button>
    </div>
    <div class="conv-search">
      <i class="fas fa-search"></i>
      <input v-model="keyword" placeholder="搜索" />
    </div>
    <div class="conv-list">
      <div
        v-for="c in list"
        :key="c.conversationId"
        class="conv-item"
        :class="{ active: app.selected?.conversationId === c.conversationId }"
        @click="app.openConversation(c)"
        @contextmenu.prevent
      >
        <div class="conv-avatar" :class="{ dm: c.type === 'dm' }">
          <UserAvatar v-if="c.type === 'dm' && c.avatar" :nick="c.name" :avatar="c.avatar" :size="44" />
          <template v-else>
            <span>{{ initials(c.name) }}</span>
            <span v-if="c.type === 'dm' && app.onlineMap[c.dmUserId!] === false" class="offline-dot"></span>
          </template>
        </div>
        <div class="conv-mid">
          <div class="conv-name-row">
            <span class="conv-name">{{ c.name }}</span>
            <span class="conv-time">{{ fmtTime(c.lastMessageAt) }}</span>
          </div>
          <div class="conv-preview-row">
            <span class="conv-preview">{{ c.lastPreview || '' }}</span>
            <span v-if="c.pinned" class="conv-pin"><i class="fas fa-thumbtack"></i></span>
            <span v-if="c.unread > 0" class="conv-unread">{{ c.unread > 99 ? '99+' : c.unread }}</span>
          </div>
        </div>
      </div>
      <div v-if="list.length === 0" class="conv-empty">
        <i class="far fa-comment-dots"></i>
        <p>暂无会话</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.conv-panel {
  width: 280px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #fff;
  border-right: 1px solid var(--dt-border-light);
  min-height: 0;
}
.conv-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px 4px;
}
.conv-title {
  font-size: 17px;
  font-weight: 600;
}
.conv-add {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
}
.conv-add:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.conv-search {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 8px 14px 10px;
  height: 32px;
  padding: 0 10px;
  border-radius: 16px;
  background: var(--dt-bg-app);
  color: var(--dt-text-3);
  font-size: 13px;
}
.conv-search input {
  flex: 1;
  border: none;
  outline: none;
  background: transparent;
  font-size: 13px;
  color: var(--dt-text);
}
.conv-list {
  flex: 1;
  overflow-y: auto;
  padding: 0 8px 8px;
}
.conv-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 8px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.12s;
}
.conv-item:hover {
  background: var(--dt-hover);
}
.conv-item.active {
  background: #e8f3ff;
}
.conv-avatar {
  width: 44px;
  height: 44px;
  border-radius: 50%;
  background: linear-gradient(135deg, #0089ff, #5cb6ff);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 16px;
  font-weight: 500;
  flex-shrink: 0;
  position: relative;
}
.conv-avatar.dm {
  background: linear-gradient(135deg, #6b7bff, #9aa5ff);
}
.offline-dot {
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #c9cdd4;
  border: 2px solid #fff;
}
.conv-mid {
  flex: 1;
  min-width: 0;
}
.conv-name-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.conv-name {
  font-size: 14px;
  color: var(--dt-text);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-time {
  font-size: 12px;
  color: var(--dt-text-4);
  flex-shrink: 0;
  margin-left: 8px;
}
.conv-preview-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 2px;
}
.conv-preview {
  flex: 1;
  font-size: 12px;
  color: var(--dt-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.conv-pin {
  color: var(--dt-primary);
  font-size: 11px;
}
.conv-unread {
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 8px;
  background: var(--dt-danger);
  color: #fff;
  font-size: 11px;
  line-height: 16px;
  text-align: center;
}
.conv-empty {
  padding: 40px 0;
  text-align: center;
  color: var(--dt-text-4);
  font-size: 30px;
}
.conv-empty p {
  font-size: 13px;
  margin-top: 8px;
}
</style>
