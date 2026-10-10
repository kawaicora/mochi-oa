<script setup lang="ts">
/**
 * Excel（.xlsx / .xls / .csv）预览（SheetJS + 自解析样式）。
 * 通过 IPC 读取本地字节 → SheetJS 解析工作簿 → 自绘表格：
 *  - 多工作表切换（页签）、列标（A/B/C）+ 行号，表头/行号吸附
 *  - 还原 Office 观感：填充色、字体（名称/字号/加粗/斜体/下划线/颜色）、对齐、边框、列宽行高
 *  - 合并单元格（rowspan/colspan）、数字右对齐、日期格式化
 *  - 大表保护：按需分块构建 + 行/列上限（避免卡死渲染进程）
 *  - Esc 关闭、打开文件所在路径
 * 注：SheetJS 社区版只解析出填充色，字体/边框/对齐由 utils/xlsx-style.ts 直接解析 styles.xml 补全。
 */
import { ref, computed, onMounted, onBeforeUnmount, nextTick } from 'vue'
import type { CellObject, Range, WorkBook, WorkSheet } from 'xlsx'
import { readXlsxStyles, type CellStyle, type SheetStyleMap } from '../utils/xlsx-style'

const props = defineProps<{ path: string; name: string }>()
const emit = defineEmits<{ close: [] }>()

/** 单元格显示模型 */
interface GridCell {
  /** 显示文本 */
  t: string
  /** colspan / rowspan（未合并为 1） */
  cs: number
  rs: number
  /** 被合并区域覆盖，跳过渲染 */
  skip: boolean
  align: 'l' | 'r' | 'c'
  /** xlsx 原始样式（填充/字体/边框/对齐） */
  style?: CellStyle
}

const scrollEl = ref<HTMLElement | null>(null)
const loading = ref(true)
const error = ref('')
const sheetNames = ref<string[]>([])
const activeSheet = ref('')
const gridRows = ref<GridCell[][]>([])
const totalRows = ref(0)
const totalCols = ref(0)
const visibleRows = ref(0)
const notice = ref('')

/** 单次构建的批大小 / 硬上限（大表保护） */
const CHUNK = 200
const MAX_ROWS = 2000
const MAX_COLS = 100

let destroyed = false
let XLSX: typeof import('xlsx') | null = null
let wb: WorkBook | null = null
let range: Range = { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
/** 合并单元格：左上角 → 跨度；被覆盖格 → true */
let mergeTop = new Map<string, { cs: number; rs: number }>()
let mergeCovered = new Set<string>()
/** 工作表名 → (单元格地址 → 样式) */
let styleBook: SheetStyleMap = new Map()
/** 当前工作表的单元格样式表 */
let sheetStyle = new Map<string, CellStyle>()

/** 列宽（px）与行高（px），来自 xlsx 的 !cols / !rows */
const colWidths = ref<number[]>([])
const rowHeights = ref<number[]>([])

const colKey = (r: number, c: number): string => `${r},${c}`

const renderedCols = computed(() => Math.min(totalCols.value, MAX_COLS))
const renderRows = computed(() => Math.min(gridRows.value.length, visibleRows.value))
const colLetters = computed(() => {
  const out: string[] = []
  for (let c = 0; c < renderedCols.value; c++) out.push(XLSX ? XLSX.utils.encode_col(c) : String(c + 1))
  return out
})
const hasMore = computed(() => visibleRows.value < Math.min(totalRows.value, MAX_ROWS))

function cellText(cell: CellObject | undefined): string {
  if (!cell) return ''
  if (cell.w != null) return String(cell.w)
  const v = cell.v
  if (v == null) return ''
  if (v instanceof Date) return v.toLocaleString()
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return String(v)
}

function alignOf(cell: CellObject | undefined): 'l' | 'r' | 'c' {
  if (!cell) return 'l'
  if (cell.t === 'n' || cell.t === 'd') return 'r'
  if (cell.t === 'b') return 'c'
  return 'l'
}

/** 解析合并区域（相对当前 range 起点） */
function buildMerges(ws: WorkSheet): void {
  mergeTop = new Map()
  mergeCovered = new Set()
  const or = range.s.r
  const oc = range.s.c
  for (const m of ws['!merges'] ?? []) {
    const r0 = m.s.r - or
    const c0 = m.s.c - oc
    const r1 = m.e.r - or
    const c1 = m.e.c - oc
    if (r0 < 0 || c0 < 0 || r1 < r0 || c1 < c0) continue
    mergeTop.set(colKey(r0, c0), { cs: c1 - c0 + 1, rs: r1 - r0 + 1 })
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        if (r === r0 && c === c0) continue
        mergeCovered.add(colKey(r, c))
      }
    }
  }
}

