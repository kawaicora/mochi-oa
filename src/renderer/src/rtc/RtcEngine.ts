/**
 * RtcEngine — 通话/会议媒体引擎（LiveKit SFU 版）。
 *
 * 背景迁移：原来按对端 userId 维护 RTCPeerConnection、走服务端 rtc:signal 转发
 * offer/answer/ice（P2P 网状）。现改为统一连接到自建 LiveKit SFU（live.kawaimoe.org），
 * 由 SFU 转发媒体：本端发布本地轨道，订阅其他参与者的轨道。
 *
 * 【公开 API 保持不变】——RtcCallRoom.vue / stores/rtc.ts 不需要任何改动：
 *   - 构造参数（roomId / myUserId / iceServers / localStream / 回调）不变
 *   - addPeer / isOffererFor / handleSignal / closePeer / closeAll / replaceTrack /
 *     startRecording / stopRecording / isRecording 全部保留
 *   - 回调语义不变：
 *       onRemoteStream(userId, stream)  — 收到某位参与者的媒体
 *       onPeerConnected(userId)         — 该参与者媒体已建立
 *       onPeerDisconnected(userId)      — 该参与者离开（LiveKit 内部自动重连，不会误报掉线）
 *   - handleSignal / addPeer 变为空操作（LiveKit 自动订阅，无需 P2P 信令）
 *
 * 配置来源：服务端统一签发下发 sfu{url,token,roomName}（.env 的 LIVEKIT_*），
 * 客户端不再持有 apiSecret、不再本地签发 token。
 */

import type { RtcIceServer, RtcSignalPayload, RtcSfuInfo, RtcKind } from '@shared/server-types'
import { Room, LocalVideoTrack, LocalAudioTrack, RoomEvent } from 'livekit-client'
import { connectSfu, publishOrReplace } from './livekitClient'
import { sfuFromAck } from '@shared/sfu'

export interface RtcEngineOptions {
  roomId: string
  /** 本端 userId（LiveKit 参与者 identity = String(myUserId)） */
  myUserId?: number
  /** 通话/会议类型（无 sfu 时需要主动向服务端 rtc:join 申请 token 时用） */
  kind?: RtcKind
  /** 兼容字段：LiveKit 房间由 SFU 下发 ICE/TURN，本字段不再使用 */
  iceServers: RtcIceServer[]
  /** SFU 连接信息（服务端 rtc:join/dmCall 等统一签发下发；有则用服务端 token，不再本地签发） */
  sfu?: RtcSfuInfo
  localStream: MediaStream
  /** 兼容字段：LiveKit 无需 P2P 信令，本回调不再触发 */
  onSignal: (signal: RtcSignalPayload) => void
  onRemoteStream: (userId: number, stream: MediaStream) => void
  /** 对端离开（不是本端主动关闭）——用于清理 UI */
  onPeerDisconnected: (userId: number) => void
  /** 对端媒体就绪（首个轨道订阅成功）——重试逻辑靠它判定成功 */
  onPeerConnected?: (userId: number) => void
}

class RtcEngine {
  private roomId: string
  private myUserId: number
  private kind?: RtcKind
  private sfu?: RtcSfuInfo
  private localStream: MediaStream
  private onRemoteStream: (userId: number, stream: MediaStream) => void
  private onPeerDisconnected: (userId: number) => void
  private onPeerConnected?: (userId: number) => void

  private room: Room | null = null
  /** 每位远端参与者当前的轨道集合（视频+音频），每次变化都重新发一个 MediaStream，触发 UI 重新绑定 */
  private remoteTracksByUser = new Map<number, MediaStreamTrack[]>()
  private connectedOnce = new Set<number>()
  /** 已订阅的远端轨道（录制用 + 去重） */
  private remoteTracks = new Map<string, MediaStreamTrack>()

  private publishedVideo: LocalVideoTrack | null = null
  private publishedAudio: LocalAudioTrack | null = null

  private recorder: MediaRecorder | null = null
  private recordChunks: Blob[] = []
  private recording = false

  private disposed = false

  constructor(opts: RtcEngineOptions) {
    this.roomId = opts.roomId
    this.myUserId = opts.myUserId ?? 0
    this.kind = opts.kind
    this.sfu = opts.sfu
    this.localStream = opts.localStream
    this.onRemoteStream = opts.onRemoteStream
    this.onPeerDisconnected = opts.onPeerDisconnected
    this.onPeerConnected = opts.onPeerConnected
    console.log(
      '[RtcEngine] 初始化（LiveKit）',
      'room=' + this.roomId,
      'identity=' + String(this.myUserId),
      'sfu=' + (opts.sfu ? 'server-token' : 'none'),
      'localTracks=' + this.localStream.getTracks().length
    )
    void this._connect()
  }

