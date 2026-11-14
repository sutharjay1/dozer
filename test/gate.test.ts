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
  onError: ReturnType<typeof vi.fn<NonNullable<GateDeps['onError']>>>
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
    onError: vi.fn<NonNullable<GateDeps['onError']>>(),
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
    deps.startChild.mockImplementation((signal) => new Promise((_, rej) => {
      signal.addEventListener('abort', () => rej(new Error('aborted')))
    }))
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

  it('reports a late child whose stop fails, keeps it as a stray, and retries on the next sleep', async () => {
    let resolve!: (c: ChildHandle) => void
    deps.startChild.mockReturnValue(new Promise((r) => { resolve = r }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000); await p
    const boom = new Error('survived')
    deps.stopChild.mockRejectedValueOnce(boom)
    resolve(child.handle); await vi.advanceTimersByTimeAsync(0)
    expect(deps.onError).toHaveBeenCalledWith(boom, 'late-stop')
    expect(g.snapshot().strays).toBe(1)
    await g.sleep('exit')
    expect(deps.stopChild).toHaveBeenCalledTimes(2)
    expect(deps.stopChild).toHaveBeenLastCalledWith(child.handle)
    expect(g.snapshot().strays).toBe(0)
  })

  it('routes a failed idle stop through onError', async () => {
    await g.ensureAwake()
    const boom = new Error('survived')
    deps.stopChild.mockRejectedValueOnce(boom)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(deps.onError).toHaveBeenCalledWith(boom, 'idle-stop')
  })

  it('ensureAwake during a pending stop waits and wakes a fresh child', async () => {
    const second = fakeChild(4200, 222)
    deps.startChild.mockResolvedValueOnce(child.handle).mockResolvedValueOnce(second.handle)
    await g.ensureAwake()
    let finishStop!: () => void
    deps.stopChild.mockReturnValueOnce(new Promise<void>((r) => { finishStop = r }))
    const sleeping = g.sleep('manual')
    await vi.advanceTimersByTimeAsync(0)
    g.noteHttpStart()
    const p = g.ensureAwake()
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.startChild).toHaveBeenCalledTimes(1)
    finishStop(); await sleeping
    expect(await p).toBe(4200)
    expect(deps.startChild).toHaveBeenCalledTimes(2)
  })

  it('ensureAwake during a failing stop returns the still-current child port', async () => {
    await g.ensureAwake()
    let failStop!: (e: Error) => void
    deps.stopChild.mockReturnValueOnce(new Promise<void>((_, r) => { failStop = r }))
    const sleeping = g.sleep('manual').catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    const p = g.ensureAwake()
    failStop(new Error('survived'))
    expect(await sleeping).toBeInstanceOf(Error)
    expect(await p).toBe(4100)
    expect(deps.startChild).toHaveBeenCalledTimes(1)
  })

  it('sleep() during waking does not resolve until the aborted start has settled', async () => {
    let rejectStart!: (e: Error) => void
    deps.startChild.mockReturnValue(new Promise((_, rej) => { rejectStart = rej }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    const sleeping = g.sleep('evicted').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(g.snapshot().state).toBe('asleep'); expect(done).toBe(false)
    rejectStart(new Error('aborted')); await sleeping
    expect(done).toBe(true); await p
  })

  it('sleep() during waking waits for a late handle to be stopped', async () => {
    let resolveStart!: (c: ChildHandle) => void
    deps.startChild.mockReturnValue(new Promise((r) => { resolveStart = r }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    const sleeping = g.sleep('evicted').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(0); expect(done).toBe(false)
    resolveStart(child.handle); await sleeping
    expect(deps.stopChild).toHaveBeenCalledWith(child.handle); await p
  })

  it('a throwing onChange does not break the wake', async () => {
    const boom = new Error('listener')
    deps.onChange.mockImplementation((snap) => { if (snap.state === 'awake') throw boom })
    expect(await g.ensureAwake()).toBe(4100)
    expect(deps.onError).toHaveBeenCalledWith(boom, 'on-change')
    expect(g.snapshot().state).toBe('awake')
  })

  it('ensureAwake in the same tick as sleep waits for the stop and wakes fresh', async () => {
    const second = fakeChild(4200, 222)
    deps.startChild.mockResolvedValueOnce(child.handle).mockResolvedValueOnce(second.handle)
    await g.ensureAwake()
    const sleeping = g.sleep('manual')
    const p = g.ensureAwake()
    await sleeping
    expect(await p).toBe(4200)
    expect(deps.stopChild).toHaveBeenCalledWith(child.handle)
  })

  it('shares one stray retry between concurrent sleeps and never stops a stray twice at once', async () => {
    let resolve!: (c: ChildHandle) => void
    deps.startChild.mockReturnValue(new Promise((r) => { resolve = r }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(120_000); await p
    deps.stopChild.mockRejectedValueOnce(new Error('survived'))
    resolve(child.handle); await vi.advanceTimersByTimeAsync(0)
    expect(g.snapshot().strays).toBe(1)
    deps.stopChild.mockClear(); deps.onError.mockClear()
    let finish!: () => void
    deps.stopChild.mockReturnValueOnce(new Promise<void>((r) => { finish = r }))
    const a = g.sleep('exit'); const b = g.sleep('exit')
    await vi.advanceTimersByTimeAsync(0)
    expect(deps.stopChild).toHaveBeenCalledTimes(1)
    finish(); await Promise.all([a, b])
    expect(g.snapshot().strays).toBe(0); expect(deps.onError).not.toHaveBeenCalled()
  })

  it('a synchronously throwing stopChild rejects sleep and does not wedge ensureAwake', async () => {
    await g.ensureAwake()
    deps.stopChild.mockImplementationOnce(() => { throw new Error('sync boom') })
    await expect(g.sleep('manual')).rejects.toThrow('sync boom')
    expect(g.snapshot().state).toBe('awake')
    expect(await g.ensureAwake()).toBe(4100)
    await g.sleep('manual'); expect(g.snapshot().state).toBe('asleep')
  })

  it('sleep() during waking resolves after wakeTimeoutMs when the start ignores the abort', async () => {
    let resolveStart!: (c: ChildHandle) => void
    deps.startChild.mockReturnValue(new Promise((r) => { resolveStart = r }))
    const p = g.ensureAwake().catch((e) => e)
    await vi.advanceTimersByTimeAsync(0)
    let done = false
    const sleeping = g.sleep('evicted').then(() => { done = true })
    await vi.advanceTimersByTimeAsync(119_999); expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await sleeping
    expect(done).toBe(true); expect(g.snapshot().strays).toBe(0)
    deps.stopChild.mockRejectedValueOnce(new Error('survived'))
    resolveStart(child.handle); await vi.advanceTimersByTimeAsync(0); await p
    expect(g.snapshot().strays).toBe(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
