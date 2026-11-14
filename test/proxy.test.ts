import { createHash, randomBytes } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Gate } from '../src/gate.js'
import { LogTail } from '../src/logs.js'
import { findHiddenPort } from '../src/port.js'
import { createGateServer, listenPublic } from '../src/proxy.js'
import { SocketHub } from '../src/sockets.js'
import { startGateOnFakeNext, type GateOnFakeNext } from './helpers/gate.js'

let h: GateOnFakeNext | null = null
async function start(env?: Record<string, string>, config?: Parameters<typeof startGateOnFakeNext>[1]) {
  h = await startGateOnFakeNext(env, config)
  return h
}
afterEach(async () => {
  await h?.stop()
  h = null
})
const sha = (s: string) => createHash('sha256').update(s).digest('hex')

describe('gate server', () => {
  it('wakes on the first request and forwards Host unchanged', async () => {
    const { publicPort: pub, gate } = await start()
    expect(gate.snapshot().state).toBe('asleep')
    const r = await fetch(`http://localhost:${pub}/a`)
    const body = await r.text()
    expect(r.status).toBe(200)
    expect(body).toContain(`host=localhost:${pub}`)
    expect(body).toContain('path=/a')
    expect(body).toContain(`public=${pub}`)
    expect(gate.snapshot().state).toBe('awake')
  })

  it('delivers a 5 MB POST body sent while waking', async () => {
    const { url, gate } = await start({ FAKE_NEXT_START_DELAY_MS: '1500' })
    const payload = randomBytes(2.5 * 1024 * 1024).toString('hex')
    const r = await fetch(url, { method: 'POST', body: payload })
    const text = await r.text()
    expect(r.status).toBe(200)
    expect(sha(text.slice(text.indexOf('\nbody=') + 6))).toBe(sha(payload))
    expect(gate.snapshot().inFlight).toBe(0)
  })

  it('releases in-flight count when the client aborts during wake', async () => {
    const { url, gate } = await start({ FAKE_NEXT_START_DELAY_MS: '1500' })
    const ac = new AbortController()
    const p = fetch(url, { signal: ac.signal }).catch(() => {})
    await vi.waitFor(() => {
      expect(gate.snapshot().state).toBe('waking')
      expect(gate.snapshot().inFlight).toBe(1)
    })
    ac.abort()
    await p
    await vi.waitFor(() => expect(gate.snapshot().inFlight).toBe(0))
    // the wake still completes and the gate stays usable
    await vi.waitFor(() => expect(gate.snapshot().state).toBe('awake'), { timeout: 5_000 })
    await new Promise((r) => setTimeout(r, 100))
    expect(gate.snapshot().inFlight).toBe(0)
    expect((await fetch(url)).status).toBe(200)
  })

  it('streams without buffering and is not cut by idle', async () => {
    const { url, gate } = await start({}, { idleMs: 1_000 })
    await (await fetch(url)).text()
    const t0 = Date.now()
    const r = await fetch(`${url}stream`)
    const reader = r.body!.getReader()
    const decoder = new TextDecoder()
    let firstAt = 0
    let text = ''
    while (Date.now() - t0 < 3_000) {
      const { value, done } = await reader.read()
      if (done) break
      if (!firstAt) firstAt = Date.now()
      text += decoder.decode(value, { stream: true })
    }
    expect(firstAt - t0).toBeLessThan(500)
    expect(text.split('chunk\n').length - 1).toBeGreaterThanOrEqual(20)
    expect(gate.snapshot().state).toBe('awake')
    await reader.cancel()
    await vi.waitFor(() => expect(gate.snapshot().inFlight).toBe(0))
  })

  it('the first request after a sleep succeeds', async () => {
    const { url, gate } = await start()
    await (await fetch(url)).text()
    const first = gate.snapshot().childPid
    await gate.sleep('manual')
    const r = await fetch(url)
    expect(r.status).toBe(200)
    expect(await r.text()).not.toContain(`pid=${first} `)
  })

  it('answers on both 127.0.0.1 and ::1', async () => {
    const { publicPort: pub } = await start()
    expect((await fetch(`http://127.0.0.1:${pub}/`)).status).toBe(200)
    expect((await fetch(`http://[::1]:${pub}/`)).status).toBe(200)
  })

  it('returns 502 with the log tail and the bypass hint when Next cannot start', async () => {
    const { url } = await start({ FAKE_NEXT_CRASH: '1' })
    const r = await fetch(url)
    expect(r.status).toBe(502)
    expect(r.headers.get('content-type')).toContain('text/plain')
    const text = await r.text()
    expect(text.startsWith('napdev: Next.js could not start\n\n')).toBe(true)
    expect(text).toContain('fake-next: crashing on purpose')
    expect(text.endsWith('\n\nRun with NAPDEV=0 to bypass napdev.\n')).toBe(true)
  })

  it('returns 504 when Next does not start within the wake timeout', async () => {
    const { url } = await start({ FAKE_NEXT_START_DELAY_MS: '5000' }, { wakeTimeoutMs: 1_000 })
    const r = await fetch(url)
    expect(r.status).toBe(504)
    expect(await r.text()).toBe('napdev: Next.js did not start within 1 s\n')
  })

  it('returns 502 with the log tail when the upstream refuses after the wake', async () => {
    const hiddenPort = await findHiddenPort() // nothing listens here
    const tail = new LogTail()
    tail.push('next: last words\n')
    const gate = {
      config: { idleMs: 60_000, wakeTimeoutMs: 10_000, pin: false },
      noteHttpStart: vi.fn(), noteHttpEnd: vi.fn(),
      ensureAwake: () => Promise.resolve(hiddenPort),
    } as unknown as Gate
    const sockets = new SocketHub(gate)
    const server = createGateServer({ gate, sockets, tail })
    await listenPublic(server, 0, null)
    try {
      const r = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`)
      expect(r.status).toBe(502)
      expect(await r.text()).toBe('napdev: Next.js could not start\n\nnext: last words\n\nRun with NAPDEV=0 to bypass napdev.\n')
      await vi.waitFor(() => expect(gate.noteHttpEnd).toHaveBeenCalledTimes(1))
      expect(gate.noteHttpStart).toHaveBeenCalledTimes(1)
    } finally {
      await sockets.close()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    }
  })

  it('notes the end of each request exactly once', async () => {
    const { url, gate } = await start()
    await (await fetch(url)).text()
    const end = vi.spyOn(gate, 'noteHttpEnd')
    await (await fetch(url, { method: 'POST', body: 'x' })).text()
    const ac = new AbortController()
    const r = await fetch(`${url}stream`, { signal: ac.signal })
    await r.body!.getReader().read()
    ac.abort()
    await vi.waitFor(() => expect(gate.snapshot().inFlight).toBe(0))
    await new Promise((r) => setTimeout(r, 100))
    expect(end).toHaveBeenCalledTimes(2)
  })
})
