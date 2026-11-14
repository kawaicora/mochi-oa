/**
 * 需求 7.3：审批消息卡片（DM 私聊卡片）的统一构造/解析纯函数。
 *
 * 四种审批卡片（考勤/报销/备用金/上网）以私聊消息发送到审批人，content 为 JSON 字符串：
 *   { requestId, title, body, byNick, status? }
 * - requestId：服务端申请单 id（接收侧点击后深链定位用）
 * - title：卡片标题（如 "报销申请" / "补卡申请"）
 * - body：卡片正文摘要（金额/事由等）
 * - byNick：申请人昵称（发送人视角的展示名）
 * - status：仅"审批结果回推"卡片携带（approved/rejected）；新发申请卡片不带
 *
 * 渲染层 ChatWindow 按 kind 渲染气泡样式；点击后按 requestId 深链到对应审批 View 定位高亮。
 */

export type ApprovalCardKind = 'attendance_card' | 'expense_card' | 'advance_card' | 'proxy_card'

export const APPROVAL_CARD_KINDS: readonly ApprovalCardKind[] = ['attendance_card', 'expense_card', 'advance_card', 'proxy_card']

/** kind → 默认卡片标题（各 View 可按具体类型覆盖，如考勤用"补卡申请"） */
export const APPROVAL_CARD_TITLE: Record<ApprovalCardKind, string> = {
  attendance_card: '考勤申请',
  expense_card: '报销申请',
  advance_card: '备用金申请',
  proxy_card: '上网申请'
}

export interface ApprovalCardData {
  requestId?: number | null
  title?: string
  body?: string
  byNick?: string
  status?: string
  /** 卡片类型；构造时由 kind 写入载荷，便于 kind 在传输中丢失时按内容自愈 */
  cardType?: ApprovalCardKind
}

export interface ParsedApprovalCard {
  requestId: number | null
  title: string
  body: string
  byNick: string
  status?: string
  cardType: ApprovalCardKind | null
}

/** kind 白名单校验 */
export function isApprovalCardKind(k: string): k is ApprovalCardKind {
  return (APPROVAL_CARD_KINDS as readonly string[]).includes(k)
}

/**
 * 构造卡片 content JSON 字符串。kind 不在白名单 → 抛错（调用方应为编译期常量，打错字应暴露而非静默错发）。
 * status 缺省时不写入字段（新发申请卡片不带 status，结果回推卡片才带）。
 */
export function buildApprovalCard(kind: ApprovalCardKind, p: ApprovalCardData): string {
  if (!isApprovalCardKind(kind)) throw new TypeError(`[approval-card] 未知卡片类型: ${String(kind)}`)
  if (p.requestId == null || !Number.isFinite(Number(p.requestId))) throw new TypeError('[approval-card] requestId 必填且为数字')
  const out: Record<string, unknown> = {
    requestId: Number(p.requestId),
    title: p.title || APPROVAL_CARD_TITLE[kind],
    body: p.body || '',
    byNick: p.byNick || '',
    cardType: kind
  }
  if (p.status) out.status = p.status
  return JSON.stringify(out)
}

/** 旧卡片载荷未带 cardType 时，按标题关键字推断类型；无法判定返回 null */
function kindByTitle(title: string): ApprovalCardKind | null {
  if (/报销/.test(title)) return 'expense_card'
  if (/备用金/.test(title)) return 'advance_card'
  if (/上网|代理/.test(title)) return 'proxy_card'
  if (/考勤|补卡|请假|调休|加班/.test(title)) return 'attendance_card'
  return null
}

/**
 * 解析卡片 content JSON。任何字段缺失/JSON 损坏 → requestId 返回 null，其余字段给默认空串；
 * 调用方据此决定"能否深链"与"摘要展示"，绝不抛异常（消息气泡渲染不能因一条坏卡片崩）。
 */
export function parseApprovalCard(content: string): ParsedApprovalCard {
  const fail: ParsedApprovalCard = { requestId: null, title: '', body: '', byNick: '', cardType: null }
  try {
    const c = JSON.parse(content) as Record<string, unknown>
    if (!c || typeof c !== 'object') return fail
    const rid = Number(c.requestId)
    const title = typeof c.title === 'string' ? c.title : ''
    const body = typeof c.body === 'string' ? c.body : (typeof c.reason === 'string' ? c.reason : '')
    const byNick = typeof c.byNick === 'string' ? c.byNick
      : (typeof c.nick === 'string' ? c.nick : (typeof c.applicant === 'string' ? c.applicant : ''))
    const rawType = typeof c.cardType === 'string' ? c.cardType : ''
    const cardType = isApprovalCardKind(rawType) ? rawType : kindByTitle(title)
    return {
      requestId: Number.isFinite(rid) ? rid : null,
      title,
      body,
      byNick,
      ...(typeof c.status === 'string' ? { status: c.status } : {}),
      cardType
    }
  } catch {
    return fail
  }
}

/**
 * 判定一条消息 content 是否为审批卡片（按内容兜底，不依赖消息 kind）。
 * 命中条件：可解析为对象、requestId 为有效数字、且标题/正文/申请人至少有一项非空；
 * 类型优先取载荷 cardType，其次按标题关键字推断。无法识别返回 null。
 */
export function detectApprovalCard(content: string): { kind: ApprovalCardKind; data: ParsedApprovalCard } | null {
  const data = parseApprovalCard(content)
  if (data.requestId == null) return null
  if (!data.title && !data.body && !data.byNick) return null
  if (!data.cardType) return null
  return { kind: data.cardType, data }
}
