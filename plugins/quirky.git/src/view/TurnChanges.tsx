import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { Badge, Button, EmptyState, InlineError, ListRow, NoticeLine } from '@quirky/ui'
import type { GitChange, GitDiff, MountFunction, UiPluginContext } from '@quirky/protocol'

import { useNotesBinding } from '../notes/binding'
import { NotesPillContent } from '../notes/NotesPill'
import { SendMenu } from '../notes/SendMenu'
import { noteCounts, useNotes, type Note } from '../notes/useNotes'
import { PANEL_ID } from '../shared/view-input'
import { messageOf } from './data'
import { DiffPane } from './DiffPane'
import { useDiffSettings, type DiffSettings } from './settings'

export const TURN_CHANGES_VIEW_ID = 'view:quirky.git/turn-changes'

/** What the turn-changes view is mounted with: the worktree and the two snapshot trees the turn ran between. */
export type TurnChangesInput = { worktree: string; fromTree: string; toTree: string }

/** The mount input as a `TurnChangesInput`, or null when it lacks the worktree or either tree. */
export function parseTurnChangesInput(input: unknown): TurnChangesInput | null {
  if (typeof input !== 'object' || input === null) return null
  const { worktree, fromTree, toTree } = input as Partial<TurnChangesInput>
  for (const value of [worktree, fromTree, toTree]) if (typeof value !== 'string' || value === '') return null
  return { worktree: worktree!, fromTree: fromTree!, toTree: toTree! }
}

