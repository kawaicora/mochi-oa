<script setup lang="ts">
import { ref, computed, watch, onMounted, onBeforeUnmount } from 'vue'
import { useAppStore } from '../stores/app'
import { fmtHuman, fmtLocal } from '../utils/time'
import { useServerStore } from '../stores/server'
import QRCode from './common/QRCode.vue'
import CompanyContactPicker from './CompanyContactPicker.vue'

// ── 类型（与服务端冻结协议对齐）──
type AssetType = 'purchase' | 'rent' | 'borrow'
type AssetStatus = 'in_stock' | 'out'
interface AssetItem {
  id: number
  companyId: number
  code: string
  name: string
  price: number
  assetType: AssetType
  status: AssetStatus
  qrCode?: string // 服务端返回 MOA-ASSET:<公司ID>:<资产ID>；缺省时按同一规则本地拼
  createdAt: string
  updatedAt: string
}
interface FlowItem {
  id: number
  companyId: number
  assetId: number
  assetCode: string
  assetName: string
  flowType: string
  direction: 'in' | 'out'
  operatorId: number
  operatorNick: string
  relatedTo: string | null
  relatedToUserId?: number | null
  note: string | null
  createdAt: string
}
// 流转枚举（与服务端白名单一致，key 不得擅自改名，否则被服务端白名单拒绝）：
// 入库(in)=购买/租聘/借用/调拨/归还/自购/受赠/其他
// 出库(out)=售卖/赠与/借出/外带/领用/调拨/丢失/报废/退还/其他
const IN_FLOWS = [
  { v: 'in_purchase', l: '购买入库' },
  { v: 'in_rent', l: '租聘入库' },
  { v: 'in_borrow', l: '借用入库' },
  { v: 'in_transfer', l: '调拨入库' },
  { v: 'in_return', l: '归还入库' },
  { v: 'in_self_purchase', l: '自购入库' },
  { v: 'in_donation', l: '受赠入库' },
  { v: 'in_other', l: '其他入库' }
]
const OUT_FLOWS = [
  { v: 'out_sell', l: '售卖' },
  { v: 'out_gift', l: '赠与' },
  { v: 'out_lend', l: '借出' },
  { v: 'out_carry', l: '外带' },
  { v: 'out_usage', l: '领用' },
  { v: 'out_transfer', l: '调拨' },
  { v: 'out_lost', l: '丢失' },
  { v: 'out_scrap', l: '报废' },
  { v: 'out_refund', l: '退还' },
  { v: 'out_other', l: '其他出库' }
]
const FLOW_LABEL: Record<string, string> = {}
;[...IN_FLOWS, ...OUT_FLOWS].forEach((f) => (FLOW_LABEL[f.v] = f.l))

const app = useAppStore()
const server = useServerStore()
const companyId = computed(() => app.activeCompanyId)
const isAdmin = computed(() => app.isAdmin)
const meId = computed(() => server.state.userId ?? 0)

// 拼二维码载荷：纯文本 MOA-ASSET:<companyId>:<assetId>（与服务端一致）
function qrPayload(cid: number, aid: number): string {
  return `MOA-ASSET:${cid}:${aid}`
}
// 优先用服务端 asset:get / asset:create 返回的 qrCode；缺省按同一规则本地拼
function assetQr(a: AssetItem): string {
  return a.qrCode || qrPayload(a.companyId, a.id)
}
// 复制二维码文本（clipboard 不可用时退回选中文本兜底）
async function copyQr(a: AssetItem): Promise<void> {
  const text = assetQr(a)
  try {
    if (navigator.clipboard) { await navigator.clipboard.writeText(text) }
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    copiedQr.value = text
    window.setTimeout(() => { if (copiedQr.value === text) copiedQr.value = '' }, 2000)
  } catch (e) { console.error('[资产] 复制二维码失败', e) }
}
const copiedQr = ref('')

const TYPE_LABEL: Record<AssetType, string> = { purchase: '购买', rent: '租赁', borrow: '借用' }

