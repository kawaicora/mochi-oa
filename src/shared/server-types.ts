/**
 * Mochi OA - 与中心服务器（teahouse-server，Socket.IO + MySQL）交互的数据类型。
 * 全部由客户端从零定义，服务端协议以 teahouse-server/server/src/handlers/* 为准。
 */

/** 服务器连接状态 */
export type ServerConnState =
  | 'idle'        // 未连接
  | 'connecting'
  | 'connected'
  | 'disconnected' // 已断线
  | 'error'

/** 文件传输模式 */
export type FileTransferMode = 'local' | 'server'

/** 服务器地址配置 */
export interface ServerSettings {
  /** 形如 http://127.0.0.1:3000 */
  serverUrl: string
  /** JWT，登录/注册后回写 */
  token: string
  /** 文件传输模式：local=本地直传/FTP，server=经服务端中继 */
  fileTransferMode: 'local' | 'server'
  /** 文件夹/文件下载落盘目录（默认：Documents/麻薯） */
  downloadDir: string
  /** 收到图片/视频/可预览文件时自动下载到本地（默认开） */
  autoDownload: boolean
  /** 音视频通话：音频采样率（Hz，默认 48000） */
  audioSampleRate?: number
  /** 音视频通话：声道数（默认 2） */
  audioChannels?: number
}

/** 账号 Acknowledge */
export interface AuthAck {
  ok: boolean
  error?: string
  token?: string
  userId?: number
  username?: string
  nick?: string
}

/** 通用 Acknowledge */
export interface Ack {
  ok: boolean
  error?: string
  data?: unknown
}

/** 服务端客户端状态（桥接到渲染进程） */
export interface ServerClientState {
  connected: boolean
  state: ServerConnState
  serverUrl: string
  userId?: number
  username?: string
  nick?: string
  avatar?: string
  phone?: string
  extra?: string
  token?: string
  error?: string
  activeCompanyId: number
}

/** 公司 */
export interface Company {
  id: number
  name: string
  code?: string
  ownerId: number
  createdAt?: string
}

/** 当前用户在公司里的身份 */
export interface CompanyMembership {
  company: Company
  role: 'owner' | 'admin' | 'member'
  departmentIds?: number[]
}

/** 部门 */
export interface Department {
  id: number
  companyId: number
  name: string
  parentId?: number | null
}

/** 用户 */
export interface UserInfo {
  id: number
  username: string
  nick?: string
  email?: string
  phone?: string
  extra?: string
  avatarUrl?: string
  avatar?: string
}

/** 群 */
export interface Group {
  id: number
  companyId: number
  name: string
  departmentId?: number | null
  code?: string
  ownerId: number
  memberCount?: number
}

/** 群成员（含角色/禁言状态；群设置/成员列表用） */
export interface ServerGroupMember {
  groupId: number
  userId: number
  role: 'owner' | 'admin' | 'member'
  joinedAt?: string
  username?: string
  nick?: string
  avatar?: string
  online?: boolean
  mutedUntil?: string | null
}

/** 群邀请推送（普通成员邀请他人入群） */
export interface GroupInviteEvent {
  groupId: number
  groupName: string
  from: { userId: number; nick: string }
  ts: number
}

/** 会话类型 */
export type ConversationKind = 'group' | 'dm'

/** 对话列表项（服务端 conversation:list 返回） */
/** 会话内某成员的已读位置（已读回执） */
export interface ReadReceipt {
  userId: number
  lastReadMessageId: number | null
}

export interface ConversationItem {
  conversationId: number
  type: ConversationKind
  groupId?: number
  dmUserId?: number
  pinned: boolean
  lastMessageAt?: number
  lastPreview?: string
  unread: number
  name: string
  avatar?: string
  /** 会话内各成员已读位置（已读回执） */
  readReceipts: ReadReceipt[]
}

/** 组织成员（公司/群/部门成员，含在线） */
export interface OrgMember {
  userId: number
  role: string
  username: string
  nick?: string
  avatar?: string
  phone?: string
  extra?: string
  location?: string
  online?: boolean
  joinedAt?: string
}

/** 好友 */
export interface FriendItem {
  userId: number
  username: string
  nick?: string
  avatar?: string
  addedAt?: string
}

/** 消息种类 */
export type MessageKind = 'text' | 'image' | 'file' | 'video' | 'audio' | 'folder'

/** 聊天消息（服务端 chat:message / chat:history / dm:history 返回） */
export interface ServerChatMessage {
  id: string
  conversationId: number
  type: ConversationKind
  fromId: number
  nick?: string
  avatar?: string
  kind: MessageKind
  content: string
  ts: number
}

/** 消息被删除推送 */
export interface ServerMessageDeleted {
  conversationId: number
  messageId: string
}

