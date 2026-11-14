// Throwaway spike runner. node run.mjs [rowFilter]
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'

const here = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, ' '))
const HOLD_MS = +(process.env.HOLD_MS || 180000)
const PROXY = 4000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rows = []
for (const v of ['15', '16'])
  for (const [bundler, flag] of v === '15' ? [['webpack', ''], ['turbopack', '--turbopack']] : [['turbopack', ''], ['webpack', '--webpack']])
    for (const router of ['app', 'pages'])
      rows.push({ v, bundler, flag, router })
const filter = process.argv[2]
const results = []

async function runRow(row) {
  const name = `next${row.v}/${row.bundler}/${row.router}`
  const appDir = path.resolve(here, '../apps/next' + row.v)
  const srcFile = path.join(appDir, row.router === 'app' ? 'app/page.tsx' : 'pages/legacy.tsx')
  const url = `http://localhost:${PROXY}${row.router === 'app' ? '/' : '/legacy'}`
  const orig = fs.readFileSync(srcFile, 'utf8')
  const proxyLog = []
  const events = []
  const t0 = Date.now()
  const ev = (...a) => { const s = `+${((Date.now() - t0) / 1000).toFixed(1)}s ` + a.join(' '); events.push(s); console.log('  ', s) }
  const proxy = spawn('node', [path.join(here, 'proxy.mjs'), appDir, row.flag].filter((x) => x !== ''), { detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  proxy.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => proxyLog.push({ t: Date.now(), l })))
  proxy.stderr.on('data', () => {})
  const res = { name, pass: false, notes: [] }
  let browser
  try {
    for (let i = 0; i < 300 && !proxyLog.some((x) => x.l.includes('READY proxy')); i++) await sleep(500)
    if (!proxyLog.some((x) => x.l.includes('READY proxy'))) throw new Error('proxy never ready')
    browser = await chromium.launch()
    const page = await browser.newPage()
    let navs = 0, reqs = 0
    const wsInfo = []
    page.on('framenavigated', (f) => { if (f === page.mainFrame()) ev('framenavigated', f.url()) })
    page.on('load', () => { navs++; ev('LOAD (full page load #' + navs + ')') })
    page.on('request', (r) => { reqs++; ev('REQ', r.method(), r.url().replace(/^https?:\/\/[^/]+/, '').slice(0, 80)) })
    page.on('websocket', (ws) => {
      ev('WS open', ws.url()); wsInfo.push(ws.url())
      ws.on('framesent', (f) => ev('WS sent', String(f.payload).replace(/[^\x20-\x7e]/g, '.').slice(0, 100)))
      ws.on('framereceived', (f) => ev('WS recv', String(f.payload).replace(/[^\x20-\x7e]/g, '.').slice(0, 100)))
      ws.on('close', () => ev('WS close', ws.url()))
    })
    await page.goto(url, { waitUntil: 'load', timeout: 180000 })
    await page.waitForSelector('#t', { timeout: 120000 })
    await sleep(8000) // let HMR socket connect + settle
    ev('INITIAL text', await page.textContent('#t'))
    // ---- sleep
    const sleepStart = Date.now()
    const navsBefore = navs, reqsBefore = reqs
    proxy.kill('SIGUSR1')
    for (let i = 0; i < 60 && !proxyLog.some((x) => x.l.includes('SLEEPING')); i++) await sleep(500)
    ev('proxy SLEEPING; holding', HOLD_MS / 1000, 's')
    await sleep(HOLD_MS)
    const httpDuring = proxyLog.filter((x) => x.t >= sleepStart && / HTTP /.test(x.l))
    const upgradesDuring = proxyLog.filter((x) => x.t >= sleepStart && /UPGRADE/.test(x.l))
    ev('hold done: proxy HTTP reqs', httpDuring.length, 'navs', navs - navsBefore, 'browser reqs', reqs - reqsBefore, 'upgrades', upgradesDuring.length)
    const fails = []
    if (httpDuring.length) fails.push(`proxy saw ${httpDuring.length} HTTP request(s) during hold: ${httpDuring.map((x) => x.l.split(' HTTP ')[1]).join(', ')}`)
    if (upgradesDuring.length) fails.push(`${upgradesDuring.length} websocket upgrade(s) during hold (client reconnected while asleep)`)
    if (navs - navsBefore) fails.push(`${navs - navsBefore} navigation(s) during hold`)
    // ---- wake
    const navsAtWake = navs
    proxy.kill('SIGUSR2')
    for (let i = 0; i < 360 && !proxyLog.some((x) => x.t > sleepStart && x.l.includes('WOKE')); i++) await sleep(500)
    ev('proxy WOKE, watching for reload')
    for (let i = 0; i < 120 && navs === navsAtWake; i++) await sleep(500)
    await page.waitForLoadState('load').catch(() => {})
    await sleep(20000)
    const wakeNavs = navs - navsAtWake
    ev('wake navigations', wakeNavs)
    if (wakeNavs !== 1) fails.push(`expected exactly 1 reload after wake, saw ${wakeNavs}`)
    // ---- HMR edit
    await page.waitForSelector('#t', { timeout: 60000 })
    const navsPreEdit = navs
    fs.writeFileSync(srcFile, orig.replace('v1', 'v2'))
    try {
      await page.waitForFunction(() => document.querySelector('#t')?.textContent.includes('v2'), null, { timeout: 90000 })
      ev('HMR edit applied; navigations during edit:', navs - navsPreEdit)
      res.notes.push(`edit applied with ${navs - navsPreEdit} navigation(s)`)
    } catch { fails.push('edit not reflected within 90s') }
    res.wsPaths = [...new Set(wsInfo.map((u) => new URL(u).pathname))]
    res.fails = fails
    res.pass = fails.length === 0
  } catch (e) {
    res.fails = [`runner error: ${e.message}`]
  } finally {
    fs.writeFileSync(srcFile, orig)
    res.events = events
    try { await browser?.close() } catch {}
    try { proxy.kill('SIGTERM') } catch {}
    await sleep(6000)
    try { process.kill(-proxy.pid, 'SIGKILL') } catch {}
    try { execSync(`lsof -ti tcp:4000 -ti tcp:4001 | xargs kill -9 2>/dev/null || true`) } catch {}
  }
  return res
}

for (const row of rows) {
  if (filter && !`next${row.v}/${row.bundler}/${row.router}`.includes(filter)) continue
  console.log('=== ROW', row)
  const r = await runRow(row)
  console.log('RESULT', r.name, r.pass ? 'PASS' : 'FAIL', (r.fails || []).join(' | '))
  results.push(r)
  fs.writeFileSync(path.join(here, 'results.json'), JSON.stringify(results, null, 2))
}
console.log('\n| row | result |\n|---|---|')
for (const r of results) console.log(`| ${r.name} | ${r.pass ? 'PASS' : 'FAIL: ' + r.fails.join('; ')} |`)
