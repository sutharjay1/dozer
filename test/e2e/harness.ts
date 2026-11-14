// Harness for the acceptance suite on real Next.js 16 apps.
// The app templates in test/e2e/apps are copied OUTSIDE the repo (Next would otherwise take the
// dozer repo as its workspace root), installed once per template hash, and run with the built CLI.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AppView } from '../../src/coordinator/protocol.js'

export const REPO = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '')
export const CLI = join(REPO, 'dist', 'cli.cjs')
const TEMPLATES = join(REPO, 'test', 'e2e', 'apps')
export const APPS = ['a', 'b', 'c'] as const
export type AppName = (typeof APPS)[number]
export const PORTS: Record<AppName, number> = { a: 4310, b: 4311, c: 4312 }

export const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    return e.isDirectory() ? files(p) : [p]
  }).sort()
}

function templateHash(): string {
  const h = createHash('sha1')
  for (const f of files(TEMPLATES)) h.update(relative(TEMPLATES, f)).update('\0').update(readFileSync(f)).update('\0')
  return h.digest('hex').slice(0, 12)
}

/**
 * Returns the (real) path of an installed copy of the templates. `pnpm install` runs only the
 * first time for a given template hash. Page sources are reset to the templates on every call,
 * and each app gets a `dozer` bin that runs this checkout's dist/cli.cjs.
 */
export function prepareWorkspace(): string {
  const ws = join(tmpdir(), `dozer-e2e-${templateHash()}`)
  const marker = join(ws, '.installed')
  if (!existsSync(marker)) {
    rmSync(ws, { recursive: true, force: true })
    cpSync(TEMPLATES, ws, { recursive: true })
    execFileSync('pnpm', ['install', '--prefer-offline'], { cwd: ws, stdio: 'inherit' })
    writeFileSync(marker, new Date().toISOString() + '\n')
  }
  for (const app of APPS) {
    resetPage(ws, app)
    const bin = join(ws, app, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'dozer'), `#!/bin/sh\nexec "${process.execPath}" "${CLI}" "$@"\n`)
    chmodSync(join(bin, 'dozer'), 0o755)
  }
  return realpathSync(ws)
}

export const pagePath = (ws: string, app: AppName) => join(ws, app, 'app', 'page.tsx')

export function resetPage(ws: string, app: AppName): void {
  const want = readFileSync(join(TEMPLATES, app, 'app', 'page.tsx'), 'utf8')
  if (!existsSync(pagePath(ws, app)) || readFileSync(pagePath(ws, app), 'utf8') !== want) writeFileSync(pagePath(ws, app), want)
}

/** A short home: the coordinator's unix socket path must stay under ~104 bytes. */
export const makeHome = () => mkdtempSync('/tmp/dozer-e2e-h')

export interface Proc { pid: number; pgid: number; command: string }

export function processes(): Proc[] {
  const out = execFileSync('ps', ['-A', '-o', 'pid=,pgid=,command='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return out.split('\n').flatMap((line) => {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)
    return m ? [{ pid: Number(m[1]), pgid: Number(m[2]), command: m[3]! }] : []
  })
}

const NEXT_BIN = /node_modules\/next\/dist\/bin\/next\b/

/** Process groups led by a `next dev` started from this workspace (one per Next tree). */
export function nextTrees(ws: string, ps = processes()): number[] {
  return [...new Set(ps.filter((p) => NEXT_BIN.test(p.command) && p.command.includes(ws)).map((p) => p.pgid))].sort()
}

/** Every process of those trees, plus anything else running from the workspace except our bin shim. */
export function nextProcesses(ws: string): Proc[] {
  const ps = processes()
  const trees = new Set(nextTrees(ws, ps))
  return ps.filter((p) => trees.has(p.pgid) ||
    (p.command.includes(ws) && !p.command.includes('/node_modules/.bin/dozer') && !p.command.startsWith('ps ')))
}

/** `dozer next dev` gate processes of this checkout. */
export const gateProcesses = (): Proc[] => processes().filter((p) => p.command.includes(`${CLI} next dev`))
export const coordinatorProcesses = (): Proc[] => processes().filter((p) => p.command.includes(`${CLI} __coordinator`))

export function rssBytes(pid: number): number {
  return Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }).trim()) * 1024
}

export function pgrep(pattern: string): string[] {
  try {
    return execFileSync('pgrep', ['-fl', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

export function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', () => resolve(false))
    s.listen(port, () => s.close(() => resolve(true)))
  })
}

export function dozer(home: string, ...args: string[]): string {
  return execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...cleanEnv(), DOZER_HOME: home } })
}

export function status(home: string): AppView[] {
  return JSON.parse(dozer(home, 'status', '--json')) as AppView[]
}

export function appView(home: string, app: AppName): AppView | undefined {
  return status(home).find((a) => a.publicPort === PORTS[app])
}

function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (k.startsWith('DOZER')) delete env[k]
  return env
}

export interface Group { proc: ChildProcess; pgid: number; lines: string[]; exited: Promise<number | null> }

/** `pnpm -r --parallel dev` in its own process group, as a terminal would run it. */
export async function startApps(ws: string, home: string, env: Record<string, string>): Promise<Group> {
  const proc = spawn('pnpm', ['-r', '--parallel', 'dev'], {
    cwd: ws,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...cleanEnv(), NEXT_TELEMETRY_DISABLED: '1', DOZER_HOME: home, ...env },
  })
  const g: Group = { proc, pgid: proc.pid!, lines: [], exited: new Promise((r) => proc.once('exit', (c) => r(c))) }
  for (const s of [proc.stdout!, proc.stderr!]) {
    s.setEncoding('utf8').on('data', (d: string) => {
      g.lines.push(...d.split('\n'))
      if (process.env.DOZER_E2E_VERBOSE === '1') process.stdout.write(d)
    })
  }
  const end = Date.now() + 30_000
  while (APPS.some((a) => !g.lines.some((l) => l.includes(`dozer listening on http://localhost:${PORTS[a]}`)))) {
    if (Date.now() > end || proc.exitCode !== null) throw new Error(`apps did not start:\n${g.lines.join('\n')}`)
    await sleepMs(100)
  }
  return g
}

/** SIGINT to the whole process group, like Ctrl+C in a terminal. Resolves pnpm's exit code. */
export async function ctrlC(g: Group, timeoutMs = 30_000): Promise<number | null> {
  if (g.proc.exitCode !== null || g.proc.signalCode !== null) return g.proc.exitCode
  try { process.kill(-g.pgid, 'SIGINT') } catch { /* already gone */ }
  let t: NodeJS.Timeout | undefined
  const code = await Promise.race([g.exited, new Promise<'timeout'>((r) => { t = setTimeout(() => r('timeout'), timeoutMs) })])
  clearTimeout(t)
  if (code === 'timeout') throw new Error('pnpm did not exit after SIGINT')
  return code
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs: number, what: string): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}`)
    await sleepMs(200)
  }
}

/** Last resort for teardown: SIGKILL every group and process this suite could have left. */
export function killEverything(ws: string): void {
  const ps = processes()
  const doomed = new Set<number>()
  for (const p of [...nextProcesses(ws), ...gateProcesses(), ...coordinatorProcesses()]) doomed.add(p.pid)
  for (const g of nextTrees(ws, ps)) { try { process.kill(-g, 'SIGKILL') } catch { /* gone */ } }
  for (const pid of doomed) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
}
