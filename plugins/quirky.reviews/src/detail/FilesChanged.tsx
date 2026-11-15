import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useDraftField } from '../draft-field'
import { Badge, Button, EmptyState, FormRow, InlineError, ListRow, NoticeLine, SectionHeader, TextField } from '@quirky/ui'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import { REVIEW_VIEW, type ReviewsSurfaceProps } from '../contracts'
import { parseCommentsResult, parseFilesResult, reviewContext, type ChangedFile, type ReviewComment } from './data'
import { registerReviewsUiControl, requestReviewsUiControl, type ReviewsUiControlRequest } from '../checks/data'

type DiffLine = { text: string; kind: 'context' | 'addition' | 'deletion' | 'meta'; leftLine: number | null; rightLine: number | null }
type InlineAnchor = { path: string; line: number; startLine: number }

type FilesView = {
  fileFilter: string
  diffMode: 'inline' | 'side-by-side'
  selectedFile: string | null
  collapsedFiles: string[]
  treeVisible: boolean
}

function equalFilesView(left: FilesView, right: FilesView): boolean {
  return left.fileFilter === right.fileFilter
    && left.diffMode === right.diffMode
    && left.selectedFile === right.selectedFile
    && left.treeVisible === right.treeVisible
    && left.collapsedFiles.length === right.collapsedFiles.length
    && left.collapsedFiles.every((path, index) => path === right.collapsedFiles[index])
}

const MAX_PATCH_CHARS = 250_000

function parsePatch(patch: string): { lines: DiffLine[]; truncated: boolean } {
  const bounded = patch.slice(0, MAX_PATCH_CHARS)
  const truncated = bounded.length < patch.length
  const lines: DiffLine[] = []
  let oldLine = 0
  let newLine = 0
  for (const text of bounded.split('\n')) {
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text)
    if (header) {
      oldLine = Number(header[1])
      newLine = Number(header[2])
      lines.push({ text, kind: 'meta', leftLine: null, rightLine: null })
      continue
    }
    if (text.startsWith('+') && !text.startsWith('+++')) {
      lines.push({ text, kind: 'addition', leftLine: null, rightLine: newLine })
      newLine += 1
    } else if (text.startsWith('-') && !text.startsWith('---')) {
      lines.push({ text, kind: 'deletion', leftLine: oldLine, rightLine: null })
      oldLine += 1
    } else if (text.startsWith(' ')) {
      lines.push({ text, kind: 'context', leftLine: oldLine, rightLine: newLine })
      oldLine += 1
      newLine += 1
    } else {
      lines.push({ text, kind: 'meta', leftLine: null, rightLine: null })
    }
  }
  return { lines, truncated }
}

