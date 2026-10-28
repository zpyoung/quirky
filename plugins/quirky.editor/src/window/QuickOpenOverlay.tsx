import { Button, Dialog, EmptyState, TextField } from '@quirky/ui'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { dismissQuickOpen, useQuickOpenRequest } from './overlayState'

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
  const [templates, setTemplates] = useState<{ relativePath: string; title: string }[]>([])
  const [title, setTitle] = useState('')
  const [templateQuery, setTemplateQuery] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const visibleTemplates = useMemo(() => templates.filter((template) =>
    template.title.toLowerCase().includes(templateQuery.toLowerCase()) ||
    template.relativePath.toLowerCase().includes(templateQuery.toLowerCase())
  ), [templateQuery, templates])

  useEffect(() => {
    if (!request) return
    setQuery(request.query)
    setTemplateQuery('')
    setTitle('')
    setTemplates([])
    setActive(0)
    setError(null)
    window.setTimeout(() => {
      if (request.purpose === 'markdown-new') titleInput.current?.focus()
      else input.current?.focus()
    }, 0)
  }, [request?.id, request?.purpose, request?.query])

  useEffect(() => {
    report?.({
      open: request !== null,
      requestId: request?.id ?? null,
      purpose: request?.purpose ?? null,
      worktreeId: request?.worktree ?? null,
      queryLength: request?.purpose === 'markdown-new' ? templateQuery.length : query.length,
      loading,
      resultCount: request?.purpose === 'markdown-new' ? templates.length : results.length,
      truncated,
      error
    })
  }, [error, loading, query, report, request?.id, request?.purpose, request?.worktree, results.length, templateQuery, templates.length, truncated])

  useEffect(() => {
    if (!request || request.purpose !== 'markdown-new') return
    let active = true
    setLoading(true)
    setError(null)
    context.call('quirky.editor/markdown', {
      action: 'templates',
      ...(request.worktree ? { worktree: request.worktree } : {})
    }).then((value) => {
      if (!active) return
      const response = value as { templates?: { relativePath: string; title: string }[] }
      setTemplates(response.templates ?? [])
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [context, request?.id, request?.purpose, request?.worktree])

  useEffect(() => {
    if (!request || request.purpose === 'markdown-new') return
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
        const candidates = response.results.length > 0 ? response.results : recent
        const filtered = request.purpose === 'markdown-open'
          ? candidates.filter((result) => /\.(?:md|markdown|mdx)$/i.test(result.path))
          : candidates
        setResults(filtered)
        setTruncated(response.truncated || (request.purpose === 'markdown-open' && filtered.length < candidates.length && response.results.length >= 50))
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
  }, [context, query, request?.id, request?.purpose, request?.worktree])

  if (!request) return null

  const openResult = async (result: QuickOpenResult) => {
    try {
      if (request.purpose === 'markdown-open' && !/\.(?:md|markdown|mdx)$/i.test(result.path)) {
        throw new Error('Choose a Markdown document.')
      }
      await context.call('quirky.editor/open', {
        worktree: request.worktree,
        ...(request.group === undefined ? {} : { group: request.group }),
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

  const createMarkdown = async (template?: string) => {
    try {
      const result = await context.call('quirky.editor/markdown', {
        action: 'new',
        ...(request.worktree ? { worktree: request.worktree } : {}),
        ...(request.group === undefined ? {} : { group: request.group }),
        title,
        ...(template ? { template } : {})
      }) as { path?: string }
      if (!result.path) throw new Error('The Markdown template did not return the created file path.')
      await context.call('quirky.editor/open', {
        worktree: request.worktree,
        ...(request.group === undefined ? {} : { group: request.group }),
        path: result.path,
        mode: 'rich',
        focus: true,
        preview: false
      })
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

  const newMarkdown = request.purpose === 'markdown-new'
  const markdownOpen = request.purpose === 'markdown-open'
  const heading = newMarkdown ? 'New Markdown' : markdownOpen ? 'Open Markdown' : 'Go to File'

  return (
    <Dialog open title={heading} onClose={() => dismissQuickOpen(request.id)}>
      {newMarkdown ? (
        <div className="qe-quick-open qe-quick-open--markdown-new">
          <input
            ref={titleInput}
            className="ui-text-field__input qe-quick-open__field"
            aria-label="Document title"
            placeholder="Title"
            value={title}
            onChange={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); dismissQuickOpen(request.id) }
            }}
          />
          <TextField
            className="qe-quick-open__field"
            label="Search templates"
            placeholder="Search templates…"
            value={templateQuery}
            onChange={(event) => setTemplateQuery(event.currentTarget.value)}
          />
          {loading && <p className="muted" role="status">Loading Markdown templates…</p>}
          {error && <p className="qe-editor-error" role="alert">{error}</p>}
          <Button variant="primary" onClick={() => void createMarkdown()}>Blank Markdown (untitled.md)</Button>
          {visibleTemplates.length === 0 && templates.length > 0 && <EmptyState message="No matching templates." />}
          <ul className="qe-quick-open-results" aria-label="Markdown templates">
            {visibleTemplates.map((template) => <li key={template.relativePath}>
              <Button onClick={() => void createMarkdown(template.relativePath)}>
                <span>{template.title}</span>
                <small>{template.relativePath}</small>
              </Button>
            </li>)}
          </ul>
          <Button onClick={() => dismissQuickOpen(request.id)}>Cancel</Button>
        </div>
      ) : (
        <div className="qe-quick-open">
          <input
            ref={input}
            className="ui-text-field__input qe-quick-open__field"
            aria-label={markdownOpen ? 'Open Markdown' : 'Go to file'}
            placeholder={markdownOpen ? 'Open Markdown…' : 'Go to file...'}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={onKeyDown}
          />
          {loading && <p className="muted" role="status">Searching files…</p>}
          {error && <p className="qe-editor-error" role="alert">{error}</p>}
          {truncated && <p className="muted">More matches may be available.</p>}
          {markdownOpen && !loading && !error && results.length === 0 && <EmptyState message="No matching Markdown documents." />}
          <ul className="qe-quick-open-results" role="listbox" aria-label={markdownOpen ? 'Markdown files' : 'Files'}>
            {results.map((result, index) => (
              <li key={`${result.path}:${result.line ?? ''}:${index}`}>
                <Button
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => void openResult(result)}
                >
                  <span>{result.name}</span>
                  <small>{result.path}{result.line === undefined ? '' : `:${result.line}${result.column === undefined ? '' : `:${result.column}`}`}</small>
                </Button>
              </li>
            ))}
          </ul>
          <footer><span>↑↓ Move</span><span>Enter Open</span><span>Esc Close</span></footer>
        </div>
      )}
    </Dialog>
  )
}
