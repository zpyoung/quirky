import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent, type MouseEvent } from 'react'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { CHECKS_PANEL, type JsonRecord, type ReviewData, type ReviewsSurfaceProps } from '../contracts'
import { isRecord } from './data'
import { ReviewActions } from '../detail/Actions'
import { ChecksList } from '../detail/ChecksList'
import { Comments } from '../detail/Comments'

const REFRESH_ENTRY_AGE_MS = 15_000
const REFRESH_COOLDOWN_MS = 10_000
const OPEN_REFRESH_MS = 60_000
const CLOSED_REFRESH_MS = 15 * 60_000
const QUIET_MERGED_REFRESH_MS = Number.POSITIVE_INFINITY
const FAILURE_BACKOFF_CAP_MS = 15 * 60_000
const UNCHANGED_BACKOFF_CAP_MS = 120_000
const ELIGIBILITY_MAX_AGE_MS = 5 * 60_000
const MIN_HEIGHT = 160
const MAX_HEIGHT = 800
const MAX_PROMPT_LENGTH = 32_000
const MAX_AGENT_ARGS_LENGTH = 2_000

let visibleCandidateGeneration = 0

export type ChecksPollingTarget = {
  worktree: string
  branch: string | null
  localHead: string | null
  number: number | null
  headOid: string | null
  provider: string
  reviewState: ReviewData['state'] | null
  checksPresent: boolean
  checksRollup: string | null
  pending: boolean
  signature: string
  fetchedAt: number
  candidate: JsonRecord
}

export type ChecksPollingPolicy = {
  identity: string | null
  signature: string
  delayMs: number
  failures: number
  lastAttemptAt: number
}

export type ChecksPollingRuntime = {
  visible(): boolean
  subscribeVisibility(listener: () => void): () => void
  subscribeLayout(listener: () => void): () => void
  subscribeConnection(listener: (status: 'connected' | 'reconnecting') => void): () => void
  report(candidates: JsonRecord[]): Promise<void>
  refresh(): Promise<boolean>
  invalidate(worktree: string): Promise<void>
  schedule(callback: () => void, delayMs: number): unknown
  cancel(handle: unknown): void
  now(): number
  onError(message: string): void
  policy: ChecksPollingPolicy
}

export type ChecksPollingController = { update(target: ChecksPollingTarget): void; force(): void; dispose(): void }

export function createChecksPollingPolicy(): ChecksPollingPolicy {
  return { identity: null, signature: '', delayMs: OPEN_REFRESH_MS, failures: 0, lastAttemptAt: 0 }
}

function pollingIdentity(target: ChecksPollingTarget): string {
  return [target.worktree, target.branch ?? '', target.number ?? '', target.localHead ?? '', target.headOid ?? '', target.provider].join('|')
}

function baseRefreshInterval(target: ChecksPollingTarget): number {
  if (target.reviewState === 'merged' && target.checksPresent && !target.pending && target.checksRollup !== 'unknown') {
    return QUIET_MERGED_REFRESH_MS
  }
  if (target.reviewState === 'closed') return CLOSED_REFRESH_MS
  return OPEN_REFRESH_MS
}

function refreshDelay(target: ChecksPollingTarget, policy: ChecksPollingPolicy, now: number, forced: boolean): number {
  const cooldown = policy.lastAttemptAt === 0 ? 0 : Math.max(0, REFRESH_COOLDOWN_MS - (now - policy.lastAttemptAt))
  if (forced) return cooldown
  const interval = baseRefreshInterval(target)
  if (!Number.isFinite(interval)) return interval
  return Math.max(interval, policy.delayMs, cooldown)
}

/**
 * The polling lifecycle is shared by the mounted panel and the deterministic hidden-window test.
 * Only the supplied runtime performs I/O, so the policy can never start renderer subprocesses.
 */
export function installChecksPolling(initialTarget: ChecksPollingTarget, runtime: ChecksPollingRuntime): ChecksPollingController {
  let target = initialTarget
  const policy = runtime.policy
  const resetPolicy = (next: ChecksPollingTarget) => {
    const identity = pollingIdentity(next)
    if (policy.identity !== identity) {
      policy.identity = identity
      policy.signature = next.signature
      policy.delayMs = OPEN_REFRESH_MS
      policy.failures = 0
      policy.lastAttemptAt = 0
    } else if (policy.signature !== next.signature) {
      policy.signature = next.signature
      policy.delayMs = OPEN_REFRESH_MS
      policy.failures = 0
    }
  }
  resetPolicy(target)

  let timer: unknown = null
  let disposed = false
  let inFlight = false
  let connectionReady = true
  let visible = false
  let lastReportedVisible = false
  let reportSequence = 0

  const report = (candidates: JsonRecord[]) => {
    const sequence = ++reportSequence
    void runtime.report(candidates).catch((error: unknown) => {
      if (!disposed && sequence === reportSequence) runtime.onError(messageOf(error, 'Could not report Checks panel visibility.'))
    })
  }

  const clearTimer = () => {
    if (timer === null) return
    runtime.cancel(timer)
    timer = null
  }

  const schedule = (forced = false) => {
    clearTimer()
    if (disposed || !visible || inFlight) return
    const delay = refreshDelay(target, policy, runtime.now(), forced)
    if (!Number.isFinite(delay)) return
    timer = runtime.schedule(() => {
      timer = null
      void run(forced ? 'forced' : 'timer')
    }, delay)
  }

  const run = async (source: 'entry' | 'forced' | 'timer') => {
    if (disposed || !visible || inFlight) return
    inFlight = true
    clearTimer()
    policy.lastAttemptAt = runtime.now()
    try {
      const succeeded = await runtime.refresh()
      if (succeeded) {
        policy.failures = 0
        if (source === 'timer') {
          policy.delayMs = Math.min(UNCHANGED_BACKOFF_CAP_MS, Math.max(OPEN_REFRESH_MS, policy.delayMs * 2))
        } else {
          policy.delayMs = OPEN_REFRESH_MS
        }
      } else {
        policy.failures += 1
        policy.delayMs = Math.min(FAILURE_BACKOFF_CAP_MS, Math.max(OPEN_REFRESH_MS, OPEN_REFRESH_MS * 2 ** Math.min(policy.failures - 1, 4)))
      }
    } catch (error) {
      policy.failures += 1
      policy.delayMs = Math.min(FAILURE_BACKOFF_CAP_MS, Math.max(OPEN_REFRESH_MS, OPEN_REFRESH_MS * 2 ** Math.min(policy.failures - 1, 4)))
      if (!disposed) runtime.onError(messageOf(error, 'Checks refresh failed.'))
    } finally {
      inFlight = false
      if (!disposed && visible) schedule()
    }
  }

  const syncVisibility = () => {
    const nextVisible = connectionReady && runtime.visible()
    visible = nextVisible
    if (!nextVisible) {
      clearTimer()
      if (inFlight) void runtime.invalidate(target.worktree).catch((error: unknown) => runtime.onError(messageOf(error, 'Could not invalidate hidden Checks work.')))
      if (lastReportedVisible) report([])
      lastReportedVisible = false
      return
    }
    report([target.candidate])
    lastReportedVisible = true
    const staleEntry = runtime.now() - target.fetchedAt > REFRESH_ENTRY_AGE_MS
    const delay = refreshDelay(target, policy, runtime.now(), staleEntry)
    if (staleEntry && delay === 0) void run('entry')
    else schedule(staleEntry)
  }

  const unsubscribeVisibility = runtime.subscribeVisibility(syncVisibility)
  const unsubscribeLayout = runtime.subscribeLayout(syncVisibility)
  const unsubscribeConnection = runtime.subscribeConnection((status) => {
    connectionReady = status === 'connected'
    syncVisibility()
    if (connectionReady && visible) schedule(true)
  })
  syncVisibility()

  return {
    update(next) {
      const previous = target
      const identityChanged = pollingIdentity(previous) !== pollingIdentity(next)
      target = next
      resetPolicy(next)
      if (identityChanged) {
        if (inFlight) void runtime.invalidate(previous.worktree).catch((error: unknown) => runtime.onError(messageOf(error, 'Could not invalidate stale Checks work.')))
        if (visible) report([target.candidate])
      }
      if (visible) {
        const staleEntry = runtime.now() - target.fetchedAt > REFRESH_ENTRY_AGE_MS
        const delay = refreshDelay(target, policy, runtime.now(), staleEntry)
        if (staleEntry && delay === 0) void run('entry')
        else schedule(staleEntry)
      }
    },
    force() {
      if (!visible) return
      const delay = refreshDelay(target, policy, runtime.now(), true)
      if (delay === 0) void run('forced')
      else schedule(true)
    },
    dispose() {
      if (disposed) return
      disposed = true
      clearTimer()
      if (inFlight) void runtime.invalidate(target.worktree).catch(() => undefined)
      unsubscribeVisibility()
      unsubscribeLayout()
      unsubscribeConnection()
      if (lastReportedVisible) report([])
      lastReportedVisible = false
    }
  }
}

