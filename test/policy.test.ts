import { describe, expect, it } from 'vitest'
import { chooseVictims } from '../src/coordinator/policy.js'
import type { AppView } from '../src/coordinator/protocol.js'

const app = (id: string, lastHttpAt: number | null, extra: Partial<AppView> = {}): AppView => ({
  id, name: id, cwd: `/apps/${id}`, publicPort: 3000, pid: 1, pinned: false,
  state: 'awake', inFlight: 0, lastHttpAt, lastActiveAt: lastHttpAt, rssBytes: 0, ...extra,
})

const L = { maxAwake: 2, memoryBudgetBytes: null, graceMs: 60_000 }

describe('chooseVictims', () => {
  it('chooses nobody at the limit', () => {
    expect(chooseVictims([app('a', 0), app('b', 1_000)], L, 500_000)).toEqual([])
  })
  it('chooses the least recently used app over the limit', () => {
    expect(chooseVictims([app('a', 0), app('b', 1_000), app('c', 400_000)], L, 500_000)).toEqual(['a'])
  })
  it('never chooses a pinned app', () => {
    expect(chooseVictims([app('a', 0, { pinned: true }), app('b', 1_000), app('c', 400_000)], L, 500_000)).toEqual(['b'])
  })
  it('is soft: in-flight and recently used apps are spared', () => {
    expect(chooseVictims([app('a', 0, { inFlight: 1 }), app('b', 480_000), app('c', 490_000)], L, 500_000)).toEqual([])
  })
  it('enforces the memory budget', () => {
    expect(chooseVictims([app('a', 0, { rssBytes: 6e9 }), app('b', 1_000, { rssBytes: 6e9 })],
      { ...L, memoryBudgetBytes: 8e9 }, 500_000)).toEqual(['a'])
  })
  it('counts waking apps but never chooses them, and ignores asleep ones', () => {
    expect(chooseVictims([app('a', 0, { state: 'waking' }), app('b', 1_000), app('c', 2_000), app('d', 0, { state: 'asleep' })],
      L, 500_000)).toEqual(['b'])
  })
  it('spares an app woken just now even when it has never served a request', () => {
    expect(chooseVictims([app('a', 400_000), app('b', null, { lastActiveAt: 499_000 })], { ...L, maxAwake: 1 }, 500_000))
      .toEqual(['a'])
  })
  it('chooses several apps, oldest first, until under the limit', () => {
    expect(chooseVictims([app('c', 3_000), app('a', 1_000), app('b', null), app('d', 4_000)], { ...L, maxAwake: 1 }, 500_000))
      .toEqual(['b', 'a', 'c'])
  })
})
