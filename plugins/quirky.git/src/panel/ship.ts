import type { GitStatus, ReviewModel } from '@quirky/protocol'
import type { GitHubReviewLookup } from './GitHubReview'
import { shouldForcePushWithLease } from './ladder'

/**
 * What the ship button and its caret read. Everything is a snapshot; the functions here hold no
 * state.
 */
export type ShipState = {
  /** The review model, or null while it loads. */
  review: ReviewModel | null
  /** The latest status, or null while it loads. */
  status: GitStatus | null
  github: GitHubReviewLookup
  /** The commit message as typed. Commit steps never read it; the click handler guards an empty one. */
  message: string
  /** What is running, such as `Commit` or `Push`, or null when nothing is. */
  busy: string | null
  /** The ticked paths while "Commit selected files…" is on; null when it is off. */
  selected: ReadonlySet<string> | null
  /** The branch is the base branch itself, so there is no PR to open from it. */
  isBaseBranch: boolean
}

/** The step the ship button runs. `up-to-date` is a status line, not a button. */
export type ShipStepKind =
  | 'commit-staged'
  | 'commit-all'
  | 'commit-selected'
  | 'pull'
  | 'sync'
  | 'publish'
  | 'push'
  | 'create-pr'
  | 'view-pr'
  | 'up-to-date'

export type ShipStep = { kind: ShipStepKind; label: string; enabled: boolean; reason?: string }

/** The caret entries, which `ShipBar` hands to the split button as their ids. */
export type ShipMenuId =
  | 'commit-all'
  | 'commit-selected'
  | 'commit-push'
  | 'commit-push-pr'
  | 'pull'
  | 'fast-forward'
  | 'sync'
  | 'push'
  | 'publish'
  | 'force-push'
  | 'rebase'
  | 'fetch'
  | 'create-pr'
  | 'view-pr'

