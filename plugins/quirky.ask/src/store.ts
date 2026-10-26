import type { Ask, QuirkyEvent, UiPluginContext } from '@quirky/protocol'

export const PANEL_ID = 'panel:quirky.ask/questions'

export type AskStore = {
  get(): readonly Ask[]
  subscribe(listener: () => void): () => void
  /** Drops an ask from the list at once, before the daemon's `resolved` event arrives. */
  remove(askId: string): void
  dispose(): void
}

/** What the panel reports to `ui.state`: each pending ask with its title as shown and its question count. */
export function reportOf(asks: readonly Ask[]): { pending: { askId: string; title: string; questions: number }[] } {
  return {
    pending: asks.map((ask) => ({ askId: ask.id, title: ask.spec.title ?? ASK_FALLBACK_TITLE, questions: ask.spec.questions.length }))
  }
}

export const ASK_FALLBACK_TITLE = 'An agent has a question'

/**
 * Tracks the pending asks from the daemon and mirrors their count onto the panel's badge, whether
 * or not the panel is mounted. Re-reads the list on every ask event and on reconnect.
 */
export function createAskStore(context: UiPluginContext): AskStore {
  let asks: readonly Ask[] = []
  let generation = 0
  let disposed = false
  const listeners = new Set<() => void>()

  const publish = (next: readonly Ask[]) => {
    asks = next
    context.setPanelBadge(PANEL_ID, next.length === 0 ? null : next.length)
    for (const listener of [...listeners]) listener()
  }

  const refresh = async () => {
    const mine = ++generation
    try {
      const list = (await context.call('quirky.ask/list', { pendingOnly: true })) as Ask[]
      if (disposed || mine !== generation) return
      publish([...list].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)))
    } catch (error) {
      context.log(`could not list asks: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
    if (event.type === 'quirky.ask/created' || event.type === 'quirky.ask/resolved') void refresh()
  })
  const unsubscribeConnection = context.onConnection((status) => {
    if (status === 'connected') void refresh()
  })
  void refresh()

  return {
    get: () => asks,
    subscribe(listener) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    remove(askId) {
      if (!asks.some((ask) => ask.id === askId)) return
      generation++
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
