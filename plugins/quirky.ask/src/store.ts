import type { Ask, AskEnvelope, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { ASK_RESULT_FLASH_MS, type AskResolutionFlash } from './presentation-types'

export const PANEL_ID = 'panel:quirky.ask/questions'

export type AskStoreClock = {
  now(): number
  setTimeout(run: () => void, delay: number): unknown
  clearTimeout(handle: unknown): void
}

export type AskStore = {
  /** The asks to show as cards: pending and not queued behind another ask of their session. */
  get(): readonly Ask[]
  /** Terminal summaries retained in the panel without affecting the pending badge. */
  flashes(): readonly AskResolutionFlash[]
  /** How many pending asks wait behind another ask of their session. */
  queued(): number
  subscribe(listener: () => void): () => void
  /** Removes an ask from the pending view and retains its returned terminal envelope for four seconds. */
  resolve(askId: string, envelope: AskEnvelope): void
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
const MAX_RESOLVED_IDS = 256

function rememberResolution(ids: Set<string>, askId: string): void {
  ids.add(askId)
  if (ids.size <= MAX_RESOLVED_IDS) return
  const oldest = ids.values().next().value
  if (oldest !== undefined) ids.delete(oldest)
}


export const ASK_FALLBACK_TITLE = 'An agent has a question'

const systemClock: AskStoreClock = {
  now: () => Date.now(),
  setTimeout: (run, delay) => setTimeout(run, delay),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}

/**
 * Tracks the asks the daemon has surfaced and mirrors their count onto the panel's badge, whether
 * or not the panel is mounted. Re-reads the pending list on an ask event whose `seq` is above the
 * highest one seen, and on reconnect. Resolved presentation stays separate from durable FIFO state.
 */
export function createAskStore(context: UiPluginContext, clock: AskStoreClock = systemClock): AskStore {
  let asks: readonly Ask[] = []
  let flashes: readonly AskResolutionFlash[] = []
  let queuedCount = 0
  let watermark = 0
  let generation = 0
  let appliedGeneration = 0
  let disposed = false
  const removedDuringRefresh = new Set<Set<string>>()
  const flashTimers = new Map<string, unknown>()
  const resolvedIds = new Set<string>()
  const recovering = new Set<string>()
  const listeners = new Set<() => void>()

  const publish = (next: readonly Ask[], queued = queuedCount, nextFlashes = flashes) => {
    asks = next
    queuedCount = queued
    flashes = nextFlashes
    context.setPanelBadge(PANEL_ID, next.length === 0 ? null : next.length)
    for (const listener of [...listeners]) listener()
  }

  const hideFromPendingRefreshes = (askId: string) => {
    for (const removed of removedDuringRefresh) removed.add(askId)
  }

  const makeFlash = (ask: Ask, envelope: AskEnvelope): AskResolutionFlash | null => {
    if (disposed || resolvedIds.has(ask.id)) return null
    rememberResolution(resolvedIds, ask.id)
    const flash: AskResolutionFlash = { ask: { ...ask, envelope }, dismissAt: clock.now() + ASK_RESULT_FLASH_MS }
    const timer = clock.setTimeout(() => {
      flashTimers.delete(ask.id)
      if (disposed) return
      publish(asks, queuedCount, flashes.filter((item) => item.ask.id !== ask.id))
    }, ASK_RESULT_FLASH_MS)
    flashTimers.set(ask.id, timer)
    return flash
  }

  const recoverResolvedAsk = async (askId: string, envelope: AskEnvelope) => {
    if (disposed || resolvedIds.has(askId) || recovering.has(askId)) return
    recovering.add(askId)
    try {
      const all = (await context.call('quirky.ask/list', { pendingOnly: false })) as Ask[]
      const resolved = all.find((ask) => ask.id === askId)
      if (!resolved || disposed) return
      const flash = makeFlash(resolved, envelope)
      if (flash) publish(asks, queuedCount, [...flashes, flash])
    } catch (error) {
      context.log(`could not recover resolved ask ${askId}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      recovering.delete(askId)
    }
  }

  const resolve = (askId: string, envelope: AskEnvelope) => {
    if (envelope.status === 'pending' || disposed) return
    hideFromPendingRefreshes(askId)
    const ask = asks.find((candidate) => candidate.id === askId)
    const next = asks.filter((candidate) => candidate.id !== askId)
    const flash = ask ? makeFlash(ask, envelope) : null
    publish(next, queuedCount, flash ? [...flashes, flash] : flashes)
    if (!ask && !resolvedIds.has(askId)) void recoverResolvedAsk(askId, envelope)
  }

  /** Refetches the pending list; the watermark advances to `eventSeq` only once the list is applied. */
  const refresh = async (eventSeq = 0) => {
    const mine = ++generation
    const removed = new Set<string>()
    removedDuringRefresh.add(removed)
    try {
      const list = (await context.call('quirky.ask/list', { pendingOnly: true })) as Ask[]
      if (disposed || mine < appliedGeneration) return
      appliedGeneration = mine
      watermark = Math.max(watermark, eventSeq)
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
    const data = event.data as { askId?: unknown; envelope?: AskEnvelope; seq?: unknown } | null
    if (event.type === 'quirky.ask/resolved') {
      if (typeof data?.askId === 'string' && data.envelope) resolve(data.askId, data.envelope)
      if (typeof data?.seq === 'number' && data.seq > watermark) void refresh(data.seq)
      return
    }
    const seq = data?.seq
    if (typeof seq === 'number') {
      if (seq <= watermark) return
      void refresh(seq)
      return
    }
    void refresh()
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') void refresh()
  })
  void refresh()

  return {
    get: () => asks,
    flashes: () => flashes,
    queued: () => queuedCount,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    resolve,
    dispose() {
      disposed = true
      unsubscribeEvents()
      unsubscribeConnection()
      for (const timer of flashTimers.values()) clock.clearTimeout(timer)
      flashTimers.clear()
      resolvedIds.clear()
      listeners.clear()
    }
  }
}
