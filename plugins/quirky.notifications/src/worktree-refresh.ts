import { randomUUID } from 'node:crypto'
import type { Worktree } from '@quirky/protocol'

export const WORKTREE_REFRESH_SLOW_MS = 2000
export const WORKTREE_REFRESH_TIMEOUT_MS = 30000
const SAMPLE_INTERVAL_MS = 100
const DIAGNOSTIC_PREFIX = 'notification-worktree-refresh '
const TIMEOUT_MESSAGE = 'quirky.worktree/list did not answer within 30000ms'

type RefreshOutcome = 'ok' | 'error' | 'timeout'
type RefreshSettlement = { status: 'ok'; worktrees: Worktree[] } | { status: 'error'; error: unknown }

type RefreshActive = {
  id: string
  generation: number
  startedAt: string
  startedAtMs: number
  nextSampleAt: number
  maxLoopLagMs: number
  slowTimer: unknown | null
  timeoutTimer: unknown | null
  sampleTimer: unknown | null
  slowLogged: boolean
  outcome: RefreshOutcome | null
}

export type RefreshDiagnostic = {
  v: 1
  id: string
  event: 'slow' | 'finished'
  startedAt: string
  at: string
  elapsedMs: number
  loopLagMs: number
  outcome?: RefreshOutcome
}

