<script setup lang="ts">
/**
 * 全局设置（应用级，与个人信息无关）：
 *  - 服务器：连接地址/端口 + 文件夹下载目录
 *  - 通知：消息提示音 / 来电铃声 / 全局免打扰
 *  - 启动：开机自启
 *  - 主邮件：仅服务器管理员可配 SMTP
 */
import { ref, reactive, onMounted } from 'vue'
import { useServerStore } from '../stores/server'
import { useAppStore } from '../stores/app'
import type { HotkeyAction, HotkeyConfig, HotkeyConflict } from '@shared/hotkey'

const emit = defineEmits<{ close: [] }>()

const server = useServerStore()
const app = useAppStore()

const tab = ref<'server' | 'notify' | 'launch' | 'hotkey' | 'mail'>('server')

// ── 服务器连接 ──
const srvHost = ref('')
const srvPort = ref('')
const srvProtocol = ref<'http' | 'https'>('http')
const srvError = ref('')
const srvPreview = ref('')
const downloadDir = ref('')

function buildUrl(): string {
  const host = srvHost.value.trim() || '127.0.0.1'
  const port = srvPort.value.trim() || '3000'
  return `${srvProtocol.value}://${host}:${port}`
}
async function chooseDownloadDir(): Promise<void> {
  const p = await window.pantry.pickFolder()
  if (p) downloadDir.value = p
}
async function saveServer(): Promise<void> {
  const url = buildUrl()
  srvError.value = ''
  try {
    await window.pantry.serverSaveSettings({ downloadDir: downloadDir.value.trim() || undefined })
    // 换服务器：清 token + 断旧会话 + 用新地址重连（渲染层随之回登录页）
    await server.changeServerUrl(url)
    emit('close')
  } catch (e) {
    srvError.value = e instanceof Error ? e.message : String(e)
  }
}

// ── 通知 ──
function shortName(p: string): string {
  return p.split(/[\\/]/).pop() || p
}
async function pickSound(which: 'message' | 'call'): Promise<void> {
  const p = await window.pantry.pickFile()
  if (!p) return
  if (which === 'message') await app.saveNotifyCfg({ messageSoundFile: p })
  else await app.saveNotifyCfg({ callSoundFile: p })
}

// ── 启动 ──
const autoLaunch = ref(false)
const autoLaunchError = ref('')
const elevated = ref(false)
async function onAutoLaunchChange(): Promise<void> {
  const want = !autoLaunch.value
  try {
    const r = await window.pantry.setAutoLaunch(want)
    autoLaunch.value = r.openAtLogin
    if (!r.ok || r.openAtLogin !== want) {
      autoLaunchError.value = r.error
        ? `设置开机自启失败：${r.error}`
        : '设置开机自启失败，系统未接受该设置（可能需要管理员权限）'
    } else {
      autoLaunchError.value = ''
    }
    elevated.value = await window.pantry.isElevated()
  } catch (e) {
    autoLaunchError.value = `调用失败：${e instanceof Error ? e.message : String(e)}`
  }
}

// ── 主邮件（仅 SERVER_ADMIN）──
const mailServerAdmin = ref(false)
const mailSource = ref<'env' | 'db'>('db')
const mailCanEdit = ref(false)
const mailForm = reactive({ email: '', displayName: '', host: '', port: 465, secure: true, user: '', password: '' })
const mailSaving = ref(false)
const mailTip = ref('')
const mailError = ref('')

async function loadMainMail(): Promise<void> {
  try {
    const ack = await window.pantry.serverGetMainMail()
    if (!ack.ok || !ack.data) {
      mailError.value = ack.error || '获取主邮件配置失败'
      return
    }
    mailServerAdmin.value = ack.data.serverAdmin
    mailSource.value = ack.data.source
    mailCanEdit.value = ack.data.canEdit
    const c = ack.data.config
    if (c) {
      mailForm.email = c.email
      mailForm.displayName = c.displayName
      mailForm.host = c.host
      mailForm.port = c.port
      mailForm.secure = c.secure
      mailForm.user = c.user
      mailForm.password = ''
    }
  } catch (e) {
    mailError.value = e instanceof Error ? e.message : String(e)
  }
}

