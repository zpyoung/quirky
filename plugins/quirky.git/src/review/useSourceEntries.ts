import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitStatus, UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import { POLL_MS, useRefreshTriggers } from '../view/data'

export type SourceEntriesData = {
  status: GitStatus | null
  error: string | null
  refresh(): void
}

/** Reads worktree status while a staged or unstaged Review scope is shown. */
export function useSourceEntries(context: UiPluginContext, worktree: string, enabled: boolean): SourceEntriesData {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const generation = useRef(0)
  const inFlight = useRef(false)
  const queued = useRef(false)

  const refresh = useCallback(() => {
    if (!enabled) return
    if (inFlight.current) {
      queued.current = true
      return
    }
    inFlight.current = true
    const mine = generation.current
    const settle = (apply: () => void) => {
      if (mine !== generation.current) return
      inFlight.current = false
      apply()
      if (queued.current) {
        queued.current = false
        refresh()
      }
    }
    void context.call('quirky.git/status', { worktree }).then(
      (result) =>
        settle(() => {
          const next = result as GitStatus
          setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next))
          setError(null)
        }),
      (failure: unknown) => settle(() => setError(messageOf(failure)))
    )
  }, [context, enabled, worktree])

  useEffect(() => {
    generation.current++
    inFlight.current = false
    queued.current = false
    setStatus(null)
    setError(null)
    if (!enabled) return

    refresh()
    const timer = setInterval(refresh, POLL_MS)
    return () => {
      generation.current++
      clearInterval(timer)
    }
  }, [enabled, refresh, worktree])
  useRefreshTriggers(context, refresh, null, worktree)

  return { status, error, refresh }
}
