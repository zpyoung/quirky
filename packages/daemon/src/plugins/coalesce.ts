import type { PluginEvent } from '@quirky/protocol'

/** The default fixed window for coalesced plugin events. */
export const COALESCE_INTERVAL_MS = 250
/** The number of replaced held emits that triggers a merge warning. */
export const MERGE_LOG_THRESHOLD = 600
/** The rolling merge-count span in milliseconds. */
export const MERGE_LOG_SPAN_MS = 60_000

const KEY_PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*){0,3}$/

type CoalesceWindow = {
  owner: string
  pending: PendingEmission | undefined
  timer: ReturnType<typeof setTimeout> | undefined
}

type PendingEmission = {
  event: PluginEvent
  sequence: number
  window: CoalesceWindow | undefined
  failure?: { error: unknown }
}

type MergeCount = { owner: string; count: number; startedAt: number }

/** Whether `value` is one to four dot-separated identifier segments. */
export function isKeyPath(value: unknown): value is string {
  if (typeof value !== 'string') return false
  return KEY_PATH_RE.exec(value)?.[0] === value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/** Reads a dot-separated path through own properties of plain objects, returning undefined when absent. */
export function readKeyPath(data: unknown, path: string): unknown {
  let value = data
  for (const segment of path.split('.')) {
    if (!isPlainObject(value) || !Object.hasOwn(value, segment)) return undefined
    value = value[segment]
  }
  return value
}

/** Sends the leading emit immediately and the latest subsequent emit when each key's fixed window ends. */
export class PluginEventCoalescer {
  private readonly windows = new Map<string, CoalesceWindow>()
  private readonly mergeCounts = new Map<string, MergeCount>()
  private readonly held = new Map<string, Map<PendingEmission, CoalesceWindow | undefined>>()
  private sequence = 0

  constructor(
    private readonly send: (event: PluginEvent) => void,
    private readonly log: (message: string) => void,
    private readonly intervalMs = COALESCE_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Sends an idle key now, holds its latest update, or forces delivery without restarting its window. */
  emit(owner: string, event: PluginEvent, keyPaths: readonly string[], immediate = false): void {
    const keyValues = keyPaths.map((path) => readKeyPath(event.data, path) ?? null)
    const key = JSON.stringify([event.type, event.worktreeId ?? null, ...keyValues])
    let window = this.windows.get(key)
    const active = window !== undefined
    if (window === undefined) {
      window = { owner, pending: undefined, timer: undefined }
      this.windows.set(key, window)
      this.arm(key, window)
    }
    if (window.pending !== undefined) {
      this.recordMerge(owner, event.type)
      this.takePending(window)
    }
    window.owner = owner

    if (immediate) {
      // reserve publication before callbacks can emit a newer value for this key.
      const publication = this.hold(owner, event, undefined)
      this.sendHeld(owner)
      if (publication.failure !== undefined) throw publication.failure.error
      return
    }
    if (active) {
      window.pending = this.hold(owner, event, window)
      return
    }

    try {
      this.send(event)
    } catch (error) {
      if (this.windows.get(key) === window) {
        this.takePending(window)
        clearTimeout(window.timer)
        window.timer = undefined
        this.windows.delete(key)
      }
      throw error
    }
  }

  /** Sends the owner's earlier held events in emit order, retaining their fixed windows and logging held failures. */
  sendHeld(owner: string): void {
    const through = this.sequence
    for (;;) {
      const queue = this.held.get(owner)
      const pending = queue?.keys().next().value
      if (pending === undefined || pending.sequence > through) return
      queue!.delete(pending)
      if (queue!.size === 0) this.held.delete(owner)
      if (pending.window !== undefined) pending.window.pending = undefined
      try {
        this.send(pending.event)
      } catch (error) {
        if (pending.window === undefined) pending.failure = { error }
        else this.logFailure(owner, pending.event, error)
      }
    }
  }

  /** Drops pending events and merge counts owned by `owner`. */
  removeAll(owner: string): void {
    for (const [key, window] of this.windows) {
      if (window.owner !== owner) continue
      clearTimeout(window.timer)
      window.timer = undefined
      this.takePending(window)
      this.windows.delete(key)
    }
    for (const [eventType, count] of this.mergeCounts) {
      if (count.owner === owner) this.mergeCounts.delete(eventType)
    }
  }

  private arm(key: string, window: CoalesceWindow): void {
    const timer = setTimeout(() => this.flush(key, window), this.intervalMs)
    timer.unref()
    window.timer = timer
  }

  private flush(key: string, window: CoalesceWindow): void {
    if (this.windows.get(key) !== window) return
    const event = this.takePending(window)?.event
    if (event === undefined) {
      window.timer = undefined
      this.windows.delete(key)
      return
    }

    this.arm(key, window)
    const owner = window.owner
    try {
      this.send(event)
    } catch (error) {
      this.logFailure(owner, event, error)
    }
  }

  private hold(owner: string, event: PluginEvent, window: CoalesceWindow | undefined): PendingEmission {
    let queue = this.held.get(owner)
    if (queue === undefined) {
      queue = new Map()
      this.held.set(owner, queue)
    }
    const pending: PendingEmission = { event, sequence: ++this.sequence, window }
    queue.set(pending, window)
    return pending
  }

  private takePending(window: CoalesceWindow): PendingEmission | undefined {
    const pending = window.pending
    if (pending === undefined) return undefined
    window.pending = undefined
    const queue = this.held.get(window.owner)
    queue?.delete(pending)
    if (queue?.size === 0) this.held.delete(window.owner)
    return pending
  }

  private logFailure(owner: string, event: PluginEvent, error: unknown): void {
    this.log(`${owner}: could not send ${event.type}: ${error instanceof Error ? error.message : String(error)}`)
  }

  private recordMerge(owner: string, eventType: string): void {
    const now = this.now()
    let count = this.mergeCounts.get(eventType)
    if (count === undefined) {
      this.mergeCounts.set(eventType, { owner, count: 1, startedAt: now })
      return
    }

    count.owner = owner
    count.count++
    if (now - count.startedAt < MERGE_LOG_SPAN_MS) return
    if (count.count >= MERGE_LOG_THRESHOLD) {
      this.log(`${owner}: ${eventType} merged ${count.count} emits in the last 60 s`)
    }
    count.count = 0
    count.startedAt = now
  }
}
