// Runs the built CLI (dist/cli.js) and its real coordinator daemon; test/global-setup.ts builds first.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askCoordinator, connectGate } from '../src/coordinator/client.js'
import { PROTOCOL_VERSION, socketPath, type AppView } from '../src/coordinator/protocol.js'
import { findHiddenPort } from '../src/port.js'

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-next.mjs', import.meta.url))

// Unix socket paths are capped near 104 bytes, so the homes live under a short directory.
const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'napdev-co-'))
const FAKE = join(root, `fake-next-${randomUUID()}.mjs`)
symlinkSync(FIXTURE, FAKE)

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

function pgrep(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

interface Cli { name: string; port: number; proc: ChildProcess; lines: string[]; exited: Promise<number | null> }

let home: string
let clis: Cli[] = []
const daemons = new Set<number>()

// The daemon logs `start pid=<n>` when it binds; every pid seen is checked at the end.
function daemonPids(): number[] {
  let log = ''
  try { log = readFileSync(join(home, 'coordinator.log'), 'utf8') } catch { return [] }
  const pids = [...log.matchAll(/ start pid=(\d+)/g)].map((m) => Number(m[1]))
  for (const p of pids) daemons.add(p)
  return pids
}

async function startCli(name: string, env: Record<string, string> = {}): Promise<Cli> {
  const app = join(root, `${basename(home)}-${name}`)
  mkdirSync(app, { recursive: true })
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name }))
  const port = await findHiddenPort()
  const proc = spawn(process.execPath, [CLI, 'next', 'dev', '-p', String(port)], {
    cwd: app,
    env: { ...process.env, NAPDEV_NEXT_BIN: FAKE, NAPDEV_HOME: home, NAPDEV_MAX_AWAKE: '1', NAPDEV_GRACE: '1s', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cli: Cli = { name, port, proc, lines: [], exited: new Promise((r) => proc.once('exit', (c) => r(c))) }
  for (const s of [proc.stdout!, proc.stderr!]) s.setEncoding('utf8').on('data', (d: string) => cli.lines.push(...d.split('\n')))
  clis.push(cli)
  await vi.waitFor(() => expect(cli.lines.some((l) => l.startsWith('napdev listening'))).toBe(true), { timeout: 10_000 })
  return cli
}

const get = (cli: Cli, path = '/') => fetch(`http://localhost:${cli.port}${path}`).then(async (r) => ({ status: r.status, body: await r.text() }))

async function list(): Promise<AppView[]> {
  const reply = await askCoordinator({ t: 'list' }, home)
  if (reply?.t !== 'apps') throw new Error(`no app list: ${JSON.stringify(reply)}`)
  return reply.apps
}

const states = (apps: AppView[]) =>
  Object.fromEntries(apps.map((a) => [basename(a.cwd).split('-').pop(), a.state]).sort())

async function registered(n: number): Promise<AppView[]> {
  let apps: AppView[] = []
  await vi.waitFor(async () => { apps = await list(); expect(apps).toHaveLength(n) }, { timeout: 8_000, interval: 100 })
  return apps
}

async function stopClis(): Promise<void> {
  for (const cli of clis.splice(0)) {
    if (cli.proc.exitCode === null && cli.proc.signalCode === null) {
      cli.proc.kill('SIGTERM')
      const t = setTimeout(() => cli.proc.kill('SIGKILL'), 8_000)
      expect(await cli.exited).toBe(0)
      clearTimeout(t)
    }
  }
}

beforeEach(() => {
  home = mkdtempSync(join(root, 'h'))
})

afterEach(async () => {
  await stopClis()
  daemonPids()
  for (const pid of daemons) { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  for (let i = 0; i < 30 && (pgrep(FAKE).length || [...daemons].some(alive)); i++) await sleepMs(100)
  expect(pgrep(FAKE)).toEqual([])
  expect([...daemons].filter(alive)).toEqual([])
})

afterAll(() => {
  expect(pgrep(FAKE)).toEqual([])
  expect([...daemons].filter(alive)).toEqual([])
  rmSync(root, { recursive: true, force: true })
})

describe('coordinator', { timeout: 30_000 }, () => {
  it('registers every gate with its identity and an owner-only socket', async () => {
    const a = await startCli('a', { NAPDEV_PIN: '1' })
    const apps = await registered(1)
    expect(apps[0]).toMatchObject({ name: expect.stringContaining('a'), publicPort: a.port, pid: a.proc.pid, pinned: true,
      state: 'asleep', inFlight: 0, lastHttpAt: null, rssBytes: 0 })
    expect(statSync(socketPath(home)).mode & 0o777).toBe(0o600)
    expect(daemonPids()).toHaveLength(1)
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
    // it reconnects to a fresh coordinator in the background
    await vi.waitFor(async () => expect(states(await list())).toEqual({ a: 'awake' }), { timeout: 12_000, interval: 200 })
    expect(daemonPids()).toHaveLength(2)
  })

  it('a gate with another protocol version is rejected and runs degraded', async () => {
    await startCli('a')
    await registered(1)
    const app = { id: 'x', name: 'x', cwd: '/x', publicPort: 1, pid: process.pid, pinned: false }
    const client = await connectGate({ t: 'hello', v: 99, app }, home)
    expect(client.connected).toBe(false)
    client.report({ t: 'report', state: 'awake', inFlight: 0, lastHttpAt: null, lastActiveAt: null, rssBytes: 0 }) // no-op
    client.close()
    expect(await registered(1)).toHaveLength(1)
  })

  it('a gate whose first connect failed registers once a coordinator appears', async () => {
    // imported from src, connectGate cannot start a daemon (it would run src/coordinator/client.ts)
    const app = { id: 'late', name: 'late', cwd: '/late', publicPort: 1, pid: process.pid, pinned: false }
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