function ownerParams(props: ReviewsSurfaceProps) {
  const owner = reviewContext(props.state, 'detail')
  if (owner === null) return null
  return {
    owner,
    params: {
      worktree: owner.worktree,
      number: owner.number,
      ...(owner.repo === null ? {} : { prRepo: owner.repo }),
    },
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commentLines(value: unknown, number: number): ReviewComment[] {
  const parsed = value === null ? null : parseCommentsResult(value, number)
  return parsed?.comments as unknown as ReviewComment[] | undefined ?? []
}

function controlValue(request: ReviewsUiControlRequest, keys: string[]) {
  const value = request.value ?? {}
  if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error('Invalid file control arguments.')
  return value
}

type FileControlLease = { target: string; generation: number; active: boolean; changed(): void; dispose(): void }

export function FilesChanged(props: ReviewsSurfaceProps) {
  const ownerInfo = ownerParams(props)
  const owner = ownerInfo?.owner ?? null
  const params = ownerInfo?.params ?? null
  const parsedFiles = owner === null || props.state.detail.files === null ? null : parseFilesResult(props.state.detail.files, owner.number)
  const files = parsedFiles?.files as ChangedFile[] | undefined ?? null
  const filesUnavailable = parsedFiles?.filesUnavailable === true
  const malformedFiles = props.state.detail.files !== null && parsedFiles === null
  const head = owner?.review?.headRefOid ?? null
  const headValid = typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)
  const repo = owner?.repo
  const target = JSON.stringify([REVIEW_VIEW, 'files-changed', owner?.worktree ?? null,
    repo ? { host: repo.host, owner: repo.owner, repo: repo.repo } : null, owner?.number ?? null, head, null])
  const ownerKey = JSON.stringify([target, owner?.generation])
  const comments = owner === null ? [] : commentLines(props.state.detail.comments, owner.number)
  const allFiles = files ?? []
  const remoteView: FilesView = {
    fileFilter: props.state.detail.fileFilter,
    diffMode: props.state.detail.diffMode,
    selectedFile: props.state.detail.selectedFile,
    collapsedFiles: props.state.detail.collapsedFiles,
    treeVisible: props.state.detail.fileTreeVisible,
  }
  const identity = ownerKey
  const filesView = useDraftField<FilesView>({
    identity,
    remote: remoteView,
    snapshot: props.snapshot,
    write: async (value) => {
      if (owner === null || params === null) return false
      await props.context.call('quirky.reviews/detailSetFilesView', {
        ...params,
        generation: owner.generation,
        fileFilter: value.fileFilter,
        diffMode: value.diffMode,
        selectedFile: value.selectedFile,
        collapsedFiles: value.collapsedFiles,
        treeVisible: value.treeVisible,
      })
    },
    refresh: props.refresh,
    resend: true,
    equal: equalFilesView,
  })
  const filesViewRef = useRef(filesView)
  const filteredFiles = useMemo(() => allFiles.filter((file) => file.path.toLowerCase().includes(filesView.value.fileFilter.toLowerCase())), [allFiles, filesView.value.fileFilter])
  const treeVisible = filesView.value.treeVisible
  const [rangeStart, setRangeStart] = useState<{ path: string; line: number } | null>(null)
  const rangeStartRef = useRef(rangeStart)
  const [inlineAnchor, setInlineAnchor] = useState<InlineAnchor | null>(null)
  const inlineAnchorRef = useRef(inlineAnchor)
  const [inlineDraft, setInlineDraft] = useState('')
  const inlineDraftRef = useRef('')
  const [inlineSession, setInlineSession] = useState(0)
  const inlineSessionRef = useRef(0)
  const [pendingPaths, setPendingPaths] = useState(new Set<string>())
  const pendingPathsRef = useRef(new Map<string, symbol>())
  const [refreshBusy, setRefreshBusy] = useState(false)
  const refreshTokenRef = useRef<symbol | null>(null)
  const [busyInline, setBusyInline] = useState(false)
  const busyInlineRef = useRef<number | null>(null)
  const busyInlineTokenRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const registration = useRef<FileControlLease | null>(null)
  const inlineRegistration = useRef<FileControlLease | null>(null)
  const [generation, setGeneration] = useState<number>()
  const [inlineGeneration, setInlineGeneration] = useState<number>()
  type Handler = {
    ownerKey: string
    actions(): Array<{ action: string; enabled: boolean }>
    run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
  }
  const current = useRef<Handler | null>(null)
  const currentInline = useRef<Handler | null>(null)
  const inlineTarget = JSON.stringify([REVIEW_VIEW, 'files-inline-comment', owner?.worktree ?? null,
    repo ? { host: repo.host, owner: repo.owner, repo: repo.repo } : null, owner?.number ?? null, head,
    inlineAnchor === null ? null : `inline-comment:${inlineAnchor.path}:${inlineAnchor.startLine}-${inlineAnchor.line}`])
  const viewedCount = allFiles.filter((file) => file.viewed === true).length
  const unknownViewedCount = allFiles.filter((file) => file.viewed === null).length
  const collapsed = new Set(filesView.value.collapsedFiles)
  useLayoutEffect(() => {
    current.current = { ownerKey, actions, run }
    currentInline.current = { ownerKey, actions: inlineActions, run: runInline }
  })
  useLayoutEffect(() => {
    rangeStartRef.current = null
    inlineAnchorRef.current = null
    inlineDraftRef.current = ''
    inlineSessionRef.current += 1
    busyInlineTokenRef.current += 1
    busyInlineRef.current = null
    pendingPathsRef.current.clear()
    refreshTokenRef.current = null
    setRangeStart(null)
    setInlineAnchor(null)
    setInlineDraft('')
    setInlineSession(inlineSessionRef.current)
    setBusyInline(false)
    setPendingPaths(new Set())
    setRefreshBusy(false)
    setError(null)
    if (owner === null) { setGeneration(undefined); return }
    const control = registerReviewsUiControl(props.context, {
      surface: REVIEW_VIEW, slot: 'files-changed', target,
      actions: () => current.current!.actions(),
      run: (request, isCurrent) => current.current!.run(request, isCurrent),
    })
    const lease = { ...control, target, active: true }
    registration.current = lease
    setGeneration(lease.generation)
    return () => {
      lease.active = false
      lease.dispose()
      if (registration.current === lease) registration.current = null
    }
  }, [props.context, ownerKey])
  useLayoutEffect(() => {
    if (owner === null || inlineAnchorRef.current === null) { setInlineGeneration(undefined); return }
    const session = inlineSessionRef.current
    const control = registerReviewsUiControl(props.context, {
      surface: REVIEW_VIEW, slot: 'files-inline-comment', target: inlineTarget,
      actions: () => currentInline.current!.actions(),
      run: (request, isCurrent) => currentInline.current!.run(request, () => isCurrent() && session === inlineSessionRef.current),
    })
    const lease = { ...control, target: inlineTarget, active: true }
    inlineRegistration.current = lease
    setInlineGeneration(lease.generation)
    return () => {
      lease.active = false
      lease.dispose()
      if (inlineRegistration.current === lease) inlineRegistration.current = null
    }
  }, [props.context, ownerKey, inlineTarget, inlineSession])

  const setFilesView = (change: Partial<FilesView>) => filesViewRef.current.edit({ ...filesViewRef.current.value, ...change })
  const editInlineDraft = (body: string) => { inlineDraftRef.current = body; setInlineDraft(body) }
  const renewInlineSession = () => { inlineSessionRef.current += 1; setInlineSession(inlineSessionRef.current) }
  const closeInline = () => { inlineAnchorRef.current = null; setInlineAnchor(null); editInlineDraft(''); renewInlineSession() }
  const requestControl = async (action: string, value?: Record<string, unknown>, inline = false) => {
    const lease = inline ? inlineRegistration.current : registration.current
    if (lease === null) return
    const origin = { ownerKey, generation: lease.generation, session: inlineSessionRef.current }
    const sessionBound = inline || action === 'inline-comment-open' || action === 'range-start-set'
    const isCurrent = () => lease.active && (inline ? inlineRegistration.current : registration.current) === lease
      && lease.generation === origin.generation && current.current?.ownerKey === origin.ownerKey
      && (!sessionBound || inlineSessionRef.current === origin.session)
    try {
      const result = await requestReviewsUiControl(props.context, {
        target: lease.target, generation: origin.generation, action, ...(value === undefined ? {} : { value }),
      })
      if (!result.delivered && isCurrent()) setError(result.reason === 'target-unavailable'
        ? 'Target review control is no longer available.' : result.reason === 'disabled'
          ? 'That review control is currently disabled.' : 'Unsupported review control action.')
    } catch (cause) { if (isCurrent()) setError(errorText(cause)) }
  }
  const fileFor = (path: unknown) => {
    const file = typeof path === 'string' ? allFiles.find((item) => item.path === path) : undefined
    if (!file) throw new Error('That changed file is no longer available.')
    return file
  }
  const validateAnchor = (path: unknown, line: unknown, startLine?: unknown): InlineAnchor => {
    const file = fileFor(path)
    if (file.isBinary || file.patchUnavailable || file.patch === null) throw new Error('A text patch is required for an inline comment.')
    if (typeof line !== 'number' || !Number.isSafeInteger(line) || line < 1) throw new Error('Invalid inline comment line.')
    if (startLine !== undefined && typeof startLine !== 'number') throw new Error('Invalid inline comment range.')
    const start = startLine ?? (rangeStartRef.current?.path === file.path && rangeStartRef.current.line <= line ? rangeStartRef.current.line : line)
    if (typeof start !== 'number' || !Number.isSafeInteger(start) || start < 1 || start > line) throw new Error('Invalid inline comment range.')
    const lines = parsePatch(file.patch).lines
    if (!lines.some((item) => item.rightLine === line) || !lines.some((item) => item.rightLine === start)) throw new Error('The inline comment range is not rendered in this patch.')
    return { path: file.path, line, startLine: start }
  }
  const actions = () => [
    { action: 'refresh', enabled: !props.state.detail.loading && refreshTokenRef.current === null },
    { action: 'tree-toggle', enabled: true },
    { action: 'collapse-all', enabled: allFiles.length > 0 },
    { action: 'expand-all', enabled: allFiles.length > 0 },
    { action: 'diff-mode-set', enabled: true },
    { action: 'file-select', enabled: true },
    { action: 'file-toggle-collapse', enabled: allFiles.length > 0 },
    { action: 'file-set-viewed', enabled: allFiles.length > 0 },
    { action: 'range-start-set', enabled: headValid && busyInlineRef.current === null },
    { action: 'inline-comment-open', enabled: headValid && busyInlineRef.current === null },
  ]
  const run = async (request: ReviewsUiControlRequest, isCurrent: () => boolean) => {
    if (!isCurrent() || params === null) return
    const action = request.action
    if (action === 'refresh') {
      controlValue(request, [])
      if (props.state.detail.loading || refreshTokenRef.current !== null) return
      const token = Symbol()
      refreshTokenRef.current = token
      setRefreshBusy(true)
      setError(null)
      try { await props.context.call('quirky.reviews/detailRefresh', { ...params, surface: 'detail' }) }
      catch (cause) { if (isCurrent() && refreshTokenRef.current === token) setError(errorText(cause)) }
      finally {
        if (isCurrent() && refreshTokenRef.current === token) { refreshTokenRef.current = null; setRefreshBusy(false) }
      }
      return
    }
    if (action === 'tree-toggle') {
      const value = controlValue(request, ['visible'])
      if (value.visible !== undefined && typeof value.visible !== 'boolean') throw new Error('Invalid file-tree visibility.')
      setFilesView({ treeVisible: value.visible ?? !filesViewRef.current.value.treeVisible })
      return
    }
    if (action === 'collapse-all' || action === 'expand-all') {
      controlValue(request, [])
      if (allFiles.length > 0) setFilesView({ collapsedFiles: action === 'collapse-all' ? allFiles.map((file) => file.path) : [] })
      return
    }
    if (action === 'diff-mode-set') {
      const value = controlValue(request, ['mode'])
      if (value.mode !== 'inline' && value.mode !== 'side-by-side') throw new Error('Invalid diff mode.')
      setFilesView({ diffMode: value.mode })
      return
    }
    if (action === 'file-select') {
      const value = controlValue(request, ['path'])
      setFilesView({ selectedFile: value.path === null ? null : fileFor(value.path).path })
      return
    }
    if (action === 'file-toggle-collapse' || action === 'file-set-viewed') {
      const value = controlValue(request, action === 'file-toggle-collapse' ? ['path', 'collapsed'] : ['path', 'viewed'])
      const file = fileFor(value.path)
      if (action === 'file-toggle-collapse') {
        if (value.collapsed !== undefined && typeof value.collapsed !== 'boolean') throw new Error('Invalid file collapse state.')
        const paths = filesViewRef.current.value.collapsedFiles
        const shouldCollapse = value.collapsed ?? !paths.includes(file.path)
        setFilesView({ collapsedFiles: shouldCollapse ? [...new Set([...paths, file.path])] : paths.filter((path) => path !== file.path) })
        return
      }
      if (value.viewed !== undefined && typeof value.viewed !== 'boolean') throw new Error('Invalid viewed state.')
      if (pendingPathsRef.current.has(file.path)) return
      if (!headValid) { setError('The current pull request head is unavailable; refresh before changing file state.'); return }
      const token = Symbol()
      pendingPathsRef.current.set(file.path, token)
      setPendingPaths(new Set(pendingPathsRef.current.keys()))
      setError(null)
      try { await props.context.call('quirky.reviews/detailSetFileViewed', { ...params, surface: 'detail', path: file.path, viewed: value.viewed ?? file.viewed !== true }) }
      catch (cause) { if (isCurrent() && pendingPathsRef.current.get(file.path) === token) setError(errorText(cause)) }
      finally {
        if (isCurrent() && pendingPathsRef.current.get(file.path) === token) {
          pendingPathsRef.current.delete(file.path)
          setPendingPaths(new Set(pendingPathsRef.current.keys()))
        }
      }
      return
    }
    const value = controlValue(request, action === 'range-start-set' ? ['path', 'line'] : ['path', 'line', 'startLine'])
    if (!headValid || busyInlineRef.current !== null) return
    const anchor = validateAnchor(value.path, value.line, action === 'range-start-set' ? value.line : value.startLine)
    if (action === 'range-start-set') {
      rangeStartRef.current = { path: anchor.path, line: anchor.line }
      setRangeStart(rangeStartRef.current)
    } else {
      if (inlineAnchorRef.current === null) editInlineDraft('')
      inlineAnchorRef.current = anchor
      setInlineAnchor(anchor)
      renewInlineSession()
    }
  }
  const inlineActions = () => [
    { action: 'inline-comment-draft', enabled: busyInlineRef.current === null },
    { action: 'inline-comment-submit', enabled: headValid && busyInlineRef.current === null && inlineDraftRef.current.trim() !== '' },
    { action: 'inline-comment-cancel', enabled: busyInlineRef.current === null },
  ]
  const runInline = async (request: ReviewsUiControlRequest, isCurrent: () => boolean) => {
    if (!isCurrent() || params === null || inlineAnchorRef.current === null || busyInlineRef.current !== null) return
    const value = controlValue(request, request.action === 'inline-comment-draft' ? ['body'] : [])
    if (request.action === 'inline-comment-draft') {
      if (typeof value.body !== 'string' || new TextEncoder().encode(value.body).byteLength > 65_536) throw new Error('Invalid inline comment body.')
      editInlineDraft(value.body)
      return
    }
    if (request.action === 'inline-comment-cancel') { closeInline(); return }
    const body = inlineDraftRef.current
    if (!headValid || body.trim() === '') return
    if (new TextEncoder().encode(body).byteLength > 65_536) throw new Error('Inline comment exceeds 65,536 UTF-8 bytes.')
    const anchor = validateAnchor(inlineAnchorRef.current.path, inlineAnchorRef.current.line, inlineAnchorRef.current.startLine)
    const session = inlineSessionRef.current
    const token = ++busyInlineTokenRef.current
    const originIsCurrent = () => isCurrent() && token === busyInlineTokenRef.current && session === inlineSessionRef.current
    busyInlineRef.current = token
    setBusyInline(true)
    setError(null)
    try {
      await props.context.call('quirky.reviews/detailInlineComment', {
        ...params, surface: 'detail', expectedHead: head, path: anchor.path, line: anchor.line,
        ...(anchor.startLine === anchor.line ? {} : { startLine: anchor.startLine }), body,
      })
      if (originIsCurrent()) { busyInlineRef.current = null; setBusyInline(false); closeInline() }
    } catch (cause) { if (originIsCurrent()) setError(errorText(cause)) }
    finally {
      if (originIsCurrent()) { busyInlineRef.current = null; setBusyInline(false) }
    }
  }
  const actionKey = JSON.stringify(actions())
  const inlineActionKey = JSON.stringify(inlineActions())
  useEffect(() => { registration.current?.changed() }, [actionKey, generation, pendingPaths])
  useEffect(() => { inlineRegistration.current?.changed() }, [inlineActionKey, inlineGeneration])
  const controlMetadata = { 'data-review-control-target': target, 'data-review-control-generation': generation }
  const errors = <>
    {props.state.detail.error !== null && <InlineError message={props.state.detail.error} />}
    {error !== null && <InlineError message={error} />}
    {filesView.error !== null && <InlineError message={filesView.error} />}
    {malformedFiles && props.state.detail.error === null && <InlineError message="Couldn’t load changed files." />}
    {Array.isArray(parsedFiles?.partialFailures) && parsedFiles.partialFailures.length > 0 && <InlineError message={parsedFiles.partialFailures.join(' ')} />}
  </>
  const matchingInlineComments = (path: string, line: number) => comments.filter((comment) =>
    comment.kind === 'review_comment' && comment.path === path && comment.line === line && comment.isOutdated !== true)
  if (owner === null) return <section className="ui-stack" aria-label="Files changed"><SectionHeader title="Files changed" /><EmptyState message="No pull request is selected." /></section>
  if (files === null) return <section className="ui-stack" aria-label="Files changed" {...controlMetadata}>
    <SectionHeader title="Files changed" />
    {errors}
    {props.state.detail.loading ? <EmptyState message="Loading changed files…" />
      : malformedFiles || props.state.detail.error !== null || error !== null || filesView.error !== null
        ? <Button disabled={refreshBusy} onClick={() => void requestControl('refresh')}>Retry</Button>
        : <><EmptyState message="Changed files have not loaded yet." /><Button disabled={refreshBusy} onClick={() => void requestControl('refresh')}>Load files</Button></>}
  </section>
  if (filesUnavailable) return <section className="ui-stack" aria-label="Files changed" {...controlMetadata}>
    <SectionHeader title="Files changed" />
    <InlineError message="Couldn’t load changed files." />
    {errors}
    <Button disabled={refreshBusy || props.state.detail.loading} onClick={() => void requestControl('refresh')}>Retry</Button>
  </section>
  if (files.length === 0) return <section className="ui-stack" aria-label="Files changed" {...controlMetadata}>
    <SectionHeader title="Files changed" />
    {props.state.detail.loading ? <EmptyState message="Loading changed files…" /> : <EmptyState message="No files changed." />}
    {errors}
    {!props.state.detail.loading && <Button disabled={refreshBusy} onClick={() => void requestControl('refresh')}>Refresh files</Button>}
  </section>
  const selectedFiles = filesView.value.selectedFile === null
    ? filteredFiles
    : filteredFiles.filter((file) => file.path === filesView.value.selectedFile)

  return <section className="ui-stack" aria-label="Files changed" {...controlMetadata}>
    <SectionHeader title="Files changed" actions={<div className="ui-cluster">
      <span className="ui-text-muted">{viewedCount} / {allFiles.length} files viewed{unknownViewedCount > 0 ? `; ${unknownViewedCount} unknown` : ''}</span>
      <Button aria-expanded={treeVisible} onClick={() => void requestControl('tree-toggle')}>{treeVisible ? 'Hide file tree' : 'Show file tree'}</Button>
      <Button onClick={() => void requestControl('collapse-all')}>Collapse All</Button>
      <Button onClick={() => void requestControl('expand-all')}>Expand All</Button>
      <FormRow label="Diff mode" htmlFor="review-diff-mode">
        <select id="review-diff-mode" className="ui-text-field__input" value={filesView.value.diffMode} onChange={(event) => { void requestControl('diff-mode-set', { mode: event.currentTarget.value }) }}>
          <option value="inline">Inline</option>
          <option value="side-by-side">Side by Side</option>
        </select>
      </FormRow>
      <TextField label="Filter files" value={filesView.value.fileFilter} onChange={(event) => setFilesView({ fileFilter: event.currentTarget.value })} />
      <Button disabled={refreshBusy || props.state.detail.loading} onClick={() => void requestControl('refresh')}>Refresh files</Button>
    </div>} />
    {errors}
    {parsedFiles?.truncated === true ? <NoticeLine>Showing the bounded changed-file set returned by the hosting provider.</NoticeLine> : null}
    {filteredFiles.length === 0 ? <EmptyState message="No files match this filter." /> : <div className="ui-stack" style={{ minWidth: 0, marginTop: 'var(--ui-space-8)', display: 'grid', gridTemplateColumns: treeVisible ? 'minmax(0, 1fr) minmax(0, 3fr)' : 'minmax(0, 1fr)', gap: 'var(--ui-space-12)' }}>
      {treeVisible ? <aside className="ui-stack" aria-label="Changed files">
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{filteredFiles.map((file) => <li key={file.path}>
          <ListRow title={file.path} description={file.viewed === true ? 'Viewed' : file.viewed === false ? 'Unviewed' : 'Unknown'} selected={filesView.value.selectedFile === file.path} onClick={() => void requestControl('file-select', { path: file.path })} />
        </li>)}</ul>
      </aside> : null}
      <div className="ui-stack" style={{ minWidth: 0 }}>
        {selectedFiles.map((file) => {
          const isCollapsed = collapsed.has(file.path)
          const patch = file.patch === null ? null : parsePatch(file.patch)
          const anchor = inlineAnchor?.path === file.path ? inlineAnchor : null
          const status = file.status.toLowerCase()
          const statusTone = status.includes('add') ? 'working' : status.includes('delete') ? 'failing' : status.includes('modify') || status.includes('change') ? 'needs-you' : 'neutral'
          return <article className="ui-stack" key={file.path} style={{ minWidth: 0 }}>
            <header className="ui-cluster">
              <Button aria-expanded={!isCollapsed} onClick={() => void requestControl('file-toggle-collapse', { path: file.path })}>{isCollapsed ? 'Expand' : 'Collapse'} {file.path}</Button>
              <Badge tone={statusTone}>{file.status}</Badge>
              <Badge tone="working">+{file.additions}</Badge>
              <span> / </span>
              <Badge tone="failing">−{file.deletions}</Badge>
              <FormRow label="Viewed" htmlFor={`review-viewed-${file.path}`}>
                <input
                  id={`review-viewed-${file.path}`}
                  type="checkbox"
                  style={{ accentColor: 'var(--ui-accent)' }}
                  checked={file.viewed === true}
                  disabled={pendingPaths.has(file.path)}
                  onChange={() => void requestControl('file-set-viewed', { path: file.path })}
                />
              </FormRow>
              {file.viewed === null ? <NoticeLine>Viewed state is unavailable.</NoticeLine> : null}
            </header>
            {!isCollapsed ? <div className="ui-stack" style={{ minWidth: 0 }}>
              {file.isBinary ? <NoticeLine>Binary file; no text diff is available.</NoticeLine>
                : file.patchUnavailable || patch === null ? <NoticeLine>Patch unavailable for this file.</NoticeLine>
                  : <>
                    {patch.truncated ? <NoticeLine>This patch is truncated to a bounded preview.</NoticeLine> : null}
                    {filesView.value.diffMode === 'side-by-side'
                      ? <div role="table" aria-label={`Side-by-side diff for ${file.path}`} className="ui-stack">
                        {patch.lines.map((line, index) => {
                          const tone = line.kind === 'addition' ? 'working' : line.kind === 'deletion' ? 'failing' : line.kind === 'meta' ? 'accent' : 'neutral'
                          return <div className="ui-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--ui-space-8)' }} role="row" key={`${index}:${line.text}`}>
                            <code role="cell"><Badge tone={tone}>{line.leftLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('-') && !line.text.startsWith('---') ? line.text.slice(1) : line.text.startsWith('+') && !line.text.startsWith('+++') ? '' : line.text}</Badge></code>
                            <code role="cell"><Badge tone={tone}>{line.rightLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('+') && !line.text.startsWith('+++') ? line.text.slice(1) : line.text.startsWith('-') && !line.text.startsWith('---') ? '' : line.text}</Badge></code>
                            {line.rightLine !== null ? <div className="ui-cluster" style={{ gridColumn: '1 / -1' }}>
                              <Button disabled={!headValid || busyInline} onClick={() => void requestControl('range-start-set', { path: file.path, line: line.rightLine })}>Set range start {line.rightLine}</Button>
                              <Button disabled={!headValid || busyInline} onClick={() => void requestControl('inline-comment-open', { path: file.path, line: line.rightLine })}>Comment at {line.rightLine}</Button>
                            </div> : null}
                          </div>
                        })}
                      </div>
                      : <div className="ui-stack">
                        {patch.lines.map((line, index) => {
                          const tone = line.kind === 'addition' ? 'working' : line.kind === 'deletion' ? 'failing' : line.kind === 'meta' ? 'accent' : 'neutral'
                          return <div className="ui-cluster" style={{ alignItems: 'start' }} key={`${index}:${line.text}`}>
                            <Badge tone={tone}>{line.leftLine ?? ''}{line.rightLine === null ? '' : ` / ${line.rightLine}`}</Badge>
                            <code>{line.text}</code>
                            {line.rightLine !== null ? <div className="ui-cluster">
                              <Button disabled={!headValid || busyInline} onClick={() => void requestControl('range-start-set', { path: file.path, line: line.rightLine })}>Set range start {line.rightLine}</Button>
                              <Button disabled={!headValid || busyInline} onClick={() => void requestControl('inline-comment-open', { path: file.path, line: line.rightLine })}>Comment at {line.rightLine}</Button>
                            </div> : null}
                          </div>
                        })}
                      </div>}
                    {patch.lines.some((line) => line.rightLine !== null && matchingInlineComments(file.path, line.rightLine as number).length > 0) ? <section className="ui-stack" aria-label="Inline review comments">
                      {patch.lines.flatMap((line) => line.rightLine === null ? [] : matchingInlineComments(file.path, line.rightLine).map((comment) =>
                        <article className="ui-stack" key={`${String(comment.id)}:${line.rightLine}`}><strong>Line {line.rightLine}</strong><Markdown source={comment.body} /></article>
                      ))}
                    </section> : null}
                  </>}
              {anchor ? <form className="ui-stack" data-review-inline-control-target={inlineTarget} data-review-inline-control-generation={inlineGeneration} onSubmit={(event) => { event.preventDefault(); void requestControl('inline-comment-submit', undefined, true) }}>
                <label>Comment on {file.path}:{anchor.startLine === anchor.line ? anchor.line : `${anchor.startLine}–${anchor.line}`}</label>
                {!headValid ? <InlineError message="A verified pull request head is required before commenting." /> : null}
                <MarkdownComposer value={inlineDraft} onChange={editInlineDraft} label="Inline review comment" minRows={3} disabled={!headValid || busyInline} onSubmit={() => void requestControl('inline-comment-submit', undefined, true)} />
                <div className="ui-cluster">
                  <Button variant="primary" type="submit" disabled={!headValid || busyInline || inlineDraft.trim() === ''}>{busyInline ? 'Sending…' : 'Add review comment'}</Button>
                  <Button disabled={busyInline} onClick={() => void requestControl('inline-comment-cancel', undefined, true)}>Cancel</Button>
                </div>
              </form> : null}
              {rangeStart?.path === file.path ? <NoticeLine>Range starts at line {rangeStart.line}. Choose a later added line to comment on the range.</NoticeLine> : null}
            </div> : null}
          </article>
        })}
      </div>
    </div>}
  </section>
}