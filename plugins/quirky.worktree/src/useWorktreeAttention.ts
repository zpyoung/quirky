import { useEffect, useRef, useState } from 'react'
import type { Ask, QuirkyEvent, UiPluginContext } from '@quirky/protocol'

const ASK_EVENTS: Readonly<Record<string, true>> = {
  'quirky.ask/created': true,
  'quirky.ask/surfaced': true,
  'quirky.ask/updated': true,
  'quirky.ask/resolved': true
}

/** Counts durable unresolved asks by their exact canonical worktree ID; null means unknown. */
export function useWorktreeAttention(context: UiPluginContext): ReadonlyMap<string, number> | null {
  const [counts, setCounts] = useState<ReadonlyMap<string, number> | null>(null)
  const generation = useRef(0)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      const mine = ++generation.current
      try {
        const value = await context.call('quirky.ask/list', { pendingOnly: true })
        if (!Array.isArray(value)) throw new Error('quirky.ask/list returned an invalid list')
        const next = new Map<string, number>()
        for (const ask of value as Ask[]) {
          if (ask.envelope.status !== 'pending' || typeof ask.worktreeId !== 'string') continue
          next.set(ask.worktreeId, (next.get(ask.worktreeId) ?? 0) + 1)
        }
        if (active && mine === generation.current) setCounts(next)
      } catch (error) {
        if (active && mine === generation.current) {
          setCounts(null)
          context.log(`could not load pending worktree questions: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }

    const unsubscribeEvents = context.subscribe((event: QuirkyEvent) => {
      if (ASK_EVENTS[event.type] === true) void refresh()
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (status === 'connected') void refresh()
    })
    void refresh()

    return () => {
      active = false
      generation.current += 1
      unsubscribeEvents()
      unsubscribeConnection()
    }
  }, [context])

  return counts
}
