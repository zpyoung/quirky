import { useEffect, useRef, useState } from 'react'
import { Badge, ContextMenu, IconButton, ListRow, SectionHeader } from '@quirky/ui'
import type { ContextMenuItem } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../panel/format'
import { SendMenu } from './SendMenu'
import type { Note } from './useNotes'

type Props = {
  context: UiPluginContext
  worktree: string
  notes: readonly Note[]
  collapsed: boolean
  onToggle(): void
  /** Changes each time the shelf should scroll into view. */
  revealTick: number
  onOpenNote(note: Note): void
  /** Asks the person to confirm; resolves to their answer. */
  ask(spec: { title: string; body: string; confirm: string; danger?: boolean }): Promise<boolean>
}

const lineLabel = (note: Note) => (note.startLine === note.line ? `Line ${note.line}` : `Lines ${note.startLine}-${note.line}`)

/**
 * The Notes shelf: every note of the worktree with copy, send and clear actions, shown only while
 * there are notes. Clicking a note opens it; the send menu is the one a keyboard request opens.
 */
export function NotesShelf({ context, worktree, notes, collapsed, onToggle, revealTick, onOpenNote, ask }: Props) {
  const root = useRef<HTMLElement>(null)
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null)

  useEffect(() => {
    if (revealTick > 0) root.current?.scrollIntoView?.({ block: 'nearest' })
  }, [revealTick])

  const copy = async (ids?: string[]) => {
    try {
      const { text } = (await context.call('quirky.git/formatNotes', { worktree, ...(ids ? { ids } : {}) })) as { text: string }
      await navigator.clipboard.writeText(text)
    } catch (error) {
      context.toast('Failed to copy notes', messageOf(error))
    }
  }

  const clear = async (path?: string) => {
    const scope = path === undefined ? { worktree } : { worktree, path }
    try {
      const title = (await context.call('quirky.git/describeClearNotes', scope)) as string
      if (!(await ask({ title, body: '', confirm: 'Clear', danger: true }))) return
      await context.call('quirky.git/clearNotes', { ...scope, yes: true })
    } catch (error) {
      context.toast('Failed to clear notes.', messageOf(error))
    }
  }

  const paths = [...new Set(notes.map((note) => note.path))].sort()
  const actions: ContextMenuItem[] = [
    { label: 'Clear all notes...', onSelect: () => void clear() },
    ...paths.map((path, index) => ({ label: `Clear notes for ${path}`, separatorBefore: index === 0, onSelect: () => void clear(path) }))
  ]

  return (
    <section className="ui-stack" ref={root} aria-label="Notes" style={{ gap: 'var(--ui-space-4)' }}>
      <SectionHeader
        title="Notes"
        actions={
          <div className="ui-cluster">
            <Badge label={`${notes.length} ${notes.length === 1 ? 'note' : 'notes'}`}>{notes.length}</Badge>
            <IconButton
              label={`${collapsed ? 'Expand' : 'Collapse'} Notes`}
              aria-expanded={!collapsed}
              onClick={onToggle}
            >
              {collapsed ? '▸' : '▾'}
            </IconButton>
            <IconButton label="Copy all notes to clipboard" title="Copy all notes to clipboard" onClick={() => void copy()}>
              {'⧉'}
            </IconButton>
            <SendMenu context={context} worktree={worktree} respondToRequest scopes={[{ id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }]} />
            <IconButton
              label="More note actions"
              aria-haspopup="menu"
              title="More note actions"
              onClick={(event) => {
                const box = event.currentTarget.getBoundingClientRect()
                setMenuAt({ x: box.left, y: box.bottom })
              }}
            >
              {'⋯'}
            </IconButton>
          </div>
        }
      />
      {!collapsed && (
        <ul className="ui-stack" style={{ gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 }}>
          {notes.map((note) => (
            <li key={note.id} data-note-row data-note-path={note.path}>
              <ListRow
                title={note.path}
                description={
                  <span className="ui-stack" style={{ gap: 'var(--ui-space-2)' }}>
                    <span className="ui-cluster" data-note-line><Badge>{lineLabel(note)}</Badge></span>
                    <span data-note-body style={{ color: 'var(--ui-text)' }}>{note.body}</span>
                  </span>
                }
                onClick={() => onOpenNote(note)}
                trailing={
                  <IconButton label="Copy note" title="Copy note" onClick={() => void copy([note.id])}>
                    {'⧉'}
                  </IconButton>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {menuAt && <ContextMenu x={menuAt.x} y={menuAt.y} label="More note actions" items={actions} onClose={() => setMenuAt(null)} />}
    </section>
  )
}
