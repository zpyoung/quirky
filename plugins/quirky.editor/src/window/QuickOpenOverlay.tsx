import { Button, Dialog, EmptyState, InlineError, NoticeLine, TextField } from '@quirky/ui'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { useEditorUiControl, useEditorUiControlReport, useEditorUiControlSurface, type EditorUiControl } from './uiControl'
import { dismissQuickOpen, isQuickOpenRequestCurrent, useQuickOpenRequest } from './overlayState'

type QuickOpenResult = { path: string; name: string; score: number; line?: number; column?: number }
type QuickOpenResponse = { results: QuickOpenResult[]; truncated: boolean; history: string[] }

function nameOf(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}
type Template = { relativePath: string; title: string }
type ReadStatus = 'pending' | 'success' | 'error'
type SearchRead = {
  key: string
  status: ReadStatus
  results: QuickOpenResult[]
  truncated: boolean
  error: string | null
}
type TemplateRead = {
  requestId: number
  status: ReadStatus
  templates: Template[]
  error: string | null
}


function hasOnlyKeys(value: Record<string, unknown> | undefined, allowed: readonly string[]): value is Record<string, unknown> {
  return value !== undefined && Object.keys(value).every((key) => allowed.includes(key))
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function searchKey(requestId: number, worktree: string | undefined, purpose: string, query: string): string {
  return JSON.stringify([requestId, worktree ?? null, purpose, query])
}

function openData(result: QuickOpenResult): Record<string, unknown> {
  return {
    path: result.path,
    ...(result.line === undefined ? {} : { line: result.line }),
    ...(result.column === undefined ? {} : { column: result.column })
  }
}

let nextQuickOpenMountGeneration = 0
const EMPTY_TEMPLATES: Template[] = []

/** Go-to-file dialog backed by the daemon's bounded, worktree-authorized quick-open inventory. */
export function QuickOpenOverlay({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const request = useQuickOpenRequest()
  const reportFromScope = useEditorUiControlReport()
  const surface = useEditorUiControlSurface()
  const publishReport = report ?? reportFromScope
  const [query, setQuery] = useState('')
  const [templatesQuery, setTemplatesQuery] = useState('')
  const [title, setTitle] = useState('')
  const [search, setSearch] = useState<SearchRead | null>(null)
  const [templateRead, setTemplateRead] = useState<TemplateRead | null>(null)
  const [operation, setOperation] = useState<{ session: string; busy: boolean; error: string | null } | null>(null)
  const [active, setActive] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const titleInput = useRef<HTMLInputElement>(null)
  const sequence = useRef(0)
  const mountGeneration = useRef<string | null>(null)
  const controlIdentity = useRef<{ session: string | null; isCurrent(): boolean }>({
    session: null,
    isCurrent: () => false
  })
  const busyRef = useRef<{ session: string | null; busy: boolean }>({ session: null, busy: false })
  if (mountGeneration.current === null) mountGeneration.current = `quick-open-mount-${++nextQuickOpenMountGeneration}`

  const session = request ? `${mountGeneration.current}:${request.id}` : null
  if (busyRef.current.session !== session) busyRef.current = { session, busy: false }
  const currentSearchKey = request && request.purpose !== 'markdown-new'
    ? searchKey(request.id, request.worktree, request.purpose, query)
    : null
  const currentSearch = search?.key === currentSearchKey ? search : null
  const currentTemplatesRead = request?.purpose === 'markdown-new' && templateRead?.requestId === request.id
    ? templateRead
    : null
  const results = currentSearch?.status === 'success' ? currentSearch.results : []
  const templates = currentTemplatesRead?.status === 'success' ? currentTemplatesRead.templates : EMPTY_TEMPLATES
  const visibleTemplates = useMemo(() => templates.filter((template) =>
    template.title.toLowerCase().includes(templatesQuery.toLowerCase()) ||
    template.relativePath.toLowerCase().includes(templatesQuery.toLowerCase())
  ), [templates, templatesQuery])
  const searchPending = currentSearchKey !== null && (!currentSearch || currentSearch.status === 'pending')
  const templatesPending = request?.purpose === 'markdown-new' &&
    (!currentTemplatesRead || currentTemplatesRead.status === 'pending')
  const actionBusy = session !== null && operation?.session === session && operation.busy
  const searchError = currentSearch?.status === 'error' ? currentSearch.error : null
  const templateError = currentTemplatesRead?.status === 'error' ? currentTemplatesRead.error : null
  const actionError = session !== null && operation?.session === session ? operation.error : null
  const error = actionError ?? searchError ?? templateError
  const readLoading = searchPending || templatesPending
  const truncated = currentSearch?.status === 'success' && currentSearch.truncated
  const requestId = request?.id ?? null
  const address = request && session ? {
    surface,
    target: `quick-open:${request.id}`,
    generation: session,
    actions: request.purpose === 'markdown-new' ? ['cancel', 'create-markdown'] : ['cancel', 'open']
  } : null

  useEffect(() => {
    if (!request) {
      setQuery('')
      setTemplatesQuery('')
      setTitle('')
      setActive(0)
      return
    }
    setQuery(request.query)
    setTemplatesQuery('')
    setTitle('')
    setActive(0)
    setOperation(null)
    const focusTimer = window.setTimeout(() => {
      if (request.purpose === 'markdown-new') titleInput.current?.focus()
      else input.current?.focus()
    }, 0)
    return () => window.clearTimeout(focusTimer)
  }, [request?.id, request?.purpose, request?.query])

  useEffect(() => {
    publishReport({
      open: request !== null,
      requestId,
      purpose: request?.purpose ?? null,
      worktreeId: request?.worktree ?? null,
      queryLength: request?.purpose === 'markdown-new' ? templatesQuery.length : query.length,
      loading: readLoading,
      busy: actionBusy,
      resultCount: request?.purpose === 'markdown-new' ? templates.length : results.length,
      truncated: truncated === true,
      error
    })
  }, [
    actionBusy,
    error,
    publishReport,
    query.length,
    readLoading,
    request?.id,
    request?.purpose,
    request?.worktree,
    requestId,
    results.length,
    templates.length,
    templatesQuery.length,
    truncated
  ])

  useEffect(() => {
    if (!request || request.purpose !== 'markdown-new') return
    let current = true
    const currentId = request.id
    setTemplateRead({ requestId: currentId, status: 'pending', templates: [], error: null })
    void context.call('quirky.editor/markdown', {
      action: 'templates',
      ...(request.worktree ? { worktree: request.worktree } : {})
    }).then((value) => {
      if (!current) return
      const response = value as { templates?: Template[] }
      setTemplateRead({
        requestId: currentId,
        status: 'success',
        templates: Array.isArray(response?.templates) ? response.templates : [],
        error: null
      })
    }).catch((reason: unknown) => {
      if (!current) return
      setTemplateRead({ requestId: currentId, status: 'error', templates: [], error: messageOf(reason) })
    })
    return () => { current = false }
  }, [context, request?.id, request?.purpose, request?.worktree])

  useEffect(() => {
    if (!request || request.purpose === 'markdown-new') return
    let current = true
    const attempt = ++sequence.current
    const key = searchKey(request.id, request.worktree, request.purpose, query)
    setSearch({ key, status: 'pending', results: [], truncated: false, error: null })
    const timer = window.setTimeout(() => {
      const action = query.trim() === '' ? 'history' : 'search'
      void context.call('quirky.editor/quickOpen', {
        action,
        worktree: request.worktree,
        query,
        limit: 50
      }).then((value) => {
        if (!current || attempt !== sequence.current) return
        const response = value as Partial<QuickOpenResponse>
        const ordinary = Array.isArray(response.results) ? response.results : []
        const history = Array.isArray(response.history)
          ? response.history.filter((path): path is string => typeof path === 'string')
          : []
        const recent = history.map((path, index) => ({ path, name: nameOf(path), score: -index }))
        const candidates = ordinary.length > 0 ? ordinary : recent
        const filtered = request.purpose === 'markdown-open'
          ? candidates.filter((result) => /\.(?:md|markdown|mdx)$/i.test(result.path))
          : candidates
        setSearch({
          key,
          status: 'success',
          results: filtered,
          truncated: response.truncated === true ||
            (request.purpose === 'markdown-open' && filtered.length < candidates.length && ordinary.length >= 50),
          error: null
        })
        setActive(0)
      }).catch((reason: unknown) => {
        if (!current || attempt !== sequence.current) return
        setSearch({ key, status: 'error', results: [], truncated: false, error: messageOf(reason) })
      })
    }, query.trim() === '' ? 0 : 100)
    return () => {
      current = false
      window.clearTimeout(timer)
      if (sequence.current === attempt) sequence.current += 1
    }
  }, [context, query, request?.id, request?.purpose, request?.worktree])

  const currentSession = session
  const handler = async (control: EditorUiControl) => {
    const capturedSession = currentSession
    const isCurrent = () => capturedSession !== null && request !== null &&
      isQuickOpenRequestCurrent(request.id) &&
      controlIdentity.current.session === capturedSession &&
      controlIdentity.current.isCurrent()
    if (!request || !capturedSession || !isCurrent()) return { delivered: false }

    if (control.action === 'cancel') {
      if (control.data !== undefined && (!hasOnlyKeys(control.data, []) || Object.keys(control.data).length > 0)) {
        return { delivered: false }
      }
      if (busyRef.current.session !== capturedSession || busyRef.current.busy || !isCurrent()) return { delivered: false }
      dismissQuickOpen(request.id)
      return { delivered: true }
    }

    let result: QuickOpenResult | undefined
    let selectedTemplate: string | undefined
    let requestedTitle = title
    if (control.action === 'open') {
      const data = control.data
      if (!hasOnlyKeys(data, ['path', 'line', 'column'])) return { delivered: false }
      const path = data.path
      const line = data.line
      const column = data.column
      const hasLine = Object.hasOwn(data, 'line')
      const hasColumn = Object.hasOwn(data, 'column')
      if (typeof path !== 'string' || path.trim() === '' ||
        (hasLine && (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1)) ||
        (hasColumn && (typeof column !== 'number' || !Number.isSafeInteger(column) || column < 1))) {
        return { delivered: false }
      }
      const matches = results.filter((candidate) => candidate.path === path)
      result = matches.find((candidate) =>
        (!hasLine || candidate.line === line) &&
        (!hasColumn || candidate.column === column)
      )
      if (!result || (request.purpose === 'markdown-open' && !/\.(?:md|markdown|mdx)$/i.test(result.path))) {
        return { delivered: false }
      }
    } else if (control.action === 'create-markdown') {
      const data = control.data
      if (request.purpose !== 'markdown-new' || (data !== undefined && !hasOnlyKeys(data, ['title', 'template']))) {
        return { delivered: false }
      }
      if (data && Object.hasOwn(data, 'title')) {
        if (typeof data.title !== 'string') return { delivered: false }
        requestedTitle = data.title
      }
      if (data && Object.hasOwn(data, 'template')) {
        const templatePath = data.template
        if (typeof templatePath !== 'string' || !templates.some((template) => template.relativePath === templatePath)) {
          return { delivered: false }
        }
        selectedTemplate = templatePath
      }
    } else {
      return { delivered: false }
    }
    if (busyRef.current.session !== capturedSession || busyRef.current.busy || !isCurrent()) {
      return { delivered: false }
    }
    busyRef.current.busy = true
    setOperation({ session: capturedSession, busy: true, error: null })
    let operationError: string | null = null
    try {
      if (control.action === 'open' && result) {
        await context.call('quirky.editor/open', {
          worktree: request.worktree,
          ...(request.group === undefined ? {} : { group: request.group }),
          path: result.path,
          ...(result.line === undefined ? {} : { line: result.line }),
          ...(result.column === undefined ? {} : { column: result.column }),
          focus: true,
          preview: false
        })
        if (!isCurrent()) return { delivered: false }
        await context.call('quirky.editor/quickOpen', { action: 'record', worktree: request.worktree, path: result.path })
        if (!isCurrent()) return { delivered: false }
      } else if (control.action === 'create-markdown') {
        const created = await context.call('quirky.editor/markdown', {
          action: 'new',
          ...(request.worktree ? { worktree: request.worktree } : {}),
          ...(request.group === undefined ? {} : { group: request.group }),
          title: requestedTitle,
          ...(selectedTemplate === undefined ? {} : { template: selectedTemplate })
        }) as { path?: unknown }
        if (!isCurrent()) return { delivered: false }
        if (typeof created?.path !== 'string' || created.path.trim() === '') {
          throw new Error('The Markdown template did not return the created file path.')
        }
        await context.call('quirky.editor/open', {
          worktree: request.worktree,
          ...(request.group === undefined ? {} : { group: request.group }),
          path: created.path,
          mode: 'rich',
          focus: true,
          preview: false
        })
        if (!isCurrent()) return { delivered: false }
      }
      if (!isCurrent()) return { delivered: false }
    } catch (reason) {
      if (!isCurrent()) return { delivered: false }
      operationError = messageOf(reason)
    }
    if (!isCurrent()) return { delivered: false }
    busyRef.current.busy = false
    setOperation({ session: capturedSession, busy: false, error: operationError })
    if (operationError !== null) return { delivered: true }
    dismissQuickOpen(request.id)
    return { delivered: true }
  }
  const onControlError = (reason: Error) => {
    if (!currentSession || !request || !isQuickOpenRequestCurrent(request.id) ||
      controlIdentity.current.session !== currentSession || !controlIdentity.current.isCurrent()) return
    setOperation({ session: currentSession, busy: busyRef.current.session === currentSession && busyRef.current.busy, error: reason.message })
  }
  const controls = useEditorUiControl({ context, address, handler, onError: onControlError })
  controlIdentity.current = { session, isCurrent: controls.isCurrent }

  if (!request) return null
  const newMarkdown = request.purpose === 'markdown-new'
  const markdownOpen = request.purpose === 'markdown-open'
  const heading = newMarkdown ? 'New Markdown' : markdownOpen ? 'Open Markdown' : 'Go to File'
  const emptyMessage = markdownOpen ? 'No matching Markdown documents.' : 'No matching files.'

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
      if (result) void controls.run('open', openData(result))
    } else if (event.key === 'Escape') {
      event.preventDefault()
      void controls.run('cancel')
    }
  }

  return (
    <Dialog open title={heading} onClose={() => { void controls.run('cancel') }}>
      {newMarkdown ? (
        <div className="qe-quick-open qe-quick-open--markdown-new">
          <input
            ref={titleInput}
            className="ui-text-field__input qe-quick-open__field"
            aria-label="Document title"
            placeholder="Title"
            value={title}
            disabled={actionBusy}
            onChange={(event) => setTitle(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') { event.preventDefault(); void controls.run('cancel') }
            }}
          />
          <TextField
            className="qe-quick-open__field"
            label="Search templates"
            placeholder="Search templates…"
            value={templatesQuery}
            disabled={actionBusy}
            onChange={(event) => setTemplatesQuery(event.currentTarget.value)}
          />
          {actionBusy && <NoticeLine>{'Creating Markdown…'}</NoticeLine>}
          {!actionBusy && templatesPending && <NoticeLine>{'Loading Markdown templates…'}</NoticeLine>}
          {error && <InlineError message={error} />}
          <Button variant="primary" disabled={actionBusy} onClick={() => {
            void controls.run('create-markdown', { title })
          }}>Blank Markdown (untitled.md)</Button>
          {!templatesPending && !templateError && currentTemplatesRead?.status === 'success' && visibleTemplates.length === 0 &&
            <EmptyState message="No matching templates." />}
          <ul className="qe-quick-open-results" aria-label="Markdown templates">
            {visibleTemplates.map((template) => <li key={template.relativePath}>
              <Button disabled={actionBusy} onClick={() => {
                void controls.run('create-markdown', { title, template: template.relativePath })
              }}>
                <span>{template.title}</span>
                <small>{template.relativePath}</small>
              </Button>
            </li>)}
          </ul>
          <Button disabled={actionBusy} onClick={() => { void controls.run('cancel') }}>Cancel</Button>
        </div>
      ) : (
        <div className="qe-quick-open">
          <input
            ref={input}
            className="ui-text-field__input qe-quick-open__field"
            aria-label={markdownOpen ? 'Open Markdown' : 'Go to file'}
            placeholder={markdownOpen ? 'Open Markdown…' : 'Go to file...'}
            value={query}
            disabled={actionBusy}
            onChange={(event) => {
              setQuery(event.currentTarget.value)
              setOperation((previous) => previous?.session === session ? { ...previous, error: null } : previous)
            }}
            onKeyDown={onKeyDown}
          />
          {actionBusy && <NoticeLine>{'Opening file…'}</NoticeLine>}
          {!actionBusy && searchPending && <NoticeLine>{'Searching files…'}</NoticeLine>}
          {error && <InlineError message={error} />}
          {truncated && <p className="muted">More matches may be available.</p>}
          {!searchPending && !searchError && currentSearch?.status === 'success' && results.length === 0 &&
            <EmptyState message={emptyMessage} />}
          <ul className="qe-quick-open-results" role="listbox" aria-label={markdownOpen ? 'Markdown files' : 'Files'}>
            {results.map((result, index) => (
              <li key={`${result.path}:${result.line ?? ''}:${result.column ?? ''}:${index}`}>
                <Button
                  disabled={actionBusy}
                  role="option"
                  aria-selected={index === active}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => { void controls.run('open', openData(result)) }}
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
