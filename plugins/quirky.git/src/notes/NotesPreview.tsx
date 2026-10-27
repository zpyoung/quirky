import { useEffect, useRef, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../view/data'
import { rangeLabel } from './line-range'
import { NotesPillContent } from './NotesPill'
import type { Note } from './useNotes'

const PREVIEW_LIMIT = 4
const POPOVER_WIDTH = 320
const COPIED_MS = 1500

type Props = {
  context: UiPluginContext
  worktree: string
  notes: readonly Note[]
}

/**
 * The combined diff's "Show N AI notes" pill and the popover it opens: the first four notes
 * with Copy (their prompt text to the clipboard) and Clear (all of the worktree's notes, after
 * a confirmation).
 */
export function NotesPreview({ context, worktree, notes }: Props) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [place, setPlace] = useState<{ alignRight: boolean; width: number }>({ alignRight: false, width: POPOVER_WIDTH })
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!anchor.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current)
    },
    []
  )

  const copy = async () => {
    try {
      const { text } = (await context.call('quirky.git/formatNotes', { worktree })) as { text: string }
      await navigator.clipboard.writeText(text)
      setCopied(true)
      if (timer.current !== null) clearTimeout(timer.current)
      timer.current = setTimeout(() => setCopied(false), COPIED_MS)
    } catch (error) {
      context.toast('Failed to copy notes', messageOf(error))
    }
  }

  const clear = async () => {
    try {
      const title = (await context.call('quirky.git/describeClearNotes', { worktree })) as string
      if (!(await context.confirm({ title, confirmLabel: 'Clear' }))) return
      await context.call('quirky.git/clearNotes', { worktree, yes: true })
      setOpen(false)
    } catch (error) {
      context.toast('Failed to clear notes.', messageOf(error))
    }
  }

  const shown = notes.slice(0, PREVIEW_LIMIT)
  const rest = notes.length - shown.length
  return (
    <span className="qgv-menu-anchor" ref={anchor}>
      <button
        type="button"
        className="qgv-note-pill"
        aria-label={`Show ${notes.length} AI ${notes.length === 1 ? 'note' : 'notes'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          const box = anchor.current?.getBoundingClientRect()
          const bound = anchor.current?.closest('.qgv-root')?.getBoundingClientRect()
          const right = bound?.right ?? window.innerWidth
          const left = bound?.left ?? 0
          const width = Math.max(160, Math.min(POPOVER_WIDTH, right - left - 16))
          setPlace({ alignRight: box !== undefined && box.left + width > right, width })
          setOpen((value) => !value)
        }}
      >
        <NotesPillContent count={notes.length} />
      </button>
      {open && (
        <div className={`qgv-note-popover${place.alignRight ? ' qgv-note-popover-end' : ''}`} style={{ width: place.width }} role="dialog" aria-label="AI notes">
          <div className="qgv-note-popover-head">
            <span className="qgv-note-popover-title">
              AI notes <span className="qgv-note-count">{notes.length}</span>
            </span>
            <span className="qgv-note-popover-actions">
              <button type="button" disabled={notes.length === 0} data-copied={copied ? '' : undefined} onClick={() => void copy()}>
                Copy
              </button>
              <button type="button" className="qgv-note-danger" disabled={notes.length === 0} onClick={() => void clear()}>
                Clear
              </button>
            </span>
          </div>
          <ul className="qgv-note-previews">
            {shown.map((note) => (
              <li key={note.id} className="qgv-note-preview">
                <div className="qgv-note-preview-where">
                  <span className="qgv-note-preview-path">{note.path}</span>
                  <span className="qgv-note-preview-lines">{rangeLabel(note)}</span>
                </div>
                <div className="qgv-note-preview-body">{note.body}</div>
              </li>
            ))}
          </ul>
          {rest > 0 && <div className="qgv-note-more">{`${rest} more ${rest === 1 ? 'note' : 'notes'} in Source Control`}</div>}
        </div>
      )}
    </span>
  )
}
