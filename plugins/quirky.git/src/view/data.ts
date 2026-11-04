import { useEffect, useRef } from 'react'
import type { GitDiff, GitDiffSource, UiPluginContext } from '@quirky/protocol'

export const POLL_MS = 3000

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The plugin error's `data.reason`, when it has one. */
export function reasonOf(error: unknown): string | undefined {
  const reason = (error as { data?: { reason?: unknown } } | null)?.data?.reason
  return typeof reason === 'string' ? reason : undefined
}

export type DiffRequest = { path: string; source: GitDiffSource; oldPath?: string; commit?: string; against?: 'base' | 'reviewed' }

/** One file's diff from the daemon. Rejects with git's message when the sides cannot be read. */
export async function fetchDiff(context: UiPluginContext, worktree: string, request: DiffRequest): Promise<GitDiff> {
  const { path, source, oldPath, commit, against } = request
  return (await context.call('quirky.git/diff', {
    worktree,
    path,
    source,
    ...(oldPath ? { oldPath } : {}),
    ...(commit ? { commit } : {}),
    ...(against ? { against } : {})
  })) as GitDiff
}

/** Whether a diff shows text a reader can read (not binary, image or past the display limits). */
export function isTextDiff(diff: GitDiff): boolean {
  return diff.kind === 'text' && !diff.binary && diff.tooLarge === undefined
}

/**
 * Whether a Review card can take edits: its diff is text and its modified side is a file on disk
 * with a known hash. A commit scope shows a commit's content, which is not the disk.
 */
export function isEditableCard(scoped: boolean, diff: GitDiff): boolean {
  return !scoped && isTextDiff(diff) && diff.modifiedDeleted !== true && typeof diff.modifiedHash === 'string'
}

/**
 * Runs `refresh` on every `quirky.git/changed` event and, when `intervalMs` is given, on a timer;
 * both stop with the component. The latest `refresh` is always the one called.
 */
export function useRefreshTriggers(context: UiPluginContext, refresh: () => void, intervalMs: number | null): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/changed') latest.current()
    })
    const timer = intervalMs === null ? null : setInterval(() => latest.current(), intervalMs)
    return () => {
      unsubscribe()
      if (timer !== null) clearInterval(timer)
    }
  }, [context, intervalMs])
}
