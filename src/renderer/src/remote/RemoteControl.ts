/**
 * 远程设备控制 —— 被控端（客户端 app，LiveKit SFU 版）
 *
 * 登录后向服务端 dev:register 注册本机为"在线电脑"，并维持心跳；
 * 订阅服务端 dev:view / dev:enumerate / dev:start / dev:stop：
 *   - dev:view（带服务端签发的 url/token/roomName）→ 连接该 LiveKit room，发布占位轨
 *   - dev:enumerate → 枚举摄像头/麦克风并 dev:devices 上报给控制端
 *   - dev:start { kind: camera|screen|mic } → 采集对应流，替换/发布到 SFU 轨道
 *   - dev:stop → 停流并断开 SFU
 *
 * 【SFU 化】不再建 RTCPeerConnection、不再走 dev:signal。被控端把屏幕/声音 publish 到
 * LiveKit room，控制端订阅；键鼠走 LiveKit data（服务端 dev:view 已签发双方 token）。
 * 轨道替换：发布同名轨道（screen / system-audio）实现摄像头/麦克风/屏幕切换。
 */
import { Room, RoomEvent, LocalVideoTrack, LocalAudioTrack } from 'livekit-client'
import VideoStream from '../media/VideoStream'

interface DevStartPayload {
  deviceId?: string
  kind?: string
  device?: unknown
}
interface DevViewPayload {
  deviceId?: string
  url?: string
  token?: string
  roomName?: string
}

class RemoteControl {
  private deviceId = ''
  private info: { deviceId: string; hostname: string; os: string; ip: string } | null = null
  private room: Room | null = null
  private activeDeviceId = ''
  /** 当前实际采集/占位轨（发布中），切换时 stop 旧轨 */
  private activeVideo: MediaStreamTrack | null = null
  private activeAudio: MediaStreamTrack | null = null
  private unsubs: Array<() => void> = []

  /** 渲染进程启动时调用一次：订阅 dev 事件（注册/心跳/系统上报已收敛到主进程 sys-report，此处只做被控采集） */
  init(): void {
    if (this.unsubs.length > 0) return
    window.pantry.devGetInfo().then((info) => {
      this.info = info
      this.deviceId = info.deviceId
      console.log(`[remote] 本机信息 deviceId=${info.deviceId} hostname=${info.hostname} ip=${info.ip} os=${info.os}`)
    }).catch((e) => console.warn('[remote] devGetInfo 失败（被控端将无法被查看）', e))

    this.unsubs.push(window.pantry.onDevView((d) => { if (this.deviceId && d.deviceId === this.deviceId) void this.connectSFU(d as DevViewPayload) }))
    this.unsubs.push(window.pantry.onDevEnumerate((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.enumerate() }))
    this.unsubs.push(window.pantry.onDevStart((d) => { if (this.deviceId && d.deviceId === this.deviceId) void this.startCapture(d as DevStartPayload) }))
    this.unsubs.push(window.pantry.onDevStop((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.stopCapture() }))
    // SFU 化后无 dev:signal（媒体协商由 LiveKit 完成），不再订阅。
  }

  destroy(): void {
    this.stopCapture()
    this.unsubs.forEach((u) => u())
    this.unsubs = []
  }

  // ── 设备枚举上报 ───────────────────────────────────────
  private async enumerate(): Promise<void> {
    if (!this.deviceId) return
    try {
      const cams = (await VideoStream.GetVideoDevices()).map((d) => ({ id: d.deviceId, label: d.label || '摄像头' }))
      const mics = (await VideoStream.GetAudioDevices()).map((d) => ({ id: d.deviceId, label: d.label || '麦克风' }))
      await window.pantry.devDevices(this.deviceId, cams, mics)
      console.log(`[remote] 上报设备 cams=${cams.length} mics=${mics.length}`)
    } catch (e) {
      console.warn('[remote] 枚举设备失败', e)
    }
  }

  // ── 占位轨（连接建立时先发布，保证控制端能订阅到画面；之后按 kind 替换） ──
  private placeholderVideoTrack(): MediaStreamTrack {
    try {
      const s = VideoStream.GetEmptyVideoStream()
      const t = s.getVideoTracks()[0]
      if (t) return t
    } catch { /* 忽略 */ }
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    canvas.getContext('2d')?.fillRect(0, 0, canvas.width, canvas.height)
    return canvas.captureStream(15).getVideoTracks()[0]
  }
  private placeholderAudioTrack(): MediaStreamTrack {
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    return dest.stream.getAudioTracks()[0]
  }

