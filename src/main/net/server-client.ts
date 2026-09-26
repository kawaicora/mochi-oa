/**
 * Mochi OA - 中心服务器客户端（Socket.IO 封装，主进程单例）。
 *
 * 架构：renderer → preload(window.pantry) → ipcMain(server-ipc) → 本文件 → socket.io → teahouse-server。
 * 本文件只负责 socket 生命周期与事件协议，不依赖任何 teahouse 原有代码。
 */
import { io, type Socket } from 'socket.io-client'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { getClientLocation } from './location'
import { constants, publicEncrypt } from 'node:crypto'
import type {
  Ack,
  AuthAck,
  Company,
  CompanyInvitation,
  CompanyMembership,
  ConversationItem,
  Department,
  Group,
  GroupInviteEvent,
  InvitationStatus,
  MemberProfile,
  OrgImportResult,
  RtcDmIncomingEvent,
  RtcDmRejectedEvent,
  RtcEndedEvent,
  RtcGroupCallEvent,
  RtcIceServer,
  RtcKind,
  RtcPeer,
  RtcPeerJoinedEvent,
  RtcPeerLeftEvent,
  RtcRoom,
  RtcSignalEvent,
  RtcSignalPayload,
  RtcChatMessageEvent,
  ServerChatMessage,
  ServerClientState,
  ServerConnState,
  ServerMessageDeleted,
  ServerPresenceUpdate,
  ServerGroupMember,
  ServerSession,
  UserInfo,
  UserProfileUpdateAck
} from '../../shared/server-types'

/** 上报给服务端的设备标识（用于登录会话列表 / 新设备登录弹窗） */
function buildDeviceLabel(): string {
  return `MochiOA ${os.type()} ${os.release()} ${os.arch()}`
}

export interface ServerClientOptions {
  serverUrl: string
  token?: string
}

/** 带超时的 emit + ack 包装。
 *  服务端 ack 结构为 `{ ok:true, fieldA, fieldB }`（字段在顶层），
 *  客户端统一规整为 `{ ok, error, data:{ fieldA, fieldB } }`，供 applyAuthAck / 各 store 用 ack.data 读取。 */
function emitWithAck<T = unknown>(
  socket: Socket,
  event: string,
  payload: unknown,
  timeoutMs = 10000
): Promise<Ack & { data?: T }> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      resolve({ ok: false, error: '请求超时' })
    }, timeoutMs)
    socket.emit(event, payload, (raw: unknown) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(normalizeAck<T>(raw))
    })
  })
}

/** 把服务端顶层字段 ack 规整为 { ok, error, data } */
function normalizeAck<T>(raw: unknown): Ack & { data?: T } {
  if (!raw || typeof raw !== 'object') return { ok: false, error: '无响应' }
  const a = raw as Record<string, unknown>
  const data: Record<string, unknown> = {}
  for (const k of Object.keys(a)) {
    if (k === 'ok' || k === 'error') continue
    data[k] = a[k]
  }
  return {
    ok: a.ok === true,
    error: typeof a.error === 'string' && a.error ? a.error : undefined,
    data: Object.keys(data).length ? (data as T) : undefined
  }
}

/**
 * 用 node:http/https 发 POST（主进程 net.fetch 在部分 Electron 版本/打包下为 null，不依赖它）。
 * 支持任意 URL（http/https）、自定义请求头、Buffer/string body；返回状态码 + 响应文本。
 */
function httpPost(url: string, headers: Record<string, string>, body: Buffer | string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('URL 不合法'))
      return
    }
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body)
    const req = mod(
      u,
      { method: 'POST', headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(Buffer.from(c)))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }))
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

/** 尝试把响应文本解析成 JSON，失败返回 null */
function parseJson(text: string): Record<string, unknown> | null {
  const t = text.trim()
  if (!t.startsWith('{') && !t.startsWith('[')) return null
  try {
    return JSON.parse(t) as Record<string, unknown>
  } catch {
    return null
  }
}

