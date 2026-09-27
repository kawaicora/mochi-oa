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

    // 把本地流每条轨道加到 PC
    this.localStream.getTracks().forEach((track) => {
      pc.addTrack(track, this.localStream)
    })

    this._bindPeerEvents(pc, userId)

    // 发起 offer
    void this._createOffer(userId, pc)
  }

  // ─── 处理对端信令 ─────────────────────────────────────

  handleSignal(fromUserId: number, signal: RtcSignalPayload): void {
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
    this.peers.forEach((pc) => {
      const senders = pc.getSenders()
      for (const sender of senders) {
        if (sender.track?.kind === kind) {
          void sender.replaceTrack(track)
        }
      }
      // 重新协商
      void this._renegotiate(pc)
    })
  }

  // ─── 内部：绑定 peer 事件 ──────────────────────────────

  private _bindPeerEvents(pc: RTCPeerConnection, userId: number): void {
    pc.ontrack = (event) => {
      // event.streams[0] 绑定远程流；无 streams 时忽略
      if (event.streams.length === 0) return
      this.onRemoteStream(userId, event.streams[0])
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.onSignal({
          type: 'ice',
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex
        })
      }
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.closePeer(userId)
        this.onPeerDisconnected(userId)
      }
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
        await pc.setRemoteDescription({ type: 'rollback' })
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
    console.log('[RtcEngine] [收到ICE] user=' + userId, signal.candidate, 'cached=' + (pc.remoteDescription === null), 'sig=' + pc.signalingState)
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

  private async _renegotiate(pc: RTCPeerConnection): Promise<void> {
    try {
      // 仅在 stable 状态下发起新 offer
      if (pc.signalingState !== 'stable') return
      const offer = await pc.createOffer()
      offer.sdp = EnforceStereo(offer.sdp ?? '')
      await pc.setLocalDescription(offer)
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
