// Stand-in for `next dev`, used by dozer tests. Not shipped.
import http from 'node:http'
import { spawn } from 'node:child_process'
import { randomInt } from 'node:crypto'
import { WebSocketServer } from 'ws'

const argv = process.argv.slice(2)
// last occurrence wins, like next dev; accepts the short aliases too
const opt = (names, fallback) => {
  let v = fallback
  for (let i = 0; i < argv.length; i++) if (names.includes(argv[i]) && argv[i + 1]) v = argv[i + 1]
  return v
}
const port = Number(opt(['--port', '-p'], process.env.PORT ?? '3000'))
const hostname = opt(['--hostname', '-H'], '127.0.0.1')

const delay = Number(process.env.FAKE_NEXT_START_DELAY_MS ?? 0)
if (delay > 0) await new Promise((r) => setTimeout(r, delay))
if (process.env.FAKE_NEXT_CRASH === '1') {
  console.error('fake-next: crashing on purpose')
  process.exit(1)
}

// One idle grandchild in the same process group, like Next's workers.
// FAKE_NEXT_STUBBORN_CHILD=1 makes it ignore SIGTERM, so only SIGKILL stops it.
const idle = process.env.FAKE_NEXT_STUBBORN_CHILD === '1'
  ? "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  : 'setInterval(() => {}, 1000)'
const grandchild = spawn(process.execPath, ['-e', idle], { stdio: 'ignore' })

const server = http.createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, { 'content-type': 'text/plain' })
    const t = setInterval(() => res.write('chunk\n'), 100)
    res.on('close', () => clearInterval(t))
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString()
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end(
      `fake-next pid=${process.pid} host=${req.headers.host} path=${req.url} public=${process.env.DOZER_PUBLIC_PORT ?? ''}` +
        (req.method === 'POST' ? `\nbody=${body}` : ''),
    )
  })
})

const wss = new WebSocketServer({ noServer: true })
const HMR_PATHS = new Set(['/_next/webpack-hmr', '/_next/hmr'])
const sessionId = randomInt(1, 2 ** 31)
server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '').split('?')[0]
  if (!HMR_PATHS.has(path)) return socket.destroy()
  wss.handleUpgrade(req, socket, head, (ws) => {
    const { host, origin, cookie } = req.headers
    const protocol = req.headers['sec-websocket-protocol']
    ws.send(JSON.stringify({ type: 'turbopack-connected', data: { sessionId, url: req.url, host, origin, cookie, protocol } }))
    // binary frames are echoed back unchanged; text frames are ignored
    ws.on('message', (data, isBinary) => { if (isBinary) ws.send(data, { binary: true }) })
  })
})
process.on('SIGUSR2', () => {
  for (const c of wss.clients) c.send(JSON.stringify({ type: 'built' }))
})
process.on('SIGTERM', () => process.exit(0))

server.listen(port, hostname, () => {
  console.log(`   - Local:        http://localhost:${port}`)
  console.log(`grandchild=${grandchild.pid}`)
})
