import { fault } from './errors'

export class FifoLock {
  private tail: Promise<void> = Promise.resolve()

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw fault('browser_tab_closed', 'the queued browser operation was cancelled')
    const previous = this.tail
    const turn = Promise.withResolvers<void>()
    this.tail = previous.then(() => turn.promise)
    try {
      if (signal) {
        const aborted = Promise.withResolvers<void>()
        const onAbort = () => aborted.resolve()
        signal.addEventListener('abort', onAbort, { once: true })
        try {
          await Promise.race([previous, aborted.promise])
        } finally {
          signal.removeEventListener('abort', onAbort)
        }
      } else await previous
      if (signal?.aborted) throw fault('browser_tab_closed', 'the queued browser operation was cancelled')
      return () => turn.resolve()
    } catch (error) {
      turn.resolve()
      throw error
    }
  }

  async run<T>(operation: () => Promise<T> | T, signal?: AbortSignal): Promise<T> {
    const release = await this.acquire(signal)
    try {
      if (signal?.aborted) throw fault('browser_tab_closed', 'the browser operation was cancelled')
      return await operation()
    } finally {
      release()
    }
  }
}

export async function withLocks<T>(locks: Map<string, FifoLock>, ids: readonly string[], operation: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(ids)].sort()
  const releases: Array<() => void> = []
  try {
    for (const id of ordered) {
      let lock = locks.get(id)
      if (!lock) {
        lock = new FifoLock()
        locks.set(id, lock)
      }
      releases.push(await lock.acquire())
    }
    return await operation()
  } finally {
    for (const release of releases.reverse()) release()
  }
}
