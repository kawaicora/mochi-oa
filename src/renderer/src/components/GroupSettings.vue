<script setup lang="ts">
/**
 * 群设置弹窗：群主/管理员管理（禁言、加人、踢人、设/取消管理员），普通成员可邀请。
 * 群主可转让群主/解散群；成员头像右键：私信 / 语音通话 / 视频通话 / 设置管理员 / 移出群聊。
 * 成员变更（服务端广播 group:members-updated）会自动刷新。
 */
import { ref, computed } from 'vue'
import { useAppStore } from '../stores/app'
import { useServerStore } from '../stores/server'
import { useRtcStore } from '../stores/rtc'
import UserAvatar from './UserAvatar.vue'
import type { ServerGroupMember } from '@shared/server-types'

const app = useAppStore()
const server = useServerStore()
const rtc = useRtcStore()
/** 当前登录用户 id */
const myId = computed(() => server.state.userId ?? 0)

type PickMode = 'add' | 'invite' | 'transfer' | null
const pickMode = ref<PickMode>(null)

const roleTag = (r?: string): string => (r === 'owner' ? '群主' : r === 'admin' ? '管理员' : '成员')
const isMuted = (m: ServerGroupMember): boolean => !!m.mutedUntil && new Date(m.mutedUntil).getTime() > Date.now()
const isSelf = (m: ServerGroupMember): boolean => m.userId === myId.value

/** 公司成员候选（排除已在群中） */
const candidates = computed(() => {
  const inGroup = new Set(app.groupSettingsMembers.map((m) => m.userId))
  return app.members.filter((m) => !inGroup.has(m.userId))
})
/** 转让群主候选：群成员排除自己 */
const transferTargets = computed(() =>
  app.groupSettingsMembers.filter((m) => m.userId !== myId.value))

/** 右键菜单 */
const ctxMenu = ref<{ x: number; y: number; m: ServerGroupMember } | null>(null)
function openCtx(e: MouseEvent, m: ServerGroupMember): void {
  ctxMenu.value = { x: e.clientX, y: e.clientY, m }
}
function closeCtx(): void {
  ctxMenu.value = null
}
function canKick(m: ServerGroupMember): boolean {
  return opsOf(m).includes('kick')
}
function canSetAdmin(m: ServerGroupMember): boolean {
  return opsOf(m).includes('setAdmin')
}

function flash(msg: string): void {
  const el = document.createElement('div')
  el.textContent = msg
  el.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 16px;border-radius:8px;z-index:9999;font-size:13px;'
  document.body.appendChild(el)
  setTimeout(() => el.remove(), 2200)
}

