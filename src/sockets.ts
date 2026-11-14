import type http from 'node:http'
import type { Duplex } from 'node:stream'
import WebSocket, { WebSocketServer, type RawData } from 'ws'
import type { Gate } from './gate.js'

// Next 15 reads `action`, Next 16 reads `type`; each ignores the other key.
export const RELOAD_FRAME = '{"action":"reloadPage","type":"reloadPage"}'

const SERVICE_RESTART = 1012

interface Pending { data: RawData; isBinary: boolean }

interface Browser {
  ws: WebSocket
  url: string
  headers: http.IncomingHttpHeaders
  upstream: WebSocket | null
  queued: Pending[] // frames sent before the upstream opened
}

export class SocketHub {
  private readonly wss = new WebSocketServer({
    noServer: true,
    // answer with the browser's first choice; the full list goes upstream
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  })
  private readonly browsers = new Set<Browser>()
  private hiddenPort: number | null = null

  constructor(private readonly gate: Gate) {}

  handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy())
    this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(ws, req))
  }

  private attach(ws: WebSocket, req: http.IncomingMessage): void {
    const b: Browser = { ws, url: req.url ?? '/', headers: req.headers, upstream: null, queued: [] }
    this.browsers.add(b)
    ws.on('error', () => ws.terminate())
    ws.on('close', () => {
      this.browsers.delete(b)
      this.detach(b)
    })
    ws.on('message', (data, isBinary) => {
      const up = b.upstream
      if (!up) return // held: dropped
      if (up.readyState === WebSocket.OPEN) up.send(data, { binary: isBinary })
      else b.queued.push({ data, isBinary })
    })
    if (this.hiddenPort !== null) this.bridge(b, this.hiddenPort)
  }

  private bridge(b: Browser, hiddenPort: number): void {
    const h = b.headers
    const protocols = (h['sec-websocket-protocol'] ?? '').split(',').map((p) => p.trim()).filter(Boolean)
    const headers: Record<string, string> = {}
    if (h.host) headers.host = h.host
    if (h.origin) headers.origin = h.origin
    if (h.cookie) headers.cookie = h.cookie
    const up = new WebSocket(`ws://127.0.0.1:${hiddenPort}${b.url}`, protocols, { headers, perMessageDeflate: false })
    b.upstream = up
    up.on('open', () => {
      for (const f of b.queued.splice(0)) up.send(f.data, { binary: f.isBinary })
    })
    up.on('message', (data, isBinary) => {
      if (b.upstream !== up) return
      this.gate.noteServerFrame()
      b.ws.send(data, { binary: isBinary })
    })
    const dropped = () => {
      if (b.upstream !== up) return // detached on purpose (sleep or browser close)
      b.upstream = null
      b.queued = []
      // a sleep kills the child before onSleep() arrives: hold the browser instead of closing it
      if (!this.gate.sleepInProgress) b.ws.close(SERVICE_RESTART)
    }
    up.on('error', dropped)
    up.on('close', dropped)
  }

  private detach(b: Browser): void {
    const up = b.upstream
    b.upstream = null
    b.queued = []
    up?.terminate()
  }

  onWake(hiddenPort: number): void {
    this.hiddenPort = hiddenPort
    for (const b of this.browsers) {
      if (b.upstream || b.ws.readyState !== WebSocket.OPEN) continue
      // held through a sleep or a wake: make the page reload onto the new server
      b.ws.send(RELOAD_FRAME)
      b.ws.close(SERVICE_RESTART)
    }
  }

  onSleep(): void {
    this.hiddenPort = null
    for (const b of this.browsers) this.detach(b)
  }

  browserCount(): number {
    return this.browsers.size
  }

  close(): Promise<void> {
    this.hiddenPort = null
    for (const b of this.browsers) {
      this.detach(b)
      b.ws.terminate()
    }
    this.browsers.clear()
    return new Promise((resolve) => this.wss.close(() => resolve()))
  }
}
