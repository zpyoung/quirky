export type LoopSummaryState = 'running' | 'needs-you' | 'paused'

export type LoopSummary = {
  id: string
  worktreeId: string
  state: LoopSummaryState
  pauseReason: string | null
  iterationsCompleted: number
  maxIterations: number | null
  updatedAt: number
}


function isBoundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
}

function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0
}
function isSummary(value: unknown): value is LoopSummary {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const summary = value as Partial<Record<keyof LoopSummary, unknown>>
  return isBoundedText(summary.id) && isBoundedText(summary.worktreeId) &&
    (summary.state === 'running' || summary.state === 'needs-you' || summary.state === 'paused') &&
    (summary.pauseReason === null || (typeof summary.pauseReason === 'string' && summary.pauseReason.length <= 1024)) &&
    isCount(summary.iterationsCompleted) && (summary.maxIterations === null || isCount(summary.maxIterations)) &&
    typeof summary.updatedAt === 'number' && Number.isFinite(summary.updatedAt) && summary.updatedAt >= 0
}

export function parseLoopSummaries(value: unknown): LoopSummary[] | null {
  if (!Array.isArray(value) || value.length > 2048 || !value.every(isSummary)) return null
  return value.map(({ id, worktreeId, state, pauseReason, iterationsCompleted, maxIterations, updatedAt }) => ({
    id, worktreeId, state, pauseReason, iterationsCompleted, maxIterations, updatedAt
  }))
}

const STATE_PRIORITY: Record<LoopSummaryState, number> = { 'needs-you': 0, running: 1, paused: 2 }

function outranks(candidate: LoopSummary, current: LoopSummary): boolean {
  const priority = STATE_PRIORITY[candidate.state] - STATE_PRIORITY[current.state]
  if (priority !== 0) return priority < 0
  if (candidate.updatedAt !== current.updatedAt) return candidate.updatedAt > current.updatedAt
  return candidate.id < current.id
}

export function selectLoopSummaries(summaries: readonly LoopSummary[]): Map<string, LoopSummary> {
  const selected = new Map<string, LoopSummary>()
  for (const summary of summaries) {
    const current = selected.get(summary.worktreeId)
    if (!current || outranks(summary, current)) selected.set(summary.worktreeId, summary)
  }
  return selected
}

function pauseReasonLabel(reason: string): string {
  switch (reason) {
    case 'cap-iterations': return 'iteration cap reached'
    case 'cap-time': return 'time cap reached'
    case 'cap-cost': return 'cost cap reached'
    default: return reason
  }
}

export function loopSummaryLabel(summary: LoopSummary, verifiable = true): string {
  const cap = summary.maxIterations === null ? '' : `/${summary.maxIterations}`
  const state = verifiable ? summary.state : 'unverifiable'
  const reason = verifiable && summary.state === 'paused' && summary.pauseReason
    ? `: ${pauseReasonLabel(summary.pauseReason)}`
    : ''
  return `Loop ${summary.iterationsCompleted}${cap} · ${state}${reason}`
}
