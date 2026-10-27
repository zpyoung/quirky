import { useEffect, useState } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { Note } from '../daemon/notes'

export type { Note }

const EMPTY: readonly Note[] = []

/**
 * The notes of a worktree, read again whenever `quirky.git/notesChanged` names it. A failed read
 * keeps the last list. Shared by the Source Control panel and the diff view.
 */
export function useNotes(context: UiPluginContext, worktree: string): readonly Note[] {
  const [notes, setNotes] = useState<readonly Note[]>(EMPTY)

  useEffect(() => {
    let alive = true
    let newest = 0
    let known: string | null = null
    const read = async () => {
      const ticket = ++newest
      try {
        const result = (await context.call('quirky.git/notes', { worktree })) as { notes: Note[] }
        if (!alive || ticket !== newest) return
        known = result.notes[0]?.worktreeId ?? known
        setNotes((prev) => (JSON.stringify(prev) === JSON.stringify(result.notes) ? prev : result.notes))
      } catch {
        // the panel and view still work without notes
      }
    }
    void read()
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.git/notesChanged') return
      const id = (event.data as { worktreeId?: unknown } | undefined)?.worktreeId
      // the event names the worktree by id and `worktree` may be a name, so only a known other id is skipped
      if (typeof id === 'string' && id !== worktree && known !== null && id !== known) return
      void read()
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [context, worktree])

  return notes
}

/** How many notes each path carries. */
export function noteCounts(notes: readonly Note[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>()
  for (const note of notes) counts.set(note.path, (counts.get(note.path) ?? 0) + 1)
  return counts
}
