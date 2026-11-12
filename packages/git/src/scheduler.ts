/** Maximum number of live child processes gated by a default scheduler. */
export const DEFAULT_GIT_CONCURRENCY = 8

/** Result from requesting a scheduler slot. */
export type GitSlotResult<T> = { timedOut: true } | { timedOut: false; value: T }

/** Options for creating a git child-process scheduler. */
export type GitSchedulerOptions = {
  /** Maximum live child processes gated by this scheduler; defaults to DEFAULT_GIT_CONCURRENCY. */
  concurrency?: number
}

/** Coordinates git child-process slots, write epochs, and post-arrival read cohorts. */
export type GitScheduler = {
  /** Live child slots currently held across one-shot and streaming calls. */
  readonly active: number
  /** Highest active count observed since creation or the last reset. */
  readonly peakActive: number
  /** Monotonic counter incremented when any write starts and again when it settles. */
  readonly writeEpoch: number
  /** Resets the peak active count to the current active count. */
  resetPeakActive(): void
  /** Runs work in a slot, prioritizing queued writes and enforcing any queue deadline. */
  withSlot<T>(
    kind: 'read' | 'write',
    timeoutMs: number | undefined,
    work: (remainingTimeoutMs: number | undefined) => Promise<T>
  ): Promise<GitSlotResult<T>>
  /** Coalesces identical reads into post-arrival cohorts and clones results shared by multiple callers. */
  shareRead<T>(key: string, run: () => Promise<T>, clone: (value: T) => T): Promise<T>
  /** Advances the write epoch on entry and in finally around a repository mutation. */
  withWrite<T>(work: () => Promise<T>): Promise<T>
}

type SlotWaiter = {
  kind: 'read' | 'write'
  deadline: number | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  work: (remainingTimeoutMs: number | undefined) => Promise<unknown>
  resolve: (result: GitSlotResult<unknown>) => void
  reject: (reason?: unknown) => void
}

type ReadCohort = {
  count: number
  promise: Promise<unknown>
  run: () => unknown
  resolve: (value: unknown) => void
  reject: (reason?: unknown) => void
}

/** Creates a write-prioritized slot gate and post-arrival read-cohort registry. */
export function createGitScheduler(options: GitSchedulerOptions = {}): GitScheduler {
  const concurrency = options.concurrency ?? DEFAULT_GIT_CONCURRENCY
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new RangeError('Git scheduler concurrency must be a positive integer')
  }

  let active = 0
  let peakActive = 0
  let writeEpoch = 0
  const writeQueue: SlotWaiter[] = []
  const readQueue: SlotWaiter[] = []
  const activeReads = new Map<string, ReadCohort>()
  const waitingReads = new Map<string, ReadCohort>()

  function remainingBudget(deadline: number | undefined): number | undefined {
    return deadline === undefined ? undefined : Math.max(1, deadline - Date.now())
  }

  function clearWaiterTimer(waiter: SlotWaiter): void {
    if (waiter.timer !== undefined) {
      clearTimeout(waiter.timer)
      waiter.timer = undefined
    }
  }

  function takeNextWaiter(): SlotWaiter | undefined {
    while (writeQueue.length > 0 || readQueue.length > 0) {
      const waiter = writeQueue.shift() ?? readQueue.shift()!
      clearWaiterTimer(waiter)
      if (waiter.deadline !== undefined && waiter.deadline <= Date.now()) {
        waiter.resolve({ timedOut: true })
        continue
      }
      return waiter
    }
  }

  function startSlot(waiter: SlotWaiter, timeoutMs: number | undefined): void {
    let result: Promise<unknown>
    try {
      result = Promise.resolve(waiter.work(timeoutMs))
    } catch (error) {
      releaseSlot()
      waiter.reject(error)
      return
    }
    result.then(
      (value) => {
        releaseSlot()
        waiter.resolve({ timedOut: false, value })
      },
      (error) => {
        releaseSlot()
        waiter.reject(error)
      }
    )
  }

  function releaseSlot(): void {
    const next = takeNextWaiter()
    if (next === undefined) {
      active--
      return
    }
    startSlot(next, remainingBudget(next.deadline))
  }

  function enqueue(waiter: SlotWaiter): void {
    const queue = waiter.kind === 'write' ? writeQueue : readQueue
    queue.push(waiter)
    if (waiter.deadline !== undefined) {
      waiter.timer = setTimeout(() => {
        const index = queue.indexOf(waiter)
        if (index === -1) return
        queue.splice(index, 1)
        waiter.timer = undefined
        waiter.resolve({ timedOut: true })
      }, Math.max(0, waiter.deadline - Date.now()))
    }
  }

  function finishCohort(key: string, cohort: ReadCohort, succeeded: boolean, value: unknown): void {
    if (activeReads.get(key) === cohort) activeReads.delete(key)
    promoteWaiting(key)
    if (succeeded) cohort.resolve(value)
    else cohort.reject(value)
  }

  function startCohort(key: string, cohort: ReadCohort): void {
    activeReads.set(key, cohort)
    let result: unknown
    try {
      result = cohort.run()
    } catch (error) {
      finishCohort(key, cohort, false, error)
      return
    }
    Promise.resolve(result).then(
      (value) => finishCohort(key, cohort, true, value),
      (error) => finishCohort(key, cohort, false, error)
    )
  }

  function promoteWaiting(key: string): void {
    if (activeReads.has(key)) return
    const cohort = waitingReads.get(key)
    if (cohort === undefined) return
    waitingReads.delete(key)
    startCohort(key, cohort)
  }

  return {
    get active() {
      return active
    },
    get peakActive() {
      return peakActive
    },
    get writeEpoch() {
      return writeEpoch
    },
    resetPeakActive() {
      peakActive = active
    },
    withSlot<T>(
      kind: 'read' | 'write',
      timeoutMs: number | undefined,
      work: (remainingTimeoutMs: number | undefined) => Promise<T>
    ): Promise<GitSlotResult<T>> {
      const deadline = timeoutMs === undefined ? undefined : Date.now() + timeoutMs
      return new Promise<GitSlotResult<T>>((resolve, reject) => {
        const waiter: SlotWaiter = {
          kind,
          deadline,
          timer: undefined,
          work: (remaining) => work(remaining),
          resolve: (result) => resolve(result as GitSlotResult<T>),
          reject,
        }
        if (active < concurrency && writeQueue.length === 0 && readQueue.length === 0) {
          active++
          peakActive = Math.max(peakActive, active)
          startSlot(waiter, remainingBudget(deadline))
          return
        }
        enqueue(waiter)
      })
    },
    shareRead<T>(key: string, run: () => Promise<T>, clone: (value: T) => T): Promise<T> {
      const cohortKey = `${writeEpoch}:${key}`
      let cohort = waitingReads.get(cohortKey)
      if (cohort === undefined) {
        const { promise, resolve, reject } = Promise.withResolvers<T>()
        cohort = {
          count: 0,
          promise,
          run,
          resolve: (value) => resolve(value as T),
          reject,
        }
        waitingReads.set(cohortKey, cohort)
        if (!activeReads.has(cohortKey)) queueMicrotask(() => promoteWaiting(cohortKey))
      }
      cohort.count++
      return cohort.promise.then((value) => {
        const result = value as T
        return cohort.count > 1 ? clone(result) : result
      })
    },
    async withWrite<T>(work: () => Promise<T>): Promise<T> {
      writeEpoch++
      try {
        return await work()
      } finally {
        writeEpoch++
      }
    },
  }
}
