import { useCallback, useEffect, useRef, useState } from 'react'
import { Badge, Button, IconButton, ReviewMark } from '@quirky/ui'
import type { GitDiff, UiPluginContext } from '@quirky/protocol'

import { useNotesBinding } from '../notes/binding'
import type { Note } from '../notes/useNotes'
import { splitPath } from '../panel/format'
import { isEditableCard, isTextDiff } from './data'
import { DiffPane, type PaneHandle, type PaneState } from './DiffPane'
import { ErrorNotice } from './Fallbacks'
import { MarkdownPreview } from './MarkdownPreview'
import { loadModeOf, type ReviewItem } from './review-layout'
import type { DiffSettings } from './settings'

/** What one card has loaded of its diff. `against` and `signature` are what that diff was fetched for. */
export type CardData = {
  status: 'idle' | 'loading' | 'loaded' | 'error'
  diff?: GitDiff
  error?: string
  /** Bumped when the diff is replaced, which rebuilds the pane. */
  revision: number
  against: 'base' | 'reviewed'
  signature: string
}

const isMarkdown = (path: string): boolean => /\.(md|markdown)$/i.test(path)

const MARK_LABELS = { none: 'Mark reviewed', reviewed: '✓ Reviewed', changed: '● Changed since review' } as const

export type ReviewCardProps = {
  context: UiPluginContext
  worktree: string
  item: ReviewItem
  data: CardData
  collapsed: boolean
  /** The user asked a changed card for its whole diff. */
  full: boolean
  /** A commit scope has no review state, so the card shows no review controls. */
  scoped: boolean
  active: boolean
  marking: boolean
  /** The card's pane holds edits that are not saved. */
  dirty: boolean
  root: HTMLElement | null
  settings: DiffSettings
  notes: readonly Note[]
  revealNote?: string
  register(key: string, element: HTMLElement | null): void
  onToggle(key: string): void
  onMark(item: ReviewItem): void
  onFullDiff(key: string): void
  onLoad(key: string): void
  onVisible(key: string): void
  onActivate(key: string): void
  onPaneState(key: string, state: PaneState): void
  onPaneHandle(key: string, handle: PaneHandle | null): void
  onReload(key: string): Promise<void>
  /** A save or revert wrote `content` to disk; the owner updates the diff it holds without rebuilding the pane. */
  onSaved(key: string, content: string, hash: string): void
}

/**
 * One file of the Review tab: a sticky header with the path, counts, notes, review mark and its
 * button over the file's diff. The diff loads when the card is told to (`onVisible`, `onLoad`).
 * Outside a commit scope the disk side of a text diff takes edits and each change can be reverted;
 * a Markdown file can be shown rendered instead of as a diff, the diff staying mounted beneath.
 */
