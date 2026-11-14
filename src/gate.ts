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
}

export interface GateDeps {
  config: AppConfig
  startChild(signal: AbortSignal): Promise<ChildHandle>
  stopChild(child: ChildHandle): Promise<void>
  onChange(snapshot: GateSnapshot, reason?: SleepReason): void
  now?(): number
}

interface Wake {
  controller: AbortController
  settled: boolean
  timer: NodeJS.Timeout | undefined
  promise: Promise<number>
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
  private idleTimer: NodeJS.Timeout | undefined

  constructor(private readonly deps: GateDeps) {}

  private now(): number { return (this.deps.now ?? Date.now)() }

  snapshot(): GateSnapshot {
    return {
      state: this.state, inFlight: this.inFlight, lastHttpAt: this.lastHttpAt,
      childPid: this.child?.pid ?? null, hiddenPort: this.child?.hiddenPort ?? null,
      failedWakes: this.failedWakes,
    }
  }

  private emit(reason?: SleepReason): void {
    if (reason === undefined) this.deps.onChange(this.snapshot())
    else this.deps.onChange(this.snapshot(), reason)
  }

  // --- activity -----------------------------------------------------------

  noteHttpStart(): void {
    this.inFlight++
    this.lastHttpAt = this.now()
    this.armIdle()
  }

  noteHttpEnd(): void {
    if (this.inFlight > 0) this.inFlight--
    this.lastHttpAt = this.now()
    this.armIdle()
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
    this.sleep('idle').catch(() => this.armIdle(this.deps.config.idleMs))
  }

  // --- waking -------------------------------------------------------------

  ensureAwake(): Promise<number> {
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
    const wake: Wake = { controller, settled: false, timer: undefined, promise, reject: rejectOuter }
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

    const stopLate = (handle: ChildHandle) => { this.deps.stopChild(handle).catch(() => {}) }

    Promise.resolve()
      .then(() => this.deps.startChild(controller.signal))
      .then((handle) => {
        if (wake.settled) { stopLate(handle); return }
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
    this.child = null
    this.state = 'asleep'
    this.clearIdle()
    this.emit('crashed')
  }

  // --- sleeping -----------------------------------------------------------

  sleep(reason: SleepReason): Promise<void> {
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
      return Promise.resolve()
    }
    if (this.sleeping) return this.sleeping
    const handle = this.child!
    this.stopping = handle
    this.sleeping = (async () => {
      try {
        await this.deps.stopChild(handle)
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
