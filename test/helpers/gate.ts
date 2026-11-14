import type http from 'node:http'
import type net from 'node:net'
import { fileURLToPath } from 'node:url'
import { Gate, type GateState } from '../../src/gate.js'
import type { AppConfig } from '../../src/config.js'
import { createChildLauncher } from '../../src/launch.js'
import { LogTail } from '../../src/logs.js'
import { createGateServer, listenPublic } from '../../src/proxy.js'
import { SocketHub } from '../../src/sockets.js'

export const FAKE_NEXT = fileURLToPath(new URL('../fixtures/fake-next.mjs', import.meta.url))

export interface GateOnFakeNext {
  gate: Gate
  sockets: SocketHub
  server: http.Server
  tail: LogTail
  publicPort: number
  url: string
  wsUrl: string
  stop(): Promise<void>
}

export async function startGateOnFakeNext(
  env: Record<string, string> = {},
  config: Partial<AppConfig> = {},
): Promise<GateOnFakeNext> {
  const tail = new LogTail()
  let launcher: ReturnType<typeof createChildLauncher> | null = null
  let sockets: SocketHub | null = null
  let last: GateState = 'asleep'
  const gate = new Gate({
    config: { idleMs: 60_000, wakeTimeoutMs: 10_000, pin: false, ...config },
    startChild: (signal) => launcher!.startChild(signal),
    stopChild: (child) => launcher!.stopChild(child),
    onChange: (snap) => {
      if (snap.state === last) return
      last = snap.state
      if (snap.state === 'awake') sockets!.onWake(snap.hiddenPort!)
      else if (snap.state === 'asleep') sockets!.onSleep()
    },
    onError: () => {},
  })
  sockets = new SocketHub(gate)
  const server = createGateServer({ gate, sockets, tail })
  await listenPublic(server, 0, null)
  const publicPort = (server.address() as net.AddressInfo).port
  launcher = createChildLauncher({
    nextBin: FAKE_NEXT, cwd: process.cwd(), env: { ...process.env, ...env }, passthrough: [],
    publicPort, onOutput: (t) => tail.push(t),
  })
  const hub = sockets
  return {
    gate, sockets: hub, server, tail, publicPort,
    url: `http://localhost:${publicPort}/`,
    wsUrl: `ws://localhost:${publicPort}/_next/webpack-hmr`,
    async stop() {
      await gate.sleep('exit')
      await hub.close()
      server.closeAllConnections()
      await new Promise<void>((r) => server.close(() => r()))
      const snap = gate.snapshot()
      if (snap.childPid !== null || snap.strays !== 0) throw new Error(`gate left a child running: ${JSON.stringify(snap)}`)
    },
  }
}
