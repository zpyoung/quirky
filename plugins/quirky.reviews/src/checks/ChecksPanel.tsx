import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { UiLayout, UiPluginContext } from '@quirky/protocol'
import { Badge, Button, ControlIcon, Dialog, EmptyState, FormRow, IconButton, InlineError, Menu, NoticeLine, SectionHeader, TextField, ToolPanelFrame } from '@quirky/ui'
import { CHECKS_PANEL, REVIEW_VIEW, type JsonRecord, type ReviewData, type ReviewsSurfaceProps } from '../contracts'
import {
  copyReviewsText,
  isRecord,
  registerReviewsUiControl,
  requestReviewsUiControl,
  type ReviewsUiControlRequest,
} from './data'
import { SitterRow, SitterSafetyStrip } from './SitterRow'
import type { ChecksSitterState, SitterDetail, SitterFleetRow } from './data'
import { parseRepoIdentity, reviewContext, safeHttpUrl, type RepoIdentity } from '../detail/data'
import { useDraftField, type DraftAction } from '../draft-field'
import { ReviewActions } from '../detail/Actions'
import { ChecksList } from '../detail/ChecksList'
import { Comments } from '../detail/Comments'
import { useReviewLinkRouting } from '../link-routing'

const UNAVAILABLE_CHECKS_SITTER_STATE: ChecksSitterState = {
  available: false,
  sitter: null,
  detail: null,
  activeCount: 0,
  otherActiveCount: 0,
}

function isSitterFleetRow(value: unknown): value is SitterFleetRow {
  if (!isRecord(value) || !isRecord(value.target) || typeof value.target.watcherId !== 'string') return false
  if (!isRecord(value.enrollment) || value.enrollment.kind !== 'hosted-review') return false
  if (!isRecord(value.enrollment.capabilities) || !isRecord(value.enrollment.budget) || !isRecord(value.enrollment.kindPayload)) return false
  if (value.enrollment.worktreeId !== undefined && value.enrollment.worktreeId !== null && typeof value.enrollment.worktreeId !== 'string') return false
  return isRecord(value.status) && typeof value.status.state === 'string' && Array.isArray(value.openEscalations)
}

function checksSitterState(value: unknown): ChecksSitterState {
  if (!isRecord(value) || value.available !== true) return UNAVAILABLE_CHECKS_SITTER_STATE
  if (typeof value.activeCount !== 'number' || !Number.isFinite(value.activeCount)) return UNAVAILABLE_CHECKS_SITTER_STATE
  if (typeof value.otherActiveCount !== 'number' || !Number.isFinite(value.otherActiveCount)) return UNAVAILABLE_CHECKS_SITTER_STATE
  if (value.sitter !== null && !isSitterFleetRow(value.sitter)) return UNAVAILABLE_CHECKS_SITTER_STATE
  const detail = value.detail !== null && isRecord(value.detail) && Array.isArray(value.detail.journal) && Array.isArray(value.detail.openEscalations)
    ? value.detail as unknown as SitterDetail
    : null
  return {
    available: true,
    sitter: value.sitter as SitterFleetRow | null,
    detail,
    activeCount: value.activeCount,
    otherActiveCount: value.otherActiveCount,
  }
}

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
type ReviewsControlAction = { action: string; enabled: boolean }

function reviewsControlTarget(
  surface: string,
  slot: string,
  worktree: string | null,
  repo: RepoIdentity | null,
  number: number | null,
  headOid: string | null,
  dialogAction: string | null = null,
): string {
  return JSON.stringify([
    surface,
    slot,
    worktree,
    repo === null ? null : { host: repo.host, owner: repo.owner, repo: repo.repo },
    number,
    headOid,
    dialogAction,
  ])
}

function controlDeliveryError(result: { delivered: false; reason: 'target-unavailable' | 'disabled' | 'unknown-action' }): string {
  if (result.reason === 'disabled') return 'This action is not currently available.'
  if (result.reason === 'unknown-action') return 'This action is no longer supported by the mounted view.'
  return 'This control is no longer available.'
}

function controlValue(request: ReviewsUiControlRequest, allowed: readonly string[]): JsonRecord {
  const value = request.value
  if (value === undefined) return {}
  if (!isRecord(value) || Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error('Invalid Reviews control arguments.')
  }
  return value
}

function useReviewsUiControl(options: {
  context: UiPluginContext
  surface: string
  slot: string
  worktree: string | null
  repo: RepoIdentity | null
  number: number | null
  headOid: string | null
  dialogAction?: string | null
  active: boolean
  actions(): ReviewsControlAction[]
  run(request: ReviewsUiControlRequest, isCurrent: () => boolean): unknown | Promise<unknown>
  onError?(message: string): void
}) {
  const target = reviewsControlTarget(
    options.surface,
    options.slot,
    options.worktree,
    options.repo,
    options.number,
    options.headOid,
    options.dialogAction ?? null,
  )
  const actionsRef = useRef(options.actions)
  const runRef = useRef(options.run)
  const errorRef = useRef(options.onError)
  useLayoutEffect(() => {
    actionsRef.current = options.actions
    runRef.current = options.run
    errorRef.current = options.onError
  })
  const registrationRef = useRef<{
    target: string
    generation: number
    changed(): void
    dispose(): void
  } | null>(null)
  const [reported, setReported] = useState<{ target: string; generation: number } | null>(null)
  const actionsKey = JSON.stringify(options.actions())

  useLayoutEffect(() => {
    if (!options.active) {
      registrationRef.current = null
      setReported(null)
      return
    }
    const registration = registerReviewsUiControl(options.context, {
      surface: options.surface,
      slot: options.slot,
      target,
      actions: () => actionsRef.current(),
      run: (request, isCurrent) => {
        const operation = runRef.current(request, isCurrent)
        if (operation instanceof Promise) {
          void operation.catch((failure) => {
            if (isCurrent()) errorRef.current?.(messageOf(failure))
          })
        }
      },
    })
    const lease = { target, generation: registration.generation, changed: registration.changed, dispose: registration.dispose }
    registrationRef.current = lease
    setReported({ target, generation: registration.generation })
    return () => {
      registration.dispose()
      if (registrationRef.current === lease) registrationRef.current = null
    }
  }, [options.active, options.context, options.slot, options.surface, target])

  useEffect(() => {
    const lease = registrationRef.current
    if (options.active && lease?.target === target) lease.changed()
  }, [actionsKey, options.active, target])

  async function request(action: string, value?: Record<string, unknown>) {
    const lease = registrationRef.current
    if (!options.active || lease === null || lease.target !== target) return null
    const controlRequest: ReviewsUiControlRequest = {
      target,
      generation: lease.generation,
      action,
      ...(value === undefined ? {} : { value }),
    }
    try {
      const result = await requestReviewsUiControl(options.context, controlRequest)
      if (!result.delivered && registrationRef.current === lease) errorRef.current?.(controlDeliveryError(result))
      return result
    } catch (error) {
      if (registrationRef.current === lease) errorRef.current?.(messageOf(error, 'The local action could not be delivered.'))
      return null
    }
  }

  return {
    target,
    generation: options.active && reported?.target === target ? reported.generation : undefined,
    request,
  }
}

