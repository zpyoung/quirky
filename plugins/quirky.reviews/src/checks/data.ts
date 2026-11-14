import type { UiPluginContext } from '@quirky/protocol'

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
export const REVIEWS_UI_CONTROL = 'command:quirky.reviews/ui-control'

export type ReviewsUiControlRequest = {
  target: string
  generation: number
  action: string
  value?: Record<string, unknown>
}

export type ReviewsUiControlResult =
  | { delivered: true; result?: unknown }
  | { delivered: false; reason: 'target-unavailable' | 'disabled' | 'unknown-action' }

export type ReviewsUiControlDescriptor = {
  surface: string
  slot: string
  target: string
  generation: number
  actions: Array<{ action: string; enabled: boolean }>
}

export type ReviewsUiControlRegistration = {
  surface: string
  slot: string
  target: string
  actions(): Array<{ action: string; enabled: boolean }>
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
}

type ReviewsUiControlLease = {
  registration: ReviewsUiControlRegistration
  generation: number
  active: boolean
}

type ReviewsUiControlRegistry = {
  nextGeneration: number
  leases: Map<string, ReviewsUiControlLease>
  listeners: Set<() => void>
}

const reviewsUiControlRegistries = new WeakMap<UiPluginContext, ReviewsUiControlRegistry>()

function reviewsUiControlRegistry(context: UiPluginContext): ReviewsUiControlRegistry {
  let registry = reviewsUiControlRegistries.get(context)
  if (!registry) {
    registry = { nextGeneration: 1, leases: new Map(), listeners: new Set() }
    reviewsUiControlRegistries.set(context, registry)
  }
  return registry
}

function notifyReviewsUiControls(registry: ReviewsUiControlRegistry): void {
  for (const listener of [...registry.listeners]) listener()
}

function reviewsUiControlActions(registration: ReviewsUiControlRegistration): ReviewsUiControlDescriptor['actions'] {
  const actions = registration.actions()
  if (!Array.isArray(actions)) throw new Error('A Reviews UI control returned invalid actions.')
  return actions.map((item) => {
    if (!isRecord(item) || typeof item.action !== 'string' || item.action.trim() === '' || typeof item.enabled !== 'boolean') {
      throw new Error('A Reviews UI control returned an invalid action.')
    }
    return { action: item.action, enabled: item.enabled }
  })
}

function reviewsUiControlRequest(input: unknown): ReviewsUiControlRequest {
  if (!isRecord(input)
    || Object.keys(input).some((key) => !['target', 'generation', 'action', 'value'].includes(key))
    || typeof input.target !== 'string' || input.target.trim() === ''
    || typeof input.generation !== 'number' || !Number.isSafeInteger(input.generation) || input.generation < 1
    || typeof input.action !== 'string' || input.action.trim() === ''
    || (Object.hasOwn(input, 'value') && !isRecord(input.value))) {
    throw new Error('Invalid Reviews UI control request.')
  }
  return {
    target: input.target,
    generation: input.generation,
    action: input.action,
    ...(Object.hasOwn(input, 'value') ? { value: input.value as Record<string, unknown> } : {})
  }
}

export function registerReviewsUiControl(
  context: UiPluginContext,
  registration: ReviewsUiControlRegistration
): { generation: number; changed(): void; dispose(): void } {
  if (!isRecord(registration)
    || typeof registration.surface !== 'string' || registration.surface.trim() === ''
    || typeof registration.slot !== 'string' || registration.slot.trim() === ''
    || typeof registration.target !== 'string' || registration.target.trim() === ''
    || typeof registration.actions !== 'function' || typeof registration.run !== 'function') {
    throw new Error('Invalid Reviews UI control registration.')
  }
  const registry = reviewsUiControlRegistry(context)
  if (!Number.isSafeInteger(registry.nextGeneration) || registry.nextGeneration < 1) {
    throw new Error('Reviews UI control generations are exhausted.')
  }
  const generation = registry.nextGeneration
  registry.nextGeneration += 1
  const previous = registry.leases.get(registration.target)
  if (previous) previous.active = false
  const lease: ReviewsUiControlLease = { registration, generation, active: true }
  registry.leases.set(registration.target, lease)
  notifyReviewsUiControls(registry)

  const isCurrent = () => lease.active && registry.leases.get(registration.target) === lease
  return {
    generation,
    changed() {
      if (isCurrent()) notifyReviewsUiControls(registry)
    },
    dispose() {
      if (!lease.active) return
      lease.active = false
      if (registry.leases.get(registration.target) === lease) {
        registry.leases.delete(registration.target)
        notifyReviewsUiControls(registry)
      }
    }
  }
}

