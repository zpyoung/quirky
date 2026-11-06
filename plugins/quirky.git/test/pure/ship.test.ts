import { describe, expect, test } from 'bun:test'
import type { GitStatus, GitStatusEntry, ReviewFile, ReviewModel } from '@quirky/protocol'
import type { GitHubReviewLookup } from '../../src/panel/GitHubReview'
import { isBaseBranch, nextStep, shipMenu, type ShipMenuId, type ShipState } from '../../src/panel/ship'

const target = { worktree: 'feat', branch: 'zoe/feat', head: 'a'.repeat(40) }
const noReview: GitHubReviewLookup = { kind: 'no-review', target }
const found = (number = 12): GitHubReviewLookup => ({ kind: 'found', target, review: { number, url: 'https://github.com/o/r/pull/12', state: 'open' } })

const entry = (path: string, area: GitStatusEntry['area'] = 'unstaged'): GitStatusEntry => ({
  path,
  area,
  status: area === 'untracked' ? 'untracked' : 'modified'
})

const upstream = (ahead = 0, behind = 0, extra: Partial<GitStatus['upstreamStatus']> = {}): GitStatus['upstreamStatus'] => ({
  hasUpstream: true,
  name: 'origin/zoe/feat',
  sha: 'b'.repeat(40),
  ahead,
  behind,
  behindPatchEquivalent: null,
  ...extra
})
const NO_UPSTREAM: GitStatus['upstreamStatus'] = { hasUpstream: false, name: null, sha: null, ahead: 0, behind: 0, behindPatchEquivalent: null }

function statusOf(entries: GitStatusEntry[] = [], up: GitStatus['upstreamStatus'] = upstream(), extra: Partial<GitStatus> = {}): GitStatus {
  return {
    branch: 'zoe/feat',
    upstream: up.name,
    ahead: up.ahead,
    behind: up.behind,
    files: [],
    head: 'a'.repeat(40),
    detached: false,
    unborn: false,
    entries,
    operation: 'none',
    capped: false,
    upstreamStatus: up,
    busy: null,
    ...extra
  }
}

function reviewOf(files: number, compare: ReviewModel['compare']['status'] = 'ready', base = 'origin/main'): ReviewModel {
  const list: ReviewFile[] = Array.from({ length: files }, (_, i) => ({
    path: `f${i}.ts`,
    status: 'M',
    added: 1,
    removed: 0,
    binary: false,
    uncommitted: false,
    staged: false,
    mark: 'none',
    notes: 0
  }))
  return {
    worktreeId: 'feat',
    branch: 'zoe/feat',
    base: { name: base, source: 'detected', isCurrentBranch: false },
    compare: { status: compare, mergeBase: null, headOid: null },
    totals: { added: files, removed: 0 },
    counts: { files, reviewed: 0, changed: 0, uncommitted: 0, staged: 0 },
    capped: false,
    files: list
  }
}

function state(overrides: Partial<ShipState> = {}): ShipState {
  return {
    review: reviewOf(2),
    status: statusOf(),
    github: noReview,
    message: '',
    busy: null,
    selected: null,
    isBaseBranch: false,
    ...overrides
  }
}

