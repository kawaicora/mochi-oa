<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue'

interface Room {
  id: string
  type: string
  title?: string
  members?: number
}
interface Device {
  id: string
  name: string
  username: string
  os: string
  ip: string
  online: boolean
  remote: boolean
}

const emit = defineEmits<{ joinRoom: [roomId: string] }>()

const verified = ref(false)
const verifying = ref(true)
const authError = ref('')
const activeTab = ref<'rooms' | 'devices' | 'update'>('rooms')
const selectedDevice = ref<Device | null>(null)

const rooms = ref<Room[]>([])
const devices = ref<Device[]>([])
// dev:view 返回的完整 sys 数据（info + perf）
const devInfo = ref<Record<string, any> | null>(null)
const devPerf = ref<Record<string, any> | null>(null)
// 设备命令执行回显
const execOutput = ref('')

// 更新发布
const updateFile = ref<File | null>(null)
const uploadingUpdate = ref(false)
const updateProgress = ref(0)
const updateResult = ref<{ ok: boolean; version?: string; detail?: string; error?: string } | null>(null)

// 监听上传进度
if (typeof window !== 'undefined' && window.pantry.onUploadUpdateProgress) {
  window.pantry.onUploadUpdateProgress((data) => {
    if (!data.done && data.percent != null) {
      updateProgress.value = data.percent
    }
  })
}

function onUpdateFile(e: Event): void {
  const input = e.target as HTMLInputElement
  updateFile.value = input.files?.[0] || null
  updateResult.value = null
}

async function uploadUpdate(): Promise<void> {
  if (!updateFile.value) return
  uploadingUpdate.value = true
  updateProgress.value = 0
  updateResult.value = null
  try {
    // 先把文件写入临时路径，再通过主进程 IPC 上传（避免 CORS）
    const arrayBuffer = await updateFile.value.arrayBuffer()
    const r = await window.pantry.writeTempFile({ name: updateFile.value.name, data: arrayBuffer })
    if (!r.ok || !r.path) {
      updateResult.value = { ok: false, error: '临时文件写入失败' }
      return
    }
    const resp = await window.pantry.serverUploadUpdate({ filePath: r.path, name: updateFile.value.name })
    if (resp.ok) {
      updateProgress.value = 100
      const detail = (resp.keys && resp.keys.length > 0) ? resp.keys.join(', ') : (resp.platform ?? '')
      updateResult.value = { ok: true, version: resp.version, detail }
    } else {
      updateResult.value = { ok: false, error: resp.error || '上传失败' }
    }
  } catch (err) {
    updateResult.value = { ok: false, error: String(err) }
  } finally {
    uploadingUpdate.value = false
  }
}

function openPreview(): void {
  if (!selectedDevice.value) return
  void window.pantry.openAdminDevPreview({
    deviceId: selectedDevice.value.id,
    deviceName: selectedDevice.value.name
  })
}

function openTerminal(): void {
  if (!selectedDevice.value) return
  void window.pantry.openAdminDevTerminal({
    deviceId: selectedDevice.value.id,
    deviceName: selectedDevice.value.name
  })
}

let refreshTimer: ReturnType<typeof setInterval> | undefined

async function doVerify(): Promise<void> {
  verifying.value = true
  authError.value = ''
  try {
    const ack = await window.pantry.serverAdminVerify()
    const data = ack.data as { token?: string } | undefined
    if (ack.ok && data?.token) {
      verified.value = true
      void loadRooms()
      void loadDevices()
      startRefresh()
    } else {
      authError.value = ack.error || '无权限'
    }
  } catch (e: any) {
    authError.value = e?.message || '验证失败'
  } finally {
    verifying.value = false
  }
}

async function loadRooms(): Promise<void> {
  try {
    const ack = await window.pantry.serverAdminListRooms()
    const data = ack.data as { rooms?: Room[] } | undefined
    if (ack.ok && data?.rooms) rooms.value = data.rooms
  } catch (e) { console.warn('[admin] listRooms failed:', e) }
}

async function loadDevices(): Promise<void> {
  try {
    const ack = await window.pantry.serverAdminListDevices()
    const data = ack.data as { devices?: Device[] } | undefined
    if (ack.ok && data?.devices) devices.value = data.devices
  } catch (e) { console.warn('[admin] listDevices failed:', e) }
}

function startRefresh(): void {
  refreshTimer = setInterval(() => {
    void loadRooms()
    void loadDevices()
    // 如果已选中设备，刷新其 sys 数据
    if (selectedDevice.value) void loadDeviceSys(selectedDevice.value)
  }, 5000)
}

