import { useMemo, useState } from 'react'
import { Badge, Button, FormRow, ListRow, SectionHeader, StatusDot, TextField } from '@quirky/ui'
import { Markdown, MarkdownComposer } from '@quirky/plugin-tasks/markdown'
import type { ReviewsSurfaceProps } from '../contracts'
import { isRecord, parseCommentsResult, parseFilesResult, reviewContext, type ChangedFile, type ReviewComment } from './data'

type DiffLine = { text: string; kind: 'context' | 'addition' | 'deletion' | 'meta'; leftLine: number | null; rightLine: number | null }
type InlineAnchor = { path: string; line: number; startLine: number }

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

function fileRows(value: unknown, number: number): ChangedFile[] | null {
  const parsed = value === null ? null : parseFilesResult(value, number)
  return parsed?.files as unknown as ChangedFile[] | undefined ?? null
}

export function FilesChanged(props: ReviewsSurfaceProps) {
  const ownerInfo = ownerParams(props)
  const owner = ownerInfo?.owner ?? null
  const params = ownerInfo?.params ?? null
  const files = owner === null ? null : fileRows(props.state.detail.files, owner.number)
  const filesUnavailable = isRecord(props.state.detail.files) && props.state.detail.files.filesUnavailable === true
  const comments = owner === null ? [] : commentLines(props.state.detail.comments, owner.number)
  const allFiles = files ?? []
  const filteredFiles = useMemo(() => allFiles.filter((file) => file.path.toLowerCase().includes(props.state.detail.fileFilter.toLowerCase())), [allFiles, props.state.detail.fileFilter])
  const treeVisible = (props.state.detail as typeof props.state.detail & { fileTreeVisible?: boolean }).fileTreeVisible !== false
  const [rangeStart, setRangeStart] = useState<{ path: string; line: number } | null>(null)
  const [inlineAnchor, setInlineAnchor] = useState<InlineAnchor | null>(null)
  const [inlineDraft, setInlineDraft] = useState('')
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [busyInline, setBusyInline] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewedCount = allFiles.filter((file) => file.viewed === true).length
  const unknownViewedCount = allFiles.filter((file) => file.viewed === null).length
  const collapsed = new Set(props.state.detail.collapsedFiles)
  const head = props.state.detail.review?.headRefOid ?? null
  const headValid = typeof head === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)

  const setFilesView = async (change: { fileFilter?: string; diffMode?: 'inline' | 'side-by-side'; selectedFile?: string | null; collapsedFiles?: string[]; treeVisible?: boolean }) => {
    if (params === null || owner === null) return
    const next = {
      fileFilter: change.fileFilter ?? props.state.detail.fileFilter,
      diffMode: change.diffMode ?? props.state.detail.diffMode,
      selectedFile: change.selectedFile === undefined ? props.state.detail.selectedFile : change.selectedFile,
      collapsedFiles: change.collapsedFiles ?? props.state.detail.collapsedFiles,
      treeVisible: change.treeVisible ?? treeVisible,
    }
    try {
      await props.context.call('quirky.reviews/detailSetFilesView', { ...params, ...next })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const refreshFiles = async () => {
    if (params === null) return
    setError(null)
    try {
      await props.context.call('quirky.reviews/detailRefresh', { ...params, surface: 'detail' })
    } catch (cause) {
      setError(errorText(cause))
    }
  }

  const toggleViewed = async (file: ChangedFile) => {
    if (params === null || owner === null || !headValid) {
      setError('The current pull request head is unavailable; refresh before changing file state.')
      return
    }
    setPendingPath(file.path)
    setError(null)
    try {
      await props.context.call('quirky.reviews/detailSetFileViewed', { ...params, surface: 'detail', path: file.path, viewed: file.viewed !== true })
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setPendingPath(null)
    }
  }

  const addInlineComment = async () => {
    if (params === null || owner === null || inlineAnchor === null || !headValid || inlineDraft.trim() === '' || busyInline) return
    setBusyInline(true)
    setError(null)
    try {
      await props.context.call('quirky.reviews/detailInlineComment', {
        ...params,
        surface: 'detail',
        expectedHead: head,
        path: inlineAnchor.path,
        line: inlineAnchor.line,
        ...(inlineAnchor.startLine === inlineAnchor.line ? {} : { startLine: inlineAnchor.startLine }),
        body: inlineDraft,
      })
      setInlineAnchor(null)
      setInlineDraft('')
    } catch (cause) {
      setError(errorText(cause))
    } finally {
      setBusyInline(false)
    }
  }

  const matchingInlineComments = (path: string, line: number) => comments.filter((comment) =>
    comment.kind === 'review_comment' && comment.path === path && comment.line === line && comment.isOutdated !== true)

  if (owner === null) return <section className="ui-stack" aria-label="Files changed"><SectionHeader title="Files changed" /><p className="ui-text-muted">No pull request is selected.</p></section>
  if (files === null) return <section className="ui-stack" aria-label="Files changed">
    <SectionHeader title="Files changed" />
    {props.state.detail.loading ? <p role="status" className="ui-text-muted">Loading changed files…</p> : <p role="alert"><StatusDot status="failing" label="Error" /> Couldn’t load changed files.</p>}
    <Button onClick={() => void refreshFiles()}>Retry</Button>
  </section>
  if (filesUnavailable) return <section className="ui-stack" aria-label="Files changed">
    <SectionHeader title="Files changed" />
    <p role="alert"><StatusDot status="failing" label="Error" /> Couldn’t load changed files.</p>
    {props.state.detail.error ? <p role="alert"><StatusDot status="failing" label="Error" /> {props.state.detail.error}</p> : null}
    <Button onClick={() => void refreshFiles()}>Retry</Button>
  </section>
  if (files.length === 0) return <section className="ui-stack" aria-label="Files changed">
    <SectionHeader title="Files changed" />
    {props.state.detail.loading ? <p role="status" className="ui-text-muted">Loading changed files…</p> : <p>No files changed.</p>}
    {props.state.detail.error ? <p role="alert"><StatusDot status="failing" label="Error" /> {props.state.detail.error}</p> : null}
    <Button onClick={() => void refreshFiles()}>Refresh files</Button>
  </section>

  const collapseAll = async () => setFilesView({ collapsedFiles: allFiles.map((file) => file.path) })
  const expandAll = async () => setFilesView({ collapsedFiles: [] })
  const selectedFiles = props.state.detail.selectedFile === null
    ? filteredFiles
    : filteredFiles.filter((file) => file.path === props.state.detail.selectedFile)

  return <section className="ui-stack" aria-label="Files changed">
    <SectionHeader title="Files changed" actions={<div className="ui-cluster">
      <span className="ui-text-muted">{viewedCount} / {allFiles.length} files viewed{unknownViewedCount > 0 ? `; ${unknownViewedCount} unknown` : ''}</span>
      <Button aria-expanded={treeVisible} onClick={() => void setFilesView({ treeVisible: !treeVisible })}>{treeVisible ? 'Hide file tree' : 'Show file tree'}</Button>
      <Button onClick={() => void collapseAll()}>Collapse All</Button>
      <Button onClick={() => void expandAll()}>Expand All</Button>
      <FormRow label="Diff mode" htmlFor="review-diff-mode">
        <select id="review-diff-mode" className="ui-text-field__input" value={props.state.detail.diffMode} onChange={(event) => void setFilesView({ diffMode: event.currentTarget.value as 'inline' | 'side-by-side' })}>
          <option value="inline">Inline</option>
          <option value="side-by-side">Side by Side</option>
        </select>
      </FormRow>
      <TextField label="Filter files" value={props.state.detail.fileFilter} onChange={(event) => void setFilesView({ fileFilter: event.currentTarget.value })} />
      <Button onClick={() => void refreshFiles()}>Refresh files</Button>
    </div>} />
    {props.state.detail.error ? <p role="alert"><StatusDot status="failing" label="Error" /> {props.state.detail.error}</p> : null}
    {error ? <p role="alert"><StatusDot status="failing" label="Error" /> {error}</p> : null}
    {isRecord(props.state.detail.files) && props.state.detail.files.truncated === true ? <p role="status" className="ui-text-muted">Showing the bounded changed-file set returned by the hosting provider.</p> : null}
    {filteredFiles.length === 0 ? <p role="status" className="ui-text-muted">No files match this filter.</p> : <div className="ui-stack" style={{ minWidth: 0, marginTop: 'var(--ui-space-8)', display: 'grid', gridTemplateColumns: treeVisible ? 'minmax(0, 1fr) minmax(0, 3fr)' : 'minmax(0, 1fr)', gap: 'var(--ui-space-12)' }}>
      {treeVisible ? <aside className="ui-stack" aria-label="Changed files">
        <ul className="ui-stack" style={{ listStyle: 'none', padding: 0 }}>{filteredFiles.map((file) => <li key={file.path}>
          <ListRow title={file.path} description={file.viewed === true ? 'Viewed' : file.viewed === false ? 'Unviewed' : 'Unknown'} selected={props.state.detail.selectedFile === file.path} onClick={() => void setFilesView({ selectedFile: file.path })} />
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
              <Button aria-expanded={!isCollapsed} onClick={() => {
                const next = isCollapsed ? props.state.detail.collapsedFiles.filter((path) => path !== file.path) : [...props.state.detail.collapsedFiles, file.path]
                void setFilesView({ collapsedFiles: next })
              }}>{isCollapsed ? 'Expand' : 'Collapse'} {file.path}</Button>
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
                  disabled={pendingPath === file.path}
                  onChange={() => void toggleViewed(file)}
                />
              </FormRow>
              {file.viewed === null ? <span className="ui-text-muted">Viewed state is unavailable.</span> : null}
            </header>
            {!isCollapsed ? <div className="ui-stack" style={{ minWidth: 0 }}>
              {file.isBinary ? <p>Binary file; no text diff is available.</p>
                : file.patchUnavailable || patch === null ? <p>Patch unavailable for this file.</p>
                  : <>
                    {patch.truncated ? <p role="status" className="ui-text-muted">This patch is truncated to a bounded preview.</p> : null}
                    {props.state.detail.diffMode === 'side-by-side'
                      ? <div role="table" aria-label={`Side-by-side diff for ${file.path}`} className="ui-stack">
                        {patch.lines.map((line, index) => {
                          const tone = line.kind === 'addition' ? 'working' : line.kind === 'deletion' ? 'failing' : line.kind === 'meta' ? 'accent' : 'neutral'
                          return <div className="ui-stack" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 'var(--ui-space-8)' }} role="row" key={`${index}:${line.text}`}>
                            <code role="cell"><Badge tone={tone}>{line.leftLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('-') && !line.text.startsWith('---') ? line.text.slice(1) : line.text.startsWith('+') && !line.text.startsWith('+++') ? '' : line.text}</Badge></code>
                            <code role="cell"><Badge tone={tone}>{line.rightLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('+') && !line.text.startsWith('+++') ? line.text.slice(1) : line.text.startsWith('-') && !line.text.startsWith('---') ? '' : line.text}</Badge></code>
                            {line.rightLine !== null ? <div className="ui-cluster" style={{ gridColumn: '1 / -1' }}>
                              <Button disabled={!headValid} onClick={() => setRangeStart({ path: file.path, line: line.rightLine as number })}>Set range start {line.rightLine}</Button>
                              <Button disabled={!headValid} onClick={() => setInlineAnchor({
                                path: file.path,
                                line: line.rightLine as number,
                                startLine: rangeStart?.path === file.path && rangeStart.line <= (line.rightLine as number) ? rangeStart.line : line.rightLine as number,
                              })}>Comment at {line.rightLine}</Button>
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
                              <Button disabled={!headValid} onClick={() => setRangeStart({ path: file.path, line: line.rightLine as number })}>Set range start {line.rightLine}</Button>
                              <Button disabled={!headValid} onClick={() => setInlineAnchor({
                                path: file.path,
                                line: line.rightLine as number,
                                startLine: rangeStart?.path === file.path && rangeStart.line <= (line.rightLine as number) ? rangeStart.line : line.rightLine as number,
                              })}>Comment at {line.rightLine}</Button>
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
              {anchor ? <form className="ui-stack" onSubmit={(event) => { event.preventDefault(); void addInlineComment() }}>
                <label>Comment on {file.path}:{anchor.startLine === anchor.line ? anchor.line : `${anchor.startLine}–${anchor.line}`}</label>
                {!headValid ? <p role="alert"><StatusDot status="failing" label="Error" /> A verified pull request head is required before commenting.</p> : null}
                <MarkdownComposer value={inlineDraft} onChange={setInlineDraft} label="Inline review comment" minRows={3} disabled={!headValid || busyInline} onSubmit={() => void addInlineComment()} />
                <div className="ui-cluster">
                  <Button variant="primary" type="submit" disabled={!headValid || busyInline || inlineDraft.trim() === ''}>{busyInline ? 'Sending…' : 'Add review comment'}</Button>
                  <Button disabled={busyInline} onClick={() => setInlineAnchor(null)}>Cancel</Button>
                </div>
              </form> : null}
              {rangeStart?.path === file.path ? <p>Range starts at line {rangeStart.line}. Choose a later added line to comment on the range.</p> : null}
            </div> : null}
          </article>
        })}
      </div>
    </div>}
  </section>
}