  // ── 连接 SFU（dev:view 下发 url/token/roomName），发布占位轨 ──
  private async connectSFU(d: DevViewPayload): Promise<void> {
    if (!d.url || !d.token || !d.roomName) {
      console.warn('[remote] dev:view 未带 SFU 信息（服务端未配置 LiveKit），设备无法被 SFU 查看')
      return
    }
    if (this.room) return // 已连接
    this.activeDeviceId = d.deviceId ?? ''
    const room = new Room()
    this.room = room
    try {
      await room.connect(d.url, d.token)
    } catch (e) {
      console.warn('[remote] 连接 SFU 失败', e)
      this.room = null
      return
    }
    console.log(`[remote] 已连接 SFU room=${d.roomName}`)
    // 发布占位轨，保证控制端有画面；后续 dev:start 按 kind 替换
    try {
      const vp = this.placeholderVideoTrack()
      const ap = this.placeholderAudioTrack()
      await room.localParticipant.publishTrack(new LocalVideoTrack(vp, {}, true), { name: 'screen' })
      await room.localParticipant.publishTrack(new LocalAudioTrack(ap, undefined, true), { name: 'system-audio' })
      this.activeVideo = vp
      this.activeAudio = ap
    } catch (e) {
      console.warn('[remote] 发布占位轨失败', e)
    }
    room.on(RoomEvent.Disconnected, () => {
      console.log('[remote] SFU 断开')
      this.room = null
      this.activeVideo = null
      this.activeAudio = null
    })
  }

  // ── 替换对应 kind 的 SFU 轨道（同名发布，先 unpublish 旧的更稳） ──
  private async replaceTrack(kind: 'video' | 'audio', name: string, track: MediaStreamTrack | null): Promise<void> {
    const room = this.room
    if (!room) return
    try {
      for (const pub of room.localParticipant.trackPublications.values()) {
        if (pub.trackName === name) {
          const t = pub.track
          if (t) await room.localParticipant.unpublishTrack(t)
          try { t?.stop() } catch { /* ignore */ }
        }
      }
      if (track) {
        const t = kind === 'video' ? new LocalVideoTrack(track, {}, true) : new LocalAudioTrack(track, undefined, true)
        await room.localParticipant.publishTrack(t, { name })
      }
    } catch (e) {
      console.warn(`[remote] 替换${kind}轨 ${name} 失败`, e)
    }
    if (kind === 'video') {
      if (this.activeVideo && this.activeVideo !== track) this.activeVideo.stop()
      this.activeVideo = track
    } else {
      if (this.activeAudio && this.activeAudio !== track) this.activeAudio.stop()
      this.activeAudio = track
    }
    console.log(`[remote] ${name} 轨已替换 kind=${track?.kind ?? 'null'}`)
  }

  // ── 采集 + 发布到 SFU ──
  private async startCapture(d: DevStartPayload): Promise<void> {
    const kind = d.kind
    if (!this.room) {
      console.warn('[remote] SFU 未连接，请先发起查看（dev:view）')
      return
    }
    try {
      if (kind === 'mic') {
        const s = await VideoStream.GetAudioStream(typeof d.device === 'string' ? d.device : undefined)
        await this.replaceTrack('audio', 'system-audio', s.getAudioTracks()[0] ?? null)
      } else if (kind === 'camera') {
        const s = await VideoStream.GetCameraStream(typeof d.device === 'string' ? d.device : undefined)
        await this.replaceTrack('video', 'screen', s.getVideoTracks()[0] ?? null)
      } else if (kind === 'screen') {
        // 屏幕 + 系统声音（audio: loopback，由主进程 setDisplayMediaRequestHandler 提供）
        const s = await (navigator.mediaDevices as unknown as { getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream> })
          .getDisplayMedia({ video: true, audio: true })
        await this.replaceTrack('video', 'screen', s.getVideoTracks()[0] ?? null)
        await this.replaceTrack('audio', 'system-audio', s.getAudioTracks()[0] ?? null)
      } else {
        console.warn('[remote] 未知采集类型', kind)
        return
      }
    } catch (e) {
      console.warn(`[remote] 采集 ${kind} 失败`, e)
    }
  }

  // ── 停止 ───────────────────────────────────────────────
  private stopCapture(): void {
    if (this.room) {
      this.room.disconnect()
      this.room = null
    }
    if (this.activeVideo) { try { this.activeVideo.stop() } catch { /* ignore */ } this.activeVideo = null }
    if (this.activeAudio) { try { this.activeAudio.stop() } catch { /* ignore */ } this.activeAudio = null }
    this.activeDeviceId = ''
    console.log('[remote] 已停止采集并断开 SFU')
  }
}

export default new RemoteControl()
