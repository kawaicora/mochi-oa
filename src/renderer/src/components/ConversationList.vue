<script setup lang="ts">
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import UserAvatar from './UserAvatar.vue'
import type { ConversationItem } from '@shared/server-types'

const app = useAppStore()
const keyword = ref('')

// 发起会话（消息标题右侧加号）
const showLaunch = ref(false)
const showLaunchDm = ref(false)
const showLaunchCreate = ref(false)
const showLaunchJoin = ref(false)
const launchMsg = ref('')
const dmKeyword = ref('')
const dmResults = ref<Array<{ id: number; username: string; nick?: string; avatar?: string }>>([])
const dmSearching = ref(false)
const newGroupName = ref('')
const joinGroupCode = ref('')

async function searchLaunchDm(): Promise<void> {
  const k = dmKeyword.value.trim()
  if (!k) { dmResults.value = []; return }
  dmSearching.value = true
  launchMsg.value = ''
  try { dmResults.value = await app.searchUsers(k) }
  catch { dmResults.value = []; launchMsg.value = '搜索失败，请重试' }
  finally { dmSearching.value = false }
}
function startLaunchDm(u: { id: number; username: string; nick?: string }): void {
  showLaunchDm.value = false
  dmKeyword.value = ''
  dmResults.value = []
  void app.openDm(u.id, u.nick || u.username)
}
async function doLaunchCreateGroup(): Promise<void> {
  const name = newGroupName.value.trim()
  if (!name) return
  launchMsg.value = ''
  const r = await app.createGroup(name)
  if (r.ok) { showLaunchCreate.value = false; newGroupName.value = '' }
  else launchMsg.value = r.error || '创建群失败'
}
async function doLaunchJoinGroup(): Promise<void> {
  const code = joinGroupCode.value.trim()
  if (!code) return
  launchMsg.value = ''
  const r = await app.joinGroup(code)
  if (r.ok) { showLaunchJoin.value = false; joinGroupCode.value = '' }
  else launchMsg.value = r.error || '加入群失败'
}

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
      <button class="conv-add" title="发起会话" @click="showLaunch = !showLaunch"><i class="fas fa-plus"></i></button>
    </div>
    <div v-if="showLaunch" class="conv-add-menu">
      <button @click="showLaunchDm = true; showLaunch = false; launchMsg = ''"><i class="far fa-comment"></i> 发起私聊</button>
      <button @click="showLaunchCreate = true; showLaunch = false; launchMsg = ''"><i class="fas fa-users"></i> 创建群</button>
      <button @click="showLaunchJoin = true; showLaunch = false; launchMsg = ''"><i class="fas fa-sign-in-alt"></i> 加入群</button>
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

    <!-- 发起私聊 -->
    <div v-if="showLaunchDm" class="modal-mask" @click.self="showLaunchDm = false">
      <div class="modal">
        <div class="modal-head">发起私聊</div>
        <div class="modal-body">
          <div class="launch-row">
            <input v-model="dmKeyword" class="modal-input" placeholder="搜索用户 ID / 用户名 / 昵称" maxlength="64" @keyup.enter="searchLaunchDm" />
            <button class="dt-btn dt-btn-primary" :disabled="dmSearching" @click="searchLaunchDm">搜索</button>
          </div>
          <div v-if="dmResults.length" class="launch-users">
            <div v-for="u in dmResults" :key="u.id" class="launch-user" @click="startLaunchDm(u)">
              <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="32" />
              <div class="launch-uinfo">
                <div class="launch-uname">{{ u.nick || u.username }}</div>
                <div class="launch-usub">@{{ u.username }} · ID {{ u.id }}</div>
              </div>
            </div>
          </div>
          <div v-else-if="dmKeyword.trim()" class="launch-hint">未找到匹配用户</div>
        </div>
        <div class="modal-foot"><button class="dt-btn dt-btn-default" @click="showLaunchDm = false">取消</button></div>
      </div>
    </div>

    <!-- 创建群 -->
    <div v-if="showLaunchCreate" class="modal-mask" @click.self="showLaunchCreate = false">
      <div class="modal">
        <div class="modal-head">创建群</div>
        <div class="modal-body">
          <input v-model="newGroupName" class="modal-input" placeholder="群名称" maxlength="64" @keyup.enter="doLaunchCreateGroup" />
          <div v-if="launchMsg" class="launch-hint err">{{ launchMsg }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showLaunchCreate = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!newGroupName.trim()" @click="doLaunchCreateGroup">创建</button>
        </div>
      </div>
    </div>

    <!-- 加入群 -->
    <div v-if="showLaunchJoin" class="modal-mask" @click.self="showLaunchJoin = false">
      <div class="modal">
        <div class="modal-head">加入群</div>
        <div class="modal-body">
          <input v-model="joinGroupCode" class="modal-input" placeholder="输入群加入码" maxlength="32" @keyup.enter="doLaunchJoinGroup" />
          <div v-if="launchMsg" class="launch-hint err">{{ launchMsg }}</div>
        </div>
        <div class="modal-foot">
          <button class="dt-btn dt-btn-default" @click="showLaunchJoin = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="!joinGroupCode.trim()" @click="doLaunchJoinGroup">加入</button>
        </div>
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
  position: relative;
}
.conv-add-menu {
  position: absolute;
  top: 42px;
  right: 12px;
  width: 176px;
  background: #fff;
  border: 1px solid var(--dt-border-light);
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.14);
  z-index: 60;
  padding: 4px;
}
.conv-add-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-text);
  text-align: left;
}
.conv-add-menu button:hover {
  background: var(--dt-hover);
}
.launch-row { display: flex; gap: 8px; }
.launch-users { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; max-height: 40vh; overflow-y: auto; }
.launch-user { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; background: var(--dt-hover); cursor: pointer; }
.launch-user:hover { background: #e8f3ff; }
.launch-uinfo { flex: 1; min-width: 0; }
.launch-uname { font-size: 14px; color: var(--dt-text); }
.launch-usub { font-size: 12px; color: var(--dt-text-3); }
.launch-hint { font-size: 13px; color: var(--dt-text-4); text-align: center; padding: 12px 0; }
.launch-hint.err { color: var(--dt-danger); text-align: left; padding: 8px 0 0; }
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