type Load<T> = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; value: T }

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`

function Counts({ change }: { change: Pick<GitChange, 'added' | 'removed' | 'binary'> }) {
  if (change.added === null || change.removed === null) return <Badge>{change.binary ? 'Binary' : 'Unknown'}</Badge>
  return (
    <span className="ui-cluster">
      <Badge tone="working" label={`Added ${plural(change.added, 'line')}`}>{`+${change.added}`}</Badge>
      <Badge tone="failing" label={`Removed ${plural(change.removed, 'line')}`}>{`−${change.removed}`}</Badge>
    </span>
  )
}

type FileProps = {
  context: UiPluginContext
  input: TurnChangesInput
  change: GitChange
  expanded: boolean
  onToggle(): void
  notes: readonly Note[]
  noteCount: number
  settings: DiffSettings
}

const noReload = async (): Promise<void> => {}
const noStaleReload = (): void => {}
const noSave = (): void => {}

/** One changed file: its row, and once expanded its read-only diff with line comments. */
function ChangedFile({ context, input, change, expanded, onToggle, notes, noteCount, settings }: FileProps) {
  const [diff, setDiff] = useState<Load<GitDiff>>({ status: 'loading' })
  const latest = useRef(0)
  const binding = useNotesBinding(context, input.worktree, notes)
  const { worktree, fromTree, toTree } = input
  const { path, oldPath } = change

  function loadDiff(): void {
    const attempt = ++latest.current
    setDiff({ status: 'loading' })
    context
      .call('quirky.git/diff', { worktree, path, source: 'trees', from: fromTree, to: toTree, ...(oldPath === undefined ? {} : { oldPath }) })
      .then((value) => attempt === latest.current && setDiff({ status: 'ready', value: value as GitDiff }))
      .catch((error: unknown) => attempt === latest.current && setDiff({ status: 'error', message: messageOf(error) }))
  }

  useEffect(() => {
    if (!expanded) return
    loadDiff()
    return () => {
      latest.current++
    }
  }, [context, expanded, worktree, path, oldPath, fromTree, toTree])

  return (
    <div role="listitem" data-turn-file={path}>
      <ListRow
        title={oldPath === undefined ? path : `${oldPath} → ${path}`}
        mainLabel={`${expanded ? 'Collapse' : 'Expand'} ${path}`}
        selected={expanded}
        compact
        onClick={onToggle}
        trailing={
          <span className="ui-cluster">
            {noteCount > 0 && <span className="ui-text-muted">{`✎ ${plural(noteCount, 'note')}`}</span>}
            <Counts change={change} />
          </span>
        }
      />
      {expanded && (
        <div data-turn-diff>
          {diff.status === 'loading' && <div role="status"><NoticeLine>Loading diff...</NoticeLine></div>}
          {diff.status === 'error' && (
            <InlineError message={`Error loading diff: ${diff.message}`} action={{ label: 'Retry', onAction: loadDiff }} />
          )}
          {diff.status === 'ready' && (
            <DiffPane
              key={`${fromTree}:${toTree}:${path}`}
              context={context}
              worktree={worktree}
              path={path}
              diff={diff.value}
              editable={false}
              settings={settings}
              variant="section"
              onSaved={noSave}
              onReload={noReload}
              onStaleReload={noStaleReload}
              notes={binding}
            />
          )}
        </div>
      )}
    </div>
  )
}

/**
 * What one agent turn changed: the files between two snapshot trees with line counts, each
 * expandable to a read-only diff you can comment on. Comments join the worktree's notes, which the
 * Send menu delivers to an agent session as one message.
 */
export function TurnChanges({ context, input }: { context: UiPluginContext; input: TurnChangesInput }) {
  const { worktree, fromTree, toTree } = input
  const { settings } = useDiffSettings(context)
  const notes = useNotes(context, worktree)
  const [changes, setChanges] = useState<Load<GitChange[]>>({ status: 'loading' })
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set())
  const counts = useMemo(() => noteCounts(notes), [notes])

  useEffect(() => {
    let alive = true
    setChanges({ status: 'loading' })
    context
      .call('quirky.git/treeChanges', { worktree, from: fromTree, to: toTree })
      .then((result) => alive && setChanges({ status: 'ready', value: (result as { changes: GitChange[] }).changes }))
      .catch((error: unknown) => alive && setChanges({ status: 'error', message: messageOf(error) }))
    return () => {
      alive = false
    }
  }, [context, worktree, fromTree, toTree])

  const toggle = useCallback((path: string) => {
    setOpen((current) => {
      const next = new Set(current)
      if (!next.delete(path)) next.add(path)
      return next
    })
  }, [])

  if (changes.status === 'loading') return <div role="status"><NoticeLine>Loading changes...</NoticeLine></div>
  if (changes.status === 'error') return <InlineError message={`Error loading changes: ${changes.message}`} />
  const files = changes.value
  if (files.length === 0) return <EmptyState message="This turn changed no files." />

  const added = files.reduce((sum, file) => sum + (file.added ?? 0), 0)
  const removed = files.reduce((sum, file) => sum + (file.removed ?? 0), 0)
  const noteLabel = `Send ${plural(notes.length, 'note')} to agent`
  return (
    <section className="ui-stack" data-turn-changes aria-label="Changes in this turn">
      <header className="ui-cluster" style={{ padding: 'var(--ui-space-4) var(--ui-space-8)' }}>
        <strong>{plural(files.length, 'file')} changed</strong>
        <Counts change={{ added, removed, binary: false }} />
        <span style={{ flex: 1 }} />
        <span className="ui-cluster" data-turn-notes role="status" aria-label={plural(notes.length, 'note')}>
          <NotesPillContent count={notes.length} />
        </span>
        {notes.length > 0 && (
          <SendMenu
            context={context}
            worktree={worktree}
            ariaLabel={noteLabel}
            scopes={[{ id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }]}
          >
            {`${noteLabel} ▾`}
          </SendMenu>
        )}
        <Button onClick={() => context.togglePanel(PANEL_ID, true)}>Open in Changes panel</Button>
      </header>
      <div role="list">
        {files.map((file) => (
          <ChangedFile
            key={file.path}
            context={context}
            input={input}
            change={file}
            expanded={open.has(file.path)}
            onToggle={() => toggle(file.path)}
            notes={notes}
            noteCount={counts.get(file.path) ?? 0}
            settings={settings}
          />
        ))}
      </div>
    </section>
  )
}

/** The `view:quirky.git/turn-changes` mount function; the host remounts it with the new input whenever the input changes. */
export function mountTurnChanges(context: UiPluginContext): MountFunction {
  return (element, { input }) => {
    const parsed = parseTurnChangesInput(input)
    const root = createRoot(element)
    root.render(parsed === null ? <EmptyState message="No turn to show." /> : <TurnChanges context={context} input={parsed} />)
    return () => root.unmount()
  }
}
