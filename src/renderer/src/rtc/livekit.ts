/**
 * LiveKit 连接配置与 token 签发（渲染层）。
 *
 * 配置来源：resources/brand.json 的 rtc 段（主进程 brandingGet 暴露）：
 *   { "rtc": { "url": "wss://live.kawaimoe.org", "apiKey": "...", "apiSecret": "...", "roomPrefix": "oa" } }
 *
 * token 在本地用 WebCrypto(HMAC-SHA256) 按 LiveKit 约定的 JWT 结构签发：
 *   header {alg:HS256, typ:JWT}
 *   payload { iss: apiKey, sub: identity, nbf, exp, video: { room, roomJoin, canPublish, canSubscribe, canPublishData } }
 */

export interface RtcBranding {
  url: string
  apiKey: string
  apiSecret: string
  roomPrefix: string
}

/** 从品牌配置读取 LiveKit 配置；未配置返回 null（此时视频链路降级为不可用，日志给出原因） */
export async function getRtcConfig(): Promise<RtcBranding | null> {
  try {
    const b = await window.pantry.getBranding()
    return b?.rtc ?? null
  } catch (e) {
    console.error('[livekit] 读取品牌配置失败', e)
    return null
  }
}

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function b64urlText(text: string): string {
  return b64url(new TextEncoder().encode(text))
}

/** 签发 LiveKit 访问 token（HS256 JWT） */
export async function signLiveKitToken(
  cfg: RtcBranding,
  identity: string,
  room: string,
  ttlSec = 2 * 60 * 60
): Promise<string> {
  const now = Math.floor(Date.now() / 1000)
  const header = b64urlText(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64urlText(
    JSON.stringify({
      iss: cfg.apiKey,
      sub: identity,
      nbf: now - 10,
      exp: now + ttlSec,
      video: {
        room,
        roomJoin: true,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
      }
    })
  )
  const data = `${header}.${payload}`
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(cfg.apiSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data))
  return `${data}.${b64url(new Uint8Array(sig))}`
}

/** 业务房间 → LiveKit 房间名（加前缀避免与其他业务房间重名） */
export function toLiveKitRoomName(cfg: RtcBranding, roomId: string): string {
  return `${cfg.roomPrefix || 'oa'}-${roomId}`
}
