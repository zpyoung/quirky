export const LOAD_RETRY_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000]

export type StateLoaderOptions<T> = {
  read(): Promise<T>
  onState(state: T): void
  onFailure(error: unknown): void
  retryDelaysMs?: readonly number[]
}

/** Recovers transient reads without allowing stale replies to replace newer state. */
export class StateLoader<T> {
  private sequence = 0
  private retryIndex = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private disposed = false

  constructor(private readonly options: StateLoaderOptions<T>) {}

  /** Starts a fresh read and resets the bounded retry sequence. */
  load(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.clearRetry()
    this.retryIndex = 0
    const sequence = ++this.sequence
    return this.read(sequence)
  }

  /** Invalidates in-flight replies and cancels pending retries. */
  settle(): void {
    if (this.disposed) return
    this.sequence += 1
    this.retryIndex = 0
    this.clearRetry()
  }

  /** Prevents further reads, callbacks, and retries. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.sequence += 1
    this.retryIndex = 0
    this.clearRetry()
  }

  private async read(sequence: number): Promise<void> {
    let state: T
    try {
      state = await this.options.read()
    } catch (error) {
      if (!this.isCurrent(sequence)) return
      this.options.onFailure(error)
      this.scheduleRetry(sequence)
      return
    }

    if (!this.isCurrent(sequence)) return
    this.options.onState(state)
  }

  private scheduleRetry(sequence: number): void {
    const delays = this.options.retryDelaysMs ?? LOAD_RETRY_DELAYS_MS
    const delay = delays[this.retryIndex]
    if (delay === undefined) return
    this.retryIndex += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined
      if (this.isCurrent(sequence)) void this.read(sequence)
    }, delay)
  }

  private isCurrent(sequence: number): boolean {
    return !this.disposed && sequence === this.sequence
  }

  private clearRetry(): void {
    clearTimeout(this.retryTimer)
    this.retryTimer = undefined
  }
}
