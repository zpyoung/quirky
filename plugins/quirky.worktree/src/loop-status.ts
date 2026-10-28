export type LoopState = 'running' | 'needs-you' | 'paused'
export type LoopPresentation = LoopState | 'detached' | 'unverifiable'
export type LoopAvailabilityStatus = 'loading' | 'available' | 'unavailable' | 'disabled'

export type LoopSummary = {
  id: string
  worktreeId: string
  state: LoopState
  pauseReason: string | null
  iterationsCompleted: number
  maxIterations: number | null
  updatedAt: number
}

/** One selected compact projection for a live loop in a catalog worktree. */
export type LoopProjection = LoopSummary & {
  presentation: LoopPresentation
  label: string
}

export type LoopReport = Pick<
  LoopProjection,
  'id' | 'state' | 'pauseReason' | 'presentation' | 'iterationsCompleted' | 'maxIterations' | 'label'
>

export type LoopStatusSnapshot = {
  status: LoopAvailabilityStatus
  error: string | null
  byWorktree: ReadonlyMap<string, LoopProjection>
}

const SUMMARY_KEYS = [
  'id',
  'worktreeId',
  'state',
  'pauseReason',
  'iterationsCompleted',
  'maxIterations',
  'updatedAt'
] as const

const PRESENTATION_PRIORITY: Record<LoopPresentation, number> = {
  'needs-you': 0,
  unverifiable: 1,
  running: 2,
  paused: 3,
  detached: 4
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function parseSummary(value: unknown): LoopSummary | null {
  if (!isRecord(value)) return null
  const keys = Object.keys(value)
  if (keys.length !== SUMMARY_KEYS.length || !SUMMARY_KEYS.every((key) => Object.hasOwn(value, key))) return null
  if (!isNonemptyString(value.id) || !isNonemptyString(value.worktreeId) ||
    (value.state !== 'running' && value.state !== 'needs-you' && value.state !== 'paused') ||
    (value.pauseReason !== null && typeof value.pauseReason !== 'string') ||
    !Number.isSafeInteger(value.iterationsCompleted) || (value.iterationsCompleted as number) < 0 ||
    (value.maxIterations !== null && (!Number.isSafeInteger(value.maxIterations) || (value.maxIterations as number) <= 0)) ||
    typeof value.updatedAt !== 'number' || !Number.isFinite(value.updatedAt)) return null

  return {
    id: value.id,
    worktreeId: value.worktreeId,
    state: value.state,
    pauseReason: value.pauseReason,
    iterationsCompleted: value.iterationsCompleted as number,
    maxIterations: value.maxIterations as number | null,
    updatedAt: value.updatedAt
  }
}

/** Validates only the loop plugin's compact public projection, never a loop snapshot. */
export function parseLoopSummaries(value: unknown): LoopSummary[] {
  if (!Array.isArray(value)) throw new Error('Loop summaries returned an invalid compact list.')
  const summaries: LoopSummary[] = []
  const ids = new Set<string>()
  for (const item of value) {
    const summary = parseSummary(item)
    if (!summary || ids.has(summary.id)) throw new Error('Loop summaries returned an invalid compact row.')
    ids.add(summary.id)
    summaries.push(summary)
  }
  return summaries
}

function parseHostedView(value: unknown): { loopId: string; matches: boolean } | null {
  if (!isRecord(value) || !isNonemptyString(value.id)) return null
  if (value.kind === undefined) return { loopId: '', matches: false }
  if (value.kind !== 'view' || !isNonemptyString(value.viewId) || !isNonemptyString(value.key) ||
    (value.input !== undefined && !isRecord(value.input)) ||
    (value.closeMethod !== undefined && typeof value.closeMethod !== 'string') ||
    (value.closeParams !== undefined && !isRecord(value.closeParams)) ||
    (value.closeContext !== undefined && typeof value.closeContext !== 'boolean')) return null

  const input = isRecord(value.input) ? value.input : null
  const closeParams = isRecord(value.closeParams) ? value.closeParams : null
  const loopId = input && typeof input.loopId === 'string' ? input.loopId : ''
  return {
    loopId,
    matches: value.viewId === 'view:quirky.loops/loop' &&
      value.key === loopId &&
      value.closeMethod === 'quirky.loops/viewCloseGuard' &&
      closeParams?.loopId === loopId &&
      value.closeContext === true
  }
}

/** Returns null for missing or malformed layout evidence, rather than treating it as detached. */
export function layoutHostedLoopIds(value: unknown, worktreeId: string): ReadonlySet<string> | null {
  if (!isRecord(value) || !isRecord(value.workspace) || value.workspace.id !== worktreeId || !('root' in value.workspace)) return null

  const visited = new Set<Record<string, unknown>>()
  const matches = new Set<string>()
  const visit = (node: unknown): boolean => {
    if (!isRecord(node) || visited.has(node) || !isNonemptyString(node.id)) return false
    visited.add(node)

    if (node.kind === 'split') {
      if (!('first' in node) || !('second' in node)) return false
      return visit(node.first) && visit(node.second)
    }

    if (node.kind !== 'group' || !Array.isArray(node.tabs)) return false
    for (const tab of node.tabs) {
      const parsed = parseHostedView(tab)
      if (!parsed) return false
      if (parsed.matches) matches.add(parsed.loopId)
    }
    return true
  }

  return visit(value.workspace.root) ? matches : null
}

function labelFor(summary: LoopSummary, presentation: LoopPresentation): string {
  const count = summary.maxIterations === null
    ? `Loop ${summary.iterationsCompleted}`
    : `Loop ${summary.iterationsCompleted}/${summary.maxIterations}`
  const state = presentation === 'paused' && summary.pauseReason
    ? `paused: ${summary.pauseReason}`
    : presentation
  return `${count} · ${state}`
}

function present(summary: LoopSummary, fresh: boolean, layouts: ReadonlyMap<string, ReadonlySet<string> | null>): LoopProjection {
  let presentation: LoopPresentation
  if (!fresh) {
    presentation = 'unverifiable'
  } else if (summary.state === 'needs-you') {
    presentation = 'needs-you'
  } else if (summary.state === 'paused' && summary.pauseReason === 'unverifiable') {
    presentation = 'unverifiable'
  } else {
    const hostedLoopIds = layouts.get(summary.worktreeId)
    if (hostedLoopIds === undefined || hostedLoopIds === null) presentation = 'unverifiable'
    else if (!hostedLoopIds.has(summary.id)) presentation = 'detached'
    else presentation = summary.state
  }
  return { ...summary, presentation, label: labelFor(summary, presentation) }
}

function outranks(candidate: LoopProjection, current: LoopProjection): boolean {
  const candidatePriority = PRESENTATION_PRIORITY[candidate.presentation]
  const currentPriority = PRESENTATION_PRIORITY[current.presentation]
  return candidatePriority < currentPriority ||
    (candidatePriority === currentPriority && (
      candidate.updatedAt > current.updatedAt ||
      (candidate.updatedAt === current.updatedAt && candidate.id.localeCompare(current.id) < 0)
    ))
}

/** Derives one deterministic row per catalog worktree from the latest compact evidence. */
export function selectLoopProjections(
  summaries: readonly LoopSummary[],
  layouts: ReadonlyMap<string, ReadonlySet<string> | null>,
  fresh: boolean,
  catalogIds: ReadonlySet<string>
): ReadonlyMap<string, LoopProjection> {
  const selected = new Map<string, LoopProjection>()
  for (const summary of summaries) {
    if (!catalogIds.has(summary.worktreeId)) continue
    const candidate = present(summary, fresh, layouts)
    const current = selected.get(summary.worktreeId)
    if (!current || outranks(candidate, current)) selected.set(summary.worktreeId, candidate)
  }
  return selected
}
