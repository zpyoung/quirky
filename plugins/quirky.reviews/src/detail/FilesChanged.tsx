import { useMemo, useState } from 'react'
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

  if (owner === null) return <section className="review-files" aria-label="Files changed"><h3>Files changed</h3><p>No pull request is selected.</p></section>
  if (files === null) return <section className="review-files" aria-label="Files changed">
    <h3>Files changed</h3>
    {props.state.detail.loading ? <p role="status">Loading changed files…</p> : <p role="alert">Couldn’t load changed files.</p>}
    <button type="button" onClick={() => void refreshFiles()}>Retry</button>
  </section>
  if (filesUnavailable) return <section className="review-files" aria-label="Files changed">
    <h3>Files changed</h3>
    <p role="alert">Couldn’t load changed files.</p>
    {props.state.detail.error ? <p role="alert">{props.state.detail.error}</p> : null}
    <button type="button" onClick={() => void refreshFiles()}>Retry</button>
  </section>
  if (files.length === 0) return <section className="review-files" aria-label="Files changed">
    <h3>Files changed</h3>
    {props.state.detail.loading ? <p role="status">Loading changed files…</p> : <p>No files changed.</p>}
    {props.state.detail.error ? <p role="alert">{props.state.detail.error}</p> : null}
    <button type="button" onClick={() => void refreshFiles()}>Refresh files</button>
  </section>

  const collapseAll = async () => setFilesView({ collapsedFiles: allFiles.map((file) => file.path) })
  const expandAll = async () => setFilesView({ collapsedFiles: [] })
  const selectedFiles = props.state.detail.selectedFile === null
    ? filteredFiles
    : filteredFiles.filter((file) => file.path === props.state.detail.selectedFile)

  return <section className="review-files" aria-label="Files changed">
    <header className="review-files-toolbar">
      <h3>Files changed</h3>
      <span>{viewedCount} / {allFiles.length} files viewed{unknownViewedCount > 0 ? `; ${unknownViewedCount} unknown` : ''}</span>
      <button type="button" aria-expanded={treeVisible} onClick={() => void setFilesView({ treeVisible: !treeVisible })}>{treeVisible ? 'Hide file tree' : 'Show file tree'}</button>
      <button type="button" onClick={() => void collapseAll()}>Collapse All</button>
      <button type="button" onClick={() => void expandAll()}>Expand All</button>
      <label>Diff mode
        <select value={props.state.detail.diffMode} onChange={(event) => void setFilesView({ diffMode: event.currentTarget.value as 'inline' | 'side-by-side' })}>
          <option value="inline">Inline</option>
          <option value="side-by-side">Side by Side</option>
        </select>
      </label>
      <label>Filter files<input value={props.state.detail.fileFilter} onChange={(event) => void setFilesView({ fileFilter: event.currentTarget.value })} /></label>
      <button type="button" onClick={() => void refreshFiles()}>Refresh files</button>
    </header>
    {props.state.detail.error ? <p className="review-error" role="alert">{props.state.detail.error}</p> : null}
    {error ? <p className="review-error" role="alert">{error}</p> : null}
    {isRecord(props.state.detail.files) && props.state.detail.files.truncated === true ? <p role="status">Showing the bounded changed-file set returned by the hosting provider.</p> : null}
    {filteredFiles.length === 0 ? <p role="status">No files match this filter.</p> : <div className="review-files-layout">
      {treeVisible ? <aside className="review-file-tree" aria-label="Changed files">
        <ul>{filteredFiles.map((file) => <li key={file.path}>
          <button type="button" aria-current={props.state.detail.selectedFile === file.path ? 'page' : undefined} onClick={() => void setFilesView({ selectedFile: file.path })}>
            {file.path} <span>{file.viewed === true ? 'Viewed' : file.viewed === false ? 'Unviewed' : 'Unknown'}</span>
          </button>
        </li>)}</ul>
      </aside> : null}
      <div className="review-file-diffs">
        {selectedFiles.map((file) => {
          const isCollapsed = collapsed.has(file.path)
          const patch = file.patch === null ? null : parsePatch(file.patch)
          const anchor = inlineAnchor?.path === file.path ? inlineAnchor : null
          return <article className="review-file-diff" key={file.path}>
            <header className="review-file-header">
              <button type="button" aria-expanded={!isCollapsed} onClick={() => {
                const next = isCollapsed ? props.state.detail.collapsedFiles.filter((path) => path !== file.path) : [...props.state.detail.collapsedFiles, file.path]
                void setFilesView({ collapsedFiles: next })
              }}>{isCollapsed ? 'Expand' : 'Collapse'} {file.path}</button>
              <span>{file.status}</span><span>+{file.additions} / −{file.deletions}</span>
              <label><input
                type="checkbox"
                checked={file.viewed === true}
                disabled={pendingPath === file.path}
                onChange={() => void toggleViewed(file)}
              />Viewed</label>
              {file.viewed === null ? <small>Viewed state is unavailable.</small> : null}
            </header>
            {!isCollapsed ? <div className="review-file-content">
              {file.isBinary ? <p>Binary file; no text diff is available.</p>
                : file.patchUnavailable || patch === null ? <p>Patch unavailable for this file.</p>
                  : <>
                    {patch.truncated ? <p role="status">This patch is truncated to a bounded preview.</p> : null}
                    {props.state.detail.diffMode === 'side-by-side'
                      ? <div className="review-side-by-side" role="table" aria-label={`Side-by-side diff for ${file.path}`}>
                        {patch.lines.map((line, index) => <div className={`review-diff-line review-diff-${line.kind}`} role="row" key={`${index}:${line.text}`}>
                          <code role="cell">{line.leftLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('-') && !line.text.startsWith('---') ? line.text.slice(1) : line.text.startsWith('+') && !line.text.startsWith('+++') ? '' : line.text}</code>
                          <code role="cell">{line.rightLine === null && line.kind !== 'meta' ? '' : line.text.startsWith('+') && !line.text.startsWith('+++') ? line.text.slice(1) : line.text.startsWith('-') && !line.text.startsWith('---') ? '' : line.text}</code>
                          {line.rightLine !== null ? <div className="review-inline-actions">
                            <button type="button" disabled={!headValid} onClick={() => setRangeStart({ path: file.path, line: line.rightLine as number })}>Set range start {line.rightLine}</button>
                            <button type="button" disabled={!headValid} onClick={() => setInlineAnchor({
                              path: file.path,
                              line: line.rightLine as number,
                              startLine: rangeStart?.path === file.path && rangeStart.line <= (line.rightLine as number) ? rangeStart.line : line.rightLine as number,
                            })}>Comment at {line.rightLine}</button>
                          </div> : null}
                        </div>)}
                      </div>
                      : <div className="review-inline-diff">
                        {patch.lines.map((line, index) => <div className={`review-diff-line review-diff-${line.kind}`} key={`${index}:${line.text}`}>
                          <span className="review-diff-lines">{line.leftLine ?? ''}{line.rightLine === null ? '' : ` / ${line.rightLine}`}</span>
                          <code>{line.text}</code>
                          {line.rightLine !== null ? <div className="review-inline-actions">
                            <button type="button" disabled={!headValid} onClick={() => setRangeStart({ path: file.path, line: line.rightLine as number })}>Set range start {line.rightLine}</button>
                            <button type="button" disabled={!headValid} onClick={() => setInlineAnchor({
                              path: file.path,
                              line: line.rightLine as number,
                              startLine: rangeStart?.path === file.path && rangeStart.line <= (line.rightLine as number) ? rangeStart.line : line.rightLine as number,
                            })}>Comment at {line.rightLine}</button>
                          </div> : null}
                        </div>)}
                      </div>}
                    {patch.lines.some((line) => line.rightLine !== null && matchingInlineComments(file.path, line.rightLine as number).length > 0) ? <section className="review-inline-threads" aria-label="Inline review comments">
                      {patch.lines.flatMap((line) => line.rightLine === null ? [] : matchingInlineComments(file.path, line.rightLine).map((comment) =>
                        <article key={`${String(comment.id)}:${line.rightLine}`}><strong>Line {line.rightLine}</strong><Markdown source={comment.body} /></article>
                      ))}
                    </section> : null}
                  </>}
              {anchor ? <form className="review-inline-comment-composer" onSubmit={(event) => { event.preventDefault(); void addInlineComment() }}>
                <label>Comment on {file.path}:{anchor.startLine === anchor.line ? anchor.line : `${anchor.startLine}–${anchor.line}`}</label>
                {!headValid ? <p role="alert">A verified pull request head is required before commenting.</p> : null}
                <MarkdownComposer value={inlineDraft} onChange={setInlineDraft} label="Inline review comment" minRows={3} disabled={!headValid || busyInline} onSubmit={() => void addInlineComment()} />
                <button type="submit" disabled={!headValid || busyInline || inlineDraft.trim() === ''}>{busyInline ? 'Sending…' : 'Add review comment'}</button>
                <button type="button" disabled={busyInline} onClick={() => setInlineAnchor(null)}>Cancel</button>
              </form> : null}
              {rangeStart?.path === file.path ? <p>Range starts at line {rangeStart.line}. Choose a later added line to comment on the range.</p> : null}
            </div> : null}
          </article>
        })}
      </div>
    </div>}
  </section>
}