import { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { messageOf } from '../view/data'
import { newGitUiGeneration, registerGitUiControl, requestGitUiControl } from '../ui-control'
import type { CardSpec, NoteDraft, NotesExtensionOptions } from './extension'
import { sameRange, type LineRange } from './line-range'
import { DraftCard, SavedCard } from './NoteCards'
import { SendMenu } from './SendMenu'
import type { Note } from './useNotes'
import type { NoteCardControls, NoteCardHandle } from './NoteCards'

const NOTE_ACTION_UNAVAILABLE = 'The note action is no longer available.'
const SOURCE_ACTION_UNAVAILABLE = 'The source control action is no longer available.'

type NotesCoordinator = {
  context: UiPluginContext
  worktree: string
  cards: Map<symbol, { id: string; handle: NoteCardHandle }>
  generation: string | null
  dispose: (() => void) | null
}

const coordinators = new WeakMap<UiPluginContext, Map<string, NotesCoordinator>>()

function coordinatorFor(context: UiPluginContext, worktree: string): NotesCoordinator {
  let byWorktree = coordinators.get(context)
  if (!byWorktree) {
    byWorktree = new Map()
    coordinators.set(context, byWorktree)
  }
  let coordinator = byWorktree.get(worktree)
  if (!coordinator) {
    coordinator = { context, worktree, cards: new Map(), generation: null, dispose: null }
    byWorktree.set(worktree, coordinator)
  }
  return coordinator
}

function registerNoteCard(coordinator: NotesCoordinator, id: string, handle: NoteCardHandle): () => void {
  const token = Symbol()
  const first = coordinator.cards.size === 0
  coordinator.cards.set(token, { id, handle })
  if (first) {
    const generation = newGitUiGeneration()
    coordinator.generation = generation
    coordinator.dispose = registerGitUiControl(
      coordinator.context,
      {
        surface: 'view:quirky.git/diff',
        target: `notes:${coordinator.worktree}`,
        generation,
        actions: ['edit', 'cancel-edit']
      },
      ({ action, data }) => {
        if (typeof data?.id !== 'string') return false
        let match: NoteCardHandle | null = null
        for (const card of coordinator.cards.values()) {
          if (card.id !== data.id) continue
          if (match !== null) return false
          match = card.handle
        }
        if (match === null) return false
        if (action === 'edit') return match.edit()
        if (action === 'cancel-edit') return match.cancelEdit()
        return false
      }
    )
  }
  return () => {
    if (!coordinator.cards.delete(token) || coordinator.cards.size !== 0) return
    coordinator.dispose?.()
    coordinator.dispose = null
    coordinator.generation = null
  }
}

function controlsFor(coordinator: NotesCoordinator, id: string): NoteCardControls {
  let mounted = false
  return {
    request(action) {
      if (!mounted) return
      const generation = coordinator.generation
      if (generation === null) return
      void requestGitUiControl(coordinator.context, {
        surface: 'view:quirky.git/diff',
        target: `notes:${coordinator.worktree}`,
        generation,
        action,
        data: { id }
      }).then((result) => {
        if (!result.delivered) throw new Error(NOTE_ACTION_UNAVAILABLE)
      }).catch((error) => {
        if (!mounted || coordinator.generation !== generation) return
        const message = messageOf(error)
        coordinator.context.toast(
          'Could not run Source Control action',
          message === SOURCE_ACTION_UNAVAILABLE ? NOTE_ACTION_UNAVAILABLE : message,
          { kind: 'error' }
        )
      })
    },
    register(handle) {
      const unregister = registerNoteCard(coordinator, id, handle)
      mounted = true
      return () => {
        mounted = false
        unregister()
      }
    }
  }
}

function toastNoteFailure(context: UiPluginContext, title: string, error: unknown): false {
  context.toast(title, messageOf(error), { kind: 'error' })
  return false
}
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
          const onSubmit = async (body: string) => {
            const params = { path, line: spec.line, ...(spec.startLine === spec.line ? {} : { startLine: spec.startLine }), body }
            const { context: ctx, worktree: tree } = live.current
            try {
              await ctx.call('quirky.git/addNote', { worktree: tree, ...params })
              close(spec.key)
              return true
            } catch (error) {
              return toastNoteFailure(ctx, 'Failed to save comment', error)
            }
          }
          root.render(
            <DraftCard
              draft={{ ...spec, body: typed.current }}
              remeasure={remeasure}
              onBodyChange={(text) => void (typed.current = text)}
              onCancel={() => close(spec.key)}
              onTooLarge={() => live.current.context.toast('Comment is too large to submit safely.', '', { kind: 'error' })}
              onSubmit={onSubmit}
            />
          )
        } else {
          const { note } = card
          const coordinator = coordinatorFor(live.current.context, live.current.worktree)
          const controls = controlsFor(coordinator, note.id)
          const onEdit = async (body: string) => {
            const { context: ctx, worktree: tree } = live.current
            try {
              await ctx.call('quirky.git/editNote', { worktree: tree, id: note.id, body })
              return true
            } catch (error) {
              return toastNoteFailure(ctx, 'Failed to save comment', error)
            }
          }
          const onDelete = async () => {
            const { context: ctx, worktree: tree } = live.current
            try {
              await ctx.call('quirky.git/deleteNote', { worktree: tree, id: note.id })
            } catch (error) {
              toastNoteFailure(ctx, 'Failed to delete note', error)
            }
          }
          root.render(
            <SavedCard
              note={note}
              controls={controls}
              remeasure={remeasure}
              onEdit={onEdit}
              onDelete={onDelete}
              send={
                <SendMenu
                  context={live.current.context}
                  worktree={live.current.worktree}
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
