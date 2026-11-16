import { useEffect, useState, type CSSProperties } from 'react'
import { RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
import { EmptyState, InlineError } from '@quirky/ui'

const MAX_RESULTS = 8

type Search = { items: string[]; unavailable: boolean }
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

const popover = {
  position: 'absolute',
  insetInline: 'var(--ui-space-8)',
  insetBlockEnd: '100%',
  zIndex: 1,
  margin: 0,
  padding: 'var(--ui-space-4)',
  listStyle: 'none',
  maxHeight: 'calc(var(--ui-row-single) * 6)',
  overflowY: 'auto',
  color: 'var(--ui-text)',
  background: 'var(--ui-surface)',
  border: 'var(--ui-border-width) solid var(--ui-border)',
  borderRadius: 'var(--ui-radius-control)'
} satisfies CSSProperties

const option = {
  padding: 'var(--ui-space-4) var(--ui-space-8)',
  borderRadius: 'var(--ui-radius-mark)',
  fontFamily: 'var(--ui-font-mono)',
  cursor: 'pointer',
  overflowWrap: 'anywhere'
} satisfies CSSProperties

const note = { ...popover, color: 'var(--ui-muted)', padding: 'var(--ui-space-8)' } satisfies CSSProperties

/** The `@file` list above the composer; `active` is the highlighted index and `onPick` receives a path. */
export function Mentions({ search, active, onPick }: { search: Search; active: number; onPick: (path: string) => void }) {
  if (search.unavailable) return <div style={note}><InlineError message="File search unavailable" /></div>
  if (search.items.length === 0) return <div style={note} role="status"><EmptyState message="No matching files" /></div>
  return (
    <ul style={popover} role="listbox" aria-label="Files">
      {search.items.map((path, index) => (
        <li
          key={path}
          role="option"
          aria-selected={index === active}
          style={{ ...option, background: index === active ? 'var(--ui-selected)' : undefined }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(path)}
        >
          {path}
        </li>
      ))}
    </ul>
  )
}
