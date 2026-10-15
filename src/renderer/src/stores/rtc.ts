import { defineStore } from 'pinia'
import { ref, watch } from 'vue'
import type {
  Ack,
  RtcDmIncomingEvent,
  RtcGroupCallEvent,
  RtcIceServer,
  RtcKind,
  RtcPeer,
  RtcRoom
} from '@shared/server-types'
import type { NotifKind, NotifTarget } from '@shared/ipc'
import { notifyEvent, stopRing } from '@renderer/utils/notify-manager'
import VideoStream, { CameraUnavailableError } from '@renderer/media/VideoStream'
import RtcEngine from '@renderer/rtc/RtcEngine'
import { saveCallRecording } from '@renderer/rtc/recording'
import RemoteUi from '@renderer/remote/RemoteUi'
import { useServerStore } from '@renderer/stores/server'

// ─── RTC preload API 类型（主进程层同时实现，此处做类型断言） ───

interface RtcPantryApi {
  rtcCreateMeeting(opts: {
    title?: string
    startAt?: string
    password?: string
    kind: RtcKind
  }): Promise<Ack & { data?: { meeting: RtcRoom; scheduled: boolean; peers?: RtcPeer[]; iceServers?: RtcIceServer[] } }>
  rtcGetMeeting(meetingNo: string): Promise<Ack & { data?: { meeting: RtcRoom } }>
  rtcJoin(
    roomId: string,
    password?: string,
    kind?: RtcKind
  ): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[]; started: boolean } }>
  rtcSignal(roomId: string, signal: import('@shared/server-types').RtcSignalPayload): Promise<Ack>
  rtcLeave(roomId: string): Promise<Ack>
  rtcEnd(roomId: string): Promise<Ack>
  rtcDmCall(
    userId: number,
    kind: RtcKind,
    password?: string
  ): Promise<Ack & { data?: { room: RtcRoom; kind: RtcKind; peers?: RtcPeer[]; iceServers?: RtcIceServer[] } }>
  rtcDmAnswer(
    roomId: string,
    accept: boolean
  ): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }>
  rtcGroupCall(
    groupId: number,
    kind: RtcKind
  ): Promise<Ack & { data?: { room: RtcRoom; peers: RtcPeer[]; iceServers: RtcIceServer[] } }>

  onRtcDmIncoming(l: (d: RtcDmIncomingEvent) => void): () => void
  onRtcDmRejected(l: (d: import('@shared/server-types').RtcDmRejectedEvent) => void): () => void
  onRtcPeerJoined(l: (d: import('@shared/server-types').RtcPeerJoinedEvent) => void): () => void
  onRtcPeerLeft(l: (d: import('@shared/server-types').RtcPeerLeftEvent) => void): () => void
  onRtcSignal(l: (d: import('@shared/server-types').RtcSignalEvent) => void): () => void
  onRtcEnded(l: (d: import('@shared/server-types').RtcEndedEvent) => void): () => void
  onRtcGroupCall(l: (d: RtcGroupCallEvent) => void): () => void
  notify(opts: { title: string; body: string; target?: NotifTarget; tray?: boolean }): Promise<unknown>
  getWindowState(): Promise<{ focused: boolean; visible: boolean; minimized: boolean }>
}

const rtcPantry = window.pantry as unknown as RtcPantryApi

// ─── Store ──────────────────────────────────────────────

interface ActiveCall {
  room: RtcRoom
  kind: RtcKind
  peers: RtcPeer[]
  remoteStreams: Record<number, MediaStream>
  isMuted: boolean
  isCameraOff: boolean
  isScreenSharing: boolean
  connectionState: 'connecting' | 'connected' | 'reconnecting'
}

