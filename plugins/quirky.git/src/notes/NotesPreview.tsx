import { useEffect, useRef, useState } from 'react'
import { Badge, Button, ListRow, Popover, SectionHeader } from '@quirky/ui'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../view/data'
import { rangeLabel } from './line-range'
import { NotesPillContent } from './NotesPill'
import type { Note } from './useNotes'

const PREVIEW_LIMIT = 4
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
  const anchor = useRef<HTMLSpanElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(
    () => () => {
      clearTimeout(timer.current)
    },
    []
  )

  const copy = async () => {
    try {
      const { text } = (await context.call('quirky.git/formatNotes', { worktree })) as { text: string }
      await navigator.clipboard.writeText(text)
      setCopied(true)
      clearTimeout(timer.current)
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
  const boundary = anchor.current?.closest<HTMLElement>('[data-git-view-root]') ?? null
  return (
    <span ref={anchor}>
      <Button
        aria-label={`Show ${notes.length} AI ${notes.length === 1 ? 'note' : 'notes'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <NotesPillContent count={notes.length} />
      </Button>
      <Popover open={open} label="AI notes" anchor={anchor} boundary={boundary} onClose={() => setOpen(false)}>
        <div className="ui-stack">
          <SectionHeader
            title="AI notes"
            actions={
              <div className="ui-cluster">
                <Badge tone="accent">{notes.length}</Badge>
                {copied && <Badge tone="working">Copied</Badge>}
                <Button disabled={notes.length === 0} title={copied ? 'Copied' : undefined} onClick={() => void copy()}>
                  Copy
                </Button>
                <Button variant="destructive" disabled={notes.length === 0} onClick={() => void clear()}>
                  Clear
                </Button>
              </div>
            }
          />
          <ul className="ui-stack" style={{ gap: 'var(--ui-space-2)', listStyle: 'none', margin: 0, padding: 0 }}>
            {shown.map((note) => (
              <li key={note.id} data-note-preview>
                <ListRow
                  title={<span title={note.path}>{note.path}</span>}
                  description={
                    <span className="ui-stack" style={{ gap: 'var(--ui-space-2)' }}>
                      <Badge>{rangeLabel(note)}</Badge>
                      <span style={{ color: 'var(--ui-text)' }}>{note.body}</span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
          {rest > 0 && <p className="ui-text-muted">{`${rest} more ${rest === 1 ? 'note' : 'notes'} in Source Control`}</p>}
        </div>
      </Popover>
    </span>
  )
}
