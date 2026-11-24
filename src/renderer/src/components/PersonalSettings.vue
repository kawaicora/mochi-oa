<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useServerStore } from '../stores/server'
import UserAvatar from './UserAvatar.vue'

const emit = defineEmits<{ close: [] }>()

const server = useServerStore()

const tab = ref<'info' | 'security'>('info')

// 基本信息
const nick = ref(server.state.nick || server.state.username || '')
const avatar = ref('')
const phone = ref('')
const emergency = ref<Array<{ name: string; phone: string }>>([{ name: '', phone: '' }, { name: '', phone: '' }, { name: '', phone: '' }])
const saving = ref(false)
const error = ref('')
const tip = ref('')

// 修改密码
const oldPwd = ref('')
const newPwd = ref('')
const confirmPwd = ref('')
const pwdSaving = ref(false)
const pwdError = ref('')
const pwdTip = ref('')

onMounted(() => {
  // 回填当前用户头像（登录/重启后从服务端 auth:me 载入，不再回退默认）
  avatar.value = server.state.avatar || ''
  // 回填手机号与紧急联系人（拓展信息 JSON）
  phone.value = server.state.phone || ''
  if (server.state.extra) {
    try {
      const extra = JSON.parse(server.state.extra)
      const arr = Array.isArray(extra?.emergency) ? extra.emergency : []
      emergency.value = [0, 1, 2].map((i) => ({ name: arr[i]?.name ?? '', phone: arr[i]?.phone ?? '' }))
    } catch {
      /* 解析失败保持空白 */
    }
  }
})

