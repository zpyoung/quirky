import { Button, EmptyState, InlineError, NoticeLine } from '@quirky/ui'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useEditorUiControl, useEditorUiControlSurface, type EditorUiControl } from './uiControl'
import type { UiPluginContext } from '@quirky/protocol'
import { makeDiff } from '@sanity/diff-match-patch'
import type { EditorSurfaceBuffer, SurfaceProps } from '../types'
import { SourceEditor, type SourceEditorHandle } from './SourceEditor'

type DiffSides = { original: string }
type DiffState = { key: string; status: 'loading' } | { key: string; status: 'ready'; sides: DiffSides } | { key: string; status: 'error'; message: string }
type PreviewState =
  | { key: string; status: 'loading' }
  | { key: string; status: 'ready'; html: string }
  | { key: string; status: 'error'; message: string }
type Layout = 'side-by-side' | 'inline'
type Display = 'source' | 'markdown-preview'

export type ChangesSurfaceProps = {
  context: UiPluginContext
  buffer: EditorSurfaceBuffer
  tabId: string | null
  fontSize: number
  fontFamily: string
  wrap: boolean
  minimap: boolean
  onDraft(content: string): void
  flushDraft(): Promise<void>
  onView(patch: Record<string, unknown>): void
  onEditorFocus(): void
  onSearchInFiles(query: string): void
  error: string | null
  onError(message: string | null): void
  registerCommandHandlers: SurfaceProps['registerCommandHandlers']
}

function diffSides(value: unknown): DiffSides {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Git did not return a file diff.')
  }
  const response = value as Record<string, unknown>
  if (response.kind !== 'text' || response.binary === true || response.modifiedDeleted === true ||
    response.tooLarge !== undefined || typeof response.original !== 'string' || typeof response.modified !== 'string') {
    throw new Error('Changes is available only for readable text files that still exist on disk.')
  }
  return { original: response.original }
}

type InlineDiffRow = { kind: 'context' | 'added' | 'removed'; text: string }
type LineDiff = { rows: InlineDiffRow[]; changedLines: number[] }

