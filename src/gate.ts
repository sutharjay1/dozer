import type { ChildHandle } from './child.js'
import { DEFAULTS, type AppConfig } from './config.js'

export type GateState = 'asleep' | 'waking' | 'awake'
export type SleepReason = 'idle' | 'evicted' | 'manual' | 'exit' | 'crashed'

export class WakeTimeoutError extends Error {
  constructor(message = 'wake timed out') { super(message); this.name = 'WakeTimeoutError' }
}
export class WakeFailedError extends Error {
  constructor(message = 'wake failed', options?: { cause?: unknown }) {
    super(message, options); this.name = 'WakeFailedError'
  }
}

export interface GateSnapshot {
  state: GateState; inFlight: number; lastHttpAt: number | null
  childPid: number | null; hiddenPort: number | null; failedWakes: number
  strays: number
  /** When the current child became ready; null unless awake. */
  awakeAt: number | null
}

export type GateErrorContext = 'late-stop' | 'idle-stop' | 'crash-stop' | 'on-change'

export interface GateDeps {
  config: AppConfig
  startChild(signal: AbortSignal): Promise<ChildHandle>
  stopChild(child: ChildHandle): Promise<void>
  onChange(snapshot: GateSnapshot, reason?: SleepReason): void
  /** Called when requests in flight go from 0 to 1 or from 1 to 0. */
  onActivity?(snapshot: GateSnapshot): void
  now?(): number
  onError?(error: unknown, context: GateErrorContext): void
}

interface Wake {
  controller: AbortController
  settled: boolean
  timer: NodeJS.Timeout | undefined
  promise: Promise<number>
  started: Promise<void>
  reject(err: unknown): void
}

