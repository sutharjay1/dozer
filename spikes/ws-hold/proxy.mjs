// Throwaway spike proxy. usage: node proxy.mjs <appDir> [bundlerFlag]
import http from 'node:http'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { WebSocketServer, WebSocket } from 'ws'

const [appDir, flag] = process.argv.slice(2)
const PORT = +(process.env.PROXY_PORT || 4000)
const UP = +(process.env.UPSTREAM_PORT || 4001)
const log = (...a) => console.log(new Date().toISOString(), ...a)

let child = null
let upstreamUp = false
const held = new Set() // { browser, upstream }

function startUpstream() {
  const args = ['next', 'dev', '-p', String(UP), ...(flag ? [flag] : [])]
  child = spawn('npx', args, { cwd: appDir, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } })
  child.stdout.on('data', (d) => process.stderr.write('[next] ' + d))
  child.stderr.on('data', (d) => process.stderr.write('[next] ' + d))
  child.on('exit', () => log('UPSTREAM exited'))
  return waitReady()
}
function waitReady() {
  return new Promise((res) => {
    const t = setInterval(() => {
      const s = net.connect(UP, '127.0.0.1')
      s.on('connect', () => { s.destroy(); clearInterval(t); upstreamUp = true; log('UPSTREAM ready'); res() })
      s.on('error', () => {})
    }, 300)
  })
}
function killUpstream() {
  upstreamUp = false
  return new Promise((res) => {
    if (!child) return res()
    const c = child; child = null
    try { process.kill(-c.pid, 'SIGTERM') } catch {}
    const t0 = Date.now()
    const t = setInterval(() => {
      let alive = true
      try { process.kill(-c.pid, 0) } catch { alive = false }
      if (!alive || Date.now() - t0 > 8000) {
        if (alive) try { process.kill(-c.pid, 'SIGKILL') } catch {}
        clearInterval(t); res()
      }
    }, 200)
  })
}

const server = http.createServer((req, res) => {
  log('HTTP', req.method, req.url)
  if (!upstreamUp) { res.statusCode = 503; return res.end('upstream down') }
  const u = http.request({ host: '127.0.0.1', port: UP, path: req.url, method: req.method, headers: req.headers }, (ur) => {
    res.writeHead(ur.statusCode, ur.headers); ur.pipe(res)
  })
  u.on('error', () => { res.statusCode = 502; res.end() })
  req.pipe(u)
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, sock, head) => {
  log('UPGRADE', req.url, upstreamUp ? '(bridged)' : '(held, upstream down)')
  wss.handleUpgrade(req, sock, head, (browser) => {
    const entry = { browser, upstream: null }
    held.add(entry)
    browser.on('close', (code) => { held.delete(entry); log('BROWSER-WS closed', code) })
    browser.on('error', () => {})
    browser.on('message', (data, isBinary) => {
      if (entry.upstream && entry.upstream.readyState === WebSocket.OPEN) entry.upstream.send(data, { binary: isBinary })
      else log('DROP browser msg while upstream down')
    })
    if (upstreamUp) connectUp(entry, req)
  })
})
function connectUp(entry, req) {
  const h = { ...req.headers }; delete h['sec-websocket-key']; delete h['sec-websocket-extensions']; delete h.upgrade; delete h.connection; delete h['sec-websocket-version']
  const up = new WebSocket(`ws://127.0.0.1:${UP}${req.url}`, { headers: h })
  entry.upstream = up
  up.on('message', (d, isBinary) => { if (entry.browser.readyState === WebSocket.OPEN) entry.browser.send(d, { binary: isBinary }) })
  up.on('close', () => { entry.upstream = null }) // silent: never propagate to browser
  up.on('error', () => {})
}

process.on('SIGUSR1', async () => {
  log('SIGUSR1: sleeping upstream')
  for (const e of held) { if (e.upstream) { const u = e.upstream; e.upstream = null; u.terminate() } }
  await killUpstream()
  log('SLEEPING')
})
process.on('SIGUSR2', async () => {
  log('SIGUSR2: waking upstream')
  await startUpstream()
  log('closing', held.size, 'held sockets with 1012')
  const mode = process.env.WAKE_MODE || 'close' // close | reload | both
  if (mode !== 'close') for (const e of [...held]) { try { e.browser.send(JSON.stringify({ action: 'reloadPage', type: 'reloadPage' })) } catch {} }
  if (mode !== 'reload') for (const e of [...held]) e.browser.close(1012, 'upstream restarted')
  log('WOKE')
})
const bye = async () => { await killUpstream(); process.exit(0) }
process.on('SIGTERM', bye); process.on('SIGINT', bye)

await startUpstream()
server.listen(PORT, '127.0.0.1', () => log('READY proxy', PORT, '->', UP))