function lineDiff(original: string, modified: string): LineDiff {
  if (original === modified) return { rows: [], changedLines: [] }
  const changes = makeDiff(original, modified, { checkLines: true, timeout: 0.01 })
  const rows: InlineDiffRow[] = []
  const changed = new Set<number>()
  const originalLines: { text: string; terminated: boolean }[] = []
  const modifiedLines: { text: string; terminated: boolean }[] = []
  let originalLine = ''
  let modifiedLine = ''
  let changedGroup = false
  let line = 1

  const flush = () => {
    if (changedGroup) {
      for (const entry of originalLines) rows.push({ kind: 'removed', text: entry.text })
      if (modifiedLines.length === 0) changed.add(line)
      for (const entry of modifiedLines) {
        rows.push({ kind: 'added', text: entry.text })
        changed.add(line)
        if (entry.terminated) line += 1
      }
    } else {
      for (const entry of originalLines) {
        rows.push({ kind: 'context', text: entry.text })
        if (entry.terminated) line += 1
      }
    }
    originalLines.length = 0
    modifiedLines.length = 0
    changedGroup = false
  }

  for (const [operation, text] of changes) {
    if (text.length === 0) continue
    let start = 0
    while (start < text.length) {
      if (operation !== 0) changedGroup = true
      const newline = text.indexOf('\n', start)
      const end = newline < 0 ? text.length : newline
      const fragment = text.slice(start, end)
      if (operation !== 1) originalLine += fragment
      if (operation !== -1) modifiedLine += fragment
      if (newline < 0) break
      if (operation !== 1) {
        originalLines.push({ text: originalLine, terminated: true })
        originalLine = ''
      }
      if (operation !== -1) {
        modifiedLines.push({ text: modifiedLine, terminated: true })
        modifiedLine = ''
      }
      start = newline + 1
      if (originalLine.length === 0 && modifiedLine.length === 0) flush()
    }
  }

  if (originalLine.length > 0) originalLines.push({ text: originalLine, terminated: false })
  if (modifiedLine.length > 0) modifiedLines.push({ text: modifiedLine, terminated: false })
  flush()
  return { rows, changedLines: [...changed].sort((left, right) => left - right) }
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

function controlValue(control: EditorUiControl): unknown {
  const data = control.data
  if (data === undefined || Reflect.ownKeys(data).length !== 1 || !Object.hasOwn(data, 'value')) return undefined
  return data.value
}

function hasNoControlData(control: EditorUiControl): boolean {
  return control.data === undefined
}

export function ChangesSurface(props: ChangesSurfaceProps): ReactElement {
  const { context, buffer } = props
  const surface = useEditorUiControlSurface()
  const [mountId] = useState(() => crypto.randomUUID())
  const [layout, setLayout] = useState<Layout>('side-by-side')
  const [display, setDisplay] = useState<Display>('source')
  const [modeEpoch, setModeEpoch] = useState(0)
  const modeChangeBusy = useRef(false)
  const [previewState, setPreviewState] = useState<PreviewState>(() => ({ key: '', status: 'loading' }))
  const [controlError, setControlError] = useState<{ key: string; message: string } | null>(null)
  const [inlineDiffState, setInlineDiffState] = useState<{ key: object; diff: LineDiff } | null>(null)
  const sourceRef = useRef<SourceEditorHandle>(null)
  const requestId = useRef(0)
  const pendingDiffsRef = useRef<Map<string, number> | null>(null)
  const pendingDiffs = pendingDiffsRef.current ?? (pendingDiffsRef.current = new Map())
  const changePosition = useRef<{ key: object; index: number } | null>(null)
  const latestDiffError = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const workingText = buffer.draft ?? buffer.content
  const textRevisionRef = useRef<{ text: string; epoch: number } | null>(null)
  let textRevision = textRevisionRef.current
  if (textRevision === null) {
    textRevision = { text: workingText, epoch: 0 }
    textRevisionRef.current = textRevision
  } else if (textRevision.text !== workingText) {
    textRevision = { text: workingText, epoch: textRevision.epoch + 1 }
    textRevisionRef.current = textRevision
  }
  const workingTextEpoch = textRevision.epoch
  const dataKey = JSON.stringify([buffer.id, props.tabId, buffer.worktreeId, buffer.path, buffer.relativePath, buffer.kind])
  const sessionKey = JSON.stringify([mountId, dataKey, layout, display, modeEpoch])
  const previewKey = JSON.stringify([sessionKey, workingTextEpoch])
  const dataKeyRef = useRef(dataKey)
  const sessionKeyRef = useRef(sessionKey)
  const previewKeyRef = useRef(previewKey)
  dataKeyRef.current = dataKey
  sessionKeyRef.current = sessionKey
  previewKeyRef.current = previewKey
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  useEffect(() => {
    modeChangeBusy.current = false
  }, [modeEpoch])

  const [diffState, setDiffState] = useState<DiffState>(() => ({ key: dataKey, status: 'loading' }))
  const diff: DiffState = diffState.key === dataKey ? diffState : { key: dataKey, status: 'loading' }
  const preview: PreviewState = previewState.key === previewKey
    ? previewState
    : { key: previewKey, status: 'loading' }
  const currentControlError = controlError?.key === sessionKey ? controlError.message : null
  const currentOriginal = diff.status === 'ready' ? diff.sides.original : null
  const changeKey = useMemo(() => ({ dataKey, original: currentOriginal, workingTextEpoch }), [
    dataKey, currentOriginal, workingTextEpoch
  ])
  const inlineKey = useMemo(() => ({ dataKey, diffState, workingTextEpoch, display, layout }), [
    dataKey, diffState, workingTextEpoch, display, layout
  ])
  const inlineDiff = inlineDiffState?.key === inlineKey ? inlineDiffState.diff : null
  const calculatedDiff = useMemo(
    () => currentOriginal === null ? null : lineDiff(currentOriginal, workingText),
    [currentOriginal, workingText]
  )
  const canNavigate = calculatedDiff !== null && calculatedDiff.changedLines.length > 0
  const noChanges = diff.status === 'ready' && diff.sides.original === workingText

  const refreshDiff = useCallback(async (throwOnError = false): Promise<boolean> => {
    if (!mountedRef.current || dataKeyRef.current !== dataKey) return false
    const requestKey = dataKey
    const currentRequest = ++requestId.current
    const pending = pendingDiffs
    pending.set(requestKey, (pending.get(requestKey) ?? 0) + 1)
    latestDiffError.current = null
    setControlError((current) => current?.key === sessionKeyRef.current ? null : current)
    setDiffState((current) => current.key === requestKey && current.status === 'ready'
      ? current
      : { key: requestKey, status: 'loading' })
    try {
      const result = await context.call('quirky.git/diff', {
        worktree: `id:${buffer.worktreeId}`,
        path: buffer.relativePath,
        source: 'unstaged',
        compareAgainstHead: true
      })
      if (!mountedRef.current || currentRequest !== requestId.current || dataKeyRef.current !== requestKey) {
        return mountedRef.current && dataKeyRef.current === requestKey
      }
      const sides = diffSides(result)
      latestDiffError.current = null
      setDiffState({ key: requestKey, status: 'ready', sides })
      return true
    } catch (reason) {
      if (mountedRef.current && currentRequest === requestId.current && dataKeyRef.current === requestKey) {
        const message = messageOf(reason)
        latestDiffError.current = message
        setDiffState({ key: requestKey, status: 'error', message })
        if (throwOnError) throw reason
        return false
      }
      return mountedRef.current && dataKeyRef.current === requestKey
    } finally {
      const count = pending.get(requestKey) ?? 0
      if (count <= 1) pending.delete(requestKey)
      else pending.set(requestKey, count - 1)
    }
  }, [buffer.relativePath, buffer.worktreeId, context, dataKey])

  useEffect(() => {
    void refreshDiff()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/changed') void refreshDiff()
    }, { worktreeId: buffer.worktreeId })
    return () => {
      requestId.current += 1
      unsubscribe()
    }
  }, [buffer.worktreeId, context, refreshDiff])


  useEffect(() => {
    if (display !== 'source' || layout !== 'inline' || currentOriginal === null) {
      setInlineDiffState(null)
      return
    }
    setInlineDiffState({ key: inlineKey, diff: lineDiff(currentOriginal, workingText) })
  }, [currentOriginal, dataKey, display, inlineKey, layout, workingText])

  useEffect(() => {
    if (display !== 'markdown-preview' || buffer.kind !== 'markdown') return
    const requestKey = previewKey
    const leaseId = crypto.randomUUID()
    const worktreeId = buffer.worktreeId
    const path = buffer.relativePath
    let active = true
    let released = false
    const release = () => {
      if (released) return
      released = true
      try {
        void context.call('quirky.editor/markdownPreview', { action: 'release', leaseId }).catch(() => {})
      } catch {}
    }
    setPreviewState({ key: requestKey, status: 'loading' })
    const renderPreview = async () => {
      try {
        const value: unknown = await context.call('quirky.editor/markdownPreview', {
          action: 'render',
          leaseId,
          worktree: `id:${worktreeId}`,
          path,
          text: workingText
        })
        if (!active || previewKeyRef.current !== requestKey) {
          release()
          return
        }
        if (value === null || typeof value !== 'object' || Array.isArray(value)) {
          throw new Error('The Markdown renderer returned no sanitized HTML.')
        }
        const response = value as Record<string, unknown>
        if (response.leaseId !== leaseId || response.worktreeId !== worktreeId || response.path !== path ||
          typeof response.html !== 'string') {
          throw new Error('The Markdown renderer returned invalid content.')
        }
        setPreviewState({ key: requestKey, status: 'ready', html: response.html })
      } catch (reason) {
        release()
        if (active && previewKeyRef.current === requestKey) {
          setPreviewState({ key: requestKey, status: 'error', message: messageOf(reason) })
        }
      }
    }
    void renderPreview()
    return () => {
      active = false
      release()
    }
  }, [buffer.kind, buffer.relativePath, buffer.worktreeId, context, display, previewKey, workingText])

  useEffect(() => {
    if (display !== 'source' || diff.status !== 'ready') return
    const editor = sourceRef.current
    if (!editor) return
    return props.registerCommandHandlers({
      flush: () => editor.flush(),
      find: (args) => editor.find(typeof args?.query === 'string' ? args.query : undefined),
      replace: (args) => editor.replace(typeof args?.query === 'string' ? args.query : undefined),
      'copy-context': () => editor.copyContext()
    })
  }, [diff.status, display, props.registerCommandHandlers])

  const navigateChange = (direction: -1 | 1): boolean => {
    if (display !== 'source' || diff.status !== 'ready') return false
    const currentDiff = inlineDiff ?? calculatedDiff
    if (!currentDiff || currentDiff.changedLines.length === 0) return false
    const lines = currentDiff.changedLines
    const currentIndex = changePosition.current?.key === changeKey ? changePosition.current.index : -1
    const next = currentIndex < 0
      ? (direction > 0 ? 0 : lines.length - 1)
      : (currentIndex + direction + lines.length) % lines.length
    changePosition.current = { key: changeKey, index: next }
    sourceRef.current?.reveal(lines[next]!)
    return true
  }

  const actions = useMemo(() => {
    if (diff.status !== 'ready' && diff.status !== 'error') return []
    const next = ['retry']
    if (diff.status === 'ready') {
      if (display === 'source') {
        next.push('layout')
        if (canNavigate) next.push('previous-change', 'next-change')
      }
      if (buffer.kind === 'markdown') next.push('display')
    }
    return next
  }, [buffer.kind, canNavigate, diff.status, display])
  const target = `changes:${JSON.stringify([buffer.id, props.tabId])}`
  const generation = JSON.stringify([mountId, dataKey, layout, display, modeEpoch])
  const address = useMemo(() => ({
    surface,
    target,
    generation,
    actions
  }), [actions, generation, surface, target])
  const onControlError = useCallback((error: Error) => {
    if (!mountedRef.current || sessionKeyRef.current !== sessionKey || error.message === latestDiffError.current) return
    setControlError({ key: sessionKey, message: error.message })
  }, [sessionKey])

  const handleControl = useCallback(async (control: EditorUiControl) => {
    if (!mountedRef.current || sessionKeyRef.current !== sessionKey || dataKeyRef.current !== dataKey) return { delivered: false }
    try {
      if (control.action === 'retry') {
        if (!hasNoControlData(control) || diff.status === 'loading' || (pendingDiffs.get(dataKey) ?? 0) > 0) {
          return { delivered: false }
        }
        const completed = await refreshDiff(true)
        if (!completed || !mountedRef.current || sessionKeyRef.current !== sessionKey || dataKeyRef.current !== dataKey) {
          return { delivered: false }
        }
        setControlError(null)
        return { delivered: true }
      }
      if (control.action === 'layout') {
        const value = controlValue(control)
        if (diff.status !== 'ready' || display !== 'source' ||
          (value !== 'side-by-side' && value !== 'inline')) return { delivered: false }
        if (modeChangeBusy.current) return { delivered: false }
        setControlError(null)
        if (value !== layout) {
          modeChangeBusy.current = true
          setLayout(value)
          setModeEpoch((epoch) => epoch + 1)
        }
        return { delivered: true }
      }
      if (control.action === 'display') {
        const value = controlValue(control)
        if (diff.status !== 'ready' || buffer.kind !== 'markdown' ||
          (value !== 'source' && value !== 'markdown-preview')) return { delivered: false }
        if (modeChangeBusy.current) return { delivered: false }
        setControlError(null)
        if (value !== display) {
          setDisplay(value)
          modeChangeBusy.current = true
          setModeEpoch((epoch) => epoch + 1)
        }
        return { delivered: true }
      }
      if (control.action === 'previous-change' || control.action === 'next-change') {
        if (!hasNoControlData(control)) return { delivered: false }
        const delivered = navigateChange(control.action === 'next-change' ? 1 : -1)
        if (!delivered) return { delivered: false }
        setControlError(null)
        return { delivered: true }
      }
      return { delivered: false }
    } catch (reason) {
      if (mountedRef.current && sessionKeyRef.current === sessionKey && messageOf(reason) !== latestDiffError.current) {
        setControlError({ key: sessionKey, message: messageOf(reason) })
      }
      throw reason
    }
  }, [buffer.kind, dataKey, diff.status, display, layout, navigateChange, refreshDiff, sessionKey])
  const controls = useEditorUiControl({
    context,
    address,
    handler: handleControl,
    onError: onControlError
  })

  if (diff.status === 'loading') {
    return <div className="qe-changes-message" role="status" aria-live="polite">
      <NoticeLine>Loading HEAD comparison…</NoticeLine>
    </div>
  }
  if (diff.status === 'error') {
    return <div className="qe-changes-message">
      <InlineError
        message={currentControlError ?? `Changes unavailable: ${diff.message}`}
        action={{ label: 'Retry Changes', onAction: () => { void controls.run('retry') } }}
      />
    </div>
  }

  const sourceEditor = (
    <SourceEditor
      ref={sourceRef}
      buffer={buffer}
      comparisonOriginal={layout === 'side-by-side' ? diff.sides.original : undefined}
      tabId={props.tabId}
      wrap={props.wrap}
      minimap={props.minimap}
      fontSize={props.fontSize}
      fontFamily={props.fontFamily}
      onDraft={props.onDraft}
      flushDraft={props.flushDraft}
      onView={props.onView}
      onEditorFocus={props.onEditorFocus}
      onSearchInFiles={props.onSearchInFiles}
      error={props.error}
      onError={props.onError}
    />
  )

  return (
    <section className="qe-changes-surface" aria-label="Changes">
      <div className="qe-changes-toolbar" role="toolbar" aria-label="Changes view">
        {display === 'source' && <>
          <Button
            aria-label="Side by side"
            aria-pressed={layout === 'side-by-side'}
            onClick={() => { void controls.run('layout', { value: 'side-by-side' }) }}
          >Side by side</Button>
          <Button
            aria-label="Inline"
            aria-pressed={layout === 'inline'}
            onClick={() => { void controls.run('layout', { value: 'inline' }) }}
          >Inline</Button>
          <Button aria-label="Previous change" disabled={!canNavigate} onClick={() => { void controls.run('previous-change') }}>
            Previous change
          </Button>
          <Button aria-label="Next change" disabled={!canNavigate} onClick={() => { void controls.run('next-change') }}>
            Next change
          </Button>
        </>}
        {buffer.kind === 'markdown' && <Button
          aria-label={display === 'source' ? 'Markdown preview' : 'Source editor'}
          onClick={() => {
            void controls.run('display', { value: display === 'source' ? 'markdown-preview' : 'source' })
          }}
        >{display === 'source' ? 'Markdown preview' : 'Source editor'}</Button>}
      </div>
      {currentControlError !== null && <InlineError message={currentControlError} />}
      {noChanges && <div className="qe-changes-clean" role="status" aria-live="polite">
        <EmptyState message="No uncommitted changes." />
      </div>}
      {display === 'markdown-preview' && buffer.kind === 'markdown' ? <>
        <div className="qe-changes-preview-notice" role="note">Markdown preview shows modified content only; HEAD is not included.</div>
        {currentControlError === null && preview.status === 'error' && <InlineError message={preview.message} />}
        {preview.status === 'ready' && <div className="qe-changes-markdown-preview" dangerouslySetInnerHTML={{ __html: preview.html }} />}
        {preview.status === 'loading' && <div role="status" aria-live="polite"><NoticeLine>Rendering modified Markdown…</NoticeLine></div>}
      </> : layout === 'inline' ? (
        <div className="qe-changes-panes qe-changes-inline">
          <section className="qe-changes-inline-diff" aria-label="Inline diff">
            <h3>Inline diff</h3>
            <div className="qe-changes-inline-rows">
              {inlineDiff === null
                ? <div role="status" aria-live="polite"><NoticeLine>Preparing inline diff…</NoticeLine></div>
                : inlineDiff.rows.map((row, index) => (
                  <div key={`${index}:${row.kind}`} className={`qe-changes-inline-row ${row.kind}`}>
                    <span aria-hidden="true">{row.kind === 'added' ? '+' : row.kind === 'removed' ? '−' : ' '}</span>
                    <code>{row.text || ' '}</code>
                  </div>
                ))}
            </div>
          </section>
          <section className="qe-changes-modified" aria-label="Modified editor">
            <h3>Modified</h3>
            {sourceEditor}
          </section>
        </div>
      ) : (
        <div className="qe-changes-panes qe-changes-side-by-side">
          <div className="qe-changes-merge-headings">
            <h3>HEAD</h3>
            <h3>Modified</h3>
          </div>
          <section className="qe-changes-merge-editor" aria-label="Side-by-side diff">
            {sourceEditor}
          </section>
        </div>
      )}
    </section>
  )
}
