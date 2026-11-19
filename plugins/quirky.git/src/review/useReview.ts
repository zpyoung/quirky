import { useCallback, useEffect, useRef, useState } from 'react'
import { RpcErrorCode, type GitStatus, type ReviewModel, type UiPluginContext } from '@quirky/protocol'
import { dataOf, messageOf } from '../panel/format'

export const REVIEW_POLL_MS = 3000

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

/**
 * The worktree's review model. Reads `quirky.git/review` on mount, every 3 seconds, and on this
 * worktree's `changed` and `reviewChanged` events. One read owns publication for a snapshot, so a
 * slow response still lands; notifications during it retain one follow-up read.
 * An unchanged result keeps the previous object, a failure keeps the last good model, and a
 * response that lands after a worktree switch or unmount is dropped.
 * With a status snapshot, `pending` withholds reports until its read settles, even on failure.
 */
export function useReview(context: UiPluginContext, worktree: string, snapshot: GitStatus | null | undefined): { model: ReviewModel | null; error: string | null; pending: boolean; refresh(): void } {
  const [loaded, setLoaded] = useState<{ model: ReviewModel | null; snapshot: GitStatus | null | undefined } | null>(null)
  const model = loaded?.model ?? null
  const [error, setError] = useState<string | null>(null)
  const currentSnapshot = useRef(snapshot)
  currentSnapshot.current = snapshot
  const generation = useRef(0)
  const inFlight = useRef(false)
  const queued = useRef(false)

  const refresh = useCallback(() => {
    if (inFlight.current) {
      queued.current = true
      return
    }
    inFlight.current = true
    const mine = generation.current
    const requestedSnapshot = currentSnapshot.current
    const settle = (apply: () => void) => {
      if (mine !== generation.current) return
      inFlight.current = false
      apply()
      if (queued.current) {
        queued.current = false
        refresh()
      }
    }
    context.call('quirky.git/review', { worktree }).then(
      (next) =>
        settle(() => {
          setLoaded((prev) => {
            const model = prev && same(prev.model, next) ? prev.model : next as ReviewModel
            return prev !== null && prev.model === model && prev.snapshot === requestedSnapshot ? prev : { model, snapshot: requestedSnapshot }
          })
          setError(null)
        }),
      (e: unknown) => settle(() => {
        setLoaded((prev) => ({ model: prev?.model ?? null, snapshot: requestedSnapshot }))
        setError(messageOf(e))
      })
    )
  }, [context, worktree])

  useEffect(() => {
    generation.current++
    inFlight.current = false
    queued.current = false
    setLoaded(null)
    setError(null)
    refresh()
    const timer = setInterval(refresh, REVIEW_POLL_MS)
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.git/changed' && event.type !== 'quirky.git/reviewChanged') return
      const id = (event.data as { worktreeId?: unknown } | undefined)?.worktreeId
      if (typeof id !== 'string' || id === worktree) refresh()
    })
    return () => {
      generation.current++
      clearInterval(timer)
      unsubscribe()
    }
  }, [context, worktree, refresh])

  useEffect(() => {
    if (snapshot === undefined || snapshot === null) return
    generation.current++
    inFlight.current = false
    queued.current = false
    refresh()
  }, [snapshot, refresh])

  return { model, error, pending: snapshot !== undefined && (snapshot === null || loaded?.snapshot !== snapshot), refresh }
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
