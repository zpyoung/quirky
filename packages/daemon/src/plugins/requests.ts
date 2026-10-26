import { createHash } from 'node:crypto'
import { RpcErrorCode } from '@quirky/protocol'
import { conflict, DaemonError } from '../errors'
import type { RequestOutcome, Store } from '../store'

/** How long a recorded request or confirmation is kept. */
export const RETENTION_MS = 24 * 60 * 60 * 1000
const PRUNE_EVERY_MS = 60 * 60 * 1000

export type RequestStore = Pick<Store, 'getRequest' | 'putRequest' | 'pruneRequests'>

/** `value` as JSON with object keys sorted at every depth, so equal params always serialize equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => [key, sortKeys(item)])
  )
}

/** sha256 hex of the method name and the canonical params: what a request ID is bound to. */
export function requestDigest(method: string, params: Record<string, unknown>): string {
  return createHash('sha256').update(`${method}\n${canonicalJson(params)}`).digest('hex')
}

/**
 * Deletes rows older than `RETENTION_MS` once at construction, then again on a `touch()` that
 * comes at least an hour after the last prune. Callers touch it on every write.
 */
export class LazyPruner {
  private last: number

  constructor(
    private readonly prune: (olderThanMs: number) => number,
    private readonly now: () => number,
    private readonly onPruned: (count: number) => void = () => {}
  ) {
    this.last = now()
    this.run()
  }

  touch(): void {
    if (this.now() - this.last < PRUNE_EVERY_MS) return
    this.last = this.now()
    this.run()
  }

  private run(): void {
    const count = this.prune(this.now() - RETENTION_MS)
    if (count > 0) this.onPruned(count)
  }
}

const reusedWithOtherParams = () => conflict('request ID reused with different params')

function outcomeOfError(error: unknown): RequestOutcome {
  if (error instanceof DaemonError) {
    return { error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } }
  }
  return { error: { code: RpcErrorCode.Internal, message: error instanceof Error ? error.message : String(error) } }
}

function replay(outcome: RequestOutcome): Promise<unknown> {
  if ('result' in outcome) return Promise.resolve(outcome.result)
  const { code, message, data } = outcome.error
  return Promise.reject(new DaemonError(code, message, data))
}

/**
 * Makes calls idempotent per request ID. The first call under an ID runs and its outcome, result
 * or error, is kept for 24 hours. A repeat with the same digest gets that outcome, or waits for
 * the call still running; a repeat with another digest is a Conflict.
 */
export class RequestLog {
  private readonly inFlight = new Map<string, { digest: string; promise: Promise<unknown> }>()
  private readonly pruner: LazyPruner
  private readonly now: () => number

  constructor(
    private readonly store: RequestStore,
    options: { now?: () => number; log?: (message: string) => void } = {}
  ) {
    this.now = options.now ?? Date.now
    this.pruner = new LazyPruner(
      (cutoff) => store.pruneRequests(cutoff),
      this.now,
      (count) => options.log?.(`request log: pruned ${count} record${count === 1 ? '' : 's'}`)
    )
  }

  /** Runs `work` unless `requestId` already has a running call or a recorded outcome for `digest`. */
  run<T>(requestId: string, digest: string, work: () => Promise<T>): Promise<T> {
    const running = this.inFlight.get(requestId)
    if (running) {
      return running.digest === digest ? (running.promise as Promise<T>) : Promise.reject(reusedWithOtherParams())
    }
    const stored = this.store.getRequest(requestId)
    if (stored && this.now() - stored.createdAt < RETENTION_MS) {
      return stored.digest === digest ? (replay(stored.outcome) as Promise<T>) : Promise.reject(reusedWithOtherParams())
    }
    const promise = this.record(requestId, digest, work).finally(() => this.inFlight.delete(requestId))
    this.inFlight.set(requestId, { digest, promise })
    return promise
  }

  private async record<T>(requestId: string, digest: string, work: () => Promise<T>): Promise<T> {
    let result: T
    try {
      result = await work()
    } catch (error) {
      this.write(requestId, digest, outcomeOfError(error))
      throw error
    }
    this.write(requestId, digest, { result })
    return result
  }

  private write(requestId: string, digest: string, outcome: RequestOutcome): void {
    this.store.putRequest({ requestId, digest, outcome, createdAt: this.now() })
    this.pruner.touch()
  }
}