function buildRow(ws: WorkSheet, r: number): GridCell[] {
  const or = range.s.r
  const oc = range.s.c
  const row: GridCell[] = []
  for (let c = 0; c < renderedCols.value; c++) {
    const key = colKey(r, c)
    if (mergeCovered.has(key)) {
      row.push({ t: '', cs: 1, rs: 1, skip: true, align: 'l' })
      continue
    }
    const addr = XLSX!.utils.encode_cell({ r: r + or, c: c + oc })
    const cell = ws[addr] as CellObject | undefined
    const span = mergeTop.get(key)
    row.push({
      t: cellText(cell),
      cs: span?.cs ?? 1,
      rs: span?.rs ?? 1,
      skip: false,
      align: alignOf(cell),
      style: sheetStyle.get(addr)
    })
  }
  return row
}

/** 单元格最终 CSS（xlsx 样式优先，其次按数据类型对齐） */
function cellCss(cell: GridCell): Record<string, string> {
  const s = cell.style
  const out: Record<string, string> = {}
  if (s?.bg) out.background = s.bg
  if (s?.color) out.color = s.color
  if (s?.bold) out.fontWeight = '700'
  if (s?.italic) out.fontStyle = 'italic'
  if (s?.underline) out.textDecoration = 'underline'
  if (s?.fontSize) out.fontSize = `${s.fontSize}pt`
  if (s?.fontFamily) out.fontFamily = `"${s.fontFamily}", "Microsoft YaHei", sans-serif`
  out.textAlign = s?.align ?? (cell.align === 'r' ? 'right' : cell.align === 'c' ? 'center' : 'left')
  if (s?.valign) out.verticalAlign = s.valign
  out.whiteSpace = s?.wrap ? 'pre-wrap' : 'nowrap'
  if (s?.border) {
    if (s.border.top) out.borderTop = s.border.top
    if (s.border.right) out.borderRight = s.border.right
    if (s.border.bottom) out.borderBottom = s.border.bottom
    if (s.border.left) out.borderLeft = s.border.left
  }
  return out
}

/** xlsx 列宽（字符数/像素）→ px */
function colWidthsFrom(ws: WorkSheet): number[] {
  const cols = ws['!cols'] ?? []
  const out: number[] = []
  for (let c = 0; c < renderedCols.value; c++) {
    const def = cols[c] as { wpx?: number; wch?: number; width?: number; hidden?: boolean } | undefined
    if (!def) {
      out.push(96)
      continue
    }
    const px = def.wpx ?? (def.wch != null ? def.wch * 7 + 5 : def.width != null ? def.width * 7 + 5 : 96)
    out.push(Math.max(24, Math.min(800, Math.round(px))))
  }
  return out
}

/** xlsx 行高（磅/像素）→ px */
function rowHeightsFrom(ws: WorkSheet): number[] {
  const rows = ws['!rows'] ?? []
  const out: number[] = []
  for (let r = 0; r < Math.min(totalRows.value, MAX_ROWS); r++) {
    const def = rows[r] as { hpx?: number; hpt?: number } | undefined
    if (!def) {
      out.push(0)
      continue
    }
    const px = def.hpx ?? (def.hpt != null ? def.hpt * 1.3333 : 0)
    out.push(px > 0 ? Math.max(16, Math.round(px)) : 0)
  }
  return out
}

/** 按需增量构建到 visibleRows */
function ensureRows(): void {
  const ws = activeSheet.value ? wb?.Sheets[activeSheet.value] : undefined
  if (!ws) return
  const target = Math.min(visibleRows.value, Math.min(totalRows.value, MAX_ROWS))
  const next = gridRows.value
  for (let r = next.length; r < target; r++) next.push(buildRow(ws, r))
  gridRows.value = next.slice()
}

function loadMore(): void {
  visibleRows.value = Math.min(visibleRows.value + CHUNK, Math.min(totalRows.value, MAX_ROWS))
  ensureRows()
  void nextTick(() => updateNotice())
}

function updateNotice(): void {
  const parts: string[] = []
  if (totalRows.value > MAX_ROWS) parts.push(`共 ${totalRows.value} 行，仅预览前 ${MAX_ROWS} 行`)
  if (totalCols.value > MAX_COLS) parts.push(`共 ${totalCols.value} 列，仅预览前 ${MAX_COLS} 列`)
  notice.value = parts.join('；')
}

