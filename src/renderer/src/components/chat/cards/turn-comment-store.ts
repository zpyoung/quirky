import { useSyncExternalStore } from 'react'

/** `side` says which file `line` counts in: 'old' only for a removed line, 'new' for added and context lines. */
export type TurnLineComment = {
  id: string
  path: string
  line: number
  side: 'old' | 'new'
  text: string
}

const EMPTY: readonly TurnLineComment[] = []
const comments = new Map<string, readonly TurnLineComment[]>()
const listeners = new Set<() => void>()

/** Comments live only as long as the app session; the key is the chat session plus the turn. */
export function turnCommentKey(sessionId: string, turnId: string): string {
  return `${sessionId}\u0000${turnId}`
}

function publish(key: string, next: readonly TurnLineComment[]): void {
  if (next.length === 0) {
    comments.delete(key)
  } else {
    comments.set(key, next)
  }
  for (const listener of listeners) {
    listener()
  }
}

export function addTurnComment(key: string, comment: Omit<TurnLineComment, 'id'>): void {
  const id = `${comment.path}:${comment.side}:${comment.line}:${(comments.get(key)?.length ?? 0) + Date.now()}`
  publish(key, [...(comments.get(key) ?? EMPTY), { ...comment, id }])
}

export function removeTurnComment(key: string, id: string): void {
  publish(
    key,
    (comments.get(key) ?? EMPTY).filter((comment) => comment.id !== id)
  )
}

export function clearTurnComments(key: string): void {
  publish(key, EMPTY)
}

export function readTurnComments(key: string): readonly TurnLineComment[] {
  return comments.get(key) ?? EMPTY
}

export function useTurnComments(key: string): readonly TurnLineComment[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => readTurnComments(key)
  )
}

/** One message for the agent: a `path:line — comment` line per note, in the order they were made; a removed line is suffixed ` (removed)`. */
export function composeCommentsMessage(notes: readonly TurnLineComment[]): string {
  return notes
    .map(
      (note) =>
        `${note.path}:${note.line}${note.side === 'old' ? ' (removed)' : ''} — ${note.text.trim()}`
    )
    .join('\n')
}