function goBack(): void {
  selectedDevice.value = null
  devInfo.value = null
  devPerf.value = null
  execOutput.value = ''
  activeTab.value = 'devices'
}

async function loadDeviceSys(d: Device): Promise<void> {
  if (d.id === 'local') {
    try {
      const [infoAck, perfAck] = await Promise.all([
        window.pantry.serverAdminSysInfo(),
        window.pantry.serverAdminSysPerf()
      ])
      if (infoAck.ok) devInfo.value = infoAck.data as Record<string, any> | null
      if (perfAck.ok) devPerf.value = perfAck.data as Record<string, any> | null
    } catch (e) { console.warn('[admin] devView failed:', e) }
  } else {
    try {
      const ack = await window.pantry.serverAdminDevView(d.id)
      console.log('[admin] dev:view response:', ack)
      const data = ack.data as {
        sys?: { info?: Record<string, any>; perf?: Record<string, any> }
        name?: string
        os?: string
        ip?: string
      } | undefined
      if (ack.ok && data?.sys) {
        const s = data.sys
        if (s.info) devInfo.value = s.info
        if (s.perf) devPerf.value = s.perf
      } else if (ack.ok) {
        // sys 为空：用 ack 里的基础信息填充，避免永远"加载中"
        devInfo.value = {
          hostname: data?.name || d.name,
          type: data?.os || d.os,
          ips: [{ address: data?.ip || d.ip }],
        }
      }
    } catch (e) {
      console.warn('[admin] dev:view failed:', e)
    }
  }
}

async function selectDevice(d: Device): Promise<void> {
  selectedDevice.value = d
  execOutput.value = ''
  // 立即用列表里的基础信息填充，不卡在"加载中"
  devInfo.value = {
    hostname: d.name,
    type: d.os,
    ips: [{ address: d.ip }],
    username: d.username,
  }
  devPerf.value = null
  // 后台拉详细信息
  await loadDeviceSys(d)
}

