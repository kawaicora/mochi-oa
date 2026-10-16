/**
 * RtcEngine — WebRTC peer connection 管理器。
 * 按对端 userId 维护 RTCPeerConnection，处理 offer/answer/ice 信令。
 * 注意：peer key 使用 userId（number），因为服务端 rtc:signal 事件的 from 只有 {userId, nick}。
 */

import type { RtcIceServer, RtcSignalPayload } from '@shared/server-types'

/**
 * 'disconnected' 的宽限期。
 *
 * WebRTC 的 'disconnected' 是【软状态】：丢包、切网、CPU 一时被抢占都可能进入，
 * 且通常几秒内自行恢复到 'connected'，此时连接和画面都没断。
 * 实测：多人在线时「有人新加入」会让所有既有连接同时瞬间 disconnected（建 PC 的突发负载），
 * 若宽限期太短就会把这些其实还活着的连接当成掉线拆掉重建 —— 画面黑一下又重建，
 * 反反复复就是循环掉线。所以这里给足自愈时间，只有真正回不来（或 'failed'）才重连。
 */
const DISCONNECT_GRACE_MS = 10000

export interface RtcEngineOptions {
  roomId: string
  /**
   * 本端 userId。用于【确定性地】判定每一对 peer 里谁发 offer：
   * 本端 userId 小于对端 → 本端发起。
   *
   * 服务端 rtc:signal 是「房间广播、无 target」，两端对「谁发起」必须有完全一致的判断。
   * 若按「谁先进房间」定，重连时两端会同时发 offer（glare），互相拆 PC → 掉线 → 再拆，
   * 形成永不停歇的乒乓。用 userId 比较则双向自洽，且跨重连保持稳定。
   * 缺省 0 时退化为「本端总是发起」，仅供单人自测。
   */
  myUserId?: number
  iceServers: RtcIceServer[]
  localStream: MediaStream
  onSignal: (signal: RtcSignalPayload) => void
  onRemoteStream: (userId: number, stream: MediaStream) => void
  /** 对端「意外」掉线（不是本端主动 closePeer/closeAll）——用于自动重连 */
  onPeerDisconnected: (userId: number) => void
  /** 对端连接建立成功（含重连成功）——重试逻辑靠它判定这一次成功了 */
  onPeerConnected?: (userId: number) => void
}

/** 把共享类型 RtcIceServer 转为 DOM 类型 RTCIceServer */
function toIceServers(ices: RtcIceServer[]): RTCIceServer[] {
  return ices.map((ice) => ({
    urls: ice.urls,
    username: ice.username,
    credential: ice.credential
  }))
}

/** 给 opus fmtp:111 行追加 stereo=1;sprop-stereo=1 */
function EnforceStereo(sdp: string): string {
  return sdp.replace(/(a=fmtp:111 .*)/g, (line) => {
    // 已有 stereo 配置则不重复追加
    if (/stereo=1/.test(line)) return line
    return line + ';stereo=1;sprop-stereo=1'
  })
}

/** 解析 ICE candidate 字符串，抽取出类型 + 地址 + 转发服务器地址，用于日志可读 */
function describeCandidate(candidate: string): string {
  const typ = candidate.match(/typ\s+(\w+)/)?.[1] ?? '?'
  const parts = candidate.split(' ')
  // 标准格式：candidate:foundation component transport priority address port typ type ...
  const address = parts[5] ?? ''
  const port = parts[6] ?? ''
  const raddr = candidate.match(/raddr\s+([\w.:-]+)/)?.[1] ?? ''
  const rport = candidate.match(/rport\s+(\d+)/)?.[1] ?? ''
  if (typ === 'relay' && raddr) return `relay ${address}:${port} (中转服务器 ${raddr}:${rport})`
  return `${typ} ${address}:${port}`
}

/**
 * 视频 Sender 参数：带宽不足时优先保分辨率（降帧率而不是降清晰度）。
 * 与参考实现一致——失败只记日志，绝不影响建连。
 */
async function configureVideoSender(sender: RTCRtpSender): Promise<void> {
  const params = sender.getParameters()
  // encodings 是数组，通常 simulcast 未开启时只有一个元素
  if (!params.encodings) params.encodings = [{}]
  // 'maintain-resolution': 优先保分辨率。带宽不足时降低帧率（变卡），但保持清晰度（不糊）。
  params.degradationPreference = 'maintain-resolution'
  try {
    await sender.setParameters(params)
    console.log('[RtcEngine] 视频参数已锁定：清晰')
  } catch (e) {
    console.error('[RtcEngine] 设置参数失败:', e)
  }
}