export const useRtcStore = defineStore('rtc', () => {
  // 当前用户头像（频谱画布用，绝对 URL 供 canvas 加载）
  const server = useServerStore()
  const myAvatarAbs = () => server.absFileUrl(server.state.avatar ?? '')
  // ─── 响应式 state ───
  const activeCall = ref<ActiveCall | null>(null)
  const incomingDm = ref<RtcDmIncomingEvent | null>(null)
  const incomingGroup = ref<RtcGroupCallEvent | null>(null)
  const error = ref('')
  const isRecording = ref(false)

  // ─── 内部引用（非响应式，普通变量） ───
  let engine: RtcEngine | null = null
  let cleanupFns: Array<() => void> = []

  // ─── 事件订阅 ───

  /**
   * 统一走通知管理器（它按类型决定弹通知/响不响/响哪个音，并统一处理免打扰）。
   * kind：call=单人语音视频来电、meeting=群通话/会议邀请、system=远程控制等系统提示。
   */
  async function maybeNotify(title: string, body: string, target?: NotifTarget, kind: NotifKind = 'system', force = false): Promise<void> {
    try {
      await notifyEvent({ kind, title, body, target, force })
    } catch (e) {
      console.error('[rtc] 通知发送失败', title, e)
    }
  }

  // 来电铃声的停止点用 watch 兜底：只要「没有待接来电」就停铃。
  // 这样接听、拒接、对方取消、超时挂断全都覆盖，不依赖每个调用点记得调 stopRing
  // ——漏一处就会一直响，这是最基本的常识问题。
  watch([incomingDm, incomingGroup], ([dm, grp]) => {
    if (!dm && !grp) stopRing()
  })

  function wire(): () => void {
    cleanupFns.push(
      rtcPantry.onRtcDmIncoming((d) => {
        if (activeCall.value) return // 已有通话，忽略新来电
        incomingDm.value = d
        const isRemote = d.kind === 'remote'
        const who = d.from.nick ?? `用户 ${d.from.userId}`
        const title = isRemote ? '远程控制请求' : `${who} 正在呼叫你`
        const body = isRemote
          ? `${who} 请求远程控制你的电脑。同意后对方将看到并操作你的屏幕。`
          : d.kind === 'video' ? '视频通话' : '语音通话'
        // 远程控制涉及他人操控本机，有风险：无论窗口是否聚焦都显著系统通知提醒（但不响铃声）
        // 语音/视频来电走 call 类型：会按设置循环播来电铃声，接听/拒接/取消时自动停
        void maybeNotify(title, body, { kind: 'main' }, isRemote ? 'system' : 'call', isRemote)
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcDmRejected((d) => {
        if (activeCall.value && activeCall.value.room.id === d.room) {
          void _leaveRoom()
          error.value = '对方已拒绝'
        }
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcPeerJoined((d) => {
        if (!activeCall.value || activeCall.value.room.id !== d.room) return
        // 同 userId 多端时保留最新
        const existingIdx = activeCall.value.peers.findIndex((p) => p.userId === d.peer.userId)
        if (existingIdx >= 0) {
          activeCall.value.peers[existingIdx] = d.peer
        } else {
          activeCall.value.peers.push(d.peer)
        }
        engine?.addPeer(d.peer.userId)
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcPeerLeft((d) => {
        if (!activeCall.value || activeCall.value.room.id !== d.room) return
        // peerId 是 socketId，找到对应 peer 的 userId
        const peer = activeCall.value.peers.find((p) => p.socketId === d.peerId)
        if (peer) {
          engine?.closePeer(peer.userId)
          delete activeCall.value.remoteStreams[peer.userId]
          activeCall.value.peers = activeCall.value.peers.filter((p) => p.socketId !== d.peerId)
        }
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcSignal((d) => {
        if (!activeCall.value || activeCall.value.room.id !== d.room) return
        // from 只有 userId/nick，engine 按 userId 维护 PC
        engine?.handleSignal(d.from.userId, d.signal)
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcEnded((d) => {
        if (activeCall.value && activeCall.value.room.id === d.room) {
          void stopRecordingAndSave().then(() => {
            void _leaveRoom()
            error.value = '通话已结束'
          })
        }
      })
    )

    cleanupFns.push(
      rtcPantry.onRtcGroupCall((d) => {
        if (activeCall.value) return // 已有通话，忽略
        incomingGroup.value = d
        void maybeNotify(`群通话邀请：${d.from.nick ?? d.from.userId}`, '群通话', { kind: 'main' }, 'meeting')
      })
    )

    // 返回总清理函数
    return () => {
      cleanupFns.forEach((fn) => fn())
      cleanupFns = []
    }
  }

  // ─── 通话入口 ───

  async function startDmCall(userId: number, kind: RtcKind, password?: string): Promise<{ needPassword?: boolean }> {
    error.value = ''
    try {
      const ack = await rtcPantry.rtcDmCall(userId, kind, password)
      if (!ack.ok || !ack.data?.room) {
        error.value = ack.error || '发起通话失败'
        // 远程控制：对方设置了密码 → 主叫弹密码输入框
        if (kind === 'remote' && ack.error && ack.error.includes('密码')) return { needPassword: true }
        return {}
      }
      if (kind === 'remote') {
        // 远程控制：打开独立远程窗口（控制端查看 + 键鼠控制）
        await RemoteUi.openMaster({ room: ack.data.room.id, kind, iceServers: ack.data.iceServers, mode: 'remote', peerId: userId })
        return {}
      }
      // 统一走通用通话窗口（与会议同一组件 RtcCallRoom）
      void window.pantry.openMeetingWindow({ mode: 'join', kind, meetingNo: ack.data.room.id })
      return {}
    } catch (e) {
      console.error('[rtc] startDmCall 失败', kind, 'userId=', userId, e)
      error.value = String(e)
      return {}
    }
  }

  async function answerDm(): Promise<void> {
    if (!incomingDm.value) return
    error.value = ''
    // 接听就立刻停铃：不等接口返回（网络慢时铃声会一直响到接口回来才停）
    stopRing()
    const roomId = incomingDm.value.room
    const kind = incomingDm.value.kind
    // 远程控制：对端（控制端/发起者）userId，用于信令精确匹配
    const peerId = incomingDm.value.from?.userId ?? 0
    try {
      const ack = await rtcPantry.rtcDmAnswer(roomId, true)
      if (!ack.ok || !ack.data?.room) {
        error.value = ack.error || '接听失败'
        return
      }
      incomingDm.value = null
      if (kind === 'remote') {
        // 被控端：同意后启动被控会话（采集屏幕 + 系统声音 + 键鼠注入）
        void RemoteUi.openSlave({ room: ack.data.room.id, kind, iceServers: ack.data.iceServers, mode: 'remote', peerId })
        return
      }
      // 统一走通用通话窗口
      void window.pantry.openMeetingWindow({ mode: 'join', kind: kind as 'video' | 'voice', meetingNo: ack.data.room.id })
    } catch (e) {
      console.error('[rtc] 调用失败', e)
      error.value = String(e)
    }
  }

  function rejectDm(): void {
    if (!incomingDm.value) return
    stopRing() // 拒接立刻停铃
    void rtcPantry.rtcDmAnswer(incomingDm.value.room, false)
    incomingDm.value = null
  }

  async function startGroupCall(groupId: number, kind: RtcKind): Promise<void> {
    error.value = ''
    try {
      const ack = await rtcPantry.rtcGroupCall(groupId, kind)
      if (!ack.ok || !ack.data?.room) {
        error.value = ack.error || '发起群通话失败'
        return
      }
      // 统一走通用通话窗口
      void window.pantry.openMeetingWindow({ mode: 'join', kind: kind as 'video' | 'voice', meetingNo: ack.data.room.id })
    } catch (e) {
      console.error('[rtc] 调用失败', e)
      error.value = String(e)
    }
  }

  async function joinGroupCall(): Promise<void> {
    if (!incomingGroup.value) return
    error.value = ''
    // 加入群通话/会议就立刻停铃（不等接口返回）
    stopRing()
    const roomId = incomingGroup.value.room
    const kind = incomingGroup.value.kind
    try {
      const ack = await rtcPantry.rtcJoin(roomId, undefined, kind)
      if (!ack.ok || !ack.data?.room) {
        error.value = ack.error || '加入群通话失败'
        return
      }
      incomingGroup.value = null
      // 统一走通用通话窗口
      void window.pantry.openMeetingWindow({ mode: 'join', kind: kind as 'video' | 'voice', meetingNo: ack.data.room.id })
    } catch (e) {
      console.error('[rtc] 调用失败', e)
      error.value = String(e)
    }
  }

  async function createMeeting(opts: {
    title?: string
    password?: string
    kind: RtcKind
    startAt?: string
  }): Promise<{ meeting: RtcRoom; scheduled: boolean }> {
    error.value = ''
    const ack = await rtcPantry.rtcCreateMeeting(opts)
    if (!ack.ok || !ack.data?.meeting) {
      error.value = ack.error || '创建会议失败'
      return { meeting: null as unknown as RtcRoom, scheduled: false }
    }
    return { meeting: ack.data.meeting, scheduled: ack.data.scheduled }
  }

  async function joinMeeting(meetingNo: string, password: string): Promise<void> {
    error.value = ''
    try {
      const ack = await rtcPantry.rtcJoin(meetingNo, password)
      if (!ack.ok || !ack.data?.room) {
        error.value = ack.error || '加入会议失败'
        return
      }
      await _enterRoom(ack.data.room, ack.data.peers, ack.data.iceServers, ack.data.room.kind)
    } catch (e) {
      console.error('[rtc] 调用失败', e)
      error.value = String(e)
    }
  }

  // ─── 通话控制 ───

  // ─── 录制（保存到 {下载目录}/通话录制/） ───
  async function stopRecordingAndSave(): Promise<void> {
    if (!engine || !isRecording.value) return
    const ac = activeCall.value
    const label = ac?.room.meetingNo || ac?.room.id || (ac?.room.type === 'dm' ? '私聊' : '通话')
    try {
      const r = await engine.stopRecording()
      isRecording.value = false
      if (r) {
        const res = await saveCallRecording(r.blob, r.kind, label)
        if (res.ok) error.value = `录制已保存：${res.path}`
        else error.value = `录制保存失败：${res.error}`
      }
    } catch {
      isRecording.value = false
      error.value = '录制停止失败'
    }
  }

  async function toggleRecording(): Promise<void> {
    if (!engine) return
    if (isRecording.value) {
      await stopRecordingAndSave()
    } else {
      engine.startRecording()
      isRecording.value = engine.isRecording()
      if (!isRecording.value) error.value = '录制启动失败（未获取到音视频流）'
    }
  }

  async function leave(): Promise<void> {
    if (!activeCall.value) return
    if (isRecording.value) await stopRecordingAndSave()
    const roomId = activeCall.value.room.id
    try {
      await rtcPantry.rtcLeave(roomId)
    } catch {
      // 即使调用失败也要清理本地状态
    }
    await _leaveRoom()
  }

  async function end(): Promise<void> {
    if (!activeCall.value) return
    if (isRecording.value) await stopRecordingAndSave()
    const roomId = activeCall.value.room.id
    try {
      await rtcPantry.rtcEnd(roomId)
    } catch {
      // 即使调用失败也要清理本地状态
    }
    await _leaveRoom()
  }

  function toggleMute(): void {
    if (!activeCall.value) return
    activeCall.value.isMuted = !activeCall.value.isMuted
    const track = VideoStream.GetCurrentAudioTrack()
    if (track) track.enabled = !activeCall.value.isMuted
  }

  async function toggleCamera(): Promise<void> {
    if (!activeCall.value || activeCall.value.kind === 'voice') return
    activeCall.value.isCameraOff = !activeCall.value.isCameraOff
    try {
      let newTrack: MediaStreamTrack | null
      if (activeCall.value.isCameraOff) {
        // 关闭摄像头 → 空视频流
        const emptyStream = VideoStream.GetEmptyVideoStream()
        newTrack = emptyStream.getVideoTracks()[0] ?? null
      } else {
        // 打开摄像头
        const camStream = await VideoStream.GetCameraStream()
        newTrack = camStream.getVideoTracks()[0] ?? null
      }
      await VideoStream.UpdateVideoStream(
        new MediaStream(newTrack ? [newTrack] : [])
      )
      engine?.replaceTrack(newTrack, 'video')
    } catch (e) {
      if (e instanceof CameraUnavailableError) {
        // 无可用摄像头 → 回退频谱头像，不弹错误窗
        const t = VideoStream.GetAvatarVideoTrack(myAvatarAbs())
        await VideoStream.UpdateVideoStream(new MediaStream(t ? [t] : []))
        engine?.replaceTrack(t, 'video')
        activeCall.value.isCameraOff = true
        return
      }
      error.value = '切换摄像头失败'
      // 回退状态
      activeCall.value.isCameraOff = !activeCall.value.isCameraOff
    }
  }

  async function toggleScreenShare(): Promise<void> {
    if (!activeCall.value || activeCall.value.kind === 'voice') return
    try {
      if (!activeCall.value.isScreenSharing) {
        // 开始共享屏幕
        const screenStream = await VideoStream.GetScreenStream()
        const track = screenStream.getVideoTracks()[0] ?? null
        await VideoStream.UpdateVideoStream(screenStream)
        engine?.replaceTrack(track, 'video')
        activeCall.value.isScreenSharing = true
      } else {
        // 停止共享，恢复摄像头
        const camStream = await VideoStream.GetCameraStream()
        const track = camStream.getVideoTracks()[0] ?? null
        await VideoStream.UpdateVideoStream(camStream)
        engine?.replaceTrack(track, 'video')
        activeCall.value.isScreenSharing = false
      }
    } catch (e) {
      error.value = '屏幕共享切换失败'
    }
  }

  // 设备面板「应用」→ 切换麦克风/扬声器/摄像头 + 音质（对每个 PC replaceTrack）
  async function applyDevices(p: {
    audioInId: string
    audioOutId: string
    cameraId: string
    sampleRate: number
    channelCount: number
  }): Promise<void> {
    if (!activeCall.value) return
    try {
      if (p.audioInId) {
        const ms = await VideoStream.GetAudioStream(p.audioInId, { sampleRate: p.sampleRate, channelCount: p.channelCount })
        const track = ms.getAudioTracks()[0] ?? null
        await VideoStream.UpdateAudioStream(new MediaStream(track ? [track] : []))
        engine?.replaceTrack(track, 'audio')
      }
      if (p.cameraId) {
        try {
          const ms = await VideoStream.GetCameraStream(p.cameraId)
          const track = ms.getVideoTracks()[0] ?? null
          await VideoStream.UpdateVideoStream(new MediaStream(track ? [track] : []))
          engine?.replaceTrack(track, 'video')
          activeCall.value.isCameraOff = p.cameraId === 'default'
        } catch (err) {
          if (err instanceof CameraUnavailableError) {
            // 无可用摄像头 → 回退频谱头像，不弹错误窗
            const t = VideoStream.GetAvatarVideoTrack(myAvatarAbs())
            await VideoStream.UpdateVideoStream(new MediaStream(t ? [t] : []))
            engine?.replaceTrack(t, 'video')
            activeCall.value.isCameraOff = true
          } else {
            throw err
          }
        }
      }
      if (p.audioOutId) {
        document.querySelectorAll('video').forEach((el) => VideoStream.SetSinkId(el as HTMLVideoElement, p.audioOutId))
      }
    } catch {
      error.value = '设备切换失败'
    }
  }

  // ─── 内部：进入/离开房间 ───

  async function _enterRoom(
    room: RtcRoom,
    peers: RtcPeer[],
    iceServers: RtcIceServer[],
    kind: RtcKind
  ): Promise<void> {
    // 一旦真的进房间，就绝不该还有铃声在响（接听/加入/被拉进会议都会走到这里）
    stopRing()
    // 1. 初始化本地流（采集失败回退空轨，保证无摄像头/麦克风也能进入通话）
    let localStream: MediaStream
    if (kind === 'video') {
      let cam: MediaStream
      try {
        cam = await VideoStream.GetCameraStream()
      } catch {
        // 无可用摄像头 → 用占位空视频
        cam = VideoStream.GetEmptyVideoStream()
      }
      let mic: MediaStream
      try {
        mic = await VideoStream.GetAudioStream()
      } catch {
        // 无可用麦克风 → 用静音空音频
        mic = VideoStream.GetEmptyAudioStream()
      }
      localStream = new MediaStream([
        ...cam.getTracks(),
        ...mic.getTracks()
      ])
    } else {
      let mic: MediaStream
      try {
        mic = await VideoStream.GetAudioStream()
      } catch {
        // 无可用麦克风 → 用静音空音频
        mic = VideoStream.GetEmptyAudioStream()
      }
      const empty = VideoStream.GetEmptyVideoStream()
      localStream = new MediaStream([
        ...empty.getTracks(),
        ...mic.getTracks()
      ])
    }

    // 把本地流写入 VideoStream.stream，供 UI 绑定和后续 replaceTrack 使用
    VideoStream.stream = localStream

    // 2. 创建 RtcEngine
    engine = new RtcEngine({
      roomId: room.id,
      iceServers,
      localStream,
      onSignal: (signal) => {
        void rtcPantry.rtcSignal(room.id, signal)
      },
      onRemoteStream: (userId, stream) => {
        if (activeCall.value) {
          activeCall.value.remoteStreams[userId] = stream
        }
      },
      onPeerDisconnected: (userId) => {
        if (activeCall.value) {
          delete activeCall.value.remoteStreams[userId]
          activeCall.value.peers = activeCall.value.peers.filter((p) => p.userId !== userId)
        }
      }
    })

    // 3. 对已有 peers 逐个建立连接
    for (const peer of peers) {
      engine.addPeer(peer.userId)
    }

    // 4. 设置 activeCall state
    activeCall.value = {
      room,
      kind,
      peers: [...peers],
      remoteStreams: {},
      isMuted: false,
      isCameraOff: false,
      isScreenSharing: false,
      connectionState: peers.length > 0 ? 'connected' : 'connecting'
    }
  }

  async function _leaveRoom(): Promise<void> {
    engine?.closeAll()
    engine = null
    VideoStream.Destroy()
    activeCall.value = null
    incomingDm.value = null
    incomingGroup.value = null
    stopRing() // 挂断一定停铃（上面的 watch 已覆盖「清空来电」，这里是显式兜底）
  }

  return {
    activeCall,
    incomingDm,
    incomingGroup,
    error,
    wire,
    startDmCall,
    answerDm,
    rejectDm,
    startGroupCall,
    joinGroupCall,
    createMeeting,
    joinMeeting,
    leave,
    end,
    toggleMute,
    toggleCamera,
    toggleScreenShare,
    applyDevices,
    isRecording,
    toggleRecording
  }
})