describe('nextStep follows the table of scenario 22 in order', () => {
  test('uncommitted changes with some staged by hand: Commit N staged files', () => {
    const step = nextStep(state({ status: statusOf([entry('a.ts', 'staged'), entry('b.ts', 'staged'), entry('c.ts')]) }))
    expect(step).toEqual({ kind: 'commit-staged', label: 'Commit 2 staged files', enabled: true })
  })

  test('one staged file reads in the singular', () => {
    expect(nextStep(state({ status: statusOf([entry('a.ts', 'staged')]) }))?.label).toBe('Commit 1 staged file')
  })

  test('uncommitted changes, none staged: Commit N files, new files included', () => {
    const step = nextStep(state({ status: statusOf([entry('a.ts'), entry('b.ts'), entry('new.ts', 'untracked')]) }))
    expect(step).toEqual({ kind: 'commit-all', label: 'Commit 3 files', enabled: true })
  })

  test('a file with both staged and unstaged changes counts once', () => {
    const step = nextStep(state({ status: statusOf([entry('a.ts', 'staged'), entry('a.ts', 'unstaged'), entry('b.ts')]) }))
    expect(step?.label).toBe('Commit 1 staged file')
  })

  test('behind and not ahead: Pull N commits', () => {
    expect(nextStep(state({ status: statusOf([], upstream(0, 2)) }))).toEqual({ kind: 'pull', label: 'Pull 2 commits', enabled: true })
    expect(nextStep(state({ status: statusOf([], upstream(0, 1)) }))?.label).toBe('Pull 1 commit')
  })

  test('ahead and behind: Sync', () => {
    expect(nextStep(state({ status: statusOf([], upstream(2, 3)) }))).toEqual({ kind: 'sync', label: 'Sync', enabled: true })
  })

  test('ahead and behind with every behind commit a rebased copy: a force push of the ahead commits', () => {
    const step = nextStep(state({ status: statusOf([], upstream(2, 2, { behindPatchEquivalent: true })) }))
    expect(step).toEqual({ kind: 'push', label: 'Force push 2 commits', enabled: true })
  })

  test('no upstream: Publish branch', () => {
    expect(nextStep(state({ status: statusOf([], NO_UPSTREAM) }))).toEqual({ kind: 'publish', label: 'Publish branch', enabled: true })
  })

  test('no upstream on a detached head cannot publish', () => {
    const step = nextStep(state({ status: statusOf([], NO_UPSTREAM, { branch: null, detached: true }) }))
    expect(step).toMatchObject({ kind: 'publish', enabled: false, reason: 'check out a branch first' })
  })

  test('commits not yet pushed: Push N commits', () => {
    expect(nextStep(state({ status: statusOf([], upstream(4, 0)) }))).toEqual({ kind: 'push', label: 'Push 4 commits', enabled: true })
    expect(nextStep(state({ status: statusOf([], upstream(1, 0)) }))?.label).toBe('Push 1 commit')
  })

  test('pushed to a GitHub remote with no PR: Create PR', () => {
    expect(nextStep(state())).toEqual({ kind: 'create-pr', label: 'Create PR', enabled: true })
  })

  test('a PR is open: View PR #N', () => {
    expect(nextStep(state({ github: found(12) }))).toEqual({ kind: 'view-pr', label: 'View PR #12', enabled: true })
  })

  test('nothing differs from the base and nothing to push: no ship bar', () => {
    expect(nextStep(state({ review: reviewOf(0) }))).toBeNull()
  })

  test('nothing differs from the base on a branch with no upstream: no ship bar', () => {
    expect(nextStep(state({ review: reviewOf(0), status: statusOf([], NO_UPSTREAM) }))).toBeNull()
  })

  test('a status that is still loading shows no ship bar', () => {
    expect(nextStep(state({ status: null }))).toBeNull()
  })
})

