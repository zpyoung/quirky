import { useSyncExternalStore } from 'react'

export type ExplorerSearchIntent = { id: number; worktree: string; query: string }
let nextId = 0
let intent: ExplorerSearchIntent | null = null
const listeners = new Set<() => void>()

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function notify(): void {
  for (const listener of listeners) listener()
}

export function openExplorerSearch(worktree: string, query: string): void {
  intent = { id: ++nextId, worktree, query }
  notify()
}

export function clearExplorerSearch(id?: number): void {
  if (id !== undefined && intent?.id !== id) return
  intent = null
  notify()
}

export function useExplorerSearchIntent(): ExplorerSearchIntent | null {
  return useSyncExternalStore(subscribe, () => intent, () => null)
}
