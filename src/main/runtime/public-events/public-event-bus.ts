import type { PublicEvent, PublicTopic } from '../../../shared/public-rpc/public-events'

export const PUBLIC_EVENT_BUFFER_MAX_EVENTS = 5000
export const PUBLIC_EVENT_BUFFER_MAX_AGE_MS = 10 * 60 * 1000

export type PublicEventInput = Omit<PublicEvent, 'seq' | 'at'>
export type PublicEventsGap = { gap: { from: number; oldest: number } }

/**
 * The in-memory event log behind `events.subscribe`. It stamps every event with a monotonic
 * `seq` (from 1) and the time, and keeps only the last 5000 events or 10 minutes, whichever
 * is smaller, so a reconnecting client can resume from its cursor or learn exactly what it missed.
 */
export class PublicEventBus {
  private seq = 0
  private events: PublicEvent[] = []
  private readonly listeners = new Set<(event: PublicEvent) => void>()
  private readonly activityWatchers = new Set<(hasSubscribers: boolean) => void>()

  constructor(private readonly now: () => number = Date.now) {}

  publish(input: PublicEventInput): void {
    const at = this.now()
    const event: PublicEvent = { ...input, seq: ++this.seq, at }
    this.events.push(event)
    this.prune(at)
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        console.error('[public-events] a listener threw', error)
      }
    }
  }

  /** The seq of the newest event ever published; 0 before the first. */
  latestSeq(): number {
    return this.seq
  }

  /**
   * Events after `after` on the given topics, oldest first. `undefined` means "from now", so no
   * replay. When `after` predates the retained window the dropped range is reported instead.
   */
  since(
    after: number | undefined,
    topics: readonly PublicTopic[]
  ): PublicEvent[] | PublicEventsGap {
    if (after === undefined) {
      return []
    }
    this.prune(this.now())
    const oldest = this.events[0]?.seq ?? this.seq + 1
    if (after < oldest - 1) {
      return { gap: { from: after + 1, oldest } }
    }
    return this.retainedAfter(after, topics)
  }

  /** The retained events after `after` on the given topics, with no gap check. */
  retainedAfter(after: number, topics: readonly PublicTopic[]): PublicEvent[] {
    const wanted = new Set<PublicTopic>(topics)
    return this.events.filter((event) => event.seq > after && wanted.has(event.topic))
  }

  subscribe(listener: (event: PublicEvent) => void): () => void {
    const wasIdle = this.listeners.size === 0
    this.listeners.add(listener)
    if (wasIdle) {
      this.notifyActivity(true)
    }
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.notifyActivity(false)
      }
    }
  }

  /**
   * Reports when the bus gains its first live subscriber and loses its last, so a source that is
   * costly to feed can run only while someone is listening. Fires once at registration when a
   * subscriber is already present.
   */
  watchSubscriberActivity(watcher: (hasSubscribers: boolean) => void): () => void {
    this.activityWatchers.add(watcher)
    if (this.listeners.size > 0) {
      watcher(true)
    }
    return () => {
      this.activityWatchers.delete(watcher)
    }
  }

  private notifyActivity(hasSubscribers: boolean): void {
    for (const watcher of this.activityWatchers) {
      try {
        watcher(hasSubscribers)
      } catch (error) {
        console.error('[public-events] a subscriber watcher threw', error)
      }
    }
  }

  private prune(now: number): void {
    const oldestAllowedAt = now - PUBLIC_EVENT_BUFFER_MAX_AGE_MS
    let drop = Math.max(0, this.events.length - PUBLIC_EVENT_BUFFER_MAX_EVENTS)
    while (drop < this.events.length && this.events[drop].at < oldestAllowedAt) {
      drop += 1
    }
    if (drop > 0) {
      this.events = this.events.slice(drop)
    }
  }
}