class RtcEngine {
  private roomId: string
  private myUserId: number
  private iceServers: RTCIceServer[]
  private localStream: MediaStream
  private onSignal: (signal: RtcSignalPayload) => void
  private onRemoteStream: (userId: number, stream: MediaStream) => void
  private onPeerDisconnected: (userId: number) => void
  private onPeerConnected?: (userId: number) => void

  /** peer key = userId */
  private peers = new Map<number, RTCPeerConnection>()
  /** 本端主动关闭的 peer：close() 也会触发 connectionState=closed，不能当成对端掉线 */
  private closing = new Set<number>()
  /** 'disconnected' 的宽限计时器：短暂抖动 WebRTC 常能自愈，别立刻重连 */
  private disconnectGrace = new Map<number, ReturnType<typeof setTimeout>>()

  constructor(opts: RtcEngineOptions) {
    this.roomId = opts.roomId
    this.myUserId = opts.myUserId ?? 0
    this.iceServers = toIceServers(opts.iceServers)
    this.localStream = opts.localStream
    this.onSignal = opts.onSignal
    this.onRemoteStream = opts.onRemoteStream
    this.onPeerDisconnected = opts.onPeerDisconnected
    this.onPeerConnected = opts.onPeerConnected
    console.log(
      '[RtcEngine] 初始化',
      'room=' + this.roomId,
      'iceServers=' +
        (this.iceServers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) + (s.username && s.credential ? '(@auth)' : '')).join(' | ') || '(none)')
    )
  }

  // ─── 建立连接 ──────────────────────────────────────────

  /**
   * 为新 peer 建立连接。
   *
   * 【谁发 offer】按 userId 大小定死：本端 userId 小于对端 → 本端是这一对的发起方。
   *   服务端 rtc:signal 是「房间广播、无 target」，两端对「谁发起」必须有完全一致的判断。
   *   若按「谁先进房间」定，重连时两端会同时发 offer（glare），互相拆 PC → 掉线 → 再拆，
   *   形成永不停歇的乒乓（实测 4 人就会 3~4 次断开）。
   *
   * @param opts.sendOffer 显式指定角色；不传则由 userId 自动判定（推荐）。
   */
  addPeer(userId: number, opts: { sendOffer?: boolean } = {}): void {
    const sendOffer = opts.sendOffer ?? this.myUserId < userId
    // 新建 = 这是一次主动发起（含重连），清掉上次的「主动关闭」标记
    this.closing.delete(userId)
    this.clearGrace(userId)
    const existing = this.peers.get(userId)
    if (existing) {
      // have-local-offer = 本端发过 offer 还没收到 answer（对端也发了 offer 才会这样）。
      // 这是唯一真正「状态不对」的情况，删掉重建。
      if (existing.signalingState === 'have-local-offer') {
        console.log('[RtcEngine] [addPeer] user=' + userId + ' 撞车(have-local-offer) → 删掉重建')
        existing.close()
        this.peers.delete(userId)
      } else {
        // stable：已经建好了；have-remote-offer：正在应答中。
        // 两种都绝不能重建 —— 重建会关掉 DTLS，对端立刻看到掉线、画面黑掉，
        // 而对端也会重建并发来新 offer，两边互相拆，就是循环掉线。
        console.log('[RtcEngine] [addPeer] user=' + userId + ' 已有 PC(sig=' + existing.signalingState + ') → 复用，不重建')
        return
      }
    }

    this._createPeerConnection(userId, sendOffer)
  }

  /**
   * 本端是不是「与 userId 这一对」的发起方？
   * 规则与 addPeer 完全一致：本端 userId 更小就是发起方。
   * 调用方（重连逻辑）靠它区分「本端该主动重发 offer」还是「本端只该等对方发起」，
   * 否则应答方会一直等一个自己永远不会发出的 offer，最后误判成失败把人踢出会议。
   */
  isOffererFor(userId: number): boolean {
    return this.myUserId < userId
  }

  /**
   * 建 PC + 加本地轨道 + 挂事件（对齐参考实现 CreatePeerConnection）。
   * @param sendOffer 是否立即发起 offer。
   *        主动发起（进房 / 新人进房 / 重连）传 true；
   *        收到对端 offer 而被动建 PC 时传 false（由 _handleOffer 应答）。
   */
  private _createPeerConnection(userId: number, sendOffer: boolean): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peers.set(userId, pc)
    console.log(
      '[RtcEngine] [createPc] user=' + userId,
      sendOffer ? '主动发起' : '被动应答',
      'ice=' +
        (this.iceServers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) + (s.username && s.credential ? '(@auth)' : '')).join(' | ') || '(none)'),
      'localTracks=' + this.localStream.getTracks().length,
      'sig=' + pc.signalingState
    )

    // 把本地流每条轨道加到 PC（对齐参考实现 AddTrack 前半段）
    this.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, this.localStream)
      // 只处理视频轨道：带宽不足时保分辨率（降帧率而不是降清晰度）
      if (track.kind === 'video') {
        void configureVideoSender(sender)
      }
    })

    this._bindPeerEvents(pc, userId)

    // 发起 offer（对齐参考实现 AddTrack 里那句 createOffer → emit offer）
    if (sendOffer) void this._createOffer(userId, pc)

    return pc
  }



  


  // ─── 处理对端信令 ─────────────────────────────────────

  /**
   * 收到信令（对齐参考实现 handleSignal）。
   * 对端发来 offer 但本地还没有 PC（说明对端先发起）→ 先创建一个再应答。
   *
   * 【为什么所有处理都要进串行队列】
   * 服务端 rtc:signal 是房间内广播，且客户端会重连重发，同一对端的信令可能
   * 密集到达（实测 10 人压测里出现「发 22 条 offer 收到 258 条 answer」）。
   * offer/answer 的处理都是 async（含多次 await setRemoteDescription），
   * 并发进入会让两次调用同时通过 signalingState 检查、又同时去 set，
   * 后一个必然抛 "Failed to set ... Called in wrong state: stable"。
   * 按 userId 串行化后，每个对端的信令严格按到达顺序一条条处理，根除该竞态。
   */
  handleSignal(fromUserId: number, signal: RtcSignalPayload): void {
    // ── 收件人过滤 ──
    // 服务端 rtc:signal 是「房间广播、无 target」：user1 发给 user2 的 offer，
    // user3、user4 也会收到。若不筛掉，user3 会把这封「写给 user2 的信」套到
    // 自己与 user1 的那条 PC 上，协商随即错位、DTLS 建不起来 —— 表现就是
    // 「人进了房间，但一个画面都没有」。信令里带 to 即可精确投递（服务端原样透传）。
    // to 缺省时按广播处理，兼容不发 to 的老客户端。
    if (signal.to !== undefined && signal.to !== null && signal.to !== this.myUserId) {
      console.log('[RtcEngine] [signal] from=' + fromUserId, 'type=' + signal.type,
        'to=' + signal.to, '不是发给本端(' + this.myUserId + ') → 忽略')
      return
    }
    const prev = this._signalQueue.get(fromUserId) ?? Promise.resolve()
    const next = prev
      .then(() => this._handleSignalNow(fromUserId, signal))
      .catch((err) => {
        console.error('[RtcEngine] [signal] user=' + fromUserId + ' 处理异常:', err)
      })
    this._signalQueue.set(fromUserId, next)
    // 队列排空后清理，避免 Map 无限增长
    void next.then(() => {
      if (this._signalQueue.get(fromUserId) === next) this._signalQueue.delete(fromUserId)
    })
  }

  /** 每个 userId 一条串行队列：同一对端的信令绝不并发处理 */
  private _signalQueue = new Map<number, Promise<void>>()

  private async _handleSignalNow(fromUserId: number, signal: RtcSignalPayload): Promise<void> {
    console.log('[RtcEngine] [signal] from=' + fromUserId, 'type=' + signal.type, 'hasPc=' + this.peers.has(fromUserId))
    let pc = this.peers.get(fromUserId)

    // 对端发来 offer 但本地还没有 PC（说明对端先发起），先创建一个
    if (!pc && signal.type === 'offer') {
      pc = this._createPeerConnection(fromUserId, false)
    }
    if (!pc) return

    switch (signal.type) {
      case 'offer':
        await this._handleOffer(pc, fromUserId, signal.sdp)
        break
      case 'answer':
        await this._handleAnswer(pc, fromUserId, signal.sdp)
        break
      case 'ice':
        await this._handleIce(pc, fromUserId, signal)
        break
    }
  }

  // ─── 关闭 ─────────────────────────────────────────────

  closePeer(userId: number, reason = '主动关闭'): void {
    const pc = this.peers.get(userId)
    this.clearGrace(userId)
    if (pc) {
      console.log('[RtcEngine] [closePeer] user=' + userId + ' ' + reason)
      this.closing.add(userId)
      this.connectedOnce.delete(userId) // 允许重连后再次通知「连接成功」
      pc.close()
      this.peers.delete(userId)
    }
  }

  closeAll(): void {
    this.peers.forEach((pc, userId) => {
      this.clearGrace(userId)
      this.closing.add(userId)
      pc.close()
    })
    this.peers.clear()
    this.connectedOnce.clear()
  }

  // ─── 轨道替换 ─────────────────────────────────────────

  /**
   * 遍历所有 PC 的 senders 替换指定 kind 的轨道。
   * track 传 null 表示关闭该轨道。
   * 替换后对每个 PC 重新协商（createOffer → setLocalDescription → onSignal）。
   */
  replaceTrack(track: MediaStreamTrack | null, kind: 'audio' | 'video'): void {
    this.peers.forEach((pc, userId) => {
      console.log('[RtcEngine] [replaceTrack] user=' + userId, 'kind=' + kind, 'track=' + (track ? track.id : 'null'), 'senders=' + pc.getSenders().length, 'sig=' + pc.signalingState)
      const senders = pc.getSenders()
      let replaced = 0
      for (const sender of senders) {
        if (sender.track?.kind === kind) {
          void sender.replaceTrack(track)
          replaced++
        }
      }
      console.log('[RtcEngine] [replaceTrack] user=' + userId, 'replaced=' + replaced)
      // 重新协商（发 offer）
      void this._renegotiate(pc, userId)
    })
  }

  // ─── 内部：绑定 peer 事件 ──────────────────────────────

  private _bindPeerEvents(pc: RTCPeerConnection, userId: number): void {
    pc.ontrack = (event) => {
      // event.streams[0] 绑定远程流；无 streams 时忽略
      if (event.streams.length === 0) return
      // 已被替换的旧 PC 的轨道不要再往 UI 塞，否则画面会在新旧流之间跳
      if (this.peers.get(userId) !== pc) return
      console.log(`[RtcEngine] [ontrack] user=${userId} kind=${event.track.kind} stream=${event.streams[0].id} ${event.track.readyState}`)
      this.onRemoteStream(userId, event.streams[0])
    }

    pc.onicecandidate = (event) => {
      const c = event.candidate
      if (c) {
        // 本端收集到候选：host/srflx/relay 类型、协议、传输地址（内网排查用）
        console.log(`[RtcEngine] [ice:local] user=${userId} ${describeCandidate(c.candidate)} (gather=${pc.iceGatheringState})`)
        // 【身份校验】旧 PC 的候选不能发给对端 —— 对方的 ufrag 已经换了，
        // 收到只会 addIceCandidate 失败并刷错，还可能干扰新连接。
        if (this.peers.get(userId) !== pc) {
          console.log(`[RtcEngine] [ice:local] user=${userId} 丢弃：该候选属于已被替换的旧连接`)
          return
        }
        this.onSignal({
          type: 'ice',
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex,
          to: userId
        })
      } else {
        console.log(`[RtcEngine] [ice:local] user=${userId} end-of-candidates`)
      }
    }

    pc.oniceconnectionstatechange = () => {
      const ice = pc.iceConnectionState
      console.log(`[RtcEngine] [ice-state] user=${userId} ${ice}`)

      // 【为什么成功判定不能只看 connectionState】
      // 实测（10 人压测）：connectionState 会卡在 connecting 不再推进，
      // 而 iceConnectionState 已经是 connected、ontrack 也已正常触发。
      // 只认 connectionState 的话，onPeerConnected 永远不触发，
      // 上层的等待就永远等不到 → 12 秒判超时 → 重连 → 循环掉线。
      // 所以 ICE 一旦 connected/completed，就认定这条连接是通的。
      const isCurrent = this.peers.get(userId) === pc
      if (!isCurrent) return

      if (ice === 'connected' || ice === 'completed') {
        this.markConnected(userId, pc, 'ice=' + ice)
        return
      }
      if (ice === 'failed') {
        console.log(`[RtcEngine] [ice-state] user=${userId} ICE 失败 → 按掉线处理`)
        this.handleDrop(userId)
      }
    }

    pc.onicegatheringstatechange = () => {
      console.log(`[RtcEngine] [ice-gather] user=${userId} ${pc.iceGatheringState}`)
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log(`[RtcEngine] [conn-state] user=${userId} ${state} ice=${pc.iceConnectionState} sig=${pc.signalingState}`)

      // 【身份校验】这个 PC 已经被替换/关闭了，它的状态事件不能影响当前连接。
      // 多人场景下本端会频繁重建 PC，旧 PC 的异步事件若不加校验，
      // 会把刚建好的新连接误判为掉线 → 触发重连 → 又产生新的事件，
      // 形成「A 断 B 断 C 断」的循环重连风暴。
      const isCurrent = this.peers.get(userId) === pc

      if (state === 'connected') {
        if (!isCurrent) return
        this.markConnected(userId, pc, 'conn=connected')
        return
      }
      if (state === 'disconnected') {
        if (!isCurrent) return
        // 丢包/切网常会自愈：给 3 秒宽限，恢复不了才按掉线处理（避免无谓重连）
        if (this.disconnectGrace.has(userId)) return
        this.disconnectGrace.set(
          userId,
          setTimeout(() => {
            this.disconnectGrace.delete(userId)
            // 定时器触发时再校验一次：这条 PC 还是当前的吗？
            // 期间可能已经重建成功，绝不能把新连接打掉。
            if (this.peers.get(userId) !== pc) {
              console.log(`[RtcEngine] [conn-state] user=${userId} 宽限到期，但该 PC 已被替换 → 忽略`)
              return
            }
            if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
              console.log(`[RtcEngine] [conn-state] user=${userId} disconnected 超时未恢复 → 按掉线处理`)
              this.handleDrop(userId)
            }
          }, DISCONNECT_GRACE_MS)
        )
        return
      }
      if (state === 'failed' || state === 'closed') {
        if (!isCurrent) return
        if (this.closing.has(userId)) {
          // 本端主动 closePeer/closeAll 触发的，不算对端掉线
          this.closing.delete(userId)
          return
        }
        this.handleDrop(userId)
      }
    }
  }

  /** 对端掉线：关掉旧 PC 并通知上层（上层据此自动重连） */
  private handleDrop(userId: number): void {
    this.clearGrace(userId)
    this.closePeer(userId)
    this.onPeerDisconnected(userId)
  }

  /**
   * 标记某对端已连通（幂等）。
   *
   * connectionState 和 iceConnectionState 谁先到都算成功，但只能通知上层一次，
   * 否则上层的「连续失败计数清零 / 等待 resolve」会被重复触发。
   * 已通知过的记在 connectedOnce 里；该 PC 被替换时清掉，允许新一轮再通知。
   */
  private markConnected(userId: number, pc: RTCPeerConnection, why: string): void {
    if (this.peers.get(userId) !== pc) return
    if (this.connectedOnce.get(userId) === pc) return
    this.connectedOnce.set(userId, pc)
    this.clearGrace(userId)
    console.log(`[RtcEngine] [connected] user=${userId} ✓（依据 ${why}）`)
    // 读取选中的候选对，报告直连 or 中转及各端地址
    void this._logPeerInfo(userId, pc)
    this.onPeerConnected?.(userId)
  }

  /** 已通知过「连接成功」的 peer（键为 userId，值为当时那条 PC） */
  private connectedOnce = new Map<number, RTCPeerConnection>()

  private clearGrace(userId: number): void {
    const t = this.disconnectGrace.get(userId)
    if (t) {
      clearTimeout(t)
      this.disconnectGrace.delete(userId)
    }
  }

  /** 连接建立后：用 getStats 找出成功候选对，判定直连/中转，并输出本地/远端候选与中心服务器(TURN)地址 */
  private async _logPeerInfo(userId: number, pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats()
      const cands = new Map<string, { candidateType?: string; address?: string; port?: number; relayProtocol?: string }>()
      let succeeded: { localCandidateId?: string; remoteCandidateId?: string } | null = null
      stats.forEach((s) => {
        const r = s as unknown as Record<string, unknown>
        if (r.type === 'candidate') {
          cands.set(s.id, {
            candidateType: String(r.candidateType ?? ''),
            address: String(r.address ?? ''),
            port: Number(r.port ?? 0),
            relayProtocol: r.relayProtocol ? String(r.relayProtocol) : undefined
          })
        } else if (r.type === 'candidate-pair' && r.state === 'succeeded' && !succeeded) {
          succeeded = { localCandidateId: String(r.localCandidateId ?? ''), remoteCandidateId: String(r.remoteCandidateId ?? '') }
        }
      })
      if (!succeeded) {
        console.log(`[RtcEngine] [peer-info] user=${userId} 尚未选出可用候选对（可能仍在中转协商中）`)
        return
      }
      const sp = succeeded as { localCandidateId?: string; remoteCandidateId?: string }
      const lc = cands.get(sp.localCandidateId ?? '')
      const rc = cands.get(sp.remoteCandidateId ?? '')
      const fmt = (c?: { candidateType?: string; address?: string; port?: number }): string =>
        c && c.address ? `${c.candidateType} ${c.address}:${c.port}` : '?'
      const viaRelay = (lc?.candidateType === 'relay' || rc?.candidateType === 'relay')
      console.log(`[RtcEngine] [peer-info] user=${userId} 连接方式=${viaRelay ? '中转(relay)' : '直连(P2P)'}`)
      console.log(`[RtcEngine] [peer-info] user=${userId} 本地候选=${fmt(lc)}`)
      console.log(`[RtcEngine] [peer-info] user=${userId} 远端成员候选=${fmt(rc)}`)
      if (lc?.candidateType === 'relay') {
        console.log(`[RtcEngine] [peer-info] user=${userId} 中心服务器(TURN)中转地址=${lc.address}:${lc.port}${lc.relayProtocol ? ` (${lc.relayProtocol})` : ''}`)
      }
    } catch (err) {
      console.log(`[RtcEngine] [peer-info] user=${userId} getStats失败 ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // ─── 内部：offer / answer / ice 流程 ──────────────────

  private async _createOffer(userId: number, pc: RTCPeerConnection): Promise<void> {
    try {
      const offer = await pc.createOffer()
      offer.sdp = EnforceStereo(offer.sdp ?? '')
      await pc.setLocalDescription(offer)
      console.log('[RtcEngine] [发送offer] user=' + userId, 'sdpLen=' + (offer.sdp?.length ?? 0), 'sig=' + pc.signalingState)
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '', to: userId })
    } catch (err) {
      console.error('[RtcEngine] createOffer failed:', err)
    }
  }

  // 远端 SDP（offer/answer）未 set 时先到/后到的 ICE candidate 会因 remoteDescription=null 被 addIceCandidate 拒绝；
  // 这里按 userId 缓存，待远端描述 set 完成后统一补加。
  //
  // 【必须绑定 PC 实例】只按 userId 存会出事：本引擎「状态不对就删掉重建」，
  // 旧 PC 的候选如果被新 PC 拿去 addIceCandidate，ufrag 对不上会全部失败，
  // ICE 永远打不通（表现就是连接一直不 connected → 上层 12 秒判超时）。
  private _pendingIce = new Map<number, { pc: RTCPeerConnection; cands: RTCIceCandidateInit[] }>()

  private _pendingIceArr(userId: number, pc: RTCPeerConnection): RTCIceCandidateInit[] {
    let e = this._pendingIce.get(userId)
    // 换过 PC（重建）→ 丢弃属于旧 PC 的候选，从空的开始
    if (!e || e.pc !== pc) {
      e = { pc, cands: [] }
      this._pendingIce.set(userId, e)
    }
    return e.cands
  }

  private async _flushPendingIce(userId: number, pc: RTCPeerConnection): Promise<void> {
    const e = this._pendingIce.get(userId)
    if (!e || e.cands.length === 0) return
    // 缓存必须属于当前这条 PC，否则整批丢弃（旧 PC 的候选对新 PC 有害无益）
    if (e.pc !== pc) {
      console.log('[RtcEngine] [flushIce] user=' + userId, '缓存候选属于旧 PC → 丢弃', e.cands.length, '条')
      this._pendingIce.delete(userId)
      return
    }
    const arr = e.cands
    this._pendingIce.delete(userId)
    console.log('[RtcEngine] [flushIce] user=' + userId, '补加缓存候选', arr.length, '条')
    for (const c of arr) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (err) {
        console.error('[RtcEngine] flushPendingIce failed:', err)
      }
    }
  }

  /**
   * 收到 offer → 应答（严格对齐参考实现 HandleOffer）。
   *
   * 参考实现原话：
   *   let pc = peerConnections[from]
   *   if (pc && pc.signalingState !== 'stable') { pc.close(); delete; pc = null }
   *   if (!pc) { pc = await CreatePeerConnection(from) }
   *   if (pc.signalingState === 'have-remote-offer') { await rollback }
   *   await pc.setRemoteDescription(offer) → createAnswer → setLocalDescription → 发送 answer
   *
   * 关键：**状态不是 stable 就整条 PC 删掉重建，绝不硬 set**。
   * 这样新建出来的 PC 必然是 stable，setRemoteDescription(offer) 一定成功，
   * 不会出现「无法设置」。
   */
  private async _handleOffer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    console.log('[RtcEngine] [收到offer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + pc.signalingState)

    // ⓪ 去重：服务端 rtc:signal 是【房间广播、无 target】，任何人的 offer 全房间都会收到。
    //    对于已经用同一份 SDP 谈好的对端，重复 offer 没有任何新信息，
    //    若照常处理就会把健康的 PC 拆掉重建 —— 重建期间远端流中断，画面随之为黑。
    //    （实测压测中单个用户会重复处理 40~59 次 offer，正是「画面出来又黑掉」的根因。）
    //    只有 SDP 与当前 remoteDescription 完全一致时才判定为重复；对端真的重建 PC
    //    会生成新 SDP，那种情况必须继续往下走，否则无法恢复。
    if (pc.remoteDescription !== null && pc.remoteDescription.type === 'offer'
      && pc.remoteDescription.sdp === sdp) {
      console.log('[RtcEngine] [收到offer] user=' + userId, '与当前 remoteDescription 相同 → 忽略重复 offer（不重建）')
      return
    }

    // ① 状态不是 stable（接不了这个 offer）
    if (pc.signalingState !== 'stable') {
      if (pc.signalingState === 'have-local-offer') {
        // ── 撞车(glare)：本端也发过 offer 还没收到 answer，对端此刻也发来 offer。
        // 处理必须严格按 userId 规则（本端 userId 更小 = 发起方），否则双方会同时都
        // 「回滚后应答」→ 出现两个 answer、没有发起方，协商不完整。
        const iAmOfferer = this.myUserId < userId
        if (iAmOfferer) {
          // 本端是发起方，对端（应答方）不该主动发 offer。保持本端已发出的 offer，
          // 忽略对端这份 offer，继续等对端的 answer —— 若回滚/重建会打断本端已发起的
          // 协商，导致双方互等（死锁），也可能关掉 DTLS 让对端看到掉线。
          console.log('[RtcEngine] [收到offer] user=' + userId, '撞车，本端是发起方 → 忽略对端offer，等待其answer')
          return
        }
        // 本端是应答方，对端才是发起方：回滚本端误发的 offer 后应答对端 —— 【绝不删 PC】。
        // 删 PC 会关掉 DTLS，对端立即看到掉线(failed)、画面黑，且对端也重建，
        // 双方互相拆 → 循环掉线（实测 replaceTrack 触发 renegotiate 发 offer，
        // 对端恰好也发 offer 即撞车，旧代码直接删 PC，表现就是「画面出来又黑、
        // 一直红色断线重连」）。回滚后应答则 DTLS 不断、连接保持。
        console.log('[RtcEngine] [收到offer] user=' + userId, '撞车，本端是应答方 → 回滚本端offer后应答（不重建）')
        try {
          await pc.setLocalDescription({ type: 'rollback' })
        } catch (err) {
          // rollback 极罕见失败时才退化为删掉重建（保底）
          console.warn('[RtcEngine] [收到offer] user=' + userId, 'rollback失败，退化为删掉重建:', err instanceof Error ? err.message : String(err))
          if (this.peers.get(userId) === pc) this.peers.delete(userId)
          try { pc.close() } catch { /* 已关闭，忽略 */ }
          pc = this._createPeerConnection(userId, false)
        }
      } else {
        // 其他非 stable（have-remote-offer / closed）→ 删掉重建后再应答
        console.log('[RtcEngine] [收到offer] user=' + userId, '状态=' + pc.signalingState + ' → 删掉重建')
        if (this.peers.get(userId) === pc) this.peers.delete(userId)
        try { pc.close() } catch { /* 已关闭，忽略 */ }
        // 被动应答：重建时【不】主动发 offer，避免与对方撞车
        pc = this._createPeerConnection(userId, false)
      }
    }

    try {
      // ② 同一个 offer 重复投递时，上一个还挂在 have-remote-offer → 回滚后重答
      if (pc.signalingState === 'have-remote-offer') {
        console.log('[RtcEngine] [收到offer] user=' + userId, '回滚远程 offer')
        try {
          await pc.setRemoteDescription({ type: 'rollback' })
        } catch {
          /* ignore：状态已变，交由下方 setRemoteDescription 决定 */
        }
      }
      await pc.setRemoteDescription({ type: 'offer', sdp })
      await this._flushPendingIce(userId, pc)
      const answer = await pc.createAnswer()
      answer.sdp = EnforceStereo(answer.sdp ?? '')

      // ③ 关键：上面几个 await 期间，同一对端可能又来了新 offer，
      //    把状态从 have-remote-offer 推走（实测会抛
      //    "Failed to set local answer sdp: Called in wrong state: stable"）。
      //    signalingState 是实时 getter，setLocalDescription 之前必须重新读一次。
      if (pc.signalingState !== 'have-remote-offer') {
        console.log('[RtcEngine] [收到offer] user=' + userId,
          '准备发送 answer 时状态已变为 ' + pc.signalingState + '（收到更新的 offer）→ 丢弃本轮 answer')
        return
      }
      await pc.setLocalDescription(answer)
      console.log('[RtcEngine] [发送answer] user=' + userId, 'sig=' + pc.signalingState)
      this.onSignal({ type: 'answer', sdp: answer.sdp ?? '', to: userId })
    } catch (err) {
      console.error('[RtcEngine] handleOffer failed:', err)
    }
  }

  private async _handleAnswer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    console.log('[RtcEngine] [收到answer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + pc.signalingState)
    try {
      // 仅当本地有未解决的 offer 时才接受 answer。
      // 广播 + 重连重发会让同一个 answer 重复到达，第二次进来时本端已 stable，
      // 硬 set 就会抛 "Called in wrong state: stable" —— 直接忽略即可。
      if (pc.signalingState !== 'have-local-offer') {
        console.log('[RtcEngine] [收到answer] user=' + userId,
          '忽略：本端不处于 have-local-offer（当前 ' + pc.signalingState + '），该 answer 已作废')
        return
      }
      await pc.setRemoteDescription({ type: 'answer', sdp })
      await this._flushPendingIce(userId, pc)
    } catch (err) {
      console.error('[RtcEngine] handleAnswer failed:', err)
    }
  }

  private async _handleIce(pc: RTCPeerConnection, userId: number, signal: Extract<RtcSignalPayload, { type: 'ice' }>): Promise<void> {
    // 这个 candidate 属于被换掉的旧 PC（对端已重建）→ 直接丢，不要塞进新 PC。
    // 老 candidate 配新 ufrag 一定会被 addIceCandidate 拒绝，还会刷一堆报错。
    if (this.peers.get(userId) !== pc) {
      console.log('[RtcEngine] [收到ICE] user=' + userId, '丢弃：该候选属于已被替换的旧连接')
      return
    }
    // 远端描述尚未 set：先缓存，待 offer/answer 处理完成后统一补加，避免 addIceCandidate 报 remote description was null
    console.log(`[RtcEngine] [收到ICE] user=${userId} ${describeCandidate(signal.candidate)} cached=${pc.remoteDescription === null} sig=${pc.signalingState}`)
    if (!pc.remoteDescription) {
      this._pendingIceArr(userId, pc).push({
        candidate: signal.candidate,
        sdpMid: signal.sdpMid ?? undefined,
        sdpMLineIndex: signal.sdpMLineIndex ?? undefined
      })
      return
    }
    try {
      await pc.addIceCandidate(
        new RTCIceCandidate({
          candidate: signal.candidate,
          sdpMid: signal.sdpMid ?? undefined,
          sdpMLineIndex: signal.sdpMLineIndex ?? undefined
        })
      )
    } catch (err) {
      console.error('[RtcEngine] handleIce failed:', err)
    }
  }

  private async _renegotiate(pc: RTCPeerConnection, userId: number): Promise<void> {
    console.log('[RtcEngine] [renegotiate] user=' + userId, 'sig=' + pc.signalingState, 'ice=' + pc.iceConnectionState)
    try {
      // 仅在 stable 状态下发起新 offer
      if (pc.signalingState !== 'stable') {
        console.log('[RtcEngine] [renegotiate] user=' + userId, '跳过（非stable）sig=' + pc.signalingState)
        return
      }
      const offer = await pc.createOffer()
      offer.sdp = EnforceStereo(offer.sdp ?? '')
      await pc.setLocalDescription(offer)
      console.log('[RtcEngine] [发送offer(renegotiate)] user=' + userId, 'sdpLen=' + (offer.sdp?.length ?? 0), 'sig=' + pc.signalingState)
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '', to: userId })
    } catch (err) {
      console.error('[RtcEngine] renegotiate failed:', err)
    }
  }

  // ─── 通话录制（本地+远端合成，MediaRecorder → webm） ─────

  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recording = false

  /** 是否正在录制 */
  isRecording(): boolean {
    return this.recording
  }

  /** 开始录制：合成本地音视频 + 所有对端接收音视频 */
  startRecording(): void {
    if (this.recording) return
    this.recordChunks = []

    const tracks: MediaStreamTrack[] = []
    // 本地
    this.localStream.getTracks().forEach((t) => tracks.push(t))
    // 远端接收（RTCRtpReceiver）
    this.peers.forEach((pc) => {
      pc.getReceivers().forEach((r) => {
        if (r.track && r.track.readyState === 'live') tracks.push(r.track)
      })
    })
    if (tracks.length === 0) return

    const hasVideo = tracks.some((t) => t.kind === 'video')
    const mixed = new MediaStream(tracks)

    let mime = ''
    if (hasVideo) {
      const candidates = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
      mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
    } else {
      const candidates = ['audio/webm;codecs=opus', 'audio/webm']
      mime = candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
    }

    try {
      this.recorder = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed)
    } catch {
      try {
        this.recorder = new MediaRecorder(mixed)
      } catch {
        this.recorder = null
        return
      }
    }

    this.recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordChunks.push(e.data)
    }
    this.recorder.onerror = () => {
      this.recording = false
      this.recorder = null
    }
    this.recorder.start(1000) // 每秒一个 chunk，降低内存峰值
    this.recording = true
  }

  /** 停止录制，返回 {blob, kind}；未在录制返回 null */
  stopRecording(): Promise<{ blob: Blob; kind: 'video' | 'audio' } | null> {
    return new Promise((resolve) => {
      if (!this.recorder || !this.recording) {
        resolve(null)
        return
      }
      const rec = this.recorder
      this.recording = false
      this.recorder = null
      const hasVideo = this.recordChunks.length > 0
      rec.onstop = () => {
        const blob = new Blob(this.recordChunks, {
          type: hasVideo ? 'video/webm' : 'audio/webm'
        })
        this.recordChunks = []
        resolve(blob.size > 0 ? { blob, kind: hasVideo ? 'video' : 'audio' } : null)
      }
      try {
        rec.stop()
      } catch {
        resolve(null)
      }
    })
  }
}

export default RtcEngine
