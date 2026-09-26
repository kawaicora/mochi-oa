<script setup lang="ts">
/**
 * 会议/通话窗口入口（meeting.html）。
 * 所有音视频通话（私聊 / 群 / 会议）都复用 RtcCallRoom 通用组件，
 * 本文件只负责把 URL 查询参数转成 props 交给 RtcCallRoom。
 */
import RtcCallRoom from './RtcCallRoom.vue'

const q = new URLSearchParams(window.location.search)
const mode: 'create' | 'join' = q.get('mode') === 'join' ? 'join' : 'create'
const kind: 'video' | 'voice' = q.get('kind') === 'voice' ? 'voice' : 'video'
const meetingNo = q.get('meetingNo') ?? ''
const password = q.get('password') ?? ''
</script>

<template>
  <RtcCallRoom :mode="mode" :kind="kind" :meetingNo="meetingNo" :password="password" />
</template>

<style>
/* 独立通话/会议窗口：整页深色，杜绝底部/四周白色 */
html,
body,
#app {
  height: 100%;
  margin: 0;
  background: #0d1117;
}
</style>
