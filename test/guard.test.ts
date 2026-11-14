// The guard of the built CLI (test/global-setup.ts builds it), driven directly.
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { GUARD_CLI, stopTree } from '../src/child.js'
import { findHiddenPort } from '../src/port.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-next.mjs', import.meta.url))
const started: ChildProcessWithoutNullStreams[] = []
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

// `ps` stand-ins put first on the guard's PATH: one counts its runs, one always fails
const bin = mkdtempSync(join(tmpdir(), 'dozer-guard-ps-'))
const REAL_PS = execFileSync('sh', ['-c', 'command -v ps'], { encoding: 'utf8' }).trim()
const COUNT = join(bin, 'count')
const script = (name: string, body: string) => {
  const dir = join(bin, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'ps'), `#!/bin/sh\n${body}\n`)
  chmodSync(join(dir, 'ps'), 0o755)
  return `${dir}:${process.env.PATH}`
}
const COUNTING_PATH = script('counting', `echo x >> "${COUNT}"\nexec "${REAL_PS}" "$@"`)
const FAILING_PATH = script('failing', 'exit 1')

afterAll(() => rmSync(bin, { recursive: true, force: true }))

afterEach(async () => {
  await Promise.all(started.splice(0).map((g) => stopTree(g.pid!, 500).catch(() => {})))
})

async function guard(env: Record<string, string> = {}) {
  const port = await findHiddenPort()
  const g = spawn(process.execPath, [GUARD_CLI, '__guard', FAKE, 'dev', '--port', String(port)], {
    detached: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  })
  started.push(g)
  let out = ''
  g.stdout.setEncoding('utf8').on('data', (d: string) => { out += d })
  g.stderr.setEncoding('utf8').on('data', (d: string) => { out += d })
  const exited = new Promise<number | null>((r) => g.once('close', (code) => r(code)))
  const line = async (re: RegExp) => {
    for (let i = 0; i < 100; i++) {
      const m = re.exec(out)
      if (m) return m
      await sleepMs(50)
    }
    throw new Error(`no ${re} in:\n${out}`)
  }
  return { g, exited, line, output: () => out }
}

describe('guard', () => {
  it('passes next output through and exits with its exit code', async () => {
    const { exited, output } = await guard({ FAKE_NEXT_CRASH: '1' })
    expect(await exited).toBe(1)
    expect(output()).toContain('crashing on purpose')
  })

  it('exits 128+signal when next is killed by a signal', async () => {
    const { g, exited, line } = await guard()
    await line(/grandchild=\d+/)
    const nextPid = Number(execFileSync('pgrep', ['-P', String(g.pid)], { encoding: 'utf8' }).trim())
    process.kill(nextPid, 'SIGKILL')
    expect(await exited).toBe(128 + 9)
  })

  it('forwards SIGTERM to next and exits with its code', async () => {
    const { g, exited, line } = await guard()
    await line(/grandchild=\d+/)
    g.kill('SIGTERM')
    expect(await exited).toBe(0) // fake-next exits 0 on SIGTERM
  })

  it('kills the rest of its group when next exits, even a worker that ignores SIGTERM', async () => {
    const { g, exited, line } = await guard({ FAKE_NEXT_STUBBORN_CHILD: '1' })
    const grandchild = Number((await line(/grandchild=(\d+)/))[1])
    g.kill('SIGTERM')
    expect(await exited).toBe(0) // still next's exit code
    for (let i = 0; i < 40 && alive(grandchild); i++) await sleepMs(50)
    expect(alive(grandchild)).toBe(false)
  })

  it('stops scanning once its group is empty: one or two ps passes', async () => {
    writeFileSync(COUNT, '')
    const { g, exited, line } = await guard({ PATH: COUNTING_PATH })
    const grandchild = Number((await line(/grandchild=(\d+)/))[1])
    g.kill('SIGTERM') // reaches next only; its grandchild is left for the guard
    expect(await exited).toBe(0)
    expect(alive(grandchild)).toBe(false)
    const passes = readFileSync(COUNT, 'utf8').split('\n').filter(Boolean).length
    expect(passes).toBeGreaterThanOrEqual(1)
    expect(passes).toBeLessThanOrEqual(2)
  })

  it('kills the whole group, itself included, when ps fails', async () => {
    const { g, exited, line } = await guard({ PATH: FAILING_PATH, FAKE_NEXT_STUBBORN_CHILD: '1' })
    const grandchild = Number((await line(/grandchild=(\d+)/))[1])
    g.kill('SIGTERM')
    await exited // by SIGKILL: next's exit code is lost
    for (let i = 0; i < 40 && alive(grandchild); i++) await sleepMs(50)
    expect(alive(grandchild)).toBe(false)
    expect(alive(g.pid!)).toBe(false)
  })

  it('kills its whole group when its stdin ends (the gate died)', async () => {
    const { g, exited, line } = await guard()
    const grandchild = Number((await line(/grandchild=(\d+)/))[1])
    g.stdin.end()
    await exited
    for (let i = 0; i < 40 && alive(grandchild); i++) await sleepMs(50)
    expect(alive(grandchild)).toBe(false)
    expect(alive(g.pid!)).toBe(false)
  })
})