async function onSaveMainMail(): Promise<void> {
  if (mailSaving.value) return
  mailSaving.value = true
  mailTip.value = ''
  mailError.value = ''
  try {
    if (!mailForm.email.trim() || !mailForm.host.trim()) {
      mailError.value = '发信地址与 SMTP 主机必填'
      return
    }
    const ack = await window.pantry.serverSetMainMail({
      email: mailForm.email.trim(),
      displayName: mailForm.displayName.trim() || undefined,
      host: mailForm.host.trim(),
      port: Number(mailForm.port) || 465,
      secure: mailForm.secure,
      user: mailForm.user.trim() || undefined,
      password: mailForm.password
    })
    if (ack.ok) {
      mailTip.value = '主邮件配置已保存并生效'
      mailForm.password = ''
      await loadMainMail()
    } else {
      mailError.value = ack.error || '保存失败'
    }
  } catch (e) {
    mailError.value = e instanceof Error ? e.message : String(e)
  } finally {
    mailSaving.value = false
  }
}

// ── 全局快捷键 ──
const HOTKEY_META: Record<HotkeyAction, { label: string; desc: string }> = {
  remoteUnlock: { label: '解锁被控端鼠标', desc: '远程控制期间按此快捷键，解锁被控端被锁定的本地鼠标（解冻并显示光标）' },
  screenshot: { label: '截图发送', desc: '打开截图编辑器，框选/标注后保存并发送到当前会话' }
}
const hk = ref<HotkeyConfig>({
  remoteUnlock: { enabled: true, accelerator: 'Ctrl+Enter' },
  screenshot: { enabled: false, accelerator: '' }
})
const hkConflicts = ref<HotkeyConflict[]>([])
/** 正在录制组合键的动作；null 表示空闲 */
const recording = ref<HotkeyAction | null>(null)

function conflictOf(a: HotkeyAction): HotkeyConflict | undefined {
  return hkConflicts.value.find((c) => c.action === a)
}