function selectSheet(name: string): void {
  if (!wb) return
  activeSheet.value = name
  const ws = wb.Sheets[name]
  const ref = ws?.['!ref']
  range = ref ? XLSX!.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: 0, c: 0 } }
  totalRows.value = range.e.r - range.s.r + 1
  totalCols.value = range.e.c - range.s.c + 1
  gridRows.value = []
  visibleRows.value = 0
  sheetStyle = styleBook.get(name) ?? new Map()
  if (ws) buildMerges(ws)
  colWidths.value = ws ? colWidthsFrom(ws) : []
  rowHeights.value = ws ? rowHeightsFrom(ws) : []
  updateNotice()
  loadMore()
  scrollEl.value?.scrollTo({ top: 0, left: 0 })
}

function onKey(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return
  emit('close')
}

async function openLocation(): Promise<void> {
  await window.pantry.openFileLocation(props.path)
}

function errText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/password|encrypt/i.test(msg)) return '该表格已加密或受保护，暂不支持预览'
  return `表格解析失败：${msg || '未知错误'}`
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  const r = await window.pantry.serverReadFileBytes(props.path)
  if (destroyed) return
  if (!r.ok || !r.data) {
    loading.value = false
    error.value = r.error || '读取表格文件失败'
    return
  }
  try {
    XLSX = await import('xlsx')
    if (destroyed) return
    // 自行解析样式（SheetJS 社区版只给填充色，字体/边框/对齐需要解析 styles.xml）
    styleBook = await readXlsxStyles(r.data.slice(0))
    if (destroyed) return
    const data = new Uint8Array(r.data.slice(0))
    wb = XLSX.read(data, { type: 'array', cellDates: true, cellText: true, cellNF: false, cellHTML: false })
    const names = wb.SheetNames ?? []
    if (names.length === 0) throw new Error('工作簿中没有任何工作表')
    sheetNames.value = names
    loading.value = false
    await nextTick()
    selectSheet(names[0]!)
  } catch (e) {
    if (destroyed) return
    loading.value = false
    error.value = errText(e)
  }
})

onBeforeUnmount(() => {
  destroyed = true
  window.removeEventListener('keydown', onKey)
  wb = null
  mergeTop = new Map()
  mergeCovered = new Set()
  styleBook = new Map()
  sheetStyle = new Map()
  gridRows.value = []
})
</script>