// ── 列表 ──
const list = ref<AssetItem[]>([])
const keyword = ref('')
const page = ref(1)
const pageSize = 10
const total = ref(0)
const pages = computed(() => Math.max(1, Math.ceil(total.value / pageSize)))
async function loadList(): Promise<void> {
  if (!companyId.value) return
  try {
    const ack = await window.pantry.serverAssetList({
      companyId: companyId.value, keyword: keyword.value || undefined, page: page.value, pageSize
    })
    if (!ack.ok) { console.error('[资产] 列表失败', ack.error); return }
    list.value = (ack.data as { assets?: AssetItem[] })?.assets ?? []
    total.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[资产] 列表异常', e) }
}

// ── 新增资产弹窗 ──
const showCreate = ref(false)
const newName = ref('')
const newPrice = ref<number | null>(null)
const newType = ref<AssetType>('purchase')
const creating = ref(false)
const createdAsset = ref<AssetItem | null>(null) // 创建成功后展示编号+二维码
async function createAsset(): Promise<void> {
  if (!newName.value.trim()) { err.value = '请输入名称'; return }
  if (newPrice.value == null) { err.value = '请输入价格'; return }
  creating.value = true
  err.value = ''
  try {
    const ack = await window.pantry.serverAssetCreate({
      companyId: companyId.value, name: newName.value.trim(), price: Number(newPrice.value), assetType: newType.value
    })
    if (!ack.ok) { console.error('[资产] 创建失败', ack.error); err.value = ack.error || '创建失败'; return }
    createdAsset.value = (ack.data as { asset?: AssetItem })?.asset ?? null
    newName.value = ''; newPrice.value = null; newType.value = 'purchase'
    await loadList()
  } catch (e) { console.error('[资产] 创建异常', e); err.value = '创建异常' }
  creating.value = false
}

// ── 详情 + 流转 ──
const detail = ref<AssetItem | null>(null)
const flows = ref<FlowItem[]>([])
const flowPage = ref(1)
const flowTotal = ref(0)
const flowPages = computed(() => Math.max(1, Math.ceil(flowTotal.value / pageSize)))
async function openDetail(a: AssetItem): Promise<void> {
  detail.value = a
  flowPage.value = 1
  await loadFlows()
}
/** 列表行直接打开"出入库"流转弹窗（admin），无需先进详情 */
async function openFlow(a: AssetItem): Promise<void> {
  detail.value = a
  flowPage.value = 1
  await loadFlows()
  showFlow.value = true
  err.value = ''
}
async function loadFlows(): Promise<void> {
  if (!detail.value) return
  try {
    const ack = await window.pantry.serverAssetFlowList({
      companyId: companyId.value, assetId: detail.value.id, page: flowPage.value, pageSize
    })
    if (!ack.ok) { console.error('[资产] 流转列表失败', ack.error); return }
    flows.value = (ack.data as { flows?: FlowItem[] })?.flows ?? []
    flowTotal.value = (ack.data as { total?: number })?.total ?? 0
  } catch (e) { console.error('[资产] 流转列表异常', e) }
}

// ── 新增流转弹窗 ──
const showFlow = ref(false)
const flowType = ref('in_purchase')
// 相关人：成员选择（多选兜底，单选也行；最多 3 人）
const relatedUserIds = ref<number[]>([])
const flowNote = ref('')
const flowSaving = ref(false)
function relatedName(ids: number[]): string {
  return ids.map((id) => app.members.find((m) => m.userId === id)?.nick || app.members.find((m) => m.userId === id)?.username || `#${id}`).join('、')
}
async function createFlow(): Promise<void> {
  if (!detail.value) return
  flowSaving.value = true
  err.value = ''
  try {
    const ack = await window.pantry.serverAssetFlowCreate({
      companyId: companyId.value, assetId: detail.value.id, flowType: flowType.value,
      relatedToUserId: relatedUserIds.value[0] ?? null,
      relatedTo: relatedName(relatedUserIds.value) || undefined,
      note: flowNote.value || undefined
    })
    if (!ack.ok) { console.error('[资产] 流转失败', ack.error); err.value = ack.error || '流转失败'; return }
    const a = (ack.data as { asset?: AssetItem })?.asset
    if (a) detail.value = a
    showFlow.value = false
    relatedUserIds.value = []; flowNote.value = ''
    flowPage.value = 1
    await Promise.all([loadFlows(), loadList()])
  } catch (e) { console.error('[资产] 流转异常', e); err.value = '流转异常' }
  flowSaving.value = false
}

// ── 删除 ──
async function remove(a: AssetItem): Promise<void> {
  if (!confirm(`确认删除资产 ${a.name}？将连同流转记录一起删除。`)) return
  try {
    const ack = await window.pantry.serverAssetDelete(companyId.value, a.id)
    if (!ack.ok) { console.error('[资产] 删除失败', ack.error); return }
    if (detail.value?.id === a.id) detail.value = null
    await loadList()
  } catch (e) { console.error('[资产] 删除异常', e) }
}

// ── 扫码：摄像头(jsQR) + 手动输入兜底 ──
const showScan = ref(false)
const manualPayload = ref('')
const scanErr = ref('')
let scanStream: MediaStream | null = null
let scanTimer: number | null = null
let scanCanvas: HTMLCanvasElement | null = null
const scanVideo = ref<HTMLVideoElement | null>(null)

async function startCamera(): Promise<void> {
  scanErr.value = ''
  try {
    // 动态 import jsqr（体积不小，按需加载）
    const jsQRMod: any = await import('jsqr')
    const JsQR = jsQRMod.default || jsQRMod
    scanStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } })
    if (scanVideo.value) {
      scanVideo.value.srcObject = scanStream
      await scanVideo.value.play()
    }
    scanCanvas = document.createElement('canvas')
    const tick = (): void => {
      if (!scanVideo.value || !scanCanvas) return
      const v = scanVideo.value
      if (v.readyState === v.HAVE_ENOUGH_DATA) {
        scanCanvas.width = v.videoWidth
        scanCanvas.height = v.videoHeight
        const ctx = scanCanvas.getContext('2d')
        if (ctx) {
          ctx.drawImage(v, 0, 0, scanCanvas.width, scanCanvas.height)
          const img = ctx.getImageData(0, 0, scanCanvas.width, scanCanvas.height)
          const code = JsQR(img.data, img.width, img.height)
          if (code && code.data) {
            handlePayload(code.data)
            return
          }
        }
      }
      scanTimer = window.setTimeout(tick, 300)
    }
    tick()
  } catch (e) {
    console.error('[扫码] 摄像头启动失败，可手动输入', e)
    scanErr.value = '摄像头不可用，请手动输入载荷码'
  }
}
function stopCamera(): void {
  if (scanTimer) { clearTimeout(scanTimer); scanTimer = null }
  if (scanStream) { try { scanStream.getTracks().forEach((t) => t.stop()) } catch (e) { console.error('[扫码] 停摄像头异常', e) } scanStream = null }
  if (scanVideo.value) scanVideo.value.srcObject = null
}
function openScan(): void {
  showScan.value = true
  manualPayload.value = ''
  scanErr.value = ''
  void startCamera()
}
function closeScan(): void {
  stopCamera()
  showScan.value = false
}
onBeforeUnmount(() => stopCamera())

