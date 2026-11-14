// Shared harness for tests that run the built CLI (dist/cli.js) and its real coordinator daemon.
// Importing it registers per-test cleanup hooks; test/global-setup.ts builds first.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askCoordinator, connectGate } from '../../src/coordinator/client.js'
import { PROTOCOL_VERSION, socketPath, type AppView } from '../../src/coordinator/protocol.js'
import { findHiddenPort } from '../../src/port.js'

export const CLI = fileURLToPath(new URL('../../dist/cli.js', import.meta.url))
const FIXTURE = fileURLToPath(new URL('../fixtures/fake-next.mjs', import.meta.url))

// Unix socket paths are capped near 104 bytes, so the homes live under a short directory.
export const root = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'napdev-co-'))
export const FAKE = join(root, `fake-next-${randomUUID()}.mjs`)
symlinkSync(FIXTURE, FAKE)

export const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function pgrep(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return []
  }
}

export function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

export interface Cli { name: string; port: number; proc: ChildProcess; lines: string[]; exited: Promise<number | null> }

export let home: string
let clis: Cli[] = []
const daemons = new Set<number>()

// The daemon logs `start pid=<n>` when it binds; every pid seen is checked at the end.
export function daemonPids(): number[] {
  let log = ''
  try { log = readFileSync(join(home, 'coordinator.log'), 'utf8') } catch { return [] }
  const pids = [...log.matchAll(/ start pid=(\d+)/g)].map((m) => Number(m[1]))
  for (const p of pids) daemons.add(p)
  return pids
}

export async function startCli(name: string, env: Record<string, string> = {}): Promise<Cli> {
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

export const get = (cli: Cli, path = '/') => fetch(`http://localhost:${cli.port}${path}`).then(async (r) => ({ status: r.status, body: await r.text() }))

export async function list(): Promise<AppView[]> {
  const reply = await askCoordinator({ t: 'list' }, home)
  if (reply?.t !== 'apps') throw new Error(`no app list: ${JSON.stringify(reply)}`)
  return reply.apps
}

export const states = (apps: AppView[]) =>
  Object.fromEntries(apps.map((a) => [basename(a.cwd).split('-').pop(), a.state]).sort())

export async function registered(n: number): Promise<AppView[]> {
  let apps: AppView[] = []
  await vi.waitFor(async () => { apps = await list(); expect(apps).toHaveLength(n) }, { timeout: 8_000, interval: 100 })
  return apps
}

export async function stopClis(): Promise<void> {
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