function messageOf(error: unknown, fallback = 'The review action failed.'): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallback
}

function layoutWorktree(layout: UiLayout): string | null {
  const input = layout.view?.input
  if (!isRecord(input) || typeof input.worktree !== 'string' || input.worktree.trim() === '') return null
  return input.worktree
}

function reviewStateName(state: ReviewData['state']): string {
  if (state === 'draft') return 'Draft'
  if (state === 'merged') return 'Merged'
  if (state === 'closed') return 'Closed'
  return 'Open'
}

function reviewDate(review: ReviewData): string | null {
  const value = review.updatedAt
  if (typeof value !== 'string') return null
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return null
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000))
  if (seconds < 60) return 'Updated just now'
  if (seconds < 3_600) return `Updated ${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `Updated ${Math.floor(seconds / 3_600)}h ago`
  return `Updated ${Math.floor(seconds / 86_400)}d ago`
}

function statusFromLookup(lookup: unknown): JsonRecord | null {
  if (!isRecord(lookup) || !isRecord(lookup.gitStatus)) return null
  return lookup.gitStatus
}

function checkSignature(checks: unknown): string {
  if (!isRecord(checks) || !Array.isArray(checks.checks)) return ''
  return checks.checks.flatMap((item) => {
    if (!isRecord(item)) return []
    return [`${String(item.name ?? '')}:${String(item.status ?? '')}:${String(item.conclusion ?? '')}`]
  }).join('|')
}

function isPending(review: ReviewData | null, checks: unknown): boolean {
  if (review?.checksStatus === 'pending') return true
  if (!isRecord(checks)) return false
  if (checks.rollup === 'pending') return true
  if (!Array.isArray(checks.checks)) return false
  return checks.checks.some((item) => {
    if (!isRecord(item)) return false
    return item.conclusion === 'pending' || (typeof item.status === 'string' && item.status.toLowerCase() !== 'completed' && item.status.toLowerCase() !== 'success')
  })
}

function pollTarget(state: ReviewsSurfaceProps['state'], worktree: string | null): ChecksPollingTarget | null {
  const checks = state.checks
  if (!worktree || checks.worktree !== worktree) return null
  const lookup = isRecord(checks.lookup) ? checks.lookup : null
  if (!lookup || lookup.kind === 'suppressed' || lookup.kind === 'folder' || lookup.kind === 'git-operation' || lookup.kind === 'blocked') return null
  const git = statusFromLookup(lookup)
  const branch = git && typeof git.branch === 'string' ? git.branch : null
  const localHead = git && typeof git.head === 'string' ? git.head : null
  const review = checks.review
  const reviewNumber = review?.number
  const headOid = review?.headRefOid ?? null
  const provider = review?.provider ?? 'github'
  const candidate: JsonRecord = {
    worktree,
    active: true,
    ...(branch ? { branch } : {}),
    ...(positiveInteger(reviewNumber) ? { number: reviewNumber } : {}),
    ...(localHead ? { headOid: localHead } : {})
  }
  return {
    worktree,
    branch,
    localHead,
    number: review?.number ?? null,
    headOid,
    provider,
    reviewState: review?.state ?? null,
    checksPresent: checks.checks !== null,
    checksRollup: isRecord(checks.checks) && typeof checks.checks.rollup === 'string' ? checks.checks.rollup : null,
    pending: isPending(review, checks.checks),
    signature: checkSignature(checks.checks),
    fetchedAt: checks.fetchedAt,
    candidate
  }
}

function lookupReason(lookup: unknown): string | null {
  if (!isRecord(lookup)) return null
  if (typeof lookup.reason === 'string') return lookup.reason
  if (isRecord(lookup.result) && typeof lookup.result.reason === 'string') return lookup.result.reason
  return null
}

function blockerRows(value: unknown): JsonRecord[] {
  if (!isRecord(value) || !Array.isArray(value.blockers)) return []
  return value.blockers.filter(isRecord)
}

function prioritizedBlocker(value: unknown): JsonRecord | null {
  const rows = blockerRows(value)
  const priority = [
    'detached_head', 'no_current_branch', 'dirty_tree', 'dirty', 'default_branch', 'fork_head_unsupported',
    'missing_remote_base', 'base_not_on_remote', 'unsupported_provider', 'existing_review',
    'no_upstream', 'branch_behind', 'needs_sync', 'authentication_required', 'auth_required',
    'not_authenticated', 'scope_missing', 'gh_unavailable', 'branch_ahead', 'needs_push'
  ]
  for (const reason of priority) {
    const found = rows.find((row) => row.reason === reason)
    if (found) return found
  }
  return rows[0] ?? null
}

function blockerCopy(reason: string | null, blocker: JsonRecord | null): { title: string; message: string; action: 'publish' | 'sync' | 'push' | 'open' | 'auth' | null } {
  const message = blocker && typeof blocker.message === 'string' ? blocker.message : ''
  switch (reason ?? blocker?.reason) {
    case 'detached_head':
    case 'no_current_branch':
      return { title: 'No current branch', message: message || 'Check out a branch to find or create a hosted review.', action: null }
    case 'dirty_tree':
    case 'dirty':
      return { title: 'Commit changes first', message: message || 'Commit or discard local changes before creating a pull request.', action: null }
    case 'default_branch':
      return { title: 'On the default branch', message: message || 'Create a feature branch before opening a pull request.', action: null }
    case 'fork_head_unsupported':
      return { title: 'Fork head unsupported', message: message || 'This fork-based head is not supported by the current provider flow.', action: null }
    case 'missing_remote_base':
    case 'base_not_on_remote':
      return { title: 'Base branch not on remote', message: message || 'Fetch or choose a base branch that exists on a configured remote.', action: null }
    case 'unsupported_provider':
      return { title: 'Provider unsupported', message: message || 'Hosted review creation is unavailable for this repository provider.', action: null }
    case 'existing_review':
      return { title: 'Pull request already exists', message: message || 'Open the existing review instead of creating a duplicate.', action: 'open' }
    case 'no_upstream':
    case 'no-upstream':
      return { title: 'No upstream configured', message: message || 'Publish this branch to configure its upstream.', action: 'publish' }
    case 'branch_behind':
    case 'needs_sync':
      return { title: 'Branch needs to sync', message: message || 'Sync this branch with its upstream before creating a review.', action: 'sync' }
    case 'authentication_required':
    case 'auth_required':
    case 'not_authenticated':
    case 'scope_missing':
    case 'permission_denied':
    case 'gh_unavailable':
      return { title: 'GitHub authentication required', message: message || 'Check the canonical GitHub CLI diagnostics below.', action: 'auth' }
    case 'branch_ahead':
    case 'needs_push':
      return { title: 'Branch has unpushed commits', message: message || 'Push the branch before creating a pull request.', action: 'push' }
    default:
      return { title: 'Pull request details unavailable', message: message || 'The provider could not confirm this branch’s review status.', action: null }
  }
}

function eligibilityIsCurrent(state: ReviewsSurfaceProps['state'], worktree: string | null): boolean {
  if (!worktree || state.checks.worktree !== worktree || !isRecord(state.checks.eligibility)) return false
  const eligibility = state.checks.eligibility
  const git = statusFromLookup(state.checks.lookup)
  const confirmedAt = eligibility.confirmedAt
  if (eligibility.eligible !== true || eligibility.worktree !== worktree || typeof confirmedAt !== 'number' ||
      Date.now() - confirmedAt > ELIGIBILITY_MAX_AGE_MS || !git || eligibility.head !== git.branch || eligibility.headOid !== git.head) return false
  return isRecord(state.checks.lookup) && state.checks.lookup.kind === 'no-review'
}

function eligibilityDisabledReason(state: ReviewsSurfaceProps['state'], worktree: string | null): string | null {
  if (!worktree) return 'Select a workspace.'
  if (state.checks.worktree !== worktree || state.checks.loading) return 'Checking this workspace…'
  if (!isRecord(state.checks.eligibility)) return 'Refresh to confirm that no pull request exists.'
  const eligibility = state.checks.eligibility
  const git = statusFromLookup(state.checks.lookup)
  if (!git || eligibility.worktree !== worktree || eligibility.head !== git.branch || eligibility.headOid !== git.head) {
    return 'The workspace changed. Refresh before opening the composer.'
  }
  if (typeof eligibility.confirmedAt !== 'number' || Date.now() - eligibility.confirmedAt > ELIGIBILITY_MAX_AGE_MS) {
    return 'Eligibility expired. Refresh to confirm the current branch.'
  }
  const blocker = prioritizedBlocker(eligibility)
  if (blocker) {
    const text = blockerCopy(typeof blocker.reason === 'string' ? blocker.reason : null, blocker)
    return text.message || text.title
  }
  if (eligibility.eligible !== true) return 'The provider has not confirmed this branch is eligible.'
  if (!isRecord(state.checks.lookup) || state.checks.lookup.kind !== 'no-review') return 'The provider has not confirmed that this branch has no review.'
  return null
}

function statusBadgeStyle(state: ReviewData['state']): CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    borderRadius: 999,
    border: '1px solid var(--border, #2b2f3a)',
    padding: '2px 8px',
    color: state === 'merged' ? 'var(--accent, #4f8ff7)' : state === 'closed' ? 'var(--muted, #8a909e)' : state === 'draft' ? 'var(--amber, #f0b429)' : 'var(--green, #3fb950)',
    fontSize: 11
  }
}

const buttonStyle: CSSProperties = {
  background: 'var(--bg-raised, #1d2027)',
  color: 'var(--text, #d7dae0)',
  border: '1px solid var(--border, #2b2f3a)',
  borderRadius: 4,
  padding: '4px 8px',
  cursor: 'pointer'
}

const primaryButtonStyle: CSSProperties = { ...buttonStyle, background: 'var(--accent, #4f8ff7)', color: '#fff', borderColor: 'transparent' }
const quietButtonStyle: CSSProperties = { ...buttonStyle, background: 'transparent' }

type StackMap = { available: boolean; number?: number; position?: number; size?: number; entries: JsonRecord[]; truncated: boolean; message?: string }

function stackModel(value: unknown): StackMap | null {
  if (!isRecord(value)) return null
  const number = positiveNumber(String(value.number ?? ''))
  const position = positiveNumber(String(value.position ?? ''))
  const size = positiveNumber(String(value.size ?? ''))
  if (value.available !== true || !Array.isArray(value.entries)) {
    const message = typeof value.message === 'string' ? value.message : value.reason === 'stack_unavailable'
      ? 'The public hosting API could not load this stack.'
      : value.reason === 'stack_mismatch'
        ? 'The provider stack did not match the selected pull request.'
        : 'Loading the canonical stack member list…'
    return {
      available: false,
      ...(number ? { number } : {}),
      ...(position ? { position } : {}),
      ...(size ? { size } : {}),
      entries: [],
      truncated: value.truncated === true,
      message
    }
  }
  if (!number || !position || !size) {
    return { available: false, entries: [], truncated: false, message: 'The canonical stack response is incomplete.' }
  }
  return {
    available: true,
    number,
    position,
    size,
    entries: value.entries.filter(isRecord),
    truncated: value.truncated === true
  }
}

function unixMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

function retryDelay(lookup: unknown, now: number): number | null {
  if (!isRecord(lookup)) return null
  const until = unixMs(lookup.retryDisabledUntil)
  return until === null || until <= now ? null : Math.ceil((until - now) / 1_000)
}

function diagnosticsCopy(value: unknown): string[] {
  if (!isRecord(value)) return []
  const messages: string[] = []
  if (value.ghAvailable === false) messages.push('GitHub CLI (gh) is not installed or unavailable.')
  if (value.requiredHostAuthenticated === false) messages.push(`No authenticated account is available for ${typeof value.requiredHost === 'string' ? value.requiredHost : 'the required GitHub host'}.`)
  if (value.envTokenInProcess === true) messages.push('An environment token is overriding the account selected by the GitHub CLI.')
  if (Array.isArray(value.missingScopes) && value.missingScopes.length > 0) messages.push(`Missing GitHub scopes: ${value.missingScopes.filter((scope): scope is string => typeof scope === 'string').join(', ')}.`)
  return messages
}

function selectStatus(state: ReviewsSurfaceProps['state'], activeWorktree: string | null): {
  title: string
  message: string
  action?: 'publish' | 'sync' | 'push' | 'open' | 'auth' | 'relink'
  existingNumber?: number
} {
  if (!activeWorktree) return { title: 'No workspace selected', message: 'Select a workspace to view checks.' }
  if (state.checks.worktree !== activeWorktree) return { title: 'Checking pull request status', message: 'Reading the active workspace before using its previous eligibility.' }
  const lookup = isRecord(state.checks.lookup) ? state.checks.lookup : null
  if (lookup?.kind === 'folder') return { title: 'Checks unavailable', message: 'Checks require a Git branch and hosted review context.' }
  if (lookup?.kind === 'suppressed') {
    const number = positiveNumber(String(lookup.number ?? ''))
    return {
      title: 'Pull request unlinked',
      message: `PR #${number ?? ''} is hidden for this workspace. Link it again to restore checks and review details.`,
      action: 'relink',
      ...(number ? { existingNumber: number } : {})
    }
  }
  if (lookup?.kind === 'blocked' && typeof lookup.operation === 'string' && lookup.operation !== 'none') {
    const operation = lookup.operation
    const title = operation === 'cherry-pick' ? 'Cherry-pick in progress' : `${operation[0]?.toUpperCase() ?? ''}${operation.slice(1)} in progress`
    return { title, message: 'PR checks will be available after the operation completes.' }
  }
  if (state.checks.review) return { title: '', message: '' }
  if (state.checks.loading || lookup?.kind === 'loading') return { title: 'Checking pull request status', message: 'Looking for a hosted review on this branch.' }

  const eligibility = isRecord(state.checks.eligibility) ? state.checks.eligibility : null
  const blocker = prioritizedBlocker(eligibility)
  const blockerReason = blocker && typeof blocker.reason === 'string' ? blocker.reason : null
  const reason = blockerReason ?? (eligibility && typeof eligibility.reason === 'string' ? eligibility.reason : lookupReason(lookup))
  const copy = blockerCopy(reason, blocker)
  const authReasons = new Set(['authentication_required', 'auth_required', 'not_authenticated', 'scope_missing', 'permission_denied', 'gh_unavailable'])
  if (reason && authReasons.has(reason)) {
    return { title: 'GitHub authentication failed', message: copy.message || 'Check the canonical GitHub CLI diagnostics.', action: 'auth' }
  }
  if (blocker || (eligibility && eligibility.eligible === false && reason !== 'lookup_unavailable')) {
    const existing = isRecord(eligibility?.review) && positiveNumber(String(eligibility.review.number ?? ''))
      ? Number(eligibility.review.number)
      : undefined
    return { title: copy.title, message: copy.message, ...(copy.action ? { action: copy.action } : {}), ...(existing ? { existingNumber: existing } : {}) }
  }
  if (lookup?.kind === 'unavailable' || (reason === 'lookup_unavailable' && eligibility?.eligible !== true)) {
    return { title: 'Pull request details unavailable', message: lookup !== null && typeof lookup.message === 'string' ? lookup.message : copy.message }
  }
  if (reason === 'no_upstream' || reason === 'branch_behind' || reason === 'branch_ahead' || reason === 'needs_push' || reason === 'needs_sync') {
    return { title: copy.title, message: copy.message, ...(copy.action ? { action: copy.action } : {}) }
  }
  if (state.checks.error) return { title: 'Could not refresh pull request status', message: state.checks.error }
  if (eligibilityIsCurrent(state, activeWorktree)) return { title: 'No pull request found', message: 'This branch is ready to create a pull request.' }
  return { title: 'Pull request details unavailable', message: 'Eligibility is not confirmed for this exact workspace. Refresh before opening the composer.' }
}

