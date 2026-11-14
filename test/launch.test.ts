import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { stopTree, type ChildHandle } from '../src/child.js'
import { WakeFailedError } from '../src/gate.js'
import { createChildLauncher } from '../src/launch.js'

const FAKE_NEXT = fileURLToPath(new URL('./fixtures/fake-next.mjs', import.meta.url))

const started: ChildHandle[] = []
afterEach(async () => {
  await Promise.all(started.splice(0).map((h) => stopTree(h.pid, 500).catch(() => {})))
})

// a unique argv marker lets pgrep find only this test's processes
function launcher(env: Record<string, string> = {}) {
  const marker = `dozer-test-${randomUUID()}` // no leading dashes, or pgrep reads it as an option
  const out: string[] = []
  const l = createChildLauncher({
    nextBin: FAKE_NEXT, cwd: process.cwd(), env: { ...process.env, ...env }, passthrough: [marker],
    publicPort: 3999, onOutput: (t) => out.push(t),
  })
  return { ...l, marker, out }
}
function pids(marker: string): number[] {
  try {
    return execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).map(Number)
  } catch {
    return [] // pgrep exits 1 when nothing matches
  }
}
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('createChildLauncher', () => {
  it('starts next on a hidden port and resolves once it answers', async () => {
    const l = launcher()
    const child = await l.startChild(new AbortController().signal)
    started.push(child)
    const body = await (await fetch(`http://127.0.0.1:${child.hiddenPort}/x`)).text()
    expect(body).toContain('path=/x')
    expect(body).toContain('public=3999')
    expect(pids(l.marker).length).toBeGreaterThan(0)
    await l.stopChild(child)
    expect(pids(l.marker)).toEqual([])
  })

  it('rejects with WakeFailedError when next exits before it is ready', async () => {
    const l = launcher({ FAKE_NEXT_CRASH: '1' })
    await expect(l.startChild(new AbortController().signal)).rejects.toBeInstanceOf(WakeFailedError)
    expect(l.out.join('')).toContain('crashing on purpose')
    expect(pids(l.marker)).toEqual([])
  })

  it('an abort mid-start stops the spawned tree before rejecting', async () => {
    const l = launcher({ FAKE_NEXT_START_DELAY_MS: '5000' })
    const ac = new AbortController()
    const p = l.startChild(ac.signal)
    const caught = p.catch((e: unknown) => e)
    for (let i = 0; i < 100 && pids(l.marker).length === 0; i++) await sleepMs(50)
    expect(pids(l.marker).length).toBeGreaterThan(0)
    ac.abort()
    expect(await caught).toBeInstanceOf(Error)
    expect(pids(l.marker)).toEqual([])
  })
})
