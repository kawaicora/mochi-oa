/**
 * rtc-debug.ts —— SFU 连接信息诊断日志（中文、成块格式化输出到 console）。
 *
 * 架构口径：会议通话、远程协助（控制端/被控端）、设备被控、设备预览，所有媒体
 * 均经自建 LiveKit SFU 中转，客户端之间不建立 P2P 直连；本端到 SFU 之间再按
 * ICE 候选类型区分 host（主机直连）/ srflx（公网反射）/ relay（TURN 中转）。
 *
 * 输出内容：
 *   - 链路类型（SFU 中转 / 非 P2P 直连）、SFU 地址、房间名、本端身份与昵称、令牌掩码
 *   - 发布 / 订阅两条 WebRTC 通道的 ICE 状态、本地与 SFU 候选类型、协议、IP:端口、
 *     RTT、上下行字节与包数
 *   - 房间内其他参与者的身份、昵称、已发布轨道；对端加入 / 离开 / 订阅轨道事件
 *
 * 所有读取均做 try/catch 兜底：诊断日志任何异常都不得影响正常音视频链路。
 */

import { RoomEvent, type Room, type RemoteParticipant, type TrackPublication } from 'livekit-client'
import type { RtcSfuInfo } from '@shared/server-types'

const TAG = '[SFU诊断]'

// ─── 纯格式化工具（可单测） ──────────────────────────────

/** 访问令牌掩码：仅保留前 10 位，绝不整串落日志 */
export function maskToken(token?: string): string {
  if (!token) return '（无）'
  if (token.length <= 10) return `${token.slice(0, 4)}…（已掩码）`
  return `${token.slice(0, 10)}…（已掩码，共 ${token.length} 字符）`
}