/** 解析 MOA-ASSET:<cid>:<aid> → asset:get → 详情（公司隔离校验） */
async function handlePayload(raw: string): Promise<void> {
  const text = (raw || '').trim()
  const m = text.match(/^MOA-ASSET:(\d+):(\d+)$/)
  if (!m) {
    scanErr.value = '载荷格式不正确，应为 MOA-ASSET:<公司ID>:<资产ID>'
    return
  }
  const cid = Number(m[1]); const aid = Number(m[2])
  if (cid !== companyId.value) {
    scanErr.value = `该资产属于公司 #${cid}，与当前公司 #${companyId.value} 不匹配`
    return
  }
  try {
    const ack = await window.pantry.serverAssetGet({ companyId: cid, id: aid })
    if (!ack.ok) { scanErr.value = '查询失败：' + (ack.error || '未知'); return }
    const a = (ack.data as { asset?: AssetItem })?.asset
    if (!a) { scanErr.value = '未找到该资产'; return }
    stopCamera()
    showScan.value = false
    manualPayload.value = ''
    await openDetail(a)
  } catch (e) {
    console.error('[扫码] 查询资产异常', e)
    scanErr.value = '查询异常'
  }
}
function submitManual(): void {
  void handlePayload(manualPayload.value)
}

const err = ref('')
watch([keyword], () => { page.value = 1; loadList() })
watch(companyId, () => { page.value = 1; loadList() })
onMounted(loadList)

