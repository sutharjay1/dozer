// Unit tests for the formatters and matcher, plus end-to-end runs of the built CLI against a real daemon.
import { execFile } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import { matchApps } from '../src/commands/control.js'
import { formatAgo, formatRss, formatTable } from '../src/commands/status.js'
import type { AppView } from '../src/coordinator/protocol.js'
import { CLI, home, list, startCli, states } from './helpers/coordinator.js'

const NOW = 1_000_000_000_000
const view = (over: Partial<AppView>): AppView => ({
  id: 'aaaaaaaaaaaa', name: 'repo/app @ main', cwd: '/x', publicPort: 3000, pid: 1, pinned: false, graceMs: 60_000,
  state: 'asleep', inFlight: 0, lastHttpAt: null, lastActiveAt: null, rssBytes: 0, ...over,
})

describe('formatAgo', () => {
  it('says never, seconds, minutes and hours', () => {
    expect(formatAgo(null, NOW)).toBe('never')
    expect(formatAgo(NOW - 5_000, NOW)).toBe('5s ago')
    expect(formatAgo(NOW - 59_999, NOW)).toBe('59s ago')
    expect(formatAgo(NOW - 60_000, NOW)).toBe('1m ago')
    expect(formatAgo(NOW - 3 * 60_000, NOW)).toBe('3m ago')
    expect(formatAgo(NOW - 3_599_000, NOW)).toBe('59m ago')
    expect(formatAgo(NOW - 3_600_000, NOW)).toBe('1h ago')
    expect(formatAgo(NOW - 50 * 3_600_000, NOW)).toBe('50h ago')
  })
  it('never goes negative when the clock is behind', () => {
    expect(formatAgo(NOW + 5_000, NOW)).toBe('0s ago')
  })
})

describe('formatRss', () => {
  it('rounds to whole MB and dashes when asleep or zero', () => {
    expect(formatRss(412.4 * 1024 * 1024, 'awake')).toBe('412 MB')
    expect(formatRss(412.6 * 1024 * 1024, 'waking')).toBe('413 MB')
    expect(formatRss(412 * 1024 * 1024, 'asleep')).toBe('-')
    expect(formatRss(0, 'awake')).toBe('-')
  })
})

describe('formatTable', () => {
  it('pads to the widest value, orders awake, waking, asleep, then by name', () => {
    const MB = 1024 * 1024
    const out = formatTable([
      view({ name: 'z/asleep @ main', state: 'asleep', publicPort: 3003 }),
      view({ name: 'b/waking @ main', state: 'waking', publicPort: 3002 }),
      view({ name: 'm/two @ main', state: 'awake', publicPort: 3001, rssBytes: 412 * MB, lastHttpAt: NOW - 180_000, pinned: true }),
      view({ name: 'a/one @ main', state: 'awake', publicPort: 41000, rssBytes: 90 * MB, lastHttpAt: NOW - 4_000 }),
    ], NOW)
    expect(out.split('\n')).toEqual([
      'NAME             STATE           PORT   RSS     LAST REQUEST',
      'a/one @ main     awake           41000  90 MB   4s ago',
      'm/two @ main     awake (pinned)  3001   412 MB  3m ago',
      'b/waking @ main  waking          3002   -       never',
      'z/asleep @ main  asleep          3003   -       never',
    ])
  })
  it('has no color codes and no trailing spaces', () => {
    const out = formatTable([view({})], NOW)
    expect(out).not.toMatch(/\u001b/)
    expect(out.split('\n').every((l: string) => l === l.trimEnd())).toBe(true)
  })
})

describe('matchApps', () => {
  const apps = [
    view({ id: '0123456789ab', name: 'r/web @ main' }),
    view({ id: 'ba9876543210', name: 'r/webhooks @ main' }),
    view({ id: 'cccccccccccc', name: 'r/API @ dev' }),
  ]
  it('matches a unique substring, case-insensitively', () => {
    expect(matchApps(apps, 'api')).toEqual({ kind: 'one', app: apps[2] })
  })
  it('reports several matches', () => {
    expect(matchApps(apps, 'WEB')).toEqual({ kind: 'many', apps: [apps[0], apps[1]] })
  })
  it('lets an exact name win over substring matches', () => {
    expect(matchApps(apps, 'R/WEB @ MAIN')).toEqual({ kind: 'one', app: apps[0] })
  })
  it('matches an id exactly', () => {
    expect(matchApps(apps, 'ba9876543210')).toEqual({ kind: 'one', app: apps[1] })
    expect(matchApps(apps, 'ba98765432')).toEqual({ kind: 'none' })
  })
  it('reports no match', () => {
    expect(matchApps(apps, 'nope')).toEqual({ kind: 'none' })
  })
})

interface Ran { code: number; out: string; err: string }
function run(...args: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, DOZER_HOME: home } }, (error, out, err) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, out, err })
    })
  })
}