export class Gate {
  private state: GateState = 'asleep'
  private inFlight = 0
  private lastHttpAt: number | null = null
  private lastFrameAt: number | null = null
  private awakeAt = 0
  private child: ChildHandle | null = null
  private stopping: ChildHandle | null = null
  private failedWakes = 0
  private lastFailureAt: number | null = null
  private wake: Wake | null = null
  private sleeping: Promise<void> | null = null
  private strays = new Set<ChildHandle>()
  private strayRetry: Promise<void> | null = null
  private idleTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: GateDeps) {}

  get config(): AppConfig { return this.deps.config }

  /** True from the moment sleep() starts stopping the child until it is gone (before onChange fires). */
  get sleepInProgress(): boolean { return this.sleeping !== null }

  private now(): number { return (this.deps.now ?? Date.now)() }

  snapshot(): GateSnapshot {
    return {
      state: this.state, inFlight: this.inFlight, lastHttpAt: this.lastHttpAt,
      childPid: this.child?.pid ?? null, hiddenPort: this.child?.hiddenPort ?? null,
      failedWakes: this.failedWakes, strays: this.strays.size,
      awakeAt: this.state === 'awake' ? this.awakeAt : null,
    }
  }

  private reportError(error: unknown, context: GateErrorContext): void {
    try {
      if (this.deps.onError) this.deps.onError(error, context)
      else process.stderr.write(`napdev: ${context}: ${(error as Error)?.message ?? String(error)}\n`)
    } catch { /* reporting must never throw */ }
  }

  private emit(reason?: SleepReason): void {
    try {
      if (reason === undefined) this.deps.onChange(this.snapshot())
      else this.deps.onChange(this.snapshot(), reason)
    } catch (err) {
      this.reportError(err, 'on-change')
    }
  }

  private async stopStray(handle: ChildHandle): Promise<void> {
    try {
      await this.deps.stopChild(handle)
      this.strays.delete(handle)
    } catch (err) {
      this.strays.add(handle)
      this.reportError(err, 'late-stop')
    }
  }

  private retryStrays(): Promise<void> {
    if (this.strayRetry) return this.strayRetry
    if (this.strays.size === 0) return Promise.resolve()
    const run = (async () => {
      try {
        for (const handle of [...this.strays]) await this.stopStray(handle)
      } finally {
        this.strayRetry = null
      }
    })()
    this.strayRetry = run
    return run
  }

  // --- activity -----------------------------------------------------------

  private emitActivity(): void {
    try {
      this.deps.onActivity?.(this.snapshot())
    } catch (err) {
      this.reportError(err, 'on-change')
    }
  }

  noteHttpStart(): void {
    this.inFlight++
    this.lastHttpAt = this.now()
    this.armIdle()
    if (this.inFlight === 1) this.emitActivity()
  }

  noteHttpEnd(): void {
    const was = this.inFlight
    if (was > 0) this.inFlight--
    this.lastHttpAt = this.now()
    this.armIdle()
    if (was === 1) this.emitActivity()
  }

  noteServerFrame(): void {
    const now = this.now()
    if (this.lastHttpAt === null || now - this.lastHttpAt > DEFAULTS.wsCeilingMs) return
    this.lastFrameAt = now
    this.armIdle()
  }

  private lastActivity(): number {
    return Math.max(this.awakeAt, this.lastHttpAt ?? 0, this.lastFrameAt ?? 0)
  }

  private clearIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }

  private armIdle(retryDelay?: number): void {
    this.clearIdle()
    if (this.state !== 'awake') return
    const delay = retryDelay ?? Math.max(0, this.lastActivity() + this.deps.config.idleMs - this.now())
    this.idleTimer = setTimeout(() => this.onIdleTimer(), delay)
  }

  private onIdleTimer(): void {
    this.idleTimer = undefined
    if (this.state !== 'awake' || this.inFlight > 0) return // re-armed when inFlight returns to 0
    if (this.now() - this.lastActivity() < this.deps.config.idleMs) return this.armIdle()
    this.sleep('idle').catch((err) => {
      this.reportError(err, 'idle-stop')
      this.armIdle(this.deps.config.idleMs)
    })
  }

  // --- waking -------------------------------------------------------------

  ensureAwake(): Promise<number> {
    if (this.sleeping) {
      // a stop is in progress: wait for it, then wake fresh (or reuse the old child if the stop failed)
      const again = () => this.ensureAwake()
      return this.sleeping.then(again, again)
    }
    if (this.state === 'awake' && this.child) return Promise.resolve(this.child.hiddenPort)
    if (this.state === 'waking' && this.wake) return this.wake.promise
    if (this.failedWakes >= DEFAULTS.maxFailedWakes && this.lastFailureAt !== null
      && this.now() - this.lastFailureAt < DEFAULTS.failedCooldownMs) {
      return Promise.reject(new WakeFailedError(
        `${this.failedWakes} wakes failed in a row; not starting again until the cooldown passes`))
    }
    return this.beginWake()
  }

  private beginWake(): Promise<number> {
    const controller = new AbortController()
    let rejectOuter!: (err: unknown) => void
    let resolveOuter!: (port: number) => void
    const promise = new Promise<number>((res, rej) => { resolveOuter = res; rejectOuter = rej })
    const wake: Wake = { controller, settled: false, timer: undefined, promise, started: Promise.resolve(), reject: rejectOuter }
    this.wake = wake
    this.state = 'waking'
    this.emit()

    const fail = (err: unknown) => {
      if (wake.settled) return
      wake.settled = true
      clearTimeout(wake.timer)
      this.wake = null
      this.failedWakes++
      this.lastFailureAt = this.now()
      this.state = 'asleep'
      this.emit()
      rejectOuter(err)
    }

    wake.timer = setTimeout(() => {
      if (wake.settled) return
      controller.abort()
      fail(new WakeTimeoutError(`next did not become ready within ${this.deps.config.wakeTimeoutMs}ms`))
    }, this.deps.config.wakeTimeoutMs)

    wake.started = Promise.resolve()
      .then(() => this.deps.startChild(controller.signal))
      .then(async (handle) => {
        if (wake.settled) { await this.stopStray(handle); return }
        wake.settled = true
        clearTimeout(wake.timer)
        this.wake = null
        this.child = handle
        this.failedWakes = 0
        this.lastFailureAt = null
        this.state = 'awake'
        this.awakeAt = this.now()
        this.armIdle()
        void handle.exited.then(() => this.onChildExit(handle))
        this.emit()
        resolveOuter(handle.hiddenPort)
      }, (err) => {
        fail(new WakeFailedError(`could not start next: ${(err as Error)?.message ?? err}`, { cause: err }))
      })

    return promise
  }

  private onChildExit(handle: ChildHandle): void {
    if (this.child !== handle || this.stopping === handle) return
    // Next's main process is gone but its workers may not be: stop the whole group first
    this.clearIdle()
    this.stopping = handle
    this.sleeping = (async () => {
      try {
        await Promise.resolve().then(() => this.deps.stopChild(handle))
      } catch (err) {
        this.strays.add(handle)
        this.reportError(err, 'crash-stop')
      } finally {
        this.sleeping = null
        this.stopping = null
      }
      this.child = null
      this.state = 'asleep'
      this.emit('crashed')
    })()
  }

  // --- sleeping -----------------------------------------------------------

  sleep(reason: SleepReason): Promise<void> {
    // sleepOnce flips the sleeping/waking state synchronously; strays are retried alongside it
    const main = this.sleepOnce(reason)
    const strays = this.retryStrays()
    return Promise.all([main, strays]).then(() => undefined)
  }

  private async sleepOnce(reason: SleepReason): Promise<void> {
    if (this.state === 'asleep') return Promise.resolve()
    if (this.state === 'waking' && this.wake) {
      const wake = this.wake
      wake.settled = true
      clearTimeout(wake.timer)
      wake.controller.abort()
      this.wake = null
      this.state = 'asleep'
      this.emit(reason)
      wake.reject(new WakeFailedError(`wake aborted (${reason})`))
      let bound: NodeJS.Timeout | undefined
      await Promise.race([
        wake.started,
        new Promise<void>((r) => { bound = setTimeout(r, this.deps.config.wakeTimeoutMs) }),
      ])
      clearTimeout(bound)
      return
    }
    if (this.sleeping) return this.sleeping
    const handle = this.child!
    this.stopping = handle
    this.sleeping = (async () => {
      try {
        await Promise.resolve().then(() => this.deps.stopChild(handle))
      } catch (err) {
        this.stopping = null
        throw err
      } finally {
        this.sleeping = null
      }
      this.stopping = null
      this.child = null
      this.state = 'asleep'
      this.clearIdle()
      this.emit(reason)
    })()
    return this.sleeping
  }

  resetFailures(): void {
    const changed = this.failedWakes !== 0
    this.failedWakes = 0
    this.lastFailureAt = null
    if (changed) this.emit()
  }
}
