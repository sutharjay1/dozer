import { appendFileSync, chmodSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { DEFAULTS, loadMachineConfig, napdevHome } from '../config.js'
import type { GateState } from '../gate.js'
import { chooseVictims, type Limits } from './policy.js'
import {
  encode, lineReader, PROTOCOL_VERSION, socketPath, socketPathUsable, type AppView,
} from './protocol.js'

const POLICY_EVERY_MS = 5_000
const LINGER_MS = 10_000
const PROBE_TIMEOUT_MS = 1_000
const STATES: readonly GateState[] = ['asleep', 'waking', 'awake']

interface GateConn { key: string; socket: net.Socket; view: AppView; evictSent: boolean }

/** Resolves true when something answers on the socket path. */
export function probe(path: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect(path)
    const done = (ok: boolean) => { clearTimeout(t); s.destroy(); resolve(ok) }
    const t = setTimeout(() => done(false), timeoutMs)
    s.once('connect', () => done(true))
    s.once('error', () => done(false))
  })
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

/** `napdev __coordinator`: serves the machine-wide view until 10 s after its last gate leaves. */
export async function runCoordinator(env: NodeJS.ProcessEnv): Promise<number> {
  const home = napdevHome(env)
  mkdirSync(home, { recursive: true })
  const logFile = join(home, 'coordinator.log')
  const log = (line: string) => {
    try { appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`) } catch { /* logging must not stop the daemon */ }
  }
  const path = socketPath(home)
  if (!socketPathUsable(path)) {
    log(`socket path too long (${Buffer.byteLength(path)} bytes): ${path}`)
    return 1
  }

  let limits: Limits
  try {
    limits = loadMachineConfig(home, env)
  } catch (err) {
    log(`config: ${(err as Error).message}; using defaults`)
    limits = { maxAwake: DEFAULTS.maxAwake, memoryBudgetBytes: null, graceMs: DEFAULTS.graceMs }
  }

  const gates = new Map<net.Socket, GateConn>()
  const sockets = new Set<net.Socket>()
  let nextKey = 0
  let linger: NodeJS.Timeout | undefined
  let closing = false

  const send = (socket: net.Socket, msg: Parameters<typeof encode>[0]) => {
    if (!socket.destroyed) socket.write(encode(msg))
  }

  const enforce = () => {
    const conns = [...gates.values()]
    // keyed by connection, so two gates with the same app id are still told apart
    const victims = chooseVictims(conns.map((c) => ({ ...c.view, id: c.key })), limits, Date.now())
    for (const key of victims) {
      const c = conns.find((g) => g.key === key)!
      if (c.evictSent) continue
      c.evictSent = true
      log(`evict id=${c.view.id} pid=${c.view.pid} name=${JSON.stringify(c.view.name)}`)
      send(c.socket, { t: 'sleep', reason: 'evicted' })
    }
  }

  const armLinger = () => {
    clearTimeout(linger)
    linger = gates.size === 0 ? setTimeout(() => void shutdown('idle'), LINGER_MS) : undefined
  }

  const onMessage = (socket: net.Socket, msg: Record<string, unknown>) => {
    const conn = gates.get(socket)
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL_VERSION) {
        log(`reject version=${JSON.stringify(msg.v)}`)
        socket.end(encode({ t: 'reject', reason: 'version' }))
        return
      }
      if (conn) return
      const app = (msg.app ?? {}) as Record<string, unknown>
      const view: AppView = {
        id: String(app.id ?? ''), name: String(app.name ?? ''), cwd: String(app.cwd ?? ''),
        publicPort: num(app.publicPort, 0), pid: num(app.pid, 0), pinned: app.pinned === true,
        state: 'asleep', inFlight: 0, lastHttpAt: null, rssBytes: 0,
      }
      gates.set(socket, { key: String(nextKey++), socket, view, evictSent: false })
      armLinger()
      log(`register id=${view.id} pid=${view.pid} port=${view.publicPort} name=${JSON.stringify(view.name)}`)
      send(socket, { t: 'welcome', v: PROTOCOL_VERSION })
      return
    }
    if (msg.t === 'report' && conn) {
      const state = STATES.includes(msg.state as GateState) ? (msg.state as GateState) : conn.view.state
      if (state !== conn.view.state) conn.evictSent = false
      conn.view = {
        ...conn.view, state, inFlight: num(msg.inFlight, 0),
        lastHttpAt: msg.lastHttpAt === null ? null : num(msg.lastHttpAt, conn.view.lastHttpAt ?? 0),
        rssBytes: num(msg.rssBytes, conn.view.rssBytes),
      }
      enforce()
      return
    }
    if (conn) return // gates send nothing else
    if (msg.t === 'list') {
      send(socket, { t: 'apps', apps: [...gates.values()].map((g) => g.view) })
      return
    }
    if ((msg.t === 'sleep' || msg.t === 'wake') && typeof msg.target === 'string') {
      const wake = msg.t === 'wake'
      const target = msg.target
      const hits = [...gates.values()].filter((g) => (target === '*' || g.view.id === target)
        && (wake ? g.view.state !== 'awake' : g.view.state !== 'asleep'))
      for (const g of hits) send(g.socket, wake ? { t: 'wake' } : { t: 'sleep', reason: 'manual' })
      log(`${msg.t} target=${JSON.stringify(msg.target)} count=${hits.length}`)
      send(socket, { t: 'ok', count: hits.length })
      return
    }
    log(`unknown message ${JSON.stringify(msg).slice(0, 200)}`)
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.setEncoding('utf8')
    socket.on('data', lineReader((m) => onMessage(socket, m), (line) => log(`unparseable line ${JSON.stringify(line.slice(0, 200))}`)))
    socket.on('error', () => {})
    socket.on('close', () => {
      sockets.delete(socket)
      const conn = gates.get(socket)
      if (!conn) return
      gates.delete(socket)
      log(`disconnect id=${conn.view.id} pid=${conn.view.pid}`)
      armLinger()
      enforce()
    })
  })

  const listen = () => new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('error', (e) => resolve(e))
    server.listen(path, () => { server.removeAllListeners('error'); resolve(null) })
  })

  const oldUmask = process.umask(0o177)
  let err: NodeJS.ErrnoException | null = null
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (existsSync(path) || err?.code === 'EADDRINUSE') {
        if (await probe(path)) return 0 // another coordinator already serves this home
        try { unlinkSync(path) } catch { /* gone already */ }
      }
      err = await listen()
      if (!err) break
    }
  } finally {
    process.umask(oldUmask)
  }
  if (err) {
    log(`cannot listen on ${path}: ${err.message}`)
    return 1
  }
  try { chmodSync(path, 0o600) } catch { /* umask already did it */ }
  server.on('error', (e) => log(`server error: ${e.message}`))
  log(`start pid=${process.pid} maxAwake=${limits.maxAwake} memoryBudgetBytes=${limits.memoryBudgetBytes} graceMs=${limits.graceMs}`)

  const tick = setInterval(enforce, POLICY_EVERY_MS)
  armLinger()

  let finished!: (code: number) => void
  const done = new Promise<number>((r) => { finished = r })
  async function shutdown(why: string): Promise<void> {
    if (closing) return
    closing = true
    clearInterval(tick)
    clearTimeout(linger)
    for (const sig of ['SIGTERM', 'SIGINT'] as const) process.off(sig, onSignal)
    for (const s of sockets) s.destroy()
    await new Promise<void>((r) => server.close(() => r()))
    try { unlinkSync(path) } catch { /* server.close removed it */ }
    log(`exit (${why})`)
    finished(0)
  }
  const onSignal = (sig: NodeJS.Signals) => void shutdown(sig)
  for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, onSignal)
  return done
}
