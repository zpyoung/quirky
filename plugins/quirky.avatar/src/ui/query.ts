import { useCallback, useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { Level, WorktreeState } from '../contracts'

/** What `quirky.avatar/status` returns. */
export type StatusResult = { handoffs: { worktreeId: string; name: string; projectName?: string; state: WorktreeState; level: Level }[]; needsYouCount: number }

export const CHANGED_EVENT = 'quirky.avatar/changed'

export const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * Calls `quirky.avatar/<method>` on mount and again on every `quirky.avatar/changed` event.
 * A reply that arrives after a newer request, or after unmount, is dropped; a failed refresh keeps
 * the last good data and reports the error.
 */
export function useAvatarQuery<T>(context: UiPluginContext, method: string, params: Record<string, unknown> = {}) {
  const key = JSON.stringify(params)
  const [state, setState] = useState<{ data: T | null; error: string | null }>({ data: null, error: null })
  const generation = useRef(0)

  const refresh = useCallback(() => {
    const mine = ++generation.current
    context.call(`quirky.avatar/${method}`, JSON.parse(key) as Record<string, unknown>).then(
      (data) => {
        if (mine === generation.current) setState({ data: data as T, error: null })
      },
      (cause: unknown) => {
        if (mine === generation.current) setState((previous) => ({ data: previous.data, error: messageOf(cause) }))
      }
    )
  }, [context, method, key])

  useEffect(() => {
    refresh()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === CHANGED_EVENT) refresh()
    })
    return () => {
      generation.current += 1
      unsubscribe()
    }
  }, [context, refresh])

  return { ...state, refresh }
}
