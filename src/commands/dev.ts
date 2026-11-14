import { mkdirSync } from 'node:fs'
import type http from 'node:http'
import { parseDevArgs, type DevArgs } from '../args.js'
import { resolveNextBin, treeRssBytes, type ChildHandle } from '../child.js'
import { DEFAULTS, loadAppConfig, loadMachineConfig, napdevHome, type AppConfig } from '../config.js'
import { connectGate, type CoordinatorClient } from '../coordinator/client.js'
import { PROTOCOL_VERSION, socketPath, socketPathUsable } from '../coordinator/protocol.js'
import { Gate, type GateSnapshot, type GateState, type SleepReason } from '../gate.js'
import { identify, type Identity } from '../identity.js'
import { createChildLauncher } from '../launch.js'
import { createLogRewriter, LogTail, type LogRewriter } from '../logs.js'
import { runNext } from '../passthrough.js'
import { PortTakenError, resolvePublicPort } from '../port.js'
import { createGateServer, listenPublic } from '../proxy.js'
import { SocketHub } from '../sockets.js'

const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
const PARENT_POLL_MS = 2_000
const REPORT_EVERY_MS = 10_000
const ACTIVITY_REPORT_GAP_MS = 250

export type GateListener = (snapshot: GateSnapshot, reason?: SleepReason) => void

/** A running `napdev next dev`: the public port is bound and Next is asleep until a request. */
export interface DevSession {
  appDir: string
  home: string
  config: AppConfig
  identity: Identity
  publicPort: number
  gate: Gate
  /** Adds a listener for every gate change; returns a function that removes it. */
  onGateChange(listener: GateListener): () => void
  /** Adds a listener for requests in flight going 0 to 1 and 1 to 0; returns a function that removes it. */
  onActivity(listener: (snapshot: GateSnapshot) => void): () => void
  /** Process groups of every Next child not yet verified gone (awake, waking, crashed or being stopped). */
  childPids(): number[]
  /** Stops Next (verified dead) and closes the public port. Rejects if the tree survived. */
  close(): Promise<void>
}

// What start-up got through before it failed, for the plain `next dev` fallback.
interface Progress { args?: DevArgs; nextBin?: string; publicPort?: number }

