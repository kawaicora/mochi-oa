<script setup lang="ts">
import { useRtcStore } from '../stores/rtc'

const rtc = useRtcStore()
</script>

<template>
  <!-- 私聊来电 -->
  <Teleport to="body">
    <div v-if="rtc.incomingDm" class="call-modal-overlay">
      <div class="call-modal">
        <div class="call-modal-avatar">
          <i :class="rtc.incomingDm.kind === 'video' ? 'fas fa-video' : 'fas fa-phone'"></i>
        </div>
        <div class="call-modal-name">{{ rtc.incomingDm.from.nick }}</div>
        <div class="call-modal-type">
          {{ rtc.incomingDm.kind === 'video' ? '视频通话' : '语音通话' }}
        </div>
        <div class="call-modal-ringing">
          <span class="ring-dot"></span>
          <span class="ring-dot"></span>
          <span class="ring-dot"></span>
        </div>
        <div class="call-modal-actions">
          <button class="call-btn reject" @click="rtc.rejectDm()" title="拒绝">
            <i class="fas fa-phone-slash"></i>
          </button>
          <button class="call-btn accept" @click="rtc.answerDm()" title="接受">
            <i class="fas fa-phone"></i>
          </button>
        </div>
      </div>
    </div>
  </Teleport>

  <!-- 群通话邀请 -->
  <Teleport to="body">
    <div v-if="rtc.incomingGroup" class="call-modal-overlay">
      <div class="call-modal">
        <div class="call-modal-avatar group">
          <i class="fas fa-users"></i>
        </div>
        <div class="call-modal-name">群通话邀请</div>
        <div class="call-modal-type">
          {{ rtc.incomingGroup.kind === 'video' ? '群视频通话' : '群语音通话' }}
        </div>
        <div class="call-modal-from">来自：{{ rtc.incomingGroup.from.nick }}</div>
        <div class="call-modal-actions">
          <button class="call-btn ignore" @click="rtc.incomingGroup = null" title="忽略">
            <i class="fas fa-times"></i>
          </button>
          <button class="call-btn accept" @click="rtc.joinGroupCall()" title="加入">
            <i class="fas fa-phone"></i>
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.call-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
}

.call-modal {
  background: #161b22;
  border-radius: 16px;
  padding: 40px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  min-width: 300px;
}

.call-modal-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  background: #30363d;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 36px;
  color: #e6edf3;
  margin-bottom: 8px;
}
.call-modal-avatar.group {
  background: #722ed1;
}

.call-modal-name {
  font-size: 22px;
  font-weight: 600;
  color: #e6edf3;
}

.call-modal-type {
  font-size: 14px;
  color: #8b949e;
}

.call-modal-from {
  font-size: 13px;
  color: #8b949e;
}

.call-modal-ringing {
  display: flex;
  gap: 6px;
  margin: 8px 0;
}
.ring-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #00b42a;
  animation: ringPulse 1.2s ease-in-out infinite;
}
.ring-dot:nth-child(2) {
  animation-delay: 0.2s;
}
.ring-dot:nth-child(3) {
  animation-delay: 0.4s;
}
@keyframes ringPulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.2); }
}

.call-modal-actions {
  display: flex;
  gap: 32px;
  margin-top: 16px;
}

.call-btn {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  border: none;
  font-size: 22px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: transform 0.1s, opacity 0.2s;
  color: #fff;
}
.call-btn:hover {
  transform: scale(1.08);
}
.call-btn:active {
  transform: scale(0.95);
}

.call-btn.accept {
  background: #00b42a;
}
.call-btn.accept:hover {
  background: #009a26;
}

.call-btn.reject,
.call-btn.ignore {
  background: #f53f3f;
}
.call-btn.reject:hover,
.call-btn.ignore:hover {
  background: #d9363e;
}
</style>
