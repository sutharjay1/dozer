import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULTS = {
  idleMs: 600_000,
  wakeTimeoutMs: 120_000,
  wsCeilingMs: 3_600_000,
  graceMs: 60_000,
  maxFailedWakes: 3,
  failedCooldownMs: 30_000,
  maxAwake: 2,
} as const

export interface AppConfig { idleMs: number; wakeTimeoutMs: number; pin: boolean }
export interface MachineConfig { maxAwake: number; memoryBudgetBytes: number | null; graceMs: number }

const UNITS: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }

export function parseDuration(text: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(String(text).trim())
  if (!m) throw new Error(`invalid duration "${text}" (use e.g. 500ms, 120s, 10m, 1h)`)
  return Math.round(Number(m[1]) * UNITS[m[2]!]!)
}

export function dozerHome(env: NodeJS.ProcessEnv): string {
  return env.DOZER_HOME || join(homedir(), '.dozer')
}

function readJson(file: string): Record<string, unknown> | null {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw new Error(`cannot read ${file}: ${(e as Error).message}`)
  }
  try {
    const v = JSON.parse(raw)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('expected an object')
    return v as Record<string, unknown>
  } catch (e) {
    throw new Error(`invalid JSON in ${file}: ${(e as Error).message}`)
  }
}

function duration(source: string, key: string, value: unknown, fallback: number): number {
  if (value === undefined) return fallback
  try {
    return parseDuration(String(value))
  } catch (e) {
    throw new Error(`${source} "${key}": ${(e as Error).message}`)
  }
}

function positiveNumber(source: string, key: string, value: unknown, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${source} "${key}": expected a positive number, got "${value}"`)
  return n
}

export function loadAppConfig(appDir: string, env: NodeJS.ProcessEnv): AppConfig {
  const file = join(appDir, 'package.json')
  const section = readJson(file)?.dozer
  const cfg = (section && typeof section === 'object' ? section : {}) as Record<string, unknown>
  const idle = env.DOZER_IDLE ?? cfg.idle
  const wake = env.DOZER_WAKE_TIMEOUT ?? cfg.wakeTimeout
  const src = env.DOZER_IDLE !== undefined ? 'DOZER_IDLE' : file
  const wsrc = env.DOZER_WAKE_TIMEOUT !== undefined ? 'DOZER_WAKE_TIMEOUT' : file
  return {
    idleMs: duration(src, 'idle', idle, DEFAULTS.idleMs),
    wakeTimeoutMs: duration(wsrc, 'wakeTimeout', wake, DEFAULTS.wakeTimeoutMs),
    pin: env.DOZER_PIN === '1' ? true : env.DOZER_PIN === '0' ? false : cfg.pin === true,
  }
}

export function loadMachineConfig(home: string, env: NodeJS.ProcessEnv): MachineConfig {
  const file = join(home, 'config.json')
  const cfg = readJson(file) ?? {}
  const maxAwake = positiveNumber(env.DOZER_MAX_AWAKE !== undefined ? 'DOZER_MAX_AWAKE' : file, 'maxAwake',
    env.DOZER_MAX_AWAKE ?? cfg.maxAwake, DEFAULTS.maxAwake)
  const budget = env.DOZER_MEMORY_BUDGET ?? cfg.memoryBudget
  const gb = positiveNumber(env.DOZER_MEMORY_BUDGET !== undefined ? 'DOZER_MEMORY_BUDGET' : file, 'memoryBudget', budget, 0)
  const graceMs = duration('DOZER_GRACE', 'grace', env.DOZER_GRACE, DEFAULTS.graceMs)
  return { maxAwake, memoryBudgetBytes: gb > 0 ? Math.round(gb * 1024 ** 3) : null, graceMs }
}
