export type KeyValueStorage = {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem?(key: string): void
}

export type StoredSelection = { worktreeId: string | null; sessionId: string | null }

const WORKTREE_KEY = 'quirky.selectedWorktree'
const SESSION_KEY = 'quirky.selectedSession'

/** `localStorage` when the browser allows it; null in private windows or with blocked site data. */
export function browserStorage(): KeyValueStorage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

/** Reads the last selection; never throws, so unavailable storage just restores nothing. */
export function readSelection(storage: KeyValueStorage | null): StoredSelection {
  const read = (key: string): string | null => {
    try {
      return storage?.getItem(key) || null
    } catch {
      return null
    }
  }
  return { worktreeId: read(WORKTREE_KEY), sessionId: read(SESSION_KEY) }
}

/** Persists the selection; a null id clears its key. Failures are swallowed. */
export function writeSelection(storage: KeyValueStorage | null, selection: StoredSelection): void {
  const write = (key: string, value: string | null) => {
    try {
      if (value === null) storage?.removeItem?.(key)
      else storage?.setItem(key, value)
    } catch {
      // storage is a convenience only
    }
  }
  write(WORKTREE_KEY, selection.worktreeId)
  write(SESSION_KEY, selection.sessionId)
}