function layoutWorktree(layout: UiLayout): string | null {
  const worktree = layout.worktree
  return typeof worktree === 'string' && worktree.trim() !== '' ? worktree : null
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
  if (!lookup || lookup.kind === 'suppressed' || lookup.kind === 'folder' || lookup.kind === 'git-operation' ||
      lookup.kind === 'blocked' || lookup.kind === 'unsupported' && lookup.reason === 'missing_origin') return null
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


type StackMap = {
  available: boolean
  loading: boolean
  number?: number
  position?: number
  size?: number
  entries: JsonRecord[]
  truncated: boolean
  message?: string
}

function stackModel(value: unknown): StackMap | null {
  if (!isRecord(value)) return null
  const number = positiveNumber(String(value.number ?? ''))
  const position = positiveNumber(String(value.position ?? ''))
  const size = positiveNumber(String(value.size ?? ''))
  const reason = typeof value.reason === 'string' ? value.reason : null
  const status = typeof value.status === 'string' ? value.status : null
  if (value.available !== true || !Array.isArray(value.entries)) {
    const failed = reason === 'stack_unavailable' || reason === 'stack_mismatch' || status === 'error' || status === 'unavailable'
    const loading = !failed && (status === 'loading' || status === 'pending' || reason === 'loading' || reason === 'pending' || reason === 'stack_loading'
      || value.available === undefined && number !== null && position !== null && size !== null)
    const fallback = loading
      ? 'Loading the canonical stack member list…'
      : reason === 'stack_unavailable'
        ? 'The public hosting API could not load this stack.'
        : reason === 'stack_mismatch'
          ? 'The provider stack did not match the selected pull request.'
          : 'The canonical stack could not be loaded.'
    return {
      available: false,
      loading,
      ...(number ? { number } : {}),
      ...(position ? { position } : {}),
      ...(size ? { size } : {}),
      entries: [],
      truncated: value.truncated === true,
      message: typeof value.message === 'string' && value.message.trim() !== '' ? value.message : fallback,
    }
  }
  if (!number || !position || !size) {
    return { available: false, loading: false, entries: [], truncated: false, message: 'The canonical stack response is incomplete.' }
  }
  return {
    available: true,
    loading: false,
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
  if (lookup?.kind === 'unsupported' && lookup.reason === 'missing_origin') {
    return {
      title: 'GitHub origin required',
      message: typeof lookup.message === 'string' ? lookup.message : 'Add a GitHub origin remote to this worktree to load its pull request checks.'
    }
  }
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
  const publicSurface = surface === 'checks' ? CHECKS_PANEL : REVIEW_VIEW
  const visible = dialog !== null && dialog.visible !== false
  const rawTarget = dialog && isRecord(dialog.target) ? dialog.target : null
  const worktree = rawTarget && typeof rawTarget.worktree === 'string' && rawTarget.worktree.trim() !== '' ? rawTarget.worktree : null
  const number = rawTarget && positiveNumber(String(rawTarget.number ?? '')) ? Number(rawTarget.number) : null
  const action = dialog?.action === 'conflicts' || dialog?.action === 'comments' ? dialog.action : 'fix'
  const selectedReview = surface === 'checks' ? state.checks.review : state.detail.review
  const selectedWorktree = surface === 'checks' ? state.checks.worktree : state.detail.target?.worktree ?? null
  const selectedOwner = reviewContext(state, surface)
  const selectedHead = selectedReview?.headRefOid ?? null
  const dialogHead = dialog && typeof dialog.headOid === 'string' ? dialog.headOid : null
  const matchingTarget = worktree !== null && worktree === selectedWorktree
    && number !== null && selectedReview?.number === number
    && (dialogHead === null || dialogHead === selectedHead)
  const targetKey = reviewsControlTarget(publicSurface, 'agent', worktree, selectedOwner?.repo ?? null, number, dialogHead, action)
  const originalPrompt = dialogPrompt(dialog)
  const [prompt, setPrompt] = useState(originalPrompt)
  const [agent, setAgent] = useState(dialog && typeof dialog.agent === 'string' ? dialog.agent : '')
  const [args, setArgs] = useState(dialog && typeof dialog.args === 'string' ? dialog.args : '')
  const [agents, setAgents] = useState<JsonRecord[]>([])
  const [defaultAgent, setDefaultAgent] = useState('')
  const [loadingAgents, setLoadingAgents] = useState(visible)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const startingRef = useRef<object | null>(null)
  const busyRef = useRef(false)
  const targetKeyRef = useRef(targetKey)
  targetKeyRef.current = targetKey
  const promptRef = useRef<HTMLTextAreaElement>(null)
  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const configuredAgent = defaultAgent !== 'auto' && defaultAgent !== 'shell' && agents.some((entry) => entry.id === defaultAgent)
    ? defaultAgent
    : undefined
  const markedAgent = agents.find((entry) => entry.isDefault === true)
  const markedAgentId = typeof markedAgent?.id === 'string' ? markedAgent.id : undefined
  const firstAgentId = typeof agents[0]?.id === 'string' ? agents[0].id : ''
  const selectedAgent = agent || configuredAgent || markedAgentId || firstAgentId
  const draftRef = useRef({ prompt, agent: selectedAgent, args })
  draftRef.current = { prompt, agent: selectedAgent, args }
  const persistTarget = useRef<{
    surface: 'checks' | 'detail'
    worktree: string | null
    number: number | null
    action: string
    prRepo?: JsonRecord
  } | null>(null)
  const currentPrRepo = selectedReview ? currentReviewPrRepo(selectedReview) : undefined
  persistTarget.current = { surface, worktree, number, action, ...(currentPrRepo ? { prRepo: currentPrRepo } : {}) }

  useEffect(() => {
    setPrompt(originalPrompt)
    setAgent(dialog && typeof dialog.agent === 'string' ? dialog.agent : '')
    setArgs(dialog && typeof dialog.args === 'string' ? dialog.args : '')
    setCatalogError(null)
    setError(null)
    setAgents([])
    setDefaultAgent('')
    startingRef.current = null
    busyRef.current = false
    setBusy(false)
  }, [targetKey])

  useEffect(() => {
    if (!visible) {
      setLoadingAgents(false)
      return
    }
    let active = true
    setLoadingAgents(true)
    setCatalogError(null)
    setAgents([])
    setDefaultAgent('')
    context.call('quirky.agents/list').then((value) => {
      if (!active) return
      const result = createAgentList(value)
      setAgents(result.agents)
      setDefaultAgent(result.defaultAgent)
    }).catch((failure: unknown) => {
      if (active) setCatalogError(messageOf(failure, 'Could not detect enabled agents.'))
    }).finally(() => {
      if (active) setLoadingAgents(false)
    })
    return () => { active = false }
  }, [context, visible, targetKey])

  const persist = useCallback(async (nextPrompt: string, nextAgent: string, nextArgs: string): Promise<boolean> => {
    const current = persistTarget.current
    if (!current || !current.worktree || current.number === null) return false
    const params: JsonRecord = {
      surface: current.surface,
      worktree: current.worktree,
      number: current.number,
      action: current.action,
      prompt: nextPrompt,
      ...(nextAgent ? { agent: nextAgent } : {}),
      args: nextArgs,
      ...(current.prRepo ? { prRepo: current.prRepo } : {})
    }
    await context.call('quirky.reviews/checksSetAgentDialog', params)
    return true
  }, [context])

  const canStartAgent = () => {
    const draft = draftRef.current
    return visible && dialog !== null && matchingTarget && !loadingAgents && catalogError === null
      && !busyRef.current && startingRef.current === null
      && agents.some((entry) => entry.id === draft.agent)
      && draft.prompt.trim() !== ''
  }

  const finishDraftTimer = () => {
    if (persistTimer.current === null) return
    clearTimeout(persistTimer.current)
    persistTimer.current = null
  }

  useEffect(() => {
    if (!visible || !matchingTarget) return
    const scheduledTarget = targetKey
    finishDraftTimer()
    persistTimer.current = setTimeout(() => {
      persistTimer.current = null
      if (targetKeyRef.current !== scheduledTarget) return
      const draft = draftRef.current
      void persist(draft.prompt, draft.agent, draft.args).catch((failure: unknown) => {
        if (targetKeyRef.current === scheduledTarget) setError(messageOf(failure))
      })
    }, 200)
    return finishDraftTimer
  }, [args, matchingTarget, persist, prompt, selectedAgent, targetKey, visible])

  const runClose = async (isCurrent: () => boolean) => {
    if (!isCurrent() || busyRef.current) return
    busyRef.current = true
    const token = {}
    startingRef.current = token
    setBusy(true)
    finishDraftTimer()
    const draft = draftRef.current
    try {
      await persist(draft.prompt, draft.agent, draft.args)
      if (!isCurrent()) return
      await context.call('quirky.reviews/checksSetAgentDialog', { action: 'hide', surface })
      if (!isCurrent()) return
      await refresh()
    } catch (failure) {
      if (isCurrent()) setError(messageOf(failure))
    } finally {
      if (startingRef.current === token) {
        startingRef.current = null
        busyRef.current = false
        if (targetKeyRef.current === targetKey) setBusy(false)
      }
    }
  }

  const runStart = async (isCurrent: () => boolean) => {
    if (!isCurrent() || !canStartAgent()) return
    const token = {}
    startingRef.current = token
    busyRef.current = true
    setBusy(true)
    setError(null)
    finishDraftTimer()
    const draft = draftRef.current
    try {
      const saved = await persist(draft.prompt, draft.agent, draft.args)
      if (!isCurrent() || !saved) return
      const result = await context.call('quirky.reviews/checksLaunchAgent', {
        worktree,
        agent: draft.agent,
        ...(draft.args ? { args: draft.args } : {})
      })
      if (!isCurrent()) return
      const outcome = isRecord(result) ? result : null
      if (outcome?.delivered !== true) {
        setError(typeof outcome?.error === 'string' ? outcome.error : 'The agent prompt was not delivered.')
      }
      if (isCurrent()) await refresh()
    } catch (failure) {
      if (isCurrent()) {
        setError(messageOf(failure))
        await refresh().catch(() => undefined)
      }
    } finally {
      if (startingRef.current === token) {
        startingRef.current = null
        busyRef.current = false
        if (targetKeyRef.current === targetKey) setBusy(false)
      }
    }
  }

  const agentControl = useReviewsUiControl({
    context,
    surface: publicSurface,
    slot: 'agent',
    worktree,
    repo: selectedOwner?.repo ?? null,
    number,
    headOid: selectedHead,
    dialogAction: action,
    active: visible && dialog !== null,
    actions: () => [
      { action: 'agent-start', enabled: canStartAgent() },
      { action: 'agent-cancel', enabled: visible && dialog !== null && !busyRef.current },
    ],
    onError: setError,
    run: (request, isCurrent) => {
      if (request.value !== undefined) throw new Error('Agent actions do not accept extra values.')
      if (request.action === 'agent-start') return runStart(isCurrent)
      if (request.action === 'agent-cancel') return runClose(isCurrent)
      throw new Error('Unknown agent dialog action.')
    },
  })
  const agentControlRef = useRef(agentControl)
  useLayoutEffect(() => { agentControlRef.current = agentControl })
  const requestAgentControl = (action: string) => agentControlRef.current.request(action)

  useEffect(() => {
    if (!visible) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        void requestAgentControl('agent-start')
      }
    }
    document.addEventListener('keydown', onKeyDown)
    promptRef.current?.focus()
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [targetKey, visible])

  if (!visible || !dialog) return null
  const title = action === 'conflicts' ? 'Resolve Review Conflicts With AI' : action === 'comments' ? 'Resolve Comments With AI' : 'Fix With AI'
  return <Dialog
    open={visible}
    title={title}
    onClose={() => { void requestAgentControl('agent-cancel') }}
    closeOnBackdrop={false}
    actions={<div className="ui-cluster">
      <Button disabled={busy} onClick={() => { void requestAgentControl('agent-cancel') }}>Cancel</Button>
      <Button variant="primary" disabled={!canStartAgent()} onClick={() => { void requestAgentControl('agent-start') }}>
        {busy ? 'Starting…' : 'Start agent'}
      </Button>
    </div>}
  >
    <div
      className="ui-stack"
      data-review-control-target={agentControl.target}
      data-review-control-generation={agentControl.generation}
    >
      <p className="ui-text-muted">PR #{number} · {contextTargetLabel(state, surface)}</p>
      {loadingAgents && <NoticeLine>Detecting agents…</NoticeLine>}
      {!loadingAgents && !catalogError && agents.length === 0 && <EmptyState message="No enabled agents" />}
      {(catalogError ?? error) && <InlineError message={catalogError ?? error!} />}
      <FormRow label="Agent" htmlFor="reviews-agent-select">
        <select
          id="reviews-agent-select"
          className="ui-text-field__input"
          aria-label="Agent"
          value={selectedAgent}
          disabled={busy || loadingAgents || catalogError !== null || agents.length === 0}
          onChange={(event) => {
            draftRef.current = { ...draftRef.current, agent: event.target.value }
            setAgent(event.target.value)
          }}
        >
          {agents.length === 0 && <option value="">{loadingAgents ? 'Detecting agents…' : 'No enabled agents'}</option>}
          {agents.map((entry) => <option key={String(entry.id)} value={String(entry.id)}>{String(entry.label ?? entry.id)}</option>)}
        </select>
      </FormRow>
      <FormRow label="Prompt" htmlFor="reviews-agent-prompt">
        <textarea
          id="reviews-agent-prompt"
          className="ui-text-field__input"
          ref={promptRef}
          aria-label="Agent prompt"
          rows={9}
          maxLength={MAX_PROMPT_LENGTH}
          value={prompt}
          disabled={busy}
          onChange={(event) => {
            draftRef.current = { ...draftRef.current, prompt: event.target.value }
            setPrompt(event.target.value)
          }}
        />
      </FormRow>
      <TextField
        id="reviews-agent-args"
        label="CLI arguments"
        aria-label="CLI arguments"
        value={args}
        maxLength={MAX_AGENT_ARGS_LENGTH}
        disabled={busy}
        onChange={(event) => {
          draftRef.current = { ...draftRef.current, args: event.target.value }
          setArgs(event.target.value)
        }}
      />
      <p className="ui-text-muted">Cmd/Ctrl+Enter starts the selected agent after it is ready.</p>
    </div>
  </Dialog>
}

function contextTargetLabel(state: ReviewsSurfaceProps['state'], surface: 'checks' | 'detail'): string {
  const target = surface === 'checks' ? state.checks.worktree : state.detail.target?.worktree
  return target ?? 'Workspace unavailable'
}

export function ChecksPanel(props: ReviewsSurfaceProps) {
  const { context, state, refresh } = props
  const routing = useReviewLinkRouting(context)
  const [layout, setLayout] = useState<UiLayout>(() => context.getLayout())
  const [windowVisible, setWindowVisible] = useState(() => typeof document === 'undefined' || document.visibilityState === 'visible')
  const [actionError, setActionError] = useState<string | null>(null)
  const [sitterState, setSitterState] = useState<ChecksSitterState | null>(null)
  const [sitterDetailLoading, setSitterDetailLoading] = useState(false)
  const [authDiagnostics, setAuthDiagnostics] = useState<JsonRecord | null>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkNumber, setLinkNumber] = useState('')
  const linkNumberRef = useRef('')
  const [dragHeight, setDragHeight] = useState<number | null>(null)
  const dragHeightRef = useRef<number | null>(null)
  const [countdownNow, setCountdownNow] = useState(Date.now())
  const previousPending = useRef<boolean | null>(null)
  const pollController = useRef<ChecksPollingController | null>(null)
  const panelEntryWorktree = useRef<string | null>(null)
  const entryRefreshWorktrees = useRef(new Set<string>())
  const mounted = useRef(true)
  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  const pollPolicy = useRef<ChecksPollingPolicy>(createChecksPollingPolicy())
  const dragCleanup = useRef<(() => void) | null>(null)
  const activeWorktree = useMemo(() => layoutWorktree(layout), [layout])
  const activeWorktreeRef = useRef(activeWorktree)
  activeWorktreeRef.current = activeWorktree
  const sitterRequestEpoch = useRef(0)
  const sitterIncludeDetail = useRef(false)
  const active = state.checks.worktree === activeWorktree ? state.checks : null
  const refreshSitter = useCallback(async (includeDetail = sitterIncludeDetail.current) => {
    const worktree = activeWorktreeRef.current
    const epoch = ++sitterRequestEpoch.current
    sitterIncludeDetail.current = includeDetail
    setSitterDetailLoading(includeDetail)
    const params = worktree === null ? { includeDetail } : { worktree, includeDetail }
    try {
      const result = checksSitterState(await context.call('quirky.reviews/checksSitterGet', params))
      if (epoch !== sitterRequestEpoch.current || activeWorktreeRef.current !== worktree || !mounted.current) return
      setSitterState(result)
    } catch {
      if (epoch === sitterRequestEpoch.current && activeWorktreeRef.current === worktree && mounted.current) {
        setSitterState(UNAVAILABLE_CHECKS_SITTER_STATE)
      }
    } finally {
      if (epoch === sitterRequestEpoch.current && activeWorktreeRef.current === worktree && mounted.current) {
        setSitterDetailLoading(false)
      }
    }
  }, [context])

  useEffect(() => {
    void refreshSitter(false)
    return () => { sitterRequestEpoch.current += 1 }
  }, [activeWorktree, refreshSitter])

  useEffect(() => context.subscribe((event) => {
    if (event.type === 'quirky.heimdall/fleetChanged') void refreshSitter()
  }), [context, refreshSitter])
  const currentReview = active?.review ?? null
  const titleOwner = active === null ? null : reviewContext(state, 'checks')
  const titleIdentity = titleOwner === null
    ? `checks|${activeWorktree ?? ''}|none|${currentReview?.headRefOid ?? ''}`
    : `${titleOwner.worktree}|${titleOwner.number}|${titleOwner.repo?.host ?? ''}/${titleOwner.repo?.owner ?? ''}/${titleOwner.repo?.repo ?? ''}|${currentReview?.headRefOid ?? ''}`
  const titleField = useDraftField<string | null>({
    identity: titleIdentity,
    remote: active?.titleDraft ?? null,
    snapshot: props.snapshot,
    write: async (title) => {
      if (titleOwner === null) return false
      const target = {
        worktree: titleOwner.worktree,
        number: titleOwner.number,
        generation: titleOwner.generation,
        ...(titleOwner.repo === null ? {} : { prRepo: titleOwner.repo }),
      }
      if (title === null) await context.call('quirky.reviews/checksCancelTitle', target)
      else await context.call('quirky.reviews/checksSetTitleDraft', { ...target, title })
    },
    refresh,
    resend: true,
  })
  const titleEditing = titleField.value !== null
  const titleInput = titleField.value ?? ''
  const titleSaveAction = useRef<DraftAction<string | null> | null>(null)
  const lookup = active && isRecord(active.lookup) ? active.lookup : null
  const onStoppedAll = () => refreshSitter(sitterIncludeDetail.current)
  const onRefreshSitter = refreshSitter
  const sitterSafetyStrip = sitterState?.available ? <SitterSafetyStrip
    context={context}
    sitterState={sitterState}
    onStoppedAll={onStoppedAll}
  /> : null
  const sitterRow = sitterState?.available ? <SitterRow
    context={context}
    activeWorktree={activeWorktree}
    review={currentReview}
    lookup={lookup}
    sitterState={sitterState}
    loadingDetail={sitterDetailLoading}
    onRefreshSitter={onRefreshSitter}
  /> : null
  const missingOrigin = lookup?.kind === 'unsupported' && lookup.reason === 'missing_origin'
  const eligibility = active && isRecord(active.eligibility) ? active.eligibility : null
  const currentTarget = useMemo(() => pollTarget(state, activeWorktree), [state.checks, activeWorktree])
  const currentTargetRef = useRef<ChecksPollingTarget | null>(currentTarget)
  currentTargetRef.current = currentTarget
  const pending = currentTarget?.pending ?? false
  const isPanelVisible = Object.values(layout.tools?.open ?? {}).includes(CHECKS_PANEL) && windowVisible
  useEffect(() => {
    setAuthDiagnostics(null)
    setActionError(null)
  }, [activeWorktree])

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => context.onLayout(setLayout), [context])

  useEffect(() => {
    if (typeof document === 'undefined') return
    const changed = () => setWindowVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', changed)
    return () => document.removeEventListener('visibilitychange', changed)
  }, [])

  useEffect(() => {
    if (!isPanelVisible) {
      panelEntryWorktree.current = null
      return
    }
    const enteringWorktree = panelEntryWorktree.current !== activeWorktree
    panelEntryWorktree.current = activeWorktree
    if (!activeWorktree || !enteringWorktree) return
    if (entryRefreshWorktrees.current.has(activeWorktree)) return
    if (state.checks.worktree === activeWorktree) {
      if (!missingOrigin) return
      setActionError(null)
    }
    const stillActive = () => mounted.current && activeWorktreeRef.current === activeWorktree
    entryRefreshWorktrees.current.add(activeWorktree)
    context.call('quirky.reviews/checksRefresh', { worktree: activeWorktree, force: true }).then(async (result) => {
      if (!stillActive()) return
      await refreshRef.current()
      if (!stillActive()) return
      if (!isRecord(result) || result.ok !== true) {
        if (isRecord(result) && result.stale === true) return
        setActionError(presentationError(result) ?? 'The review could not be refreshed.')
      }
    }).catch((error: unknown) => {
      if (stillActive()) setActionError(messageOf(error))
    }).finally(() => {
      entryRefreshWorktrees.current.delete(activeWorktree)
    })
  }, [activeWorktree, context, isPanelVisible, missingOrigin])

  const runRefresh = useCallback(async (
    reason: 'manual' | 'active',
    worktree = activeWorktree,
    leaseCurrent?: () => boolean,
  ): Promise<boolean> => {
    if (!worktree) return false
    const stillActive = () => mounted.current && activeWorktreeRef.current === worktree && (leaseCurrent?.() ?? true)
    if (!stillActive()) return false
    setActionError(null)
    const current = currentTargetRef.current
    const candidate: JsonRecord = current?.worktree === worktree ? current.candidate : { worktree, active: true }
    try {
      const queued = await context.call('quirky.hosting/refresh', { candidate, reason, priority: 80 })
      if (!stillActive()) return false
      const queueResult = isRecord(queued) ? queued : null
      const queuedError = queueResult && (queueResult.kind === 'paused' || queueResult.kind === 'unavailable')
        ? typeof queueResult.message === 'string' ? queueResult.message : `GitHub refresh ${String(queueResult.kind)}.`
        : null
      const result = await context.call('quirky.reviews/checksRefresh', { worktree, force: true })
      if (!stillActive()) return false
      const stale = isRecord(result) && result.stale === true
      const failed = !stale && (!isRecord(result) || result.ok !== true)
      if (failed) setActionError(presentationError(result) ?? queuedError ?? 'The review could not be refreshed.')
      else if (queuedError) setActionError(queuedError)
      await refreshRef.current()
      if (!stillActive()) return false
      return !failed && queuedError === null
    } catch (error) {
      if (stillActive()) setActionError(messageOf(error))
      return false
    }
  }, [activeWorktree, context])

  useEffect(() => {
    if (!currentTarget || !activeWorktree || !isPanelVisible) {
      pollController.current?.dispose()
      pollController.current = null
      return
    }
    const runtime: ChecksPollingRuntime = {
      visible: () => Object.values(context.getLayout().tools?.open ?? {}).includes(CHECKS_PANEL) && typeof document !== 'undefined' && document.visibilityState === 'visible',
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
        if (!target) return Promise.resolve(false)
        if (entryRefreshWorktrees.current.has(target.worktree)) return Promise.resolve(true)
        return runRefresh('active', target.worktree)
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

  const conflicts = active?.conflicts
  const localConflict = isRecord(conflicts) && (
    conflicts.status === 'loading' || conflicts.status === 'unavailable' ||
    conflicts.status === 'ready' && (
      conflicts.conflicting === true ||
      (Array.isArray(conflicts.files) && conflicts.files.length > 0) ||
      (Array.isArray(conflicts.localFiles) && conflicts.localFiles.length > 0)
    )
  )
  const hostConflict = currentReview?.mergeable === 'CONFLICTING' || currentReview?.mergeStateStatus === 'DIRTY'
  const checkRows = active && isRecord(active.checks) && Array.isArray(active.checks.checks) ? active.checks.checks : []
  const broken = checkRows.some((row) => isRecord(row) && (
    ['failure', 'error', 'startup_failure', 'timed_out', 'cancelled', 'action_required'].includes(String(row.conclusion ?? '').toLowerCase()) ||
    ['failure', 'error', 'action_required'].includes(String(row.status ?? '').toLowerCase())
  ))
  const queuedCount = active?.queuedComments.length ?? 0
  const triageAction = hostConflict || localConflict ? 'conflicts' : broken ? 'fix' : queuedCount > 0 ? 'comments' : null
  const noReviewStatus = active && activeWorktree && !currentReview ? selectStatus(state, activeWorktree) : null
  const offeredBlockerAction = noReviewStatus?.action ?? null
  const retrySeconds = retryDelay(lookup, countdownNow)
  const reviewRetrySeconds = retryDelay(active?.lookup, countdownNow)
  const noReviewEligibility = eligibilityIsCurrent(state, activeWorktree)
  const blocked = prioritizedBlocker(eligibility)
  const reason = blocked && typeof blocked.reason === 'string'
    ? blocked.reason
    : eligibility && typeof eligibility.reason === 'string'
      ? eligibility.reason
      : lookupReason(lookup)
  const diagnosticData = authDiagnostics ?? (
    lookup && isRecord(lookup.authDiagnostics)
      ? lookup.authDiagnostics
      : eligibility && isRecord(eligibility.authDiagnostics)
        ? eligibility.authDiagnostics
        : null
  )
  const diagnosticError = lookup && typeof lookup.authDiagnosticsError === 'string'
    ? lookup.authDiagnosticsError
    : eligibility && typeof eligibility.authDiagnosticsError === 'string'
      ? eligibility.authDiagnosticsError
      : null
  const diagnostics = diagnosticsCopy(diagnosticData)
  const currentReviewOwner = active === null ? null : reviewContext(state, 'checks')
  const lookupGitStatus = statusFromLookup(lookup)
  const blockerReview = eligibility && isRecord(eligibility.review) ? eligibility.review : null
  const panelHead = currentReview?.headRefOid
    ?? (typeof lookupGitStatus?.head === 'string' ? lookupGitStatus.head : null)
    ?? (typeof eligibility?.headOid === 'string' ? eligibility.headOid : null)
  const panelNumber = currentReview?.number
    ?? (lookup && positiveNumber(String(lookup.number ?? '')) ? Number(lookup.number) : null)
    ?? (blockerReview && positiveNumber(String(blockerReview.number ?? '')) ? Number(blockerReview.number) : null)
  const controlRepo = currentReviewOwner?.repo
    ?? parseRepoIdentity(lookup?.prRepo)
    ?? parseRepoIdentity(eligibility?.prRepo)
    ?? parseRepoIdentity(blockerReview?.prRepo)
    ?? null
  const panelTarget = reviewsControlTarget(CHECKS_PANEL, 'checks', activeWorktree, controlRepo, panelNumber, panelHead)
  const canRefresh = active !== null && activeWorktree !== null && !active.loading && retrySeconds === null
    && (currentReview !== null || !missingOrigin)
  const canUnlink = currentReview !== null && currentReviewOwner !== null && activeWorktree !== null && active !== null && !active.loading
  const canRelink = offeredBlockerAction === 'relink' && activeWorktree !== null && active !== null && !active.loading
  const canLink = currentReview !== null && currentReviewOwner !== null && activeWorktree !== null && active !== null && !active.loading
  const canTitleEdit = currentReview !== null && titleOwner !== null && activeWorktree !== null && active !== null && !active.loading
  const canCreate = () => active !== null && !active.loading && eligibilityIsCurrent(state, activeWorktree)
  const canBlocker = offeredBlockerAction !== null && activeWorktree !== null && active !== null && !active.loading
  const canOpenLink = currentReview !== null && currentReviewOwner !== null && activeWorktree !== null && active !== null && safeHttpUrl(currentReview.url) !== null
  const canCopyLink = activeWorktree !== null && ((currentReview !== null && currentReviewOwner !== null && safeHttpUrl(currentReview.url) !== null) || diagnosticData !== null)
  const canAgentOpen = triageAction !== null && activeWorktree !== null && active !== null && !active.loading
  const canSetHeight = active !== null && activeWorktree !== null

  const runReviewOperation = async (
    operation: () => Promise<unknown>,
    isCurrent: () => boolean,
    refreshState = true,
  ): Promise<unknown> => {
    if (!isCurrent()) return null
    setActionError(null)
    try {
      const result = await operation()
      if (!isCurrent()) return result
      if (refreshState) {
        await refreshRef.current()
        if (!isCurrent()) return result
      }
      const error = presentationError(result)
      if (error) setActionError(error)
      return result
    } catch (error) {
      if (isCurrent()) setActionError(messageOf(error))
      return null
    }
  }

  const runAuthDiagnosis = async (isCurrent: () => boolean) => {
    if (!activeWorktree || !isCurrent()) return
    setActionError(null)
    try {
      const result = await context.call('quirky.hosting/diagnoseAuth', { worktree: activeWorktree })
      if (!isCurrent()) return
      await refreshRef.current()
      if (!isCurrent()) return
      if (!isRecord(result)) throw new Error('GitHub returned invalid authentication diagnostics.')
      setAuthDiagnostics(result)
      setActionError(null)
    } catch (error) {
      if (isCurrent()) setActionError(messageOf(error))
    }
  }

  const runBlocker = (request: ReviewsUiControlRequest, isCurrent: () => boolean) => {
    const value = controlValue(request, ['action', 'number'])
    const action = value.action
    const allowed = ['publish', 'sync', 'push', 'open', 'auth', 'relink']
    if (typeof action !== 'string' || !allowed.includes(action)) throw new Error('Invalid pull request blocker action.')
    if (!noReviewStatus || action !== offeredBlockerAction || !activeWorktree || !isCurrent()) return
    const existingNumber = noReviewStatus.existingNumber
    if (value.number !== undefined && !positiveInteger(value.number)) throw new Error('Invalid blocker pull request number.')
    if (value.number !== undefined && value.number !== existingNumber) return
    if (action !== 'open' && action !== 'relink' && value.number !== undefined) {
      throw new Error('This blocker action does not accept a pull request number.')
    }
    if (action === 'relink') {
      return runReviewOperation(() => context.call('quirky.reviews/checksRelink', { worktree: activeWorktree }), isCurrent)
    }
    if (action === 'open') {
      if (!existingNumber) return
      return runReviewOperation(() => context.call('quirky.reviews/checksOpenReview', {
        worktree: activeWorktree,
        number: existingNumber,
        tab: 'conversation',
      }), isCurrent)
    }
    if (action === 'auth') {
      return runAuthDiagnosis(isCurrent)
    }
    return runReviewOperation(() => context.call('quirky.reviews/checksGitAction', {
      worktree: activeWorktree,
      action,
    }), isCurrent).then((result) => {
      if (action === 'push' && isRecord(result) && result.ok === true && isCurrent()) {
        return runReviewOperation(() => context.call('quirky.reviews/createOpen', { worktree: activeWorktree }), isCurrent, false)
      }
    })
  }

  const resolveOpenLink = (number: number | null): string | null => {
    if (!currentReview) return null
    if (number === currentReview.number) return safeHttpUrl(currentReview.url)
    const stack = stackModel(currentReview.stack)
    if (!stack?.available) return null
    const entry = stack.entries.find((candidate) => candidate.number === number)
    return safeHttpUrl(entry?.url)
  }

  const runChecksControl = (request: ReviewsUiControlRequest, isCurrent: () => boolean) => {
    if (!isCurrent()) return
    if (request.action === 'refresh') {
      controlValue(request, [])
      return runRefresh('manual', activeWorktree, isCurrent)
    }
    if (request.action === 'unlink') {
      controlValue(request, [])
      if (activeWorktree) return runReviewOperation(() => context.call('quirky.reviews/checksUnlink', { worktree: activeWorktree }), isCurrent)
      return
    }
    if (request.action === 'relink') {
      controlValue(request, [])
      if (offeredBlockerAction === 'relink' && activeWorktree) {
        return runReviewOperation(() => context.call('quirky.reviews/checksRelink', { worktree: activeWorktree }), isCurrent)
      }
      return
    }
    if (request.action === 'link-open') {
      controlValue(request, [])
      if (currentReview && isCurrent()) {
        setActionError(null)
        linkNumberRef.current = ''
        setLinkNumber('')
        setLinkOpen(true)
      }
      return
    }
    if (request.action === 'title-edit') {
      controlValue(request, [])
      if (!currentReview || !isCurrent()) return
      setActionError(null)
      titleField.edit(currentReview.title)
      return
    }
    if (request.action === 'create') {
      controlValue(request, [])
      if (activeWorktree && eligibilityIsCurrent(state, activeWorktree)) {
        return runReviewOperation(() => context.call('quirky.reviews/createOpen', { worktree: activeWorktree }), isCurrent, false)
      }
      return
    }
    if (request.action === 'blocker') {
      return runBlocker(request, isCurrent)
    }
    if (request.action === 'open-link') {
      const value = controlValue(request, ['number', 'invert'])
      const number = value.number === undefined ? currentReview?.number ?? null : value.number
      if (!positiveInteger(number)) throw new Error('Invalid pull request link target.')
      if (value.invert !== undefined && typeof value.invert !== 'boolean') throw new Error('Invalid pull request link modifier.')
      const url = resolveOpenLink(number)
      if (!url || !activeWorktree) throw new Error('Select a current pull request or stack member link.')
      return runReviewOperation(() => context.call('quirky.reviews/openLink', {
        url,
        worktree: activeWorktree,
        ...(value.invert === true ? { invert: true } : {}),
      }), isCurrent, false)
    }
    if (request.action === 'copy-link') {
      const value = controlValue(request, ['source'])
      const source = value.source ?? 'review'
      const text = source === 'review'
        ? currentReview && currentReviewOwner !== null && safeHttpUrl(currentReview.url)
        : source === 'auth-status' && diagnosticData !== null
          ? 'gh auth status'
          : null
      if (typeof text !== 'string' || text === '') throw new Error('Select a current pull request link or GitHub auth status.')
      return runReviewOperation(() => copyReviewsText(text), isCurrent, false)
    }
    if (request.action === 'agent-open') {
      const value = controlValue(request, ['action'])
      if (value.action !== 'fix' && value.action !== 'conflicts' && value.action !== 'comments') {
        throw new Error('Invalid agent action.')
      }
      if (value.action !== triageAction || !activeWorktree) return
      return runReviewOperation(() => context.call('quirky.reviews/checksSetAgentDialog', {
        surface: 'checks',
        worktree: activeWorktree,
        action: value.action,
      }), isCurrent)
    }
    if (request.action === 'height-set') {
      const value = controlValue(request, ['height'])
      if (typeof value.height !== 'number' || !Number.isFinite(value.height)) throw new Error('Invalid Checks panel height.')
      const height = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(value.height)))
      dragHeightRef.current = null
      setDragHeight(null)
      return runReviewOperation(() => context.call('quirky.reviews/checksSetHeight', { height }), isCurrent)
    }
    throw new Error('Unknown Checks panel action.')
  }

  const checksControl = useReviewsUiControl({
    context,
    surface: CHECKS_PANEL,
    slot: 'checks',
    worktree: activeWorktree,
    repo: controlRepo,
    number: panelNumber,
    headOid: panelHead,
    active: true,
    onError: setActionError,
    actions: () => [
      { action: 'refresh', enabled: canRefresh },
      { action: 'unlink', enabled: canUnlink },
      { action: 'relink', enabled: canRelink },
      { action: 'link-open', enabled: canLink },
      { action: 'title-edit', enabled: canTitleEdit },
      { action: 'create', enabled: canCreate() },
      { action: 'blocker', enabled: canBlocker },
      { action: 'open-link', enabled: canOpenLink },
      { action: 'copy-link', enabled: canCopyLink },
      { action: 'agent-open', enabled: canAgentOpen },
      { action: 'height-set', enabled: canSetHeight },
    ],
    run: runChecksControl,
  })
  const requestChecksControl = (action: string, value?: Record<string, unknown>) => checksControl.request(action, value)

  const titleControl = useReviewsUiControl({
    context,
    surface: CHECKS_PANEL,
    slot: 'title',
    worktree: titleOwner?.worktree ?? activeWorktree,
    repo: titleOwner?.repo ?? controlRepo,
    number: titleOwner?.number ?? currentReview?.number ?? null,
    headOid: currentReview?.headRefOid ?? panelHead,
    active: titleEditing && currentReview !== null && titleOwner !== null,
    onError: setActionError,
    actions: () => [
      { action: 'title-save', enabled: canTitleEdit && titleInput.trim() !== '' },
      { action: 'title-cancel', enabled: canTitleEdit },
    ],
    run: (request, isCurrent) => {
      controlValue(request, [])
      if (request.action === 'title-save') return saveTitle(isCurrent)
      else if (request.action === 'title-cancel') {
        if (titleOwner && currentReview && isCurrent()) {
          setActionError(null)
          titleSaveAction.current?.fail()
          titleSaveAction.current = null
          titleField.edit(null)
        }
      } else throw new Error('Unknown title editor action.')
    },
  })
  const requestTitleControl = (action: string) => titleControl.request(action)

  async function saveTitle(isCurrent: () => boolean): Promise<void> {
    if (!titleOwner || !currentReview || titleField.value === null || titleInput.trim() === '' || !isCurrent()) return
    if (titleSaveAction.current !== null && titleSaveAction.current.status() !== 'gone') return
    const owner = titleOwner
    const reviewAtStart = currentReview
    const action = titleField.begin()
    titleSaveAction.current = action
    setActionError(null)
    try {
      await titleField.settled()
      if (!isCurrent() || action.status() === 'gone') return
      const title = action.take()
      if (title === null) {
        action.fail()
        return
      }
      const result = await context.call('quirky.reviews/checksSaveTitle', {
        worktree: owner.worktree,
        number: owner.number,
        expectedHead: reviewAtStart.headRefOid,
        title,
      })
      if (!isCurrent() || action.status() === 'gone') return
      if (isRecord(result) && result.updated === true) action.succeed(null)
      else {
        action.fail()
        setActionError(presentationError(result) ?? 'The pull request title could not be saved.')
      }
    } catch (error) {
      if (isCurrent() && action.status() !== 'gone') {
        action.fail()
        setActionError(messageOf(error))
      }
    } finally {
      if (titleSaveAction.current === action) titleSaveAction.current = null
    }
  }

  const linkControl = useReviewsUiControl({
    context,
    surface: CHECKS_PANEL,
    slot: 'link',
    worktree: activeWorktree,
    repo: controlRepo,
    number: panelNumber,
    headOid: panelHead,
    active: linkOpen && currentReview !== null && activeWorktree !== null,
    onError: setActionError,
    actions: () => [
      { action: 'link-submit', enabled: linkOpen && activeWorktree !== null && active !== null && !active.loading },
      { action: 'link-cancel', enabled: linkOpen },
    ],
    run: (request, isCurrent) => {
      const value = controlValue(request, request.action === 'link-submit' ? ['number'] : [])
      if (request.action === 'link-cancel') {
        if (isCurrent()) {
          setActionError(null)
          linkNumberRef.current = ''
          setLinkNumber('')
          setLinkOpen(false)
        }
        return
      }
      if (request.action !== 'link-submit') throw new Error('Unknown pull request link action.')
      if (value.number !== undefined && typeof value.number !== 'string') throw new Error('Invalid pull request number.')
      const number = positiveNumber(typeof value.number === 'string' ? value.number : linkNumberRef.current)
      if (!number || !activeWorktree) {
        if (isCurrent()) setActionError('Enter a positive pull request number.')
        return
      }
      return runReviewOperation(() => context.call('quirky.reviews/checksLink', {
        worktree: activeWorktree,
        number,
      }), isCurrent).then((result) => {
        if (isCurrent() && isRecord(result) && result.linked === true) {
          linkNumberRef.current = ''
          setLinkNumber('')
          setLinkOpen(false)
        }
      })
    },
  })
  const requestLinkControl = (action: string) => linkControl.request(action)

  const setHeight = useCallback((height: number) => {
    const bounded = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(height)))
    dragHeightRef.current = bounded
    setDragHeight(bounded)
  }, [])
  const beginResize = (event: MouseEvent<HTMLDivElement>) => {
    event.preventDefault()
    const startY = event.clientY
    const startHeight = active?.height ?? 320
    const onMove = (move: globalThis.MouseEvent) => setHeight(startHeight + startY - move.clientY)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      dragCleanup.current = null
      void requestChecksControl('height-set', { height: dragHeightRef.current ?? active?.height ?? startHeight })
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    dragCleanup.current = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }

  useEffect(() => () => dragCleanup.current?.(), [])
  useEffect(() => {
    dragCleanup.current?.()
    dragCleanup.current = null
    dragHeightRef.current = null
    setDragHeight(null)
    linkNumberRef.current = ''
    setLinkNumber('')
    setLinkOpen(false)
  }, [panelTarget])

  const actionItems = useMemo(() => [
    {
      id: 'unlink',
      label: 'Unlink PR from workspace',
      disabled: !canUnlink,
      onAction: () => { void requestChecksControl('unlink') },
    },
    {
      id: 'link-another',
      label: 'Link another PR',
      disabled: !canLink,
      onAction: () => { void requestChecksControl('link-open') },
    },
  ], [canLink, canUnlink, requestChecksControl])

  const panelMetadata = {
    'data-review-control-target': checksControl.target,
    'data-review-control-generation': checksControl.generation,
  }
  if (!activeWorktree) {
    return <section className="ui-stack" {...panelMetadata}>
      {sitterSafetyStrip}
      {sitterRow}
      <SectionHeader title="No workspace selected" />
      <EmptyState message="Select a workspace to view checks." />
    </section>
  }
  const initialLookupPending = active !== null && active.lookup?.kind === 'loading' && !active.review
  if (!active || active.loading && !active.lookup && !active.review || initialLookupPending) {
    const readError = actionError ?? active?.error ?? titleField.error
    return <section className="ui-stack" aria-busy={readError === null} {...panelMetadata}>
      {sitterSafetyStrip}
      {sitterRow}
      {readError
        ? <InlineError message={readError} />
        : <NoticeLine>Checking pull request status…</NoticeLine>}
    </section>
  }
  if (!currentReview) {
    const empty = noReviewStatus ?? selectStatus(state, activeWorktree)
    const existingNumber = empty.existingNumber
    const busy = active.loading
    const lookupFailure = lookup?.kind === 'unavailable'
      ? typeof lookup.message === 'string' ? lookup.message : 'The provider could not determine whether this branch has a pull request.'
      : reason === 'lookup_unavailable'
        ? 'The provider could not establish whether this branch has a review. No composer is available until lookup succeeds.'
        : null
    const genuineEmpty = lookup?.kind === 'no-review' && noReviewEligibility && active.error === null
    const createUnavailable = lookup?.kind === 'unavailable' || reason === 'lookup_unavailable'
    const authenticationFailure = empty.action === 'auth'
    return (
      <section className="ui-stack" style={{ minHeight: 0, maxHeight: '100%', overflow: 'hidden' }} {...panelMetadata}>
        {sitterSafetyStrip}
        {sitterRow}
        {!missingOrigin && actionError && <InlineError message={actionError} />}
        {!missingOrigin && active.error && <InlineError message={active.error} />}
        {lookupFailure && <InlineError message={lookupFailure} />}
        {diagnosticError && <InlineError message={diagnosticError} />}
        <div className="ui-stack" style={{ padding: 'var(--ui-space-12)', overflow: 'auto' }}>
          {authenticationFailure
            ? <InlineError message={`${empty.title}: ${empty.message}`} />
            : genuineEmpty
              ? <EmptyState message="No pull request found" />
              : <SectionHeader title={empty.title} />}
          {!lookupFailure && !authenticationFailure && <p>{empty.message}</p>}
          {empty.action && <Button
            variant={empty.action === 'open' || empty.action === 'relink' ? 'primary' : 'secondary'}
            disabled={busy}
            onClick={() => {
              if (empty.action === 'relink') void requestChecksControl('relink')
              else void requestChecksControl('blocker', {
                action: empty.action!,
                ...(existingNumber === undefined ? {} : { number: existingNumber }),
              })
            }}
          >
            {empty.action === 'open' ? `Open Review #${existingNumber ?? ''}` : empty.action === 'relink' ? `Link PR #${existingNumber ?? ''}` : empty.action === 'publish' ? 'Publish Branch' : empty.action === 'sync' ? 'Sync Branch' : empty.action === 'push' ? 'Push & Create PR' : 'Connect GitHub'}
          </Button>}
          {diagnostics.length > 0 && <section className="ui-stack" aria-label="GitHub CLI diagnostics"><SectionHeader title="GitHub CLI diagnostics" /><ul className="ui-stack">{diagnostics.map((item) => <li key={item}>{item}</li>)}</ul></section>}
          {diagnosticData && <section className="ui-stack" aria-label="GitHub account status">
            {typeof diagnosticData.requiredHost === 'string' && <p>Required host: <code>{diagnosticData.requiredHost}</code></p>}
            {Array.isArray(diagnosticData.accounts) && diagnosticData.accounts.length > 0 && <ul className="ui-stack">
              {diagnosticData.accounts.filter(isRecord).map((account, index) => (
                <li key={`${String(account.host ?? '')}:${String(account.user ?? index)}`}>
                  {typeof account.user === 'string' ? account.user : 'Account'}{typeof account.host === 'string' ? ` · ${account.host}` : ''}
                  {typeof account.source === 'string' ? ` · ${account.source}` : ''}
                  {account.active === true ? ' · active' : ''}
                </li>
              ))}
            </ul>}
            {diagnosticData.ghAvailable === false && <p>GitHub CLI (gh) is unavailable. Install it, then retry.</p>}
            <Button onClick={() => { void requestChecksControl('copy-link', { source: 'auth-status' }) }}>Copy gh auth status</Button>
          </section>}
          {reason === 'authentication_required' || reason === 'auth_required' || reason === 'not_authenticated' || reason === 'scope_missing' || reason === 'gh_unavailable'
            ? <p>Check GitHub access with <code>gh auth status</code>. Sign in with <code>gh auth login</code>; no token is entered or stored here.</p>
            : null}
          {eligibility?.eligible === true && !noReviewEligibility && <p>Eligibility is stale or belongs to a different branch. Refresh to confirm the current workspace.</p>}
          {!createUnavailable && noReviewEligibility && <Button
            variant="primary"
            disabled={busy}
            onClick={() => { void requestChecksControl('create') }}
          >Create PR</Button>}
          {!createUnavailable && !noReviewEligibility && eligibility?.eligible === true && <Button
            disabled={busy}
            title={eligibilityDisabledReason(state, activeWorktree) ?? undefined}
          >Create PR</Button>}
          {!missingOrigin && <Button disabled={busy || retrySeconds !== null} onClick={() => { void requestChecksControl('refresh') }}>
            {retrySeconds === null ? 'Retry' : `Retry in ${retrySeconds}s`}
          </Button>}
        </div>
        <div role="separator" aria-orientation="horizontal" aria-label="Resize Checks panel" tabIndex={0}
          onMouseDown={beginResize}
          onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
              event.preventDefault()
              void requestChecksControl('height-set', { height: (active.height ?? 320) + (event.key === 'ArrowUp' ? 24 : -24) })
            }
          }}
          style={{ height: 'var(--ui-space-8)', cursor: 'row-resize', borderTop: 'var(--ui-border-width) solid var(--ui-border)' }} />
      </section>
    )
  }

  const stack = stackModel(currentReview.stack)
  const editedTitle = titleField.value !== null
  const contentHeight = dragHeight ?? active.height

  const refreshTitle = reviewRetrySeconds === null ? 'Refresh checks' : `Retry is paused for ${reviewRetrySeconds}s`

  return (
    <ToolPanelFrame
      title="Checks"
      tools={
        <IconButton label="Refresh checks" disabled={!canRefresh} title={refreshTitle} onClick={() => { void requestChecksControl('refresh') }}>
          <ControlIcon name="arrows-clockwise" />
        </IconButton>
      }
      actions={<Menu label="More PR actions" trigger={<ControlIcon name="dots-three" />} items={actionItems} />}
    >
    <section
      className="ui-stack"
      style={{ display: 'flex', flexDirection: 'column', minHeight: 0, maxHeight: '100%', overflow: 'hidden' }}
      {...panelMetadata}
    >
      {sitterSafetyStrip}
      {active.error && <InlineError message={`${active.error} Showing the last known review status.`} />}
      {(actionError ?? titleField.error) && <InlineError message={actionError ?? titleField.error!} />}
      <div className="ui-stack" style={{ padding: 'var(--ui-space-12)' }}>
        <div className="ui-cluster">
          <span aria-hidden="true">PR</span>
          <Button title={routing.title} disabled={!canOpenLink} onClick={(event) => {
            void requestChecksControl('open-link', { number: currentReview.number, invert: routing.invert(event) })
          }}>#{currentReview.number}</Button>
          <Badge tone={currentReview.state === 'open' ? 'working' : currentReview.state === 'merged' ? 'accent' : 'neutral'}>{reviewStateName(currentReview.state)}</Badge>
          <Button aria-label="Copy PR link" disabled={!canCopyLink} onClick={() => { void requestChecksControl('copy-link', { source: 'review' }) }}>Copy link</Button>
        </div>
        <div className="ui-cluster" style={{ alignItems: 'start', justifyContent: 'space-between' }}>
          <div className="ui-stack" style={{ minWidth: 0, flex: '1 1 auto' }}>
            {editedTitle ? (
              <div
                className="ui-cluster"
                data-review-control-target={titleControl.target}
                data-review-control-generation={titleControl.generation}
              >
                <TextField id="reviews-pull-request-title" label="Pull request title" aria-label="Pull request title" maxLength={256} value={titleInput} onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                  if (event.key === 'Escape') {
                    event.preventDefault()
                    void requestTitleControl('title-cancel')
                  } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault()
                    void requestTitleControl('title-save')
                  }
                }} onChange={(event) => {
                  titleField.edit(event.target.value)
                  setActionError(null)
                }} />
                <IconButton label="Save pull request title" disabled={!canTitleEdit || titleInput.trim() === ''} onClick={() => { void requestTitleControl('title-save') }}>✓</IconButton>
                <IconButton label="Cancel title edit" disabled={!canTitleEdit} onClick={() => { void requestTitleControl('title-cancel') }}>×</IconButton>
              </div>
            ) : (
              <Button className="ui-cluster" style={{ flex: '1 1 auto', justifyContent: 'flex-start' }} aria-label="Edit pull request title" disabled={!canTitleEdit} onClick={() => { void requestChecksControl('title-edit') }}>{currentReview.title}</Button>
            )}
            <div className="ui-text-muted">{currentReview.baseRefName} ← {currentReview.headRefName}{reviewDate(currentReview) ? ` · ${reviewDate(currentReview)}` : ''}</div>
          </div>
          <span className="ui-text-muted" title={activeWorktree}>Workspace</span>
        </div>
        {linkOpen && <form
          className="ui-cluster"
          data-review-control-target={linkControl.target}
          data-review-control-generation={linkControl.generation}
          onSubmit={(event) => {
            event.preventDefault()
            void requestLinkControl('link-submit')
          }}
        >
          <TextField label="Pull request number" aria-label="Pull request number" inputMode="numeric" disabled={active.loading} value={linkNumber} onChange={(event) => {
            linkNumberRef.current = event.target.value
            setLinkNumber(event.target.value)
            setActionError(null)
          }} />
          <Button variant="primary" type="submit" disabled={active.loading}>Link PR</Button>
          <Button type="button" onClick={() => { void requestLinkControl('link-cancel') }}>Cancel</Button>
        </form>}
      </div>

      {stack && <section className="ui-stack" aria-label="Pull request stack">
        {stack.available ? (
          <>
            <strong>Stack #{stack.number} · PR #{currentReview.number} at position {stack.position} of {stack.size}</strong>
            <ol className="ui-cluster" style={{ listStyle: 'none', padding: 0 }}>
              {stack.entries.map((entry) => {
                const linkUrl = safeHttpUrl(entry.url)
                return <li key={String(entry.number)}>
                  <Button aria-current={entry.number === currentReview.number ? 'page' : undefined} title={routing.title}
                    disabled={linkUrl === null} onClick={(event) => {
                      if (linkUrl !== null) {
                        void requestChecksControl('open-link', { number: entry.number, invert: routing.invert(event) })
                      }
                    }}>
                    #{String(entry.number)} · {String(entry.title ?? 'Pull request')}
                  </Button>
                </li>
              })}
            </ol>
            {stack.truncated && <p className="ui-text-muted">Showing the first 100 stack members.</p>}
          </>
        ) : stack.loading
          ? <NoticeLine>{stack.message}</NoticeLine>
          : <InlineError message={stack.message ?? 'The canonical stack could not be loaded.'} />}
      </section>}

      <div className="ui-stack" style={{ padding: 'var(--ui-space-8) var(--ui-space-12)' }}>
        <ReviewActions {...props} surface="checks" />
      </div>
      {sitterRow}

      {(hostConflict || localConflict) && <section className="ui-stack" aria-label="Merge conflicts">
        <SectionHeader title="Conflicts block this PR" />
        {active.conflicts?.status === 'loading' && <NoticeLine>Loading conflict paths…</NoticeLine>}
        {active.conflicts?.status === 'unavailable' && <p>{typeof active.conflicts.message === 'string' ? active.conflicts.message : 'Conflict paths are unavailable from the read-only preview.'}</p>}
        {active.conflicts?.available === true && active.conflicts.conflicting === false && <p>Git’s read-only preview found no conflicting paths; refresh the review metadata before merging.</p>}
        {Array.isArray(active.conflicts?.files) && active.conflicts.files.length > 0 && <ul className="ui-stack">{active.conflicts.files.map((file, index) => <li key={isRecord(file) && typeof file.path === 'string' ? file.path : index}>{isRecord(file) && typeof file.path === 'string' ? file.path : 'Conflicting file'}</li>)}</ul>}
        {Array.isArray(active.conflicts?.localFiles) && active.conflicts.localFiles.length > 0 && <div className="ui-stack"><strong>Active workspace conflicts</strong><ul className="ui-stack">{active.conflicts.localFiles.map((file, index) => <li key={isRecord(file) && typeof file.path === 'string' ? file.path : index}>{isRecord(file) && typeof file.path === 'string' ? file.path : 'Conflicting file'}</li>)}</ul></div>}
        {active.conflicts?.truncated === true && <p className="ui-text-muted">Conflict file list is truncated at 100 entries.</p>}
      </section>}

      {(hostConflict || broken || pending || queuedCount > 0) && <section className="ui-cluster" aria-label="Review triage" style={{ justifyContent: 'space-between' }}>
        <Badge tone={hostConflict ? 'failing' : broken ? 'failing' : pending ? 'needs-you' : 'needs-you'}>{hostConflict ? 'Conflicts block this PR' : broken ? 'Failing checks' : pending ? 'Checks pending' : `${queuedCount} queued comments`}</Badge>
        {triageAction === 'conflicts' ? (
          <Button variant="primary" disabled={!canAgentOpen} onClick={() => { void requestChecksControl('agent-open', { action: 'conflicts' }) }}>Resolve</Button>
        ) : triageAction === 'fix' ? (
          <Button variant="primary" disabled={!canAgentOpen} onClick={() => { void requestChecksControl('agent-open', { action: 'fix' }) }}>Fix</Button>
        ) : triageAction === 'comments' ? (
          <Button variant="primary" disabled={!canAgentOpen} onClick={() => { void requestChecksControl('agent-open', { action: 'comments' }) }}>Resolve {queuedCount} Comments With AI</Button>
        ) : <span className="ui-text-muted">Orca will refresh checks while this panel stays open.</span>}
      </section>}

      <div className="ui-stack" style={{ minHeight: 0, flex: '1 1 auto', height: contentHeight, maxHeight: '100%', overflow: 'auto', padding: 'var(--ui-space-12)' }}>
        <ChecksList {...props} surface="checks" />
        <Comments {...props} surface="checks" />
      </div>
      {isRecord(active.conflicts) && active.conflicts.status === 'ready' && active.conflicts.truncated === true && <p className="ui-text-muted">Conflict file list is truncated at 100 entries.</p>}
      {isRecord(active.checks) && active.checks.truncated === true && <p className="ui-text-muted">Showing the first 100 checks.</p>}
      {isRecord(active.comments) && active.comments.truncated === true && <p className="ui-text-muted">Showing the first 100 comments.</p>}
      {active.error && <InlineError message={`${active.error} Showing the last known review status.`} />}
      {(actionError ?? titleField.error) && <InlineError message={actionError ?? titleField.error!} />}
      <div role="separator" aria-orientation="horizontal" aria-label="Resize Checks panel" tabIndex={0}
        onMouseDown={beginResize}
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
            event.preventDefault()
            void requestChecksControl('height-set', { height: (active.height ?? 320) + (event.key === 'ArrowUp' ? 24 : -24) })
          }
        }}
        style={{ height: 'var(--ui-space-8)', flex: '0 0 var(--ui-space-8)', cursor: 'row-resize', borderTop: 'var(--ui-border-width) solid var(--ui-border)' }} />
    </section>
    </ToolPanelFrame>
  )
}
