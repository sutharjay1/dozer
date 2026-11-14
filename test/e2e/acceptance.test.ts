// The spec's "Done means", on three real Next.js 16 apps in one pnpm workspace.
// Slow tests (20 s idle, 61 s maxAwake gap, 90 s browser hold) each run once.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  APPS, appView, coordinatorProcesses, ctrlC, gateProcesses, killEverything, makeHome, napdev, nextProcesses,
  nextTrees, pagePath, pgrep, PORTS, portFree, prepareWorkspace, resetPage, rssBytes, sleepMs, startApps, until,
  CLI, type Group,
} from './harness.js'

const ws = prepareWorkspace()
const measured: Record<string, unknown> = {}
const note = (key: string, value: unknown) => {
  measured[key] = value
  console.log(`[e2e] ${key}: ${JSON.stringify(value)}`)
}
const url = (app: keyof typeof PORTS) => `http://localhost:${PORTS[app]}/`

async function visit(app: keyof typeof PORTS): Promise<number> {
  const t0 = performance.now()
  const res = await fetch(url(app))
  const body = await res.text()
  const ms = Math.round(performance.now() - t0)
  expect(res.status).toBe(200)
  expect(body).toContain(`app ${app} v1`)
  return ms
}

async function expectAllGone(): Promise<void> {
  await until(() => nextProcesses(ws).length === 0 && gateProcesses().length === 0, 20_000, 'every process to exit')
  for (const app of APPS) expect(await portFree(PORTS[app])).toBe(true)
}

let group: Group | null = null

beforeAll(async () => {
  expect(nextProcesses(ws)).toEqual([])
  expect(gateProcesses()).toEqual([])
  for (const app of APPS) expect(await portFree(PORTS[app]), `port ${PORTS[app]} is taken`).toBe(true)
})

afterAll(async () => {
  for (const app of APPS) resetPage(ws, app)
  if (group) await ctrlC(group).catch(() => {})
  // the coordinator lingers 10 s after the last gate leaves, then exits by itself
  await until(() => coordinatorProcesses().length === 0, 20_000, 'the coordinator to exit').catch(() => {})
  const left = { next: nextProcesses(ws), gates: gateProcesses(), coordinator: coordinatorProcesses() }
  const grep = {
    'next-server': pgrep('next-server'), 'fake-next': pgrep('fake-next'), 'dist/cli.cjs': pgrep(CLI),
    __coordinator: pgrep('__coordinator'), workspace: pgrep(ws),
  }
  console.log(`[e2e] measured: ${JSON.stringify(measured)}`)
  writeFileSync(join(ws, 'measured.json'), JSON.stringify(measured, null, 2) + '\n')
  console.log(`[e2e] afterAll pgrep: ${JSON.stringify(grep)}`)
  const ports = Object.fromEntries(await Promise.all(APPS.map(async (a) => [PORTS[a], await portFree(PORTS[a])])))
  console.log(`[e2e] ports free: ${JSON.stringify(ports)}`)
  killEverything(ws)
  expect(left).toEqual({ next: [], gates: [], coordinator: [] })
  expect([grep['fake-next'], grep['dist/cli.cjs'], grep.__coordinator, grep.workspace]).toEqual([[], [], [], []])
  expect(Object.values(ports).every(Boolean)).toBe(true)
})

describe('three gated apps, idle 20 s', () => {
  const home = makeHome()

  beforeAll(async () => {
    group = await startApps(ws, home, { NAPDEV_IDLE: '20s' })
  })

  afterAll(async () => {
    if (group) await ctrlC(group)
    group = null
    await expectAllGone()
  })

  it('with none visited there is no Next process and each gate is under 60 MB', async () => {
    await until(() => appViewCount(home) === 3, 10_000, 'three apps registered')
    await sleepMs(5_000) // past start-up: the coordinator connection and the first report are done
    expect(nextProcesses(ws)).toEqual([])
    const gates = gateProcesses()
    expect(gates).toHaveLength(3)
    const rss = gates.map((g) => rssBytes(g.pid))
    note('sleeping gate RSS MB', rss.map((b) => +(b / 1024 ** 2).toFixed(1)))
    const coord = coordinatorProcesses()
    expect(coord).toHaveLength(1)
    note('coordinator RSS MB', +(rssBytes(coord[0]!.pid) / 1024 ** 2).toFixed(1))
    for (const b of rss) expect(b).toBeLessThan(60 * 1024 ** 2)
  })

  it('visiting one app leaves exactly one Next tree', async () => {
    note('wake a (first in this run) ms', await visit('a'))
    expect(nextTrees(ws)).toHaveLength(1)
    expect(appView(home, 'a')?.state).toBe('awake')
  })

  it('after idle there is none', async () => {
    await sleepMs(30_000)
    expect(nextProcesses(ws)).toEqual([])
    expect(appView(home, 'a')?.state).toBe('asleep')
  })
})

