import { checkSummary, optionalLogins, relativeTime, type CheckResult, type ListItem, type MergeMetadata } from './model'

/** A linked worktree's agent state, from the agent-status dashboard; only buckets that need a dot. */
export type AgentActivity = { bucket: 'attention' | 'working'; agent: string; label: string }

export type RowStatus = 'needs-you' | 'failing' | 'working' | 'done' | 'idle'

export type RowStatusInputs = {
  viewer: string | null
  checks?: CheckResult
  merge?: MergeMetadata
  activity?: AgentActivity
}

/**
 * Resolves the one dot and detail text a compact task row shows; the first matching rule wins.
 * Rules that depend on who is looking never match when `viewer` is null, and a row whose
 * checks and merge metadata haven't arrived falls through to `idle` with its age.
 */
export function rowStatus(item: ListItem, { viewer, checks, merge, activity }: RowStatusInputs): { status: RowStatus; detail: string } {
  const requestedReviewers = optionalLogins(merge?.review.requestedReviewers) ?? []
  const isOwn = viewer !== null && item.author === viewer
  const reviewDecision = typeof item.reviewDecision === 'string'
    ? item.reviewDecision
    : typeof merge?.review.reviewDecision === 'string' ? merge.review.reviewDecision : undefined
  const agentDetail = activity ? `${activity.agent} · ${activity.label}` : ''

  if (activity?.bucket === 'attention') return { status: 'needs-you', detail: agentDetail }
  if (viewer !== null && requestedReviewers.includes(viewer)) return { status: 'needs-you', detail: 'review requested' }
  if (isOwn && reviewDecision === 'CHANGES_REQUESTED') return { status: 'needs-you', detail: 'changes requested' }

  if (isOwn) {
    const summary = checkSummary(checks, false)
    if (summary.tone === 'danger') {
      const count = Number.parseInt(summary.label, 10)
      return { status: 'failing', detail: `${count} ${count === 1 ? 'check' : 'checks'} failing` }
    }
  }

  if (activity?.bucket === 'working') return { status: 'working', detail: agentDetail }

  const age = relativeTime(item.updatedAt).label
  if (item.state === 'merged' || item.state === 'closed') return { status: 'done', detail: `${item.state} ${age}` }

  const first = requestedReviewers[0]
  return { status: 'idle', detail: first ? `waiting on ${first}` : age }
}

/**
 * The compact row's second line. Agent activity already names the agent, so the repository is
 * left out there; every other row names the repository between the number and the detail.
 */
export function rowDescription(item: ListItem, { status, detail }: { status: RowStatus; detail: string }): string {
  const fixedReviewDetail = detail === 'review requested' || detail === 'changes requested'
  const isAgentActivity = status === 'working' || (status === 'needs-you' && !fixedReviewDetail)
  return isAgentActivity ? `#${item.number} · ${detail}` : `#${item.number} · ${item.repoName} · ${detail}`
}
