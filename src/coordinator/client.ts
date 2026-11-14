import { spawn } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import {
  encode, lineReader, socketPath, socketPathUsable, type CliMsg, type CliReply, type CoordMsg, type GateMsg,
} from './protocol.js'

type Hello = Extract<GateMsg, { t: 'hello' }>
type Report = Extract<GateMsg, { t: 'report' }>

export interface CoordinatorClient {
  /** True while registered with a coordinator. */
  connected: boolean
  report(m: Report): void
  onCommand(cb: (m: CoordMsg) => void): void
  close(): void
}

const START_WAIT_MS = 2_000
const RETRY_EVERY_MS = 100
const RECONNECT_EVERY_MS = 5_000
const ASK_TIMEOUT_MS = 2_000

// In the bundle this module lives inside dist/cli.js itself.
const CLI_PATH = fileURLToPath(import.meta.url)

function spawnDaemon(home: string): void {
  try {
    const child = spawn(process.execPath, [CLI_PATH, '__coordinator'], {
      detached: true, stdio: 'ignore', env: { ...process.env, NAPDEV_HOME: home },
    })
    child.on('error', () => {})
    child.unref()
  } catch { /* the gate runs without a coordinator */ }
}

function dial(path: string): Promise<net.Socket | null> {
  return new Promise((resolve) => {
    const s = net.connect(path)
    s.once('connect', () => { s.removeAllListeners('error'); resolve(s) })
    s.once('error', () => { s.destroy(); resolve(null) })
  })
}

type Outcome = { socket: net.Socket } | { rejected: true } | null

/** Connects (starting a coordinator if none answers) and waits for the welcome. */
async function register(hello: Hello, home: string, onLine: (m: Record<string, unknown>) => void): Promise<Outcome> {
  const path = socketPath(home)
  if (!socketPathUsable(path)) return null
  const end = Date.now() + START_WAIT_MS
  let spawned = false
  for (;;) {
    const socket = await dial(path)
    if (socket) {
      const answer = await new Promise<Outcome>((resolve) => {
        const t = setTimeout(() => { socket.destroy(); resolve(null) }, Math.max(end - Date.now(), 500))
        socket.setEncoding('utf8')
        socket.on('error', () => {})
        let settled = false
        socket.on('data', lineReader((m) => {
          if (settled) return onLine(m)
          if (m.t === 'welcome') { settled = true; clearTimeout(t); resolve({ socket }) }
          if (m.t === 'reject') { settled = true; clearTimeout(t); socket.destroy(); resolve({ rejected: true }) }
        }))
        socket.once('close', () => { if (!settled) { clearTimeout(t); resolve(null) } })
        socket.write(encode(hello))
      })
      if (answer) return answer
    } else if (!spawned) {
      spawned = true
      spawnDaemon(home)
    }
    if (Date.now() >= end) return null
    await new Promise((r) => setTimeout(r, RETRY_EVERY_MS))
  }
}

/** Registers a gate. Never rejects: without a coordinator the gate runs with the idle rule only. */
export async function connectGate(hello: Hello, home: string): Promise<CoordinatorClient> {
  const listeners: Array<(m: CoordMsg) => void> = []
  let socket: net.Socket | null = null
  let lastReport: Report | null = null
  let closed = false
  let retry: NodeJS.Timeout | undefined

  const onLine = (m: Record<string, unknown>) => {
    if (m.t !== 'sleep' && m.t !== 'wake') return
    for (const cb of listeners) { try { cb(m as CoordMsg) } catch { /* a listener must not break the link */ } }
  }

  const adopt = (s: net.Socket) => {
    socket = s
    s.unref()
    if (lastReport) s.write(encode(lastReport))
    s.once('close', () => {
      if (socket !== s) return
      socket = null
      scheduleReconnect()
    })
  }

  // after an established link drops: try again every 5 s, re-sending hello
  const scheduleReconnect = () => {
    if (closed) return
    retry = setTimeout(async () => {
      const out = await register(hello, home, onLine).catch(() => null)
      if (closed) { if (out && 'socket' in out) out.socket.destroy(); return }
      if (out && 'socket' in out) adopt(out.socket)
      else if (!(out && 'rejected' in out)) scheduleReconnect()
    }, RECONNECT_EVERY_MS)
    retry.unref()
  }

  const first = await register(hello, home, onLine).catch(() => null)
  const client: CoordinatorClient = {
    get connected() { return socket !== null && !closed },
    report(m) {
      lastReport = m
      if (socket && !socket.destroyed) socket.write(encode(m))
    },
    onCommand(cb) { listeners.push(cb) },
    close() {
      closed = true
      clearTimeout(retry)
      socket?.end()
      socket = null
    },
  }
  if (first && 'socket' in first) adopt(first.socket)
  return client
}

/** One request/reply with the coordinator; null when none runs (or it does not answer within 2 s). */
export async function askCoordinator(msg: CliMsg, home: string): Promise<CliReply | null> {
  const path = socketPath(home)
  if (!socketPathUsable(path)) return null
  const socket = await dial(path)
  if (!socket) return null
  return new Promise((resolve) => {
    const finish = (reply: CliReply | null) => { clearTimeout(t); socket.destroy(); resolve(reply) }
    const t = setTimeout(() => finish(null), ASK_TIMEOUT_MS)
    socket.setEncoding('utf8')
    socket.on('error', () => finish(null))
    socket.on('close', () => finish(null))
    socket.on('data', lineReader((m) => {
      if (m.t === 'apps' || m.t === 'ok') finish(m as CliReply)
    }))
    socket.write(encode(msg))
  })
}
