/**
 * sfu.ts —— 从服务端 ack/事件响应中提取 SFU 连接信息的通用工具。
 *
 * 服务端 rtc:createMeeting / rtc:join / rtc:dmCall / rtc:dmAnswer / rtc:groupCall /
 * dev:view 的返回都是 util.OK(map) 展平结构：{ ok:true, url, token, roomName, ... }，
 * 即 sfu 三字段平铺在 ack 顶层（无 data.sfu 包装）。
 * 这里统一用 sfuFromAck() 从顶层组装 RtcSfuInfo，避免各处重复拼、也避免字段位置踩坑。
 */

import type { RtcSfuInfo } from './server-types'

/** 服务端 ack/事件里平铺的 SFU 三字段（util.OK 展平结构：{ ok:true, url, token, roomName, ... }） */
export interface SfuAckFields {
  url?: string | null
  token?: string | null
  roomName?: string | null
}

/** 从 ack/事件对象（顶层含 url/token/roomName）提取 SFU 连接信息；缺任一字段返回 undefined。 */
export function sfuFromAck(ack: SfuAckFields | undefined | null): RtcSfuInfo | undefined {
  if (!ack || !ack.url || !ack.token || !ack.roomName) return undefined
  return { url: ack.url, token: ack.token, roomName: ack.roomName }
}