function positiveNumber(value: string): number | null {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : null
}
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function presentationError(result: unknown): string | null {
  return isRecord(result) && typeof result.error === 'string' ? result.error : null
}

function currentReviewPrRepo(review: ReviewData): JsonRecord | undefined {
  return isRecord(review.prRepo) ? review.prRepo : undefined
}

function dialogPrompt(record: unknown): string {
  return isRecord(record) && typeof record.prompt === 'string' ? record.prompt : ''
}

function createAgentList(value: unknown): { agents: JsonRecord[]; defaultAgent: string } {
  if (!isRecord(value) || !Array.isArray(value.agents)) return { agents: [], defaultAgent: '' }
  return {
    agents: value.agents.filter((entry): entry is JsonRecord => isRecord(entry) && entry.enabled === true && entry.installed === true),
    defaultAgent: typeof value.defaultAgent === 'string' ? value.defaultAgent : ''
  }
}

export function ChecksAgentDialog(props: ReviewsSurfaceProps) {
  const { context, state, refresh } = props
  const rawDialog = state.checks.agentDialog
  const dialog = isRecord(rawDialog) ? rawDialog : null
  const surface = dialog?.surface === 'detail' ? 'detail' : 'checks'
  const visible = dialog !== null && dialog.visible !== false
  const target = dialog && isRecord(dialog.target) ? dialog.target : null
  const worktree = target && typeof target.worktree === 'string' ? target.worktree : state.checks.worktree
  const number = target && positiveNumber(String(target.number ?? '')) ? Number(target.number) : null
  const action = dialog && typeof dialog.action === 'string' ? dialog.action : 'fix'
  const originalPrompt = dialogPrompt(dialog)
  const [prompt, setPrompt] = useState(originalPrompt)
  const [agent, setAgent] = useState(dialog && typeof dialog.agent === 'string' ? dialog.agent : '')
  const [args, setArgs] = useState(dialog && typeof dialog.args === 'string' ? dialog.args : '')
  const [agents, setAgents] = useState<JsonRecord[]>([])
  const [defaultAgent, setDefaultAgent] = useState('')
  const [loadingAgents, setLoadingAgents] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const targetKey = `${surface}|${worktree ?? ''}|${number ?? ''}|${dialog?.headOid ?? ''}|${action}`
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    setPrompt(originalPrompt)
    setAgent(dialog && typeof dialog.agent === 'string' ? dialog.agent : '')
    setArgs(dialog && typeof dialog.args === 'string' ? dialog.args : '')
    setError(null)
  }, [targetKey])

  useEffect(() => {
    if (!visible) return
    let active = true
    setLoadingAgents(true)
    context.call('quirky.agents/list').then((value) => {
      if (!active) return
      const result = createAgentList(value)
      setAgents(result.agents)
      setDefaultAgent(result.defaultAgent)
    }).catch((failure: unknown) => {
      if (active) setError(messageOf(failure))
    }).finally(() => {
      if (active) setLoadingAgents(false)
    })
    return () => { active = false }
  }, [context, visible, targetKey])

  const selectedReview = surface === 'checks' ? state.checks.review : state.detail.review
  const currentPrRepo = selectedReview ? currentReviewPrRepo(selectedReview) : undefined
  const configuredAgent = defaultAgent !== 'auto' && defaultAgent !== 'shell' && agents.some((entry) => entry.id === defaultAgent)
    ? defaultAgent
    : undefined
  const markedAgent = agents.find((entry) => entry.isDefault === true)
  const markedAgentId = typeof markedAgent?.id === 'string' ? markedAgent.id : undefined
  const firstAgentId = typeof agents[0]?.id === 'string' ? agents[0].id : ''
  const selectedAgent = agent || configuredAgent || markedAgentId || firstAgentId
  const persistTarget = useRef<{ surface: 'checks' | 'detail'; worktree: string | null; number: number | null; action: string; prRepo?: JsonRecord } | null>(null)
  persistTarget.current = { surface, worktree, number, action, ...(currentPrRepo ? { prRepo: currentPrRepo } : {}) }

  const persist = useCallback(async (nextPrompt: string, nextAgent: string, nextArgs: string): Promise<boolean> => {
    const target = persistTarget.current
    if (!target || !target.worktree || target.number === null) return false
    const params: JsonRecord = {
      surface: target.surface,
      worktree: target.worktree,
      number: target.number,
      action: target.action,
      prompt: nextPrompt,
      ...(nextAgent ? { agent: nextAgent } : {}),
      args: nextArgs,
      ...(target.prRepo ? { prRepo: target.prRepo } : {})
    }
    await context.call('quirky.reviews/checksSetAgentDialog', params)
    return true
  }, [context])

  useEffect(() => {
    if (!visible || !worktree || number === null) return
    if (persistTimer.current !== null) clearTimeout(persistTimer.current)
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      void persist(prompt, selectedAgent, args).catch((failure: unknown) => setError(messageOf(failure)))
    }, 200)
    return () => {
      if (persistTimer.current !== null) clearTimeout(persistTimer.current)
      persistTimer.current = null
    }
  }, [args, number, persist, prompt, selectedAgent, visible, worktree])

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        void close()
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void submit()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    promptRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [visible, targetKey, prompt, agent, args])

  const close = async () => {
    if (busy) return
    setBusy(true)
    try {
      await persist(prompt, selectedAgent, args)
      await context.call('quirky.reviews/checksSetAgentDialog', { action: 'hide', surface })
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
    } finally {
      setBusy(false)
    }
  }

  const submit = async () => {
    if (busy || !worktree || number === null) return
    if (prompt.trim() === '') {
      setError('Enter an agent prompt before starting.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await persist(prompt, selectedAgent, args)
      const result = await context.call('quirky.reviews/checksLaunchAgent', {
        worktree,
        agent: selectedAgent,
        ...(args ? { args } : {})
      })
      const outcome = isRecord(result) ? result : null
      if (outcome?.delivered !== true) {
        setError(typeof outcome?.error === 'string' ? outcome.error : 'The agent prompt was not delivered.')
      }
      await refresh()
    } catch (failure) {
      setError(messageOf(failure))
      await refresh().catch(() => undefined)
    } finally {
      setBusy(false)
    }
  }

  if (!visible || !dialog) return null
  const title = action === 'conflicts' ? 'Resolve Review Conflicts With AI' : action === 'comments' ? 'Resolve Comments With AI' : 'Fix With AI'
  return (
    <div role="presentation" className="quirky-reviews-dialog-backdrop" style={{ position: 'fixed', inset: 0, zIndex: 10000, background: 'rgba(0,0,0,.55)', display: 'grid', placeItems: 'center', padding: 16 }}>
      <section role="dialog" aria-modal="true" aria-labelledby="reviews-agent-dialog-title" style={{ width: 'min(680px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--bg-raised, #1d2027)', color: 'var(--text, #d7dae0)', border: '1px solid var(--border, #2b2f3a)', borderRadius: 8, padding: 16, display: 'grid', gap: 12 }}>
        <header>
          <h2 id="reviews-agent-dialog-title" style={{ margin: 0, fontSize: 16 }}>{title}</h2>
          <p className="muted" style={{ margin: '6px 0 0' }}>PR #{number} · {contextTargetLabel(state, surface)}</p>
        </header>
        <label style={{ display: 'grid', gap: 5 }}>
          Agent
          <select aria-label="Agent" value={selectedAgent} disabled={busy || loadingAgents || agents.length === 0} onChange={(event) => setAgent(event.target.value)}>
            {agents.length === 0 && <option value="">{loadingAgents ? 'Detecting agents…' : 'No enabled agents'}</option>}
            {agents.map((entry) => <option key={String(entry.id)} value={String(entry.id)}>{String(entry.label ?? entry.id)}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          Prompt
          <textarea ref={promptRef} aria-label="Agent prompt" rows={9} maxLength={MAX_PROMPT_LENGTH} value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} />
        </label>
        <label style={{ display: 'grid', gap: 5 }}>
          CLI arguments
          <input aria-label="CLI arguments" value={args} maxLength={MAX_AGENT_ARGS_LENGTH} disabled={busy} onChange={(event) => setArgs(event.target.value)} />
        </label>
        <p className="muted" style={{ margin: 0 }}>Cmd/Ctrl+Enter starts the selected agent after it is ready.</p>
        {error && <p role="alert" style={{ color: 'var(--danger, #e5534b)', margin: 0 }}>{error}</p>}
        <footer style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" style={quietButtonStyle} disabled={busy} onClick={() => void close()}>Cancel</button>
          <button type="button" style={primaryButtonStyle} disabled={busy || loadingAgents || agents.length === 0 || selectedAgent === '' || prompt.trim() === ''} onClick={() => void submit()}>
            {busy ? 'Starting…' : 'Start agent'}
          </button>
        </footer>
      </section>
    </div>
  )
}

function contextTargetLabel(state: ReviewsSurfaceProps['state'], surface: 'checks' | 'detail'): string {
  const target = surface === 'checks' ? state.checks.worktree : state.detail.target?.worktree
  return target ?? 'Workspace unavailable'
}

export function ChecksPanel(props: ReviewsSurfaceProps) {
  const { context, state, refresh } = props
  const [layout, setLayout] = useState<UiLayout>(() => context.getLayout())
  const [windowVisible, setWindowVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const [actionError, setActionError] = useState<string | null>(null)
  const [authDiagnostics, setAuthDiagnostics] = useState<JsonRecord | null>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkNumber, setLinkNumber] = useState('')
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleInput, setTitleInput] = useState('')
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const dragHeightRef = useRef<number | null>(null)
  const [countdownNow, setCountdownNow] = useState(Date.now())
  const previousPending = useRef<boolean | null>(null)
  const pollController = useRef<ChecksPollingController | null>(null)
  const pollPolicy = useRef<ChecksPollingPolicy>(createChecksPollingPolicy())
  const dragCleanup = useRef<(() => void) | null>(null)
  const activeWorktree = useMemo(() => layoutWorktree(layout), [layout])
  const active = state.checks.worktree === activeWorktree ? state.checks : null
  const currentReview = active?.review ?? null
  useEffect(() => {
    if (!currentReview) {
      setTitleEditing(false)
      setTitleInput('')
      return
    }
    if (typeof active?.titleDraft === 'string') setTitleInput(active.titleDraft)
    else if (!titleEditing) setTitleInput(currentReview.title)
  }, [active?.titleDraft, currentReview?.headRefOid, currentReview?.number])
  const lookup = active && isRecord(active.lookup) ? active.lookup : null
  const eligibility = active && isRecord(active.eligibility) ? active.eligibility : null
  const currentTarget = useMemo(() => pollTarget(state, activeWorktree), [state.checks, activeWorktree])
  const currentTargetRef = useRef<ChecksPollingTarget | null>(currentTarget)
  currentTargetRef.current = currentTarget
  const pending = currentTarget?.pending ?? false
  const isPanelVisible = layout.panel === CHECKS_PANEL && windowVisible
  useEffect(() => setAuthDiagnostics(null), [activeWorktree])

  useEffect(() => context.onLayout(setLayout), [context])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setWindowVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useEffect(() => {
    if (!activeWorktree || state.checks.worktree === activeWorktree || !isPanelVisible) return
    let alive = true
    context.call('quirky.reviews/checksRefresh', { worktree: activeWorktree, force: true }).then(() => {
      if (alive) return refresh()
      return undefined
    }).catch((error: unknown) => {
      if (alive) setActionError(messageOf(error))
    })
    return () => { alive = false }
  }, [activeWorktree, context, isPanelVisible, refresh, state.checks.worktree])

  const runRefresh = useCallback(async (reason: 'manual' | 'active', worktree = activeWorktree): Promise<boolean> => {
    if (!worktree) return false
    setActionError(null)
    const current = currentTargetRef.current
    const candidate: JsonRecord = current?.worktree === worktree ? current.candidate : { worktree, active: true }
    try {
      const queued = await context.call('quirky.hosting/refresh', { candidate, reason, priority: 80 })
      const queueResult = isRecord(queued) ? queued : null
      const queuedError = queueResult && (queueResult.kind === 'paused' || queueResult.kind === 'unavailable')
        ? typeof queueResult.message === 'string' ? queueResult.message : `GitHub refresh ${String(queueResult.kind)}.`
        : null
      const result = await context.call('quirky.reviews/checksRefresh', { worktree, force: true })
      await refresh()
      if (queuedError) setActionError(queuedError)
      if (!isRecord(result) || result.ok !== true) {
        const message = presentationError(result) ?? queuedError ?? 'The review could not be refreshed.'
        setActionError(message)
        return false
      }
      return queuedError === null
    } catch (error) {
      setActionError(messageOf(error))
      return false
    }
  }, [activeWorktree, context, refresh])

  useEffect(() => {
    if (!currentTarget || !activeWorktree || !isPanelVisible) {
      pollController.current?.dispose()
      pollController.current = null
      return
    }
    const runtime: ChecksPollingRuntime = {
      visible: () => context.getLayout().panel === CHECKS_PANEL && typeof document !== 'undefined' && document.visibilityState === 'visible',
      subscribeVisibility: (listener) => {
        document.addEventListener('visibilitychange', listener)
        return () => document.removeEventListener('visibilitychange', listener)
      },
      subscribeLayout: (listener) => context.onLayout(() => listener()),
      subscribeConnection: (listener) => context.onConnection(listener),
      async report(candidates) {
        const result = await context.call('quirky.hosting/visibleRefreshCandidates', {
          generation: ++visibleCandidateGeneration,
          candidates
        })
        if (!isRecord(result) || result.accepted !== true) throw new Error('GitHub did not accept the Checks visibility candidate set.')
      },
      refresh: () => {
        const target = currentTargetRef.current
        return target ? runRefresh('active', target.worktree) : Promise.resolve(false)
      },
      async invalidate(worktree) {
        await context.call('quirky.reviews/checksInvalidate', { worktree })
      },
      schedule: (callback, delayMs) => window.setTimeout(callback, delayMs),
      cancel: (timer) => window.clearTimeout(timer as number),
      now: () => Date.now(),
      onError: setActionError,
      policy: pollPolicy.current
    }
    const controller = installChecksPolling(currentTarget, runtime)
    pollController.current = controller
    return () => {
      controller.dispose()
      if (pollController.current === controller) pollController.current = null
    }
  }, [context, Boolean(currentTarget), activeWorktree, isPanelVisible, runRefresh])

  useEffect(() => {
    if (currentTarget) pollController.current?.update(currentTarget)
  }, [currentTarget])

  useEffect(() => {
    if (previousPending.current !== null && previousPending.current !== pending && isPanelVisible) pollController.current?.force()
    previousPending.current = pending
  }, [isPanelVisible, pending])

  useEffect(() => {
    if (!isPanelVisible) return
    const until = lookup && typeof lookup.retryDisabledUntil === 'number' ? lookup.retryDisabledUntil : null
    if (until === null || until <= Date.now()) return
    const timer = window.setInterval(() => setCountdownNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [isPanelVisible, lookup?.retryDisabledUntil])

  const runReviewMethod = useCallback(async (id: string, params: JsonRecord, refreshState = true): Promise<unknown> => {
    setActionError(null)
    try {
      const result = await context.call(`quirky.reviews/${id}`, params)
      if (refreshState) await refresh()
      const error = presentationError(result)
      if (error) setActionError(error)
      return result
    } catch (error) {
      setActionError(messageOf(error))
      return null
    }
  }, [context, refresh])

  const openLink = useCallback(async (url: string, event?: MouseEvent<HTMLButtonElement>) => {
    if (!activeWorktree) return
    const isMac = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform)
    const invert = Boolean(event?.shiftKey && (isMac ? event.metaKey : event.ctrlKey))
    await runReviewMethod('openLink', { url, worktree: activeWorktree, ...(invert ? { invert: true } : {}) }, false)
  }, [activeWorktree, runReviewMethod])

  const copyLink = useCallback(async (url: string) => {
    await runReviewMethod('copyText', { text: url }, false)
  }, [runReviewMethod])

  const linkAnother = async (event: FormEvent) => {
    event.preventDefault()
    const number = positiveNumber(linkNumber)
    if (!number || !activeWorktree) {
      setActionError('Enter a positive pull request number.')
      return
    }
    const result = await runReviewMethod('checksLink', { worktree: activeWorktree, number })
    if (isRecord(result) && result.linked === true) {
      setLinkOpen(false)
      setLinkNumber('')
      setMoreOpen(false)
    }
  }

  const openComposer = async () => {
    if (!activeWorktree || !eligibilityIsCurrent(state, activeWorktree)) return
    await runReviewMethod('createOpen', { worktree: activeWorktree }, false)
  }

  const runBlockerAction = async (action: 'publish' | 'sync' | 'push' | 'open' | 'auth' | 'relink', number?: number) => {
    if (!activeWorktree) return
    if (action === 'relink') {
      await runReviewMethod('checksRelink', { worktree: activeWorktree })
      return
    }
    if (action === 'open') {
      const existingValue = eligibility?.review
      const existingNumber = number ?? (isRecord(existingValue) && positiveNumber(String(existingValue.number ?? '')) ? Number(existingValue.number) : currentReview?.number)
      if (existingNumber) await runReviewMethod('checksOpenReview', { worktree: activeWorktree, number: existingNumber, tab: 'conversation' })
      return
    }
    if (action === 'auth') {
      try {
        const diagnostics = await context.call('quirky.hosting/diagnoseAuth', { worktree: activeWorktree })
        await refresh()
        if (!isRecord(diagnostics)) throw new Error('GitHub returned invalid authentication diagnostics.')
        setAuthDiagnostics(diagnostics)
        setActionError(null)
      } catch (error) {
        setActionError(messageOf(error))
      }
      return
    }
    const result = await runReviewMethod('checksGitAction', { worktree: activeWorktree, action })
    if (action === 'push' && isRecord(result) && result.ok === true) {
      await runReviewMethod('createOpen', { worktree: activeWorktree }, false)
    }
  }

  const startTitleEdit = () => {
    if (!activeWorktree || !currentReview) return
    setTitleEditing(true)
    setTitleInput(currentReview.title)
    void runReviewMethod('checksSetTitleDraft', { worktree: activeWorktree, number: currentReview.number, title: currentReview.title })
  }
  const saveTitle = async () => {
    if (!activeWorktree || !currentReview || titleInput.trim() === '') return
    const result = await runReviewMethod('checksSaveTitle', {
      worktree: activeWorktree,
      number: currentReview.number,
      expectedHead: currentReview.headRefOid,
      title: titleInput
    })
    if (isRecord(result) && result.updated === true) {
      setTitleEditing(false)
      setTitleInput('')
    }
  }
  const cancelTitle = () => {
    if (!activeWorktree || !currentReview) return
    setTitleEditing(false)
    setTitleInput('')
    void runReviewMethod('checksCancelTitle', { worktree: activeWorktree, number: currentReview.number })
  }

  const setHeight = useCallback((height: number) => {
    const bounded = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
    dragHeightRef.current = bounded
    setDragHeight(bounded)
  }, [])
  const commitHeight = useCallback(async (height: number) => {
    dragHeightRef.current = null
    setDragHeight(null)
    await runReviewMethod('checksSetHeight', { height })
  }, [runReviewMethod])
  const beginResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = active?.height ?? 320
    const onMove = (move: globalThis.MouseEvent) => setHeight(startHeight + startY - move.clientY)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragCleanup.current = null
      void commitHeight(dragHeightRef.current ?? active?.height ?? startHeight)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    dragCleanup.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }

  useEffect(() => () => dragCleanup.current?.(), [])

  if (!activeWorktree) {
    return <section className="quirky-reviews-checks" style={{ padding: 12 }}><h3>No workspace selected</h3><p>Select a workspace to view checks.</p></section>
  }
  if (!active || active.loading && !active.lookup && !active.review) {
    return <section className="quirky-reviews-checks" style={{ padding: 12 }} aria-busy="true"><p>Checking pull request status…</p>{actionError && <p role="alert">{actionError}</p>}</section>
  }
  if (!currentReview) {
    const empty = selectStatus(state, activeWorktree)
    const retrySeconds = retryDelay(lookup, countdownNow)
    const eligible = eligibilityIsCurrent(state, activeWorktree)
    const blocked = prioritizedBlocker(eligibility)
    const reason = blocked && typeof blocked.reason === 'string' ? blocked.reason : eligibility && typeof eligibility.reason === 'string' ? eligibility.reason : lookupReason(lookup)
    const blocker = blockerCopy(reason, blocked)
    const diagnosticData = authDiagnostics ?? (lookup && isRecord(lookup.authDiagnostics) ? lookup.authDiagnostics : eligibility && isRecord(eligibility.authDiagnostics) ? eligibility.authDiagnostics : null)
    const diagnosticError = lookup && typeof lookup.authDiagnosticsError === 'string' ? lookup.authDiagnosticsError : eligibility && typeof eligibility.authDiagnosticsError === 'string' ? eligibility.authDiagnosticsError : null
    const diagnostics = diagnosticsCopy(diagnosticData)
    const existingNumber = empty.existingNumber
    const busy = Boolean(active.loading)
    return (
      <section className="quirky-reviews-checks" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '100%', overflow: 'hidden' }}>
        {actionError && <p role="alert" style={{ color: 'var(--danger, #e5534b)', padding: '6px 10px', margin: 0 }}>{actionError}</p>}
        {active.error && <p role="alert" style={{ color: 'var(--danger, #e5534b)', padding: '6px 10px', margin: 0 }}>{active.error}</p>}
        <div style={{ padding: 12, overflow: 'auto' }}>
          <h3 style={{ margin: '0 0 6px' }}>{empty.title}</h3>
          <p style={{ margin: '0 0 10px' }}>{empty.message}</p>
          {empty.action && <button type="button" style={empty.action === 'open' || empty.action === 'relink' ? primaryButtonStyle : quietButtonStyle} disabled={busy} onClick={() => void runBlockerAction(empty.action!, existingNumber)}>
            {empty.action === 'open' ? `Open Review #${existingNumber ?? ''}` : empty.action === 'relink' ? `Link PR #${existingNumber ?? ''}` : empty.action === 'publish' ? 'Publish Branch' : empty.action === 'sync' ? 'Sync Branch' : empty.action === 'push' ? 'Push & Create PR' : 'Connect GitHub'}
          </button>}
          {reason === 'lookup_unavailable' && !eligibility && <p role="alert">The provider could not establish whether this branch has a review. No composer is available until lookup succeeds.</p>}
          {diagnostics.length > 0 && <section aria-label="GitHub CLI diagnostics"><h4>GitHub CLI diagnostics</h4><ul>{diagnostics.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {diagnosticError && <p role="alert">{diagnosticError}</p>}
          {diagnosticData && <section aria-label="GitHub account status" style={{ margin: '8px 0' }}>
            {typeof diagnosticData.requiredHost === 'string' && <p>Required host: <code>{diagnosticData.requiredHost}</code></p>}
            {Array.isArray(diagnosticData.accounts) && diagnosticData.accounts.length > 0 && <ul>
              {diagnosticData.accounts.filter(isRecord).map((account, index) => (
                <li key={`${String(account.host ?? '')}:${String(account.user ?? index)}`}>
                  {typeof account.user === 'string' ? account.user : 'Account'}{typeof account.host === 'string' ? ` · ${account.host}` : ''}
                  {typeof account.source === 'string' ? ` · ${account.source}` : ''}
                  {account.active === true ? ' · active' : ''}
                </li>
              ))}
            </ul>}
            {diagnosticData.ghAvailable === false && <p>GitHub CLI (gh) is unavailable. Install it, then retry.</p>}
            <button type="button" style={quietButtonStyle} onClick={() => void copyLink('gh auth status')}>Copy gh auth status</button>
          </section>}
          {reason === 'authentication_required' || reason === 'auth_required' || reason === 'not_authenticated' || reason === 'scope_missing' || reason === 'gh_unavailable'
            ? <p>Check GitHub access with <code>gh auth status</code>. Sign in with <code>gh auth login</code>; no token is entered or stored here.</p>
            : null}
          {eligibility?.eligible === true && !eligible && <p>Eligibility is stale or belongs to a different branch. Refresh to confirm the current workspace.</p>}
          {eligible && <button type="button" style={primaryButtonStyle} disabled={busy} onClick={() => void openComposer()}>Create PR</button>}
          {!eligible && eligibility?.eligible === true && <button type="button" disabled={busy} title={eligibilityDisabledReason(state, activeWorktree) ?? undefined}>Create PR</button>}
          <button type="button" style={quietButtonStyle} disabled={busy || retrySeconds !== null} onClick={() => void runRefresh('manual')}>
            {retrySeconds === null ? 'Retry' : `Retry in ${retrySeconds}s`}
          </button>
          {lookup?.kind === 'unavailable' && typeof lookup.message === 'string' && <p role="alert">{lookup.message}</p>}
        </div>
        <div role="separator" aria-orientation="horizontal" aria-label="Resize Checks panel" tabIndex={0}
          onMouseDown={beginResize}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              void commitHeight((active.height ?? 320) + (event.key === 'ArrowUp' ? 24 : -24))
            }
          }}
          style={{ height: 8, cursor: 'row-resize', borderTop: '1px solid var(--border, #2b2f3a)' }} />
      </section>
    )
  }

  const stack = stackModel(currentReview.stack)
  const reviewRetrySeconds = retryDelay(active.lookup, countdownNow)
  const editedTitle = titleEditing || typeof active.titleDraft === 'string'
  const checkRows = isRecord(active.checks) && Array.isArray(active.checks.checks) ? active.checks.checks : []
  const broken = checkRows.some((row) => isRecord(row) && (
    ['failure', 'error', 'startup_failure', 'timed_out', 'cancelled', 'action_required'].includes(String(row.conclusion ?? '').toLowerCase()) ||
    ['failure', 'error', 'action_required'].includes(String(row.status ?? '').toLowerCase())
  ))
  const localConflict = isRecord(active.conflicts) && (
    active.conflicts.status === 'loading' || active.conflicts.status === 'unavailable' ||
    active.conflicts.status === 'ready' && (
      active.conflicts.conflicting === true ||
      (Array.isArray(active.conflicts.files) && active.conflicts.files.length > 0) ||
      (Array.isArray(active.conflicts.localFiles) && active.conflicts.localFiles.length > 0)
    )
  )
  const hostConflict = currentReview.mergeable === 'CONFLICTING' || currentReview.mergeStateStatus === 'DIRTY'
  const queuedCount = active.queuedComments.length
  const contentHeight = dragHeight ?? active.height

  return (
    <section className="quirky-reviews-checks" style={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '100%', overflow: 'hidden', color: 'var(--text, #d7dae0)' }}>
      {active.error && <div role="alert" style={{ background: 'var(--danger, #e5534b)', color: '#fff', padding: '6px 10px' }}>{active.error}{currentReview ? ' Showing the last known review status.' : ''}</div>}
      {actionError && <p role="alert" style={{ color: 'var(--danger, #e5534b)', padding: '4px 10px', margin: 0 }}>{actionError}</p>}
      <header style={{ padding: '10px 12px', borderBottom: '1px solid var(--border, #2b2f3a)', display: 'grid', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
          <span aria-hidden="true">PR</span>
          <button type="button" style={quietButtonStyle} title="Open on GitHub; Shift+Cmd-click flips the configured destination" onClick={(event) => void openLink(currentReview.url, event)}>#{currentReview.number}</button>
          <span style={statusBadgeStyle(currentReview.state)}>{reviewStateName(currentReview.state)}</span>
          <button type="button" style={quietButtonStyle} aria-label="Copy PR link" onClick={() => void copyLink(currentReview.url)}>Copy link</button>
          <button type="button" style={quietButtonStyle} aria-label="Refresh checks" disabled={active.loading || reviewRetrySeconds !== null} title={reviewRetrySeconds === null ? 'Refresh checks' : `Retry is paused for ${reviewRetrySeconds}s`} onClick={() => void runRefresh('manual')}>{reviewRetrySeconds === null ? 'Refresh' : `Refresh paused (${reviewRetrySeconds}s)`}</button>
          <button type="button" style={quietButtonStyle} aria-label="More PR actions" aria-expanded={moreOpen} onClick={() => setMoreOpen((value) => !value)}>⋯</button>
        </div>
        <div style={{ display: 'flex', alignItems: 'start', justifyContent: 'space-between', gap: 8 }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            {editedTitle ? (
              <div style={{ display: 'flex', gap: 5 }}>
                <input aria-label="Pull request title" maxLength={256} value={titleInput} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelTitle()
                  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void saveTitle()
                  }
                }} onChange={(event) => {
                  const title = event.target.value
                  setTitleInput(title)
                  void runReviewMethod('checksSetTitleDraft', { worktree: activeWorktree, number: currentReview.number, title }, false)
                }} />
                <button type="button" aria-label="Save pull request title" disabled={active.loading || titleInput.trim() === ''} onClick={() => void saveTitle()}>✓</button>
                <button type="button" aria-label="Cancel title edit" disabled={active.loading} onClick={cancelTitle}>×</button>
              </div>
            ) : (
              <button type="button" style={{ ...quietButtonStyle, padding: 0, border: 0, textAlign: 'left', fontSize: 14, fontWeight: 650 }} aria-label="Edit pull request title" onClick={startTitleEdit}>{currentReview.title}</button>
            )}
            <div className="muted" style={{ fontSize: 11 }}>{currentReview.baseRefName} ← {currentReview.headRefName}{reviewDate(currentReview) ? ` · ${reviewDate(currentReview)}` : ''}</div>
          </div>
          <span className="muted" title={activeWorktree}>Workspace</span>
        </div>
        {moreOpen && <div role="menu" style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button type="button" role="menuitem" style={quietButtonStyle} onClick={() => void runReviewMethod('checksUnlink', { worktree: activeWorktree })}>Unlink PR from workspace</button>
          <button type="button" role="menuitem" style={quietButtonStyle} onClick={() => { setLinkOpen(true); setMoreOpen(false) }}>Link another PR</button>
        </div>}
        {linkOpen && <form onSubmit={(event) => void linkAnother(event)} style={{ display: 'flex', gap: 6 }}>
          <label style={{ flex: 1 }}>Pull request number <input aria-label="Pull request number" inputMode="numeric" value={linkNumber} onChange={(event) => setLinkNumber(event.target.value)} /></label>
          <button type="submit" style={primaryButtonStyle}>Link PR</button>
          <button type="button" style={quietButtonStyle} onClick={() => setLinkOpen(false)}>Cancel</button>
        </form>}
      </header>

      {stack && <section aria-label="Pull request stack" style={{ padding: '7px 12px', borderBottom: '1px solid var(--border, #2b2f3a)' }}>
        {stack.available ? (
          <>
            <div style={{ fontSize: 11, fontWeight: 600 }}>Stack #{stack.number} · PR #{currentReview.number} at position {stack.position} of {stack.size}</div>
            <ol style={{ display: 'flex', gap: 8, listStyle: 'none', padding: 0, margin: '6px 0 0', alignItems: 'center', flexWrap: 'wrap' }}>
              {stack.entries.map((entry) => (
                <li key={String(entry.number)}>
                  <button type="button" style={quietButtonStyle} aria-current={entry.number === currentReview.number ? 'page' : undefined}
                    disabled={typeof entry.url !== 'string'} onClick={(event) => typeof entry.url === 'string' && void openLink(entry.url, event)}>
                    #{String(entry.number)} · {String(entry.title ?? 'Pull request')}
                  </button>
                </li>
              ))}
            </ol>
            {stack.truncated && <p className="muted" style={{ fontSize: 10 }}>Showing the first 100 stack members.</p>}
          </>
        ) : <p role="status" className="muted">{stack.message}</p>}
      </section>}

      <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border, #2b2f3a)' }}>
        <ReviewActions {...props} surface="checks" />
      </div>

      {(hostConflict || localConflict) && <section aria-label="Merge conflicts" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border, #2b2f3a)' }}>
        <strong>Conflicts block this PR</strong>
        {active.conflicts?.status === 'loading' && <p>Loading conflict paths…</p>}
        {active.conflicts?.status === 'unavailable' && <p>{typeof active.conflicts.message === 'string' ? active.conflicts.message : 'Conflict paths are unavailable from the read-only preview.'}</p>}
        {active.conflicts?.available === true && active.conflicts.conflicting === false && <p>Git’s read-only preview found no conflicting paths; refresh the review metadata before merging.</p>}
        {Array.isArray(active.conflicts?.files) && active.conflicts.files.length > 0 && <ul>{active.conflicts.files.map((file, index) => <li key={isRecord(file) && typeof file.path === 'string' ? file.path : index}>{isRecord(file) && typeof file.path === 'string' ? file.path : 'Conflicting file'}</li>)}</ul>}
        {Array.isArray(active.conflicts?.localFiles) && active.conflicts.localFiles.length > 0 && <div><strong>Active workspace conflicts</strong><ul>{active.conflicts.localFiles.map((file, index) => <li key={isRecord(file) && typeof file.path === 'string' ? file.path : index}>{isRecord(file) && typeof file.path === 'string' ? file.path : 'Conflicting file'}</li>)}</ul></div>}
        {active.conflicts?.truncated === true && <p className="muted">Conflict file list is truncated at 100 entries.</p>}
      </section>}

      {(hostConflict || broken || pending || queuedCount > 0) && <section aria-label="Review triage" style={{ padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, borderBottom: '1px solid var(--border, #2b2f3a)' }}>
        <span>{hostConflict ? 'Conflicts block this PR' : broken ? 'Failing checks' : pending ? 'Checks pending' : `${queuedCount} queued comments`}</span>
        {hostConflict || localConflict ? (
          <button type="button" style={primaryButtonStyle} onClick={() => void runReviewMethod('checksSetAgentDialog', { surface: 'checks', action: 'conflicts' })}>Resolve</button>
        ) : broken ? (
          <button type="button" style={primaryButtonStyle} onClick={() => void runReviewMethod('checksSetAgentDialog', { surface: 'checks', action: 'fix' })}>Fix</button>
        ) : queuedCount > 0 ? (
          <button type="button" style={primaryButtonStyle} onClick={() => void runReviewMethod('checksSetAgentDialog', { surface: 'checks', action: 'comments' })}>Resolve {queuedCount} Comments With AI</button>
        ) : <span className="muted">Orca will refresh checks while this panel stays open.</span>}
      </section>}

      <div style={{ minHeight: 0, flex: '1 1 auto', height: contentHeight, maxHeight: '72vh', overflow: 'auto', padding: 10 }}>
        <ChecksList {...props} surface="checks" />
        <Comments {...props} surface="checks" />
      </div>
      {isRecord(active.conflicts) && active.conflicts.status === 'ready' && active.conflicts.truncated === true && <p className="muted">Conflict file list is truncated at 100 entries.</p>}
      {isRecord(active.checks) && active.checks.truncated === true && <p className="muted">Showing the first 100 checks.</p>}
      {isRecord(active.comments) && active.comments.truncated === true && <p className="muted">Showing the first 100 comments.</p>}
      {active.error && <p role="alert" style={{ color: 'var(--danger, #e5534b)', padding: '4px 10px', margin: 0 }}>{active.error}</p>}
      {actionError && <p role="alert" style={{ color: 'var(--danger, #e5534b)', padding: '4px 10px', margin: 0 }}>{actionError}</p>}
      <div role="separator" aria-orientation="horizontal" aria-label="Resize Checks panel" tabIndex={0}
        onMouseDown={beginResize}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            void commitHeight((active.height ?? 320) + (event.key === 'ArrowUp' ? 24 : -24))
          }
        }}
        style={{ height: 8, flex: '0 0 8px', cursor: 'row-resize', borderTop: '1px solid var(--border, #2b2f3a)' }} />
    </section>
  )
}
