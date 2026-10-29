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
    byNick: p.byNick || ''
  }
  if (p.status) out.status = p.status
  return JSON.stringify(out)
}

/**
 * 解析卡片 content JSON。任何字段缺失/JSON 损坏 → requestId 返回 null，其余字段给默认空串；
 * 调用方据此决定"能否深链"与"摘要展示"，绝不抛异常（消息气泡渲染不能因一条坏卡片崩）。
 */
export function parseApprovalCard(content: string): Required<Omit<ApprovalCardData, 'status'>> & { status?: string } {
  const fail = { requestId: null, title: '', body: '', byNick: '' }
  try {
    const c = JSON.parse(content) as Record<string, unknown>
    if (!c || typeof c !== 'object') return fail
    const rid = Number(c.requestId)
    return {
      requestId: Number.isFinite(rid) ? rid : null,
      title: typeof c.title === 'string' ? c.title : '',
      body: typeof c.body === 'string' ? c.body : '',
      byNick: typeof c.byNick === 'string' ? c.byNick : '',
      ...(typeof c.status === 'string' ? { status: c.status } : {})
    }
  } catch {
    return fail
  }
}
