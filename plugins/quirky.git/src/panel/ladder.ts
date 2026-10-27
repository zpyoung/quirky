import type { GitBusyOp, GitStatus, GitUpstreamStatus } from '@quirky/protocol'
import { isStageable } from './sections'

/**
 * What the primary-button and menu decisions read. Everything is a snapshot; the functions here
 * hold no state.
 */
export type LadderState = {
  /** The latest status, or null while the upstream is still loading. */
  status: GitStatus | null
  /** The commit message as typed; surrounding whitespace is ignored. */
  message: string
  /** A commit started from this window is running. */
  committing: boolean
  /** The compare base ref, such as `origin/main` or `refs/remotes/origin/main`; null when none is known. */
  base: string | null
}

/** What the primary button does when pressed. */
export type PrimaryKind = 'commit' | 'stage' | 'push' | 'force-push' | 'pull' | 'sync' | 'publish'

/** The primary button: its action, label, whether it can be pressed, and its tooltip. */
export type PrimaryAction = { kind: PrimaryKind; label: string; enabled: boolean; title: string }

const BUSY_LABELS: Readonly<Record<GitBusyOp, string>> = {
  push: 'Push',
  'force-push': 'Force Push',
  pull: 'Pull',
  'fast-forward': 'Fast-forward',
  fetch: 'Fetch',
  sync: 'Sync',
  rebase: 'Rebase',
  continue: 'Continue',
  abort: 'Abort'
}

/**
 * Orca's lease predicate: the branch is both ahead and behind but every behind commit is a
 * patch-equivalent copy of a local one (a rebased branch), so a force push with lease is the
 * right way to update the remote.
 */
export function shouldForcePushWithLease(upstream: GitUpstreamStatus): boolean {
  return upstream.hasUpstream && upstream.ahead > 0 && upstream.behind > 0 && upstream.behindPatchEquivalent === true
}

const hasUnresolved = (status: GitStatus | null): boolean =>
  status?.entries.some((e) => e.conflict?.state === 'unresolved') ?? false

const stagedCount = (status: GitStatus | null): number => status?.entries.filter((e) => e.area === 'staged').length ?? 0

/**
 * Why Commit cannot run, in Orca's order, or null when it can. Conflicts and staged files are
 * read from the status; `message` is trimmed here.
 */
export function commitDisabledReason(state: LadderState): string | null {
  if (hasUnresolved(state.status)) return 'Resolve conflicts before committing'
  if (stagedCount(state.status) === 0) return 'Stage at least one file to commit'
  if (state.message.trim() === '') return 'Enter a commit message to commit'
  return null
}

const commitRow = (title: string): PrimaryAction => ({ kind: 'commit', label: 'Commit', enabled: false, title })

/** Rows 4 to 16 of the ladder: what the button would be if nothing were running. */
function pick(state: LadderState): PrimaryAction {
  const { status } = state
  if (hasUnresolved(status)) return commitRow('Resolve conflicts before committing')
  const staged = stagedCount(status)
  if (staged > 0) {
    return state.message.trim() === ''
      ? commitRow('Enter a commit message to commit')
      : { kind: 'commit', label: 'Commit', enabled: true, title: 'Commit staged changes' }
  }
  if (status?.entries.some((e) => isStageable(e))) {
    return { kind: 'stage', label: 'Stage All', enabled: true, title: 'Stage all changes' }
  }
  if (status === null) return commitRow('Stage at least one file to commit')
  const up = status.upstreamStatus
  if (!up.hasUpstream) {
    if (status.detached) return commitRow('Check out a branch before publishing commits.')
    return { kind: 'publish', label: 'Publish Branch', enabled: true, title: 'Publish this branch to origin' }
  }
  if (up.ahead > 0 && up.behind > 0) {
    if (shouldForcePushWithLease(up)) {
      return {
        kind: 'force-push',
        label: 'Force Push',
        enabled: true,
        title: `Remote only has older copies of local commits. Force push ${up.ahead} branch commits with lease to update ${up.name ?? status.upstream ?? 'the remote'}.`
      }
    }
    return { kind: 'sync', label: 'Sync', enabled: true, title: `Pull ${up.behind}, push ${up.ahead}` }
  }
  if (up.behind > 0) return { kind: 'pull', label: 'Pull', enabled: true, title: `Pull ${up.behind} commit(s)` }
  if (up.ahead > 0) return { kind: 'push', label: 'Push', enabled: true, title: `Push ${up.ahead} commit(s)` }
  return commitRow('Nothing to commit. Branch is up to date.')
}

/**
 * The primary button for logic SC-28 (rows 2, 3, 4, 7 to 14 and 16; the pull-request rows belong
 * to a later milestone). The first matching row wins, in this order: committing, a running
 * operation, then the ladder from conflicts down.
 *
 * While an operation runs (`status.busy`): a force push shows "Force Push"; push, pull and sync
 * show their own label; fetch, fast-forward and rebase show their label on the pick's `kind`
 * (they have no button of their own); continue and abort leave the pick in place, disabled with
 * a generic title. The button is always disabled in these cases.
 */