/** 把键盘事件转成 Electron accelerator；只按修饰键返回空串（不成立） */
function eventToAccelerator(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  if (e.metaKey) parts.push('Meta')
  let key = e.key
  if (['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'Escape'].includes(key)) return ''
  if (key === ' ') key = 'Space'
  else if (key.length === 1) key = key.toUpperCase()
  parts.push(key)
  return parts.join('+')
}

function startRecord(a: HotkeyAction): void {
  recording.value = a
}

function onRecordKey(a: HotkeyAction, e: KeyboardEvent): void {
  if (recording.value !== a) return
  e.preventDefault()
  e.stopPropagation()
  // Esc 清空当前组合键
  if (e.key === 'Escape') {
    hk.value[a].accelerator = ''
    hk.value[a].enabled = false
    recording.value = null
    void saveHotkey()
    return
  }
  const acc = eventToAccelerator(e)
  if (!acc) return
  hk.value[a].accelerator = acc
  hk.value[a].enabled = true
  recording.value = null
  void saveHotkey()
}

async function toggleHotkey(a: HotkeyAction): Promise<void> {
  hk.value[a].enabled = !hk.value[a].enabled
  await saveHotkey()
}

async function saveHotkey(): Promise<void> {
  const r = await window.pantry.hotkeySet(structuredClone(hk.value))
  hk.value = r.config
  hkConflicts.value = r.conflicts
}

onMounted(async () => {
  const cfg = await window.pantry.serverGetSettings()
  downloadDir.value = cfg.downloadDir || ''
  try {
    const u = new URL(cfg.serverUrl)
    srvProtocol.value = u.protocol === 'https:' ? 'https' : 'http'
    srvHost.value = u.hostname
    srvPort.value = u.port || (u.protocol === 'https:' ? '443' : '80')
  } catch {
    srvHost.value = '127.0.0.1'; srvPort.value = '3000'; srvProtocol.value = 'http'
  }
  srvPreview.value = buildUrl()
  autoLaunch.value = await window.pantry.getAutoLaunch()
  elevated.value = await window.pantry.isElevated()
  try {
    const hr = await window.pantry.hotkeyGet()
    hk.value = hr.config
    hkConflicts.value = hr.conflicts
  } catch (e) {
    console.warn('[settings] 读取快捷键配置失败：', e)
  }
  void loadMainMail()
})
</script>

<template>
  <div class="modal-mask" @click.self="emit('close')">
    <div class="modal">
      <div class="modal-head">设置</div>
      <div class="ps-tabs">
        <button class="ps-tab" :class="{ on: tab === 'server' }" @click="tab = 'server'">服务器</button>
        <button class="ps-tab" :class="{ on: tab === 'notify' }" @click="tab = 'notify'">通知</button>
        <button class="ps-tab" :class="{ on: tab === 'launch' }" @click="tab = 'launch'">启动</button>
        <button class="ps-tab" :class="{ on: tab === 'hotkey' }" @click="tab = 'hotkey'">快捷键</button>
        <button v-if="mailServerAdmin" class="ps-tab" :class="{ on: tab === 'mail' }" @click="tab = 'mail'">主邮件</button>
      </div>

      <!-- 服务器连接 -->
      <div v-if="tab === 'server'" class="modal-body">
        <p class="modal-desc">填写连接的服务端地址与端口</p>
        <div class="srv-row">
          <select v-model="srvProtocol" class="srv-select"><option value="http">http://</option><option value="https">https://</option></select>
          <input v-model="srvHost" class="srv-input" placeholder="127.0.0.1" />
          <span class="srv-colon">:</span>
          <input v-model="srvPort" class="srv-input srv-port" placeholder="3000" />
        </div>
        <div v-if="srvError" class="srv-error">{{ srvError }}</div>
        <p class="srv-preview">连接地址：{{ buildUrl() }}</p>

        <p class="modal-desc dl-desc">文件夹下载目录</p>
        <div class="srv-row">
          <input v-model="downloadDir" class="srv-input" placeholder="例如：Documents/麻薯" />
          <button class="dt-btn" @click="chooseDownloadDir"><i class="far fa-folder-open"></i>&nbsp;浏览</button>
        </div>
        <p class="srv-hint">接收到的文件夹将下载到此目录（按原结构建子目录）</p>
      </div>

      <!-- 通知 -->
      <div v-else-if="tab === 'notify'" class="modal-body">
        <div class="sec-group">
          <div class="sec-title"><i class="fas fa-bell"></i>&nbsp;消息通知</div>
          <label class="switch-row">
            <span class="switch-label">新消息播放提示音</span>
            <span class="switch" :class="{ on: app.notifyCfg.notifySound }" @click="app.saveNotifyCfg({ notifySound: !app.notifyCfg.notifySound })">
              <i class="switch-knob"></i>
            </span>
          </label>
          <div class="ps-field">
            <label class="ps-label">消息提示音文件</label>
            <div class="file-row">
              <span class="file-name" :title="app.notifyCfg.messageSoundFile">
                {{ app.notifyCfg.messageSoundFile ? shortName(app.notifyCfg.messageSoundFile) : '默认（resources/message.wav）' }}
              </span>
              <button class="dt-btn" @click="pickSound('message')">选择</button>
              <button v-if="app.notifyCfg.messageSoundFile" class="dt-btn" @click="app.saveNotifyCfg({ messageSoundFile: '' })">恢复默认</button>
            </div>
          </div>
          <p class="sec-hint">自定义文件丢失会自动回退默认提示音</p>
        </div>

        <div class="sec-group">
          <div class="sec-title"><i class="fas fa-phone-alt"></i>&nbsp;来电 / 会议</div>
          <label class="switch-row">
            <span class="switch-label">来电与会议邀请播放铃声</span>
            <span class="switch" :class="{ on: app.notifyCfg.callSound }" @click="app.saveNotifyCfg({ callSound: !app.notifyCfg.callSound })">
              <i class="switch-knob"></i>
            </span>
          </label>
          <div class="ps-field">
            <label class="ps-label">来电铃声文件</label>
            <div class="file-row">
              <span class="file-name" :title="app.notifyCfg.callSoundFile">
                {{ app.notifyCfg.callSoundFile ? shortName(app.notifyCfg.callSoundFile) : '默认（resources/calling.mp3）' }}
              </span>
              <button class="dt-btn" @click="pickSound('call')">选择</button>
              <button v-if="app.notifyCfg.callSoundFile" class="dt-btn" @click="app.saveNotifyCfg({ callSoundFile: '' })">恢复默认</button>
            </div>
          </div>
          <p class="sec-hint">接听 / 拒接 / 对方取消时会自动停铃；单个群或个人可在聊天窗口标题栏单独设置铃声</p>
        </div>

        <div class="sec-group">
          <div class="sec-title"><i class="fas fa-bell-slash"></i>&nbsp;免打扰</div>
          <label class="switch-row">
            <span class="switch-label">全局免打扰（静音所有消息提示音）</span>
            <span class="switch" :class="{ on: app.notifyCfg.dnd }" @click="app.saveNotifyCfg({ dnd: !app.notifyCfg.dnd })">
              <i class="switch-knob"></i>
            </span>
          </label>
          <p class="sec-hint">
            来电铃声不受免打扰影响（避免漏接）；单独屏蔽某个群或个人，在该聊天窗口的标题栏里切换。
            <template v-if="app.notifyCfg.dndConvs.length">已单独免打扰 {{ app.notifyCfg.dndConvs.length }} 个会话。</template>
          </p>
        </div>
      </div>

      <!-- 启动 -->
      <div v-else-if="tab === 'launch'" class="modal-body">
        <div class="sec-group">
          <div class="sec-title"><i class="fas fa-rocket"></i>&nbsp;开机自启</div>
          <label class="switch-row">
            <span class="switch-label">开机时自动启动并进入后台托盘</span>
            <span class="switch" :class="{ on: autoLaunch }" @click="onAutoLaunchChange">
              <i class="switch-knob"></i>
            </span>
          </label>
          <p class="sec-hint">
            Windows 写入注册表启动项，Linux 写入 ~/.config/autostart（并注册 systemd 用户服务），
            macOS 写入系统登录项；开机后静默驻留托盘，不弹窗。
          </p>
          <p v-if="!elevated" class="sec-hint" style="color:var(--dt-text-3)">
            <i class="fas fa-shield-alt"></i> 当前非管理员运行，设置开机自启时会请求系统授权
          </p>
          <p v-else class="sec-hint" style="color:#52c41a">
            <i class="fas fa-shield-alt"></i> 已以管理员权限运行
          </p>
          <p v-if="autoLaunchError" class="sec-hint sec-hint-error">{{ autoLaunchError }}</p>
        </div>
      </div>

      <!-- 快捷键 -->
      <div v-else-if="tab === 'hotkey'" class="modal-body">
        <p class="modal-desc">全局快捷键在应用内任意位置生效；点击组合键框后直接按下想要的组合，Esc 清除。</p>
        <div v-for="a in (['remoteUnlock', 'screenshot'] as HotkeyAction[])" :key="a" class="hk-row">
          <div class="hk-head">
            <div class="hk-text">
              <div class="hk-label">{{ HOTKEY_META[a].label }}</div>
              <div class="hk-desc">{{ HOTKEY_META[a].desc }}</div>
            </div>
            <span class="switch" :class="{ on: hk[a].enabled }" @click="toggleHotkey(a)">
              <i class="switch-knob"></i>
            </span>
          </div>
          <div class="hk-control">
            <button
              class="hk-capture"
              :class="{ recording: recording === a }"
              @click="startRecord(a)"
              @keydown="onRecordKey(a, $event)"
              :title="recording === a ? '请按下组合键，Esc 清除' : '点击录制组合键'"
            >
              {{ recording === a ? '请按键…' : hk[a].accelerator || '未设置' }}
            </button>
            <span v-if="conflictOf(a)" class="hk-warn">
              <i class="fas fa-triangle-exclamation"></i>&nbsp;{{ conflictOf(a)!.reason }}
            </span>
          </div>
        </div>
      </div>

      <!-- 主邮件 -->
      <div v-else class="modal-body">
        <div v-if="!mailServerAdmin" class="mail-banner">
          <i class="fas fa-shield-alt"></i>&nbsp;仅服务器管理员（SERVER_ADMIN）可配置主邮件
        </div>
        <template v-else>
          <div v-if="mailSource === 'env'" class="mail-env-tip">
            <i class="fas fa-server"></i>&nbsp;主邮件已由服务器环境配置（.env / Docker 的 MAIL_* 变量），如需修改请在服务器端编辑 .env 后重启服务。
          </div>
          <div class="mail-grid">
            <div class="ps-field">
              <label class="ps-label">发信地址</label>
              <input v-model="mailForm.email" class="ps-input" placeholder="admin@example.com" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">发件人名称</label>
              <input v-model="mailForm.displayName" class="ps-input" placeholder="如 OA 通知" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">SMTP 主机</label>
              <input v-model="mailForm.host" class="ps-input" placeholder="smtp.example.com" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">SMTP 端口</label>
              <input v-model.number="mailForm.port" class="ps-input" placeholder="465" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">SMTP 用户名</label>
              <input v-model="mailForm.user" class="ps-input" placeholder="留空默认同发信地址" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">SMTP 密码</label>
              <input v-model="mailForm.password" type="password" class="ps-input" :placeholder="mailCanEdit ? '留空则保持当前密码' : '（已隐藏）'" :readonly="!mailCanEdit" />
            </div>
            <div class="ps-field">
              <label class="ps-label">加密方式</label>
              <label class="switch-row" :class="{ disabled: !mailCanEdit }">
                <span class="switch-label">SSL / TLS 加密</span>
                <span class="switch" :class="{ on: mailForm.secure }" @click="mailCanEdit && (mailForm.secure = !mailForm.secure)">
                  <i class="switch-knob"></i>
                </span>
              </label>
            </div>
          </div>
          <div class="sec-row" v-if="mailCanEdit">
            <button class="dt-btn dt-btn-primary" :disabled="mailSaving" @click="onSaveMainMail">
              {{ mailSaving ? '保存中…' : '保存并启用' }}
            </button>
          </div>
          <div v-if="mailError" class="ps-error">{{ mailError }}</div>
          <div v-if="mailTip" class="ps-tip">{{ mailTip }}</div>
        </template>
      </div>

      <div class="modal-foot">
        <button class="dt-btn dt-btn-default" @click="emit('close')">关闭</button>
        <button v-if="tab === 'server'" class="dt-btn dt-btn-primary" @click="saveServer">保存并连接</button>
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
.sec-group { margin-bottom: 22px; }
.sec-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--dt-text);
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.sec-row { margin-top: 4px; }
.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 0;
  cursor: pointer;
}
.switch-label { font-size: 13px; color: var(--dt-text); flex: 1; }
.switch {
  position: relative;
  width: 42px;
  height: 22px;
  border-radius: 11px;
  background: #d5d9e0;
  flex-shrink: 0;
  transition: background 0.2s;
}
.switch.on { background: var(--dt-primary); }
.switch-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: #fff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: left 0.2s;
}
.switch.on .switch-knob { left: 22px; }
.sec-hint { font-size: 12px; color: var(--dt-text-4); margin-top: 4px; }
.sec-hint-error { color: #f53f3f; }
/* 快捷键 */
.hk-row { padding: 12px 0; border-bottom: 1px solid var(--dt-border-light); }
.hk-row:last-child { border-bottom: none; }
.hk-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.hk-text { flex: 1; min-width: 0; }
.hk-label { font-size: 13px; font-weight: 600; color: var(--dt-text); }
.hk-desc { font-size: 12px; color: var(--dt-text-4); margin-top: 4px; line-height: 1.5; }
.hk-control { display: flex; align-items: center; gap: 10px; margin-top: 10px; }
.hk-capture {
  min-width: 132px;
  height: 34px;
  padding: 0 14px;
  border: 1px dashed var(--dt-border);
  border-radius: 6px;
  background: #fff;
  color: var(--dt-text-2);
  font-size: 13px;
  cursor: pointer;
}
.hk-capture:hover { border-color: var(--dt-primary); color: var(--dt-primary); }
.hk-capture.recording { border-style: solid; border-color: var(--dt-primary); color: var(--dt-primary); }
.hk-warn { display: inline-flex; align-items: center; font-size: 12px; color: #f53f3f; }
.mail-banner {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 12px;
  border-radius: 6px;
  background: var(--dt-bg-hover, #f5f6f8);
  color: var(--dt-text-2);
  font-size: 13px;
}
.mail-env-tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 12px;
  border-radius: 6px;
  background: #fff7e6;
  color: #8a6d3b;
  font-size: 13px;
  margin-bottom: 12px;
}
.mail-grid { display: flex; flex-direction: column; }
.switch-row.disabled { opacity: 0.55; cursor: not-allowed; }
.file-row { display: flex; align-items: center; gap: 8px; }
.file-name {
  flex: 1;
  min-width: 0;
  height: 36px;
  line-height: 36px;
  padding: 0 12px;
  border: 1px dashed var(--dt-border);
  border-radius: 6px;
  font-size: 12px;
  color: var(--dt-text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.modal-desc { font-size: 13px; color: var(--dt-text-3); margin-bottom: 14px; }
.srv-row { display: flex; align-items: center; gap: 8px; }
.srv-select { height: 36px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 8px; background: #fff; font-size: 13px; color: var(--dt-text); outline: none; }
.srv-input { height: 36px; border: 1px solid var(--dt-border); border-radius: 6px; padding: 0 12px; font-size: 13px; color: var(--dt-text); outline: none; width: 0; flex: 1; }
.srv-input:focus { border-color: var(--dt-primary); }
.srv-port { flex: 0 0 90px; }
.srv-colon { color: var(--dt-text-3); }
.srv-preview { margin-top: 14px; font-size: 12px; color: var(--dt-text-3); }
.dl-desc { margin-top: 18px; margin-bottom: 8px; }
.srv-hint { margin-top: 8px; font-size: 12px; color: var(--dt-text-4); }
.srv-error { margin-top: 10px; font-size: 13px; color: var(--dt-danger); }
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
</style>
