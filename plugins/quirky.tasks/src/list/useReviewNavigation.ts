import { useCallback } from 'react'
import type { ItemTarget, TasksSurfaceProps } from '../contracts'
import { openReview } from '../review-navigation'

type ReviewTab = 'conversation' | 'checks' | 'files'
type ErrorReporter = (message: string) => void

function object(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Opens the separate public Reviews view; missing contribution is reported, never treated as success. */
export function useReviewNavigation(
  context: TasksSurfaceProps['context'],
  reportError: ErrorReporter
): (target: ItemTarget, tab?: ReviewTab) => Promise<boolean> {
  return useCallback(async (target: ItemTarget, tab: ReviewTab = 'conversation'): Promise<boolean> => {
    try {
      await openReview(context, { ...target, tab })
      return true
    } catch (error) {
      const code = object(error)?.code
      reportError(code === -32601
        ? 'Pull-request detail is unavailable. Open this pull request on GitHub instead.'
        : messageOf(error))
      return false
    }
  }, [context, reportError])
}
