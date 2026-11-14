import { mkdtempSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULTS, loadAppConfig, loadMachineConfig, napdevHome, parseDuration } from '../src/config.js'

const tmp = () => mkdtempSync(join(tmpdir(), 'napdev-cfg-'))
const appWith = (napdev: unknown) => {
  const d = tmp()
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'x', napdev }))
  return d
}
const homeWith = (cfg: unknown) => {
  const d = tmp()
  writeFileSync(join(d, 'config.json'), JSON.stringify(cfg))
  return d
}

describe('parseDuration', () => {
  it('parses units', () => {
    expect(parseDuration('10m')).toBe(600_000)
    expect(parseDuration('120s')).toBe(120_000)
    expect(parseDuration('500ms')).toBe(500)
    expect(parseDuration('1h')).toBe(3_600_000)
  })
  it('throws on junk', () => {
    expect(() => parseDuration('soon')).toThrow()
    expect(() => parseDuration('10')).toThrow()
    expect(() => parseDuration('')).toThrow()
  })
})

describe('defaults', () => {
  it('has the documented values', () => {
    expect(DEFAULTS).toEqual({ idleMs: 600_000, wakeTimeoutMs: 120_000, wsCeilingMs: 3_600_000,
      graceMs: 60_000, maxFailedWakes: 3, failedCooldownMs: 30_000, maxAwake: 2 })
  })
})

describe('loadAppConfig', () => {
  it('defaults when package.json has no napdev key or is missing', () => {
    expect(loadAppConfig(tmp(), {})).toEqual({ idleMs: 600_000, wakeTimeoutMs: 120_000, pin: false })
    expect(loadAppConfig(appWith(undefined), {})).toEqual({ idleMs: 600_000, wakeTimeoutMs: 120_000, pin: false })
  })
  it('reads the napdev key', () => {
    expect(loadAppConfig(appWith({ idle: '2m', wakeTimeout: '30s', pin: true }), {}))
      .toEqual({ idleMs: 120_000, wakeTimeoutMs: 30_000, pin: true })
  })
  it('env wins', () => {
    expect(loadAppConfig(appWith({ idle: '2m' }), { NAPDEV_IDLE: '30s' }).idleMs).toBe(30_000)
    expect(loadAppConfig(tmp(), { NAPDEV_WAKE_TIMEOUT: '5s' }).wakeTimeoutMs).toBe(5_000)
    expect(loadAppConfig(tmp(), { NAPDEV_PIN: '1' }).pin).toBe(true)
    expect(loadAppConfig(appWith({ pin: true }), { NAPDEV_PIN: '0' }).pin).toBe(false)
    expect(loadAppConfig(appWith({ pin: false }), { NAPDEV_PIN: '1' }).pin).toBe(true)
    expect(loadAppConfig(appWith({ pin: true }), {}).pin).toBe(true)
  })
  it('invalid duration names the key', () => {
    expect(() => loadAppConfig(appWith({ idle: 'soon' }), {})).toThrow(/idle/)
  })
  it('invalid JSON names the file', () => {
    const d = tmp()
    writeFileSync(join(d, 'package.json'), '{nope')
    expect(() => loadAppConfig(d, {})).toThrow(/package\.json/)
  })
})

describe('loadMachineConfig', () => {
  it('defaults when file missing', () => {
    expect(loadMachineConfig(tmp(), {})).toEqual({ maxAwake: 2, memoryBudgetBytes: null, graceMs: 60_000 })
  })
  it('reads config.json', () => {
    expect(loadMachineConfig(homeWith({ memoryBudget: 8 }), {})).toEqual({ maxAwake: 2, memoryBudgetBytes: 8 * 1024 ** 3, graceMs: 60_000 })
    expect(loadMachineConfig(homeWith({ maxAwake: 4 }), {}).maxAwake).toBe(4)
  })
  it('env wins', () => {
    expect(loadMachineConfig(homeWith({ maxAwake: 4, memoryBudget: 8 }), { NAPDEV_MAX_AWAKE: '1', NAPDEV_MEMORY_BUDGET: '2' }))
      .toEqual({ maxAwake: 1, memoryBudgetBytes: 2 * 1024 ** 3, graceMs: 60_000 })
  })
  it('NAPDEV_GRACE overrides the grace period', () => {
    expect(loadMachineConfig(tmp(), { NAPDEV_GRACE: '1s' }).graceMs).toBe(1_000)
    expect(() => loadMachineConfig(tmp(), { NAPDEV_GRACE: 'soon' })).toThrow(/NAPDEV_GRACE/)
  })
  it('invalid JSON names the file', () => {
    const d = tmp()
    writeFileSync(join(d, 'config.json'), 'oops')
    expect(() => loadMachineConfig(d, {})).toThrow(/config\.json/)
  })
})

describe('napdevHome', () => {
  it('uses NAPDEV_HOME or ~/.napdev', () => {
    expect(napdevHome({ NAPDEV_HOME: '/x/y' })).toBe('/x/y')
    expect(napdevHome({})).toBe(join(homedir(), '.napdev'))
  })
})