function appViewCount(home: string): number {
  try { return APPS.filter((a) => appView(home, a)).length } catch { return 0 }
}

describe('three gated apps, maxAwake 1, idle 10 min', () => {
  const home = makeHome()
  let browser: Browser | null = null

  beforeAll(async () => {
    group = await startApps(ws, home, { NAPDEV_IDLE: '10m', NAPDEV_MAX_AWAKE: '1' })
    await until(() => appViewCount(home) === 3, 10_000, 'three apps registered')
  })

  afterAll(async () => {
    await browser?.close()
    resetPage(ws, 'a')
  })

  it('with maxAwake=1, visiting a then b 60 s apart leaves one tree once b has answered', async () => {
    note('wake a (warm) ms', await visit('a'))
    const awake = appView(home, 'a')
    note('awake a tree RSS MB (status)', Math.round((awake?.rssBytes ?? 0) / 1024 ** 2))
    await sleepMs(61_000)
    note('wake b ms', await visit('b'))
    await until(() => nextTrees(ws).length === 1, 30_000, 'one Next tree')
    expect(nextTrees(ws)).toHaveLength(1)
    expect(appView(home, 'a')?.state).toBe('asleep')
    expect(appView(home, 'b')?.state).toBe('awake')
  })

  it('a background tab neither wakes nor reloads a sleeping app, and HMR works after wake', async () => {
    browser = await chromium.launch()
    const page = await browser.newPage()
    let loads = 0
    page.on('load', () => { loads++ })
    await page.goto(url('a'), { waitUntil: 'load' })
    await page.getByText('app a v1').waitFor({ timeout: 60_000 })
    await sleepMs(3_000) // the dev websocket is connected
    expect(napdev(home, 'sleep', 'e2e-a')).toContain('Asleep:')
    await until(() => appView(home, 'a')?.state === 'asleep', 30_000, 'a asleep')
    const before = { loads, lastHttpAt: appView(home, 'a')?.lastHttpAt }

    await sleepMs(90_000)
    const a = appView(home, 'a')
    note('loads during 90 s hold', loads - before.loads)
    expect(loads - before.loads).toBe(0)
    expect(a?.state).toBe('asleep')
    expect(a?.lastHttpAt).toBe(before.lastHttpAt) // no HTTP request reached the gate
    // b is still awake: with a asleep it is the only awake app, within maxAwake=1
    expect(appView(home, 'b')?.state).toBe('awake')
    expect(nextTrees(ws)).toHaveLength(1)

    const t0 = performance.now()
    await page.reload({ waitUntil: 'load' })
    await page.getByText('app a v1').waitFor({ timeout: 60_000 })
    note('reload-to-text after sleep ms', Math.round(performance.now() - t0))
    expect(appView(home, 'a')?.state).toBe('awake')
    await sleepMs(3_000) // let the new page's dev websocket connect
    const afterWake = loads

    const src = readFileSync(pagePath(ws, 'a'), 'utf8')
    try {
      writeFileSync(pagePath(ws, 'a'), src.replace('app a v1', 'app a v2'))
      const t1 = performance.now()
      await page.getByText('app a v2').waitFor({ timeout: 30_000 })
      note('edit-to-text ms', Math.round(performance.now() - t1))
      note('full loads caused by the edit', loads - afterWake)
    } finally {
      resetPage(ws, 'a')
    }
  })

  it('Ctrl+C leaves no process and frees the ports', async () => {
    expect(nextTrees(ws).length).toBeGreaterThan(0) // a is awake, so a real tree has to be stopped
    const code = await ctrlC(group!)
    group = null
    note('pnpm exit code after SIGINT', code)
    await expectAllGone()
  })
})
