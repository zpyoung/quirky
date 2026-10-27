import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { PopupMenu, type MenuEntry } from '../panel/Menu'
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
  const more = useRef<HTMLButtonElement>(null)
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
  const actions: MenuEntry[] = [
    { label: 'Clear all notes...', onSelect: () => void clear() },
    ...paths.map((path, index) => ({ label: `Clear notes for ${path}`, separatorBefore: index === 0, onSelect: () => void clear(path) }))
  ]

  return (
    <section className="scm-notes" ref={root} aria-label="Notes">
      <header className="scm-section-head scm-notes-head">
        <button type="button" className="scm-section-toggle scm-notes-toggle" aria-expanded={!collapsed} onClick={onToggle}>
          <span className="scm-chevron" aria-hidden="true">
            {collapsed ? '▸' : '▾'}
          </span>
          <span className="scm-notes-title">Notes</span>
          <span className="scm-count">{notes.length}</span>
        </button>
        <span className="scm-section-actions">
          <button type="button" className="icon-button" aria-label="Copy all notes to clipboard" title="Copy all notes to clipboard" onClick={() => void copy()}>
            {'⧉'}
          </button>
          <SendMenu context={context} worktree={worktree} respondToRequest scopes={[{ id: 'all', label: 'All unsent notes', notes, params: { scope: 'all' } }]} />
          <button
            ref={more}
            type="button"
            className="icon-button"
            aria-label="More note actions"
            aria-haspopup="menu"
            title="More note actions"
            onClick={() => {
              const box = more.current?.getBoundingClientRect()
              setMenuAt({ x: box?.left ?? 0, y: box?.bottom ?? 0 })
            }}
          >
            {'⋯'}
          </button>
        </span>
      </header>
      {!collapsed && (
        <ul className="scm-notes-list">
          {notes.map((note) => (
            <li key={note.id} className="scm-note-row">
              <button type="button" className="scm-note-open" title={`${note.path}, ${lineLabel(note)}`} onClick={() => onOpenNote(note)}>
                <span className="scm-note-where">
                  <span className="scm-note-path">{note.path}</span>
                  <span className="scm-note-lines">{lineLabel(note)}</span>
                </span>
                <span className="scm-note-text">{note.body}</span>
              </button>
              <button type="button" className="icon-button" aria-label="Copy note" title="Copy note" onClick={() => void copy([note.id])}>
                {'⧉'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {menuAt && <PopupMenu x={menuAt.x} y={menuAt.y} label="More note actions" items={actions} onClose={() => setMenuAt(null)} />}
    </section>
  )
}
