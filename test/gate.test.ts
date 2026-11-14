import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChildHandle } from '../src/child.js'
import { Gate, WakeFailedError, WakeTimeoutError, type GateDeps } from '../src/gate.js'

function fakeChild(port = 4100, pid = 111) {
  let exit!: (code: number | null) => void
  const exited = new Promise<number | null>((r) => { exit = r })
  const handle: ChildHandle = { pid, hiddenPort: port, exited }
  return { handle, exit }
}

let child: ReturnType<typeof fakeChild>
let deps: {
  config: GateDeps['config']
  startChild: ReturnType<typeof vi.fn<GateDeps['startChild']>>
  stopChild: ReturnType<typeof vi.fn<GateDeps['stopChild']>>
  onChange: ReturnType<typeof vi.fn<GateDeps['onChange']>>
}
let g: Gate

beforeEach(() => {
  vi.useFakeTimers()
  child = fakeChild()
  deps = {
    config: { idleMs: 600_000, wakeTimeoutMs: 120_000, pin: false },
    startChild: vi.fn<GateDeps['startChild']>(async () => child.handle),
    stopChild: vi.fn<GateDeps['stopChild']>(async () => {}),
    onChange: vi.fn<GateDeps['onChange']>(),
  }
  g = new Gate(deps)
})
afterEach(() => { vi.useRealTimers() })

