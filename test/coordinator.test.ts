// Runs the built CLI and its real coordinator daemon (harness in test/helpers/coordinator.ts).
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { askCoordinator, connectGate } from '../src/coordinator/client.js'
import { PROTOCOL_VERSION, socketPath } from '../src/coordinator/protocol.js'
import { findHiddenPort } from '../src/port.js'
import { alive, CLI, get, home, list, pgrep, registered, sleepMs, startCli, states, daemonPids, FAKE, stopClis } from './helpers/coordinator.js'

describe('coordinator', { timeout: 30_000 }, () => {
  it('registers every gate with its identity and an owner-only socket', async () => {
    const a = await startCli('a', { NAPDEV_PIN: '1' })
    const apps = await registered(1)
    expect(apps[0]).toMatchObject({ name: expect.stringContaining('a'), publicPort: a.port, pid: a.proc.pid, pinned: true,
      state: 'asleep', inFlight: 0, lastHttpAt: null, rssBytes: 0 })
    expect(statSync(socketPath(home)).mode & 0o777).toBe(0o600)
    expect(daemonPids()).toHaveLength(1)
  })

  it('the daemon runs from the napdev home, not the first app', async () => {
    await startCli('a')
    await registered(1)
    const [pid] = daemonPids()
    const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' })
      .split('\n').find((l) => l.startsWith('n'))!.slice(1)
    expect(cwd).toBe(realpathSync(home))
  })

  it('sleeps the least recently used app when a second one wakes', async () => {
    const a = await startCli('a')
    const b = await startCli('b')
    await startCli('c')
    await registered(3)
    expect((await get(a)).status).toBe(200)
    await sleepMs(1_200)
    expect((await get(b)).status).toBe(200)
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'asleep', b: 'awake', c: 'asleep' }),
      { timeout: 10_000, interval: 100 })
    expect(readFileSync(join(home, 'coordinator.log'), 'utf8')).toMatch(/ evict /)
    // the evicted app still wakes on its next request
    expect((await get(a)).status).toBe(200)
  })

  it('reports the awake tree RSS', async () => {
    const a = await startCli('a')
    await registered(1)
    await get(a)
    await vi.waitFor(async () => expect((await list())[0]!.rssBytes).toBeGreaterThan(0), { timeout: 8_000, interval: 100 })
  })

  it('never evicts an app while a request is in flight, and evicts it once the request ends and grace passes', async () => {
    const a = await startCli('a')
    const b = await startCli('b')
    await registered(2)
    const held = new AbortController()
    const res = await fetch(`http://localhost:${a.port}/stream`, { signal: held.signal })
    const reader = res.body!.getReader()
    await reader.read() // the stream is open and counted in flight
    await sleepMs(1_200) // past grace: only inFlight protects A now
    // B stays in use (inside grace), so A is the only app the policy could pick
    let busy = true
    const keepBusy = (async () => { while (busy) { await get(b); await sleepMs(200) } })()
    try {
      await sleepMs(6_000) // longer than one policy tick
      expect(states(await list())).toEqual({ a: 'awake', b: 'awake' })
      expect((await reader.read()).done).toBe(false) // still streaming
      held.abort()
      await reader.read().catch(() => {})
      const ended = Date.now()
      await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'asleep', b: 'awake' }),
        { timeout: 10_000, interval: 100 })
      expect(Date.now() - ended).toBeGreaterThanOrEqual(900)
    } finally {
      busy = false
      await keepBusy
    }
  })

  it('each gate is judged by its own grace, so a long one does not stall the limit', async () => {
    // A starts the daemon, so the daemon's own default grace is A's 30 s
    const a = await startCli('a', { NAPDEV_GRACE: '30s' })
    await registered(1)
    const b = await startCli('b')
    const apps = await registered(2)
    expect(apps.map((v) => v.graceMs).sort((x, y) => x - y)).toEqual([1_000, 30_000])
    expect((await get(a)).status).toBe(200)
    await sleepMs(1_200)
    expect((await get(b)).status).toBe(200)
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'awake', b: 'asleep' }),
      { timeout: 9_000, interval: 100 })
  })

  it('a refused eviction moves to the next app and is retried once its grace passes', async () => {
    const d = spawn(process.execPath, [CLI, '__coordinator'],
      { env: { ...process.env, NAPDEV_HOME: home, NAPDEV_MAX_AWAKE: '1' }, stdio: 'ignore' })
    d.unref()
    await vi.waitFor(() => expect(daemonPids()).toHaveLength(1))
    // two hand-driven gates: x is the oldest and refuses its first eviction
    const gate = async (id: string, lastActiveAt: number) => {
      const s = net.connect(socketPath(home))
      const got: string[] = []
      s.setEncoding('utf8').on('data', (c: string) => got.push(...c.split('\n').filter(Boolean)))
      await new Promise((r) => s.once('connect', r))
      s.write(JSON.stringify({ t: 'hello', v: PROTOCOL_VERSION,
        app: { id, name: id, cwd: `/${id}`, publicPort: 1, pid: process.pid, pinned: false, graceMs: 1_000 } }) + '\n')
      await vi.waitFor(() => expect(got).toContain(JSON.stringify({ t: 'welcome', v: PROTOCOL_VERSION })))
      const report = (extra: object = {}) => s.write(JSON.stringify({ t: 'report', state: 'awake', inFlight: 0,
        lastHttpAt: lastActiveAt, lastActiveAt, rssBytes: 0, ...extra }) + '\n')
      const evictions = () => got.filter((l) => l.includes('"evicted"')).length
      return { s, report, evictions }
    }
    const now = Date.now()
    const x = await gate('x', now - 5_000)
    const y = await gate('y', now - 2_000)
    try {
      x.report()
      y.report()
      await vi.waitFor(() => expect(x.evictions()).toBe(1))
      expect(y.evictions()).toBe(0)
      x.report({ refused: true })
      await vi.waitFor(() => expect(y.evictions()).toBe(1))
      // y obeys (it goes to sleep); x is still over the limit only if y stays up, so keep y awake
      y.report({ refused: true })
      await vi.waitFor(() => expect(x.evictions()).toBe(2), { timeout: 8_000, interval: 100 })
    } finally {
      x.s.destroy()
      y.s.destroy()
    }
  })

  it('an app woken from the command line gets grace; the other one is evicted', async () => {
    const a = await startCli('a')
    await startCli('b')
    const apps = await registered(2)
    expect((await get(a)).status).toBe(200)
    await sleepMs(1_200)
    const b = apps.find((v) => v.cwd.endsWith('-b'))!
    expect(await askCoordinator({ t: 'wake', target: b.id }, home)).toEqual({ t: 'ok', count: 1 })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'asleep', b: 'awake' }),
      { timeout: 10_000, interval: 100 })
    await sleepMs(1_500)
    const view = (await list()).find((v) => v.id === b.id)!
    expect(view.state).toBe('awake')
    expect(view.lastHttpAt).toBeNull()
    expect(view.lastActiveAt).toBeGreaterThan(0)
  })

  it('sleeps and wakes on request from the command line', async () => {
    const a = await startCli('a')
    const [view] = await registered(1)
    expect(await askCoordinator({ t: 'wake', target: view!.id }, home)).toEqual({ t: 'ok', count: 1 })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'awake' }), { timeout: 8_000, interval: 100 })
    expect(await askCoordinator({ t: 'sleep', target: '*' }, home)).toEqual({ t: 'ok', count: 1 })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'asleep' }), { timeout: 8_000, interval: 100 })
    expect(await askCoordinator({ t: 'sleep', target: 'nope' }, home)).toEqual({ t: 'ok', count: 0 })
    expect((await get(a)).status).toBe(200)
  })

  it('a gate keeps working when the coordinator is killed', async () => {
    const a = await startCli('a')
    await registered(1)
    const [pid] = daemonPids()
    process.kill(pid!, 'SIGKILL')
    await vi.waitFor(() => expect(alive(pid!)).toBe(false))
    expect((await get(a)).status).toBe(200)
    await sleepMs(5_500)
    expect(daemonPids()).toHaveLength(1) // a gate starts a daemon at most once
    // it registers again with the next coordinator (here started by hand, as a new gate would)
    spawn(process.execPath, [CLI, '__coordinator'], { env: { ...process.env, NAPDEV_HOME: home }, stdio: 'ignore' }).unref()
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'awake' }), { timeout: 12_000, interval: 200 })
    expect(daemonPids()).toHaveLength(2)
  })

  it('a gate with another protocol version is rejected and runs degraded', async () => {
    await startCli('a')
    await registered(1)
    const app = { id: 'x', name: 'x', cwd: '/x', publicPort: 1, pid: process.pid, pinned: false, graceMs: 1_000 }
    const client = await connectGate({ t: 'hello', v: 99, app }, home)
    expect(client.connected).toBe(false)
    client.report({ t: 'report', state: 'awake', inFlight: 0, lastHttpAt: null, lastActiveAt: null, rssBytes: 0 }) // no-op
    client.close()
    expect(await registered(1)).toHaveLength(1)
  })

  it('a gate whose first connect failed registers once a coordinator appears', async () => {
    // imported from src, connectGate cannot start a daemon (it would run src/coordinator/client.ts)
    const app = { id: 'late', name: 'late', cwd: '/late', publicPort: 1, pid: process.pid, pinned: false, graceMs: 1_000 }
    const client = await connectGate({ t: 'hello', v: PROTOCOL_VERSION, app }, home)
    try {
      expect(client.connected).toBe(false)
      const d = spawn(process.execPath, [CLI, '__coordinator'], { env: { ...process.env, NAPDEV_HOME: home }, stdio: 'ignore' })
      d.unref()
      await vi.waitFor(() => expect(daemonPids()).toHaveLength(1))
      await vi.waitFor(() => expect(client.connected).toBe(true), { timeout: 8_000, interval: 100 })
      expect((await list()).map((v) => v.id)).toEqual(['late'])
    } finally {
      client.close()
    }
  })

  it('a gate rejected by its coordinator still serves', async () => {
    // a coordinator speaking another version rejects every hello
    const hellos: unknown[] = []
    const fake = net.createServer((s) => {
      s.setEncoding('utf8').once('data', (d: string) => {
        hellos.push(JSON.parse(d.split('\n')[0]!))
        s.end(JSON.stringify({ t: 'reject', reason: 'version' }) + '\n')
      })
    })
    await new Promise<void>((r) => fake.listen(socketPath(home), () => r()))
    try {
      const a = await startCli('a')
      await vi.waitFor(() => expect(hellos).toHaveLength(1), { timeout: 8_000 })
      expect(hellos[0]).toMatchObject({ t: 'hello', v: PROTOCOL_VERSION, app: { publicPort: a.port, pid: a.proc.pid } })
      expect((await get(a)).status).toBe(200)
      expect(daemonPids()).toEqual([])
    } finally {
      await new Promise<void>((r) => fake.close(() => r()))
    }
  })

  it('the daemon exits after its last gate leaves and removes its socket', async () => {
    await startCli('a')
    await startCli('b')
    await registered(2)
    const [pid] = daemonPids()
    await stopClis()
    const left = Date.now()
    await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 12_000, interval: 200 })
    expect(Date.now() - left).toBeGreaterThanOrEqual(9_000)
    expect(existsSync(socketPath(home))).toBe(false)
    expect(await askCoordinator({ t: 'list' }, home)).toBeNull()
  })

  it('a second daemon exits at once when the socket is served', async () => {
    await startCli('a')
    await registered(1)
    const second = spawn(process.execPath, [CLI, '__coordinator'], { env: { ...process.env, NAPDEV_HOME: home }, stdio: 'ignore' })
    const code = await new Promise((r) => second.once('exit', r))
    expect(code).toBe(0)
    expect(await registered(1)).toHaveLength(1)
    expect(daemonPids()).toHaveLength(1)
  })

  it('leaves a socket file that is no longer its own', async () => {
    await startCli('a')
    await registered(1)
    const [pid] = daemonPids()
    const path = socketPath(home)
    rmSync(path)
    const conns = new Set<net.Socket>()
    const other = net.createServer((s) => {
      conns.add(s)
      s.on('error', () => {})
      s.end(JSON.stringify({ t: 'ok', count: 42 }) + '\n')
    })
    await new Promise<void>((r) => other.listen(path, () => r()))
    try {
      process.kill(pid!, 'SIGTERM')
      await vi.waitFor(() => expect(alive(pid!)).toBe(false), { timeout: 5_000 })
      expect(existsSync(path)).toBe(true)
      expect(await askCoordinator({ t: 'list' }, home)).toEqual({ t: 'ok', count: 42 })
    } finally {
      for (const c of conns) c.destroy()
      await new Promise<void>((r) => other.close(() => r()))
    }
  })

  it('drops a connection that sends an over-long line', async () => {
    await startCli('a')
    await registered(1)
    const s = net.connect(socketPath(home))
    const closed = new Promise((r) => s.once('close', r))
    s.on('error', () => {})
    s.write('x'.repeat(70 * 1024))
    await closed
    expect(readFileSync(join(home, 'coordinator.log'), 'utf8')).toMatch(/line over 65536 bytes/)
    expect(await registered(1)).toHaveLength(1)
  })

  it('a stale socket file is replaced', async () => {
    const path = socketPath(home)
    const holder = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(path)}, () => console.log('up'))`],
      { stdio: ['ignore', 'pipe', 'ignore'] })
    await new Promise((r) => holder.stdout!.once('data', r))
    holder.kill('SIGKILL')
    await new Promise((r) => holder.once('exit', r))
    expect(existsSync(path)).toBe(true)
    expect(await askCoordinator({ t: 'list' }, home)).toBeNull()
    await startCli('a')
    expect(await registered(1)).toHaveLength(1)
  })
})
