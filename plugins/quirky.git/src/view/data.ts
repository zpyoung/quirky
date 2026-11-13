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
 * The ID a selector states outright: `id:<value>` or a bare `wt_` and 12 lowercase hex digits.
 * Other selectors need daemon resolution and return null.
 */
export function worktreeIdOf(selector: string): string | null {
  const value = selector.trim()
  if (value.startsWith('id:')) return value.slice(3) || null
  return /^wt_[0-9a-f]{12}$/.test(value) ? value : null
}

/**
 * Runs `refresh` on `quirky.git/changed` for `worktree` and, when `intervalMs` is given, on a timer;
 * both stop with the component. Selectors that don't state an ID hear every git change.
 * The latest `refresh` is always the one called.
 */
export function useRefreshTriggers(
  context: UiPluginContext,
  refresh: () => void,
  intervalMs: number | null,
  worktree: string
): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => {
    const worktreeId = worktreeIdOf(worktree)
    const unsubscribe = context.subscribe((event) => {
      if (event.type === 'quirky.git/changed') latest.current()
    }, worktreeId === null ? undefined : { worktreeId })
    const timer = intervalMs === null ? null : setInterval(() => latest.current(), intervalMs)
    return () => {
      unsubscribe()
      if (timer !== null) clearInterval(timer)
    }
  }, [context, intervalMs, worktree])
}
