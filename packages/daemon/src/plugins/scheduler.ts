import {
  DEFAULT_JOB_TIMEOUT_MS,
  MIN_JOB_INTERVAL_MS,
  parseDuration,
  type JobHandler,
  type JobInfo,
  type JobRun
} from '@quirky/protocol'
import { conflict, notFound } from '../errors'
import type { Store } from '../store'
import type { PluginHost } from './host'

export type SchedulerOptions = {
  plugins: Pick<PluginHost, 'contributions' | 'resolveImplementation'>
  store: Pick<Store, 'listJobRuns' | 'recordJobStart' | 'recordJobFinish' | 'recordJobSettled'>
  log(message: string): void
  /** Wall clock in milliseconds; defaults to `Date.now`. */
  now?: () => number
  /** Longest a timer sleeps before re-checking the clock; defaults to 60 seconds. */
  recheckMs?: number
}

const DEFAULT_RECHECK_MS = 60_000

type Timer = ReturnType<typeof setTimeout>

type JobDefinition = {
  id: string
  owner: string
  intervalMs: number
  initialDelayMs: number
  timeoutMs: number
}

/** One invocation of a job's handler, from record-start until the handler's promise settles. */
type Active = {
  entry: Entry
  startedAt: number
  controller: AbortController
  timeoutTimer?: Timer
  timedOut: boolean
  /** Outcomes of a detached run are never recorded. */
  detached: boolean
  settled: boolean
  resolved: boolean
  resolve(run: JobRun): void
}