export function listReviewsUiControls(context: UiPluginContext, surface: string): ReviewsUiControlDescriptor[] {
  return [...reviewsUiControlRegistry(context).leases.values()]
    .filter((lease) => lease.active && lease.registration.surface === surface)
    .map((lease) => ({
      surface: lease.registration.surface,
      slot: lease.registration.slot,
      target: lease.registration.target,
      generation: lease.generation,
      actions: reviewsUiControlActions(lease.registration)
    }))
}

export function subscribeReviewsUiControls(context: UiPluginContext, listener: () => void): () => void {
  const registry = reviewsUiControlRegistry(context)
  registry.listeners.add(listener)
  return () => registry.listeners.delete(listener)
}

export async function runReviewsUiControl(context: UiPluginContext, input: unknown): Promise<ReviewsUiControlResult> {
  const request = reviewsUiControlRequest(input)
  const registry = reviewsUiControlRegistry(context)
  const lease = registry.leases.get(request.target)
  const isCurrent = () => lease !== undefined
    && lease.active
    && lease.generation === request.generation
    && registry.leases.get(request.target) === lease
  if (!isCurrent() || !lease) return { delivered: false, reason: 'target-unavailable' }

  const action = reviewsUiControlActions(lease.registration).find((item) => item.action === request.action)
  if (!isCurrent()) return { delivered: false, reason: 'target-unavailable' }
  if (!action) return { delivered: false, reason: 'unknown-action' }
  if (!action.enabled) return { delivered: false, reason: 'disabled' }

  const result = await lease.registration.run(request, isCurrent)
  if (!isCurrent()) return { delivered: false, reason: 'target-unavailable' }
  return result === undefined ? { delivered: true } : { delivered: true, result }
}

export function reviewsUiControlDescriptor(args: ReviewsUiControlRequest): {
  command: typeof REVIEWS_UI_CONTROL
  args: ReviewsUiControlRequest
} {
  return { command: REVIEWS_UI_CONTROL, args }
}

export async function requestReviewsUiControl(
  context: UiPluginContext,
  args: ReviewsUiControlRequest
): Promise<ReviewsUiControlResult> {
  const request = reviewsUiControlRequest(args)
  const identity = await context.call('ui.window.self', {})
  if (!isRecord(identity) || typeof identity.connId !== 'number' || !Number.isSafeInteger(identity.connId) || identity.connId < 1) {
    throw new Error('The daemon did not identify this window.')
  }
  const descriptor = reviewsUiControlDescriptor(request)
  const response = await context.call('ui.window.command.run', {
    connId: identity.connId,
    id: descriptor.command,
    args: descriptor.args
  })
  if (!isRecord(response) || !Object.hasOwn(response, 'result') || !isRecord(response.result)) {
    throw new Error('The UI control command returned an invalid result envelope.')
  }
  const result = response.result
  if (result.delivered === false) {
    if (result.reason === 'target-unavailable' || result.reason === 'disabled' || result.reason === 'unknown-action') {
      return { delivered: false, reason: result.reason }
    }
    throw new Error('The UI control command returned an invalid delivery result.')
  }
  if (result.delivered !== true) throw new Error('The UI control command did not report delivery.')
  return Object.hasOwn(result, 'result') ? { delivered: true, result: result.result } : { delivered: true }
}

export async function copyReviewsText(text: unknown): Promise<void> {
  if (typeof text !== 'string' || text.length > 1_048_576) throw new Error('Invalid clipboard text.')
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('Clipboard access is unavailable in this window.')
  }
  await navigator.clipboard.writeText(text)
}