/** 字节数可读化 */
export function formatBytes(n?: number): string {
  if (n == null || Number.isNaN(n)) return '0 B'
  if (n < 1024) return `${Math.round(n)} B`
  const units = ['KB', 'MB', 'GB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return `${v.toFixed(1)} ${units[i]}`
}

/** ICE 候选类型中文说明 */
export function candidateTypeLabel(t?: string): string {
  switch (t) {
    case 'host': return '主机直连(host)'
    case 'srflx': return '公网反射(srflx)'
    case 'relay': return 'TURN 中转(relay)'
    default: return t ? `未知(${t})` : '未知'
  }
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// ─── WebRTC 统计读取（绕过 @internal 字段，结构化取值） ──

interface IceCandidateLike {
  address?: string
  port?: number
  candidateType?: string
  protocol?: string
}

interface CandidatePairLike {
  state?: string
  selected?: boolean
  localCandidateId?: string
  remoteCandidateId?: string
  bytesSent?: number
  bytesReceived?: number
  packetsSent?: number
  packetsReceived?: number
  currentRoundTripTime?: number
}

interface TransportLike {
  getStats(): Promise<RTCStatsReport | undefined>
  getConnectedAddress(): Promise<string | undefined>
  getICEConnectionState?: () => string
}

interface PcManagerLike {
  publisher?: TransportLike
  subscriber?: TransportLike
}

interface EngineLike {
  pcManager?: PcManagerLike
}

function candidateLine(role: string, c?: IceCandidateLike): string {
  if (!c || (!c.address && !c.port)) return `${role}：（候选尚未分配）`
  const type = candidateTypeLabel(c.candidateType)
  const proto = (c.protocol ?? '?').toUpperCase()
  return `${role}：${type}  ${proto}  ${c.address ?? '?'}:${c.port ?? '?'}`
}

/** 采样并打印单条 WebRTC 通道（publisher / subscriber）的连接统计 */
async function dumpTransport(label: string, t: TransportLike | undefined): Promise<void> {
  if (!t) {
    console.log(`${TAG} 【${label}】该通道不存在（本场景未建立）`)
    return
  }

  let address: string | undefined
  let report: RTCStatsReport | undefined
  try {
    address = await t.getConnectedAddress()
    report = await t.getStats()
  } catch (e) {
    console.warn(`${TAG} 【${label}】读取连接统计失败：${errMsg(e)}`)
    return
  }

  const iceState = typeof t.getICEConnectionState === 'function' ? t.getICEConnectionState() : undefined
  console.log(
    `${TAG} 【${label}】ICE 状态=${iceState ?? '未知'}  SFU 地址=${address ?? '统计暂不可用（ICE 未完成）'}`
  )
  if (!report) return

  const candidates = new Map<string, IceCandidateLike>()
  let pair: CandidatePairLike | undefined
  let selectedPairId = ''

  report.forEach((v) => {
    const s = v as unknown as Record<string, unknown>
    if (v.type === 'transport') {
      const id = s.selectedCandidatePairId
      if (typeof id === 'string') selectedPairId = id
    } else if (v.type === 'candidate-pair') {
      const p = s as unknown as CandidatePairLike
      if (!pair || p.selected === true || p.state === 'succeeded') pair = p
      if (selectedPairId && v.id === selectedPairId) pair = p
    } else if (v.type === 'local-candidate' || v.type === 'remote-candidate') {
      candidates.set(v.id, s as unknown as IceCandidateLike)
    }
  })

  if (!pair) {
    console.log(`${TAG} 【${label}】尚未选中 ICE 候选对（正在建连）`)
    return
  }

  const local = pair.localCandidateId ? candidates.get(pair.localCandidateId) : undefined
  const remote = pair.remoteCandidateId ? candidates.get(pair.remoteCandidateId) : undefined
  console.log(`${TAG}   ${candidateLine('本地候选', local)}`)
  console.log(`${TAG}   ${candidateLine('SFU 候选', remote)}`)

  const rtt = pair.currentRoundTripTime
  const rttText = typeof rtt === 'number' && Number.isFinite(rtt) ? `${(rtt * 1000).toFixed(0)} ms` : '未知'
  console.log(
    `${TAG}   链路质量：状态=${pair.state ?? '未知'}  RTT=${rttText}  ` +
    `上行=${formatBytes(pair.bytesSent)} / ${pair.packetsSent ?? 0} 包  ` +
    `下行=${formatBytes(pair.bytesReceived)} / ${pair.packetsReceived ?? 0} 包`
  )
}

// ─── 参与者信息格式化 ────────────────────────────────────

function peerLine(p: RemoteParticipant | { identity: string; name?: string; trackPublications: Map<string, TrackPublication> }): string {
  const tracks = [...p.trackPublications.values()]
    .map((pub) => `${pub.trackName}(${pub.kind})`)
    .join(', ') || '无轨道'
  const nick = p.name ? ` 昵称=${p.name}` : ''
  return `identity=${p.identity}${nick} 轨道=[${tracks}]`
}

// ─── 挂接诊断钩子（connectSfu 连接成功后调用一次） ─────────

/**
 * 为已连接的 Room 挂接 SFU 诊断日志。
 * @param room  已 connect 成功的 Room
 * @param sfu   服务端签发的 SFU 连接信息
 * @param label 场景中文标签，如「会议通话」「远程协助-控制端」
 */
export function attachSfuDiagnostics(room: Room, sfu: RtcSfuInfo, label: string): void {
  const me = room.localParticipant

  console.log(`${TAG} ==================== ${label} · SFU 连接信息 ====================`)
  console.log(`${TAG} 链路类型：SFU 中转（LiveKit），媒体经服务器转发，客户端之间不建立 P2P 直连`)
  console.log(`${TAG} SFU 地址：${sfu.url || '（未提供）'}`)
  console.log(`${TAG} 房间名  ：${sfu.roomName || '（未提供）'}`)
  console.log(`${TAG} 本端身份：${me.identity}${me.name ? `（昵称=${me.name}）` : ''}`)
  console.log(`${TAG} 访问令牌：${maskToken(sfu.token)}`)

  const printPeers = (prefix: string): void => {
    const peers = [...room.remoteParticipants.values()]
    if (peers.length === 0) {
      console.log(`${TAG} ${prefix}当前房间内暂无其他参与者`)
      return
    }
    console.log(`${TAG} ${prefix}其他参与者（${peers.length}）：`)
    for (const p of peers) console.log(`${TAG}   · ${peerLine(p)}`)
  }
  printPeers('')

  // 后续加入 / 离开 / 订阅轨道的对端事件
  room.on(RoomEvent.ParticipantConnected, (p) => {
    console.log(`${TAG} 对端加入：${peerLine(p)}`)
  })
  room.on(RoomEvent.ParticipantDisconnected, (p) => {
    console.log(`${TAG} 对端离开：identity=${p.identity}${p.name ? ` 昵称=${p.name}` : ''}`)
  })
  room.on(RoomEvent.TrackSubscribed, (track, pub, p) => {
    const kind = track.mediaStreamTrack?.kind ?? track.kind
    console.log(`${TAG} 订阅到对端轨道：identity=${p.identity} 名称=${pub?.trackName ?? '(未命名)'} kind=${kind}`)
  })

  // ICE 候选对需要在建连完成后才稳定，延迟 2s 采样一次通道统计
  const engine = room as unknown as { engine?: EngineLike }
  const manager = engine.engine?.pcManager
  const sample = async (): Promise<void> => {
    if (!manager) {
      console.log(`${TAG} 通道统计：引擎尚未建立 PeerConnection`)
      return
    }
    await dumpTransport('发布通道 publisher', manager.publisher)
    await dumpTransport('订阅通道 subscriber', manager.subscriber)
  }
  const timer = window.setTimeout(() => { void sample() }, 2000)

  room.on(RoomEvent.Reconnected, () => {
    console.log(`${TAG} LiveKit 已重连，重新采样通道统计…`)
    window.setTimeout(() => { void sample() }, 1500)
  })
  room.on(RoomEvent.Disconnected, () => {
    window.clearTimeout(timer)
  })
}
