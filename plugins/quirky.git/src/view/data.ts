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

export type DiffRequest = { path: string; source: GitDiffSource; oldPath?: string; commit?: string }

/** One file's diff from the daemon. Rejects with git's message when the sides cannot be read. */
export async function fetchDiff(context: UiPluginContext, worktree: string, request: DiffRequest): Promise<GitDiff> {
  const { path, source, oldPath, commit } = request
  return (await context.call('quirky.git/diff', {
    worktree,
    path,
    source,
    ...(oldPath ? { oldPath } : {}),
    ...(commit ? { commit } : {})
  })) as GitDiff
}

/** Whether a diff of this shape can take edits: an unstaged, readable text file that is still on disk. */
export function isEditable(source: GitDiffSource, diff: GitDiff): boolean {
  return (
    source === 'unstaged' &&
    diff.kind === 'text' &&
    !diff.binary &&
    diff.tooLarge === undefined &&
    diff.modifiedDeleted !== true
  )
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
