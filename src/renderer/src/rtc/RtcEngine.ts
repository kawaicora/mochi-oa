/**
 * RtcEngine — WebRTC peer connection 管理器。
 *
 * 本文件逐条对齐【服务端网页版 static/js/rtc.js】（那份是稳定的参考实现）：
 *
 *   addPeer(userId)                  先到的人：为每个新来的人新建 PC + 发 offer
 *   handleSignal(from, sig)          收到 offer（没有 PC 就新建）/ answer / ice
 *   replaceTrack(track, kind)        所有 PC 一起换轨道
 *   closePeer / closeAll             关闭
 *
 * 为什么必须「1 userId ↔ 1 PC，绝不复用」：
 *   服务端 rtc:signal 是【房间内广播】，且 signal 里【不带发送者身份】，
 *   from 只有 {userId, nick}。所以一个 PC 无法承载多路信令，
 *   一个 PC 也接不了第二个 offer（收了一个立刻进 stable）。
 *   唯一正确的模型就是：每个远端 userId 一个独立 PC。
 *
 * 与网页版的唯一区别（故意保留）：视频 sender 锁 maintain-resolution 与下行日志，
 * 失败只记日志，绝不影响建连。
 */

import type { RtcIceServer, RtcSignalPayload } from '@shared/server-types'

export interface RtcEngineOptions {
  roomId: string
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
  return (ices || []).map((ice) => ({
    urls: ice.urls,
    username: ice.username,
    credential: ice.credential
  }))
}

/** 给 opus fmtp:111 行追加 stereo=1;sprop-stereo=1（对齐网页版 stereo()） */
function EnforceStereo(sdp: string): string {
  return (sdp || '').replace(/(a=fmtp:111 .*)/g, (line) =>
    /stereo=1/.test(line) ? line : line + ';stereo=1;sprop-stereo=1'
  )
}

/** 解析 ICE candidate 字符串，抽取出类型 + 地址 + 转发服务器地址，用于日志可读 */
function describeCandidate(candidate: string): string {
  const typ = candidate.match(/typ\s+(\w+)/)?.[1] ?? '?'
  const parts = candidate.split(' ')
  // 标准格式：candidate:foundation component transport priority address port typ type ...
  const address = parts[4] ?? ''
  const port = parts[5] ?? ''
  const raddr = candidate.match(/raddr\s+([\w.:-]+)/)?.[1] ?? ''
  const rport = candidate.match(/rport\s+(\d+)/)?.[1] ?? ''
  if (typ === 'relay' && raddr) return `relay ${address}:${port} (中转服务器 ${raddr}:${rport})`
  return `${typ} ${address}:${port}`
}

/**
 * 视频 Sender 参数：带宽不足时优先保分辨率（降帧率而不是降清晰度）。
 * 失败只记日志，绝不影响建连。
 */
async function configureVideoSender(sender: RTCRtpSender): Promise<void> {
  try {
    const params = sender.getParameters()
    if (!params.encodings) params.encodings = [{}]
    params.degradationPreference = 'maintain-resolution'
    await sender.setParameters(params)
    console.log('[RtcEngine] 视频参数已锁定：清晰（maintain-resolution）')
  } catch (e) {
    console.error('[RtcEngine] 设置视频参数失败:', e)
  }
}

class RtcEngine {
  private roomId: string
  private iceServers: RTCIceServer[]
  private localStream: MediaStream
  private onSignal: (signal: RtcSignalPayload) => void
  private onRemoteStream: (userId: number, stream: MediaStream) => void
  private onPeerDisconnected: (userId: number) => void
  private onPeerConnected?: (userId: number) => void

  /** peer key = userId（服务端 from 只有 userId，见文件头说明） */
  private peers = new Map<number, RTCPeerConnection>()

