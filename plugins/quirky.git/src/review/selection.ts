/** Which surface moved the selection, so the other one follows without echoing it back. */
export type SelectionOrigin = 'panel' | 'review'

type Listener = (path: string | null, origin: SelectionOrigin) => void

const selected = new Map<string, string | null>()
const listeners = new Map<string, Set<Listener>>()

/** The path the panel and the Review tab currently share for `worktree`, or null. */
export function selectedPath(worktree: string): string | null {
  return selected.get(worktree) ?? null
}

/** Sets the shared selection and tells every listener for `worktree`, including repeats of the same path. */
export function selectPath(worktree: string, path: string | null, origin: SelectionOrigin): void {
  selected.set(worktree, path)
  for (const listener of [...(listeners.get(worktree) ?? [])]) listener(path, origin)
}

/** Listens for selection changes of `worktree`; the returned function stops it. */
export function onSelectedPath(worktree: string, listener: Listener): () => void {
  let set = listeners.get(worktree)
  if (!set) listeners.set(worktree, (set = new Set()))
  set.add(listener)
  return () => {
    set.delete(listener)
    if (set.size === 0 && listeners.get(worktree) === set) listeners.delete(worktree)
  }
}
