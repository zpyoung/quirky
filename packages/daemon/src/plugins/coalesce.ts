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
  pending: PluginEvent | undefined
  timer: ReturnType<typeof setTimeout> | undefined
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

  constructor(
    private readonly send: (event: PluginEvent) => void,
    private readonly log: (message: string) => void,
    private readonly intervalMs = COALESCE_INTERVAL_MS,
    private readonly now: () => number = Date.now
  ) {}

  /** Emits immediately for an idle key, or replaces its held event and returns without sending. */
  emit(owner: string, event: PluginEvent, keyPaths: readonly string[]): void {
    const keyValues = keyPaths.map((path) => readKeyPath(event.data, path) ?? null)
    const key = JSON.stringify([event.type, event.worktreeId ?? null, ...keyValues])
    if (key === undefined) throw new Error('could not serialize plugin event coalescing key')

    const active = this.windows.get(key)
    if (active) {
      if (active.pending !== undefined) this.recordMerge(owner, event.type)
      active.owner = owner
      active.pending = event
      return
    }

    const window: CoalesceWindow = { owner, pending: undefined, timer: undefined }
    this.windows.set(key, window)
    this.arm(key, window)
    try {
      this.send(event)
    } catch (error) {
      if (this.windows.get(key) === window) {
        clearTimeout(window.timer)
        window.timer = undefined
        this.windows.delete(key)
      }
      throw error
    }
  }

  /** Drops pending events and merge counts owned by `owner`. */
  removeAll(owner: string): void {
    for (const [key, window] of this.windows) {
      if (window.owner !== owner) continue
      clearTimeout(window.timer)
      window.timer = undefined
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
    const event = window.pending
    if (event === undefined) {
      window.timer = undefined
      this.windows.delete(key)
      return
    }

    window.pending = undefined
    this.arm(key, window)
    const owner = window.owner
    try {
      this.send(event)
    } catch (error) {
      this.log(`${owner}: could not send ${event.type}: ${error instanceof Error ? error.message : String(error)}`)
    }
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