/** 在线状态/成员变化推送（服务端 presence:update） */
export interface ServerPresenceUpdate {
  userId: number
  nick?: string
  online: boolean
}

/** 邀请状态 */
export type InvitationStatus = 'pending' | 'accepted' | 'declined' | 'expired'

/** 公司邀请 */
export interface CompanyInvitation {
  id: number
  companyId: number
  companyName?: string
  code: string
  createdBy: number
  status: InvitationStatus
  expiresAt?: string | null
  createdAt?: string
}

/** 用户×公司 人事信息 */
export interface MemberProfile {
  companyId: number
  userId: number
  realName?: string
  idCard?: string
  bankCard?: string
  resumeUrl?: string
  portfolioUrl?: string
}

/** CSV 导入结果 */
export interface OrgImportResult {
  ok: boolean
  error?: string
  companies: number
  departments: number
  users: number
  memberships: number
  skipped: number
  errors: string[]
}

/** 登录会话（多端） */
export interface ServerSession {
  id: number
  device: string
  ip: string
  location?: string
  createdAt: string
  expiresAt: string
  lastActiveAt?: string
  expired?: boolean
}

/** 新设备登录推送（其余在线端收到弹窗提醒） */
export interface NewDeviceLoginEvent {
  sessionId: number
  device: string
  ip: string
  at: string
}

/** 会话被踢下线 / 过期（本端需清 token 回登录页） */
export interface SessionRevokedEvent {
  sessionId: number
  reason: string
  device?: string
  at?: string
}

// ─── WebRTC 信令 ─────────────────────────────────────────

export type RtcKind = 'video' | 'voice'
export type RtcType = 'dm' | 'conf' | 'group'

export interface RtcRoom {
  id: string
  type: RtcType
  kind: RtcKind
  meetingNo?: string
  title?: string
  hasPassword: boolean
  hostId: number
  groupId?: number
  started: boolean
  createdAt: number
}

export interface RtcPeer {
  socketId: string
  userId: number
  nick: string
  avatar?: string
}

export interface RtcIceServer {
  urls: string | string[]
  username?: string
  credential?: string
}

export interface RtcSignalSdp {
  type: 'offer' | 'answer'
  sdp: string
}

export interface RtcSignalIce {
  type: 'ice'
  candidate: string
  sdpMid?: string | null
  sdpMLineIndex?: number | null
}

export type RtcSignalPayload = RtcSignalSdp | RtcSignalIce

export interface RtcDmIncomingEvent {
  room: string
  kind: RtcKind
  from: { userId: number; nick: string; avatar?: string }
  ts: number
}

export type HolidayType = 'legal' | 'workday' | 'custom'
export interface Holiday {
  id: number
  /** 日期 YYYY-MM-DD（唯一） */
  date: string
  name: string
  /** legal=法定假期，workday=周末调休补班，custom=自定义 */
  type: HolidayType
  createdAt: string
}

export interface RtcGroupCallEvent {
  room: string
  kind: RtcKind
  groupId: number
  from: { userId: number; nick: string; avatar?: string }
  ts: number
}

export interface RtcPeerJoinedEvent {
  room: string
  peer: RtcPeer
}

export interface RtcPeerLeftEvent {
  room: string
  peerId: string
}

export interface RtcSignalEvent {
  room: string
  from: { userId: number; nick: string; avatar?: string }
  signal: RtcSignalPayload
}

export interface RtcEndedEvent {
  room: string
  reason: string
  by: { userId: number; nick: string }
}

export interface RtcDmRejectedEvent {
  room: string
  by: { userId: number; nick: string }
}

// ─── 个人信息 / 会议窗口 / 会议内聊天 ─────────────────────

export interface UserProfileUpdateAck {
  ok: boolean
  error?: string
  user?: { id: number; username: string; nick?: string; avatar?: string; email?: string; phone?: string; extra?: string }
}

export interface RtcChatMessageEvent {
  room: string
  from: { userId: number; nick: string; avatar?: string }
  content: string
  ts: number
}

export interface OpenMeetingWindowParams {
  mode: 'create' | 'join'
  kind?: 'video' | 'voice'
  meetingNo?: string
  password?: string
}


/** 主邮件配置读取结果（含当前用户是否 SERVER_ADMIN、来源、是否可改） */
export interface MainMailInfo extends Ack {
  data?: {
    serverAdmin: boolean
    source: 'env' | 'db'
    canEdit: boolean
    config: {
      email: string
      displayName: string
      host: string
      port: number
      secure: boolean
      user: string
      enabled: boolean
      isDefault: boolean
      password: string
    } | null
  }
}

/** 设置主邮件的入参（需 SERVER_ADMIN；仅环境未配置时生效） */
export interface MainMailInput {
  email: string
  displayName?: string
  host: string
  port?: number
  secure?: boolean
  user?: string
  password: string
}

