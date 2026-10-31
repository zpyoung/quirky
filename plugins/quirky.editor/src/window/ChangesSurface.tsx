import { Button, EmptyState } from '@quirky/ui'
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { makeDiff } from '@sanity/diff-match-patch'
import type { EditorSurfaceBuffer, SurfaceProps } from '../types'
import { SourceEditor, type SourceEditorHandle } from './SourceEditor'

type DiffSides = { original: string }
type DiffState = { status: 'loading' } | { status: 'ready'; sides: DiffSides } | { status: 'error'; message: string }
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

export function ChangesSurface(props: ChangesSurfaceProps): ReactElement {
  const { context, buffer } = props
  const [diff, setDiff] = useState<DiffState>({ status: 'loading' })
  const [layout, setLayout] = useState<Layout>('side-by-side')
  const [display, setDisplay] = useState<Display>('source')
  const [previewHtml, setPreviewHtml] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)
  const [changeIndex, setChangeIndex] = useState(-1)
  const [inlineDiff, setInlineDiff] = useState<LineDiff | null>(null)
  const sourceRef = useRef<SourceEditorHandle>(null)
  const requestId = useRef(0)
  const workingText = buffer.draft ?? buffer.content

  const refreshDiff = useCallback(async () => {
    const currentRequest = ++requestId.current
    setDiff((current) => current.status === 'ready' ? current : { status: 'loading' })
    try {
      const result = await context.call('quirky.git/diff', {
        worktree: `id:${buffer.worktreeId}`,
        path: buffer.relativePath,
        source: 'unstaged',
        compareAgainstHead: true
      })
      if (currentRequest === requestId.current) setDiff({ status: 'ready', sides: diffSides(result) })
    } catch (reason) {
      if (currentRequest === requestId.current) setDiff({ status: 'error', message: messageOf(reason) })
    }
  }, [buffer.relativePath, buffer.worktreeId, context])

  useEffect(() => {
    void refreshDiff()
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/changed') void refreshDiff()
    })
    return () => {
      requestId.current += 1
      unsubscribe()
    }
  }, [context, refreshDiff])
  useEffect(() => {
    setChangeIndex(-1)
  }, [diff.status === 'ready' ? diff.sides.original : '', workingText])

  useEffect(() => {
    const original = diff.status === 'ready' ? diff.sides.original : null
    if (display !== 'source' || layout !== 'inline' || original === null) {
      setInlineDiff(null)
      return
    }
    setInlineDiff(lineDiff(original, workingText))
  }, [diff, display, layout, workingText])

  useEffect(() => {
    if (display !== 'markdown-preview' || buffer.kind !== 'markdown') return
    const leaseId = crypto.randomUUID()
    let active = true
    const worktreeId = buffer.worktreeId
    const path = buffer.relativePath
    const release = () => {
      try {
        void context.call('quirky.editor/markdownPreview', { action: 'release', leaseId }).catch(() => {})
      } catch {}
    }
    setPreviewHtml(null)
    setPreviewError(null)
    void context.call('quirky.editor/markdownPreview', {
      action: 'render',
      leaseId,
      worktree: `id:${worktreeId}`,
      path,
      text: workingText
    }).then((value: unknown) => {
      if (!active) {
        release()
        return
      }
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        release()
        throw new Error('The Markdown renderer returned no sanitized HTML.')
      }
      const response = value as Record<string, unknown>
      if (response.leaseId !== leaseId || response.worktreeId !== worktreeId || response.path !== path ||
        typeof response.html !== 'string') {
        release()
        throw new Error('The Markdown renderer returned invalid content.')
      }
      setPreviewHtml(response.html)
    }).catch((reason: unknown) => {
      release()
      if (active) setPreviewError(messageOf(reason))
    })
    return () => {
      active = false
      release()
    }
  }, [buffer.kind, buffer.worktreeId, buffer.relativePath, context, display, workingText])

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

  const navigateChange = (direction: -1 | 1) => {
    if (diff.status !== 'ready') return
    const currentDiff = inlineDiff ?? lineDiff(diff.sides.original, workingText)
    setInlineDiff(currentDiff)
    const lines = currentDiff.changedLines
    if (lines.length === 0) return
    const next = changeIndex < 0
      ? (direction > 0 ? 0 : lines.length - 1)
      : (changeIndex + direction + lines.length) % lines.length
    setChangeIndex(next)
    sourceRef.current?.reveal(lines[next]!)
  }

  if (diff.status === 'loading') return <div className="qe-changes-message" role="status">Loading HEAD comparison…</div>
  if (diff.status === 'error') {
    return <div className="qe-changes-message" role="alert">
      <span>Changes unavailable: {diff.message}</span>
      <Button onClick={() => void refreshDiff()}>Retry Changes</Button>
    </div>
  }

  const noChanges = diff.sides.original === workingText
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
          <Button aria-label="Side by side" aria-pressed={layout === 'side-by-side'} onClick={() => setLayout('side-by-side')}>Side by side</Button>
          <Button aria-label="Inline" aria-pressed={layout === 'inline'} onClick={() => setLayout('inline')}>Inline</Button>
          <Button aria-label="Previous change" disabled={noChanges} onClick={() => navigateChange(-1)}>Previous change</Button>
          <Button aria-label="Next change" disabled={noChanges} onClick={() => navigateChange(1)}>Next change</Button>
        </>}
        {buffer.kind === 'markdown' && <Button
          aria-label={display === 'source' ? 'Markdown preview' : 'Source editor'}
          onClick={() => setDisplay(display === 'source' ? 'markdown-preview' : 'source')}
        >{display === 'source' ? 'Markdown preview' : 'Source editor'}</Button>}
      </div>
      {noChanges && <div className="qe-changes-clean" role="status">No uncommitted changes.</div>}
      {display === 'markdown-preview' && buffer.kind === 'markdown' ? <>
        <div className="qe-changes-preview-notice" role="note">Markdown preview shows modified content only; HEAD is not included.</div>
        {previewError !== null && <div role="alert"><EmptyState message={previewError} /></div>}
        {previewHtml !== null && <div className="qe-changes-markdown-preview" dangerouslySetInnerHTML={{ __html: previewHtml }} />}
        {previewHtml === null && previewError === null && <div role="status">Rendering modified Markdown…</div>}
      </> : layout === 'inline' ? (
        <div className="qe-changes-panes qe-changes-inline">
          <section className="qe-changes-inline-diff" aria-label="Inline diff">
            <h3>Inline diff</h3>
            <div className="qe-changes-inline-rows">
              {inlineDiff === null
                ? <span role="status">Preparing inline diff…</span>
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