export function ReviewCard(props: ReviewCardProps) {
  const { context, worktree, item, data, collapsed, full, scoped, active, marking, dirty, root, settings, notes, onToggle, onVisible } = props
  const { key } = item
  const element = useRef<HTMLElement | null>(null)
  const visible = useRef(false)
  const binding = useNotesBinding(context, worktree, notes, props.revealNote)
  const pane = useRef<PaneHandle | null>(null)
  const [preview, setPreview] = useState(false)

  useEffect(() => {
    const el = element.current
    props.register(key, el)
    if (!el || !root || typeof IntersectionObserver === 'undefined') return () => props.register(key, null)
    const observer = new IntersectionObserver(
      (hits) => {
        for (const hit of hits) visible.current = hit.isIntersecting
        if (visible.current) onVisible(key)
      },
      { root, rootMargin: '100% 0%' }
    )
    observer.observe(el)
    return () => {
      observer.disconnect()
      props.register(key, null)
    }
  }, [root, key, onVisible, props.register])

  useEffect(() => {
    if (!collapsed && visible.current) onVisible(key)
  }, [collapsed, key, onVisible])

  const onPaneState = useCallback((state: PaneState) => props.onPaneState(key, state), [props.onPaneState, key])
  const onPaneHandle = useCallback(
    (handle: PaneHandle | null) => {
      pane.current = handle
      props.onPaneHandle(key, handle)
    },
    [props.onPaneHandle, key]
  )
  const onReload = useCallback(() => props.onReload(key), [props.onReload, key])
  const onSaved = useCallback((content: string, hash: string) => props.onSaved(key, content, hash), [props.onSaved, key])

  const { name, dir } = splitPath(item.path)
  const known = item.added !== null && item.removed !== null
  const mode = loadModeOf(item)
  const since = !scoped && item.mark === 'changed' && !full
  const diff = data.status === 'loaded' ? data.diff : undefined
  const editable = diff !== undefined && isEditableCard(scoped, diff)
  const previewable = diff !== undefined && isMarkdown(item.path) && isTextDiff(diff) && diff.modifiedDeleted !== true
  const previewing = previewable && preview

  return (
    <section
      data-path={item.path}
      data-active={active ? '' : undefined}
      ref={element}
      className="git-review__card"
      onPointerDown={() => props.onActivate(key)}
    >
      <header className="git-review__card-head">
        <IconButton label={`${collapsed ? 'Expand' : 'Collapse'} ${item.path}`} aria-expanded={!collapsed} onClick={() => onToggle(key)}>
          {collapsed ? '▸' : '▾'}
        </IconButton>
        <span className="git-review__title" title={item.path}>
          {item.oldPath && <span className="git-review__dir">{item.oldPath} → </span>}
          {dir !== '' && <span className="git-review__dir">{dir}/</span>}
          <span className="git-review__name">{name}</span>
        </span>
        {known && (
          <span className="git-review__counts">
            <Badge tone="working" label={`Added ${item.added} line${item.added === 1 ? '' : 's'}`}>+{item.added}</Badge>
            <Badge tone="failing" label={`Removed ${item.removed} line${item.removed === 1 ? '' : 's'}`}>-{item.removed}</Badge>
          </span>
        )}
        {item.notes > 0 && <span className="git-review__notes">{`✎ ${item.notes} note${item.notes === 1 ? '' : 's'}`}</span>}
        {(dirty || previewable) && (
          <span className="git-review__edit">
            {dirty && <Badge tone="needs-you">Unsaved</Badge>}
            {previewable && (
              <Button title={preview ? 'Show the diff' : 'Show the rendered Markdown'} onClick={() => setPreview(!preview)}>
                {preview ? 'Source' : 'Preview'}
              </Button>
            )}
          </span>
        )}
        {!scoped && (
          <span className="git-review__review">
            <ReviewMark state={item.mark} />
            <Button disabled={marking} onClick={() => props.onMark(item)}>
              {MARK_LABELS[item.mark]}
            </Button>
          </span>
        )}
      </header>
      <div hidden={collapsed} data-review-body className="git-review__body">
        {since && (
          <p className="ui-text-muted git-review__since" role="status">
            Showing changes since you reviewed ·{' '}
            <Button disabled={dirty} title={dirty ? 'Save or discard your edits first' : undefined} onClick={() => props.onFullDiff(key)}>
              Full diff
            </Button>
          </p>
        )}
        {data.status === 'error' ? (
          <>
            <ErrorNotice message={data.error ?? 'Unable to load diff.'} />
            <Button onClick={() => props.onLoad(key)}>Retry</Button>
          </>
        ) : data.status === 'loaded' && data.diff ? (
          <>
            <div className="git-review__pane" hidden={previewing}>
              <DiffPane
                key={data.revision}
                context={context}
                worktree={worktree}
                path={item.path}
                diff={data.diff}
                editable={editable}
                settings={settings}
                variant="section"
                onState={onPaneState}
                bind={onPaneHandle}
                onSaved={onSaved}
                revertOnDisk={!scoped}
                onReload={onReload}
                onFocus={() => props.onActivate(key)}
                notes={binding}
              />
            </div>
            {previewing && (
              <MarkdownPreview
                context={context}
                worktree={worktree}
                path={item.path}
                revision={data.revision}
                textOf={() => pane.current?.modifiedText() ?? data.diff!.modified}
              />
            )}
          </>
        ) : data.status === 'idle' && mode !== 'auto' ? (
          <section className="ui-stack git-review__notice">
            <p>{known ? 'Large diffs are not rendered by default.' : "This diff's size isn't known yet, so it loads on request."}</p>
            <Button onClick={() => props.onLoad(key)}>Load diff</Button>
          </section>
        ) : (
          <p className="ui-text-muted git-review__notice">Loading diff...</p>
        )}
      </div>
    </section>
  )
}
