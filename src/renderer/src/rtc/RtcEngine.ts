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
 *
 * 日志：全部直接走 console，统一前缀 [RTC][user=7]。
 *       在 DevTools 里过滤 "RTC" 就能看到完整建连流程；
 *       级别用 console.log / warn / error，DevTools 原生按级别过滤。
 */

import type { RtcIceServer, RtcSignalPayload } from '@shared/server-types'

// ═══════════════════════════════════════════════════════════
// 日志：直接走 console，DevTools 自带级别过滤 / 搜索
// ═══════════════════════════════════════════════════════════

/** 普通流程日志 */
function log(tag: string, msg: string, data?: unknown): void {
  console.log(`[RTC]${tag ? '[' + tag + ']' : ''} ${msg}`, ...(data !== undefined ? [data] : []))
}
/** 可恢复的问题（跳过 / 忽略 / 回退） */
function logw(tag: string, msg: string, data?: unknown): void {
  console.warn(`[RTC]${tag ? '[' + tag + ']' : ''} ${msg}`, ...(data !== undefined ? [data] : []))
}
/** 致命错误（连不上就是这么来的） */
function loge(tag: string, msg: string, data?: unknown): void {
  console.error(`[RTC]${tag ? '[' + tag + ']' : ''} ${msg}`, ...(data !== undefined ? [data] : []))
}

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

/**
 * 解析 ICE candidate，返回结构化信息用于日志。
 * candidate 格式：candidate:<foundation> <component> <transport> <priority> <address> <port> typ <type> ...
 * 注意 parts[0] 是 "candidate:xxxx"，所以 address 在 parts[4]、port 在 parts[5]。
 */
function parseCandidate(candidate: string): {
  address: string
  port: string
  transport: string
  type: string
  raddr: string
  rport: string
} {
  const parts = (candidate || '').split(' ')
  const g = (re: RegExp): string => (candidate || '').match(re)?.[1] ?? ''
  return {
    address: parts[4] ?? '',
    port: parts[5] ?? '',
    transport: parts[2] ?? '',
    type: g(/typ\s+(\w+)/),
    raddr: g(/raddr\s+([\w.:-]+)/),
    rport: g(/rport\s+(\d+)/)
  }
}

/** 一行摘要：host/srflx/prflx/relay + 地址:端口（relay 附中转服务器地址） */
function describeCandidate(candidate: string): string {
  const c = parseCandidate(candidate)
  const base = `${c.type} ${c.address}:${c.port}${c.transport ? '/' + c.transport : ''}`
  if (c.type === 'relay') return `${base}（经中转服务器 ${c.raddr || '?'}:${c.rport || '?'}）`
  if (c.type === 'srflx' || c.type === 'prflx') return `${base}（NAT 映射）`
  return base
}

/** SDP 摘要：媒体行 + 编解码 + ice-ufrag，一眼看出协商了什么 */
function describeSdp(sdp: string): string {
  const lines = (sdp || '').split(/\r?\n/)
  const media: string[] = []
  const codecs: string[] = []
  let ufrag = ''
  let setup = ''
  for (const l of lines) {
    if (l.startsWith('m=')) media.push(l.slice(2))
    else if (l.startsWith('a=rtpmap:')) codecs.push(l.replace('a=rtpmap:', ''))
    else if (l.startsWith('a=ice-ufrag:')) ufrag = l.slice('a=ice-ufrag:'.length)
    else if (l.startsWith('a=setup:')) setup = l.slice('a=setup:'.length)
  }
  const uniq = Array.from(new Set(codecs.map((c) => c.split(' ')[1] ?? c))).slice(0, 10)
  return `m=[${media.join(' | ')}] 编解码=[${uniq.join(', ')}] ufrag=${ufrag || '?'} setup=${setup || '?'}`
}

/** 统计 SDP 里的 candidate 数量（判断是否真的采集到了候选） */
function countCandidates(sdp: string): number {
  return ((sdp || '').match(/^a=candidate:/gm) ?? []).length
}

/** MediaStream 摘要 */
function describeStream(stream: MediaStream | null | undefined): string {
  if (!stream) return '(null)'
  const ids = stream.getTracks().map((t) => `${t.kind}:${t.readyState}`).join(',')
  return `tracks=${stream.getTracks().length}(video=${stream.getVideoTracks().length},audio=${stream.getAudioTracks().length}) [${ids}]`
}

