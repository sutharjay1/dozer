export interface DevArgs { publicPort: number; portExplicit: boolean; hostname: string | null; passthrough: string[] }

function toPort(text: string | undefined, origin: string): number {
  const n = Number(text)
  if (text === undefined || !/^\d+$/.test(text) || n < 1 || n > 65535) {
    throw new Error(`invalid port "${text ?? ''}" from ${origin}`)
  }
  return n
}

export function parseDevArgs(argv: string[], env: NodeJS.ProcessEnv): DevArgs {
  let port: number | null = null
  let hostname: string | null = null
  const passthrough: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-p' || a === '--port') port = toPort(argv[++i], a)
    else if (a.startsWith('--port=')) port = toPort(a.slice(7), '--port')
    else if (a === '-H' || a === '--hostname') {
      const v = argv[++i]
      if (v === undefined) throw new Error(`${a} requires a value`)
      hostname = v
    } else if (a.startsWith('--hostname=')) hostname = a.slice(11)
    else passthrough.push(a)
  }
  if (port === null && env.PORT) port = toPort(env.PORT, 'PORT')
  return { publicPort: port ?? 3000, portExplicit: port !== null, hostname, passthrough }
}
