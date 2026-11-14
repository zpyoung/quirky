export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export type SitterCapabilityKey = 'updateBranch' | 'resolveConflicts' | 'fixChecks' | 'merge'
export type SitterCapabilityMode = 'off' | 'gated' | 'on'
export type SitterCapabilities = Record<SitterCapabilityKey, SitterCapabilityMode>
export type SitterBranchUpdateMode = 'merge-base-update' | 'rebase'
export type SitterMergeMethod = 'merge' | 'squash' | 'rebase' | null
export type SitterMergeCheckScope = 'all' | 'required'

export type SitterApprovalScope = {
  actionKind: string
  contentIdentity: string
  evidenceKey: string
  preparedCommitSha?: string
}

export type SitterOpenEscalation = {
  escalationId: string
  escalationKind: string
  status: string
  foldCount: number
  reason?: string
  detail?: string
  approvalScope?: SitterApprovalScope
}

export type SitterFleetRow = {
  target: { watcherId: string; connectionId?: string | null; pairingRevision?: number | null }
  ownerFence: { executionHostId: string; schedulerOwner: string; workspaceKey: string; revision: number }
  enrollment: {
    watcherId: string
    kind: string
    enabled: boolean
    paused: boolean
    commandRevision: number
    worktreeId?: string | null
    capabilities: Record<string, SitterCapabilityMode>
    budget: { wallClockActiveMs: number | null; turns: number | null }
    kindPayload: Record<string, unknown>
    createdAtMs: number
    terminalAtMs: number | null
    parkReason: string | null
    haltReason: string | null
    malformed?: string
  }
  status: {
    state: 'watching' | 'acting' | 'held' | 'escalated' | 'parked' | 'terminal' | 'disabled' | 'unreachable' | 'malformed'
    reason?: string
    detail?: string
    nextPulseAtMs: number | null
    consecutiveErrors: number
    consecutiveGateHolds: number
  }
  name: string
  workspaceName: string
  branch: string | null
  phase: string | null
  ownerContact: 'live' | 'unverifiable'
  observedAtMs: number
  lastSuccessfulTickAtMs: number | null
  budget: { activeMs: number; turns: number; exhausted: 'budget-wall-clock' | 'budget-turns' | null }
  openEscalations: SitterOpenEscalation[]
  pendingQuestion: boolean
}

export type SitterDetail = {
  target: SitterFleetRow['target']
  ownerFence: SitterFleetRow['ownerFence']
  enrollment: SitterFleetRow['enrollment']
  status: SitterFleetRow['status'] | null
  budget: SitterFleetRow['budget']
  ownerContact: 'live' | 'unverifiable'
  observedAtMs: number
  readOnly?: boolean
  openEscalations: SitterOpenEscalation[]
  pendingControls: string[]
  journal: Array<{
    seq: number
    eventId: string
    atMs: number
    class: 'fact' | 'observation'
    origin: 'owner' | 'client'
    kind: string
    resolved: boolean
    [key: string]: unknown
  }>
}

export type ChecksSitterState = {
  available: boolean
  sitter: SitterFleetRow | null
  detail: SitterDetail | null
  activeCount: number
  otherActiveCount: number
}

export function findWorktreeSitter(rows: readonly SitterFleetRow[], worktreeId: string): SitterFleetRow | null {
  return rows.find((row) => row.enrollment.kind === 'hosted-review' && row.enrollment.worktreeId === worktreeId) ?? null
}

export function isActiveSitter(row: SitterFleetRow): boolean {
  return row.enrollment.kind === 'hosted-review' &&
    row.enrollment.terminalAtMs === null &&
    row.enrollment.enabled &&
    !row.enrollment.paused &&
    row.status.state !== 'parked' &&
    row.status.state !== 'terminal' &&
    row.status.state !== 'disabled'
}

export function isDisarmableSitter(row: SitterFleetRow): boolean {
  return row.enrollment.kind === 'hosted-review' &&
    row.enrollment.terminalAtMs === null &&
    row.status.state !== 'terminal' &&
    (row.enrollment.enabled || row.enrollment.paused || row.enrollment.parkReason !== null)
}

function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export function sitterStatusPresentation(
  row: Pick<SitterFleetRow, 'status' | 'ownerContact' | 'observedAtMs'>,
  now = Date.now()
): { label: string; tone: 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'; dot: 'working' | 'needs-you' | 'failing' | 'done' | 'idle'; reason?: string; detail?: string } {
  let label: string
  let tone: 'neutral' | 'accent' | 'working' | 'needs-you' | 'failing'
  let dot: 'working' | 'needs-you' | 'failing' | 'done' | 'idle'
  if (row.ownerContact === 'unverifiable') {
    label = `Host unreachable · last confirmed ${ageLabel(now - row.observedAtMs)}`
    tone = 'failing'
    dot = 'failing'
  } else if (row.status.state === 'held' && (row.status.reason === 'tick-error' || row.status.consecutiveErrors > 0)) {
    label = 'Error · retrying'
    tone = 'failing'
    dot = 'failing'
  } else {
    switch (row.status.state) {
      case 'watching':
        label = 'Watching'
        tone = 'working'
        dot = 'working'
        break
      case 'held':
        label = 'Held'
        tone = 'needs-you'
        dot = 'needs-you'
        break
      case 'acting':
        label = 'Acting'
        tone = 'working'
        dot = 'working'
        break
      case 'escalated':
        label = 'Escalated'
        tone = 'needs-you'
        dot = 'needs-you'
        break
      case 'parked':
        label = 'Parked'
        tone = 'needs-you'
        dot = 'needs-you'
        break
      case 'terminal':
        label = 'Complete'
        tone = 'accent'
        dot = 'done'
        break
      case 'disabled':
        label = 'Stopped'
        tone = 'neutral'
        dot = 'idle'
        break
      case 'unreachable':
        label = 'Host unreachable'
        tone = 'failing'
        dot = 'failing'
        break
      case 'malformed':
        label = 'Malformed'
        tone = 'failing'
        dot = 'failing'
        break
    }
  }
  return {
    label,
    tone,
    dot,
    ...(row.status.reason ? { reason: row.status.reason } : {}),
    ...(row.status.detail ? { detail: row.status.detail } : {})
  }
}

