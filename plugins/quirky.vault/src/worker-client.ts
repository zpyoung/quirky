import type { WorkerEvent, WorkerRequest, WorkerResponse } from './types'

const IDLE_WORKER_MS = 5 * 60_000
const CLOSE_TIMEOUT_MS = 1500

type Pending = { resolve(value: unknown): void; reject(error: Error): void }

export class WorkerRequestError extends Error {
  constructor(readonly kind: string, message: string) {
    super(message)
    this.name = 'WorkerRequestError'
  }
}


/** Owns the in-daemon Bun Worker; calls are never retried after a worker failure. */
export class VaultWorkerClient {
  private worker: Worker | undefined
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private keepAlive = false
  private closed = false

  constructor(
    private readonly entrypoint: string,
    private readonly onEvent: (event: WorkerEvent) => void
  ) {}
  get started(): boolean {
    return this.worker !== undefined
  }


  setKeepAlive(value: boolean): void {
    this.keepAlive = value
    if (value) this.clearIdleTimer()
    else this.touchIdleTimer()
  }

  request<T>(op: string, args: Record<string, unknown> = {}): Promise<T> {
    if (this.closed) return Promise.reject(new WorkerRequestError('worker-closed', 'vault worker is closed'))
    const worker = this.ensureWorker()
    const id = this.nextId++
    const deferred = Promise.withResolvers<T>()
    this.pending.set(id, {
      resolve: (value) => deferred.resolve(value as T),
      reject: deferred.reject
    })
    try {
      const request: WorkerRequest = { id, op, args }
      worker.postMessage(request)
      this.touchIdleTimer()
    } catch (error) {
      this.pending.delete(id)
      deferred.reject(asError(error))
    }
    return deferred.promise
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.clearIdleTimer()
    const worker = this.worker
    this.worker = undefined
    if (!worker) return

    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new WorkerRequestError('worker-closed', 'vault worker is shutting down'))
    }
    const id = this.nextId++
    const deferred = Promise.withResolvers<void>()
    this.pending.set(id, { resolve: () => deferred.resolve(), reject: () => deferred.resolve() })
    try {
      worker.postMessage({ id, op: 'close', args: {} } satisfies WorkerRequest)
    } catch {
      this.pending.delete(id)
      deferred.resolve()
    }
    const timer = setTimeout(() => deferred.resolve(), CLOSE_TIMEOUT_MS)
    await deferred.promise
    clearTimeout(timer)
    this.pending.delete(id)
    worker.terminate()
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    if (this.closed) throw new WorkerRequestError('worker-closed', 'vault worker is closed')
    const worker = new Worker(this.entrypoint, { type: 'module' })
    worker.addEventListener('message', (event: MessageEvent<unknown>) => this.receive(event.data))
    worker.addEventListener('error', (event: ErrorEvent) => this.failWorker(event.message || 'vault worker failed'))
    worker.addEventListener('messageerror', () => this.failWorker('vault worker sent an unreadable message'))
    this.worker = worker
    return worker
  }

  private receive(value: unknown): void {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return
    if ('event' in value && typeof value.event === 'string') {
      if (typeof value.data !== 'object' || value.data === null || Array.isArray(value.data)) return
      try {
        this.onEvent(value as unknown as WorkerEvent)
      } catch {
        // An observer failure must not turn a completed worker request into a failure.
      }
      return
    }
    if (!('id' in value) || typeof value.id !== 'number') return
    const pending = this.pending.get(value.id)
    if (!pending) return
    this.pending.delete(value.id)
    const response = value as WorkerResponse
    if (response.error && typeof response.error.kind === 'string' && typeof response.error.message === 'string') {
      pending.reject(new WorkerRequestError(response.error.kind, response.error.message))
    } else {
      pending.resolve(response.result)
    }
    this.touchIdleTimer()
  }

  private failWorker(message: string): void {
    const worker = this.worker
    this.worker = undefined
    this.clearIdleTimer()
    worker?.terminate()
    for (const [id, pending] of this.pending) {
      this.pending.delete(id)
      pending.reject(new WorkerRequestError('worker-failed', message))
    }
  }

  private touchIdleTimer(): void {
    this.clearIdleTimer()
    if (this.closed || this.keepAlive || !this.worker) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined
      void this.retireIfIdle()
    }, IDLE_WORKER_MS)
  }

  private async retireIfIdle(): Promise<void> {
    const worker = this.worker
    if (!worker || this.closed || this.keepAlive || this.pending.size > 0) return
    try {
      await this.request('close')
    } catch {
      // An idle worker is disposable; a later request creates a new one.
    }
    if (this.worker === worker) {
      this.worker = undefined
      this.clearIdleTimer()
      worker.terminate()
    }
  }

  private clearIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