describe('Gate', () => {
  it('coalesces concurrent wakes into one child start', async () => {
    const [a, b] = await Promise.all([g.ensureAwake(), g.ensureAwake()])
    expect(a).toBe(b); expect(deps.startChild).toHaveBeenCalledTimes(1); expect(g.snapshot().state).toBe('awake')
    expect(a).toBe(4100)
  })

  it('ensureAwake while awake resolves immediately and starts nothing', async () => {
    await g.ensureAwake()
    expect(await g.ensureAwake()).toBe(4100)
    expect(deps.startChild).toHaveBeenCalledTimes(1)
  })

  it('sleeps after 10 min without activity', async () => {
    await g.ensureAwake(); g.noteHttpStart(); g.noteHttpEnd(); await vi.advanceTimersByTimeAsync(600_000)
    expect(deps.stopChild).toHaveBeenCalledTimes(1); expect(g.snapshot().state).toBe('asleep')
    expect(deps.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'asleep' }), 'idle')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not sleep while a request is in flight', async () => {
    await g.ensureAwake(); g.noteHttpStart(); await vi.advanceTimersByTimeAsync(3_600_000)
    expect(g.snapshot().state).toBe('awake')
  })

  it('counts idle from the moment the last in-flight request ends', async () => {
    await g.ensureAwake(); g.noteHttpStart(); await vi.advanceTimersByTimeAsync(3_600_000)
    g.noteHttpEnd()
    await vi.advanceTimersByTimeAsync(599_999)
    expect(g.snapshot().state).toBe('awake')
    await vi.advanceTimersByTimeAsync(1)
    expect(g.snapshot().state).toBe('asleep')
  })

  it('noteHttpEnd never drives inFlight below 0', async () => {
    await g.ensureAwake(); g.noteHttpEnd(); g.noteHttpEnd()
    expect(g.snapshot().inFlight).toBe(0)
    g.noteHttpStart(); expect(g.snapshot().inFlight).toBe(1)
  })

  it('server frames keep it awake only until 60 min after the last http request', async () => {
    await g.ensureAwake(); g.noteHttpStart(); g.noteHttpEnd()
    for (let m = 0; m < 59; m += 5) { await vi.advanceTimersByTimeAsync(300_000); g.noteServerFrame() }
    expect(g.snapshot().state).toBe('awake')
    for (let m = 0; m < 20; m += 5) { await vi.advanceTimersByTimeAsync(300_000); g.noteServerFrame() }
    expect(g.snapshot().state).toBe('asleep')
  })

  it('server frames do not count when there has never been an http request', async () => {
    await g.ensureAwake()
    await vi.advanceTimersByTimeAsync(300_000); g.noteServerFrame()
    await vi.advanceTimersByTimeAsync(299_999); g.noteServerFrame()
    expect(g.snapshot().state).toBe('awake')
    await vi.advanceTimersByTimeAsync(1)
    expect(g.snapshot().state).toBe('asleep')
  })

  it('times out a wake after 120 s and stops the child', async () => {
    deps.startChild.mockReturnValue(new Promise(() => {})); const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000); expect(await p).toBeInstanceOf(WakeTimeoutError)
    expect(g.snapshot().state).toBe('asleep'); expect(g.snapshot().failedWakes).toBe(1)
    expect(deps.startChild.mock.calls[0]![0].aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops a child that becomes ready after the wake timed out', async () => {
    let resolve!: (c: ChildHandle) => void
    deps.startChild.mockReturnValue(new Promise((r) => { resolve = r }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000); expect(await p).toBeInstanceOf(WakeTimeoutError)
    resolve(child.handle); await vi.advanceTimersByTimeAsync(0)
    expect(deps.stopChild).toHaveBeenCalledWith(child.handle)
    expect(g.snapshot().state).toBe('asleep')
  })

  it('after 3 failed wakes rejects for 30 s without starting a child', async () => {
    deps.startChild.mockRejectedValue(new Error('exit 1'))
    for (let i = 0; i < 3; i++) await g.ensureAwake().catch(() => {})
    await expect(g.ensureAwake()).rejects.toBeInstanceOf(WakeFailedError); expect(deps.startChild).toHaveBeenCalledTimes(3)
    await vi.advanceTimersByTimeAsync(30_000); await g.ensureAwake().catch(() => {}); expect(deps.startChild).toHaveBeenCalledTimes(4)
  })

  it('resetFailures lifts the cooldown at once', async () => {
    deps.startChild.mockRejectedValue(new Error('exit 1'))
    for (let i = 0; i < 3; i++) await g.ensureAwake().catch(() => {})
    g.resetFailures()
    expect(g.snapshot().failedWakes).toBe(0)
    await g.ensureAwake().catch(() => {}); expect(deps.startChild).toHaveBeenCalledTimes(4)
  })

  it('a successful wake resets failedWakes', async () => {
    deps.startChild.mockRejectedValueOnce(new Error('exit 1'))
    await g.ensureAwake().catch(() => {}); expect(g.snapshot().failedWakes).toBe(1)
    await g.ensureAwake(); expect(g.snapshot().failedWakes).toBe(0)
  })

  it('returns to asleep with reason crashed when the child exits', async () => {
    await g.ensureAwake(); child.exit(1); await vi.advanceTimersByTimeAsync(0)
    expect(g.snapshot().state).toBe('asleep')
    expect(deps.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'asleep', childPid: null }), 'crashed')
    expect(deps.stopChild).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a child that exits because the gate stopped it is not reported as crashed', async () => {
    deps.stopChild.mockImplementation(async () => { child.exit(0); await Promise.resolve() })
    await g.ensureAwake(); await g.sleep('manual'); await vi.advanceTimersByTimeAsync(0)
    const reasons = deps.onChange.mock.calls.map((c) => c[1])
    expect(reasons).not.toContain('crashed'); expect(reasons).toContain('manual')
  })

  it('sleep() during waking aborts the start', async () => {
    deps.startChild.mockReturnValue(new Promise(() => {}))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    await g.sleep('evicted')
    expect(deps.startChild.mock.calls[0]![0].aborted).toBe(true)
    expect(await p).toBeInstanceOf(WakeFailedError)
    expect(g.snapshot().state).toBe('asleep')
    expect(deps.onChange).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'asleep' }), 'evicted')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sleep() while asleep is a no-op', async () => {
    await g.sleep('manual')
    expect(deps.onChange).not.toHaveBeenCalled(); expect(deps.stopChild).not.toHaveBeenCalled()
  })

  it('sleep() rejects when stopChild rejects, stays awake, and can retry', async () => {
    await g.ensureAwake()
    deps.stopChild.mockRejectedValueOnce(new Error('survived'))
    await expect(g.sleep('manual')).rejects.toThrow('survived')
    expect(g.snapshot().state).toBe('awake'); expect(g.snapshot().childPid).toBe(111)
    await g.sleep('manual')
    expect(deps.stopChild).toHaveBeenCalledTimes(2); expect(g.snapshot().state).toBe('asleep')
  })

  it('idle sleep that fails to stop re-arms and retries one idleMs later without unhandled rejection', async () => {
    const unhandled = vi.fn(); process.on('unhandledRejection', unhandled)
    try {
      await g.ensureAwake()
      deps.stopChild.mockRejectedValueOnce(new Error('survived'))
      await vi.advanceTimersByTimeAsync(600_000)
      expect(deps.stopChild).toHaveBeenCalledTimes(1); expect(g.snapshot().state).toBe('awake')
      await vi.advanceTimersByTimeAsync(599_999); expect(deps.stopChild).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(deps.stopChild).toHaveBeenCalledTimes(2); expect(g.snapshot().state).toBe('asleep')
      await vi.advanceTimersByTimeAsync(0)
      expect(unhandled).not.toHaveBeenCalled()
    } finally { process.off('unhandledRejection', unhandled) }
  })
})