  constructor(opts: RtcEngineOptions) {
    this.roomId = opts.roomId
    this.iceServers = toIceServers(opts.iceServers)
    this.localStream = opts.localStream
    this.onSignal = opts.onSignal
    this.onRemoteStream = opts.onRemoteStream
    this.onPeerDisconnected = opts.onPeerDisconnected
    this.onPeerConnected = opts.onPeerConnected
    console.log(
      '[RtcEngine] 初始化',
      'room=' + this.roomId,
      'iceServers=' + this.describeIce(),
      'localTracks=' + this.localStream.getTracks().length
    )
  }

  private describeIce(): string {
    return (
      this.iceServers
        .map(
          (s) =>
            (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) +
            (s.username && s.credential ? '(@auth)' : '')
        )
        .join(' | ') || '(none)'
    )
  }

  // ─── 建立连接（对齐网页版 addPeer）─────────────────────

  /**
   * 为某对端建 PC 并发起 offer。
   *   已有 stable 连接 → 直接返回（绝不发第二个 offer，那必然 wrong state）
   *   已有但非 stable → 丢掉重来
   *   没有           → 新建 + 塞本地轨道 + 挂事件 + createOffer → onSignal
   */
  addPeer(userId: number): void {
    const ex = this.peers.get(userId)
    if (ex) {
      if (ex.signalingState !== 'stable') {
        console.log(`[RtcEngine] [addPeer] user=${userId} 旧 PC 停在 ${ex.signalingState} → 丢掉重来`)
        ex.close()
        this.peers.delete(userId)
      } else {
        console.log(`[RtcEngine] [addPeer] user=${userId} 已有 stable 连接，跳过`)
        return
      }
    }
    const pc = this.createPc(userId, 'offer')
    void this.sendOffer(pc, userId)
  }

