import type { ScanProgress, SearchStatus, WorkerRequest, WorkerResponse } from './types'

const IDLE_WORKER_MS = 5 * 60_000
const CLOSE_TIMEOUT_MS = 1500

type WorkerEvent =
  | { event: 'scanProgress'; data: ScanProgress }
  | { event: 'searchStatus'; data: SearchStatus }

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item: unknown) => typeof item === 'string')
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isFiniteNumber)
  )
}

function isScanProgress(value: unknown): value is ScanProgress {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('phase' in value) || (value.phase !== 'discovering' && value.phase !== 'reading' && value.phase !== 'complete')) return false
  if (!('scannedFiles' in value) || !isFiniteNumber(value.scannedFiles)) return false
  if (!('parsedFiles' in value) || !isFiniteNumber(value.parsedFiles)) return false
  return !('current' in value) || value.current === undefined || typeof value.current === 'string'
}

function isSearchStatus(value: unknown): value is SearchStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (!('enabled' in value) || typeof value.enabled !== 'boolean') return false
  if (
    !('phase' in value) ||
    (value.phase !== 'closed' && value.phase !== 'idle' && value.phase !== 'indexing' &&
      value.phase !== 'current' && value.phase !== 'degraded')
  ) return false
  if (!('filesIndexed' in value) || !isFiniteNumber(value.filesIndexed)) return false
  if (!('filesDue' in value) || !isFiniteNumber(value.filesDue)) return false
  if (!('filesFailed' in value) || !isFiniteNumber(value.filesFailed)) return false
  if (!('messagesIndexed' in value) || !isFiniteNumber(value.messagesIndexed)) return false
  if (!('degradedRoots' in value) || !Array.isArray(value.degradedRoots)) return false
  if (!value.degradedRoots.every((root: unknown) =>
    typeof root === 'object' && root !== null && !Array.isArray(root) &&
    'reason' in root && typeof root.reason === 'string' &&
    (!('root' in root) || root.root === undefined || typeof root.root === 'string')
  )) return false
  if (!('lastReconcileAt' in value) || (value.lastReconcileAt !== null && !isFiniteNumber(value.lastReconcileAt))) return false
  if (!('lastSweepCompletedAt' in value) || (value.lastSweepCompletedAt !== null && !isFiniteNumber(value.lastSweepCompletedAt))) return false
  if (!('generation' in value) || !isFiniteNumber(value.generation)) return false
  if (!('supportedAgents' in value) || !isStringArray(value.supportedAgents)) return false
  return 'sessionsByAgent' in value && isNumberRecord(value.sessionsByAgent)
}

function parseWorkerEvent(value: object): WorkerEvent | null {
  if (!('event' in value) || !('data' in value)) return null
  if (value.event === 'scanProgress' && isScanProgress(value.data)) {
    return { event: 'scanProgress', data: value.data }
  }
  if (value.event === 'searchStatus' && isSearchStatus(value.data)) {
    return { event: 'searchStatus', data: value.data }
  }
  return null
}

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
      const event = parseWorkerEvent(value)
      if (event) {
        try {
          this.onEvent(event)
        } catch {
          // An observer failure must not turn a completed worker request into a failure.
        }
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