/**
 * 视频 Sender 参数：带宽不足时优先保分辨率（降帧率而不是降清晰度）。
 * 失败只记日志，绝不影响建连。
 */
async function configureVideoSender(sender: RTCRtpSender, tag: string): Promise<void> {
  try {
    const params = sender.getParameters()
    if (!params.encodings) params.encodings = [{}]
    params.degradationPreference = 'maintain-resolution'
    await sender.setParameters(params)
    log(tag, '视频 sender 参数已锁定 maintain-resolution（带宽不足时降帧率保清晰）')
  } catch (e) {
    logw(tag, '设置视频 sender 参数失败（不影响建连）', e)
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

  /** 每个 peer 的诊断快照：候选、建连时间、最后一条信令 */
  private peerDiag = new Map<number, {
    localCands: { type: string; addr: string }[]
    remoteCands: { type: string; addr: string }[]
    created: number
    lastSignal?: string
  }>()

  constructor(opts: RtcEngineOptions) {
    this.roomId = opts.roomId
    this.iceServers = toIceServers(opts.iceServers)
    this.localStream = opts.localStream
    this.onSignal = opts.onSignal
    this.onRemoteStream = opts.onRemoteStream
    this.onPeerDisconnected = opts.onPeerDisconnected
    this.onPeerConnected = opts.onPeerConnected

    const R = 'room=' + this.roomId
    log(R, '════════ RtcEngine 初始化 ════════')
    log(R, `本地流 ${describeStream(this.localStream)}`)
    if (this.localStream.getTracks().length === 0) {
      loge(R, '本地流没有任何轨道！对方只会看到黑屏/无声')
    }
    if (this.iceServers.length === 0) {
      loge(R, 'ICE 服务器列表为空！只能靠 host 候选直连，跨 NAT 必然连不上')
    }
    this.iceServers.forEach((s, i) => {
      const urls = Array.isArray(s.urls) ? s.urls.join(', ') : String(s.urls)
      log(R, `ICE[${i}] urls=${urls} 需鉴权=${!!(s.username && s.credential)}`)
    })
    const allUrls = this.iceServers
      .map((s) => (Array.isArray(s.urls) ? s.urls.join(',') : String(s.urls)))
      .join(',')
    const hasStun = /stun:/i.test(allUrls)
    const hasTurn = /turns?:/i.test(allUrls)
    log(R, `ICE 类型：STUN=${hasStun} TURN=${hasTurn}${hasTurn ? '' : '（无 TURN：双方都是对称 NAT 时会连不上）'}`)
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

  private tag(userId: number): string {
    return `user=${userId}`
  }

  private diag(userId: number): {
    localCands: { type: string; addr: string }[]
    remoteCands: { type: string; addr: string }[]
    created: number
    lastSignal?: string
  } {
    let d = this.peerDiag.get(userId)
    if (!d) {
      d = { localCands: [], remoteCands: [], created: Date.now() }
      this.peerDiag.set(userId, d)
    }
    return d
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
        logw(this.tag(userId), `旧 PC 停在 ${ex.signalingState}（接不了新 offer）→ 关闭重来`)
        ex.close()
        this.peers.delete(userId)
      } else {
        log(this.tag(userId), '已有 stable 连接 → 跳过（绝不发第二个 offer）')
        return
      }
    }
    const pc = this.createPc(userId, 'offer')
    void this.sendOffer(pc, userId)
  }

  /** 建 PC + 加本地轨道 + 挂事件（不负责协商方向） */
  private createPc(userId: number, tag: string): RTCPeerConnection {
    const t = this.tag(userId)
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    this.peers.set(userId, pc)
    this.peerDiag.set(userId, { localCands: [], remoteCands: [], created: Date.now() })

    const tracks = this.localStream.getTracks()
    log(t, `新建 PC（角色=${tag}）ice=${this.describeIce()} 本地流 ${describeStream(this.localStream)}`)
    if (tracks.length === 0) {
      loge(t, '本地流没有任何轨道！对方只会看到黑屏/无声')
    }
    tracks.forEach((track) => {
      const sender = pc.addTrack(track, this.localStream)
      log(t, `addTrack kind=${track.kind} id=${track.id} enabled=${track.enabled} state=${track.readyState}`)
      if (track.kind === 'video') {
        void configureVideoSender(sender, t)
      }
    })
    log(t, `addTrack 完成 senders=${pc.getSenders().length}`)
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
    const t = this.tag(fromUserId)
    const hasPc = this.peers.has(fromUserId)
    const sigState = this.peers.get(fromUserId)?.signalingState ?? '(无PC)'

    if (signal.type === 'ice') {
      log(t, `收到信令 ice ${describeCandidate(signal.candidate)} hasPc=${hasPc} sig=${sigState}`)
    } else {
      log(t, `收到信令 ${signal.type} sdpLen=${signal.sdp?.length ?? 0} hasPc=${hasPc} sig=${sigState}`)
      log(t, `${signal.type} SDP 概要：${describeSdp(signal.sdp ?? '')}`)
    }
    this.diag(fromUserId).lastSignal = `${signal.type}@${new Date().toLocaleTimeString()}`

    let pc = this.peers.get(fromUserId)
    if (!pc && signal.type === 'offer') {
      // 后进房间的人走这条：来一个 offer 就为这个 userId 建一个独立 PC
      log(t, '本端尚无该对端 PC → 作为【应答方】新建 PC（被叫路径）')
      pc = this.createPc(fromUserId, 'answer')
    }
    if (!pc) {
      // answer / ice 比 offer 先到（后进房间的人偶发）→ 缓存 ICE，其余丢弃
      if (signal.type === 'ice') {
        this.pendingIce(fromUserId).push(this.toIceInit(signal))
        logw(t, `尚无 PC，ICE 先缓存（缓存数=${this.pendingIce(fromUserId).length}），等 PC 建好补加`)
      } else {
        logw(t, `尚无 PC 却收到 ${signal.type} → 丢弃（对不上任何连接）`)
      }
      return
    }

    if (signal.type === 'offer') void this.applyOffer(pc, fromUserId, signal.sdp)
    else if (signal.type === 'answer') void this.applyAnswer(pc, fromUserId, signal.sdp)
    else if (signal.type === 'ice') void this.applyIce(pc, fromUserId, signal)
  }

  // ─── 关闭 ─────────────────────────────────────────────

  closePeer(userId: number, reason = '主动关闭'): void {
    const pc = this.peers.get(userId)
    if (pc) {
      log(this.tag(userId), `关闭 PC（${reason}）此前 conn=${pc.connectionState} ice=${pc.iceConnectionState} sig=${pc.signalingState}`)
      pc.close()
      this.peers.delete(userId)
    }
  }

  closeAll(): void {
    log('room=' + this.roomId, `closeAll：关闭全部 ${this.peers.size} 个 PC`)
    this.peers.forEach((_pc, userId) => this.logPeerSummary(userId))
    this.peers.forEach((pc) => pc.close())
    this.peers.clear()
    this.peerDiag.clear()
  }

  /** 是否已有该对端的 PC（上层判断"要不要发起/重建"用） */
  hasPeer(userId: number): boolean {
    return this.peers.has(userId)
  }

  /** 当前所有 peer 的状态快照（排查用；DevTools 里可 window.__RTC_PEERS__() 或直接读日志） */
  dumpPeers(): string {
    if (this.peers.size === 0) return '(无 peer)'
    const lines: string[] = []
    this.peers.forEach((pc, userId) => {
      lines.push(
        `user=${userId} conn=${pc.connectionState} ice=${pc.iceConnectionState} gather=${pc.iceGatheringState} sig=${pc.signalingState} senders=${pc.getSenders().length} receivers=${pc.getReceivers().length}`
      )
    })
    return lines.join('\n')
  }

  // ─── 轨道替换（对齐网页版 replaceTrack）───────────────

  /**
   * 遍历所有 PC 的 senders 替换指定 kind 的轨道；track 传 null 表示关闭该轨道。
   * kind 不变时 SDP 无需改动，因此【不重新协商】——
   * 否则双方一换设备就同时进 have-local-offer，这正是 glare 的来源。
   */
  replaceTrack(track: MediaStreamTrack | null, kind: 'audio' | 'video'): void {
    log('room=' + this.roomId,
      `replaceTrack kind=${kind} track=${track ? `${track.id}(${track.readyState})` : 'null（关闭该轨道）'} 作用于 ${this.peers.size} 个 PC（不重新协商）`)
    this.peers.forEach((pc, userId) => {
      const t = this.tag(userId)
      let replaced = 0
      let matched = 0
      for (const sender of pc.getSenders()) {
        if (sender.track?.kind === kind) {
          matched++
          replaced++
          void sender.replaceTrack(track)
            .then(() => log(t, `replaceTrack kind=${kind} 成功`))
            .catch((e) => loge(t, `replaceTrack kind=${kind} 失败：${e instanceof Error ? e.message : String(e)}`, e))
        }
      }
      if (matched === 0) {
        logw(t, `该 PC 上没有 kind=${kind} 的 sender → 换轨无效（现有 senders=${pc.getSenders().map((s) => s.track?.kind ?? 'null').join(',') || '空'}）`)
      } else {
        log(t, `replaceTrack kind=${kind} 已提交 replaced=${replaced} sig=${pc.signalingState}`)
      }
    })
  }

  // ─── 内部：绑定 peer 事件（对齐网页版 _bind）───────────

  private bindPeerEvents(pc: RTCPeerConnection, userId: number): void {
    const t = this.tag(userId)

    pc.ontrack = (event) => {
      log(t, `★ ontrack 收到远端轨道 kind=${event.track.kind} id=${event.track.id} state=${event.track.readyState} streams=${event.streams.length}`)
      // event.streams[0] 绑定远程流；无 streams 时忽略
      if (event.streams.length === 0) {
        logw(t, 'ontrack 事件不含 streams（无法绑定到 video 元素）→ 忽略')
        return
      }
      const stream = event.streams[0]
      log(t, `远端流 ${describeStream(stream)}`)
      try {
        log(t, `轨道参数 ${JSON.stringify(event.track.getSettings())}`)
      } catch { /* getSettings 个别环境不支持，忽略 */ }
      this.onRemoteStream(userId, stream)
    }

    pc.onicecandidate = (event) => {
      const c = event.candidate
      if (c) {
        const parsed = parseCandidate(c.candidate)
        this.diag(userId).localCands.push({ type: parsed.type, addr: `${parsed.address}:${parsed.port}` })
        log(t, `本端候选 → ${describeCandidate(c.candidate)}`)
        this.onSignal({
          type: 'ice',
          candidate: c.candidate,
          sdpMid: c.sdpMid,
          sdpMLineIndex: c.sdpMLineIndex
        })
      } else {
        log(t, `本端候选采集结束（end-of-candidates）gather=${pc.iceGatheringState}`)
      }
    }

    // STUN/TURN 故障就藏在这里 —— 连不上时这条几乎必看
    pc.onicecandidateerror = (event) => {
      const e = event as RTCPeerConnectionIceErrorEvent
      const why =
        e.errorCode === 701 ? 'STUN/TURN 服务器连不上（检查地址/端口/防火墙）'
        : e.errorCode === 401 ? 'TURN 鉴权失败（用户名或密码错）'
        : e.errorCode === 403 ? 'TURN 拒绝（配额或权限不足）'
        : e.errorCode === 300 ? 'TURN 重定向'
        : '见 errorText'
      loge(t, `ICE 候选采集错误 code=${e.errorCode} text=${e.errorText} url=${e.url || '(未知)'} address=${e.address || '?'}:${e.port || '?'} —— ${why}`)
    }

    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState
      const extra =
        s === 'failed' ? '（ICE 失败：候选对打不通，通常是 NAT/防火墙/缺 TURN）'
        : s === 'disconnected' ? '（暂时中断，可能在自愈）'
        : s === 'checking' ? '（正在试探候选对）'
        : ''
      if (s === 'failed') loge(t, `ICE 连接状态 → ${s}${extra}`)
      else if (s === 'disconnected') logw(t, `ICE 连接状态 → ${s}${extra}`)
      else log(t, `ICE 连接状态 → ${s}${extra}`)
      if (s === 'failed') void this.logPeerInfo(userId, pc)
    }

    pc.onicegatheringstatechange = () => {
      log(t, `ICE 采集状态 → ${pc.iceGatheringState}`)
    }

    pc.onsignalingstatechange = () => {
      log(t, `信令状态 → ${pc.signalingState}`)
    }

    pc.onnegotiationneeded = () => {
      log(t, `negotiationneeded（本端想重新协商；本引擎不自动发 offer）sig=${pc.signalingState}`)
    }

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState
      if (state === 'connected') {
        log(t, `★★ 连接已建立（connected）ice=${pc.iceConnectionState} sig=${pc.signalingState}`)
        // 连接建立 → 读取选中的候选对，报告直连 or 中转；并通知上层「这次成功了」
        void this.logPeerInfo(userId, pc)
        this.onPeerConnected?.(userId)
        return
      }
      if (state === 'connecting') {
        log(t, `连接状态 → connecting ice=${pc.iceConnectionState}`)
        return
      }
      if (state === 'disconnected') logw(t, '连接状态 → disconnected（媒体可能已中断，等待自愈或重连）')
      else if (state === 'failed') loge(t, '连接状态 → failed（建连失败：见上面 ICE 日志与下方诊断）')
      else if (state === 'closed') log(t, '连接状态 → closed')

      // 对齐网页版：disconnected / failed / closed 一律清理并通知上层，不自己造秒数、不自己重连。
      // 唯一的加固：只有「当前登记的还是这个 PC」才处理 ——
      // 老 PC 被主动关掉后它的异步事件不能误伤刚建好的新 PC。
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        if (this.peers.get(userId) !== pc) {
          log(t, '该 PC 已不是当前登记的连接（已被替换）→ 不触发掉线回调')
          return
        }
        void this.logPeerInfo(userId, pc)
        this.logPeerSummary(userId)
        this.closePeer(userId, `连接状态=${state}`)
        this.onPeerDisconnected(userId)
      }
    }
  }

  /** 一条完整的对端诊断：候选类型/地址、失败原因 */
  private logPeerSummary(userId: number): void {
    const d = this.peerDiag.get(userId)
    if (!d) return
    const t = this.tag(userId)
    const l = d.localCands.map((c) => `${c.type}(${c.addr})`)
    const r = d.remoteCands.map((c) => `${c.type}(${c.addr})`)
    log(t, `── 对端诊断 ── 本端候选=[${l.join(', ') || '无'}] 远端候选=[${r.join(', ') || '无'}]`)
    if (d.localCands.length === 0) {
      loge(t, '本端一个 ICE 候选都没采集到！检查网卡/防火墙/ICE 服务器配置')
    }
    if (d.remoteCands.length === 0) {
      loge(t, '没收到对端任何 ICE 候选！信令可能没送达（检查房间/服务端转发）')
    }
    log(t, `首个 PC 建于 ${new Date(d.created).toLocaleTimeString()}，最后一次信令=${d.lastSignal ?? '无'}，存活=${Date.now() - d.created}ms`)
  }

  /**
   * 用 getStats 找出成功候选对，判定【直连(P2P) / 中转(relay)】并打印双方 IP。
   * 「到底走直连还是中转、对方 IP 是多少、TURN 地址是多少」全在这里。
   */
  private async logPeerInfo(userId: number, pc: RTCPeerConnection): Promise<void> {
    const t = this.tag(userId)
    try {
      const stats = await pc.getStats()
      const cands = new Map<string, {
        candidateType?: string; address?: string; port?: number
        protocol?: string; relayProtocol?: string; url?: string
      }>()
      const pairs: {
        id: string
        localCandidateId: string
        remoteCandidateId: string
        state: string
        nominated?: boolean
        bytesSent?: number
        bytesReceived?: number
        currentRoundTripTime?: number
      }[] = []
      // 用数组收集 transport 信息：TS 不追踪回调里的赋值，
      // 若用 `let x = null` 会被收窄成 never；push 进数组则不受影响。
      const transportLines: string[] = []

      stats.forEach((s) => {
        const r = s as unknown as Record<string, unknown>
        if (r.type === 'candidate') {
          const c = {
            candidateType: String(r.candidateType ?? ''),
            address: String(r.address ?? ''),
            port: Number(r.port ?? 0),
            protocol: r.protocol ? String(r.protocol) : undefined,
            relayProtocol: r.relayProtocol ? String(r.relayProtocol) : undefined,
            url: r.url ? String(r.url) : undefined
          }
          cands.set(s.id, c)
          // 累积到诊断（用于「没收到候选」判断）
          const d = this.diag(userId)
          const addr = `${c.address}:${c.port}`
          if (!d.remoteCands.some((x) => x.addr === addr)) {
            d.remoteCands.push({ type: c.candidateType ?? '?', addr })
          }
        } else if (r.type === 'candidate-pair') {
          pairs.push({
            id: s.id,
            localCandidateId: String(r.localCandidateId ?? ''),
            remoteCandidateId: String(r.remoteCandidateId ?? ''),
            state: String(r.state ?? ''),
            nominated: r.nominated === true,
            bytesSent: Number(r.bytesSent ?? 0),
            bytesReceived: Number(r.bytesReceived ?? 0),
            currentRoundTripTime: r.currentRoundTripTime !== undefined ? Number(r.currentRoundTripTime) : undefined
          })
        } else if (r.type === 'transport') {
          transportLines.push(
            `DTLS=${r.dtlsState ? String(r.dtlsState) : '?'} ICE角色=${r.iceRole ? String(r.iceRole) : '?'}`
          )
        }
      })

      transportLines.forEach((line) => log(t, line))

      const succeeded = pairs.filter((p) => p.state === 'succeeded')
      const pair =
        pairs.find((p) => p.state === 'succeeded' && p.nominated) ??
        succeeded.find((p) => (p.bytesSent ?? 0) > 0 || (p.bytesReceived ?? 0) > 0) ??
        succeeded[0]

      if (!pair) {
        logw(t, `尚未选出可用候选对（共 ${pairs.length} 对，succeeded=${succeeded.length}）——连接可能仍在协商或已失败`)
        pairs.forEach((p) => log(t, `  候选对 state=${p.state} nominated=${!!p.nominated}`))
        return
      }

      const lc = cands.get(pair.localCandidateId)
      const rc = cands.get(pair.remoteCandidateId)
      const fmt = (c?: { candidateType?: string; address?: string; port?: number; protocol?: string }): string =>
        c && c.address ? `${c.candidateType} ${c.address}:${c.port}${c.protocol ? '/' + c.protocol : ''}` : '(未知)'

      const viaRelay = lc?.candidateType === 'relay' || rc?.candidateType === 'relay'
      const rtt = pair.currentRoundTripTime !== undefined ? `${(pair.currentRoundTripTime * 1000).toFixed(0)}ms` : '?'

      log(t, '════════ 连接方式 ════════')
      log(t, `方式=${viaRelay ? '中转(relay/TURN)' : '直连(P2P)'}  RTT=${rtt}  已发送=${pair.bytesSent ?? 0}B 已接收=${pair.bytesReceived ?? 0}B`)
      log(t, `本端地址=${fmt(lc)}`)
      log(t, `远端地址=${fmt(rc)}`)
      if (viaRelay) {
        log(t, `★ 对端经中转（未打洞成功）`)
      } else if (rc?.address) {
        log(t, `★ 直连：对方 IP=${rc.address} 端口=${rc.port}`)
      }
      if (lc?.candidateType === 'relay') {
        log(t, `★ 中转服务器(TURN)地址 = ${lc.address}:${lc.port}${lc.relayProtocol ? ` (${lc.relayProtocol})` : ''}${lc.url ? ` url=${lc.url}` : ''}`)
      }
      if (rc?.candidateType === 'relay') {
        logw(t, '对端侧也是 relay（全程走 TURN，未打洞成功）')
      }

      // 候选对全貌：判断「为什么没走直连」用
      log(t, `候选对明细（共 ${pairs.length}）：`)
      pairs.forEach((p, i) => {
        const a = cands.get(p.localCandidateId)
        const b = cands.get(p.remoteCandidateId)
        log(t, `  [${i}] ${p.state}${p.nominated ? ' nominated' : ''} 本端=${fmt(a)} ↔ 远端=${fmt(b)}`)
      })
    } catch (err) {
      loge(t, `getStats 失败：${err instanceof Error ? err.message : String(err)}`, err)
    }
  }

  // ─── 内部：offer / answer / ice 流程（对齐网页版）─────

  /** createOffer → setLocalDescription → onSignal（先到的人给新人发起） */
  private async sendOffer(pc: RTCPeerConnection, userId: number): Promise<void> {
    const t = this.tag(userId)
    try {
      log(t, 'createOffer 开始…')
      const offer = await pc.createOffer()
      offer.sdp = EnforceStereo(offer.sdp ?? '')
      log(t, `offer SDP 概要：${describeSdp(offer.sdp ?? '')}`)
      await pc.setLocalDescription(offer)
      log(t, `★ 发送 offer sdpLen=${offer.sdp?.length ?? 0} sig=${pc.signalingState} SDP内候选数=${countCandidates(offer.sdp ?? '')}`)
      this.onSignal({ type: 'offer', sdp: offer.sdp ?? '' })
    } catch (err) {
      loge(t, `createOffer/setLocalDescription 失败：${err instanceof Error ? err.message : String(err)}`, err)
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
    log(this.tag(userId), `补加先前缓存的 ICE 候选，共 ${arr.length} 条`)
    for (const c of arr) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(c))
      } catch (err) {
        logw(this.tag(userId), `补加候选失败：${err instanceof Error ? err.message : String(err)}`)
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
    const t = this.tag(userId)
    const sig = pc.signalingState
    log(t, `处理 offer 开始 sig=${sig} sdpLen=${sdp.length} SDP内候选数=${countCandidates(sdp)}`)
    log(t, `offer SDP 概要：${describeSdp(sdp)}`)

    // ① stable：本端协商已完成 → 这个 offer 多余，跳过（连接保持好的）
    if (sig === 'stable') {
      logw(t, '跳过：本端已 stable（该 offer 重复/迟到，应答反而会破坏现有连接）')
      return
    }
    // ② closed：PC 已关闭
    if (sig === 'closed') {
      logw(t, '跳过：PC 已关闭（等上层重建）')
      return
    }

    try {
      // ③ 双方同时发 offer：rollback 本端的 offer，改应答对方
      if (sig === 'have-local-offer') {
        logw(t, '检测到双方同时发起（glare）→ rollback 本端 offer，改为应答对方')
        await pc.setRemoteDescription({ type: 'rollback' })
        log(t, `rollback 完成 sig=${pc.signalingState}`)
      }
      // ④ 上一个 remote offer 还没答完：先回滚
      if (pc.signalingState === 'have-remote-offer') {
        log(t, '上一个远端 offer 未答完 → 先 rollback')
        try {
          await pc.setRemoteDescription({ type: 'rollback' })
          log(t, `rollback 完成 sig=${pc.signalingState}`)
        } catch (e) {
          logw(t, `rollback 失败（状态已变，继续尝试）：${e instanceof Error ? e.message : String(e)}`)
        }
      }
      // 走到这里 signalingState 必为 stable（上面已经把 have-local-offer 与
      // have-remote-offer 都 rollback 掉了），可以直接 setRemoteDescription(offer)。
      // 注意：signalingState 是实时 getter，await 之后不能靠此前的窄化判断，
      // 每次都要重新读，否则会把「已经变成 have-remote-offer」误判成 stable。
      await pc.setRemoteDescription({ type: 'offer', sdp })
      log(t, `setRemoteDescription(offer) 成功 sig=${pc.signalingState}`)
      await this.flushIce(userId, pc)
      const answer = await pc.createAnswer()
      answer.sdp = EnforceStereo(answer.sdp ?? '')
      log(t, `answer SDP 概要：${describeSdp(answer.sdp ?? '')}`)
      await pc.setLocalDescription(answer)
      log(t, `★ 发送 answer sdpLen=${answer.sdp?.length ?? 0} sig=${pc.signalingState} SDP内候选数=${countCandidates(answer.sdp ?? '')}`)
      this.onSignal({ type: 'answer', sdp: answer.sdp ?? '' })
    } catch (err) {
      loge(t, `处理 offer 失败（本轮不应答，连接状态未破坏）：${err instanceof Error ? err.message : String(err)}`, err)
    }
  }

  /** 收到 answer（对齐网页版 _handleAnswer）：只有本端等着对方回 answer 时才收 */
  private async applyAnswer(pc: RTCPeerConnection, userId: number, sdp: string): Promise<void> {
    const t = this.tag(userId)
    const sig = pc.signalingState
    log(t, `处理 answer 开始 sig=${sig} sdpLen=${sdp.length} SDP内候选数=${countCandidates(sdp)}`)
    // 只有 have-local-offer 时才是「本端等着对方回 answer」：
    //  - stable → 这个 answer 对应的是本端已作废的 offer（双方同时发 offer 后本端那个被丢了/
    //    已被别的 answer 答完）。此时绝不能硬 set —— 会抛 wrong state: stable，
    //    更糟的是把当前正常的连接毁掉。答案很简单：忽略，本端手里的连接是好的。
    if (sig !== 'have-local-offer') {
      logw(t, `忽略 answer：本端不处于 have-local-offer（当前 ${sig}），该 answer 对应的 offer 已作废`)
      return
    }
    try {
      await pc.setRemoteDescription({ type: 'answer', sdp })
      log(t, `setRemoteDescription(answer) 成功 sig=${pc.signalingState}`)
      await this.flushIce(userId, pc)
    } catch (err) {
      // 真的失败了（比如 SDP 角色冲突）→ 这个连接救不回来，丢掉它让上层重连，
      // 但只动这一个 peer，绝不波及其它人。
      loge(t, `应用 answer 失败，重建该连接：${err instanceof Error ? err.message : String(err)}`, err)
      if (this.peers.get(userId) === pc) {
        this.logPeerSummary(userId)
        this.closePeer(userId, 'answer应用失败')
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
    const t = this.tag(userId)
    // 这个 candidate 属于被换掉的旧连接（对端已重建）→ 直接丢，不要塞进新 PC。
    // 老 candidate 配新 ufrag 一定会被 addIceCandidate 拒绝，还会刷一堆报错。
    if (this.peers.get(userId) !== pc) {
      logw(t, `丢弃远端候选（属于已被替换的旧连接）：${describeCandidate(signal.candidate)}`)
      return
    }
    const parsed = parseCandidate(signal.candidate)
    this.diag(userId).remoteCands.push({ type: parsed.type, addr: `${parsed.address}:${parsed.port}` })

    if (!pc.remoteDescription) {
      this.pendingIce(userId).push(this.toIceInit(signal))
      log(t, `远端描述尚未 set，先缓存候选 ${describeCandidate(signal.candidate)}（缓存数=${this.pendingIce(userId).length}）`)
      return
    }
    try {
      await pc.addIceCandidate(new RTCIceCandidate(this.toIceInit(signal)))
      log(t, `加入远端候选成功 ${describeCandidate(signal.candidate)} sig=${pc.signalingState}`)
    } catch (err) {
      logw(t, `加入远端候选失败（通常是旧连接残留）：${describeCandidate(signal.candidate)} —— ${err instanceof Error ? err.message : String(err)}`)
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
    if (this.recording) {
      logw('record', '已在录制中，忽略重复开始')
      return
    }
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
    log('record', `开始录制，待合成轨道数=${tracks.length}（本地 ${this.localStream.getTracks().length} + 远端 ${tracks.length - this.localStream.getTracks().length}）`)
    if (tracks.length === 0) {
      loge('record', '没有任何可用轨道 → 录制无法开始')
      return
    }

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
    } catch (e) {
      logw('record', `首选 MIME 失败（${mime || '默认'}），回退默认：${e instanceof Error ? e.message : String(e)}`)
      try {
        rec = new MediaRecorder(mixed)
      } catch (e2) {
        loge('record', `创建 MediaRecorder 失败：${e2 instanceof Error ? e2.message : String(e2)}`)
        rec = null
      }
    }
    if (!rec) return

    rec.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) this.recordChunks.push(e.data)
    }
    rec.onerror = (e) => {
      loge('record', `录制出错：${(e as unknown as { error?: Error })?.error?.message ?? '未知错误'}`)
      this.recording = false
      this.recorder = null
    }
    rec.start(1000) // 每秒一个 chunk，降低内存峰值
    this.recorder = rec
    // 记录本次录制的真实内容类型：stopRecording 时用它决定 MIME/后缀，
    // 不能靠 recordChunks 长度猜（那和有没有视频毫无关系）。
    this.recordHasVideo = hasVideo
    this.recording = true
    log('record', `录制已启动 mime=${rec.mimeType} 含视频=${hasVideo}`)
  }

  /** 停止录制，返回 {blob, kind}；未在录制返回 null */
  stopRecording(): Promise<{ blob: Blob; kind: 'video' | 'audio' } | null> {
    return new Promise((resolve) => {
      const rec = this.recorder
      if (!rec || !this.recording) {
        logw('record', '未在录制中，stopRecording 无操作')
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
        log('record', `录制结束 分片=${chunks.length} 大小=${blob.size}B 类型=${hasVideo ? 'video' : 'audio'}`)
        resolve(blob.size > 0 ? { blob, kind: hasVideo ? 'video' : 'audio' } : null)
      }
      rec.onstop = finish
      try {
        rec.stop()
      } catch (e) {
        logw('record', `rec.stop() 抛错，直接收尾：${e instanceof Error ? e.message : String(e)}`)
        finish()
      }
    })
  }
}

export default RtcEngine
