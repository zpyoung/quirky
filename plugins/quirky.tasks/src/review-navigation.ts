export type ReviewTarget = { worktree: string; number: number; tab?: 'conversation' | 'checks' | 'files' }

/** Public cross-plugin navigation; the reviews owner captures and restores the prior Tasks view. */
export async function openReview(context: { call(method: string, params?: Record<string, unknown>): Promise<unknown> }, target: ReviewTarget): Promise<unknown> {
  if (typeof target.worktree !== 'string' || target.worktree.length === 0 || !Number.isSafeInteger(target.number) || target.number < 1) throw new Error('A registered workspace and positive pull request number are required')
  if (target.tab !== undefined && !['conversation', 'checks', 'files'].includes(target.tab)) throw new Error('Unknown pull request tab')
  return context.call('quirky.reviews/open', { worktree: target.worktree, number: target.number, ...(target.tab ? { tab: target.tab } : {}) })
}
