import os from 'node:os'

let cached: { ip: string; location: string } | null = null

/**
 * 获取本机公网 IP 与归属地（用于登录记录 / 用户名后显示登录归属地）。
 * 主选太平洋 IP 库（国内直连，GBK 编码），次选 ipinfo.io，最后用局域网 IP 兜底。
 * 结果缓存一次，避免每次登录重复请求。
 */
export async function getClientLocation(): Promise<{ ip: string; location: string }> {
  if (cached) return cached
  let ip = ''
  let location = ''
  try {
    const res = await fetch('https://whois.pconline.com.cn/ipJson.jsp?json=true', { signal: AbortSignal.timeout(6000) })
    const buf = await res.arrayBuffer()
    const txt = new TextDecoder('gbk').decode(buf)
    // 形如: {"ip":"1.2.3.4","pro":"广东省","city":"广州市",...,"addr":"广东省广州市 电信"}
    const m = txt.match(/\{ip:"([^"]+)",\s*pro:"([^"]*)",\s*city:"([^"]*)",\s*region:"([^"]*)",\s*addr:"([^"]*)"/)
    if (m) {
      ip = m[1]
      location = m[5] || [m[2], m[3]].filter(Boolean).join(' ')
    }
  } catch {
    /* ignore */
  }
  if (!ip) {
    try {
      const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(6000) })
      const j = (await res.json()) as { ip?: string; country?: string; region?: string; city?: string }
      ip = j.ip ?? ''
      location = [j.country, j.region, j.city].filter(Boolean).join(' ')
    } catch {
      /* ignore */
    }
  }
  if (!ip) {
    const ifs = os.networkInterfaces()
    outer: for (const list of Object.values(ifs)) {
      for (const i of list ?? []) {
        if (i.family === 'IPv4' && !i.internal) {
          ip = i.address
          break outer
        }
      }
    }
  }
  cached = { ip, location }
  return cached
}