export type WorktreeRefreshOptions = {
  read: () => Promise<Worktree[]>
  onSnapshot: (snapshot: Worktree[]) => void
  log: (line: string) => void
  now?: () => Date
  monotonicNow?: () => number
  setTimeout?: (run: () => void, delay: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/** Runs bounded, single-flight worktree refreshes and retains the last successful snapshot. */
export class WorktreeRefresh {
  private readonly activationId = randomUUID()
  private readonly read: WorktreeRefreshOptions['read']
  private readonly onSnapshot: WorktreeRefreshOptions['onSnapshot']
  private readonly log: WorktreeRefreshOptions['log']
  private readonly now: () => Date
  private readonly monotonicNow: () => number
  private readonly setTimer: (run: () => void, delay: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readNumber = 0
  private generation = 0
  private active: RefreshActive | null = null
  private dirty = false
  private stopped = false
  private lastSnapshot: Worktree[] | undefined

  constructor(options: WorktreeRefreshOptions) {
    this.read = options.read
    this.onSnapshot = options.onSnapshot
    this.log = options.log
    this.now = options.now ?? (() => new Date())
    this.monotonicNow = options.monotonicNow ?? (() => performance.now())
    this.setTimer = options.setTimeout ?? ((run, delay) => setTimeout(run, delay))
    this.clearTimer = options.clearTimeout ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>))
  }

  get snapshot(): Worktree[] | undefined {
    return this.lastSnapshot === undefined ? undefined : structuredClone(this.lastSnapshot)
  }

  request(invalidate = false): void {
    if (this.stopped) return
    if (invalidate) this.generation++
    if (this.active !== null) {
      this.dirty = true
      return
    }
    this.startRead()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.dirty = false
    if (this.active !== null) this.clearTimers(this.active)
  }

  private startRead(): void {
    if (this.stopped || this.active !== null) return
    const startedAtMs = this.monotonicNow()
    const active: RefreshActive = {
      id: `${this.activationId}:${++this.readNumber}`,
      generation: this.generation,
      startedAt: this.now().toISOString(),
      startedAtMs,
      nextSampleAt: startedAtMs + SAMPLE_INTERVAL_MS,
      maxLoopLagMs: 0,
      slowTimer: null,
      timeoutTimer: null,
      sampleTimer: null,
      slowLogged: false,
      outcome: null
    }
    this.active = active
    active.slowTimer = this.setTimer(() => this.checkTimer(active), WORKTREE_REFRESH_SLOW_MS)
    active.timeoutTimer = this.setTimer(() => this.checkTimer(active), WORKTREE_REFRESH_TIMEOUT_MS)
    active.sampleTimer = this.setTimer(() => this.sample(active), SAMPLE_INTERVAL_MS)

    let raw: Promise<Worktree[]>
    try {
      raw = this.read()
    } catch (error) {
      this.settle(active, { status: 'error', error })
      return
    }
    void Promise.resolve(raw)
      .then((worktrees) => this.settle(active, { status: 'ok', worktrees }))
      .catch((error: unknown) => this.settle(active, { status: 'error', error }))
  }

  private checkTimer(active: RefreshActive): void {
    if (this.active !== active || this.stopped || active.outcome !== null) return
    const observedAt = this.monotonicNow()
    this.observeTimerLag(active, observedAt)
    this.checkBoundaries(active, observedAt)
  }

  private sample(active: RefreshActive): void {
    if (this.active !== active || this.stopped || active.outcome !== null) return
    active.sampleTimer = null
    const observedAt = this.monotonicNow()
    this.observeTimerLag(active, observedAt)
    this.checkBoundaries(active, observedAt)
    if (active.outcome !== null || this.active !== active || this.stopped) return
    active.nextSampleAt = observedAt + SAMPLE_INTERVAL_MS
    active.sampleTimer = this.setTimer(() => this.sample(active), SAMPLE_INTERVAL_MS)
  }

  private settle(active: RefreshActive, result: RefreshSettlement): void {
    if (this.active !== active) return
    if (this.stopped) {
      this.release(active)
      return
    }
    if (active.outcome === null) {
      const observedAt = this.monotonicNow()
      this.observeTimerLag(active, observedAt)
      this.checkBoundaries(active, observedAt)
      if (active.outcome === null) {
        if (result.status === 'error') {
          active.outcome = 'error'
          this.logOrdinaryError(result.error)
          this.emitFinished(active, 'error', observedAt)
        } else {
          active.outcome = 'ok'
          if (active.slowLogged) this.emitFinished(active, 'ok', observedAt)
          if (this.generation === active.generation) {
            this.lastSnapshot = structuredClone(result.worktrees)
            this.notifySnapshot(this.lastSnapshot)
          }
        }
      }
    }
    this.release(active)
  }

  private checkBoundaries(active: RefreshActive, observedAt: number): void {
    if (this.active !== active || this.stopped || active.outcome !== null) return
    const elapsedMs = this.elapsed(active, observedAt)
    if (elapsedMs >= WORKTREE_REFRESH_SLOW_MS) this.emitSlow(active, observedAt)
    if (elapsedMs < WORKTREE_REFRESH_TIMEOUT_MS) return
    active.outcome = 'timeout'
    this.safeLog(`quirky.worktree/list failed: ${TIMEOUT_MESSAGE}`)
    this.emitFinished(active, 'timeout', observedAt)
    this.clearTimers(active)
  }

  private emitSlow(active: RefreshActive, observedAt: number): void {
    if (active.slowLogged) return
    active.slowLogged = true
    this.emitDiagnostic(active, 'slow', observedAt)
  }

  private emitFinished(active: RefreshActive, outcome: RefreshOutcome, observedAt: number): void {
    this.emitDiagnostic(active, 'finished', observedAt, outcome)
  }

  private emitDiagnostic(active: RefreshActive, event: 'slow' | 'finished', observedAt: number, outcome?: RefreshOutcome): void {
    const diagnostic: RefreshDiagnostic = {
      v: 1,
      id: active.id,
      event,
      startedAt: active.startedAt,
      at: this.now().toISOString(),
      elapsedMs: this.elapsed(active, observedAt),
      loopLagMs: active.maxLoopLagMs,
      ...(outcome === undefined ? {} : { outcome })
    }
    this.safeLog(`${DIAGNOSTIC_PREFIX}${JSON.stringify(diagnostic)}`)
  }

  private observeTimerLag(active: RefreshActive, observedAt: number): void {
    const lateBy = observedAt - active.nextSampleAt
    if (Number.isFinite(lateBy) && lateBy > active.maxLoopLagMs) active.maxLoopLagMs = lateBy
  }

  private elapsed(active: RefreshActive, observedAt: number): number {
    const elapsedMs = observedAt - active.startedAtMs
    return Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0
  }

  private logOrdinaryError(error: unknown): void {
    let message: string
    try {
      message = error instanceof Error ? error.message : String(error)
    } catch {
      message = 'unknown error'
    }
    this.safeLog(`quirky.worktree/list failed: ${message}`)
  }

  private notifySnapshot(snapshot: Worktree[]): void {
    try {
      this.onSnapshot(structuredClone(snapshot))
    } catch (error) {
      let message: string
      try {
        message = error instanceof Error ? error.message : String(error)
      } catch {
        message = 'unknown error'
      }
      this.safeLog(`notification worktree refresh callback failed: ${message}`)
    }
  }

  private safeLog(line: string): void {
    try {
      this.log(line)
    } catch {
      // logging is best-effort; refresh ownership and timers must still settle.
    }
  }

  private clearTimers(active: RefreshActive): void {
    if (active.slowTimer !== null) this.clearTimer(active.slowTimer)
    if (active.timeoutTimer !== null) this.clearTimer(active.timeoutTimer)
    if (active.sampleTimer !== null) this.clearTimer(active.sampleTimer)
    active.slowTimer = null
    active.timeoutTimer = null
    active.sampleTimer = null
  }

  private release(active: RefreshActive): void {
    this.clearTimers(active)
    if (this.active !== active) return
    this.active = null
    if (this.stopped || !this.dirty) return
    this.dirty = false
    this.startRead()
  }

}
