type Pass = PromiseWithResolvers<void>

/** Joins event bursts without overlapping passes; awaiting callers get a fresh pass. */
export class PassScheduler {
  private running: Pass | null = null
  private waiting: Pass | null = null
  private requested = false
  private timer: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(
    private readonly run: () => Promise<void>,
    private readonly settleMs: number,
    private readonly onError: (error: unknown) => void = () => {}
  ) {}

  request(): void {
    if (this.stopped || this.requested || this.waiting) return
    this.requested = true
    if (!this.running) this.arm()
  }

  now(): Promise<void> {
    if (this.stopped) return Promise.resolve()
    this.cancel()
    if (this.running) {
      this.waiting ??= Promise.withResolvers<void>()
      return this.waiting.promise
    }
    const pass = Promise.withResolvers<void>()
    this.start(pass)
    return pass.promise
  }

  cancel(): void {
    clearTimeout(this.timer)
    this.timer = undefined
    this.requested = false
  }

  stop(): void {
    this.stopped = true
    this.cancel()
  }

  private arm(): void {
    this.timer = setTimeout(() => {
      this.timer = undefined
      this.requested = false
      const pass = Promise.withResolvers<void>()
      void pass.promise.catch(this.onError)
      this.start(pass)
    }, this.settleMs)
  }

  private start(pass: Pass): void {
    this.running = pass
    let result: Promise<void>
    try {
      result = this.run()
    } catch (error) {
      result = Promise.reject(error)
    }
    void result.then(() => {
      this.finish()
      pass.resolve()
    }, (error) => {
      this.finish()
      pass.reject(error)
    })
  }

  private finish(): void {
    this.running = null
    const waiting = this.waiting
    this.waiting = null
    if (this.stopped) {
      waiting?.resolve()
    } else if (waiting) {
      this.cancel()
      this.start(waiting)
    } else if (this.requested) {
      this.arm()
    }
  }
}
