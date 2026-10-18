/**
 * 本地无鉴权转发代理：监听 127.0.0.1:随机端口，把请求转发到远端带鉴权的代理。
 * Chrome 不用 Credential Manager 做代理认证（只对 IE/WinInet 生效），
 * 所以系统代理指向本地无鉴权端口，认证在本地转发层完成。
 */
import http from 'node:http'
import net from 'node:net'

let localServer: http.Server | null = null
let localPort = 0

/** 启动本地转发代理。返回本地端口。 */
export async function startLocalForward(remoteHost: string, remotePort: number, username: string, password: string): Promise<number> {
  stopLocalForward()
  const auth = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')

  const server = http.createServer((req, res) => {
    // 普通 HTTP 请求（非 CONNECT）
    const options: http.RequestOptions = {
      hostname: remoteHost,
      port: remotePort,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, 'proxy-authorization': auth }
    }
    const proxyReq = http.request(options, (proxyRes) => {
      // 上游 407/认证失败 → 本地返回 502，绝不透传 Proxy-Authenticate 给浏览器（避免 ERR_PROXY_AUTH_UNSUPPORTED）
      if (proxyRes.statusCode === 407) {
        console.error('[local-proxy] 上游代理认证失败(407)，本地返回 502')
        res.writeHead(502, { 'content-type': 'text/plain' })
        res.end('Upstream proxy auth failed')
        proxyRes.resume()
        return
      }
      // 过滤掉上游可能返回的 Proxy-Authenticate 头
      const headers = { ...proxyRes.headers }
      delete headers['proxy-authenticate']
      res.writeHead(proxyRes.statusCode || 502, headers)
      proxyRes.pipe(res)
    })
    proxyReq.on('error', (e) => {
      console.error('[local-proxy] 转发失败', e)
      res.writeHead(502)
      res.end('Bad Gateway')
    })
    req.pipe(proxyReq)
  })

  server.on('connect', (req, clientSocket, head) => {
    // CONNECT：连远端代理，发 CONNECT + Proxy-Authorization，成功后 pipe
    const remote = net.connect(remotePort, remoteHost, () => {
      remote.write(`CONNECT ${req.url} HTTP/1.1\r\nHost: ${req.url}\r\nProxy-Authorization: ${auth}\r\n\r\n`)
    })
    let responded = false
    remote.on('data', (chunk) => {
      if (!responded) {
        responded = true
        // 上游 CONNECT 响应 407/失败 → 本地返回 502，不透传认证质询
        const head = chunk.toString('utf8', 0, Math.min(chunk.length, 256))
        if (/^HTTP\/1\.[01] 407/.test(head) || /^HTTP\/1\.[01] [45]\d\d/.test(head)) {
          console.error('[local-proxy] CONNECT 上游失败：', head.split('\r\n')[0])
          clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          clientSocket.end()
          remote.end()
          return
        }
        clientSocket.write(chunk)
        if (head.length) remote.write(head)
        remote.pipe(clientSocket)
        clientSocket.pipe(remote)
      }
    })
    remote.on('error', (e) => { console.error('[local-proxy] CONNECT 失败', e); clientSocket.end() })
    clientSocket.on('error', (e) => { console.error('[local-proxy] 客户端断开', e); remote.end() })
  })

  server.on('error', (e) => { console.error('[local-proxy] 服务器错误', e) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number }
      localPort = addr.port
      localServer = server
      console.log(`[local-proxy] 本地转发代理已监听 127.0.0.1:${localPort} → ${remoteHost}:${remotePort}`)
      resolve()
    })
  })
  return localPort
}

/** 停止本地转发代理。 */
export function stopLocalForward(): void {
  if (localServer) {
    localServer.close(() => console.log('[local-proxy] 本地转发代理已停止'))
    localServer = null
    localPort = 0
  }
}

export function getLocalPort(): number { return localPort }