/** 用 node:http/https 发 GET，返回状态码 + 原始 Buffer（文件内容为二进制）。 */
function httpGet(url: string): Promise<{ status: number; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    let u: URL
    try {
      u = new URL(url)
    } catch (e) {
      reject(e instanceof Error ? e : new Error('URL 不合法'))
      return
    }
    const mod = u.protocol === 'https:' ? httpsRequest : httpRequest
    const req = mod(u, { method: 'GET' }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(Buffer.from(c)))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

export class ServerClient extends EventEmitter {
  private socket: Socket | null = null
  private _state: ServerClientState = {
    connected: false,
    state: 'idle',
    serverUrl: '',
    userId: undefined,
    username: undefined,
    nick: undefined,
    avatar: undefined,
    phone: undefined,
    extra: undefined,
    token: undefined,
    error: undefined,
    activeCompanyId: 0
  }
  private token = ''
  /** 当前连接的 RSA 登录加密公钥（每次连接从服务端获取，连接销毁即失效） */
  private pubKey: string | null = null

  get state(): ServerClientState {
    return { ...this._state }
  }

  get isAuthenticated(): boolean {
    return this._state.connected && this._state.state === 'connected' && this._state.userId != null
  }

  get currentToken(): string {
    return this.token
  }

  private setState(patch: Partial<ServerClientState>): void {
    this._state = { ...this._state, ...patch }
    this.emit('state', this.state)
  }

  connect(opts: ServerClientOptions): void {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.token = opts.token ?? ''
    this.setState({
      serverUrl: opts.serverUrl,
      state: 'connecting',
      connected: false,
      error: undefined
    })

    const socket = io(opts.serverUrl, {
      auth: this.token ? { token: this.token, device: buildDeviceLabel() } : { device: buildDeviceLabel() },
      transports: ['websocket', 'polling'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 10000,
      timeout: 8000
    })
    this.socket = socket
    this.pubKey = null // 新连接对应服务端新的 RSA 密钥对，需重新获取公钥

    socket.on('connect', () => {
      this.setState({ state: 'connected', connected: true, error: undefined })
      if (this.token) {
        void this.authMe().then((ack) => {
          if (!ack.ok) {
            this.setState({ state: 'connected', connected: true, userId: undefined, error: ack.error || '会话已失效' })
          }
        })
      }
    })
    socket.on('disconnect', (reason) => {
      this.setState({
        state: 'disconnected',
        connected: false,
        error: reason === 'io server disconnect' ? '服务端断开连接' : undefined
      })
    })
    socket.on('connect_error', (err) => {
      this.setState({ state: 'error', connected: false, error: err.message })
    })

    socket.on('chat:message', (msg: ServerChatMessage) => this.emit('message', msg))
    socket.on('dm:message', (msg: ServerChatMessage) => this.emit('message', msg))
    socket.on('presence:update', (p: ServerPresenceUpdate) => this.emit('presence', p))
    socket.on('user:profileUpdated', (d: { user: { id: number; username: string; nick: string; avatar: string; email: string; phone: string; extra: string } }) => this.emit('userProfileUpdated', d))
    socket.on('message:deleted', (d: ServerMessageDeleted) => this.emit('messageDeleted', d))
    socket.on('conversations:updated', (d: unknown) => this.emit('conversationsUpdated', d))

    // 多会话推送：新设备登录 → 本端弹窗提醒；本端会话被踢/过期 → 清 token 回登录页
    socket.on('auth:newDeviceLogin', (d: { sessionId: number; device: string; ip: string; at: string }) =>
      this.emit('sessionNewDevice', d)
    )
    socket.on('auth:sessionRevoked', (d: { sessionId: number; reason: string; device?: string; at?: string }) => {
      this.emit('sessionRevoked', d)
      if (this.token) {
        this.token = ''
        this.setState({ token: undefined, userId: undefined, username: undefined })
      }
    })

    // RTC 信令推送（服务端 → 本端）
    socket.on('rtc:dmIncoming', (d: RtcDmIncomingEvent) => this.emit('rtcDmIncoming', d))
    socket.on('rtc:dmRejected', (d: RtcDmRejectedEvent) => this.emit('rtcDmRejected', d))
    socket.on('rtc:peerJoined', (d: RtcPeerJoinedEvent) => this.emit('rtcPeerJoined', d))
    socket.on('rtc:peerLeft', (d: RtcPeerLeftEvent) => this.emit('rtcPeerLeft', d))
    socket.on('rtc:signal', (d: RtcSignalEvent) => this.emit('rtcSignal', d))
    socket.on('rtc:ended', (d: RtcEndedEvent) => this.emit('rtcEnded', d))
    socket.on('rtc:groupCall', (d: RtcGroupCallEvent) => this.emit('rtcGroupCall', d))
    socket.on('rtc:chatMessage', (d: RtcChatMessageEvent) => this.emit('rtcChatMessage', d))
    socket.on('group:members-updated', (d: { groupId: number }) => this.emit('groupMembersUpdated', d))
    socket.on('group:invite', (d: GroupInviteEvent) => this.emit('groupInvite', d))
    socket.on('group:dissolved', (d: { groupId: number }) => this.emit('groupDissolved', d))
    socket.on('company:dissolved', (d: { companyId: number }) => this.emit('companyDissolved', d))
    socket.on('company:updated', (d: { companyId: number }) => this.emit('companyUpdated', d))
    socket.on('company:removed', (d: { companyId: number }) => this.emit('companyRemoved', d))
    socket.on('company:added', (d: { companyId: number }) => this.emit('companyAdded', d))
    socket.on('group:added', (d: { groupId: number }) => this.emit('groupAdded', d))
    socket.on('group:removed', (d: { groupId: number }) => this.emit('groupRemoved', d))
    socket.on('friends:updated', () => this.emit('friendsUpdated'))
  }

  disconnect(): void {
    if (this.socket) {
      this.socket.disconnect()
      this.socket = null
    }
    this.token = ''
    this.setState({ state: 'idle', connected: false, userId: undefined, username: undefined, nick: undefined, avatar: undefined, token: undefined, error: undefined, activeCompanyId: 0 })
  }

  // ─── 账号 ───────────────────────────────────────────────

  /** 获取当前连接的服务端 RSA 公钥（登录/注册凭据加密用） */
  private async ensurePublicKey(): Promise<boolean> {
    if (this.pubKey) return true
    if (!this.socket) return false
    const ack = await emitWithAck<{ publicKey: string }>(this.socket, 'auth:getPublicKey', {})
    if (ack.ok && ack.data?.publicKey) {
      this.pubKey = ack.data.publicKey
      return true
    }
    return false
  }

  /** 用服务端公钥加密对象 → base64（RSA PKCS1）。登录/注册的敏感字段走加密传输 */
  private encryptCreds(payload: Record<string, unknown>): string | null {
    try {
      if (!this.pubKey) return null
      const buf = publicEncrypt(
        { key: this.pubKey, padding: constants.RSA_PKCS1_PADDING },
        Buffer.from(JSON.stringify(payload), 'utf8')
      )
      return buf.toString('base64')
    } catch {
      return null
    }
  }

  /** 注册；若提供 avatarPath（可选），注册成功后自动上传头像并写入资料 */
  async register(username: string, password: string, nick?: string, email?: string, avatarPath?: string, code?: string): Promise<AuthAck> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    if (!(await this.ensurePublicKey())) return { ok: false, error: '获取注册加密公钥失败' }
    const enc = this.encryptCreds({ username, password })
    if (!enc) return { ok: false, error: '注册凭据加密失败' }
    const ci = await getClientLocation()
    const ack = await emitWithAck<{ token: string; user: UserInfo; companies: CompanyMembership[] }>(
      this.socket, 'auth:register', { enc, nick, email, code, device: buildDeviceLabel(), clientInfo: ci }
    )
    // 注册不自动登录：不 setState(userId/token)，由渲染层随后登出清理服务端自动创建的会话
    if (!ack.ok) return { ok: false, error: ack.error || '注册失败' }
    // 可选：注册成功后用服务端自动创建的会话上传头像（随后渲染层仍会登出清理）
    if (avatarPath && ack.data) {
      const savedToken = this.token
      this.token = ack.data.token // 让 uploadFile 携带有效 token
      try {
        const up = await this.uploadFile(avatarPath, 0)
        if (up.ok && up.data?.url) {
          await emitWithAck(this.socket, 'user:updateProfile', { avatar: up.data.url })
        }
      } catch {
        // 头像上传失败不影响注册本身
      }
      this.token = savedToken
    }
    return { ok: true }
  }

  /** 登录：账号可为用户名或邮箱；支持密码登录，或邮箱验证码登录（传 code） */
  async login(account: string, password?: string, code?: string): Promise<AuthAck> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    if (!(await this.ensurePublicKey())) return { ok: false, error: '获取登录加密公钥失败' }
    const enc = this.encryptCreds(code ? { account, code } : { account, password })
    if (!enc) return { ok: false, error: '登录凭据加密失败' }
    const ci = await getClientLocation()
    const ack = await emitWithAck<{ token: string; user: UserInfo; companies: CompanyMembership[] }>(
      this.socket, 'auth:login', { enc, device: buildDeviceLabel(), clientInfo: ci }
    )
    return this.applyAuthAck(ack)
  }

  /** 发送邮箱验证码（注册验证 / 验证码登录） */
  async sendEmailCode(email: string, purpose: 'register' | 'login'): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'auth:sendEmailCode', { email, purpose })
  }

  /** 忘记密码：向绑定邮箱发送重置验证码 */
  async sendResetCode(email: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'auth:sendResetCode', { email })
  }

  /** 忘记密码：验证码通过后发送重置密码邮件（含 /view/reset-pwd 链接） */
  async sendResetMail(email: string, code: string, baseUrl: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'auth:sendResetMail', { email, code, baseUrl })
  }

  private applyAuthAck(ack: Ack & { data?: { token: string; user: UserInfo; companies: CompanyMembership[] } }): AuthAck {
    if (ack.ok && ack.data) {
      this.token = ack.data.token
      this.setState({
        token: ack.data.token,
        userId: ack.data.user.id,
        username: ack.data.user.username,
        nick: ack.data.user.nick,
        avatar: ack.data.user.avatar,
        phone: ack.data.user.phone ?? '',
        extra: ack.data.user.extra ?? '',
        connected: true,
        error: undefined
      })
      this.emit('authenticated', ack.data.user)
      return { ok: true, token: ack.data.token, userId: ack.data.user.id, username: ack.data.user.username, nick: ack.data.user.nick }
    }
    return { ok: false, error: ack.error || '登录失败' }
  }

  async logout(): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    const ack = await emitWithAck(this.socket, 'auth:logout', {})
    this.token = ''
    this.setState({ token: undefined, userId: undefined, username: undefined, nick: undefined, avatar: undefined, connected: false, state: 'connected' })
    return ack
  }

  async authMe(): Promise<Ack & { data?: { user: UserInfo; companies: CompanyMembership[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    const ack = await emitWithAck<{ user: UserInfo; companies: CompanyMembership[] }>(this.socket, 'auth:me', {})
    if (ack.ok && ack.data) {
      this.setState({ userId: ack.data.user.id, username: ack.data.user.username, nick: ack.data.user.nick, avatar: ack.data.user.avatar, phone: ack.data.user.phone ?? '', extra: ack.data.user.extra ?? '', connected: true, error: undefined })
      this.emit('authenticated', ack.data.user)
    }
    return ack
  }

  // ─── 登录会话（多端）/ 账号安全 ──────────────────────────

  async listSessions(): Promise<Ack & { data?: { sessions: ServerSession[]; currentSessionId?: number; sessionDays?: number | null } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ sessions: ServerSession[]; currentSessionId?: number; sessionDays?: number | null }>(this.socket, 'auth:sessions', {})
  }

  async endSession(sessionId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'auth:endSession', { sessionId })
  }

  async endAllSessions(): Promise<Ack & { data?: { ended: number } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ ended: number }>(this.socket, 'auth:endAllSessions', {})
  }

  async setSessionDays(days: number | null): Promise<Ack & { data?: { sessionDays: number | null } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ sessionDays: number | null }>(this.socket, 'auth:setSessionDays', { days })
  }

  setActiveCompany(companyId: number): void {
    this.setState({ activeCompanyId: companyId })
  }

  // ─── 公司 / 部门 ────────────────────────────────────────

  async listCompanies(): Promise<Ack & { data?: { companies: CompanyMembership[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ companies: CompanyMembership[] }>(this.socket, 'company:list', {})
  }

  async createCompany(name: string, code?: string): Promise<Ack & { data?: { company: Company } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ company: Company }>(this.socket, 'company:create', { name, code })
  }

  async joinCompany(code: string): Promise<Ack & { data?: { company: Company } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ company: Company }>(this.socket, 'company:join', { code })
  }

  async leaveCompany(companyId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:leave', { companyId })
  }

  async searchCompanies(keyword?: string): Promise<Ack & { data?: { companies: Company[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ companies: Company[] }>(this.socket, 'company:search', keyword ? { keyword } : {})
  }

  async setCompanyRole(companyId: number, userId: number, role: 'owner' | 'admin' | 'member'): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:setRole', { companyId, userId, role })
  }

  async kickCompanyMember(companyId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:kick', { companyId, userId })
  }

  async searchUsers(keyword: string): Promise<Ack & { data?: { users: Array<{ id: number; username: string; nick?: string; avatar?: string }> } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ users: Array<{ id: number; username: string; nick?: string; avatar?: string }> }>(this.socket, 'user:search', { keyword })
  }

  async addCompanyMember(companyId: number, target: number | string, departmentId?: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    const isId = typeof target === 'number'
    return emitWithAck(this.socket, 'company:addMember', {
      companyId,
      userId: isId ? target : 0,
      username: isId ? undefined : String(target),
      departmentId: departmentId ?? null
    })
  }

  async renameCompany(companyId: number, name: string): Promise<Ack & { data?: { company: Company } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ company: Company }>(this.socket, 'company:rename', { companyId, name })
  }

  async listDepartments(companyId: number): Promise<Ack & { data?: { departments: Department[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ departments: Department[] }>(this.socket, 'company:listDepartments', { companyId })
  }

  async createDepartment(companyId: number, name: string, parentId?: number): Promise<Ack & { data?: { department: Department } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ department: Department }>(this.socket, 'company:createDepartment', { companyId, name, parentId })
  }

  async deleteDepartment(companyId: number, departmentId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:deleteDepartment', { companyId, departmentId })
  }

  async assignDepartment(departmentId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'department:assign', { departmentId, userId })
  }

  async removeDepartmentMember(departmentId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'department:removeMember', { departmentId, userId })
  }

  async companyMembers(companyId: number): Promise<Ack & { data?: { members: UserInfo[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ members: UserInfo[] }>(this.socket, 'company:members', { companyId })
  }

  async departmentMembers(departmentId: number): Promise<Ack & { data?: { members: UserInfo[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ members: UserInfo[] }>(this.socket, 'department:members', { departmentId })
  }

  // ─── 邀请 ───────────────────────────────────────────────

  async invite(companyId: number, opts?: { expiresAt?: string }): Promise<Ack & { data?: { invitation: CompanyInvitation } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ invitation: CompanyInvitation }>(this.socket, 'company:invite', { companyId, ...(opts ?? {}) })
  }

  async myInvites(): Promise<Ack & { data?: { invitations: CompanyInvitation[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ invitations: CompanyInvitation[] }>(this.socket, 'company:myInvites', {})
  }

  async listInvitations(companyId: number): Promise<Ack & { data?: { invitations: CompanyInvitation[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ invitations: CompanyInvitation[] }>(this.socket, 'company:listInvitations', { companyId })
  }

  async acceptInvite(code: string): Promise<Ack & { data?: { company: Company } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ company: Company }>(this.socket, 'company:acceptInvite', { code })
  }

  async declineInvite(invitationId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:declineInvite', { invitationId })
  }

  // ─── 人事信息 ───────────────────────────────────────────

  async getProfile(companyId: number): Promise<Ack & { data?: { profile: MemberProfile } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ profile: MemberProfile }>(this.socket, 'member:getProfile', { companyId })
  }

  async updateProfile(companyId: number, profile: Partial<MemberProfile>): Promise<Ack & { data?: { profile: MemberProfile } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ profile: MemberProfile }>(this.socket, 'member:updateProfile', { companyId, ...profile })
  }

  // ─── 群 ─────────────────────────────────────────────────

  async listGroups(): Promise<Ack & { data?: { groups: Group[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ groups: Group[] }>(this.socket, 'group:list', {})
  }

  async createGroup(companyId: number, name: string, departmentId?: number): Promise<Ack & { data?: { group: Group } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ group: Group }>(this.socket, 'group:create', { companyId, name, departmentId })
  }

  async joinGroup(code: string): Promise<Ack & { data?: { group: Group } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ group: Group }>(this.socket, 'group:join', { code })
  }

  async leaveGroup(groupId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:leave', { groupId })
  }

  async searchGroups(companyId?: number, keyword?: string): Promise<Ack & { data?: { groups: Group[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    const payload: Record<string, unknown> = {}
    if (companyId !== undefined) payload.companyId = companyId
    if (keyword) payload.keyword = keyword
    return emitWithAck<{ groups: Group[] }>(this.socket, 'group:search', payload)
  }

  async kickGroupMember(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:kick', { groupId, userId })
  }

  async groupMembers(groupId: number): Promise<Ack & { data?: { members: ServerGroupMember[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ members: ServerGroupMember[] }>(this.socket, 'group:members', { groupId })
  }
  async groupSetAdmin(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:setAdmin', { groupId, userId })
  }
  async groupUnsetAdmin(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:unsetAdmin', { groupId, userId })
  }
  async groupMute(groupId: number, userId: number, seconds: number): Promise<Ack & { data?: { mutedUntil: string | null } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ mutedUntil: string | null }>(this.socket, 'group:mute', { groupId, userId, seconds })
  }
  async groupAdd(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:add', { groupId, userId })
  }
  async groupInvite(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:invite', { groupId, userId })
  }
  async groupAcceptInvite(groupId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:acceptInvite', { groupId })
  }
  async groupDeclineInvite(groupId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:declineInvite', { groupId })
  }
  async groupTransfer(groupId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:transfer', { groupId, userId })
  }
  async groupDissolve(groupId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'group:dissolve', { groupId })
  }
  async companyTransfer(companyId: number, userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:transfer', { companyId, userId })
  }
  async companyDissolve(companyId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'company:dissolve', { companyId })
  }

  // ─── 消息 ───────────────────────────────────────────────

  async sendGroupMessage(groupId: number, content: string, kind: 'text' | 'image' | 'file' | 'video' | 'folder' = 'text'): Promise<Ack & { data?: { id: string } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ id: string }>(this.socket, 'chat:send', { groupId, kind, content })
  }

  async groupHistory(groupId: number, beforeTs?: number, limit = 50): Promise<Ack & { data?: { messages: ServerChatMessage[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ messages: ServerChatMessage[] }>(this.socket, 'chat:history', { groupId, beforeTs, limit })
  }

  async sendDmMessage(toUserId: number, content: string, kind: 'text' | 'image' | 'file' | 'video' | 'folder' = 'text'): Promise<Ack & { data?: { id: string } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ id: string }>(this.socket, 'dm:send', { toUserId, kind, content })
  }

  async dmHistory(withUserId: number, beforeTs?: number, limit = 50): Promise<Ack & { data?: { messages: ServerChatMessage[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ messages: ServerChatMessage[] }>(this.socket, 'dm:history', { withUserId, beforeTs, limit })
  }

  // ─── 会话列表 / 置顶 / 已读 ─────────────────────────────

  async listConversations(type?: 'group' | 'dm'): Promise<Ack & { data?: { conversations: ConversationItem[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ conversations: ConversationItem[] }>(this.socket, 'conversation:list', type ? { type } : {})
  }

  async pinConversation(conversationId: number, pinned: boolean): Promise<Ack & { data?: { pinned: boolean } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ pinned: boolean }>(this.socket, 'conversation:pin', { conversationId, pinned })
  }

  async markConversationRead(conversationId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'conversation:read', { conversationId })
  }

  // ─── 删除 ───────────────────────────────────────────────

  async deleteMessage(conversationId: number, messageId: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'message:delete', { conversationId, messageId })
  }

  async hardDeleteMessage(conversationId: number, messageId: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'message:hardDelete', { conversationId, messageId })
  }

  // ─── 好友 ───────────────────────────────────────────────

  async listFriends(): Promise<Ack & { data?: { friends: UserInfo[] } }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<{ friends: UserInfo[] }>(this.socket, 'friend:list', {})
  }

  async addFriend(userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'friend:add', { userId })
  }

  async removeFriend(userId: number): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck(this.socket, 'friend:remove', { userId })
  }

  // ─── CSV 导入 ───────────────────────────────────────────

  async importCsv(csv: string): Promise<Ack & { data?: OrgImportResult }> {
    if (!this.socket) return { ok: false, error: '未连接' }
    return emitWithAck<OrgImportResult>(this.socket, 'org:importCsv', { csv })
  }

  // ─── 文件上传（HTTP 中继） ──────────────────────────────

  async uploadFile(filePath: string, companyId = 0): Promise<Ack & { data?: { url?: string; uuid?: string; fileName?: string; size?: number } }> {
    if (!this.token) return { ok: false, error: '未登录' }
    try {
      const { readFile } = await import('node:fs/promises')
      const { basename } = await import('node:path')
      const buf = await readFile(filePath)
      const name = basename(filePath)
      const boundary = '----moshi-' + Math.random().toString(16).slice(2)
      const CRLF = '\r\n'
      const head = Buffer.from(
        `--${boundary}${CRLF}` +
        `Content-Disposition: form-data; name="file"; filename="${name.replace(/"/g, '')}"${CRLF}` +
        'Content-Type: application/octet-stream' + CRLF + CRLF
      )
      const tail = Buffer.from(`${CRLF}--${boundary}--${CRLF}`)
      const body = Buffer.concat([head, buf, tail])
      const url = `${this._state.serverUrl.replace(/\/$/, '')}/api/upload?token=${encodeURIComponent(this.token)}&company=${companyId}`
      // 主进程用 node:http/https 手写 POST（net.fetch 在部分 Electron 版本为 null，不依赖它）
      const res = await httpPost(url, { 'Content-Type': `multipart/form-data; boundary=${boundary}` }, body)
      const data = parseJson(res.text) as { ok?: boolean; error?: string; fileName?: string; url?: string; uuid?: string; size?: number } | null
      if (!data || typeof data !== 'object' || !data.ok) return { ok: false, error: data?.error || `上传失败（http ${res.status}）` }
      return { ok: true, data: { url: data.url, uuid: data.uuid, fileName: data.fileName, size: data.size } }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // 分块上传（带进度回调；服务端按 uploadId 暂存分块，支持断点续传；relativePath 保留文件夹结构）
  async uploadFileChunked(
    filePath: string,
    onProgress?: (percent: number) => void,
    companyId = 0,
    relativePath = ''
  ): Promise<{ ok: boolean; error?: string; url?: string; uuid?: string; fileName?: string; size?: number }> {
    if (!this.token) return { ok: false, error: '未登录（无会话 token，请重新登录）' }
    const base = this._state.serverUrl.replace(/\/$/, '')
    if (!base) return { ok: false, error: '未配置服务器地址' }
    const authQ = `token=${encodeURIComponent(this.token)}&company=${companyId}`
    const CHUNK = 1024 * 1024 // 1MB/块
    // console.log(`[upload] 开始分块上传 ${filePath} -> ${base}/api/upload/chunk (company=${companyId})`)
    try {
      const { randomUUID } = await import('node:crypto')
      const { readFile, stat } = await import('node:fs/promises')
      const { basename } = await import('node:path')
      const uploadId = randomUUID()
      const { size } = await stat(filePath)
      const name = basename(filePath)
      const ext = (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase()
      const mime =
        /^(png|jpe?g|gif|webp|bmp|svg)$/.test(ext) ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
        : /^(mp4|webm|mov|mkv|avi|m4v|flv)$/.test(ext) ? `video/${ext}`
        : 'application/octet-stream'
      const total = Math.max(1, Math.ceil(size / CHUNK))
      const CRLF = '\r\n'
      const buf = await readFile(filePath)
      const field = (b: string, k: string, v: string): string =>
        `--${b}${CRLF}Content-Disposition: form-data; name="${k}"${CRLF}${CRLF}${v}${CRLF}`

      for (let i = 0; i < total; i++) {
        const start = i * CHUNK
        const end = Math.min(size, start + CHUNK)
        const b = '----moshi-' + Math.random().toString(16).slice(2)
        const head = Buffer.from(
          field(b, 'uploadId', uploadId) +
          field(b, 'chunkIndex', String(i)) +
          field(b, 'totalChunks', String(total)) +
          `--${b}${CRLF}Content-Disposition: form-data; name="file"; filename="chunk"${CRLF}` +
          'Content-Type: application/octet-stream' + CRLF + CRLF
        )
        const tail = Buffer.from(`${CRLF}--${b}--${CRLF}`)
        const body = Buffer.concat([head, buf.subarray(start, end), tail])
        const res = await httpPost(`${base}/api/upload/chunk?${authQ}`, { 'Content-Type': `multipart/form-data; boundary=${b}` }, body)
        const data = parseJson(res.text) as { ok?: boolean } | null
        // console.log(`[upload] 分块 ${i + 1}/${total}: http=${res.status} ok=${data?.ok}`)
        if (!data?.ok) throw new Error(`分块 ${i + 1}/${total} 上传失败（http ${res.status}）`)
        onProgress?.(Math.round(((i + 1) / total) * 100))
      }

      const compRes = await httpPost(`${base}/api/upload/chunk/complete?${authQ}`, { 'Content-Type': 'application/json' }, JSON.stringify({ uploadId, filename: name, totalChunks: total, mime, relativePath }))
      const comp = parseJson(compRes.text) as { ok?: boolean; error?: string; url?: string; uuid?: string; filename?: string; size?: number } | null
      // console.log(`[upload] complete: http=${compRes.status} ok=${comp?.ok} url=${comp?.url} ${comp?.error || ''}`)
      if (!comp?.ok) throw new Error(comp?.error || `合并文件失败（http ${compRes.status}）`)
      return { ok: true, url: comp.url, uuid: comp.uuid, fileName: comp.filename, size: comp.size }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── 文件夹下载（HTTP：清单 → 逐文件落盘到配置目录） ──────
  async downloadFile(url: string): Promise<{ ok: boolean; error?: string; buf?: Buffer }> {
    if (!this.token) return { ok: false, error: '未登录' }
    try {
      const fr = await httpGet(String(url))
      if (fr.status >= 200 && fr.status < 300) return { ok: true, buf: fr.buf }
      return { ok: false, error: `下载失败（http ${fr.status}）` }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  async downloadFolder(relPath: string, destDir: string): Promise<{ ok: boolean; error?: string; destDir?: string; count?: number }> {
    if (!this.token) return { ok: false, error: '未登录' }
    const base = this._state.serverUrl.replace(/\/$/, '')
    if (!base) return { ok: false, error: '未配置服务器地址' }
    try {
      const { mkdir, writeFile } = await import('node:fs/promises')
      const { join, normalize, sep } = await import('node:path')
      const listUrl = `${base}/api/folder/files?path=${encodeURIComponent(relPath)}&token=${encodeURIComponent(this.token)}`
      const lr = await httpGet(listUrl)
      const list = parseJson(lr.buf.toString('utf8')) as { ok?: boolean; error?: string; files?: { relPath?: string; url?: string }[] } | null
      if (!list?.ok) return { ok: false, error: list?.error || `获取文件夹清单失败（http ${lr.status}）` }
      const files = list.files ?? []
      // 落盘结构：去掉首段(companyKey) 后为 {文件夹名}/{子目录...}/{文件}，保持与发送一致
      const stripCompany = (p: string): string => p.split('/').slice(1).join('/')
      let count = 0
      for (const f of files) {
        if (!f.url || !f.relPath) continue
        const localRel = stripCompany(f.relPath)
        if (!localRel) continue
        const target = normalize(join(destDir, localRel))
        const baseNorm = normalize(destDir)
        if (target !== baseNorm && !target.startsWith(baseNorm + sep)) continue // 防穿越
        await mkdir(join(target, '..'), { recursive: true })
        const fr = await httpGet(f.url)
        if (fr.status >= 200 && fr.status < 300) {
          await writeFile(target, fr.buf)
          count += 1
        }
      }
      return { ok: true, destDir, count }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }

  // ─── RTC 信令 ───────────────────────────────────────────

  async rtcCreateMeeting(opts: { title?: string; startAt?: string; password?: string; kind: RtcKind }): Promise<Ack & { data?: { meeting: RtcRoom; scheduled: boolean; peers?: RtcPeer[]; iceServers?: RtcIceServer[] } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck<{ meeting: RtcRoom; scheduled: boolean; peers?: RtcPeer[]; iceServers?: RtcIceServer[] }>(this.socket, 'rtc:createMeeting', opts)
  }

  async rtcGetMeeting(meetingNo: string): Promise<Ack & { data?: { meeting: RtcRoom } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck<{ meeting: RtcRoom }>(this.socket, 'rtc:getMeeting', { meetingNo })
  }

  async rtcJoin(roomId: string, password?: string, kind?: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[]; started: boolean } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    const payload: Record<string, unknown> = { roomId }
    if (password) payload.password = password
    if (kind) payload.kind = kind
    return emitWithAck<{ room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[]; started: boolean }>(this.socket, 'rtc:join', payload)
  }

  async rtcSignal(roomId: string, signal: RtcSignalPayload): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'rtc:signal', { roomId, signal })
  }

  async rtcLeave(roomId: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'rtc:leave', { roomId })
  }

  async rtcEnd(roomId: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'rtc:end', { roomId })
  }

  async rtcDmCall(userId: number, kind: RtcKind): Promise<Ack & { data?: { room: RtcRoom; kind: RtcKind } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck<{ room: RtcRoom; kind: RtcKind }>(this.socket, 'rtc:dmCall', { userId, kind })
  }

  async rtcDmAnswer(roomId: string, accept: boolean): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck<{ room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] }>(this.socket, 'rtc:dmAnswer', { roomId, accept })
  }

  async rtcGroupCall(groupId: number, kind: RtcKind): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck<{ room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] }>(this.socket, 'rtc:groupCall', { groupId, kind })
  }

  async rtcChatMessage(roomId: string, content: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'rtc:chatMessage', { roomId, content })
  }

  // ─── 个人信息 ───────────────────────────────────────────

  async userUpdateProfile(patch: { nick?: string; avatar?: string; phone?: string; extra?: { emergency: Array<{ name: string; phone: string }> } }): Promise<UserProfileUpdateAck> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    const ack = await emitWithAck<{ user: { id: number; username: string; nick?: string; avatar?: string; email?: string; phone?: string; extra?: string } }>(this.socket, 'user:updateProfile', patch)
    if (ack.ok && ack.data) {
      // 同步本地会话态：昵称/头像立即生效（不再回退默认）
      this.setState({ nick: ack.data.user.nick, avatar: ack.data.user.avatar, phone: ack.data.user.phone ?? '', extra: ack.data.user.extra ?? '' })
      return { ok: true, user: ack.data.user }
    }
    return { ok: false, error: ack.error || '更新失败' }
  }

  /** 修改密码：服务端校验旧密码 → 更新散列 → 踢下线其他会话 */
  async userChangePassword(oldPassword: string, newPassword: string): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'auth:changePassword', { oldPassword, newPassword })
  }

  /** 主邮件配置（含当前用户是否 SERVER_ADMIN、来源、是否可改） */
  async getMainMailConfig(): Promise<Ack & { data?: { serverAdmin: boolean; source: 'env' | 'db'; canEdit: boolean; config: {
    email: string; displayName: string; host: string; port: number; secure: boolean; user: string; enabled: boolean; isDefault: boolean; password: string
  } | null } }> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'mail:getMainConfig', {})
  }

  /** 设置主邮件配置（需 SERVER_ADMIN；仅当环境未配置主邮件时生效） */
  async setMainMailConfig(cfg: { email: string; displayName?: string; host: string; port?: number; secure?: boolean; user?: string; password: string }): Promise<Ack> {
    if (!this.socket) return { ok: false, error: '未连接服务器' }
    return emitWithAck(this.socket, 'mail:setMainConfig', cfg)
  }
}

export const serverClient = new ServerClient()