  // ─── 建立连接（LiveKit） ───────────────────────────────

  private async _connect(): Promise<void> {
    // 启动先获取：优先用调用方传入的 sfu；未传入则主动向服务端申请 token（rtc:join 返回），
    // 绝不因为构造时 sfu 未就绪就放弃连接。
    let sfu = this.sfu
    if (!sfu) {
      try {
        const ack = await window.pantry.rtcJoin(this.roomId, undefined, this.kind)
        const got = sfuFromAck(ack)
        if (got) {
          sfu = got
          this.sfu = got
        }
      } catch (e) {
        console.error('[RtcEngine] 主动获取 SFU 信息失败', e)
      }
    }
    if (!sfu) {
      console.error('[RtcEngine] 无法获取 SFU 信息（服务端未启用 LiveKit / 未配置 LIVEKIT_*），视频链路不可用')
      return
    }
    const roomName = sfu.roomName

    try {
      // 统一连接（connectSfu）：事件订阅在 onRoomCreated 里完成（需在 connect 前绑定才不会错过）
      const room = await connectSfu(sfu, {
        onRoomCreated: (r) => {
          this.room = r

          r.on(RoomEvent.TrackSubscribed, (track, _pub, participant) => {
            const uid = Number(participant.identity)
            if (!Number.isFinite(uid) || !track.mediaStreamTrack) return
            this.remoteTracks.set(track.sid ?? `${uid}-${track.mediaStreamTrack.id}`, track.mediaStreamTrack)
            const list = this.remoteTracksByUser.get(uid) ?? []
            if (!list.includes(track.mediaStreamTrack)) list.push(track.mediaStreamTrack)
            this.remoteTracksByUser.set(uid, list)
            console.log(`[RtcEngine] [subscribe] user=${uid} kind=${track.mediaStreamTrack.kind}`)
            // 重新构建 MediaStream：<video srcObject> 在轨道变化后需要重绑才能播放新轨
            this.onRemoteStream(uid, new MediaStream(list.slice()))
            if (!this.connectedOnce.has(uid)) {
              this.connectedOnce.add(uid)
              this.onPeerConnected?.(uid)
            }
          })

          r.on(RoomEvent.TrackUnsubscribed, (track, _pub, participant) => {
            const uid = Number(participant.identity)
            if (!track.mediaStreamTrack) return
            const list = this.remoteTracksByUser.get(uid) ?? []
            const next = list.filter((t) => t !== track.mediaStreamTrack)
            if (next.length) this.remoteTracksByUser.set(uid, next)
            else this.remoteTracksByUser.delete(uid)
            this.remoteTracks.delete(track.sid ?? '')
            this.onRemoteStream(uid, new MediaStream(next.slice()))
          })

          r.on(RoomEvent.ParticipantDisconnected, (participant) => {
            const uid = Number(participant.identity)
            if (!Number.isFinite(uid)) return
            console.log(`[RtcEngine] [disconnect] user=${uid}`)
            this.remoteTracksByUser.delete(uid)
            this.connectedOnce.delete(uid)
            this.onPeerDisconnected(uid)
          })

          r.on(RoomEvent.Reconnecting, () => {
            console.log('[RtcEngine] LiveKit 重连中…')
          })
          r.on(RoomEvent.Reconnected, () => {
            console.log('[RtcEngine] LiveKit 重连成功')
            for (const uid of this.remoteTracksByUser.keys()) {
              if (!this.connectedOnce.has(uid)) {
                this.connectedOnce.add(uid)
                this.onPeerConnected?.(uid)
              }
            }
          })
        },
        onDisconnected: () => {
          console.log('[RtcEngine] LiveKit 连接断开')
        }
      })
      this.room = room
      console.log('[RtcEngine] LiveKit 已连接', roomName, 'url=' + sfu.url)

      // 发布本地轨道（通用 publishOrReplace）
      const videoTrack = this.localStream.getVideoTracks()[0] ?? null
      const audioTrack = this.localStream.getAudioTracks()[0] ?? null
      if (videoTrack) this.publishedVideo = (await publishOrReplace(room, 'camera', 'video', videoTrack)) as LocalVideoTrack | null
      if (audioTrack) this.publishedAudio = (await publishOrReplace(room, 'microphone', 'audio', audioTrack)) as LocalAudioTrack | null
      console.log('[RtcEngine] 本地轨道已发布 video=' + !!videoTrack + ' audio=' + !!audioTrack)
    } catch (e) {
      console.error('[RtcEngine] LiveKit 连接失败:', e instanceof Error ? e.message : String(e))
    }
  }