async function doSetAdmin(m: ServerGroupMember): Promise<void> {
  if (!window.confirm(`确定将 ${m.nick || m.username} 设为群管理员？`)) return
  const r = await app.setGroupAdmin(m.userId)
  if (r.ok) flash('已设为管理员'); else flash(r.error || '操作失败')
  closeCtx()
}
async function doUnsetAdmin(m: ServerGroupMember): Promise<void> {
  if (!window.confirm(`确定取消 ${m.nick || m.username} 的管理员？`)) return
  const r = await app.unsetGroupAdmin(m.userId)
  if (r.ok) flash('已取消管理员'); else flash(r.error || '操作失败')
  closeCtx()
}
async function doMute(m: ServerGroupMember): Promise<void> {
  if (isMuted(m)) {
    const r = await app.muteGroupMember(m.userId, 0)
    if (r.ok) flash('已解除禁言'); else flash(r.error || '操作失败')
    return
  }
  const input = window.prompt('禁言时长（秒），0 为立即解禁', '600')
  if (input === null) return
  const sec = Number(input)
  if (!Number.isFinite(sec) || sec < 0) return flash('时长不合法')
  const r = await app.muteGroupMember(m.userId, sec)
  if (r.ok) flash(sec > 0 ? `已禁言 ${sec} 秒` : '已解除禁言'); else flash(r.error || '操作失败')
}
async function doKick(m: ServerGroupMember): Promise<void> {
  if (!window.confirm(`确定将 ${m.nick || m.username} 移出该群？`)) return
  const r = await app.kickGroupMemberUi(m.userId)
  if (r.ok) flash('已移出'); else flash(r.error || '操作失败')
  closeCtx()
}
async function doPick(u: { userId: number; username?: string; nick?: string }): Promise<void> {
  if (pickMode.value === 'add') {
    const r = await app.addGroupMember(u.userId)
    if (r.ok) flash(`已将 ${u.nick || u.username} 加入群`); else flash(r.error || '添加失败')
  } else if (pickMode.value === 'invite') {
    const r = await app.inviteGroupMember(u.userId)
    if (r.ok) flash(`已向 ${u.nick || u.username || ''} 发送群邀请`); else flash(r.error || '邀请失败')
  } else if (pickMode.value === 'transfer') {
    if (!window.confirm(`确定将群主转让给 ${u.nick || u.username || ''}？转让后你将成为管理员。`)) { pickMode.value = null; return }
    const r = await app.transferGroupOwner(u.userId)
    if (r.ok) flash('群主已转让'); else flash(r.error || '转让失败')
  }
  pickMode.value = null
}
async function doDissolve(): Promise<void> {
  if (!window.confirm('解散该群将删除所有消息且不可恢复，确定解散？')) return
  const r = await app.dissolveGroup()
  if (r.ok) flash('群已解散'); else flash(r.error || '解散失败')
}
async function doLeave(): Promise<void> {
  if (!window.confirm('确定退出该群？')) return
  const r = await app.leaveGroup(app.groupSettingsId)
  if (r.ok) { app.closeGroupSettings(); void app.refreshConversations(); flash('已退出群'); } else flash(r.error || '退出失败')
}
/** 私信 */
function dm(m: ServerGroupMember): void {
  app.openDm(m.userId, m.nick || m.username || '')
  app.closeGroupSettings()
}
/** 语音/视频通话 */
function call(m: ServerGroupMember, kind: 'voice' | 'video'): void {
  void rtc.startDmCall(m.userId, kind)
  app.closeGroupSettings()
}

/** 当前用户对该成员的可用操作 */
function opsOf(m: ServerGroupMember): string[] {
  const my = app.groupSettingsMyRole
  const t = m.role
  const out: string[] = []
  if (m.userId === myId.value) return out
  if (my === 'owner') {
    if (t === 'admin') { out.push('unsetAdmin', 'kick') }
    else if (t === 'member') { out.push('setAdmin', 'mute', 'kick') }
  } else if (my === 'admin') {
    if (t === 'member') out.push('mute', 'kick')
  }
  return out
}
</script>

