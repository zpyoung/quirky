import { useEffect, useState } from 'react'
import { RpcErrorCode, type UiPluginContext } from '@quirky/protocol'

const MAX_RESULTS = 8

export type Search = { items: string[]; unavailable: boolean }
const NONE: Search = { items: [], unavailable: false }

/**
 * Searches the worktree's files for `query` through the editor plugin. `query` null means no search is
 * wanted; `unavailable` is true when the editor plugin is not installed.
 */
export function useFileSearch(context: UiPluginContext, worktree: string, query: string | null): Search {
  const [result, setResult] = useState<Search>(NONE)

  useEffect(() => {
    if (query === null) {
      setResult(NONE)
      return
    }
    let cancelled = false
    context
      .call('quirky.editor/quickOpen', { worktree, action: 'search', query, limit: MAX_RESULTS })
      .then((found) => {
        if (cancelled) return
        const results = (found as { results?: { path: string }[] } | undefined)?.results ?? []
        setResult({ items: results.map((entry) => entry.path), unavailable: false })
      })
      .catch((error: { code?: unknown }) => {
        if (!cancelled) setResult({ items: [], unavailable: error?.code === RpcErrorCode.MethodNotFound })
      })
    return () => {
      cancelled = true
    }
  }, [context, worktree, query])

  return result
}
