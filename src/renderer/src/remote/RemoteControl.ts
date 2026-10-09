/**
 * 远程设备控制 —— 被控端（客户端 app）
 *
 * 登录后向服务端 dev:register 注册本机为"在线电脑"，并维持心跳；
 * 订阅服务端 dev:view / dev:enumerate / dev:start / dev:stop / dev:signal：
 *   - dev:view / dev:enumerate → 枚举摄像头/麦克风并 dev:devices 上报给控制端
 *   - dev:start { kind: camera|screen|mic, device, iceServers } → 采集对应流，
 *     以被控端为 WebRTC sender（addTrack + createOffer），经 dev:signal 发给控制端
 *   - dev:stop → 停流并关闭 RTCPeerConnection
 *
 * 信令经 main 的 serverClient socket（IPC：window.pantry.devSignal / onDevSignal）转发。
 */
import VideoStream from '../media/VideoStream'

interface DevStartPayload {
  deviceId?: string
  kind?: string
  device?: unknown
  iceServers?: Array<{ urls: string | string[]; username?: string; credential?: string }>
}
interface DevSignalPayload {
  type?: string
  sdp?: string
  candidate?: unknown
}
interface DevState {
  connected: boolean
  token?: string
  username?: string
  nick?: string
}

class RemoteControl {
  private deviceId = ''
  private info: { deviceId: string; hostname: string; os: string; ip: string } | null = null
  private registered = false
  private hbTimer: ReturnType<typeof setInterval> | null = null
  private pc: RTCPeerConnection | null = null
  private stream: MediaStream | null = null
  private activeDeviceId = ''
  private unsubs: Array<() => void> = []
  private nickname = ''

  /** 渲染进程启动时调用一次：订阅服务端状态 + dev 事件，登录后自动注册被控 */
  init(): void {
    if (this.unsubs.length > 0) return
    window.pantry.devGetInfo().then((info) => {
      this.info = info
      this.deviceId = info.deviceId
      console.log(`[remote] 本机信息 deviceId=${info.deviceId} hostname=${info.hostname} ip=${info.ip} os=${info.os}`)
    }).catch((e) => console.warn('[remote] devGetInfo 失败（被控端将无法注册）', e))

    this.unsubs.push(
      window.pantry.onServerState((s: DevState) => {
        if (s.connected && s.token) this.tryRegister(s.username ?? '', s.nick ?? '')
        else this.registered = false
      })
    )
    this.unsubs.push(window.pantry.onDevView((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.enumerate() }))
    this.unsubs.push(window.pantry.onDevEnumerate((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.enumerate() }))
    this.unsubs.push(window.pantry.onDevStart((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.startCapture(d as DevStartPayload) }))
    this.unsubs.push(window.pantry.onDevStop((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.stopCapture() }))
    this.unsubs.push(window.pantry.onDevSignal((d) => { if (this.deviceId && d.deviceId === this.deviceId) this.handleSignal(d.signal as DevSignalPayload) }))
  }

  destroy(): void {
    this.stopCapture()
    if (this.hbTimer) clearInterval(this.hbTimer)
    this.hbTimer = null
    this.unsubs.forEach((u) => u())
    this.unsubs = []
  }

