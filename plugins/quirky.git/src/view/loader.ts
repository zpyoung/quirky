/**
 * Runs section loads one at a time, in request order. Asking for a key that is already queued or
 * running returns the pending promise, and `front` moves a queued key to the head so an explicit
 * "Load diff" is not stuck behind the scroll-triggered ones. A failing `run` is the caller's to
 * report; the queue carries on.
 */
export class SectionLoader {
  private readonly queue: string[] = []
  private readonly pending = new Map<string, { promise: Promise<void>; resolve: () => void }>()
  private running = false

  constructor(private readonly run: (key: string) => Promise<void>) {}

  /** Resolves once `key` has been loaded (or failed). */
  request(key: string, front = false): Promise<void> {
    const known = this.pending.get(key)
    if (known) {
      const queued = this.queue.indexOf(key)
      if (front && queued > 0) {
        this.queue.splice(queued, 1)
        this.queue.unshift(key)
      }
      return known.promise
    }
    let resolve!: () => void
    const promise = new Promise<void>((done) => (resolve = done))
    this.pending.set(key, { promise, resolve })
    if (front) this.queue.unshift(key)
    else this.queue.push(key)
    void this.pump()
    return promise
  }

  /** Forgets everything not yet started; the running load still finishes. */
  clear(): void {
    for (const key of this.queue.splice(0)) {
      this.pending.get(key)?.resolve()
      this.pending.delete(key)
    }
  }

  private async pump(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let key = this.queue.shift(); key !== undefined; key = this.queue.shift()) {
        try {
          await this.run(key)
        } catch {
          // the run reports its own failure
        }
        this.pending.get(key)?.resolve()
        this.pending.delete(key)
      }
    } finally {
      this.running = false
    }
  }
}
