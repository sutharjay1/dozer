import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { findHiddenPort } from '../src/port.js'
import {
  childEnv, psRunner, resolveNextBin, spawnChild, stopTree, treeRssBytes, waitReady, type ChildHandle,
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

  it('waitReady resolves only once next listens', async () => {
    const h = await start({ FAKE_NEXT_START_DELAY_MS: '800' })
    const t0 = Date.now()
    await waitReady(h.hiddenPort, 5_000, new AbortController().signal)
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
  })

  it('waitReady connects but sends no request', async () => {
    const got: Buffer[] = []
    const server = net.createServer((s) => s.on('data', (d: Buffer) => got.push(d)))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()))
    try {
      await waitReady((server.address() as net.AddressInfo).port, 5_000, new AbortController().signal)
      await new Promise((r) => setTimeout(r, 200))
      expect(Buffer.concat(got).length).toBe(0)
    } finally {
      await new Promise<void>((r) => server.close(() => r()))
    }
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

describe('ps failure', () => {
  afterEach(() => vi.restoreAllMocks())
  it('stopTree fails closed when ps errors', async () => {
    const h = await start()
    vi.spyOn(psRunner, 'run').mockRejectedValue(new Error('ps failed: boom'))
    await expect(stopTree(h.pid, 100)).rejects.toThrow('ps failed')
    vi.restoreAllMocks()
  })
  it('treeRssBytes rejects when ps prints nothing', async () => {
    vi.spyOn(psRunner, 'run').mockRejectedValue(new Error('ps printed nothing'))
    await expect(treeRssBytes(1234)).rejects.toThrow('ps printed nothing')
  })
})

describe('childEnv', () => {
  it('sets the ports, and FORCE_COLOR only on a terminal the user has not configured', () => {
    expect(childEnv({ A: '1' }, 3000, 51000, false)).toEqual({ A: '1', NAPDEV_PUBLIC_PORT: '3000', PORT: '51000' })
    expect(childEnv({}, 3000, 51000, true).FORCE_COLOR).toBe('1')
    expect(childEnv({ FORCE_COLOR: '0' }, 3000, 51000, true).FORCE_COLOR).toBe('0')
    expect(childEnv({ NO_COLOR: '1' }, 3000, 51000, true).FORCE_COLOR).toBeUndefined()
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
