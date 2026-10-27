import type { Ask, QuirkyEvent, UiPluginContext } from '@quirky/protocol'

export const PANEL_ID = 'panel:quirky.ask/questions'

export type AskStore = {
  /** The asks to show as cards: pending and not queued behind another ask of their session. */
  get(): readonly Ask[]
  /** How many pending asks wait behind another ask of their session. */
  queued(): number
  subscribe(listener: () => void): () => void
  /** Drops an ask from the list at once, before the daemon's `resolved` event arrives. */
  remove(askId: string): void
  dispose(): void
}

/** What the panel reports to `ui.state`: each shown ask with its title and question count, and how many wait in queues. */
export function reportOf(store: Pick<AskStore, 'get' | 'queued'>): {
  pending: { askId: string; title: string; questions: number }[]
  queued: number
} {
  return {
    pending: store.get().map((ask) => ({ askId: ask.id, title: ask.spec.title ?? ASK_FALLBACK_TITLE, questions: ask.spec.questions.length })),
    queued: store.queued()
  }
}

const ASK_EVENTS = new Set(['quirky.ask/created', 'quirky.ask/surfaced', 'quirky.ask/updated', 'quirky.ask/resolved'])

export const ASK_FALLBACK_TITLE = 'An agent has a question'

/**
 * Tracks the asks the daemon has surfaced and mirrors their count onto the panel's badge, whether
 * or not the panel is mounted. Re-reads the pending list on an ask event whose `seq` is above the
 * highest one seen, and on reconnect.
 */
export function createAskStore(context: UiPluginContext): AskStore {
  let asks: readonly Ask[] = []
  let queuedCount = 0
  let watermark = 0
  let generation = 0
  let disposed = false
  // ids removed locally while a refresh was in flight; that refresh's list may still hold them
  const removedDuringRefresh = new Set<Set<string>>()
  const listeners = new Set<() => void>()

  const publish = (next: readonly Ask[], queued = queuedCount) => {
    asks = next
    queuedCount = queued
    context.setPanelBadge(PANEL_ID, next.length === 0 ? null : next.length)
    for (const listener of [...listeners]) listener()
  }

  const refresh = async () => {
    const mine = ++generation
    const removed = new Set<string>()
    removedDuringRefresh.add(removed)
    try {
      const list = (await context.call('quirky.ask/list', { pendingOnly: true })) as Ask[]
      if (disposed || mine !== generation) return
      for (const ask of list) watermark = Math.max(watermark, ask.seq)
      const live = list.filter((ask) => !removed.has(ask.id))
      publish(
        live.filter((ask) => !ask.queued).sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
        live.filter((ask) => ask.queued).length
      )
    } catch (error) {
      context.log(`could not list asks: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      removedDuringRefresh.delete(removed)
    }
  }

  const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
    if (!('data' in event) || !ASK_EVENTS.has(event.type)) return
    const seq = (event.data as { seq?: unknown } | null)?.seq
    if (typeof seq === 'number') {
      if (seq <= watermark) return
      watermark = seq
    }
    void refresh()
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') void refresh()
  })
  void refresh()

  return {
    get: () => asks,
    queued: () => queuedCount,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    remove(askId) {
      if (!asks.some((ask) => ask.id === askId)) return
      for (const removed of removedDuringRefresh) removed.add(askId)
      publish(asks.filter((ask) => ask.id !== askId))
    },
    dispose() {
      disposed = true
      unsubscribeEvents()
      unsubscribeConnection()
      listeners.clear()
    }
  }
}