export type ShipMenuItem = {
  id: ShipMenuId
  label: string
  enabled: boolean
  /** Why the entry cannot run; present only when `enabled` is false. */
  detail?: string
  separatorBefore?: boolean
  danger?: boolean
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

const stripRemotePrefix = (ref: string): string => ref.replace(/^(?:refs\/)?remotes\//, '')

/**
 * Whether `base` names the branch the worktree is on, so nothing can be proposed against it.
 * `origin/main` and `refs/remotes/origin/main` both match the local `main`.
 */
export function isBaseBranch(base: string, branch: string | null): boolean {
  if (branch === null || base === '') return false
  const bare = stripRemotePrefix(base)
  return bare === branch || bare.slice(bare.indexOf('/') + 1) === branch
}

type Facts = {
  status: GitStatus
  /** Unique uncommitted paths. */
  uncommitted: string[]
  staged: string[]
  ahead: number
  behind: number
  hasUpstream: boolean
  upstreamName: string
  detached: boolean
}

function factsOf(status: GitStatus): Facts {
  const up = status.upstreamStatus
  return {
    status,
    uncommitted: [...new Set(status.entries.map((entry) => entry.path))],
    staged: [...new Set(status.entries.filter((entry) => entry.area === 'staged').map((entry) => entry.path))],
    ahead: up.ahead,
    behind: up.behind,
    hasUpstream: up.hasUpstream,
    upstreamName: up.name ?? status.upstream ?? 'the remote',
    detached: status.detached
  }
}

const lookingUp = (github: GitHubReviewLookup): boolean => github.kind === 'loading' || github.kind === 'waiting'

const CHECKING = 'checking for a pull request…'

const MERGED = 'the pull request is already merged'

/** Why a push cannot go yet: it goes to the linked PR's branch when there is one, and not to a merged one. */
function pushHold(github: GitHubReviewLookup): string | null {
  if (lookingUp(github)) return CHECKING
  return github.kind === 'found' && github.review.state === 'merged' ? MERGED : null
}

const afterLookup = (step: ShipStep, github: GitHubReviewLookup): ShipStep => {
  const hold = pushHold(github)
  return hold !== null && step.enabled ? { kind: step.kind, label: step.label, enabled: false, reason: hold } : step
}

function isClean(state: ShipState, facts: Facts): boolean {
  const { review } = state
  return review !== null && review.compare.status === 'ready' && review.counts.files === 0 &&
    facts.uncommitted.length === 0 && facts.ahead === 0 && facts.behind === 0
}

/** The ticked paths that are still uncommitted. */
function ticked(state: ShipState, facts: Facts): string[] {
  const set = state.selected
  return set === null ? [] : facts.uncommitted.filter((path) => set.has(path))
}

const withBusy = (step: ShipStep, busy: string | null): ShipStep =>
  busy === null ? step : { kind: step.kind, label: step.label, enabled: false, reason: `${busy} in progress…` }

function pick(state: ShipState, facts: Facts): ShipStep {
  const { github } = state
  if (facts.uncommitted.length > 0) {
    if (state.selected !== null) {
      const chosen = ticked(state, facts).length
      const label = `Commit ${chosen} of ${facts.uncommitted.length} files`
      return chosen === 0
        ? { kind: 'commit-selected', label, enabled: false, reason: 'tick at least one file' }
        : { kind: 'commit-selected', label, enabled: true }
    }
    if (facts.staged.length > 0) {
      return { kind: 'commit-staged', label: `Commit ${plural(facts.staged.length, 'staged file')}`, enabled: true }
    }
    return { kind: 'commit-all', label: `Commit ${plural(facts.uncommitted.length, 'file')}`, enabled: true }
  }
  const up = facts.status.upstreamStatus
  if (facts.hasUpstream && facts.behind > 0 && facts.ahead === 0) {
    return { kind: 'pull', label: `Pull ${plural(facts.behind, 'commit')}`, enabled: true }
  }
  if (facts.hasUpstream && facts.ahead > 0 && facts.behind > 0) {
    if (shouldForcePushWithLease(up)) {
      return afterLookup({ kind: 'push', label: `Force push ${plural(facts.ahead, 'commit')}`, enabled: true }, github)
    }
    return github.kind === 'found'
      ? { kind: 'sync', label: 'Sync', enabled: false, reason: 'pull, then push to the pull request' }
      : afterLookup({ kind: 'sync', label: 'Sync', enabled: true }, github)
  }
  if (!facts.hasUpstream) {
    return facts.detached
      ? { kind: 'publish', label: 'Publish branch', enabled: false, reason: 'check out a branch first' }
      : afterLookup({ kind: 'publish', label: 'Publish branch', enabled: true }, github)
  }
  if (facts.ahead > 0) return afterLookup({ kind: 'push', label: `Push ${plural(facts.ahead, 'commit')}`, enabled: true }, github)
  if (github.kind === 'found') return { kind: 'view-pr', label: `View PR #${github.review.number}`, enabled: true }
  const quiet = (reason: string): ShipStep => ({ kind: 'up-to-date', label: `Pushed to ${facts.upstreamName}`, enabled: false, reason })
  if (state.isBaseBranch) return quiet('this is the base branch')
  if (github.kind === 'unsupported') return quiet('no GitHub remote')
  if (lookingUp(github)) return { kind: 'create-pr', label: 'Create PR', enabled: false, reason: CHECKING }
  return { kind: 'create-pr', label: 'Create PR', enabled: true }
}

/**
 * The step the ship button names: the first row of scenario 22's table that applies. Null when
 * there is no ship bar, which is while the status loads and for a worktree that matches its base
 * and its upstream. When nothing is left to do but no step can run, the result is an
 * `up-to-date` line with the reason, not a disabled button. A running operation disables the
 * step and names itself as the reason.
 */
export function nextStep(state: ShipState): ShipStep | null {
  if (state.status === null) return null
  const facts = factsOf(state.status)
  if (isClean(state, facts)) return null
  return withBusy(pick(state, facts), state.busy)
}

/** Why Create PR, or a chain that ends in it, cannot run; null when it can. */
function prBlocker(state: ShipState, facts: Facts): string | null {
  const { github } = state
  if (github.kind === 'found') return `PR #${github.review.number} is already open`
  if (github.kind === 'unsupported') return 'no GitHub remote'
  if (state.isBaseBranch) return 'this is the base branch'
  if (facts.detached) return 'check out a branch first'
  if (lookingUp(github)) return CHECKING
  return null
}

/**
 * The caret of the ship button: every step, always listed, with `enabled: false` and a short
 * `detail` reason for any that cannot run. A running operation or a status that is still loading
 * greys the whole list.
 */
export function shipMenu(state: ShipState): ShipMenuItem[] {
  const facts = state.status === null ? null : factsOf(state.status)
  const lockedBy = state.busy !== null ? `${state.busy} in progress…` : facts === null ? 'loading status…' : null
  const base = state.review?.base.name ?? ''
  const baseLabel = stripRemotePrefix(base)

  const item = (id: ShipMenuId, label: string, reason: string | null, extra: Partial<ShipMenuItem> = {}): ShipMenuItem => {
    const why = lockedBy ?? reason
    return { id, label, enabled: why === null, ...(why === null ? {} : { detail: why }), ...extra }
  }

  const n = facts?.uncommitted.length ?? 0
  const noChanges = n === 0 ? 'nothing to commit' : null
  const noUpstream = facts !== null && !facts.hasUpstream ? 'no upstream yet' : null
  const ahead = facts?.ahead ?? 0
  const behind = facts?.behind ?? 0
  const detached = facts?.detached === true ? 'check out a branch first' : null
  const github = state.github
  const pr = facts === null ? null : prBlocker(state, facts)
  const checking = pushHold(github)

  const createPr = (): string | null => {
    if (facts === null) return null
    if (pr !== null) return pr
    if (n > 0) return 'commit your changes first'
    if (!facts.hasUpstream) return 'publish the branch first'
    if (ahead > 0) return 'push first'
    if (behind > 0) return 'pull first'
    return null
  }

  return [
    item('commit-all', n === 0 ? 'Commit all files' : `Commit all ${plural(n, 'file')}`, noChanges),
    item('commit-selected', 'Commit selected files…', noChanges),
    item('commit-push', 'Commit & push', detached ?? noChanges ?? checking),
    item('commit-push-pr', 'Commit, push & create PR', pr ?? noChanges),
    item('pull', behind > 0 ? `Pull ${plural(behind, 'commit')}` : 'Pull', noUpstream ?? (behind === 0 ? 'nothing to pull' : null), { separatorBefore: true }),
    item('fast-forward', 'Fast-forward', noUpstream ?? (behind === 0 ? 'nothing to pull' : ahead > 0 ? 'has local commits' : null)),
    item('sync', 'Sync', noUpstream ?? (ahead === 0 && behind === 0 ? 'already in sync' : github.kind === 'found' ? 'linked to a pull request' : checking)),
    item('push', ahead > 0 ? `Push ${plural(ahead, 'commit')}` : 'Push', noUpstream ?? (ahead === 0 ? 'nothing to push' : checking)),
    item('publish', 'Publish branch', facts?.hasUpstream === true ? 'already published' : detached ?? checking),
    item('force-push', 'Force push', noUpstream ?? (ahead === 0 ? 'nothing to force' : checking), { danger: true }),
    item(
      'rebase',
      baseLabel === '' ? 'Rebase from base' : `Rebase from ${baseLabel}`,
      baseLabel === '' ? 'no base' : baseLabel.includes('/') ? null : 'base is not on the remote'
    ),
    item('fetch', 'Fetch', null),
    item('create-pr', 'Create PR', createPr(), { separatorBefore: true }),
    item('view-pr', github.kind === 'found' ? `View PR #${github.review.number}` : 'View PR', github.kind === 'found' ? null : 'no pull request yet')
  ]
}
