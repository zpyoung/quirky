/** How long a run may hold the gate before the next request may start another. */
export const REFRESH_ABANDON_MS = 30_000

export type RefreshGateClock = {
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export type RefreshGateOptions = { abandonAfterMs?: number; clock?: RefreshGateClock }

export type RefreshGate = {
  /** Starts now when idle; otherwise waits for the trailing run. Never rejects. */
  request(): Promise<void>
  /** Drops the pending rerun and resolves its waiters without disposing the gate. */
  cancel(): void
}

const systemClock: RefreshGateClock = {
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Serializes refreshes with one trailing run and nonrejecting waiters; hung runs release their slot. */
export function createRefreshGate(run: () => Promise<unknown>, options: RefreshGateOptions = {}): RefreshGate {
  const clock = options.clock ?? systemClock
  const abandonAfterMs = options.abandonAfterMs ?? REFRESH_ABANDON_MS
  let current: PromiseWithResolvers<void> | null = null
  let pending: PromiseWithResolvers<void> | null = null

  function start(waiter: PromiseWithResolvers<void>) {
    current = waiter
    const timer = clock.setTimeout(finish, abandonAfterMs)
    function finish() {
      if (current !== waiter) return
      clock.clearTimeout(timer)
      current = null
      waiter.resolve()
      const trailing = pending
      pending = null
      if (trailing) start(trailing)
    }
    try {
      Promise.resolve(run()).then(finish, finish)
    } catch {
      finish()
    }
  }

  return {
    request() {
      if (current) {
        pending ??= Promise.withResolvers<void>()
        return pending.promise
      }
      const waiter = Promise.withResolvers<void>()
      start(waiter)
      return waiter.promise
    },
    cancel() {
      pending?.resolve()
      pending = null
    },
  }
}
