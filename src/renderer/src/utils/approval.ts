/**
 * 需求 7.2：审批操作（通过/驳回）按钮可见性的统一判定（纯函数，可单测）。
 *
 * 语义：只有「当前用户是审批人 且 该项状态为 pending」时，才允许在卡片内显示通过/驳回按钮；
 * 历史项（已通过/已驳回）、非审批人、缺审批人字段 → 一律只读。
 *
 * 各审批 View 数据结构差异：考勤/报销/备用金用 approverIds: number[]（多人审批人）；
 * 上网(Proxy)用 approverId: number | null（单人审批人）。此处两种字段都兼容。
 * 另保留既有行为：公司管理员（isAdmin）可对 pending 项执行操作（与改造前各 View 的 canAct 一致）。
 */
export interface ApprovalActorInput {
  /** 项状态：'pending' | 'approved' | 'rejected' | ... */
  status?: string | null
  /** 当前用户 id */
  meId?: number | null
  /** 多人审批人名单（考勤/报销/备用金） */
  approverIds?: number[] | null
  /** 单人审批人 id（上网代理） */
  approverId?: number | null
  /** 当前用户是否公司管理员（owner/admin） */
  isAdmin?: boolean
}

export function canActApproval(p: ApprovalActorInput): boolean {
  // 历史项（已通过/已驳回/其他终态）→ 只读
  if (p.status !== 'pending') return false
  const me = p.meId ?? 0
  if (me <= 0) return false
  // 管理员兜底（既有行为）
  if (p.isAdmin === true) return true
  // 在审批人名单内（多人）
  if (Array.isArray(p.approverIds) && p.approverIds.includes(me)) return true
  // 是单人审批人（上网代理）
  if (p.approverId != null && p.approverId === me) return true
  return false
}