function fmtUptime(sec: number): string {
  if (!sec || sec < 0) return '—'
  const d = Math.floor(sec / 86400)
  const h = Math.floor((sec % 86400) / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return d > 0 ? `${d}天 ${h}时 ${m}分` : `${h}时 ${m}分`
}
function fmtBytes(b: number): string {
  if (!b) return '—'
  const gb = b / (1024 * 1024 * 1024)
  return gb >= 100 ? gb.toFixed(0) + ' GB' : gb.toFixed(1) + ' GB'
}
const roomTypeLabel = (t: string) => ({ conf: '会议', dm: '私聊', group: '群聊' } as Record<string, string>)[t] || t

onMounted(() => { void doVerify() })
onUnmounted(() => { if (refreshTimer) clearInterval(refreshTimer) })
</script>

<template>
  <div class="ap">
    <div v-if="verifying" class="ap-center"><i class="fas fa-spinner fa-spin"></i> 验证管理员权限…</div>
    <div v-else-if="!verified" class="ap-center ap-err">
      <i class="fas fa-shield-alt"></i><p>{{ authError }}</p>
      <button class="ap-btn" @click="doVerify">重新验证</button>
    </div>

    <template v-else>
      <div class="ap-tabs">
        <button :class="{ on: activeTab === 'rooms' && !selectedDevice }" @click="activeTab = 'rooms'; selectedDevice = null">
          <i class="fas fa-video"></i> 房间列表 <span class="ap-badge">{{ rooms.length }}</span>
        </button>
        <button :class="{ on: activeTab === 'devices' && !selectedDevice }" @click="activeTab = 'devices'">
          <i class="fas fa-desktop"></i> 在线设备 <span class="ap-badge">{{ devices.filter(d => d.online).length }}</span>
        </button>
        <button :class="{ on: activeTab === 'update' && !selectedDevice }" @click="activeTab = 'update'; selectedDevice = null">
          <i class="fas fa-upload"></i> 更新发布
        </button>
        <button v-if="selectedDevice" class="ap-back" @click="goBack">
          <i class="fas fa-arrow-left"></i> 返回设备列表
        </button>
      </div>

      <!-- 房间列表 -->
      <div v-if="activeTab === 'rooms' && !selectedDevice" class="ap-list">
        <div v-if="rooms.length === 0" class="ap-empty">暂无进行中的房间</div>
        <div v-for="r in rooms" :key="r.id" class="ap-row" @click="emit('joinRoom', r.id)">
          <span class="ap-tag" :class="r.type">{{ roomTypeLabel(r.type) }}</span>
          <span class="ap-title">{{ r.title || r.id }}</span>
          <span class="ap-meta">{{ r.members || 0 }} 人</span>
          <button class="ap-btn-sm">加入</button>
        </div>
      </div>

      <!-- 设备列表 -->
      <div v-else-if="activeTab === 'devices' && !selectedDevice" class="ap-grid">
        <div v-if="devices.length === 0" class="ap-empty">暂无在线设备</div>
        <div v-for="d in devices" :key="d.id" class="ap-card" :class="{ off: !d.online }" @click="selectDevice(d)">
          <i class="fas fa-desktop ap-card-icon"></i>
          <div class="ap-card-name">{{ d.name }}</div>
          <div class="ap-card-sub">{{ d.username }} · {{ d.os.split(' ')[0] }}</div>
          <span class="ap-status" :class="d.online ? 'on' : 'off'">{{ d.online ? '在线' : '离线' }}</span>
        </div>
      </div>

      <!-- 更新发布 -->
      <div v-else-if="activeTab === 'update' && !selectedDevice" class="ap-update">
        <div class="ap-update-card">
          <h3><i class="fas fa-upload"></i> 发布更新包</h3>
          <p class="ap-update-desc">上传 exe / AppImage / dmg / zip，自动识别平台、架构与版本号，按「平台_架构」发布到 /files/version</p>
          <div class="ap-update-row">
            <input type="file" accept=".exe,.appimage,.AppImage,.dmg,.zip" ref="updateFileInput" @change="onUpdateFile" />
          </div>
          <div v-if="updateFile" class="ap-update-info">
            <i class="fas fa-file-excel"></i> {{ updateFile.name }} ({{ fmtBytes(updateFile.size) }})
          </div>
          <div v-if="uploadingUpdate" class="ap-update-progress">
            <div class="ap-update-progress-bar" :style="{ width: updateProgress + '%' }"></div>
            <span class="ap-update-progress-text">{{ updateProgress }}%</span>
          </div>
          <div v-if="updateResult" class="ap-update-result" :class="{ ok: updateResult.ok, err: !updateResult.ok }">
            {{ updateResult.ok ? `发布成功！版本 ${updateResult.version}${updateResult.detail ? ' · ' + updateResult.detail : ''}` : updateResult.error }}
          </div>
          <button class="ap-update-btn" :disabled="!updateFile || uploadingUpdate" @click="uploadUpdate">
            {{ uploadingUpdate ? '上传中…' : '发布更新' }}
          </button>
        </div>
      </div>

      <!-- 设备详情 -->
      <div v-else-if="selectedDevice" class="ap-detail">
        <h3>{{ selectedDevice.name }} <span class="ap-detail-sub">{{ selectedDevice.username }} · {{ selectedDevice.os }} · {{ selectedDevice.ip }}</span></h3>

        <!-- 系统信息网格 -->
        <div v-if="devInfo" class="ap-info-grid">
          <div v-if="devInfo.hostname"><label>主机名</label><span>{{ devInfo.hostname }}</span></div>
          <div v-if="devInfo.ips?.length"><label>IP 地址</label><span>{{ devInfo.ips.map((i: any) => i.address || i.ip4).filter(Boolean).join(', ') }}</span></div>
          <div v-if="devInfo.type || devInfo.release"><label>操作系统</label><span>{{ devInfo.type }} {{ devInfo.release || '' }} {{ devInfo.arch || '' }}</span></div>
          <div v-if="devInfo.cpuModel"><label>CPU</label><span>{{ devInfo.cpuModel }} · {{ devInfo.cpuCores }} 核</span></div>
          <div v-if="devInfo.totalMem"><label>内存总量</label><span>{{ fmtBytes(devInfo.totalMem) }}</span></div>
          <div v-if="devInfo.board"><label>主板</label><span>{{ typeof devInfo.board === 'string' ? devInfo.board : (devInfo.board?.manufacturer || '') + ' ' + (devInfo.board?.model || '') }}</span></div>
          <div v-if="devInfo.gpuInfo || devInfo.gpu"><label>显卡</label><span>{{ typeof devInfo.gpu === 'string' ? devInfo.gpu : (devInfo.gpuInfo?.[0]?.name || devInfo.gpuInfo?.[0]?.vendor || '') }}</span></div>
          <div v-if="devInfo.uptime"><label>运行时长</label><span>{{ fmtUptime(devInfo.uptime) }}</span></div>
        </div>
        <div v-else class="ap-empty">正在加载系统信息…</div>

        <!-- 实时图表 + 磁盘 -->
        <div class="ap-charts-row">
          <div v-if="devPerf" class="ap-charts">
            <div class="ap-chart">
              <label>CPU 使用率</label>
              <div class="ap-bar"><div class="ap-bar-fill cpu" :style="{ width: (devPerf.cpu || 0) + '%' }"></div></div>
              <span>{{ devPerf.cpu || 0 }}%</span>
            </div>
            <div class="ap-chart">
              <label>内存</label>
              <div class="ap-bar"><div class="ap-bar-fill mem" :style="{ width: (devPerf.memPercent || 0) + '%' }"></div></div>
              <span>{{ devPerf.memPercent || 0 }}%（{{ fmtBytes(devPerf.memUsed) }} / {{ fmtBytes(devPerf.memTotal) }}）</span>
            </div>
          </div>

          <!-- 磁盘信息 -->
          <div v-if="devInfo?.disk" class="ap-disk">
            <label>磁盘</label>
            <div v-if="Array.isArray(devInfo.disk) || typeof devInfo.disk === 'string'">
              <pre>{{ typeof devInfo.disk === 'string' ? devInfo.disk : JSON.stringify(devInfo.disk, null, 2) }}</pre>
            </div>
            <div v-else-if="Array.isArray(devInfo.disk)" class="ap-disk-list">
              <div v-for="(p, i) in devInfo.disk" :key="i" class="ap-disk-row">
                <span>{{ p.mount || p.mountpoint }}</span>
                <div class="ap-bar"><div class="ap-bar-fill mem" :style="{ width: (p.use || 0) + '%' }"></div></div>
                <span>{{ p.used }} / {{ p.size }} ({{ p.use }}%)</span>
              </div>
            </div>
          </div>
        </div>

        <!-- 进程列表（客户端已采集） -->
        <div v-if="devInfo?.processes?.length" class="ap-process">
          <label>进程数（前30）</label>
          <div class="ap-proc-list">
            <div v-for="p in devInfo.processes.slice(0, 30)" :key="p.pid" class="ap-proc">
              <span>{{ p.pid }}</span><span>{{ p.name }}</span><span v-if="p.cpu">{{ p.cpu }}%</span>
            </div>
          </div>
        </div>

        <!-- 操作按钮 -->
        <div class="ap-actions">
          <button class="ap-btn" @click="openTerminal">
            <i class="fas fa-terminal"></i> 终端
          </button>
          <button class="ap-btn" @click="openPreview">
            <i class="fas fa-video"></i> 远程预览
          </button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.ap { height: 100%; width: 100%; display: flex; flex-direction: column; background: #f5f6f8; }
.ap-center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; color: #888; }
.ap-err { color: #d92b3a; }
.ap-btn { padding: 8px 16px; border-radius: 8px; border: none; background: var(--dt-primary); color: #fff; cursor: pointer; font-size: 13px; }
.ap-actions { display: flex; gap: 10px; padding: 4px 0; }
.ap-btn-sm { padding: 4px 10px; border-radius: 6px; border: 1px solid #ddd; background: #fff; cursor: pointer; font-size: 12px; }
.ap-btn-sm:hover { border-color: var(--dt-primary); color: var(--dt-primary); }

.ap-tabs { display: flex; gap: 4px; padding: 10px 14px; background: #fff; border-bottom: 1px solid var(--dt-border-light); align-items: center; }
.ap-tabs button { padding: 6px 14px; border-radius: 8px; border: none; background: transparent; cursor: pointer; font-size: 13px; color: var(--dt-text-2); }
.ap-tabs button.on { background: #e3edff; color: var(--dt-primary); }
.ap-tabs .ap-back { margin-left: auto; color: #888; }
.ap-badge { background: #ddd; border-radius: 10px; padding: 0 6px; font-size: 11px; margin-left: 4px; }

.ap-list { flex: 1; overflow-y: auto; padding: 12px; }
.ap-empty { text-align: center; color: #aaa; padding: 40px; }
.ap-row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: #fff; border-radius: 8px; margin-bottom: 6px; cursor: pointer; }
.ap-row:hover { box-shadow: 0 1px 4px rgba(0,0,0,.08); }
.ap-tag { font-size: 11px; padding: 2px 8px; border-radius: 4px; color: #fff; }
.ap-tag.conf { background: #4a90d9; } .ap-tag.dm { background: #67b26f; } .ap-tag.group { background: #d9a44a; }
.ap-title { flex: 1; font-size: 13px; }
.ap-meta { font-size: 12px; color: #999; }

.ap-grid { flex: 1; overflow-y: auto; padding: 14px; display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px; align-content: start; }
.ap-card { background: #fff; border-radius: 10px; padding: 16px; text-align: center; cursor: pointer; position: relative; }
.ap-card:hover { box-shadow: 0 2px 8px rgba(0,0,0,.1); }
.ap-card.off { opacity: .5; }
.ap-card-icon { font-size: 28px; color: #4a90d9; margin-bottom: 8px; }
.ap-card-name { font-size: 13px; font-weight: 600; }
.ap-card-sub { font-size: 11px; color: #999; margin-top: 2px; }
.ap-status { position: absolute; top: 8px; right: 8px; font-size: 10px; padding: 1px 6px; border-radius: 4px; }
.ap-status.on { background: #e6f9e6; color: #2a9d3a; }
.ap-status.off { background: #f0f0f0; color: #999; }

.ap-detail { flex: 1; overflow-y: auto; padding: 16px 20px; width: 100%; box-sizing: border-box; }
.ap-detail h3 { margin: 0 0 14px; font-size: 16px; }
.ap-detail-sub { font-size: 12px; color: #999; font-weight: normal; margin-left: 8px; }
.ap-info-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px 20px; background: #fff; padding: 16px 18px; border-radius: 10px; margin-bottom: 12px; }
.ap-info-grid > div { font-size: 12px; }
.ap-info-grid label { display: block; color: #999; margin-bottom: 2px; }
.ap-info-grid span { color: var(--dt-text); }

.ap-charts-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
.ap-charts { background: #fff; padding: 14px; border-radius: 10px; display: flex; flex-direction: column; gap: 10px; }
.ap-chart { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.ap-chart label { width: 80px; color: #666; }
.ap-bar { flex: 1; height: 10px; background: #eee; border-radius: 5px; overflow: hidden; }
.ap-bar-fill { height: 100%; border-radius: 5px; transition: width .5s; }
.ap-bar-fill.cpu { background: #4a90d9; } .ap-bar-fill.mem { background: #67b26f; }

.ap-disk { background: #fff; padding: 14px; border-radius: 10px; }
.ap-disk label { display: block; color: #999; margin-bottom: 6px; font-size: 12px; }
.ap-disk pre { margin: 0; white-space: pre-wrap; font-family: inherit; font-size: 12px; }
.ap-disk-row { display: flex; align-items: center; gap: 8px; font-size: 11px; margin-bottom: 4px; }
.ap-disk-row .ap-bar { flex: 2; }

.ap-process { background: #fff; padding: 14px; border-radius: 10px; margin-bottom: 12px; }
.ap-process label { display: block; color: #999; font-size: 12px; margin-bottom: 6px; }
.ap-proc-list { max-height: 200px; overflow-y: auto; }
.ap-proc { display: flex; gap: 12px; padding: 3px 0; font-size: 11px; font-family: monospace; }

.ap-exec { background: #fff; padding: 14px; border-radius: 10px; margin-bottom: 12px; }
.ap-exec label { display: block; font-size: 12px; color: #666; margin-bottom: 6px; }
.ap-exec-row { display: flex; gap: 8px; }
.ap-exec-row input { flex: 1; padding: 6px 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 13px; }
.ap-exec-out { background: #1e1e1e; color: #d4d4d4; padding: 10px; border-radius: 6px; font-size: 12px; max-height: 200px; overflow-y: auto; margin-top: 8px; white-space: pre-wrap; }

.ap-remote { text-align: center; padding: 10px; }

.ap-update { padding: 20px; }
.ap-update-card { background: #fff; border-radius: 12px; padding: 24px; max-width: 500px; }
.ap-update-card h3 { margin: 0 0 8px; font-size: 16px; }
.ap-update-desc { color: #888; font-size: 13px; margin: 0 0 16px; }
.ap-update-row { display: flex; align-items: center; gap: 16px; margin-bottom: 12px; }
.ap-update-row input[type=file] { font-size: 13px; }
.ap-update-info { display: flex; align-items: center; gap: 8px; padding: 10px; background: #f5f6f8; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
.ap-update-result { padding: 10px; border-radius: 8px; font-size: 13px; margin-bottom: 12px; }
.ap-update-result.ok { background: #e8f5e9; color: #2e7d32; }
.ap-update-result.err { background: #ffebee; color: #c62828; }
.ap-update-progress { position: relative; height: 24px; background: #e9ecef; border-radius: 12px; overflow: hidden; margin-bottom: 12px; }
.ap-update-progress-bar { position: absolute; left: 0; top: 0; bottom: 0; background: #4a90d9; transition: width 0.2s; }
.ap-update-progress-text { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); font-size: 12px; color: #333; font-weight: 500; }
.ap-update-btn { padding: 8px 20px; border: none; border-radius: 8px; background: var(--dt-primary); color: #fff; cursor: pointer; font-size: 14px; }
.ap-update-btn:disabled { opacity: 0.6; cursor: not-allowed; }
</style>