function fmt(s: string): string {
  if (!s) return '—'
  return fmtLocal(s)
}
</script>

<template>
  <div class="av">
    <div v-if="err" class="av-err">{{ err }}</div>
    <!-- 列表头：搜索 + 扫码 + 新增 -->
    <div class="av-head">
      <input v-model="keyword" class="srv-input" placeholder="搜索名称/编号…" />
      <button class="dt-btn" @click="openScan"><i class="fas fa-qrcode"></i> 扫码看详情</button>
      <button v-if="isAdmin" class="dt-btn dt-btn-primary" @click="showCreate = true; err = ''"><i class="fas fa-plus"></i> 新增资产</button>
    </div>

    <!-- 列表 -->
    <div class="av-table-wrap">
      <div v-if="!list.length" class="av-empty">暂无资产</div>
      <table v-else class="av-table">
        <thead><tr><th>编号</th><th>名称</th><th>价格</th><th>类型</th><th>状态</th><th></th></tr></thead>
        <tbody>
          <tr v-for="a in list" :key="a.id" class="av-row" @click="openDetail(a)">
            <td class="av-code">{{ a.code }}</td>
            <td>{{ a.name }}</td>
            <td>¥{{ a.price }}</td>
            <td>{{ TYPE_LABEL[a.assetType] }}</td>
            <td><span class="av-badge" :class="a.status">{{ a.status === 'in_stock' ? '在库' : '在外' }}</span></td>
            <td class="av-ops">
              <button v-if="isAdmin" class="dt-btn sm" @click.stop="openFlow(a)"><i class="fas fa-exchange-alt"></i> 出入库</button>
              <button v-if="isAdmin" class="av-op danger" @click.stop="remove(a)"><i class="fas fa-trash"></i></button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="av-pager">
      <button class="dt-btn" :disabled="page <= 1" @click="page--; loadList()">上一页</button>
      <span>{{ page }} / {{ pages }}</span>
      <button class="dt-btn" :disabled="page >= pages" @click="page++; loadList()">下一页</button>
    </div>

    <!-- 新增资产弹窗 -->
    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-head">新增资产</div>
        <div class="modal-body">
          <!-- 表单 -->
          <template v-if="!createdAsset">
            <label class="av-lab">名称 <i class="req">*</i></label>
            <input v-model="newName" class="srv-input" />
            <label class="av-lab">价格 <i class="req">*</i></label>
            <input v-model.number="newPrice" type="number" step="0.01" class="srv-input" />
            <label class="av-lab">类型</label>
            <select v-model="newType" class="srv-select">
              <option value="purchase">购买</option>
              <option value="rent">租赁</option>
              <option value="borrow">借用</option>
            </select>
          </template>
          <!-- 创建成功：展示自动编号 + 二维码（载荷 MOA-ASSET:<cid>:<aid>） -->
          <template v-else>
            <div class="av-created">
              <div>编号：<b>{{ createdAsset.code }}</b></div>
              <div>名称：{{ createdAsset.name }}</div>
              <QRCode :text="assetQr(createdAsset)" :size="180" />
              <div class="av-qr-url">{{ assetQr(createdAsset) }}</div>
              <button class="dt-btn sm" @click="copyQr(createdAsset)"><i class="fas fa-copy"></i> {{ copiedQr === assetQr(createdAsset) ? '已复制' : '复制二维码文本' }}</button>
            </div>
          </template>
        </div>
        <div class="modal-foot">
          <button v-if="!createdAsset" class="dt-btn" @click="showCreate = false">取消</button>
          <button v-if="!createdAsset" class="dt-btn dt-btn-primary" :disabled="creating" @click="createAsset">{{ creating ? '创建中…' : '创建' }}</button>
          <button v-else class="dt-btn" @click="showCreate = false; createdAsset = null">完成</button>
        </div>
      </div>
    </div>

    <!-- 详情弹窗 -->
    <div v-if="detail" class="modal-mask" @click.self="detail = null">
      <div class="modal av-detail">
        <div class="modal-head">{{ detail.name }} <span class="av-code-head">{{ detail.code }}</span></div>
        <div class="modal-body">
          <div class="av-dinfo">
            <div>价格：¥{{ detail.price }}　类型：{{ TYPE_LABEL[detail.assetType] }}　状态：{{ detail.status === 'in_stock' ? '在库' : '在外' }}</div>
            <div class="av-qr-box">
              <QRCode :text="assetQr(detail)" :size="120" />
              <div class="av-qr-url">{{ assetQr(detail) }}</div>
              <button class="dt-btn sm" @click="copyQr(detail)"><i class="fas fa-copy"></i> {{ copiedQr === assetQr(detail) ? '已复制' : '复制二维码文本' }}</button>
            </div>
          </div>
          <div class="av-flow-head">
            <span>流转记录</span>
            <button v-if="isAdmin" class="dt-btn sm" @click="showFlow = true; err = ''"><i class="fas fa-plus"></i> 发起流转</button>
          </div>
          <div v-if="!flows.length" class="av-empty">暂无流转记录</div>
          <div v-else class="av-flows">
            <div v-for="f in flows" :key="f.id" class="av-flow">
              <span class="av-flow-type" :class="f.direction">{{ FLOW_LABEL[f.flowType] || f.flowType }}</span>
              <span class="av-flow-op">经办人：{{ f.operatorNick || '—' }}</span>
              <span v-if="f.relatedTo" class="av-flow-rel">相关人：{{ f.relatedTo }}</span>
              <span v-if="f.note" class="av-flow-note">备注：{{ f.note }}</span>
              <span class="av-flow-time">{{ fmtHuman(f.createdAt) }}</span>
            </div>
          </div>
          <div class="av-pager">
            <button class="dt-btn" :disabled="flowPage <= 1" @click="flowPage--; loadFlows()">上一页</button>
            <span>{{ flowPage }} / {{ flowPages }}</span>
            <button class="dt-btn" :disabled="flowPage >= flowPages" @click="flowPage++; loadFlows()">下一页</button>
          </div>
        </div>
        <div class="modal-foot"><button class="dt-btn" @click="detail = null">关闭</button></div>
      </div>
    </div>

    <!-- 发起流转弹窗 -->
    <div v-if="showFlow" class="modal-mask" @click.self="showFlow = false">
      <div class="modal">
        <div class="modal-head">发起流转</div>
        <div class="modal-body">
          <label class="av-lab">流转类型 <i class="req">*</i></label>
          <select v-model="flowType" class="srv-select">
            <optgroup label="资产入库">
              <option v-for="f in IN_FLOWS" :key="f.v" :value="f.v">{{ f.l }}</option>
            </optgroup>
            <optgroup label="资产出库">
              <option v-for="f in OUT_FLOWS" :key="f.v" :value="f.v">{{ f.l }}</option>
            </optgroup>
          </select>
          <label class="av-lab">经办人</label>
          <div class="av-form-readonly">当前登录人（系统自动记录）</div>
          <label class="av-lab">相关人</label>
          <CompanyContactPicker v-model="relatedUserIds" :max="3" title="选择相关成员" placeholder="选择相关成员（客户/借出对象等）" />
          <label class="av-lab">备注</label>
          <input v-model="flowNote" class="srv-input" />
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="showFlow = false">取消</button>
          <button class="dt-btn dt-btn-primary" :disabled="flowSaving" @click="createFlow">{{ flowSaving ? '提交中…' : '确定' }}</button>
        </div>
      </div>
    </div>

    <!-- 扫码弹窗：摄像头 + 手动输入兜底 -->
    <div v-if="showScan" class="modal-mask" @click.self="closeScan">
      <div class="modal av-scan">
        <div class="modal-head"><i class="fas fa-qrcode"></i> 扫码查看资产详情</div>
        <div class="modal-body">
          <video ref="scanVideo" class="av-scan-video" playsinline muted></video>
          <div v-if="scanErr" class="av-scan-err">{{ scanErr }}</div>
          <label class="av-lab">手动输入载荷码（摄像头不可用时）</label>
          <input v-model="manualPayload" class="srv-input" placeholder="MOA-ASSET:<公司ID>:<资产ID>" @keydown.enter="submitManual" />
        </div>
        <div class="modal-foot">
          <button class="dt-btn" @click="closeScan">关闭</button>
          <button class="dt-btn dt-btn-primary" @click="submitManual">查询</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.av { flex: 1; min-height: 0; width: 100%; display: flex; flex-direction: column; overflow: hidden; padding: 12px 18px; }
