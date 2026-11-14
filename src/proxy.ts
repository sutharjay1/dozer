import http from 'node:http'
import { WakeTimeoutError, type Gate } from './gate.js'
import type { LogTail } from './logs.js'
import type { SocketHub } from './sockets.js'

// Node sets these itself for each hop.
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer'])

function endToEnd(headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k.startsWith('proxy-')) continue
    out[k] = v
  }
  return out
}

function failureBody(tail: LogTail): string {
  const lines = tail.lines().join('\n')
  return `napdev: Next.js could not start\n\n${lines}\n\nRun with NAPDEV=0 to bypass napdev.\n`
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  if (res.headersSent) { res.destroy(); return }
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(body) })
  res.end(body)
}

export function createGateServer(o: { gate: Gate; sockets: SocketHub; tail: LogTail }): http.Server {
  const { gate, sockets, tail } = o
  const server = http.createServer((req, res) => {
    gate.noteHttpStart()
    let ended = false
    let upstream: http.ClientRequest | null = null
    res.once('close', () => {
      if (!ended) { ended = true; gate.noteHttpEnd() }
      upstream?.destroy()
    })

    gate.ensureAwake().then((hiddenPort) => {
      if (res.destroyed || ended) return // the client left during the wake
      const up = http.request({
        host: '127.0.0.1', port: hiddenPort, method: req.method, path: req.url,
        headers: endToEnd(req.headers), agent: false,
      })
      upstream = up
      up.on('response', (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, endToEnd(upRes.headers))
        res.flushHeaders()
        upRes.on('error', () => res.destroy())
        upRes.pipe(res)
      })
      up.on('error', () => sendText(res, 502, failureBody(tail)))
      req.on('error', () => up.destroy())
      req.pipe(up)
    }, (err: unknown) => {
      if (err instanceof WakeTimeoutError) {
        const s = Math.round(gate.config.wakeTimeoutMs / 1000)
        sendText(res, 504, `napdev: Next.js did not start within ${s} s\n`)
      } else {
        sendText(res, 502, failureBody(tail))
      }
    })
  })
  server.on('upgrade', (req, socket, head) => sockets.handleUpgrade(req, socket, head))
  return server
}

export function listenPublic(server: http.Server, port: number, hostname: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => reject(err)
    server.once('error', onError)
    const opts = hostname === null ? { port, host: '::', ipv6Only: false } : { port, host: hostname }
    server.listen(opts, () => {
      server.off('error', onError)
      resolve()
    })
  })
}