async function startDev(argv: string[], env: NodeJS.ProcessEnv, appDir: string, p: Progress): Promise<DevSession> {
  const args = p.args = parseDevArgs(argv, env)
  const config = loadAppConfig(appDir, env)
  const home = napdevHome(env)
  mkdirSync(home, { recursive: true })
  const nextBin = p.nextBin = resolveNextBin(appDir, env)
  const identity = await identify(appDir)
  const publicPort = p.publicPort = await resolvePublicPort(args)

  const tail = new LogTail()
  const rewriters = new Map<number, LogRewriter>()
  const live = new Set<number>()
  const emit = (text: string) => {
    if (!text) return
    process.stdout.write(text)
    tail.push(text)
  }
  const launcher = createChildLauncher({
    nextBin, cwd: appDir, env, passthrough: args.passthrough, publicPort,
    onSpawn: (child: ChildHandle) => {
      const rw = createLogRewriter(child.hiddenPort, publicPort)
      rewriters.set(child.hiddenPort, rw)
      live.add(child.pid)
      void child.exited.then(() => {
        // the group stays in `live` (for the second Ctrl+C) until a stop verified it is gone
        if (rewriters.get(child.hiddenPort) === rw) rewriters.delete(child.hiddenPort)
        emit(rw.flush())
      })
    },
    onGone: (child: ChildHandle) => { live.delete(child.pid) },
    onOutput: (text, hiddenPort) => {
      const rw = rewriters.get(hiddenPort)
      emit(rw ? rw(text) : text)
    },
  })

  const listeners = new Set<GateListener>()
  const activity = new Set<(snapshot: GateSnapshot) => void>()
  let sockets: SocketHub | null = null
  let last: GateState = 'asleep'
  const gate = new Gate({
    config,
    startChild: (signal) => launcher.startChild(signal),
    stopChild: (child) => launcher.stopChild(child),
    onChange: (snap, reason) => {
      if (snap.state !== last) {
        last = snap.state
        if (snap.state === 'awake') sockets!.onWake(snap.hiddenPort!)
        else if (snap.state === 'asleep') sockets!.onSleep()
      }
      for (const l of listeners) l(snap, reason)
    },
    onActivity: (snap) => { for (const l of activity) l(snap) },
  })
  const hub = sockets = new SocketHub(gate)
  const server = createGateServer({ gate, sockets: hub, tail })
  try {
    await listenPublic(server, publicPort, args.hostname)
  } catch (err) {
    // lost a race for the port after it was found free
    if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') throw new PortTakenError(publicPort)
    throw err
  }

  return {
    appDir, home, config, identity, publicPort, gate,
    onGateChange(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    onActivity(listener) {
      activity.add(listener)
      return () => activity.delete(listener)
    },
    childPids: () => [...live],
    async close() {
      try {
        await gate.sleep('exit')
        const left = gate.snapshot()
        const trees = left.strays + (left.childPid !== null ? 1 : 0)
        if (trees > 0) throw new Error(`${trees} Next.js process tree(s) still running`)
      } finally {
        await hub.close()
        await closeServer(server)
      }
    },
  }
}

function closeServer(server: http.Server): Promise<void> {
  server.closeAllConnections()
  return new Promise((resolve) => server.close(() => resolve()))
}

function hasPortFlag(argv: string[]): boolean {
  return argv.some((a) => a === '-p' || a === '--port' || a.startsWith('--port='))
}

async function fallback(err: unknown, argv: string[], env: NodeJS.ProcessEnv, appDir: string, p: Progress): Promise<number> {
  let nextBin = p.nextBin
  if (!nextBin) {
    try {
      nextBin = resolveNextBin(appDir, env)
    } catch {
      process.stderr.write(`napdev: could not find next in ${appDir}\n`)
      return 1
    }
  }
  process.stderr.write(`napdev: could not start (${(err as Error)?.message ?? String(err)}); running next dev directly\n`)
  const args = ['dev', ...argv]
  if (p.args && !hasPortFlag(argv)) args.push('--port', String(p.publicPort ?? p.args.publicPort))
  return runNext(nextBin, args, appDir, env)
}

const message = (err: unknown) => (err as Error)?.message ?? String(err)

/**
 * Registers the session with the machine-wide coordinator and keeps it informed; obeys its
 * sleep and wake commands. Without a coordinator the gate keeps its idle rule only.
 * Returns a function that detaches (safe to call before the connection settles).
 */
function attachCoordinator(session: DevSession, env: NodeJS.ProcessEnv): () => void {
  const { gate, identity, config, appDir, publicPort, home } = session
  if (env.NAPDEV_COORDINATOR === '0') return () => {}
  const path = socketPath(home)
  if (!socketPathUsable(path)) {
    process.stderr.write(`napdev: coordinator socket path too long (${Buffer.byteLength(path)} bytes); running without the machine-wide limit\n`)
    return () => {}
  }
  let graceMs: number = DEFAULTS.graceMs
  try { graceMs = loadMachineConfig(home, env).graceMs } catch { /* the coordinator reports bad config itself */ }

  let client: CoordinatorClient | null = null
  let detached = false
  let rssBytes = 0
  let lastReportAt = 0
  let pending: NodeJS.Timeout | undefined

  const lastActiveAt = (s: GateSnapshot) =>
    s.lastHttpAt === null && s.awakeAt === null ? null : Math.max(s.lastHttpAt ?? 0, s.awakeAt ?? 0)
  const report = (refused = false) => {
    clearTimeout(pending)
    pending = undefined
    lastReportAt = Date.now()
    const s = gate.snapshot()
    client?.report({ t: 'report', state: s.state, inFlight: s.inFlight, lastHttpAt: s.lastHttpAt,
      lastActiveAt: lastActiveAt(s), rssBytes: s.childPid === null ? 0 : rssBytes, ...(refused ? { refused: true } : {}) })
  }
  // at most one activity report per 250 ms; the last change is always sent
  const reportSoon = () => {
    if (pending) return
    const wait = lastReportAt + ACTIVITY_REPORT_GAP_MS - Date.now()
    if (wait <= 0) return report()
    pending = setTimeout(report, wait)
    pending.unref()
  }
  // the coordinator may have decided on stale facts; only an idle app past its grace is evicted
  const mayEvict = () => {
    const s = gate.snapshot()
    const active = lastActiveAt(s)
    return !config.pin && s.inFlight === 0 && (active === null || Date.now() - active >= graceMs)
  }
  const sample = async () => {
    const pid = gate.snapshot().childPid
    if (pid === null) rssBytes = 0
    else {
      try { rssBytes = await treeRssBytes(pid) } catch { /* unknown: keep the last value */ }
    }
    report()
  }

  const stopListening = session.onGateChange((snap) => {
    report()
    if (snap.state === 'awake') void sample()
  })
  const stopActivity = session.onActivity(reportSoon)
  const timer = setInterval(() => void sample(), REPORT_EVERY_MS)
  timer.unref()

  void connectGate({
    t: 'hello', v: PROTOCOL_VERSION,
    app: { id: identity.id, name: identity.name, cwd: appDir, publicPort, pid: process.pid, pinned: config.pin, graceMs },
  }, home).then((c) => {
    if (detached) return c.close()
    client = c
    c.onCommand((m) => {
      if (m.t === 'sleep') {
        if (m.reason === 'evicted' && !mayEvict()) return report(true)
        gate.sleep(m.reason).catch((err: unknown) => process.stderr.write(`napdev: could not sleep Next.js (${message(err)})\n`))
      } else if (m.t === 'wake') {
        gate.resetFailures()
        gate.ensureAwake().catch((err: unknown) => process.stderr.write(`napdev: could not wake Next.js (${message(err)})\n`))
      }
    })
    void sample()
  })

  return () => {
    detached = true
    clearInterval(timer)
    clearTimeout(pending)
    stopListening()
    stopActivity()
    client?.close()
  }
}

/**
 * Prints the ready line, waits for a signal or a parent change, then shuts the session down.
 * Resolves the exit code.
 */
function serve(session: DevSession, ready: () => void): Promise<number> {
  return new Promise((resolve) => {
    const parent = process.ppid
    let stopping = false
    const finish = (code: number) => {
      clearInterval(poll)
      for (const sig of SIGNALS) process.off(sig, onSignal)
      resolve(code)
    }
    const shutdown = () => {
      stopping = true
      session.close().then(() => finish(0), (err: unknown) => {
        process.stderr.write(`napdev: could not stop Next.js (${(err as Error)?.message ?? String(err)})\n`)
        finish(1)
      })
    }
    const onSignal = () => {
      if (!stopping) return shutdown()
      // second signal: do not wait for a graceful stop
      for (const pid of session.childPids()) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
      finish(130)
    }
    for (const sig of SIGNALS) process.on(sig, onSignal)
    const poll = setInterval(() => { if (!stopping && process.ppid !== parent) shutdown() }, PARENT_POLL_MS)
    poll.unref()
    ready() // only now: whoever reads the line may signal at once
  })
}

export async function runDev(argv: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<number> {
  // the gate speaks plain HTTP to Next; a TLS dev server cannot sit behind it yet
  if (argv.some((a) => a.startsWith('--experimental-https'))) {
    let nextBin: string
    try {
      nextBin = resolveNextBin(cwd, env)
    } catch {
      process.stderr.write(`napdev: could not find next in ${cwd}\n`)
      return 1
    }
    process.stderr.write('napdev: --experimental-https is not supported yet; running next dev directly\n')
    return runNext(nextBin, ['dev', ...argv], cwd, env)
  }
  const progress: Progress = {}
  let session: DevSession
  try {
    session = await startDev(argv, env, cwd, progress)
  } catch (err) {
    if (err instanceof PortTakenError) {
      process.stderr.write(`Port ${err.port} is already in use\n`)
      return 1
    }
    return fallback(err, argv, env, cwd, progress)
  }
  // a bug in napdev must not leave Next running: kill every group we started, then exit
  const crash = (err: unknown) => {
    for (const pid of session.childPids()) { try { process.kill(-pid, 'SIGKILL') } catch { /* already gone */ } }
    process.stderr.write(`napdev: crashed (${message(err)})\n`)
    process.exit(1)
  }
  process.on('uncaughtException', crash)
  process.on('unhandledRejection', crash)
  if (env.NAPDEV_DEBUG === '1') process.stderr.write(`napdev: identity ${JSON.stringify(session.identity)}\n`)
  let detach = () => {}
  const code = await serve(session, () => {
    process.stdout.write(`napdev listening on http://localhost:${session.publicPort} (Next.js asleep; starts on first request)\n`)
    detach = attachCoordinator(session, env)
  })
  detach()
  return code
}
