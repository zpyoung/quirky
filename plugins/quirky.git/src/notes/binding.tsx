import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../view/data'
import type { CardSpec, NoteDraft, NotesExtensionOptions } from './extension'
import { sameRange, type LineRange } from './line-range'
import { DraftCard, SavedCard } from './NoteCards'
import { SendMenu } from './SendMenu'
import type { Note } from './useNotes'

/**
 * What a diff owner (the single-file view or one combined section) gives its panes: the worktree's
 * notes, the draft being written, and how to draw cards. It lives above the pane, which is rebuilt
 * when its settings or its diff change, so a half-written note survives both.
 */
export type NotesBinding = {
  /** Every note of the worktree; a pane keeps those of its own path. */
  notes: readonly Note[]
  draft: NoteDraft | null
  /** A note whose card the pane should scroll into view, until `revealed` is called. */
  reveal: string | undefined
  revealed(): void
  openDraft(range: LineRange): void
  /** Renders a card of a note on `path` into the element of its block widget. */
  mountCard(path: string, element: HTMLElement, card: CardSpec, remeasure: () => void): () => void
}

/**
 * The binding of one diff owner. Opening a draft while another is open closes the first and
 * carries its text over, so moving to another line does not lose what was typed.
 */
export function useNotesBinding(context: UiPluginContext, worktree: string, notes: readonly Note[], reveal?: string): NotesBinding {
  const [draft, setDraft] = useState<NoteDraft | null>(null)
  const [pending, setPending] = useState(reveal)
  const typed = useRef('')
  const keys = useRef(0)
  const live = useRef({ context, worktree, draft })
  live.current = { context, worktree, draft }

  useEffect(() => setPending(reveal), [reveal])

  const actions = useRef<Pick<NotesBinding, 'openDraft' | 'mountCard'> | null>(null)
  if (actions.current === null) {
    const close = (key: number) => {
      setDraft((current) => (current?.key === key ? null : current))
      typed.current = ''
    }
    const call = async (method: string, params: Record<string, unknown>, failed: string): Promise<boolean> => {
      const { context: ctx, worktree: tree } = live.current
      try {
        await ctx.call(`quirky.git/${method}`, { worktree: tree, ...params })
        return true
      } catch (error) {
        ctx.toast(failed, messageOf(error))
        return false
      }
    }
    actions.current = {
      openDraft(range) {
        const current = live.current.draft
        if (current && sameRange(current, range)) return
        keys.current += 1
        if (!current) typed.current = ''
        setDraft({ ...range, key: keys.current, body: typed.current })
      },
      mountCard(path, element, card, remeasure) {
        const root = createRoot(element)
        if (card.kind === 'draft') {
          const { draft: spec } = card
          root.render(
            <DraftCard
              draft={{ ...spec, body: typed.current }}
              remeasure={remeasure}
              onBodyChange={(text) => void (typed.current = text)}
              onCancel={() => close(spec.key)}
              onTooLarge={() => live.current.context.toast('Comment is too large to submit safely.', '')}
              onSubmit={async (body) => {
                const params = { path, line: spec.line, ...(spec.startLine === spec.line ? {} : { startLine: spec.startLine }), body }
                const saved = await call('addNote', params, 'Failed to save comment')
                if (saved) close(spec.key)
                return saved
              }}
            />
          )
        } else {
          const { note } = card
          root.render(
            <SavedCard
              note={note}
              remeasure={remeasure}
              onEdit={(body) => call('editNote', { id: note.id, body }, 'Failed to save comment')}
              onDelete={() => void call('deleteNote', { id: note.id }, 'Failed to delete note')}
              send={
                <SendMenu
                  context={live.current.context}
                  worktree={live.current.worktree}
                  className="qgv-note-action"
                  scopes={[{ id: 'note', label: 'This note', notes: [note], params: { scope: 'note', id: note.id } }]}
                />
              }
            />
          )
        }
        // the editor may destroy a card while React is rendering; unmounting then would be re-entrant
        return () => queueMicrotask(() => root.unmount())
      }
    }
  }

  return useMemo(
    () => ({ notes, draft, reveal: pending, revealed: () => setPending(undefined), ...actions.current! }),
    [notes, draft, pending]
  )
}
