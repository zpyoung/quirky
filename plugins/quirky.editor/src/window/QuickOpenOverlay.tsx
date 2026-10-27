import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { dismissQuickOpen, useQuickOpenRequest } from '../overlayState'

type QuickOpenResult = { path: string; name: string; score: number; line?: number; column?: number }
type QuickOpenResponse = { results: QuickOpenResult[]; truncated: boolean; history: string[] }

function nameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

/** Go-to-file dialog backed by the daemon's bounded, worktree-authorized quick-open inventory. */
export function QuickOpenOverlay({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const request = useQuickOpenRequest()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<QuickOpenResult[]>([])
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)

  useEffect(() => {
    if (!request) return
    setQuery(request.query)
    setActive(0)
    setError(null)
    window.setTimeout(() => input.current?.focus(), 0)
  }, [request?.id])
  useEffect(() => {
    report?.({
      open: request !== null,
      requestId: request?.id ?? null,
      worktreeId: request?.worktree ?? null,
      queryLength: query.length,
      loading,
      resultCount: results.length,
      truncated,
      error
    })
  }, [report, request?.id, request?.worktree, query, loading, results.length, truncated, error])


  useEffect(() => {
    if (!request) return
    const attempt = ++sequence.current
    const timer = window.setTimeout(() => {
      setLoading(true)
      setError(null)
      const action = query.trim() === '' ? 'history' : 'search'
      context.call('quirky.editor/quickOpen', {
        action,
        worktree: request.worktree,
        query,
        limit: 50
      }).then((value) => {
        if (attempt !== sequence.current) return
        const response = value as QuickOpenResponse
        const recent = (response.history ?? []).map((path, index) => ({ path, name: nameOf(path), score: -index }))
        setResults(response.results.length > 0 ? response.results : recent)
        setTruncated(response.truncated)
        setActive(0)
      }).catch((reason: unknown) => {
        if (attempt !== sequence.current) return
        setResults([])
        setTruncated(false)
        setError(reason instanceof Error ? reason.message : String(reason))
      }).finally(() => {
        if (attempt === sequence.current) setLoading(false)
      })
    }, query.trim() === '' ? 0 : 100)
    return () => {
      window.clearTimeout(timer)
      sequence.current += 1
    }
  }, [context, query, request?.id, request?.worktree])

  if (!request) return null

  const openResult = async (result: QuickOpenResult) => {
    try {
      await context.call('quirky.editor/open', {
        worktree: request.worktree,
        path: result.path,
        ...(result.line === undefined ? {} : { line: result.line }),
        ...(result.column === undefined ? {} : { column: result.column }),
        focus: true,
        preview: false
      })
      await context.call('quirky.editor/quickOpen', { action: 'record', worktree: request.worktree, path: result.path })
      dismissQuickOpen(request.id)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((current) => Math.min(results.length - 1, current + 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((current) => Math.max(0, current - 1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const result = results[active]
      if (result) void openResult(result)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      dismissQuickOpen(request.id)
    }
  }

  return (
    <div className="qe-modal-layer" onMouseDown={(event) => { if (event.target === event.currentTarget) dismissQuickOpen(request.id) }}>
      <section className="qe-quick-open" role="dialog" aria-modal="true" aria-labelledby="qe-quick-open-title">
        <h2 id="qe-quick-open-title">Go to File</h2>
        <input
          ref={input}
          aria-label="Go to file"
          placeholder="Go to file..."
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={onKeyDown}
        />
        {loading && <p className="muted">Searching files…</p>}
        {error && <p className="qe-editor-error" role="alert">{error}</p>}
        {truncated && <p className="muted">More matches may be available.</p>}
        <ul className="qe-quick-open-results" role="listbox" aria-label="Files">
          {results.map((result, index) => (
            <li key={`${result.path}:${result.line ?? ''}:${index}`}>
              <button
                type="button"
                role="option"
                aria-selected={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => void openResult(result)}
              >
                <span>{result.name}</span>
                <small>{result.path}{result.line === undefined ? '' : `:${result.line}${result.column === undefined ? '' : `:${result.column}`}`}</small>
              </button>
            </li>
          ))}
        </ul>
        <footer><span>↑↓ Move</span><span>Enter Open</span><span>Esc Close</span></footer>
      </section>
    </div>
  )
}
