// Spawns the built CLI (dist/cli.cjs); test/global-setup.ts runs `pnpm build` first.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { findHiddenPort, isPortFree } from '../src/port.js'

const CLI = fileURLToPath(new URL('../dist/cli.cjs', import.meta.url))
const FIXTURE = fileURLToPath(new URL('./fixtures/fake-next.mjs', import.meta.url))

// A uniquely named link to the fixture: pgrep finds only this file's processes,
// while `ws` still resolves from the fixture's real location.
const root = mkdtempSync(join(tmpdir(), 'napdev-dev-test-'))
const FAKE = join(root, `fake-next-${randomUUID()}.mjs`)
symlinkSync(FIXTURE, FAKE)

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }

function pgrep(pattern: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}

interface Cli {
  proc: ChildProcess
  lines: string[]
  waiters: Array<() => void>
  exited: Promise<number | null>
  grandchildren: number[]
}

const clis: Cli[] = []
let app: string
let home: string
let port: number

function startCli(args: string[], env: Record<string, string> = {}): Cli {
  const proc = spawn(process.execPath, [CLI, ...args], {
    cwd: app,
    // these tests are about one gate; the machine-wide coordinator is covered in coordinator.test.ts
    env: { ...process.env, NAPDEV_NEXT_BIN: FAKE, NAPDEV_HOME: home, NAPDEV_COORDINATOR: '0', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cli: Cli = {
    proc, lines: [], waiters: [], grandchildren: [],
    exited: new Promise((r) => proc.once('exit', (code) => r(code))),
  }
  for (const stream of [proc.stdout!, proc.stderr!]) {
    let partial = ''
    stream.setEncoding('utf8').on('data', (d: string) => {
      const parts = (partial + d).split('\n')
      partial = parts.pop() ?? ''
      for (const line of parts) {
        const g = /grandchild=(\d+)/.exec(line)
        if (g) cli.grandchildren.push(Number(g[1]))
        cli.lines.push(line)
      }
      for (const w of cli.waiters.splice(0)) w()
    })
  }
  clis.push(cli)
  return cli
}

async function waitForLine(cli: Cli, re: RegExp = /./, timeoutMs = 10_000): Promise<string> {
  const end = Date.now() + timeoutMs
  for (;;) {
    const hit = cli.lines.find((l) => re.test(l))
    if (hit !== undefined) return hit
    if (Date.now() > end) throw new Error(`no line matching ${re}; got:\n${cli.lines.join('\n')}`)
    await new Promise<void>((r) => {
      cli.waiters.push(r)
      setTimeout(r, 100)
    })
  }
}

function exitCode(cli: Cli): Promise<number | null> {
  return cli.exited
}

beforeEach(async () => {
  app = mkdtempSync(join(root, 'app-'))
  writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  home = join(app, 'home')
  port = await findHiddenPort()
})

afterEach(async () => {
  for (const cli of clis.splice(0)) {
    if (cli.proc.exitCode === null && cli.proc.signalCode === null) {
      cli.proc.kill('SIGTERM')
      const t = setTimeout(() => cli.proc.kill('SIGKILL'), 8_000)
      await cli.exited
      clearTimeout(t)
    }
    // Plain `next dev` runs (NAPDEV=0, fallback) leave the fixture's idle grandchild behind.
    for (const pid of cli.grandchildren) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }
  // a stray stop is killed by its group; give the kernel a moment to reap
  for (let i = 0; i < 20 && pgrep(FAKE).length; i++) await new Promise((r) => setTimeout(r, 100))
  expect(pgrep(FAKE)).toEqual([])
})

afterAll(() => {
  expect(pgrep(FAKE)).toEqual([])
  try { chmodSync(join(root, 'locked'), 0o755) } catch { /* not created */ }
  rmSync(root, { recursive: true, force: true })
})

describe('napdev next dev', { timeout: 20_000 }, () => {
  it('prints the ready line and starts no child', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    expect(await waitForLine(cli)).toBe(`napdev listening on http://localhost:${port} (Next.js asleep; starts on first request)`)
    expect(pgrep(FAKE)).toEqual([])
  })

  it('rewrites the hidden port in child output', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    const body = await (await fetch(`http://localhost:${port}/`)).text()
    expect(body).toContain('fake-next')
    expect(await waitForLine(cli, /Local:/)).toContain(`http://localhost:${port}`)
  })

  it('SIGTERM stops the tree and frees the port', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    await (await fetch(`http://localhost:${port}/`)).text()
    expect(pgrep(FAKE).length).toBeGreaterThan(0)
    cli.proc.kill('SIGTERM')
    expect(await exitCode(cli)).toBe(0)
    expect(pgrep(FAKE)).toEqual([])
    expect(await isPortFree(port, null)).toBe(true)
  })

  it('a crashed next leaves no worker behind, and the next request wakes a fresh one', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    const body = await (await fetch(`http://localhost:${port}/`)).text()
    const main = Number(/pid=(\d+)/.exec(body)![1])
    await waitForLine(cli, /grandchild=/)
    const [grandchild] = cli.grandchildren
    process.kill(main, 'SIGKILL')
    for (let i = 0; i < 50 && pgrep(FAKE).length; i++) await new Promise((r) => setTimeout(r, 100))
    expect(pgrep(FAKE)).toEqual([])
    expect(alive(grandchild!)).toBe(false)
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(200)
    cli.proc.kill('SIGTERM')
    expect(await exitCode(cli)).toBe(0)
  })

  it('SIGKILL of the gate leaves no next process within 3 s', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(200)
    await waitForLine(cli, /grandchild=/)
    expect(pgrep(FAKE).length).toBeGreaterThan(0)
    const t0 = Date.now()
    cli.proc.kill('SIGKILL')
    await exitCode(cli)
    while (pgrep(FAKE).length && Date.now() - t0 < 3_000) await new Promise((r) => setTimeout(r, 50))
    expect(pgrep(FAKE)).toEqual([])
    expect(cli.grandchildren.filter(alive)).toEqual([])
  })

  // the spec's goal 1: an ESM bundle and an eager `ws` load put it at ~72 MB on macOS
  it('a sleeping gate stays under 60 MB RSS', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    await new Promise((r) => setTimeout(r, 2_000))
    const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(cli.proc.pid)], { encoding: 'utf8' }).trim())
    expect(kb * 1024).toBeLessThan(60 * 1024 ** 2)
  })

  it('SIGINT while asleep exits 0', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)])
    await waitForLine(cli, /napdev listening/)
    cli.proc.kill('SIGINT')
    expect(await exitCode(cli)).toBe(0)
    expect(await isPortFree(port, null)).toBe(true)
  })

  it('NAPDEV=0 runs the real command on the public port', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)], { NAPDEV: '0' })
    expect(await waitForLine(cli, /Local:/)).toContain(`http://localhost:${port}`)
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(body).toContain('fake-next')
    expect(body).toContain('public=') // no NAPDEV_PUBLIC_PORT: Next itself owns the port
    expect(body).not.toMatch(/public=\d/)
    expect(cli.lines.some((l) => l.startsWith('napdev listening'))).toBe(false)
    cli.proc.kill('SIGTERM')
    expect(await exitCode(cli)).toBe(0)
  })

  it('an explicit port that is taken exits 1 with the port in the message', async () => {
    const blocker = net.createServer()
    await new Promise<void>((r) => blocker.listen(port, '127.0.0.1', () => r()))
    try {
      const cli = startCli(['next', 'dev', '--port', String(port)])
      expect(await exitCode(cli)).toBe(1)
      expect(cli.lines).toContain(`Port ${port} is already in use`)
      expect(pgrep(FAKE)).toEqual([])
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()))
    }
  })

  it('falls back to plain next dev when NAPDEV_HOME is not writable', async () => {
    writeFileSync(join(app, 'blocker'), 'a file where a directory should be')
    const cli = startCli(['next', 'dev', '-p', String(port)], { NAPDEV_HOME: join(app, 'blocker', 'home') })
    expect(await waitForLine(cli, /^napdev: could not start/))
      .toMatch(/^napdev: could not start \(.+\); running next dev directly$/)
    await waitForLine(cli, /Local:/)
    const body = await (await fetch(`http://127.0.0.1:${port}/`)).text()
    expect(body).toContain('fake-next')
    cli.proc.kill('SIGTERM')
    expect(await exitCode(cli)).toBe(0)
  })

  it('falls back when NAPDEV_HOME is under a read-only directory', async () => {
    const locked = join(root, 'locked')
    mkdirSync(locked, { recursive: true })
    chmodSync(locked, 0o555)
    const cli = startCli(['next', 'dev', '-p', String(port)], { NAPDEV_HOME: join(locked, 'home') })
    expect(await waitForLine(cli, /^napdev: could not start/)).toContain('running next dev directly')
    await waitForLine(cli, /Local:/)
    cli.proc.kill('SIGTERM')
    expect(await exitCode(cli)).toBe(0)
  })

  it('exits 1 when next cannot be found', async () => {
    const cli = startCli(['next', 'dev', '-p', String(port)], { NAPDEV_NEXT_BIN: '' })
    expect(await exitCode(cli)).toBe(1)
    expect(cli.lines.some((l) => l.startsWith('napdev: could not find next in '))).toBe(true)
  })

  it('says so once and keeps serving when the coordinator socket path is too long', async () => {
    const longHome = join(app, 'h'.repeat(120))
    const cli = startCli(['next', 'dev', '-p', String(port)], { NAPDEV_HOME: longHome, NAPDEV_COORDINATOR: '1' })
    await waitForLine(cli, /napdev listening/)
    expect(await waitForLine(cli, /socket path too long/))
      .toMatch(/^napdev: coordinator socket path too long \(\d+ bytes\); running without the machine-wide limit$/)
    expect((await fetch(`http://localhost:${port}/`)).status).toBe(200)
    expect(cli.lines.filter((l) => l.includes('socket path too long'))).toHaveLength(1)
  })

  it('unknown commands print usage and exit 1', async () => {
    const cli = startCli(['frobnicate'])
    expect(await exitCode(cli)).toBe(1)
    expect(cli.lines.join('\n')).toContain('napdev next dev [next dev options]')
  })
})
