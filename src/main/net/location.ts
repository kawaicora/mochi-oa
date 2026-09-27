let cached: { ip: string; location: string } | null = null

/**
 * 获取本机公网 IP 与归属地（用于登录记录 / 用户名后显示登录归属地）。
 * 依次尝试 pconline（国内直连，GBK）、ipify、ipinfo.io；全部失败返回空串。
 * 注意：不再用局域网 IP 兜底——NAT 后的 192.168.x 不是公网 IP，会误导归属地展示。
 */
export async function getClientLocation(): Promise<{ ip: string; location: string }> {
  if (cached) return cached
  let ip = ''
  let location = ''
  // 1) 太平洋 IP 库：国内直连，GBK 编码，返回公网 IP + 省市区
  try {
    const res = await fetch('https://whois.pconline.com.cn/ipJson.jsp?json=true', { signal: AbortSignal.timeout(5000) })
    const buf = await res.arrayBuffer()
    const txt = new TextDecoder('gbk').decode(buf)
    const ipM = txt.match(/"ip":\s*"([^"]+)"/)
    if (ipM) {
      ip = ipM[1]
      const proM = txt.match(/"pro":\s*"([^"]*)"/)
      const cityM = txt.match(/"city":\s*"([^"]*)"/)
      const addrM = txt.match(/"addr":\s*"([^"]*)"/)
      location = addrM?.[1] || [proM?.[1], cityM?.[1]].filter(Boolean).join(' ')
    }
  } catch {
    /* ignore */
  }
  // 2) ipify：仅返回公网 IP
  if (!ip) {
    try {
      const res = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) })
      const j = (await res.json()) as { ip?: string }
      if (j.ip) ip = j.ip
    } catch {
      /* ignore */
    }
  }
  // 3) ipinfo.io：公网 IP + 国家/地区/城市
  if (!ip) {
    try {
      const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(5000) })
      const j = (await res.json()) as { ip?: string; country?: string; region?: string; city?: string }
      if (j.ip) {
        ip = j.ip
        location = [j.country, j.region, j.city].filter(Boolean).join(' ')
      }
    } catch {
      /* ignore */
    }
  }
  cached = { ip: (ip ?? '').trim(), location }
  return cached
}
