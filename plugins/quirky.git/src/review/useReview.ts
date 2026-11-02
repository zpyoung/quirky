import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcErrorCode, type ReviewModel, type UiPluginContext } from '@quirky/protocol'
import { dataOf, messageOf } from '../panel/format'

export const REVIEW_POLL_MS = 3000

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The worktree's review model. Reads `quirky.git/review` on mount, every 3 seconds, and on this
 * worktree's `changed` and `reviewChanged` events. An unchanged result keeps the previous object,
 * a failure keeps the last good model, and a response that lands after a worktree switch is dropped.
 */
export function useReview(context: UiPluginContext, worktree: string): { model: ReviewModel | null; error: string | null; refresh(): void } {
  const [model, setModel] = useState<ReviewModel | null>(null)
  const [error, setError] = useState<string | null>(null)
  const newest = useRef(0)
  const alive = useRef(true)

  const refresh = useCallback(() => {
    const ticket = ++newest.current
    context.call('quirky.git/review', { worktree }).then(
      (next) => {
        if (!alive.current || ticket !== newest.current) return
        setModel((prev) => (same(prev, next) ? prev : (next as ReviewModel)))
        setError(null)
      },
      (e: unknown) => {
        if (alive.current && ticket === newest.current) setError(messageOf(e))
      }
    )
  }, [context, worktree])

  useEffect(() => {
    alive.current = true
    setModel(null)
    setError(null)
    refresh()
    const timer = setInterval(refresh, REVIEW_POLL_MS)
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.git/changed' && event.type !== 'quirky.git/reviewChanged') return
      const id = (event.data as { worktreeId?: unknown } | undefined)?.worktreeId
      if (typeof id !== 'string' || id === worktree) refresh()
    })
    return () => {
      alive.current = false
      newest.current++
      clearInterval(timer)
      unsubscribe()
    }
  }, [context, worktree, refresh])

  return { model, error, refresh }
}

/**
 * Marks `path` reviewed or clears the mark. With `expected` (the content hash the user was looking
 * at) a file that changed meanwhile is not marked and the result is `'conflict'`; any other failure,
 * including a conflict for another reason, throws.
 */
export async function setReviewMark(
  context: UiPluginContext,
  params: { worktree: string; path: string; reviewed: boolean; expected?: string | null }
): Promise<'ok' | 'conflict'> {
  try {
    await context.call('quirky.git/setReviewMark', params)
    return 'ok'
  } catch (e) {
    const isConflict = (e as { code?: unknown } | null)?.code === RpcErrorCode.Conflict
    if (isConflict && dataOf(e).reason === 'changed-on-disk') return 'conflict'
    throw e
  }
}