<template>
  <div class="sheet-mask" @click.self="emit('close')">
    <div class="sheet-box">
      <div class="sheet-head">
        <span class="sheet-title"><i class="fas fa-file-excel"></i>&nbsp;Excel 预览</span>
        <div class="sheet-name" :title="name">{{ name }}</div>
        <button class="sheet-x" title="关闭 (Esc)" @click="emit('close')"><i class="fas fa-times"></i></button>
      </div>

      <div class="sheet-tabs">
        <button
          v-for="n in sheetNames"
          :key="n"
          class="sheet-tab"
          :class="{ on: n === activeSheet }"
          :title="n"
          @click="selectSheet(n)"
        >
          {{ n }}
        </button>
        <span class="sheet-spacer"></span>
        <span v-if="!loading && !error" class="sheet-dim">{{ totalRows }} 行 × {{ totalCols }} 列</span>
        <button class="sheet-btn" title="打开文件所在路径" @click="openLocation"><i class="far fa-folder-open"></i></button>
      </div>

      <div ref="scrollEl" class="sheet-scroll">
        <table v-if="!loading && !error" class="sheet-table" :class="{ 'sheet-fixed': colWidths.length > 0 }">
          <colgroup>
            <col style="width: 46px" />
            <col v-for="(w, i) in colWidths" :key="i" :style="{ width: w + 'px' }" />
          </colgroup>
          <thead>
            <tr class="sheet-colhead">
              <th class="sheet-corner"></th>
              <th v-for="(letter, i) in colLetters" :key="i" class="sheet-colno">{{ letter }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, ri) in gridRows.slice(0, renderRows)"
              :key="ri"
              :style="rowHeights[ri] ? { height: rowHeights[ri] + 'px' } : undefined"
            >
              <th class="sheet-rownum">{{ ri + 1 }}</th>
              <template v-for="(cell, ci) in row" :key="ci">
                <td
                  v-if="!cell.skip"
                  :colspan="cell.cs > 1 ? Math.min(cell.cs, renderedCols - ci) : undefined"
                  :rowspan="cell.rs > 1 ? Math.min(cell.rs, renderRows - ri) : undefined"
                  :class="['sheet-cell', 'al-' + cell.align]"
                  :style="cellCss(cell)"
                >
                  {{ cell.t }}
                </td>
              </template>
            </tr>
          </tbody>
        </table>

        <div v-if="hasMore" class="sheet-more">
          <button class="sheet-more-btn" @click="loadMore">显示更多（已显示 {{ renderRows }} 行）</button>
        </div>
        <div v-if="notice" class="sheet-notice">{{ notice }}</div>

        <div v-if="loading" class="sheet-status"><i class="fas fa-spinner fa-spin"></i>&nbsp;正在解析表格…</div>
        <div v-else-if="error" class="sheet-status sheet-status-err">
          <i class="fas fa-exclamation-triangle"></i>&nbsp;{{ error }}
        </div>
      </div>

      <div class="sheet-foot">
        <span class="sheet-hint">滚轮滚动 · 点击页签切换工作表 · Esc 关闭</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.sheet-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 145;
}
.sheet-box {
  width: 960px;
  max-width: 94vw;
  height: 720px;
  max-height: 92vh;
  background: #fff;
  border-radius: 10px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.sheet-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--dt-border-light);
  flex-shrink: 0;
}
.sheet-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--dt-text);
  flex-shrink: 0;
}
.sheet-title .fa-file-excel {
  color: #217346;
}
.sheet-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  color: var(--dt-text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sheet-x {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-3);
  font-size: 14px;
  flex-shrink: 0;
}
.sheet-x:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.sheet-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 12px;
  border-bottom: 1px solid var(--dt-border-light);
  background: #fafbfc;
  flex-shrink: 0;
  overflow-x: auto;
}
.sheet-tab {
  height: 28px;
  max-width: 180px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 13px;
  color: var(--dt-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex-shrink: 0;
}
.sheet-tab:hover {
  background: var(--dt-hover);
}
.sheet-tab.on {
  background: var(--dt-active);
  color: var(--dt-primary);
  font-weight: 600;
}
.sheet-spacer {
  flex: 1;
}
.sheet-dim {
  font-size: 12px;
  color: var(--dt-text-3);
  white-space: nowrap;
  margin-right: 4px;
}
.sheet-btn {
  width: 30px;
  height: 30px;
  border-radius: 6px;
  color: var(--dt-text-2);
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.sheet-btn:hover {
  background: var(--dt-hover);
  color: var(--dt-text);
}
.sheet-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: #f0f2f5;
  position: relative;
}
.sheet-table {
  border-collapse: separate;
  border-spacing: 0;
  background: #fff;
  font-size: 13px;
  color: var(--dt-text);
}
/* 有列宽定义时按 Excel 的固定列宽排版 */
.sheet-table.sheet-fixed {
  table-layout: fixed;
}
.sheet-table th,
.sheet-table td {
  border-right: 1px solid #e6e9ee;
  border-bottom: 1px solid #e6e9ee;
  padding: 3px 6px;
  min-width: 56px;
  max-width: 360px;
  white-space: pre-wrap;
  word-break: break-word;
  vertical-align: bottom;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 固定列宽模式下由 colgroup 决定宽度，避免 min-width 干扰 */
.sheet-table.sheet-fixed th,
.sheet-table.sheet-fixed td {
  min-width: 0;
}
.sheet-table tbody td {
  background: #fff;
}
.sheet-table thead th {
  position: sticky;
  top: 0;
  z-index: 2;
  background: #f2f4f7;
  color: var(--dt-text-3);
  font-weight: 500;
  font-size: 11px;
  text-align: center;
  padding: 2px 6px;
  white-space: nowrap;
}
.sheet-corner {
  left: 0;
  z-index: 3 !important;
  min-width: 44px !important;
}
.sheet-colno {
  min-width: 56px;
}
.sheet-rownum {
  position: sticky;
  left: 0;
  z-index: 1;
  background: #f2f4f7;
  color: var(--dt-text-3);
  font-weight: 500;
  font-size: 11px;
  text-align: center;
  min-width: 44px !important;
  white-space: nowrap;
}
.sheet-cell.al-r {
  text-align: right;
  font-variant-numeric: tabular-nums;
}
.sheet-cell.al-c {
  text-align: center;
}
.sheet-more,
.sheet-notice {
  padding: 10px 16px;
  text-align: center;
}
.sheet-more-btn {
  height: 30px;
  padding: 0 16px;
  border-radius: 6px;
  background: var(--dt-primary);
  color: #fff;
  font-size: 13px;
}
.sheet-more-btn:hover {
  background: var(--dt-primary-hover);
}
.sheet-notice {
  font-size: 12px;
  color: var(--dt-text-4);
  padding-top: 0;
}
.sheet-status {
  position: absolute;
  left: 50%;
  top: 40%;
  transform: translate(-50%, -50%);
  color: var(--dt-text-3);
  font-size: 14px;
}
.sheet-status-err {
  color: var(--dt-danger);
  text-align: center;
  padding: 0 24px;
  max-width: 80%;
  line-height: 1.6;
}
.sheet-foot {
  padding: 8px 16px;
  border-top: 1px solid var(--dt-border-light);
  display: flex;
  justify-content: center;
  flex-shrink: 0;
}
.sheet-hint {
  font-size: 12px;
  color: var(--dt-text-4);
}
</style>