describe('status, sleep and wake against a real daemon', { timeout: 40_000 }, () => {
  it('status with no coordinator exits 0', async () => {
    expect(await run('status')).toEqual({ code: 0, out: 'No dozer apps are running.\n', err: '' })
    expect(await run('status', '--json')).toMatchObject({ code: 0, out: '[]\n' })
  })

  it('sleep and wake with no coordinator exit 1', async () => {
    expect(await run('sleep', '--all')).toMatchObject({ code: 1, out: '', err: 'No dozer apps are running.\n' })
    expect(await run('wake', 'web')).toMatchObject({ code: 1, out: '', err: 'No dozer apps are running.\n' })
  })

  it('status lists a sleeping app', async () => {
    const web = await startCli('web')
    await vi.waitFor(async () => expect(await list()).toHaveLength(1))
    const r = await run('status')
    expect(r.code).toBe(0)
    const [header, row] = r.out.trimEnd().split('\n')
    expect(header).toMatch(/^NAME\s+STATE\s+PORT\s+RSS\s+LAST REQUEST$/)
    expect(row).toMatch(new RegExp(`/web @ -\\s+asleep\\s+${web.port}\\s+-\\s+never$`))
    expect(r.out).not.toMatch(/\u001b/)
  })

  it('status --json returns AppView objects', async () => {
    const web = await startCli('web')
    await vi.waitFor(async () => expect(await list()).toHaveLength(1))
    const r = await run('status', '--json')
    expect(JSON.parse(r.out)[0]).toMatchObject({ state: 'asleep', publicPort: web.port })
    expect(r.out).toBe(JSON.stringify(await list(), null, 2) + '\n')
  })

  it('wake then sleep changes the state', async () => {
    await startCli('web')
    await startCli('api')
    await vi.waitFor(async () => expect(await list()).toHaveLength(2))
    expect(await run('wake', 'WEB')).toMatchObject({ code: 0, out: expect.stringMatching(/^Awake: .*\/web @ -\n$/) })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ api: 'asleep', web: 'awake' }), { timeout: 10_000, interval: 100 })
    const status = await run('status')
    expect(status.out).toMatch(/\/web @ -\s+awake\s+\d+\s+\d+ MB\s+never/)
    expect(await run('sleep', 'web')).toMatchObject({ code: 0, out: expect.stringMatching(/^Asleep: .*\/web @ -\n$/) })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ api: 'asleep', web: 'asleep' }), { timeout: 10_000, interval: 100 })
  })

  it('sleep and wake succeed when the app is already there', async () => {
    await startCli('web')
    await vi.waitFor(async () => expect(await list()).toHaveLength(1))
    expect(await run('sleep', 'web')).toMatchObject({ code: 0, out: expect.stringMatching(/^Asleep: .*\/web @ -\n$/) })
    await run('wake', 'web')
    await vi.waitFor(async () => expect(states(await list())).toEqual({ web: 'awake' }), { timeout: 10_000, interval: 100 })
    expect(await run('wake', 'web')).toMatchObject({ code: 0, out: expect.stringMatching(/^Awake: .*\/web @ -\n$/) })
  })

  it('sleep --all puts every app to sleep', async () => {
    await startCli('web')
    await vi.waitFor(async () => expect(await list()).toHaveLength(1))
    await run('wake', 'web')
    await vi.waitFor(async () => expect(states(await list())).toEqual({ web: 'awake' }), { timeout: 10_000, interval: 100 })
    expect(await run('sleep', '--all')).toEqual({ code: 0, out: 'Asleep: 1 app(s)\n', err: '' })
    await vi.waitFor(async () => expect(states(await list())).toEqual({ web: 'asleep' }), { timeout: 10_000, interval: 100 })
  })

  it('an ambiguous name exits 1 and lists the candidates', async () => {
    await startCli('web-one')
    await startCli('web-two')
    await startCli('api')
    await vi.waitFor(async () => expect(await list()).toHaveLength(3))
    const r = await run('sleep', 'web')
    expect(r.code).toBe(1)
    expect(r.out + r.err).toMatch(/^"web" matches several apps:\n.*web-one.*\n.*web-two.*\n$/)
    expect(r.out + r.err).not.toContain('api')
  })

  it('an unknown name exits 1 and lists the running apps', async () => {
    await startCli('web')
    await vi.waitFor(async () => expect(await list()).toHaveLength(1))
    const r = await run('wake', 'nope')
    expect(r.code).toBe(1)
    expect(r.out + r.err).toMatch(/^No dozer app matches "nope"\. Running apps:\n.*\/web @ -\n$/)
  })

  it('unknown flags and a missing name print usage and exit 1', async () => {
    for (const args of [['status', '--bogus'], ['sleep'], ['wake'], ['sleep', '--bogus'], ['wake', 'a', 'b'], ['sleep', '--all', 'x']]) {
      const r = await run(...args)
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.out).toBe('')
      expect(r.err).toMatch(/^usage: /)
    }
  })
})