type Entry = JobDefinition & {
  timer?: Timer
  /** When the next run is due; null while a run is unsettled. */
  due: number | null
  running: Active | null
  lastRun: JobRun | null
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Runs the effective `job` contributions on fixed delays: each run is due one interval after the
 * previous one settled, and a job never has two runs in flight. Run history lives in the store, so
 * due times survive a restart.
 */
export class Scheduler {
  private readonly jobs = new Map<string, Entry>()
  /** Unsettled runs of jobs that were disarmed; they still block a new run of the same job. */
  private readonly lingering = new Map<string, Active>()
  private readonly skipped = new Set<string>()
  private readonly now: () => number
  private readonly recheckMs: number
  private started = false

  constructor(private readonly options: SchedulerOptions) {
    this.now = options.now ?? Date.now
    this.recheckMs = options.recheckMs ?? DEFAULT_RECHECK_MS
  }

  /** Arms every effective job. Call after startup plugins have activated; a second call does nothing. */
  start(): void {
    if (this.started) return
    this.started = true
    this.sync()
  }

  /** Reconciles armed jobs with the effective set: disarms the ones that left, arms new ones, leaves the rest. */
  sync(): void {
    if (!this.started) return
    const effective = new Map<string, JobDefinition>()
    for (const job of this.effectiveJobs()) effective.set(job.id, job)

    for (const [id, entry] of [...this.jobs]) {
      if (effective.get(id)?.owner !== entry.owner) this.disarm(entry)
    }
    const history = this.options.store.listJobRuns()
    for (const job of effective.values()) {
      if (!this.jobs.has(job.id)) this.arm(job, history.get(job.id))
    }
  }

  /** The armed jobs sorted by ID. */
  list(): JobInfo[] {
    return [...this.jobs.values()]
      .sort((a, b) => compare(a.id, b.id))
      .map((entry) => {
        const unsettled = entry.running !== null || this.lingering.has(entry.id)
        return {
          id: entry.id,
          plugin: entry.owner,
          intervalMs: entry.intervalMs,
          timeoutMs: entry.timeoutMs,
          state: unsettled ? ('running' as const) : ('idle' as const),
          nextRunAt: unsettled ? null : entry.due,
          lastRun: entry.lastRun ? { ...entry.lastRun } : null
        }
      })
  }

  /**
   * Runs a job now and resolves with the finished run; a failed run resolves too. A timed-out run
   * resolves when the timeout fires. NotFound when the job isn't in effect, Conflict when it is running.
   */
  run(id: string): Promise<JobRun> {
    this.sync()
    const entry = this.jobs.get(id)
    if (!entry) return Promise.reject(notFound(`no job ${id} is in effect`))
    if (entry.running || this.lingering.has(id)) return Promise.reject(conflict(`${id} is already running`))
    return this.launch(entry)
  }

  /** Aborts and forgets the plugin's runs; their jobs are due again one interval from now. */
  revokePlugin(pluginId: string): void {
    for (const entry of this.jobs.values()) {
      const active = entry.running
      if (!active || entry.owner !== pluginId) continue
      this.detach(active, true, `${pluginId} was revoked`)
      entry.running = null
      this.schedule(entry, this.now() + entry.intervalMs)
    }
    for (const [id, active] of [...this.lingering]) {
      if (active.entry.owner !== pluginId) continue
      this.detach(active, true, `${pluginId} was revoked`)
      this.lingering.delete(id)
    }
  }

  /** Clears every timer and aborts running signals; outcomes that arrive later are not recorded. */
  stop(): void {
    this.started = false
    for (const entry of this.jobs.values()) {
      this.clearTimer(entry)
      if (entry.running) this.detach(entry.running, true, 'the scheduler stopped')
    }
    this.jobs.clear()
    for (const active of this.lingering.values()) this.detach(active, true, 'the scheduler stopped')
    this.lingering.clear()
  }

  private effectiveJobs(): JobDefinition[] {
    const jobs: JobDefinition[] = []
    for (const contribution of this.options.plugins.contributions({ kind: 'job' })) {
      const { id, data } = contribution
      const intervalMs = typeof data.interval === 'string' ? parseDuration(data.interval) : null
      if (intervalMs === null || intervalMs < MIN_JOB_INTERVAL_MS) {
        if (!this.skipped.has(id)) {
          this.skipped.add(id)
          this.options.log(`${contribution.plugin}: job ${id} skipped: invalid interval ${JSON.stringify(data.interval)}`)
        }
        continue
      }
      jobs.push({
        id,
        owner: contribution.plugin,
        intervalMs,
        initialDelayMs: durationOr(data.initialDelay, intervalMs),
        timeoutMs: durationOr(data.timeout, DEFAULT_JOB_TIMEOUT_MS)
      })
    }
    return jobs
  }

  private arm(job: JobDefinition, previous: JobRun | undefined): void {
    const entry: Entry = { ...job, due: null, running: null, lastRun: previous ? { ...previous } : null }
    this.jobs.set(job.id, entry)
    const now = this.now()
    let due: number
    if (!previous) due = now + job.initialDelayMs
    else if (previous.finishedAt === null) due = now
    else due = Math.max(previous.finishedAt + job.intervalMs, now)
    this.schedule(entry, due)
  }

  private disarm(entry: Entry): void {
    this.clearTimer(entry)
    this.jobs.delete(entry.id)
    if (entry.running) {
      this.detach(entry.running, false, `job ${entry.id} is no longer in effect`)
      this.lingering.set(entry.id, entry.running)
    }
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer !== undefined) clearTimeout(entry.timer)
    entry.timer = undefined
  }

  private schedule(entry: Entry, due: number): void {
    this.clearTimer(entry)
    entry.due = due
    const delay = Math.max(0, Math.min(due - this.now(), this.recheckMs))
    entry.timer = setTimeout(() => this.wake(entry), delay)
  }

  private wake(entry: Entry): void {
    entry.timer = undefined
    if (this.jobs.get(entry.id) !== entry || entry.running || entry.due === null) return
    try {
      if (this.now() < entry.due) this.schedule(entry, entry.due)
      else if (this.lingering.has(entry.id)) entry.timer = setTimeout(() => this.wake(entry), this.recheckMs)
      else void this.launch(entry)
    } catch (error) {
      this.options.log(`job ${entry.id} could not start: ${messageOf(error)}`)
    }
  }

  private launch(entry: Entry): Promise<JobRun> {
    const startedAt = this.now()
    this.options.store.recordJobStart(entry.id, startedAt)
    this.clearTimer(entry)
    entry.due = null

    let resolveRun!: (run: JobRun) => void
    const promise = new Promise<JobRun>((resolve) => {
      resolveRun = resolve
    })
    const active: Active = {
      entry,
      startedAt,
      controller: new AbortController(),
      timedOut: false,
      detached: false,
      settled: false,
      resolved: false,
      resolve: (run) => {
        if (active.resolved) return
        active.resolved = true
        resolveRun(run)
      }
    }
    entry.running = active
    entry.lastRun = { startedAt, finishedAt: null, status: 'running' }
    active.timeoutTimer = setTimeout(() => this.onTimeout(active), entry.timeoutMs)
    void this.execute(active).then((error) => this.onSettled(active, error))
    return promise
  }

  /** Resolves to the failure message, or null when the handler completed. */
  private async execute(active: Active): Promise<string | null> {
    const { id } = active.entry
    try {
      const handler = await this.options.plugins.resolveImplementation(id)
      if (active.controller.signal.aborted) return null
      if (typeof handler !== 'function') throw new Error(`${id} is not a function`)
      await (handler as JobHandler)({ jobId: id, signal: active.controller.signal })
      return null
    } catch (error) {
      return messageOf(error)
    }
  }

  private onTimeout(active: Active): void {
    active.timeoutTimer = undefined
    if (active.settled) return
    active.controller.abort()
    if (active.detached) return
    const { entry } = active
    active.timedOut = true
    const run: JobRun = {
      startedAt: active.startedAt,
      finishedAt: this.now(),
      status: 'timed-out',
      error: `timed out after ${entry.timeoutMs} ms`
    }
    try {
      this.options.store.recordJobFinish(entry.id, run.finishedAt!, 'timed-out', run.error)
    } catch (error) {
      this.options.log(`job ${entry.id}: could not record the timeout: ${messageOf(error)}`)
    }
    entry.lastRun = run
    active.resolve({ ...run })
  }

  private onSettled(active: Active, error: string | null): void {
    active.settled = true
    if (active.timeoutTimer !== undefined) clearTimeout(active.timeoutTimer)
    const { entry } = active
    if (this.lingering.get(entry.id) === active) this.lingering.delete(entry.id)
    if (active.detached) return

    const at = this.now()
    try {
      if (active.timedOut) {
        this.options.store.recordJobSettled(entry.id, at)
        if (entry.lastRun) entry.lastRun = { ...entry.lastRun, finishedAt: at }
      } else {
        const run: JobRun =
          error === null
            ? { startedAt: active.startedAt, finishedAt: at, status: 'ok' }
            : { startedAt: active.startedAt, finishedAt: at, status: 'failed', error }
        if (error !== null) this.options.log(`${entry.owner}: job ${entry.id} failed: ${error}`)
        this.options.store.recordJobFinish(entry.id, at, run.status as 'ok' | 'failed', run.error)
        entry.lastRun = run
        active.resolve({ ...run })
      }
    } catch (failure) {
      this.options.log(`job ${entry.id}: could not record the outcome: ${messageOf(failure)}`)
      active.resolve({ startedAt: active.startedAt, finishedAt: at, status: 'failed', error: messageOf(failure) })
    }
    entry.running = null
    if (this.started && this.jobs.get(entry.id) === entry) this.schedule(entry, at + entry.intervalMs)
  }

  /** Ignores the run's outcome from here on; `abort` also signals the handler. */
  private detach(active: Active, abort: boolean, reason: string): void {
    active.detached = true
    if (abort) {
      if (active.timeoutTimer !== undefined) clearTimeout(active.timeoutTimer)
      active.timeoutTimer = undefined
      active.controller.abort()
    }
    if (active.resolved) return
    active.entry.lastRun = { startedAt: active.startedAt, finishedAt: this.now(), status: 'failed', error: reason }
    active.resolve({ ...active.entry.lastRun })
  }
}

function durationOr(value: unknown, fallback: number): number {
  const parsed = typeof value === 'string' ? parseDuration(value) : null
  return parsed ?? fallback
}
