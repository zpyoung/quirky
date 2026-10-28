import { RpcErrorCode, type PluginContext, type Worktree } from '@quirky/protocol'
import type { Preferences } from './state'
import { isPlainRecord } from './state'

type ReviewState = 'open' | 'draft' | 'closed' | 'merged'
type ChecksStatus = 'neutral' | 'pending' | 'success' | 'failure'
export type ReviewReason = 'completed' | 'passing' | 'unknown'

type CachedReview = {
  state: ReviewState
  checksStatus: ChecksStatus
  headRefOid: string
  number: number
  url: string
}

type CachedWorkspaceReview = {
  worktreeId: string
  instanceId: string
  branch: string | null
  headOid: string | null
  review: CachedReview | null
  stale: boolean
  error?: string
}

export type ReviewDecision = {
  hidden: boolean
  reason?: ReviewReason
  error?: string
}

const reviewStates: readonly ReviewState[] = ['open', 'draft', 'closed', 'merged']
const checksStatuses: readonly ChecksStatus[] = ['neutral', 'pending', 'success', 'failure']

function parseReview(value: unknown): CachedReview | null | undefined {
  if (value === null) return null
  if (
    !isPlainRecord(value) ||
    typeof value.state !== 'string' || !reviewStates.includes(value.state as ReviewState) ||
    typeof value.checksStatus !== 'string' || !checksStatuses.includes(value.checksStatus as ChecksStatus) ||
    typeof value.headRefOid !== 'string' || value.headRefOid.length === 0 ||
    typeof value.number !== 'number' || !Number.isSafeInteger(value.number) || value.number <= 0 ||
    typeof value.url !== 'string' || value.url.length === 0
  ) return undefined
  return {
    state: value.state as ReviewState,
    checksStatus: value.checksStatus as ChecksStatus,
    headRefOid: value.headRefOid,
    number: value.number,
    url: value.url
  }
}

function parseWorkspaceReview(value: unknown): CachedWorkspaceReview | undefined {
  if (
    !isPlainRecord(value) ||
    typeof value.worktreeId !== 'string' || value.worktreeId.length === 0 ||
    typeof value.instanceId !== 'string' || value.instanceId.length === 0 ||
    !(value.branch === null || (typeof value.branch === 'string' && value.branch.length > 0)) ||
    !(value.headOid === null || (typeof value.headOid === 'string' && value.headOid.length > 0)) ||
    typeof value.stale !== 'boolean' ||
    (value.error !== undefined && typeof value.error !== 'string')
  ) return undefined
  const review = parseReview(value.review)
  if (review === undefined) return undefined
  return {
    worktreeId: value.worktreeId,
    instanceId: value.instanceId,
    branch: value.branch,
    headOid: value.headOid,
    review,
    stale: value.stale,
    ...(typeof value.error === 'string' ? { error: value.error } : {})
  }
}

function unknownFor(worktrees: Worktree[], error?: string): Map<string, ReviewDecision> {
  const results = new Map<string, ReviewDecision>()
  for (const worktree of worktrees) {
    results.set(worktree.id, { hidden: false, reason: 'unknown', ...(error === undefined ? {} : { error }) })
  }
  return results
}

/** Reads only hosting's normalized review cache; filtering never triggers a provider lookup. */
export async function readReviewDecisions(
  context: PluginContext,
  worktrees: Worktree[],
  preferences: Preferences
): Promise<Map<string, ReviewDecision> | undefined> {
  const hideCompleted = preferences.hideCompletedReviewWorkspaces
  const hidePassing = preferences.hidePassingCheckWorkspaces
  if (!hideCompleted && !hidePassing) return undefined

  const decisions = unknownFor(worktrees)
  const gitWorktrees = worktrees.filter((worktree) => worktree.kind === 'git')
  if (gitWorktrees.length === 0) return decisions
  const requestedIds = new Set(gitWorktrees.map((worktree) => worktree.id))
  const selectors = gitWorktrees.map((worktree) => worktree.id)
  const returned = new Map<string, unknown>()
  const malformed = new Set<string>()

  for (let offset = 0; offset < selectors.length; offset += 1000) {
    let result: unknown
    try {
      result = await context.call('quirky.hosting/cachedReviews', {
        worktrees: selectors.slice(offset, offset + 1000)
      })
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound) return decisions
      return unknownFor(worktrees, error instanceof Error ? error.message : String(error))
    }
    if (!isPlainRecord(result) || !Array.isArray(result.workspaces)) {
      return unknownFor(worktrees, 'quirky.hosting/cachedReviews returned an invalid response')
    }

    for (const row of result.workspaces) {
      if (!isPlainRecord(row) || typeof row.worktreeId !== 'string' || row.worktreeId.length === 0) {
        return unknownFor(worktrees, 'quirky.hosting/cachedReviews returned an invalid workspace entry')
      }
      if (!requestedIds.has(row.worktreeId)) continue
      if (returned.has(row.worktreeId) || malformed.has(row.worktreeId)) {
        returned.delete(row.worktreeId)
        malformed.add(row.worktreeId)
      } else {
        returned.set(row.worktreeId, row)
      }
    }
  }

  for (const worktree of gitWorktrees) {
    if (malformed.has(worktree.id)) {
      decisions.set(worktree.id, {
        hidden: false,
        reason: 'unknown',
        error: 'quirky.hosting/cachedReviews returned duplicate workspace data'
      })
      continue
    }

    const raw = returned.get(worktree.id)
    if (raw === undefined) continue
    const cached = parseWorkspaceReview(raw)
    if (cached === undefined) {
      decisions.set(worktree.id, {
        hidden: false,
        reason: 'unknown',
        error: 'quirky.hosting/cachedReviews returned malformed workspace data'
      })
      continue
    }
    if (cached.error !== undefined) {
      decisions.set(worktree.id, { hidden: false, reason: 'unknown', error: cached.error })
      continue
    }
    // Hosting owns local-head freshness and may resolve merged reviews through ancestry.
    if (
      cached.worktreeId !== worktree.id ||
      cached.instanceId !== worktree.instanceId ||
      cached.branch !== worktree.branch ||
      cached.stale ||
      cached.review === null ||
      cached.headOid === null ||
      cached.headOid.length === 0
    ) continue

    if (hideCompleted && (cached.review.state === 'merged' || cached.review.state === 'closed')) {
      decisions.set(worktree.id, { hidden: true, reason: 'completed' })
    } else if (hidePassing && cached.review.checksStatus === 'success') {
      decisions.set(worktree.id, { hidden: true, reason: 'passing' })
    } else {
      decisions.set(worktree.id, { hidden: false })
    }
  }

  return decisions
}
