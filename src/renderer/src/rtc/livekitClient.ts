/**
 * livekitClient.ts —— LiveKit SFU 通用连接/收发工具（复用性统一出口）。
 *
 * 会议（RtcEngine）、远程协助（RemoteSession）、设备被控（RemoteControl）都用到
 * 「new Room + connect + 发布/替换轨道 + data 消息」这几步，重复代码以前散在三处。
 * 这里抽成一组通用函数，任何 SFU 场景直接复用：
 *   - connectSfu()          统一连接（new Room + connect + Disconnected 兜底）
 *   - sendData()            统一 data 消息发送（可选 destination 指定接收者）
 *   - publishOrReplace()    发布或同名替换一条轨道（先 unpublish 旧轨再发，杜绝重复）
 *
 * 所有 token 均由服务端签发（.env LIVEKIT_*），客户端不持有 apiSecret。
 */

import { Room, RoomEvent, LocalVideoTrack, LocalAudioTrack } from 'livekit-client'
import type { RtcSfuInfo } from '@shared/server-types'

/** 连接回调 */
export interface SfuConnectOpts {
  /** Disconnected 时调用（各场景据此收场） */
  onDisconnected?: () => void
  /**
   * Room 已创建、尚未 connect 时调用（事件订阅需在 connect 前完成才不会错过，
   * 例如 RtcEngine 的 TrackSubscribed / Reconnected）。
   */
  onRoomCreated?: (room: Room) => void
}

/** 统一连接一个 LiveKit SFU room。失败抛错，由调用方处理。 */
export async function connectSfu(sfu: RtcSfuInfo, opts: SfuConnectOpts = {}): Promise<Room> {
  const room = new Room()
  opts.onRoomCreated?.(room)
  if (opts.onDisconnected) {
    room.on(RoomEvent.Disconnected, () => opts.onDisconnected?.())
  }
  await room.connect(sfu.url, sfu.token)
  return room
}

/**
 * 统一 data 消息发送（LiveKit publishData）。
 * @param room        已连接的 Room
 * @param toIdentity  接收方 participant identity；传 null 则广播给 room 全部参与者
 * @param msg         JSON 可序列化对象（自动 encode）
 * @param reliable    可靠投递（默认 true；键鼠这类高频可改 false）
 */
export function sendData(room: Room, toIdentity: string | null, msg: unknown, reliable = true): void {
  const options: { reliable?: boolean; destinationIdentities?: string[] } = { reliable }
  if (toIdentity) options.destinationIdentities = [toIdentity]
  room.localParticipant.publishData(
    new TextEncoder().encode(typeof msg === 'string' ? msg : JSON.stringify(msg)),
    options
  )
}

/**
 * 发布或同名替换一条轨道（摄像头/麦克风/屏幕/系统声音等）。
 * 先 unpublish 同名旧轨（并 stop），再发布新轨；track 为 null 时仅移除旧轨。
 * 返回新轨的 LocalTrack（无则 null）。
 */
export async function publishOrReplace(
  room: Room,
  name: string,
  kind: 'audio' | 'video',
  track: MediaStreamTrack | null
): Promise<LocalVideoTrack | LocalAudioTrack | null> {
  // 1) 清理同名旧轨
  for (const pub of room.localParticipant.trackPublications.values()) {
    if (pub.trackName === name) {
      const old = pub.track
      if (old) await room.localParticipant.unpublishTrack(old)
      try { old?.stop() } catch { /* ignore */ }
    }
  }
  // 2) 空轨：仅移除，不发
  if (!track) return null
  // 3) 发布新轨
  const lkTrack = kind === 'video'
    ? new LocalVideoTrack(track, {}, true)
    : new LocalAudioTrack(track, undefined, true)
  await room.localParticipant.publishTrack(lkTrack, { name })
  return lkTrack
}
