import type { PluginContext, Worktree } from '@quirky/protocol'
import type { ActivityFeed } from './activity'
import type { ActivityThread } from './activity-types'
import type { DashboardBucket, DashboardQuery, DashboardSnapshot } from './dashboard-types'

const WORKSPACE_STATUSES = ['todo', 'in-progress', 'in-review', 'done'] as const
const REVIEW_STATUSES = ['open', 'draft', 'merged', 'closed', 'no-review'] as const
const REVIEW_LOOKUP_CONCURRENCY = 6

type ReviewStatus = (typeof REVIEW_STATUSES)[number]
type ReviewLookup = { kind: 'found'; review?: { state?: unknown } } | { kind: 'no-review' } | { kind: 'unavailable'; reason?: string; message?: string }
type ReviewResult = { state: ReviewStatus | null; unavailable?: string }

function queryOf(value: unknown, context: PluginContext): DashboardQuery {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw context.error('invalid-params', 'dashboard query must be an object')
  }
  const source = value as Record<string, unknown>

  const query: DashboardQuery = {}
  for (const name of ['text', 'project'] as const) {
    const raw = source[name]
    if (raw === undefined) continue
    if (typeof raw !== 'string') throw context.error('invalid-params', `${name} must be a string`)
    const trimmed = raw.trim()
    if (trimmed) query[name] = trimmed
  }

  if (source.workspaceStatus !== undefined) {
    if (typeof source.workspaceStatus !== 'string' || !WORKSPACE_STATUSES.includes(source.workspaceStatus as (typeof WORKSPACE_STATUSES)[number])) {
      throw context.error('invalid-params', `workspaceStatus must be one of ${WORKSPACE_STATUSES.join(', ')}`)
    }
    query.workspaceStatus = source.workspaceStatus
  }
  if (source.reviewStatus !== undefined) {
    if (typeof source.reviewStatus !== 'string' || !REVIEW_STATUSES.includes(source.reviewStatus as ReviewStatus)) {
      throw context.error('invalid-params', `reviewStatus must be one of ${REVIEW_STATUSES.join(', ')}`)
    }
    query.reviewStatus = source.reviewStatus
  }
  if (source.showIdle !== undefined) {
    if (typeof source.showIdle !== 'boolean') throw context.error('invalid-params', 'showIdle must be a boolean')
    query.showIdle = source.showIdle
  }
  return query
}

function bucketOf(thread: ActivityThread): DashboardBucket {
  switch (thread.display) {
    case 'waiting':
    case 'blocked':
    case 'permission':
      return 'attention'
    case 'done':
    case 'failed':
    case 'interrupted':
      return 'done'
    case 'idle':
      return 'idle'
    default:
      return 'working'
  }
}

function reviewUnavailable(worktreeId: string, reason: string): ReviewResult {
  return { state: null, unavailable: `GitHub review status is unavailable for ${worktreeId}: ${reason}` }
}

function stateFromLookup(worktreeId: string, lookup: ReviewLookup): ReviewResult {
  if (lookup.kind === 'no-review') return { state: 'no-review' }
  if (lookup.kind === 'unavailable') return reviewUnavailable(worktreeId, lookup.message ?? lookup.reason ?? 'the provider did not return review state')
  const state = lookup.review?.state
  if (typeof state === 'string' && (REVIEW_STATUSES as readonly string[]).includes(state)) return { state: state as ReviewStatus }
  return reviewUnavailable(worktreeId, 'the provider returned no supported review state')
}

async function reviewFor(context: PluginContext, worktree: Worktree): Promise<ReviewResult> {
  if (worktree.kind === 'folder') return { state: 'no-review' }
  const params: Record<string, unknown> = { worktree: worktree.id }
  if (worktree.branch) params.branch = worktree.branch
  if (worktree.head) params.headOid = worktree.head
  if (worktree.linkedPR) {
    params.number = worktree.linkedPR.number
    params.prRepo = worktree.linkedPR.repository
  }
  try {
    const lookup = (await context.call('quirky.hosting/forBranch', params)) as ReviewLookup
    return stateFromLookup(worktree.id, lookup)
  } catch (error) {
    return reviewUnavailable(worktree.id, error instanceof Error ? error.message : String(error))
  }
}

async function reviewStates(context: PluginContext, worktrees: Worktree[], candidates: Set<string>): Promise<Map<string, ReviewResult>> {
  const available = worktrees.filter((worktree) => candidates.has(worktree.id))
  const results = new Map<string, ReviewResult>()
  let next = 0
  const workers = Array.from({ length: Math.min(REVIEW_LOOKUP_CONCURRENCY, available.length) }, async () => {
    for (;;) {
      const index = next++
      const worktree = available[index]
      if (!worktree) return
      results.set(worktree.id, await reviewFor(context, worktree))
    }
  })
  await Promise.all(workers)
  return results
}

/** Dashboard groups and filters the retained Activity projection; it owns no status or receipt state. */
export class DashboardService {
  constructor(
    private readonly context: PluginContext,
    private readonly activity: Pick<ActivityFeed, 'query'>
  ) {}

  async query(params: unknown): Promise<DashboardSnapshot> {
    const query = queryOf(params, this.context)
    const { threads } = await this.activity.query(query.text ? { text: query.text } : {})
    const needsWorktrees = query.project !== undefined || query.workspaceStatus !== undefined || query.reviewStatus !== undefined
    const worktrees = needsWorktrees
      ? ((await this.context.call('quirky.worktree/list', query.project === undefined ? {} : { repo: query.project })) as Worktree[])
      : []
    const byWorktree = new Map(worktrees.map((worktree) => [worktree.id, worktree]))
    const unavailable = new Set<string>()
    const projected = threads.filter((thread) => {
      if (!needsWorktrees) return true
      const worktree = byWorktree.get(thread.worktreeId)
      if (!worktree) {
        if (query.project === undefined && query.reviewStatus !== undefined) {
          unavailable.add(`GitHub review status is unavailable for ${thread.worktreeId}: workspace metadata is unavailable`)
        } else if (query.project === undefined && query.workspaceStatus !== undefined) {
          unavailable.add(`Workspace status is unavailable for ${thread.worktreeId}: workspace metadata is unavailable`)
        }
        return false
      }
      return query.workspaceStatus === undefined || worktree.status === query.workspaceStatus
    })

    const reviews = query.reviewStatus === undefined
      ? new Map<string, ReviewResult>()
      : await reviewStates(this.context, worktrees, new Set(projected.map((thread) => thread.worktreeId)))
    const cards: DashboardSnapshot['cards'] = []
    let total = 0
    let hiddenIdle = 0
    for (const thread of projected) {
      if (query.reviewStatus !== undefined) {
        const review = reviews.get(thread.worktreeId)
        if (!review) {
          unavailable.add(`GitHub review status is unavailable for ${thread.worktreeId}: workspace metadata is unavailable`)
          continue
        }
        if (review.unavailable) {
          unavailable.add(review.unavailable)
          continue
        }
        if (review.state !== query.reviewStatus) continue
      }

      total++
      const bucket = bucketOf(thread)
      if (bucket === 'idle' && query.showIdle !== true) {
        hiddenIdle++
        continue
      }
      cards.push({ thread, bucket })
    }
    return { cards, total, hiddenIdle, unavailable: [...unavailable] }
  }
}