describe('precedence', () => {
  test('uncommitted changes beat every remote step', () => {
    const status = statusOf([entry('a.ts')], upstream(2, 2))
    expect(nextStep(state({ status }))?.kind).toBe('commit-all')
  })

  test('staged beats unstaged', () => {
    expect(nextStep(state({ status: statusOf([entry('a.ts'), entry('b.ts', 'staged')], upstream(3, 3)) }))?.kind).toBe('commit-staged')
  })

  test('pull beats publish, push and the PR rows', () => {
    expect(nextStep(state({ status: statusOf([], upstream(0, 1)), github: found() }))?.kind).toBe('pull')
  })

  test('sync beats push', () => {
    expect(nextStep(state({ status: statusOf([], upstream(1, 1)) }))?.kind).toBe('sync')
  })

  test('publish beats create PR', () => {
    expect(nextStep(state({ status: statusOf([], NO_UPSTREAM) }))?.kind).toBe('publish')
  })

  test('push beats create PR and view PR', () => {
    expect(nextStep(state({ status: statusOf([], upstream(1, 0)), github: found() }))?.kind).toBe('push')
  })

  test('unpushed commits with nothing differing from the base still push', () => {
    expect(nextStep(state({ review: reviewOf(0), status: statusOf([], upstream(2, 0)) }))?.label).toBe('Push 2 commits')
  })

  test('a selection turns the commit into Commit N of M files, whatever was staged', () => {
    const status = statusOf([entry('a.ts', 'staged'), entry('b.ts'), entry('c.ts')])
    const step = nextStep(state({ status, selected: new Set(['a.ts', 'b.ts']) }))
    expect(step).toEqual({ kind: 'commit-selected', label: 'Commit 2 of 3 files', enabled: true })
  })

  test('a selection of nothing cannot commit', () => {
    const status = statusOf([entry('a.ts'), entry('b.ts')])
    expect(nextStep(state({ status, selected: new Set() }))).toEqual({
      kind: 'commit-selected',
      label: 'Commit 0 of 2 files',
      enabled: false,
      reason: 'tick at least one file'
    })
  })

  test('ticks of files that are no longer uncommitted do not count', () => {
    const status = statusOf([entry('a.ts'), entry('b.ts')])
    expect(nextStep(state({ status, selected: new Set(['a.ts', 'gone.ts']) }))?.label).toBe('Commit 1 of 2 files')
  })

  test('a selection with nothing left uncommitted falls through to the remote steps', () => {
    expect(nextStep(state({ selected: new Set(['a.ts']) }))?.kind).toBe('create-pr')
  })
})

describe('the commit steps carry no message guard', () => {
  test('an empty message leaves Commit enabled', () => {
    expect(nextStep(state({ status: statusOf([entry('a.ts')]), message: '' }))?.enabled).toBe(true)
    expect(nextStep(state({ status: statusOf([entry('a.ts', 'staged')]), message: '   ' }))?.enabled).toBe(true)
  })
})