  // ─── 兼容旧 API ────────────────────────────────────────

  /** 旧的 P2P 建连入口：LiveKit 自动订阅，这里无需建连（保留签名供上层调用） */
  addPeer(userId: number, _opts: { sendOffer?: boolean } = {}): void {
    if (this.connectedOnce.has(userId)) return
    console.log('[RtcEngine] [addPeer] user=' + userId + '（LiveKit 自动订阅，无需手工建连）')
  }

  /** 旧的「谁发 offer」判定：保留签名（LiveKit 下无意义） */
  isOffererFor(userId: number): boolean {
    return this.myUserId < userId
  }

  /** 旧的 P2P 信令入口：LiveKit 无需 P2P 信令，忽略 */
  handleSignal(_fromUserId: number, _signal: RtcSignalPayload): void {
    /* no-op：媒体由 SFU 转发 */
  }

  /** 旧的对端关闭：LiveKit 由房间事件驱动，无需手工关闭 */
  closePeer(userId: number, _reason = '主动关闭'): void {
    console.log('[RtcEngine] [closePeer] user=' + userId + '（LiveKit 自动处理）')
  }

  /** 关闭并断开 LiveKit 连接 */
  closeAll(): void {
    this.disposed = true
    try {
      this.room?.disconnect()
    } catch {
      /* ignore */
    }
    this.room = null
    this.remoteTracksByUser.clear()
    this.remoteTracks.clear()
    this.connectedOnce.clear()
    this.publishedVideo = null
    this.publishedAudio = null
  }

  /**
   * 替换本地轨道（切换摄像头/麦克风/屏幕共享/开关摄像头）。
   * null 时取消发布对应类型的轨道。
   */
  replaceTrack(track: MediaStreamTrack | null, kind: 'audio' | 'video'): void {
    void this._replaceTrack(track, kind)
  }

  private async _replaceTrack(track: MediaStreamTrack | null, kind: 'audio' | 'video'): Promise<void> {
    // 维护本地流引用（录制用）
    const old = this.localStream.getTracks().filter((t) => t.kind === kind)
    old.forEach((t) => {
      try {
        this.localStream.removeTrack(t)
      } catch {
        /* ignore */
      }
    })
    if (track) this.localStream.addTrack(track)

    const room = this.room
    const participant = room?.localParticipant
    if (!room || !participant) return

    try {
      if (kind === 'video') {
        if (!track) {
          if (this.publishedVideo) {
            // 不停止底层相机轨道（设备可能被别处复用）
            await participant.unpublishTrack(this.publishedVideo, false)
            this.publishedVideo = null
          }
          return
        }
        if (this.publishedVideo) {
          await this.publishedVideo.replaceTrack(track)
        } else {
          const t = new LocalVideoTrack(track, {}, true)
          await participant.publishTrack(t, { name: 'camera' })
          this.publishedVideo = t
        }
      } else {
        if (!track) {
          if (this.publishedAudio) {
            await participant.unpublishTrack(this.publishedAudio, false)
            this.publishedAudio = null
          }
          return
        }
        if (this.publishedAudio) {
          await this.publishedAudio.replaceTrack(track)
        } else {
          const t = new LocalAudioTrack(track, undefined, true)
          await participant.publishTrack(t, { name: 'microphone' })
          this.publishedAudio = t
        }
      }
    } catch (e) {
      console.error('[RtcEngine] replaceTrack 失败:', e instanceof Error ? e.message : String(e))
    }
  }

  // ─── 通话录制（本地+远端合成，MediaRecorder → webm） ─────

  /** 是否正在录制 */
  isRecording(): boolean {
    return this.recording
  }

  /** 开始录制：合成本地音视频 + 所有对端接收音视频 */
  startRecording(): void {
    if (this.recording) return
    this.recordChunks = []

    const tracks: MediaStreamTrack[] = []
    this.localStream.getTracks().forEach((t) => {
      if (t.readyState === 'live') tracks.push(t)
    })
    this.remoteTracks.forEach((t) => {
      if (t.readyState === 'live') tracks.push(t)
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