<template>
  <div class="gs-mask" @click.self="app.closeGroupSettings()">
    <div class="gs-panel">
      <header class="gs-head">
        <div class="gs-title">
          <i class="fas fa-users"></i>&nbsp;{{ app.groupSettingsName }}
          <span class="gs-sub">群设置 · {{ app.groupSettingsMembers.length }} 人</span>
        </div>
        <button class="gs-close" title="关闭" @click="app.closeGroupSettings()"><i class="fas fa-times"></i></button>
      </header>

      <div class="gs-actions">
        <button v-if="app.canManageGroup" class="gs-btn" @click="pickMode = 'add'"><i class="fas fa-user-plus"></i> 加人</button>
        <button class="gs-btn" @click="pickMode = 'invite'"><i class="fas fa-envelope"></i> 邀请</button>
        <button v-if="app.isGroupOwner" class="gs-btn danger-btn" @click="pickMode = 'transfer'"><i class="fas fa-share"></i> 转让群主</button>
        <button v-if="app.isGroupOwner" class="gs-btn danger-btn" @click="doDissolve"><i class="fas fa-trash-alt"></i> 解散群</button>
        <button v-if="!app.isGroupOwner" class="gs-btn" @click="doLeave"><i class="fas fa-sign-out-alt"></i> 退出群</button>
        <span class="gs-tip">头像右键：私信/语音/视频/管理</span>
      </div>

      <!-- 成员列表 -->
      <div v-if="app.groupSettingsLoading" class="gs-hint">加载中…</div>
      <div v-else class="gs-list" @click.self="closeCtx">
        <div v-for="m in app.groupSettingsMembers" :key="m.userId" class="gs-member" @contextmenu.prevent="openCtx($event, m)">
          <UserAvatar :nick="m.nick || m.username" :avatar="m.avatar" :size="34" />
          <div class="gs-mi">
            <span class="gs-name">
              {{ m.nick || m.username }}
              <i v-if="isSelf(m)" class="gs-me">我</i>
              <i v-if="m.online" class="gs-online" title="在线"></i>
              <i v-if="isMuted(m)" class="fas fa-microphone-slash gs-muted" title="已禁言"></i>
            </span>
            <span class="gs-tag" :class="m.role">{{ roleTag(m.role) }}</span>
          </div>
          <div class="gs-ops">
            <button v-if="opsOf(m).includes('setAdmin')" class="gs-op" title="设为管理员" @click="doSetAdmin(m)"><i class="fas fa-crown"></i></button>
            <button v-if="opsOf(m).includes('unsetAdmin')" class="gs-op" title="取消管理员" @click="doUnsetAdmin(m)"><i class="fas fa-user-minus"></i></button>
            <button v-if="opsOf(m).includes('mute')" class="gs-op" title="禁言/解禁" @click="doMute(m)"><i class="fas fa-microphone-slash"></i></button>
            <button v-if="opsOf(m).includes('kick')" class="gs-op danger" title="移出群" @click="doKick(m)"><i class="fas fa-user-slash"></i></button>
          </div>
        </div>
        <div v-if="!app.groupSettingsMembers.length" class="gs-hint">（空群）</div>
      </div>

      <!-- 头像右键菜单 -->
      <div v-if="ctxMenu" class="gs-ctx" :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }" @click.stop>
        <button class="ctx-item" @click="dm(ctxMenu!.m); closeCtx()"><i class="fas fa-comment-dots"></i> 私信</button>
        <button class="ctx-item" @click="call(ctxMenu!.m, 'video'); closeCtx()"><i class="fas fa-video"></i> 通话</button>
        <template v-if="canSetAdmin(ctxMenu!.m)">
          <div class="ctx-sep"></div>
          <button class="ctx-item" @click="doSetAdmin(ctxMenu!.m)"><i class="fas fa-crown"></i> 设置管理员</button>
        </template>
        <template v-if="canKick(ctxMenu!.m)">
          <div class="ctx-sep"></div>
          <button class="ctx-item danger" @click="doKick(ctxMenu!.m)"><i class="fas fa-user-slash"></i> 移出群聊</button>
        </template>
      </div>

      <!-- 候选成员（加人/邀请/转让） -->
      <div v-if="pickMode" class="gs-pick-mask" @click.self="pickMode = null">
        <div class="gs-pick">
          <div class="gs-pick-head">
            {{ pickMode === 'add' ? '添加成员' : pickMode === 'invite' ? '邀请入群' : '转让群主' }}
            <button class="gs-close" @click="pickMode = null"><i class="fas fa-times"></i></button>
          </div>
          <div class="gs-pick-list">
            <div v-if="pickMode === 'transfer' && !transferTargets.length" class="gs-hint">没有可转让的成员</div>
            <div v-else-if="pickMode !== 'transfer' && !candidates.length" class="gs-hint">没有可添加的公司成员</div>
            <div v-for="u in (pickMode === 'transfer' ? transferTargets : candidates)" :key="u.userId" class="gs-pick-item" @click="doPick(u)">
              <UserAvatar :nick="u.nick || u.username" :avatar="u.avatar" :size="30" />
              <span>{{ u.nick || u.username }}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.gs-mask { position: fixed; inset: 0; background: rgba(0,0,0,0.45); display: flex; align-items: center; justify-content: center; z-index: 240; }
