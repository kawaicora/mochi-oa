/**
 * RtcEngine — WebRTC peer connection 管理器。
 * 按对端 userId 维护 RTCPeerConnection，处理 offer/answer/ice 信令。
 * 注意：peer key 使用 userId（number），因为服务端 rtc:signal 事件的 from 只有 {userId, nick}。
 */

import type { RtcIceServer, RtcSignalPayload } from '@shared/server-types'

export interface RtcEngineOptions {
  roomId: string
  iceServers: RtcIceServer[]
  localStream: MediaStream
  onSignal: (signal: RtcSignalPayload) => void
  onRemoteStream: (userId: number, stream: MediaStream) => void
  onPeerDisconnected: (userId: number) => void
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

class RtcEngine {
  private roomId: string
  private iceServers: RTCIceServer[]
  private localStream: MediaStream
  private onSignal: (signal: RtcSignalPayload) => void
  private onRemoteStream: (userId: number, stream: MediaStream) => void
  private onPeerDisconnected: (userId: number) => void

  /** peer key = userId */
  private peers = new Map<number, RTCPeerConnection>()

  constructor(opts: RtcEngineOptions) {
    this.roomId = opts.roomId
    this.iceServers = toIceServers(opts.iceServers)
    this.localStream = opts.localStream
    this.onSignal = opts.onSignal
    this.onRemoteStream = opts.onRemoteStream
    this.onPeerDisconnected = opts.onPeerDisconnected
    console.log(
      '[RtcEngine] 初始化',
      'room=' + this.roomId,
      'iceServers=' +
        (this.iceServers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) + (s.username && s.credential ? '(@auth)' : '')).join(' | ') || '(none)')
    )
  }

  // ─── 建立连接 ──────────────────────────────────────────

  /** 为新 peer 创建 PC 并发起 offer */
  addPeer(userId: number): void {
    // 已存在连接：若 signalingState 不稳定则 close 重建
    const existing = this.peers.get(userId)
    if (existing) {
      if (existing.signalingState !== 'stable') {
        existing.close()
        this.peers.delete(userId)
      } else {
        return // 已存在且稳定，不重复创建
      }
    }

    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peers.set(userId, pc)
    console.log(
      '[RtcEngine] [addPeer] user=' + userId,
      '创建PC',
      'ice=' +
        (this.iceServers.map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)) + (s.username && s.credential ? '(@auth)' : '')).join(' | ') || '(none)'),
      'localTracks=' + this.localStream.getTracks().length,
      'sig=' + pc.signalingState
    )

    // 把本地流每条轨道加到 PC
    const senders = [];
    this.localStream.getTracks().forEach((track) => {
      const sender = pc.addTrack(track, this.localStream)
      // 只处理视频轨道，音频不需要设置分辨率/比特率策略
      if (track.kind === 'video') {
        configureVideoSender(sender).catch((err) => {
          console.error('配置视频发送参数失败:', err)
        })
      }
    })
    
    // 2. 对每个视频 Sender 设置“禁止模糊”和“指定比特率”
    async function configureVideoSender(sender: RTCRtpSender) {
      const params = sender.getParameters();
      
      // 指定比特率 (Bitrate) ---
      // 注意：encodings 是一个数组，通常 simulcast 未开启时只有一个元素
      if (!params.encodings) params.encodings = [{}];
      
      // params.encodings[0].maxBitrate = 3_000_000; 
      // 禁止画面模糊 (Degradation Preference) ---
      // 'maintain-resolution': 优先保分辨率。带宽不足时，降低帧率（变卡），但保持清晰度（不糊）。
      // 'maintain-framerate': 优先保流畅。带宽不足时，降低分辨率（变糊），但保持帧率（不卡）。
      // 'balanced': 默认行为，两者权衡。
      params.degradationPreference = 'maintain-resolution';

      try {
        await sender.setParameters(params);
        console.log('视频参数已锁定：清晰');
      } catch (e) {
        console.error('设置参数失败:', e);
      }
    }
    this._bindPeerEvents(pc, userId)

    // 发起 offer
    void this._createOffer(userId, pc)
  }



  


  // ─── 处理对端信令 ─────────────────────────────────────

  handleSignal(fromUserId: number, signal: RtcSignalPayload): void {
    console.log('[RtcEngine] [signal] from=' + fromUserId, 'type=' + signal.type, 'hasPc=' + this.peers.has(fromUserId))
    let pc = this.peers.get(fromUserId)

    // 对端发来 offer 但本地还没有 PC（说明对端先发起），先创建一个
    if (!pc && signal.type === 'offer') {
      pc = new RTCPeerConnection({ iceServers: this.iceServers })
      this.peers.set(fromUserId, pc)
      this.localStream.getTracks().forEach((track) => {
        pc!.addTrack(track, this.localStream)
      })
      this._bindPeerEvents(pc, fromUserId)
    }
    if (!pc) return

    switch (signal.type) {
      case 'offer':
        void this._handleOffer(pc, fromUserId, signal.sdp)
        break
      case 'answer':
        void this._handleAnswer(pc, fromUserId, signal.sdp)
        break
      case 'ice':
        void this._handleIce(pc, fromUserId, signal)
        break
    }
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
      console.log(`[RtcEngine] [ontrack] user=${userId} kind=${event.track.kind} stream=${event.streams[0].id} ${event.track.readyState}`)
      this.onRemoteStream(userId, event.streams[0])
    }

    pc.onicecandidate = (event) => {
      const c = event.candidate
      if (c) {
        // 本端收集到候选：host/srflx/relay 类型、协议、传输地址（内网排查用）
        console.log(`[RtcEngine] [ice:local] user=${userId} ${describeCandidate(c.candidate)} (gather=${pc.iceGatheringState})`)
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

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      console.log(`[RtcEngine] [conn-state] user=${userId} ${state} ice=${pc.iceConnectionState} sig=${pc.signalingState}`)
      if (state === 'connected') {
        // 连接建立 → 读取选中的候选对，报告直连 or 中转及各端地址
        void this._logPeerInfo(userId, pc)
      }
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        console.log(`[RtcEngine] [conn-state] user=${userId} ${state} → 关闭对端连接`)
        this.closePeer(userId)
        this.onPeerDisconnected(userId)
      }
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
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '' })
    } catch (err) {
      console.error('[RtcEngine] createOffer failed:', err)
    }
  }

  // 远端 SDP（offer/answer）未 set 时先到/后到的 ICE candidate 会因 remoteDescription=null 被 addIceCandidate 拒绝；
  // 这里按 userId 缓存，待远端描述 set 完成后统一补加。
  private _pendingIce = new Map<number, RTCIceCandidateInit[]>()

  private _pendingIceArr(userId: number): RTCIceCandidateInit[] {
    let arr = this._pendingIce.get(userId)
    if (!arr) {
      arr = []
      this._pendingIce.set(userId, arr)
    }
    return arr
  }

  private async _flushPendingIce(userId: number, pc: RTCPeerConnection): Promise<void> {
    const arr = this._pendingIce.get(userId)
    if (!arr || arr.length === 0) return
    this._pendingIce.delete(userId)
    for (const c of arr) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (err) {
        console.error('[RtcEngine] flushPendingIce failed:', err)
      }
    }
  }

  private async _handleOffer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    console.log('[RtcEngine] [收到offer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + pc.signalingState)
    try {
      // 若已有未完成的 remote offer，先回滚
      if (pc.signalingState === 'have-remote-offer') {
        // 检查后状态可能已被并发 offer 变更（如已是 stable）→ rollback 失败时忽略，继续尝试 set 新 offer
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
      await pc.setLocalDescription(answer)
      this.onSignal({ type: 'answer', sdp: answer.sdp ?? '' })
    } catch (err) {
      console.error('[RtcEngine] handleOffer failed:', err)
    }
  }

  private async _handleAnswer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    console.log('[RtcEngine] [收到answer] user=' + userId, 'sdpLen=' + sdp.length, 'sig=' + pc.signalingState)
    try {
      // 仅当本地有未解决的 offer 时才接受 answer
      if (pc.signalingState === 'have-local-offer') {
        await pc.setRemoteDescription({ type: 'answer', sdp })
        await this._flushPendingIce(userId, pc)
      }
    } catch (err) {
      console.error('[RtcEngine] handleAnswer failed:', err)
    }
  }

  private async _handleIce(pc: RTCPeerConnection, userId: number, signal: Extract<RtcSignalPayload, { type: 'ice' }>): Promise<void> {
    // 远端描述尚未 set：先缓存，待 offer/answer 处理完成后统一补加，避免 addIceCandidate 报 remote description was null
    console.log(`[RtcEngine] [收到ICE] user=${userId} ${describeCandidate(signal.candidate)} cached=${pc.remoteDescription === null} sig=${pc.signalingState}`)
    if (!pc.remoteDescription) {
      this._pendingIceArr(userId).push({
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
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '' })
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
