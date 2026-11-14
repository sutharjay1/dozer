import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { findHiddenPort } from '../src/port.js'
import {
  resolveNextBin, spawnChild, stopTree, treeRssBytes, waitReady, type ChildHandle,
} from '../src/child.js'

const FAKE = fileURLToPath(new URL('./fixtures/fake-next.mjs', import.meta.url))
const started: ChildHandle[] = []

async function start(env: NodeJS.ProcessEnv = {}, out: string[] = []): Promise<ChildHandle> {
  const hiddenPort = await findHiddenPort()
  const h = spawnChild({
    nextBin: FAKE, cwd: process.cwd(), env: { ...process.env, ...env }, passthrough: [],
    hiddenPort, publicPort: 3000, onOutput: (t) => out.push(t),
  })
  started.push(h)
  return h
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
async function grandchildPid(out: string[]): Promise<number> {
  for (let i = 0; i < 100; i++) {
    const m = /grandchild=(\d+)/.exec(out.join(''))
    if (m) return Number(m[1])
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('no grandchild line')
}

afterEach(async () => {
  await Promise.all(started.splice(0).map((h) => stopTree(h.pid, 500).catch(() => {})))
})

describe('child', () => {
  it('starts on the hidden port and reports ready', async () => {
    const h = await start()
    await waitReady(h.hiddenPort, 5_000, new AbortController().signal)
    const body = await (await fetch(`http://127.0.0.1:${h.hiddenPort}/x`)).text()
    expect(body).toContain('path=/x')
    expect(body).toContain('public=3000')
  })

  it('stopTree leaves no process from the tree, including the grandchild', async () => {
    const out: string[] = []
    const h = await start({}, out)
    const grandchild = await grandchildPid(out)
    expect(alive(grandchild)).toBe(true)
    await stopTree(h.pid)
    expect(alive(h.pid)).toBe(false)
    expect(alive(grandchild)).toBe(false)
    expect(await h.exited).not.toBeUndefined()
  })

  it('stopTree on an already-exited tree resolves', async () => {
    const h = await start({ FAKE_NEXT_CRASH: '1' })
    await h.exited
    await expect(stopTree(h.pid)).resolves.toBeUndefined()
  })

  it('treeRssBytes counts the whole group', async () => {
    const out: string[] = []
    const h = await start({}, out)
    await grandchildPid(out)
    expect(await treeRssBytes(h.pid)).toBeGreaterThan(10 * 1024 ** 2)
    await stopTree(h.pid)
    expect(await treeRssBytes(h.pid)).toBe(0)
  })

  it('waitReady rejects when aborted', async () => {
    const h = await start({ FAKE_NEXT_START_DELAY_MS: '5000' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(new Error('nope')), 100)
    await expect(waitReady(h.hiddenPort, 5_000, ac.signal)).rejects.toThrow('nope')
  })

  it('waitReady rejects on timeout', async () => {
    const h = await start({ FAKE_NEXT_START_DELAY_MS: '5000' })
    await expect(waitReady(h.hiddenPort, 300, new AbortController().signal)).rejects.toThrow(/within 300ms/)
  })

  it('exit code is reported when the child crashes', async () => {
    const h = await start({ FAKE_NEXT_CRASH: '1' })
    expect(await h.exited).toBe(1)
  })
})

describe('resolveNextBin', () => {
  it('prefers NAPDEV_NEXT_BIN', () => {
    expect(resolveNextBin('/x', { NAPDEV_NEXT_BIN: '/y/next' })).toBe('/y/next')
  })
  it('throws naming appDir when next is missing', () => {
    expect(() => resolveNextBin('/nonexistent-app-dir', {})).toThrow('/nonexistent-app-dir')
  })
})