.gs-panel { position: relative; width: 440px; max-height: 78vh; display: flex; flex-direction: column; background: #fff; border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,0.3); overflow: hidden; }
.gs-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid #eee; }
.gs-title { font-size: 15px; font-weight: 600; display: flex; align-items: center; }
.gs-sub { font-size: 12px; color: #999; margin-left: 8px; font-weight: 400; }
.gs-close { background: none; border: none; font-size: 16px; color: #999; cursor: pointer; }
.gs-actions { display: flex; align-items: center; gap: 8px; padding: 10px 16px; border-bottom: 1px solid #f2f2f2; flex-wrap: wrap; }
.gs-btn { display: inline-flex; align-items: center; gap: 6px; border: 1px solid #d9d9d9; background: #fff; color: #333; border-radius: 6px; padding: 6px 12px; font-size: 13px; cursor: pointer; }
.gs-btn:hover { border-color: #1677ff; color: #1677ff; }
.gs-btn.danger-btn:hover { border-color: #ff4d4f; color: #ff4d4f; }
.gs-tip { font-size: 11px; color: #aaa; margin-left: auto; }
.gs-list { flex: 1; overflow-y: auto; padding: 6px 8px; }
.gs-member { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 8px; }
.gs-member:hover { background: #f6f8fa; }
.gs-mi { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.gs-name { font-size: 14px; display: flex; align-items: center; gap: 6px; }
.gs-me { font-style: normal; font-size: 11px; color: #1677ff; border: 1px solid #1677ff; border-radius: 4px; padding: 0 4px; }
.gs-online { width: 8px; height: 8px; border-radius: 50%; background: #52c41a; display: inline-block; }
.gs-muted { color: #ff4d4f; font-size: 12px; }
.gs-tag { font-size: 11px; padding: 0 6px; border-radius: 4px; align-self: flex-start; }
.gs-tag.owner { background: #fff7e6; color: #d48806; }
.gs-tag.admin { background: #e6f4ff; color: #1677ff; }
.gs-tag.member { background: #f0f0f0; color: #888; }
.gs-ops { display: flex; gap: 4px; }
.gs-op { background: none; border: none; color: #666; font-size: 13px; cursor: pointer; padding: 4px 6px; border-radius: 6px; }
.gs-op:hover { background: #e6f4ff; color: #1677ff; }
.gs-op.danger:hover { background: #fff1f0; color: #ff4d4f; }
.gs-hint { color: #bbb; font-size: 13px; text-align: center; padding: 20px; }
.gs-ctx { position: fixed; z-index: 300; min-width: 160px; background: #fff; border-radius: 8px; box-shadow: 0 8px 30px rgba(0,0,0,0.25); padding: 5px; }
.ctx-item { display: flex; align-items: center; gap: 8px; width: 100%; border: none; background: none; text-align: left; padding: 9px 12px; font-size: 13px; color: #333; cursor: pointer; border-radius: 6px; }
.ctx-item:hover { background: #e6f4ff; color: #1677ff; }
.ctx-item.danger:hover { background: #fff1f0; color: #ff4d4f; }
.ctx-sep { height: 1px; background: #f0f0f0; margin: 4px 8px; }
.gs-pick-mask { position: absolute; inset: 0; background: rgba(0,0,0,0.2); display: flex; align-items: center; justify-content: center; }
.gs-pick { width: 320px; max-height: 60vh; display: flex; flex-direction: column; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(0,0,0,0.25); }
.gs-pick-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-bottom: 1px solid #eee; font-weight: 600; }
.gs-pick-list { overflow-y: auto; padding: 6px; }
.gs-pick-item { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.gs-pick-item:hover { background: #e6f4ff; }
</style>