  // ── 注册 / 心跳 ────────────────────────────────────────
  // 服务端 dev:register 幂等（按 deviceId 覆盖信息 + 更新 socket），
  // 因此每次连接恢复（onServerState connected）都重复注册，保证容器/服务端重启后被控端自动重新上线，
  // 不再依赖 registered 标志（重连后该标志残留 true 会导致"列表有设备但点开失败/dev:sys 被丢弃"）。
  private async tryRegister(username: string, nick: string): Promise<void> {
    if (!this.info) {
      try { this.info = await window.pantry.devGetInfo() } catch (e) { console.warn('[remote] tryRegister 获取本机信息失败', e) }
      if (this.info) this.deviceId = this.info.deviceId
    }
    if (!this.deviceId) { console.warn('[remote] tryRegister 无 deviceId，跳过注册'); return }
    const name = this.info?.hostname || '电脑'
    // 用户名：优先 nick，为空显示 username（不兜底主机名，主机名用 name 单独显示）
    this.nickname = nick || username || ''
    let ack: { ok: boolean; error?: string }
    try {
      ack = await window.pantry.devRegister({
        deviceId: this.deviceId,
        name,
        os: this.info?.os ?? '',
        ip: this.info?.ip ?? '',
        username: this.nickname
      })
    } catch (e) {
      console.error('[remote] dev:register 调用失败（IPC 异常）', e)
      return
    }
    console.log(`[remote] dev:register ${this.deviceId} name=${name} =>`, ack.ok ? 'ok' : (ack as { error?: string }).error)
    if (!ack.ok) return
    this.registered = true
    if (!this.hbTimer) {
      // 心跳携带完整设备信息：服务端按 deviceId upsert（没有就添加，有就更新），即使 register 丢失也会由心跳自动重建设备
      this.hbTimer = setInterval(() => {
        window.pantry.devHeartbeat({
          deviceId: this.deviceId,
          name: this.info?.hostname || '电脑',
          os: this.info?.os ?? '',
          ip: this.info?.ip ?? '',
          username: this.nickname
        })
      }, 25_000)
    }
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

  // ── 采集 + WebRTC（被控端 sender） ─────────────────────
  private async startCapture(d: DevStartPayload): Promise<void> {
    const kind = d.kind
    const deviceId = d.deviceId ?? ''
    const ice = (d.iceServers ?? [{ urls: 'stun:stun.l.google.com:19302' }]) as RTCIceServer[]
    this.stopCapture()
    this.activeDeviceId = deviceId
    let stream: MediaStream | null = null
    try {
      if (kind === 'camera') {
        stream = await VideoStream.GetCameraStream(typeof d.device === 'string' ? d.device : undefined)
      } else if (kind === 'mic') {
        stream = await VideoStream.GetAudioStream(typeof d.device === 'string' ? d.device : undefined)
      } else if (kind === 'screen') {
        stream = await (navigator.mediaDevices as unknown as { getDisplayMedia: (c: MediaStreamConstraints) => Promise<MediaStream> }).getDisplayMedia({ video: true })
      } else {
        console.warn('[remote] 未知采集类型', kind)
        return
      }
    } catch (e) {
      console.warn(`[remote] 采集 ${kind} 失败`, e)
      await window.pantry.devSignal(this.activeDeviceId, { type: 'error', sdp: undefined, candidate: String((e as Error)?.message ?? e) })
      return
    }
    this.stream = stream
    try {
      this.pc = new RTCPeerConnection({ iceServers: ice })
    } catch (e) {
      console.warn('[remote] RTCPeerConnection 创建失败', e)
      return
    }
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) window.pantry.devSignal(this.activeDeviceId, { type: 'candidate', sdp: undefined, candidate: ev.candidate.toJSON() })
    }
    this.pc.onconnectionstatechange = () => console.log('[remote] connectionState=', this.pc?.connectionState)
    stream.getTracks().forEach((t) => this.pc!.addTrack(t, stream))
    const offer = await this.pc.createOffer()
    await this.pc.setLocalDescription(offer)
    await window.pantry.devSignal(this.activeDeviceId, { type: offer.type, sdp: offer.sdp, candidate: undefined })
    console.log(`[remote] 已发送 offer kind=${kind}`)
  }

  private async handleSignal(signal: DevSignalPayload): Promise<void> {
    if (!this.pc) return
    try {
      if (signal.type === 'answer' && signal.sdp) {
        await this.pc.setRemoteDescription({ type: 'answer', sdp: signal.sdp })
        console.log('[remote] 已设置远端 answer')
      } else if (signal.candidate) {
        try {
          await this.pc.addIceCandidate(signal.candidate as RTCIceCandidateInit)
        } catch { /* 忽略候选时序 */ }
      }
    } catch (e) {
      console.warn('[remote] 处理信令失败', e)
    }
  }

  // ── 停止 ───────────────────────────────────────────────
  private stopCapture(): void {
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop())
      this.stream = null
    }
    if (this.pc) {
      this.pc.onicecandidate = null
      this.pc.onconnectionstatechange = null
      this.pc.close()
      this.pc = null
    }
    this.activeDeviceId = ''
  }
}

export default new RemoteControl()