describe('the GitHub lookup', () => {
  test.each([
    ['loading', { kind: 'loading', target } as GitHubReviewLookup],
    ['waiting', { kind: 'waiting' } as GitHubReviewLookup]
  ])('while it is %s Create PR is disabled with a reason', (_, github) => {
    expect(nextStep(state({ github }))).toEqual({
      kind: 'create-pr',
      label: 'Create PR',
      enabled: false,
      reason: 'checking for a pull request…'
    })
  })

  test.each([
    ['loading', { kind: 'loading', target } as GitHubReviewLookup],
    ['waiting', { kind: 'waiting' } as GitHubReviewLookup]
  ])('while it is %s the push steps wait for it, since a linked PR changes where they go', (_, github) => {
    const reason = 'checking for a pull request…'
    expect(nextStep(state({ github, status: statusOf([], upstream(2, 0)) }))).toMatchObject({ kind: 'push', enabled: false, reason })
    expect(nextStep(state({ github, status: statusOf([], NO_UPSTREAM) }))).toMatchObject({ kind: 'publish', enabled: false, reason })
    expect(nextStep(state({ github, status: statusOf([], upstream(1, 1)) }))).toMatchObject({ kind: 'sync', enabled: false, reason })
    expect(nextStep(state({ github, status: statusOf([], upstream(0, 1)) }))).toMatchObject({ kind: 'pull', enabled: true })
    const items = shipMenu(state({ github, status: statusOf([], upstream(2, 0)) }))
    expect(items.find((item) => item.id === 'push')).toMatchObject({ enabled: false, detail: reason })
    expect(items.find((item) => item.id === 'force-push')).toMatchObject({ enabled: false, detail: reason })
  })

  test('a merged PR holds the push steps with the reason', () => {
    const github: GitHubReviewLookup = { kind: 'found', target, review: { number: 5, url: 'https://github.com/o/r/pull/5', state: 'merged' } }
    const reason = 'the pull request is already merged'
    expect(nextStep(state({ github, status: statusOf([], NO_UPSTREAM) }))).toMatchObject({ kind: 'publish', enabled: false, reason })
    expect(nextStep(state({ github, status: statusOf([], upstream(2, 0)) }))).toMatchObject({ kind: 'push', enabled: false, reason })
    expect(nextStep(state({ github }))).toMatchObject({ kind: 'view-pr', enabled: true })
    expect(shipMenu(state({ github, status: statusOf([], upstream(2, 0)) })).find((item) => item.id === 'push')).toMatchObject({ enabled: false, detail: reason })
  })

  test('an unavailable lookup leaves Create PR enabled so pressing it reports the failure', () => {
    const github: GitHubReviewLookup = { kind: 'unavailable', target, message: 'gh is not signed in' }
    expect(nextStep(state({ github }))).toEqual({ kind: 'create-pr', label: 'Create PR', enabled: true })
  })

  test('no GitHub remote: a quiet up-to-date line', () => {
    const step = nextStep(state({ github: { kind: 'unsupported', target } }))
    expect(step).toEqual({ kind: 'up-to-date', label: 'Pushed to origin/zoe/feat', enabled: false, reason: 'no GitHub remote' })
  })

  test('the base branch with nothing to push: a quiet up-to-date line', () => {
    const step = nextStep(state({ isBaseBranch: true, review: reviewOf(1) }))
    expect(step).toEqual({ kind: 'up-to-date', label: 'Pushed to origin/zoe/feat', enabled: false, reason: 'this is the base branch' })
  })

  test('an open PR still reads View PR on the base branch', () => {
    expect(nextStep(state({ isBaseBranch: true, github: found(3) }))?.kind).toBe('view-pr')
  })

  test('an unreadable compare still shows the quiet line instead of hiding the bar', () => {
    const step = nextStep(state({ review: reviewOf(0, 'invalid-base'), github: { kind: 'unsupported', target } }))
    expect(step?.kind).toBe('up-to-date')
  })
})

describe('a running operation disables the step with its reason', () => {
  test('commit', () => {
    expect(nextStep(state({ status: statusOf([entry('a.ts')]), busy: 'Commit' }))).toEqual({
      kind: 'commit-all',
      label: 'Commit 1 file',
      enabled: false,
      reason: 'Commit in progress…'
    })
  })

  test('push', () => {
    expect(nextStep(state({ status: statusOf([], upstream(1, 0)), busy: 'Push' }))).toMatchObject({ kind: 'push', enabled: false, reason: 'Push in progress…' })
  })
})

describe('isBaseBranch', () => {
  test('matches the base with or without its remote prefix', () => {
    expect(isBaseBranch('origin/main', 'main')).toBe(true)
    expect(isBaseBranch('refs/remotes/origin/main', 'main')).toBe(true)
    expect(isBaseBranch('main', 'main')).toBe(true)
    expect(isBaseBranch('origin/main', 'zoe/feat')).toBe(false)
    expect(isBaseBranch('origin/main', null)).toBe(false)
    expect(isBaseBranch('', 'main')).toBe(false)
  })
})