async function onChangeAvatar(): Promise<void> {
  error.value = ''
  tip.value = ''
  const filePath = await window.pantry.pickFile()
  if (!filePath) return
  try {
    const ack = await window.pantry.serverUploadFile(filePath, 0)
    const d = ack.data as { url?: string } | undefined
    if (!ack.ok || !d?.url) {
      error.value = ack.error || '上传失败'
      return
    }
    avatar.value = d.url
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

async function onSave(): Promise<void> {
  if (saving.value) return
  saving.value = true
  error.value = ''
  tip.value = ''
  try {
    const ack = await window.pantry.serverUpdateProfile({
      nick: nick.value.trim() || undefined,
      avatar: avatar.value || undefined,
      phone: phone.value.trim() || undefined,
      extra: { emergency: emergency.value.map((e) => ({ name: e.name.trim(), phone: e.phone.trim() })) }
    })
    if (ack.ok) {
      tip.value = '已保存'
      setTimeout(() => emit('close'), 600)
    } else {
      error.value = ack.error || '服务端暂不支持该操作'
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function onChangePassword(): Promise<void> {
  if (pwdSaving.value) return
  pwdError.value = ''
  pwdTip.value = ''
  if (!oldPwd.value || !newPwd.value || !confirmPwd.value) {
    pwdError.value = '请填写完整'
    return
  }
  if (newPwd.value.length < 6 || newPwd.value.length > 128) {
    pwdError.value = '新密码长度需 6-128'
    return
  }
  if (newPwd.value !== confirmPwd.value) {
    pwdError.value = '两次输入的新密码不一致'
    return
  }
  pwdSaving.value = true
  try {
    const ack = await window.pantry.serverChangePassword(oldPwd.value, newPwd.value)
    if (ack.ok) {
      pwdTip.value = '密码已修改（其他设备已下线）'
      oldPwd.value = ''
      newPwd.value = ''
      confirmPwd.value = ''
    } else {
      pwdError.value = ack.error || '修改失败'
    }
  } catch (e) {
    pwdError.value = e instanceof Error ? e.message : String(e)
  } finally {
    pwdSaving.value = false
  }
}
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">个人设置</div>
      <!-- 二级标签：基本信息 / 安全 -->
      <div class="ps-tabs">
        <button class="ps-tab" :class="{ on: tab === 'info' }" @click="tab = 'info'">基本信息</button>
        <button class="ps-tab" :class="{ on: tab === 'security' }" @click="tab = 'security'">安全</button>
      </div>

      <div v-if="tab === 'info'" class="modal-body">
        <div class="ps-avatar-row">
          <UserAvatar :nick="nick || '?'" :avatar="avatar" :size="80" />
          <button class="dt-btn dt-btn-default" @click="onChangeAvatar">
            <i class="far fa-image"></i>&nbsp; 更换头像
          </button>
        </div>
        <div class="ps-field">
          <label class="ps-label">昵称</label>
          <input v-model="nick" class="ps-input" placeholder="请输入昵称" maxlength="24" />
        </div>
        <div class="ps-field">
          <label class="ps-label">手机号</label>
          <input v-model="phone" class="ps-input" placeholder="请输入手机号" maxlength="32" />
        </div>
        <div class="emg-block">
          <div class="emg-title"><i class="fas fa-phone-alt"></i>&nbsp;紧急联系人</div>
          <div v-for="(e, i) in emergency" :key="i" class="emg-row">
            <span class="emg-index">紧急联系人{{ i + 1 }}</span>
            <input v-model="e.name" class="ps-input emg-name" placeholder="姓名" maxlength="32" />
            <input v-model="e.phone" class="ps-input emg-phone" placeholder="手机号" maxlength="32" />
          </div>
        </div>
        <div v-if="error" class="ps-error">{{ error }}</div>
        <div v-if="tip" class="ps-tip">{{ tip }}</div>
      </div>

      <div v-else class="modal-body">
        <div class="sec-group">
          <div class="sec-title"><i class="fas fa-key"></i>&nbsp;修改密码</div>
          <div class="ps-field">
            <label class="ps-label">旧密码</label>
            <input v-model="oldPwd" type="password" class="ps-input" placeholder="当前登录密码" />
          </div>
          <div class="ps-field">
            <label class="ps-label">新密码</label>
            <input v-model="newPwd" type="password" class="ps-input" placeholder="6-128 位" />
          </div>
          <div class="ps-field">
            <label class="ps-label">确认新密码</label>
            <input v-model="confirmPwd" type="password" class="ps-input" placeholder="再次输入新密码" />
          </div>
          <div class="sec-row">
            <button class="dt-btn dt-btn-primary" :disabled="pwdSaving" @click="onChangePassword">
              {{ pwdSaving ? '修改中…' : '确认修改' }}
            </button>
          </div>
          <div v-if="pwdError" class="ps-error">{{ pwdError }}</div>
          <div v-if="pwdTip" class="ps-tip">{{ pwdTip }}</div>
        </div>
      </div>

      <div class="modal-foot">
        <button class="dt-btn dt-btn-default" @click="emit('close')">关闭</button>
        <button v-if="tab === 'info'" class="dt-btn dt-btn-primary" :disabled="saving" @click="onSave">
          {{ saving ? '保存中…' : '保存' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 110;
}
.modal {
  width: 440px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.15);
  overflow: hidden;
}
.modal-head {
  padding: 14px 18px;
  font-size: 15px;
  font-weight: 600;
  border-bottom: 1px solid var(--dt-border-light);
}
.ps-tabs {
  display: flex;
  gap: 4px;
  padding: 10px 18px 0;
}
.ps-tab {
  height: 32px;
  padding: 0 16px;
  border-radius: 6px 6px 0 0;
  font-size: 13px;
  color: var(--dt-text-2);
  border-bottom: 2px solid transparent;
}
.ps-tab.on {
  color: var(--dt-primary);
  font-weight: 600;
  border-bottom-color: var(--dt-primary);
}
.modal-body { padding: 18px; }
.modal-foot {
  padding: 12px 18px;
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  border-top: 1px solid var(--dt-border-light);
}
.ps-avatar-row {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 18px;
}
.ps-field { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.ps-label { font-size: 13px; color: var(--dt-text-2); }
.ps-input {
  height: 36px;
  border: 1px solid var(--dt-border);
  border-radius: 6px;
  padding: 0 12px;
  font-size: 13px;
  color: var(--dt-text);
  outline: none;
}
.ps-input:focus { border-color: var(--dt-primary); }
.ps-error { margin-top: 10px; font-size: 13px; color: var(--dt-danger); }
.ps-tip { margin-top: 10px; font-size: 13px; color: var(--dt-success); }
/* 紧急联系人 */
.emg-block { margin-top: 4px; margin-bottom: 12px; }
.emg-title { font-size: 13px; font-weight: 600; color: var(--dt-text); margin-bottom: 10px; }
.emg-row { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
.emg-index { flex-shrink: 0; font-size: 13px; color: var(--dt-text-2); width: 78px; }
.emg-name { flex: 1; min-width: 0; }
.emg-phone { flex: 1; min-width: 0; }
.dt-btn {
  height: 36px;
  padding: 0 16px;
  border-radius: 6px;
  font-size: 13px;
  border: 1px solid var(--dt-border);
  background: #fff;
  color: var(--dt-text-2);
  cursor: pointer;
}
.dt-btn:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.dt-btn-primary { background: var(--dt-primary); color: #fff; border-color: var(--dt-primary); }
.dt-btn-primary:hover { color: #fff; }
.dt-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

/* 安全相关菜单 */
.sec-group {
  margin-bottom: 22px;
}
.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dt-text);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sec-row {
  margin-top: 4px;
}
</style>