function humanize(value: string): string {
  const words = value.replace(/[-_]+/g, ' ').trim()
  return words.length === 0 ? 'Activity' : `${words[0]!.toLocaleUpperCase()}${words.slice(1)}`
}

export function sitterActionLabel(actionKind: string): string {
  switch (actionKind) {
    case 'merge': return 'Merge review'
    case 'update-branch': return 'Update branch'
    case 'rerun-checks':
    case 'rerun-check': return 'Rerun failed checks'
    case 'prepare-check-fix':
    case 'prepare-fix-checks': return 'Prepare check fix'
    case 'publish-check-fix':
    case 'publish-fix-checks': return 'Publish check fix'
    case 'prepare-conflict-resolution':
    case 'prepare-resolve-conflicts': return 'Prepare conflict resolution'
    case 'publish-conflict-resolution':
    case 'publish-resolve-conflicts': return 'Publish conflict resolution'
    default: return humanize(actionKind)
  }
}

function sentence(value: string): string {
  const text = value.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (text.length === 0) return text
  return /[.!?]$/.test(text) ? text : `${text}.`
}

export function sitterReasonText(row: Pick<SitterFleetRow, 'status' | 'enrollment'>): string | null {
  if (row.status.detail) return sentence(row.status.detail)
  const reason = row.status.reason ?? row.enrollment.parkReason ?? row.enrollment.haltReason
  if (!reason) return null
  const state = row.status.state === 'parked' ? 'parked' : row.status.state === 'disabled' ? 'stopped' : 'held'
  return `The watcher is ${state}: ${humanize(reason)}.`
}

function duration(milliseconds: number): string {
  const minutes = Math.max(0, Math.floor(milliseconds / 60_000))
  if (minutes < 1) return '<1m'
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours === 0) return `${remainingMinutes}m`
  if (hours < 24) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return remainingHours ? `${days}d ${remainingHours}h` : `${days}d`
}

export function formatRemainingBudget(
  budget: SitterFleetRow['budget'],
  policy: SitterFleetRow['enrollment']['budget']
): string {
  return policy.wallClockActiveMs === null
    ? 'Unlimited'
    : duration(Math.max(0, policy.wallClockActiveMs - budget.activeMs))
}

function entrySummary(entry: SitterDetail['journal'][number]): string {
  const action = isRecord(entry.action) && typeof entry.action.kind === 'string' ? entry.action.kind : null
  switch (entry.kind) {
    case 'attempt': return `${sitterActionLabel(action ?? 'action')} started`
    case 'attempt-resolved': return `${sitterActionLabel(action ?? 'action')} finished`
    case 'escalation': return 'Approval requested'
    case 'approval': return 'Action approved'
    case 'terminal': return 'Review completed'
    case 'interval-open': return 'Active work started'
    case 'interval-close': return 'Active work ended'
    case 'interval-checkpoint': return 'Active work recorded'
    case 'turn': return 'Worker turn completed'
    case 'evidence': return 'Review evidence recorded'
    case 'gate-held': return 'Action held for approval'
    default: return humanize(entry.kind)
  }
}

export function formatLedgerEntry(entry: SitterDetail['journal'][number]): { title: string; timestamp: string } {
  return {
    title: entrySummary(entry).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim(),
    timestamp: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(entry.atMs)
  }
}

export function sameApprovalScope(left: SitterApprovalScope, right: SitterApprovalScope): boolean {
  return left.actionKind === right.actionKind &&
    left.contentIdentity === right.contentIdentity &&
    left.evidenceKey === right.evidenceKey &&
    left.preparedCommitSha === right.preparedCommitSha
}

let pendingOpenSitter: { worktree: string | null } | null = null
const openSitterListeners = new Set<(worktree: string | null) => void>()

export function requestOpenSitter(worktree: string | null): void {
  pendingOpenSitter = { worktree }
  for (const listener of openSitterListeners) listener(worktree)
}

export function consumePendingSitterOpen(worktree: string | null): boolean {
  if (pendingOpenSitter === null || pendingOpenSitter.worktree !== worktree) return false
  pendingOpenSitter = null
  return true
}

export function subscribeOpenSitter(listener: (worktree: string | null) => void): () => void {
  openSitterListeners.add(listener)
  return () => openSitterListeners.delete(listener)
}
