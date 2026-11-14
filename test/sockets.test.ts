import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { RELOAD_FRAME } from '../src/sockets.js'
import { startGateOnFakeNext, type GateOnFakeNext } from './helpers/gate.js'

let h: GateOnFakeNext | null = null
const clients: WebSocket[] = []
async function start(env?: Record<string, string>) {
  h = await startGateOnFakeNext(env)
  return h
}
afterEach(async () => {
  for (const c of clients.splice(0)) c.terminate()
  await h?.stop()
  h = null
})

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms))
function open(url: string, protocols?: string[], headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, protocols, { headers })
  clients.push(ws)
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}
function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(d.toString())))
}

describe('SocketHub', () => {
  it('an upgrade while asleep is held and does not wake', async () => {
    const { publicPort: pub, gate, sockets } = await start()
    const ws = await open(`ws://localhost:${pub}/_next/webpack-hmr`)
    await sleepMs(300)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(gate.snapshot().state).toBe('asleep')
    expect(sockets.browserCount()).toBe(1)
  })

  it('held sockets get RELOAD_FRAME then close code 1012 on wake, and a reconnect is bridged', async () => {
    const { url, wsUrl } = await start()
    const ws = await open(wsUrl)
    const frame = nextMessage(ws)
    const closed = once(ws, 'close')
    await fetch(url)
    expect(await frame).toBe(RELOAD_FRAME)
    expect((await closed)[0]).toBe(1012)
    const ws2 = await open(wsUrl)
    expect(JSON.parse(await nextMessage(ws2)).type).toBe('turbopack-connected')
  })

  it('an upgrade while waking is held and gets RELOAD_FRAME then 1012 once awake', async () => {
    const { url, wsUrl, gate } = await start({ FAKE_NEXT_START_DELAY_MS: '1000' })
    const req = fetch(url)
    await vi.waitFor(() => expect(gate.snapshot().state).toBe('waking'))
    const ws = await open(wsUrl)
    const frame = nextMessage(ws)
    const closed = once(ws, 'close')
    expect((await req).status).toBe(200)
    expect(await frame).toBe(RELOAD_FRAME)
    expect((await closed)[0]).toBe(1012)
  })

  it('accepts the Next 16 path and forwards path, query, Host, Origin, Cookie and subprotocol', async () => {
    const { url, publicPort: pub } = await start()
    await fetch(url)
    const ws = await open(`ws://localhost:${pub}/_next/hmr?id=abc`, ['p1', 'p2'],
      { origin: `http://localhost:${pub}`, cookie: 'a=1; b=2' })
    const msg = JSON.parse(await nextMessage(ws))
    expect(msg.type).toBe('turbopack-connected')
    expect(msg.data).toMatchObject({
      url: '/_next/hmr?id=abc', host: `localhost:${pub}`, origin: `http://localhost:${pub}`,
      cookie: 'a=1; b=2', protocol: 'p1,p2',
    })
    expect(ws.protocol).toBe('p1')
  })

  it('relays binary frames unchanged and keeps text as text', async () => {
    const { url, wsUrl } = await start()
    await fetch(url)
    const ws = await open(wsUrl)
    const first = await new Promise<[Buffer, boolean]>((r) => ws.once('message', (d, b) => r([d as Buffer, b])))
    expect(first[1]).toBe(false)
    const bytes = Buffer.from([0, 1, 2, 254, 255, 0x80, 0x7f])
    const echo = new Promise<[Buffer, boolean]>((r) => ws.once('message', (d, b) => r([d as Buffer, b])))
    ws.send(bytes, { binary: true })
    const [data, isBinary] = await echo
    expect(isBinary).toBe(true)
    expect(Buffer.compare(data, bytes)).toBe(0)
  })

  it('browser sockets survive sleep without a close event', async () => {
    const { url, wsUrl, gate } = await start()
    await fetch(url)
    const ws = await open(wsUrl)
    await nextMessage(ws)
    let closedEarly = false
    ws.once('close', () => { closedEarly = true })
    await gate.sleep('manual')
    await sleepMs(300)
    expect(closedEarly).toBe(false)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    // frames a held socket sends are dropped silently
    ws.send('ping')
    ws.send(Buffer.from([1, 2, 3]), { binary: true })
    await sleepMs(200)
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(gate.snapshot().state).toBe('asleep')
  })

  it('server frames count as activity; browser frames do not', async () => {
    const { url, wsUrl, gate } = await start()
    // childPid is the guard's; the body names fake-next's own pid
    const nextPid = Number(/pid=(\d+)/.exec(await (await fetch(url)).text())![1])
    const ws = await open(wsUrl)
    await nextMessage(ws)
    const spy = vi.spyOn(gate, 'noteServerFrame')
    const built = nextMessage(ws)
    process.kill(nextPid, 'SIGUSR2')
    expect(JSON.parse(await built).type).toBe('built')
    expect(spy).toHaveBeenCalledTimes(1)
    ws.send('ping')
    await sleepMs(200)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('closes the browser socket with 1012 when the upstream drops while awake', async () => {
    const { url, publicPort: pub, sockets } = await start()
    await fetch(url)
    // fake-next destroys upgrades on paths it does not serve
    const ws = await open(`ws://localhost:${pub}/not-hmr`)
    const [code] = await once(ws, 'close')
    expect(code).toBe(1012)
    await vi.waitFor(() => expect(sockets.browserCount()).toBe(0))
  })

  it('close() terminates every browser socket', async () => {
    const { wsUrl, sockets } = await start()
    const ws = await open(wsUrl)
    const closed = once(ws, 'close')
    await sockets.close()
    await closed
    expect(sockets.browserCount()).toBe(0)
  })
})