describe('shipMenu', () => {
  const byId = (items: ReturnType<typeof shipMenu>, id: ShipMenuId) => items.find((item) => item.id === id)!

  test('lists every step in a fixed order, whatever the state', () => {
    const ids = (s: ShipState): string[] => shipMenu(s).map((item) => item.id)
    const expected = [
      'commit-all',
      'commit-selected',
      'commit-push',
      'commit-push-pr',
      'pull',
      'fast-forward',
      'sync',
      'push',
      'publish',
      'force-push',
      'rebase',
      'fetch',
      'create-pr',
      'view-pr'
    ]
    expect(ids(state())).toEqual(expected)
    expect(ids(state({ status: statusOf([entry('a.ts')], NO_UPSTREAM) }))).toEqual(expected)
    expect(ids(state({ github: found() }))).toEqual(expected)
  })

  test('Commit all N counts every uncommitted file', () => {
    const items = shipMenu(state({ status: statusOf([entry('a.ts', 'staged'), entry('b.ts'), entry('c.ts', 'untracked')]) }))
    expect(byId(items, 'commit-all')).toMatchObject({ label: 'Commit all 3 files', enabled: true })
    expect(byId(items, 'commit-selected')).toMatchObject({ label: 'Commit selected files…', enabled: true })
  })

  test('the commit entries are greyed when nothing is uncommitted', () => {
    const items = shipMenu(state())
    for (const id of ['commit-all', 'commit-selected', 'commit-push', 'commit-push-pr'] as const) {
      expect(byId(items, id)).toMatchObject({ enabled: false, detail: 'nothing to commit' })
    }
  })

  test('no GitHub remote: Create PR is greyed with the reason', () => {
    const items = shipMenu(state({ github: { kind: 'unsupported', target } }))
    expect(byId(items, 'create-pr')).toMatchObject({ label: 'Create PR', enabled: false, detail: 'no GitHub remote' })
    expect(byId(items, 'commit-push-pr')).toMatchObject({ enabled: false, detail: 'no GitHub remote' })
  })

  test('no upstream yet: Pull, Fast-forward, Sync, Push and Force push are greyed, Publish is on', () => {
    const items = shipMenu(state({ status: statusOf([], NO_UPSTREAM) }))
    for (const id of ['pull', 'fast-forward', 'sync', 'push', 'force-push'] as const) {
      expect(byId(items, id)).toMatchObject({ enabled: false, detail: 'no upstream yet' })
    }
    expect(byId(items, 'publish')).toMatchObject({ label: 'Publish branch', enabled: true })
  })

  test('with an upstream Publish is greyed', () => {
    expect(byId(shipMenu(state()), 'publish')).toMatchObject({ enabled: false, detail: 'already published' })
  })

  test('the base branch: Create PR is greyed with "this is the base branch"', () => {
    const items = shipMenu(state({ isBaseBranch: true, status: statusOf([], upstream(2, 0)) }))
    expect(byId(items, 'create-pr')).toMatchObject({ enabled: false, detail: 'this is the base branch' })
    expect(byId(items, 'push')).toMatchObject({ label: 'Push 2 commits', enabled: true })
  })

  test('nothing to force: Force push is greyed until commits are ahead', () => {
    expect(byId(shipMenu(state()), 'force-push')).toMatchObject({ enabled: false, detail: 'nothing to force', danger: true })
    expect(byId(shipMenu(state({ status: statusOf([], upstream(1, 0)) })), 'force-push')).toMatchObject({ enabled: true, danger: true })
  })

  test('Pull and Push carry their counts and grey out when there is nothing to move', () => {
    const behind = shipMenu(state({ status: statusOf([], upstream(0, 2)) }))
    expect(byId(behind, 'pull')).toMatchObject({ label: 'Pull 2 commits', enabled: true })
    expect(byId(behind, 'push')).toMatchObject({ label: 'Push', enabled: false, detail: 'nothing to push' })
    expect(byId(behind, 'fast-forward')).toMatchObject({ enabled: true })
    const level = shipMenu(state())
    expect(byId(level, 'pull')).toMatchObject({ label: 'Pull', enabled: false, detail: 'nothing to pull' })
    expect(byId(level, 'fast-forward')).toMatchObject({ enabled: false, detail: 'nothing to pull' })
  })

  test('Sync needs commits on one side', () => {
    expect(byId(shipMenu(state()), 'sync')).toMatchObject({ enabled: false, detail: 'already in sync' })
    expect(byId(shipMenu(state({ status: statusOf([], upstream(1, 1)) })), 'sync')).toMatchObject({ enabled: true })
  })

  test('Fast-forward and Rebase from base are always listed', () => {
    const items = shipMenu(state())
    expect(byId(items, 'fast-forward').label).toBe('Fast-forward')
    expect(byId(items, 'rebase')).toMatchObject({ label: 'Rebase from origin/main', enabled: true })
  })

  test('Rebase from base is greyed when the base is not on the remote', () => {
    const items = shipMenu(state({ review: reviewOf(1, 'ready', 'main') }))
    expect(byId(items, 'rebase')).toMatchObject({ label: 'Rebase from main', enabled: false, detail: 'base is not on the remote' })
  })

  test('Rebase from base is greyed while there is no base', () => {
    expect(byId(shipMenu(state({ review: null })), 'rebase')).toMatchObject({ label: 'Rebase from base', enabled: false })
  })

  test('View PR is greyed with no PR and on once one is open', () => {
    expect(byId(shipMenu(state()), 'view-pr')).toMatchObject({ label: 'View PR', enabled: false, detail: 'no pull request yet' })
    expect(byId(shipMenu(state({ github: found(12) })), 'view-pr')).toMatchObject({ label: 'View PR #12', enabled: true })
    expect(byId(shipMenu(state({ github: found(12) })), 'create-pr')).toMatchObject({ enabled: false, detail: 'PR #12 is already open' })
  })

  test('Create PR while the lookup runs is greyed with the checking reason', () => {
    expect(byId(shipMenu(state({ github: { kind: 'waiting' } })), 'create-pr')).toMatchObject({ enabled: false, detail: 'checking for a pull request…' })
  })

  test('Create PR waits for the commits to be pushed', () => {
    expect(byId(shipMenu(state({ status: statusOf([], upstream(1, 0)) })), 'create-pr')).toMatchObject({ enabled: false, detail: 'push first' })
    expect(byId(shipMenu(state({ status: statusOf([], NO_UPSTREAM) })), 'create-pr')).toMatchObject({ enabled: false, detail: 'publish the branch first' })
    expect(byId(shipMenu(state({ status: statusOf([entry('a.ts')]) })), 'create-pr')).toMatchObject({ enabled: false, detail: 'commit your changes first' })
  })

  test('Commit & push and Commit, push & create PR run when there are changes', () => {
    const items = shipMenu(state({ status: statusOf([entry('a.ts')], NO_UPSTREAM) }))
    expect(byId(items, 'commit-push')).toMatchObject({ label: 'Commit & push', enabled: true })
    expect(byId(items, 'commit-push-pr')).toMatchObject({ label: 'Commit, push & create PR', enabled: true })
  })

  test('Commit & push on a detached head is greyed', () => {
    const items = shipMenu(state({ status: statusOf([entry('a.ts')], NO_UPSTREAM, { branch: null, detached: true }) }))
    expect(byId(items, 'commit-push')).toMatchObject({ enabled: false, detail: 'check out a branch first' })
  })

  test('separators open the commit, remote and PR groups', () => {
    const items = shipMenu(state())
    expect(items.filter((item) => item.separatorBefore).map((item) => item.id)).toEqual(['pull', 'create-pr'])
  })

  test('a running operation greys every entry with its reason', () => {
    const items = shipMenu(state({ status: statusOf([entry('a.ts')], upstream(1, 1)), busy: 'Push' }))
    for (const item of items) expect(item).toMatchObject({ enabled: false, detail: 'Push in progress…' })
  })

  test('a status that is still loading greys every entry', () => {
    for (const item of shipMenu(state({ status: null }))) expect(item).toMatchObject({ enabled: false, detail: 'loading status…' })
  })
})
