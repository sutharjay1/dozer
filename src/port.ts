import net from 'node:net'
import type { DevArgs } from './args.js'

export class PortTakenError extends Error {
  constructor(public port: number) {
    super(`port ${port} is already in use`)
    this.name = 'PortTakenError'
  }
}

type Probe = 'free' | 'taken' | 'unavailable'

function probe(port: number, host: string | undefined): Promise<Probe> {
  return new Promise((resolve) => {
    const s = net.createServer()
    s.once('error', (e: NodeJS.ErrnoException) => {
      resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? 'taken' : 'unavailable')
    })
    s.listen({ port, host, exclusive: true }, () => s.close(() => resolve('free')))
  })
}

// A port is free only if nothing listens on loopback v4, loopback v6, the wildcard, or the requested host.
export async function isPortFree(port: number, hostname: string | null): Promise<boolean> {
  const hosts: Array<string | undefined> = ['127.0.0.1', '::1', undefined]
  if (hostname && !hosts.includes(hostname)) hosts.push(hostname)
  for (const h of hosts) {
    if ((await probe(port, h)) === 'taken') return false
  }
  return true
}

export async function resolvePublicPort(args: DevArgs): Promise<number> {
  const last = args.portExplicit ? args.publicPort : Math.min(args.publicPort + 10, 65535)
  for (let p = args.publicPort; p <= last; p++) {
    if (await isPortFree(p, args.hostname)) return p
  }
  throw new PortTakenError(args.publicPort)
}

export function findHiddenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo
      s.close(() => resolve(port))
    })
  })
}