export function primaryAction(state: LadderState): PrimaryAction {
  if (state.committing) return commitRow('Commit in progress…')
  const busy = state.status?.busy ?? null
  const candidate = pick(state)
  if (busy === null) return candidate
  if (busy === 'continue' || busy === 'abort') {
    return {
      ...candidate,
      enabled: false,
      title:
        candidate.kind === 'commit'
          ? 'Remote operation in progress — try again once it finishes'
          : 'Remote operation in progress…'
    }
  }
  const kind: PrimaryKind =
    busy === 'push' || busy === 'force-push' || busy === 'pull' || busy === 'sync' ? busy : candidate.kind
  const label = BUSY_LABELS[busy]
  return { kind, label, enabled: false, title: `${label} in progress…` }
}

/** Which action a menu row runs. `commit-push` is a force push under the lease predicate. */
export type MenuItemId =
  | 'commit'
  | 'commit-push'
  | 'commit-sync'
  | 'push'
  | 'force-push'
  | 'pull'
  | 'fast-forward'
  | 'sync'
  | 'rebase'
  | 'fetch'
  | 'publish'
  | 'abort'

/** One row of the chevron menu. `title` is the tooltip: the reason when disabled. */
export type MenuItem = {
  id: MenuItemId
  label: string
  enabled: boolean
  title?: string
  separatorBefore?: boolean
}

const stripRemotePrefix = (ref: string): string => ref.replace(/^(?:refs\/)?remotes\//, '')

const withCount = (label: string, n: number): string => (n > 0 ? `${label} (${n})` : label)

/**
 * The chevron menu of SC-29, in order, every row present and dimmed when it does not apply,
 * without Orca's pull-request rows. The first row of a group after the commit rows carries
 * `separatorBefore`, and "Abort merge" / "Abort rebase" is appended during those operations
 * (cherry-picks have no abort). Compound rows commit first and run their remote part only if
 * the commit succeeded; that sequencing belongs to the caller.
 */
export function menuItems(state: LadderState): MenuItem[] {
  const { status } = state
  const up = status?.upstreamStatus
  const lease = up ? shouldForcePushWithLease(up) : false
  const detached = status?.detached ?? false
  const hasUpstream = up?.hasUpstream ?? false
  const commitReason = commitDisabledReason(state)

  // the single reason that switches off every row, if any
  const blocked: string | null = state.committing
    ? 'Commit in progress…'
    : status?.busy
      ? `${BUSY_LABELS[status.busy]} in progress…`
      : null
  const loading = status === null ? 'Loading status…' : null

  const row = (
    id: MenuItemId,
    label: string,
    reason: string | null,
    options: { title?: string; separatorBefore?: boolean } = {}
  ): MenuItem => {
    const why = blocked ?? loading ?? reason
    const item: MenuItem = { id, label, enabled: why === null }
    const title = why ?? options.title
    if (title !== undefined) item.title = title
    if (options.separatorBefore) item.separatorBefore = true
    return item
  }

  const branchReason = detached ? 'Check out a branch first' : null
  const upstreamReason = branchReason ?? (hasUpstream ? null : 'Publish Branch')
  const syncReason = upstreamReason ?? (lease ? 'Force Push first' : null)
  const base = state.base === null ? null : stripRemotePrefix(state.base)
  const ahead = up?.ahead ?? 0
  const behind = up?.behind ?? 0

  const items: MenuItem[] = [
    row('commit', 'Commit', commitReason),
    row('commit-push', lease ? 'Commit & Force Push' : 'Commit & Push', commitReason ?? branchReason),
    row('commit-sync', 'Commit & Sync', commitReason ?? syncReason),
    row('push', withCount('Push', ahead), branchReason, { separatorBefore: true }),
    row('force-push', withCount('Force Push', ahead), branchReason),
    row('pull', withCount('Pull', behind), upstreamReason),
    row('fast-forward', withCount('Fast-forward', behind), upstreamReason),
    row('sync', hasUpstream && (ahead > 0 || behind > 0) ? `Sync (↓${behind} ↑${ahead})` : 'Sync', syncReason),
    row(
      'rebase',
      base === null ? 'Rebase from Base' : `Rebase from ${base}`,
      base?.includes('/') ? null : 'Base branch is not on the remote'
    ),
    row('fetch', 'Fetch', null, { title: 'Fetch from remote without merging' }),
    row('publish', 'Publish Branch', branchReason ?? (hasUpstream ? 'Branch already has an upstream' : null))
  ]
  if (status?.operation === 'merge' || status?.operation === 'rebase') {
    items.push(row('abort', `Abort ${status.operation}`, null, { separatorBefore: true }))
  }
  return items
}