  /** 建 PC + 加本地轨道 + 挂事件（不负责协商方向） */
  private createPc(userId: number, tag: string): RTCPeerConnection {
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peers.set(userId, pc)
    console.log(
      `[RtcEngine] [${tag}] user=` + userId,
      'ice=' + this.describeIce(),
      'localTracks=' + this.localStream.getTracks().length
    )
    this.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, this.localStream)
      // 只处理视频轨道：带宽不足时降帧率、保清晰度
      if (track.kind === 'video') {
        configureVideoSender(sender).catch((err) => {
          console.error('配置视频发送参数失败:', err)
        })
      }
    })
    this.bindPeerEvents(pc, userId)
    return pc
  }

  // ─── 收到信令（对齐网页版 handleSignal）───────────────

  /**
   * offer  → 没有 PC 就新建（并塞本地轨道），然后应答
   * answer → 应用到自己那个 PC（仅 have-local-offer）
   * ice    → 加到该用户的 PC；PC 还没建就【先缓存】，等建好补加
   */
  handleSignal(fromUserId: number, signal: RtcSignalPayload): void {
    console.log(
      '[RtcEngine] [signal] from=' + fromUserId,
      'type=' + signal.type,
      'hasPc=' + this.peers.has(fromUserId)
    )

    let pc = this.peers.get(fromUserId)
    if (!pc && signal.type === 'offer') {
      // 后进房间的人走这条：来一个 offer 就为这个 userId 建一个独立 PC
      pc = this.createPc(fromUserId, 'answer')
    }
    if (!pc) {
      // answer / ice 比 offer 先到（后进房间的人偶发）→ 缓存 ICE，其余丢弃
      if (signal.type === 'ice') {
        this.pendingIce(fromUserId).push(this.toIceInit(signal))
        console.log(`[RtcEngine] [收到ICE] user=${fromUserId} 尚无 PC，先缓存`)
      }
      return
    }

    if (signal.type === 'offer') void this.applyOffer(pc, fromUserId, signal.sdp)
    else if (signal.type === 'answer') void this.applyAnswer(pc, fromUserId, signal.sdp)
    else if (signal.type === 'ice') void this.applyIce(pc, fromUserId, signal)
  }

  // ─── 关闭 ─────────────────────────────────────────────

  closePeer(userId: number): void {
    const pc = this.peers.get(userId)
    if (pc) {
      pc.close()
      this.peers.delete(userId)
    }
  }

  closeAll(): void {
    this.peers.forEach((pc) => pc.close())
    this.peers.clear()
  }

  /** 是否已有该对端的 PC（上层判断"要不要发起/重建"用） */
  hasPeer(userId: number): boolean {
    return this.peers.has(userId)
  }

  // ─── 轨道替换（对齐网页版 replaceTrack）───────────────

  /**
   * 遍历所有 PC 的 senders 替换指定 kind 的轨道；track 传 null 表示关闭该轨道。
   * kind 不变时 SDP 无需改动，因此【不重新协商】——
   * 否则双方一换设备就同时进 have-local-offer，这正是 glare 的来源。
   */
  replaceTrack(track: MediaStreamTrack | null, kind: 'audio' | 'video'): void {
    this.peers.forEach((pc, userId) => {
      console.log(
        '[RtcEngine] [replaceTrack] user=' + userId,
        'kind=' + kind,
        'track=' + (track ? track.id : 'null'),
        'senders=' + pc.getSenders().length,
        'sig=' + pc.signalingState
      )
      let replaced = 0
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === kind) {
          void sender.replaceTrack(track).catch((e) => {
            console.error(`[RtcEngine] [replaceTrack] user=${userId} kind=${kind} 失败:`, e)
          })
          replaced++
        }
      }
      console.log(`[RtcEngine] [replaceTrack] user=${userId} replaced=${replaced}（不重新协商）`)
    })
  }

  // ─── 内部：绑定 peer 事件（对齐网页版 _bind）───────────

  private bindPeerEvents(pc: RTCPeerConnection, userId: number): void {
    pc.ontrack = (event) => {
      // event.streams[0] 绑定远程流；无 streams 时忽略
      if (event.streams.length === 0) return
      console.log(
        `[RtcEngine] [ontrack] user=${userId} kind=${event.track.kind} stream=${event.streams[0].id} ${event.track.readyState}`
      )
      this.onRemoteStream(userId, event.streams[0])
    }

    pc.onicecandidate = (event) => {
      const c = event.candidate
      if (c) {
        // 本端收集到候选：host/srflx/relay 类型、协议、传输地址（内网排查用）
        console.log(
          `[RtcEngine] [ice:local] user=${userId} ${describeCandidate(c.candidate)} (gather=${pc.iceGatheringState})`
        )
        this.onSignal({
          type: 'ice',
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex
        })
      } else {
        console.log(`[RtcEngine] [ice:local] user=${userId} end-of-candidates`)
      }
    }

    pc.oniceconnectionstatechange = () => {
      console.log(`[RtcEngine] [ice-state] user=${userId} ${pc.iceConnectionState}`)
    }

    pc.onicegatheringstatechange = () => {
      console.log(`[RtcEngine] [ice-gather] user=${userId} ${pc.iceGatheringState}`)
    }

    pc.onsignalingstatechange = () => {
      console.log(`[RtcEngine] [sig-state] user=${userId} ${pc.signalingState}`)
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log(
        `[RtcEngine] [conn-state] user=${userId} ${state} ice=${pc.iceConnectionState} sig=${pc.signalingState}`
      )
      if (state === 'connected') {
        // 连接建立 → 读取选中的候选对，报告直连 or 中转；并通知上层「这次成功了」
        void this.logPeerInfo(userId, pc)
        this.onPeerConnected?.(userId)
        return
      }
      // 对齐网页版：disconnected / failed / closed 一律清理并通知上层，不自己造秒数、不自己重连。
      // 唯一的加固：只有「当前登记的还是这个 PC」才处理 ——
      // 老 PC 被主动关掉后它的异步事件不能误伤刚建好的新 PC。
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        if (this.peers.get(userId) !== pc) return
        this.closePeer(userId)
        this.onPeerDisconnected(userId)
      }
    }
  }

  /** 连接建立后：用 getStats 找出成功候选对，判定直连/中转，并输出候选与中心服务器(TURN)地址 */
  private async logPeerInfo(userId: number, pc: RTCPeerConnection): Promise<void> {
    try {
      const stats = await pc.getStats()
      const cands = new Map<
        string,
        { candidateType?: string; address?: string; port?: number; relayProtocol?: string }
      >()
      let succeeded: { localCandidateId: string; remoteCandidateId: string } | null = null
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
          succeeded = {
            localCandidateId: String(r.localCandidateId ?? ''),
            remoteCandidateId: String(r.remoteCandidateId ?? '')
          }
        }
      })
      if (!succeeded) {
        console.log(`[RtcEngine] [peer-info] user=${userId} 尚未选出可用候选对（可能仍在中转协商中）`)
        return
      }
      const sp: { localCandidateId: string; remoteCandidateId: string } = succeeded
      const lc = cands.get(sp.localCandidateId)
      const rc = cands.get(sp.remoteCandidateId)
      const fmt = (c?: { candidateType?: string; address?: string; port?: number }): string =>
        c && c.address ? `${c.candidateType} ${c.address}:${c.port}` : '?'
      const viaRelay = lc?.candidateType === 'relay' || rc?.candidateType === 'relay'
      console.log(`[RtcEngine] [peer-info] user=${userId} 连接方式=${viaRelay ? '中转(relay)' : '直连(P2P)'}`)
      console.log(`[RtcEngine] [peer-info] user=${userId} 本地候选=${fmt(lc)}`)
      console.log(`[RtcEngine] [peer-info] user=${userId} 远端候选=${fmt(rc)}`)
      if (lc?.candidateType === 'relay') {
        console.log(
          `[RtcEngine] [peer-info] user=${userId} 中心服务器(TURN)中转地址=${lc.address}:${lc.port}${lc.relayProtocol ? ` (${lc.relayProtocol})` : ''}`
        )
      }
    } catch (err) {
      console.log(
        `[RtcEngine] [peer-info] user=${userId} getStats失败 ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  // ─── 内部：offer / answer / ice 流程（对齐网页版）─────

  /** createOffer → setLocalDescription → onSignal（先到的人给新人发起） */
  private async sendOffer(pc: RTCPeerConnection, userId: number): Promise<void> {
    try {
      const offer = await pc.createOffer()
      offer.sdp = EnforceStereo(offer.sdp ?? '')
      await pc.setLocalDescription(offer)
      console.log(
        '[RtcEngine] [发送offer] user=' + userId,
        'sdpLen=' + (offer.sdp?.length ?? 0),
        'sig=' + pc.signalingState
      )
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '' })
    } catch (err) {
      console.error('[RtcEngine] createOffer failed:', err)
    }
  }

  // 远端 SDP（offer/answer）未 set 时先到的 ICE candidate 会因 remoteDescription=null
  // 被 addIceCandidate 拒绝；这里按 userId 缓存，待远端描述 set 完成后统一补加。
  private pendingIceMap = new Map<number, RTCIceCandidateInit[]>()

  private pendingIce(userId: number): RTCIceCandidateInit[] {
    let arr = this.pendingIceMap.get(userId)
    if (!arr) {
      arr = []
      this.pendingIceMap.set(userId, arr)
    }
    return arr
  }

  private toIceInit(signal: Extract<RtcSignalPayload, { type: 'ice' }>): RTCIceCandidateInit {
    return {
      candidate: signal.candidate,
      sdpMid: signal.sdpMid ?? undefined,
      sdpMLineIndex: signal.sdpMLineIndex ?? undefined
    }
  }

  private async flushIce(userId: number, pc: RTCPeerConnection): Promise<void> {
    const arr = this.pendingIceMap.get(userId)
    if (!arr || arr.length === 0) return
    this.pendingIceMap.delete(userId)
    for (const c of arr) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (err) {
        console.error('[RtcEngine] flushIce failed:', err)
      }
    }
  }

  /**
   * 收到 offer → 应答（对齐网页版 _handleOffer）。
   *
   * 关键规则：一个 PC 只能答一个 offer，答完就进 stable。
   *   - 本端还有没被应答的 offer（have-local-offer，双方同时发起）→ rollback 本端的，改应答对方；
   *   - 上一个远端 offer 还没答完（have-remote-offer）→ 先 rollback 掉；
   *   - stable → 本端协商已完成、手里的连接是好的：
   *     这个 offer 是重入房间时对方补发/迟到的，【跳过应答】。
   *     绝不能应答——那会动到已经 stable 的连接，就是
   *     "Failed to set local answer sdp: Called in wrong state: stable"。
   *   - closed 等 → 这个 PC 已废，直接忽略（等上层重建）。
   */
  private async applyOffer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    const sig = pc.signalingState
    console.log('[RtcEngine] [收到offer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + sig)

    // ① stable：本端协商已完成 → 这个 offer 多余，跳过（连接保持好的）
    if (sig === 'stable') {
      console.log(`[RtcEngine] [收到offer] user=${userId} 跳过：本端已 stable（应答反而会把它弄坏）`)
      return
    }
    // ② closed：PC 已关闭
    if (sig === 'closed') {
      console.log(`[RtcEngine] [收到offer] user=${userId} 跳过：PC 已关闭`)
      return
    }

    try {
      // ③ 双方同时发 offer：rollback 本端的 offer，改应答对方
      if (sig === 'have-local-offer') {
        console.warn(`[RtcEngine] [收到offer] user=${userId} 双方同时发起 → rollback 本端 offer，改为应答对方`)
        await pc.setRemoteDescription({ type: 'rollback' })
      }
      // ④ 上一个 remote offer 还没答完：先回滚
      if (pc.signalingState === 'have-remote-offer') {
        try {
          await pc.setRemoteDescription({ type: 'rollback' })
        } catch {
          /* 状态已变，交由下面 setRemoteDescription 决定 */
        }
      }
      // 走到这里 signalingState 必为 stable（上面已经把 have-local-offer 与
      // have-remote-offer 都 rollback 掉了），可以直接 setRemoteDescription(offer)。
      // 注意：signalingState 是实时 getter，await 之后不能靠此前的窄化判断，
      // 每次都要重新读，否则会把「已经变成 have-remote-offer」误判成 stable。
      await pc.setRemoteDescription({ type: 'offer', sdp })
      await this.flushIce(userId, pc)
      const answer = await pc.createAnswer()
      answer.sdp = EnforceStereo(answer.sdp ?? '')
      await pc.setLocalDescription(answer)
      console.log(
        '[RtcEngine] [发送answer] user=' + userId,
        'sdpLen=' + (answer.sdp?.length ?? 0),
        'sig=' + pc.signalingState
      )
      this.onSignal({ type: 'answer', sdp: answer.sdp ?? '' })
    } catch (err) {
      console.warn(
        `[RtcEngine] [收到offer] user=${userId} 处理失败（本轮不应答，连接状态未破坏）：`,
        err instanceof Error ? err.message : err
      )
    }
  }

  /** 收到 answer（对齐网页版 _handleAnswer）：只有本端等着对方回 answer 时才收 */
  private async applyAnswer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    const sig = pc.signalingState
    console.log('[RtcEngine] [收到answer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + sig)
    // 只有 have-local-offer 时才是「本端等着对方回 answer」：
    //  - stable → 这个 answer 对应的是本端已作废的 offer（双方同时发 offer 后本端那个被丢了/
    //    已被别的 answer 答完）。此时绝不能硬 set —— 会抛 wrong state: stable，
    //    更糟的是把当前正常的连接毁掉。答案很简单：忽略，本端手里的连接是好的。
    if (sig !== 'have-local-offer') {
      console.log(
        `[RtcEngine] [收到answer] user=${userId} 忽略：本端不处于 have-local-offer（${sig}），该 answer 对应的 offer 已作废`
      )
      return
    }
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp })
      await this.flushIce(userId, pc)
    } catch (err) {
      // 真的失败了（比如 SDP 角色冲突）→ 这个连接救不回来，丢掉它让上层重连，
      // 但只动这一个 peer，绝不波及其它人。
      console.error(`[RtcEngine] [收到answer] user=${userId} 应用失败，重建该连接：`, err)
      if (this.peers.get(userId) === pc) {
        this.closePeer(userId)
        this.onPeerDisconnected(userId)
      }
    }
  }

  /** 收到 ICE（对齐网页版 _handleIce）：远端描述未 set 就先缓存 */
  private async applyIce(
    pc: RTCPeerConnection,
    userId: number,
    signal: Extract<RtcSignalPayload, { type: 'ice' }>
  ): Promise<void> {
    // 这个 candidate 属于被换掉的旧连接（对端已重建）→ 直接丢，不要塞进新 PC。
    // 老 candidate 配新 ufrag 一定会被 addIceCandidate 拒绝，还会刷一堆报错。
    if (this.peers.get(userId) !== pc) {
      console.log(`[RtcEngine] [收到ICE] user=${userId} 丢弃：该候选属于已被替换的旧连接`)
      return
    }
    console.log(
      `[RtcEngine] [收到ICE] user=${userId} ${describeCandidate(signal.candidate)} remoteDesc=${pc.remoteDescription === null ? 'null' : 'set'} sig=${pc.signalingState}`
    )
    if (!pc.remoteDescription) {
      this.pendingIce(userId).push(this.toIceInit(signal))
      return
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(this.toIceInit(signal)))
    } catch (err) {
      console.warn(
        `[RtcEngine] [收到ICE] user=${userId} 添加失败（通常是旧连接的候选）：${err instanceof Error ? err.message : err}`
      )
    }
  }

  // ─── 通话录制（本地+远端合成，MediaRecorder → webm） ─────

  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recording = false
  /** 录制内容里是否含视频轨（决定导出 MIME 与后缀） */
  private recordHasVideo = false

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

    let rec: MediaRecorder | null = null
    try {
      rec = mime ? new MediaRecorder(mixed, { mimeType: mime }) : new MediaRecorder(mixed)
    } catch {
      try {
        rec = new MediaRecorder(mixed)
      } catch {
        rec = null
      }
    }
    if (!rec) return

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordChunks.push(e.data)
    }
    rec.onerror = () => {
      this.recording = false
      this.recorder = null
    }
    rec.start(1000) // 每秒一个 chunk，降低内存峰值
    this.recorder = rec
    // 记录本次录制的真实内容类型：stopRecording 时用它决定 MIME/后缀，
    // 不能靠 recordChunks 长度猜（那和有没有视频毫无关系）。
    this.recordHasVideo = hasVideo
    this.recording = true
  }

  /** 停止录制，返回 {blob, kind}；未在录制返回 null */
  stopRecording(): Promise<{ blob: Blob; kind: 'video' | 'audio' } | null> {
    return new Promise((resolve) => {
      const rec = this.recorder
      if (!rec || !this.recording) {
        resolve(null)
        return
      }
      const hasVideo = this.recordHasVideo
      const chunks = this.recordChunks
      this.recording = false
      this.recorder = null
      this.recordChunks = []

      const finish = (): void => {
        const blob = new Blob(chunks, { type: hasVideo ? 'video/webm' : 'audio/webm' })
        resolve(blob.size > 0 ? { blob, kind: hasVideo ? 'video' : 'audio' } : null)
      }
      rec.onstop = finish
      try {
        rec.stop()
      } catch {
        finish()
      }
    })
  }
}

export default RtcEngine