.av-err { color: #d92b3a; font-size: 13px; margin-bottom: 6px; }
.av-head { display: flex; gap: 10px; margin-bottom: 10px; }
.av-head .srv-input { flex: 1; }
.av-table-wrap { flex: 1; overflow: auto; border: 1px solid var(--dt-border-light); border-radius: 8px; }
.av-empty { color: var(--dt-text-4); text-align: center; padding: 24px 0; font-size: 13px; }
.av-table { width: 100%; border-collapse: collapse; font-size: 13px; background: #fff; }
.av-table th, .av-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--dt-border-light); }
.av-table th { background: #fafbfc; font-weight: 600; color: var(--dt-text-3); font-size: 12px; }
.av-row { cursor: pointer; }
.av-row:hover { background: #f6f8fb; }
.av-code { font-family: monospace; color: var(--dt-text-3); }
.av-badge { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.av-badge.in_stock { background: #e8f9ef; color: #2fbb6b; }
.av-badge.out { background: #fff3e0; color: #d46b08; }
.av-ops .av-op { border: none; background: transparent; cursor: pointer; color: #d92b3a; }
.av-pager { display: flex; align-items: center; gap: 10px; margin: 8px 0; font-size: 12px; color: var(--dt-text-3); }
.av-lab { display: block; font-size: 12px; color: var(--dt-text-3); margin: 10px 0 4px; font-weight: 600; }
.av-form-readonly { font-size: 13px; color: var(--dt-text-2); background: #f6f8fb; padding: 8px 10px; border-radius: 6px; }
.av-created { display: flex; flex-direction: column; align-items: center; gap: 8px; }
.av-qr-url { font-size: 11px; color: var(--dt-text-4); word-break: break-all; font-family: monospace; }
.av-detail { width: 640px; }
.av-code-head { font-size: 12px; color: var(--dt-text-4); font-weight: 400; margin-left: 8px; }
.av-dinfo { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
.av-qr-box { display: flex; flex-direction: column; align-items: center; gap: 6px; flex-shrink: 0; }
.av-flow-head { display: flex; align-items: center; justify-content: space-between; margin: 10px 0 6px; font-weight: 700; }
.av-flows { max-height: 220px; overflow: auto; }
.av-flow { display: flex; gap: 8px; align-items: center; padding: 6px 0; border-bottom: 1px dashed var(--dt-border-light); font-size: 13px; flex-wrap: wrap; }
.av-flow-type { padding: 1px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
.av-flow-type.in { background: #e8f9ef; color: #2fbb6b; }
.av-flow-type.out { background: #fff3e0; color: #d46b08; }
.av-flow-op { color: var(--dt-text-2); }
.av-flow-rel { color: var(--dt-text-3); }
.av-flow-note { color: var(--dt-text-4); flex: 1; }
.av-flow-time { font-size: 11px; color: var(--dt-text-4); margin-left: auto; }
.req { color: #e64545; font-style: normal; }
.dt-btn.sm { padding: 3px 10px; font-size: 12px; }
.av-scan { width: 420px; }
.av-scan-video { width: 100%; max-height: 240px; background: #000; border-radius: 8px; }
.av-scan-err { color: #d92b3a; font-size: 12px; margin: 6px 0; }
</style>
