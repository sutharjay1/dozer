import net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { findHiddenPort, isPortFree, PortTakenError, resolvePublicPort } from '../src/port.js'

const open: net.Server[] = []
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))))
})

function occupy(port: number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(port, host, () => { open.push(s); resolve() })
  })
}
const args = (publicPort: number, portExplicit: boolean) => ({ publicPort, portExplicit, hostname: null, passthrough: [] })

describe('isPortFree', () => {
  it('true for a free port', async () => {
    expect(await isPortFree(await findHiddenPort(), null)).toBe(true)
  })
  it('detects 127.0.0.1 occupant', async () => {
    const p = await findHiddenPort(); await occupy(p, '127.0.0.1')
    expect(await isPortFree(p, null)).toBe(false)
  })
  it('detects wildcard occupant', async () => {
    const p = await findHiddenPort(); await occupy(p)
    expect(await isPortFree(p, null)).toBe(false)
  })
  it('detects ::1 occupant', async () => {
    const p = await findHiddenPort()
    try { await occupy(p, '::1') } catch { return } // no IPv6 here
    expect(await isPortFree(p, null)).toBe(false)
  })
})

describe('resolvePublicPort', () => {
  it('explicit and taken throws', async () => {
    const p = await findHiddenPort(); await occupy(p)
    await expect(resolvePublicPort(args(p, true))).rejects.toBeInstanceOf(PortTakenError)
  })
  it('explicit and free returns it', async () => {
    const p = await findHiddenPort()
    expect(await resolvePublicPort(args(p, true))).toBe(p)
  })
  it('not explicit moves up', async () => {
    const p = await findHiddenPort(); await occupy(p)
    expect(await resolvePublicPort(args(p, false))).toBe(p + 1)
  })
  it('not explicit throws after 11 taken ports', async () => {
    const p = await findHiddenPort()
    for (let i = 0; i <= 10; i++) {
      try { await occupy(p + i) } catch { return } // can't hold the whole range; skip
    }
    await expect(resolvePublicPort(args(p, false))).rejects.toMatchObject({ name: 'PortTakenError', port: p })
  })
})

describe('findHiddenPort', () => {
  it('returns a usable port', async () => {
    const p = await findHiddenPort()
    expect(p).toBeGreaterThan(0)
    await occupy(p, '127.0.0.1')
  })
})
