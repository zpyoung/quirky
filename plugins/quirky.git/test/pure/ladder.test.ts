import { describe, expect, test } from 'bun:test'
import type { GitBusyOp, GitStatus, GitStatusEntry, GitUpstreamStatus } from '@quirky/protocol'
import { menuItems, primaryAction, shouldForcePushWithLease, type LadderState, type MenuItem } from '../../src/panel/ladder'

const entry = (path: string, area: GitStatusEntry['area'], extra: Partial<GitStatusEntry> = {}): GitStatusEntry => ({
  path,
  area,
  status: area === 'untracked' ? 'untracked' : 'modified',
  ...extra
})

const upstream = (over: Partial<GitUpstreamStatus> = {}): GitUpstreamStatus => ({
  hasUpstream: true,
  name: 'origin/zoe/feat',
  sha: 'abc',
  ahead: 0,
  behind: 0,
  behindPatchEquivalent: null,
  ...over
})

const status = (over: Partial<GitStatus> & { up?: Partial<GitUpstreamStatus> } = {}): GitStatus => {
  const { up, ...rest } = over
  return {
    branch: 'zoe/feat',
    upstream: 'origin/zoe/feat',
    ahead: 0,
    behind: 0,
    files: [],
    head: 'deadbeef',
    detached: false,
    unborn: false,
    entries: [],
    operation: 'none',
    capped: false,
    upstreamStatus: upstream(up),
    busy: null,
    ...rest
  }
}

const state = (over: Partial<LadderState> = {}): LadderState => ({
  status: status(),
  message: '',
  committing: false,
  base: 'origin/main',
  ...over
})

const staged = [entry('a.ts', 'staged')]
const changed = [entry('b.ts', 'unstaged')]

describe('primaryAction, SC-28 rows', () => {
  test('row 2: committing', () => {
    expect(primaryAction(state({ committing: true, message: 'x', status: status({ entries: staged }) }))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Commit in progress…'
    })
  })

  test('row 2 wins over a running remote operation', () => {
    expect(primaryAction(state({ committing: true, status: status({ busy: 'push' }) })).title).toBe('Commit in progress…')
  })

  test('row 4: unresolved conflicts', () => {
    const conflict = entry('c.ts', 'conflicts', { conflict: { kind: 'both_modified', state: 'unresolved' } })
    expect(primaryAction(state({ message: 'm', status: status({ entries: [conflict, ...staged] }) }))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Resolve conflicts before committing'
    })
  })

  test('a conflict resolved locally does not block', () => {
    const conflict = entry('c.ts', 'conflicts', { conflict: { kind: 'both_modified', state: 'resolved_locally' } })
    expect(primaryAction(state({ status: status({ entries: [conflict, ...staged] }) })).title).toBe(
      'Enter a commit message to commit'
    )
  })

  test('row 7: staged files and a message', () => {
    expect(primaryAction(state({ message: ' fix ', status: status({ entries: staged }) }))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: true,
      title: 'Commit staged changes'
    })
  })

  test('row 8: staged files, no message (whitespace only counts as none)', () => {
    const expected = { kind: 'commit', label: 'Commit', enabled: false, title: 'Enter a commit message to commit' }
    expect(primaryAction(state({ status: status({ entries: staged }) }))).toEqual(expected as never)
    expect(primaryAction(state({ message: '  \n ', status: status({ entries: staged }) }))).toEqual(expected as never)
  })

  test('row 9: nothing staged, something stageable', () => {
    expect(primaryAction(state({ message: 'x', status: status({ entries: changed }) }))).toEqual({
      kind: 'stage',
      label: 'Stage All',
      enabled: true,
      title: 'Stage all changes'
    })
    expect(primaryAction(state({ status: status({ entries: [entry('n', 'untracked')] }) })).kind).toBe('stage')
  })

  test('row 9 does not count submodule rows as stageable', () => {
    const sub = entry('v', 'unstaged', { submodule: { commitChanged: true, trackedChanges: false, untrackedChanges: false } })
    expect(primaryAction(state({ status: status({ entries: [sub] }) })).kind).toBe('commit')
  })

  test('row 10: upstream still loading', () => {
    expect(primaryAction(state({ status: null }))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Stage at least one file to commit'
    })
  })

  test('row 11: detached HEAD', () => {
    expect(primaryAction(state({ status: status({ detached: true, branch: null, up: { hasUpstream: false, name: null } }) }))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Check out a branch before publishing commits.'
    })
  })

  test('row 11: no upstream publishes', () => {
    expect(primaryAction(state({ status: status({ up: { hasUpstream: false, name: null } }) }))).toEqual({
      kind: 'publish',
      label: 'Publish Branch',
      enabled: true,
      title: 'Publish this branch to origin'
    })
  })

  test('row 12: ahead and behind with patch-equivalent commits force-pushes', () => {
    expect(
      primaryAction(state({ status: status({ up: { ahead: 2, behind: 1, behindPatchEquivalent: true } }) }))
    ).toEqual({
      kind: 'force-push',
      label: 'Force Push',
      enabled: true,
      title: 'Remote only has older copies of local commits. Force push 2 branch commits with lease to update origin/zoe/feat.'
    })
  })

  test('row 12: ahead and behind otherwise syncs', () => {
    for (const equivalent of [false, null]) {
      expect(
        primaryAction(state({ status: status({ up: { ahead: 2, behind: 1, behindPatchEquivalent: equivalent } }) }))
      ).toEqual({ kind: 'sync', label: 'Sync', enabled: true, title: 'Pull 1, push 2' })
    }
  })

  test('row 13: behind pulls', () => {
    expect(primaryAction(state({ status: status({ up: { behind: 1 } }) }))).toEqual({
      kind: 'pull',
      label: 'Pull',
      enabled: true,
      title: 'Pull 1 commit(s)'
    })
  })

  test('row 14: ahead pushes', () => {
    expect(primaryAction(state({ status: status({ up: { ahead: 2 } }) }))).toEqual({
      kind: 'push',
      label: 'Push',
      enabled: true,
      title: 'Push 2 commit(s)'
    })
  })

  test('row 16: otherwise nothing to commit', () => {
    expect(primaryAction(state())).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Nothing to commit. Branch is up to date.'
    })
  })

  test('local work comes before remote work', () => {
    const behind = status({ entries: changed, up: { behind: 3 } })
    expect(primaryAction(state({ status: behind })).kind).toBe('stage')
    const ahead = status({ entries: staged, up: { ahead: 3 } })
    expect(primaryAction(state({ message: 'x', status: ahead })).kind).toBe('commit')
  })
})

describe('primaryAction, row 3 in-flight rules', () => {
  const busy = (op: GitBusyOp, over: Partial<GitStatus> & { up?: Partial<GitUpstreamStatus> } = {}) =>
    state({ status: status({ busy: op, ...over }) })

  test('an in-flight force push shows Force Push', () => {
    expect(primaryAction(busy('force-push', { up: { ahead: 2, behind: 1 } }))).toEqual({
      kind: 'force-push',
      label: 'Force Push',
      enabled: false,
      title: 'Force Push in progress…'
    })
  })

  test('an in-flight push on a ladder that would pull shows Push', () => {
    expect(primaryAction(busy('push', { up: { behind: 1 } }))).toEqual({
      kind: 'push',
      label: 'Push',
      enabled: false,
      title: 'Push in progress…'
    })
  })

  test('an in-flight push on a ladder that would push shows Push (SC-30)', () => {
    const result = primaryAction(busy('push', { up: { ahead: 1 } }))
    expect([result.label, result.enabled, result.title]).toEqual(['Push', false, 'Push in progress…'])
  })

  test('an in-flight pull and an in-flight sync', () => {
    expect(primaryAction(busy('pull', { up: { ahead: 1 } }))).toMatchObject({ kind: 'pull', label: 'Pull', title: 'Pull in progress…' })
    expect(primaryAction(busy('sync', { up: { ahead: 1 } }))).toMatchObject({ kind: 'sync', label: 'Sync', title: 'Sync in progress…' })
  })

  test('an in-flight publish is a push of an unpublished branch', () => {
    const result = primaryAction(busy('push', { up: { hasUpstream: false, name: null } }))
    expect([result.label, result.title]).toEqual(['Push', 'Push in progress…'])
  })

  test('fetch, fast-forward and rebase keep the ladder pick and show their own label', () => {
    expect(primaryAction(busy('fetch', { up: { ahead: 1 } }))).toEqual({
      kind: 'push',
      label: 'Fetch',
      enabled: false,
      title: 'Fetch in progress…'
    })
    expect(primaryAction(busy('fast-forward'))).toMatchObject({ kind: 'commit', label: 'Fast-forward' })
    expect(primaryAction(busy('rebase'))).toMatchObject({ label: 'Rebase', title: 'Rebase in progress…' })
  })

  test('continue and abort fall back to the pick, disabled with the generic title', () => {
    expect(primaryAction(busy('abort'))).toEqual({
      kind: 'commit',
      label: 'Commit',
      enabled: false,
      title: 'Remote operation in progress — try again once it finishes'
    })
    expect(primaryAction(busy('continue', { up: { ahead: 2 } }))).toEqual({
      kind: 'push',
      label: 'Push',
      enabled: false,
      title: 'Remote operation in progress…'
    })
  })

  test('a running remote operation outranks unresolved conflicts', () => {
    const conflict = entry('c.ts', 'conflicts', { conflict: { kind: 'both_modified', state: 'unresolved' } })
    expect(primaryAction(busy('pull', { entries: [conflict] })).title).toBe('Pull in progress…')
  })
})

describe('shouldForcePushWithLease', () => {
  test('needs an upstream, both counts, and patch equivalence', () => {
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: true }))).toBe(true)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: false }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 1, behindPatchEquivalent: null }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 0, behind: 1, behindPatchEquivalent: true }))).toBe(false)
    expect(shouldForcePushWithLease(upstream({ ahead: 1, behind: 0, behindPatchEquivalent: true }))).toBe(false)
    expect(
      shouldForcePushWithLease(upstream({ hasUpstream: false, ahead: 1, behind: 1, behindPatchEquivalent: true }))
    ).toBe(false)
  })
})

describe('menuItems', () => {
  const byId = (items: MenuItem[], id: string) => items.find((i) => i.id === id)!
  const ready = state({
    message: 'm',
    status: status({ entries: staged, up: { ahead: 2, behind: 1 } })
  })

  test('order and labels (SC-29)', () => {
    expect(menuItems(ready).map((i) => [i.id, i.label])).toEqual([
      ['commit', 'Commit'],
      ['commit-push', 'Commit & Push'],
      ['commit-sync', 'Commit & Sync'],
      ['push', 'Push (2)'],
      ['force-push', 'Force Push (2)'],
      ['pull', 'Pull (1)'],
      ['fast-forward', 'Fast-forward (1)'],
      ['sync', 'Sync (↓1 ↑2)'],
      ['rebase', 'Rebase from origin/main'],
      ['fetch', 'Fetch'],
      ['publish', 'Publish Branch']
    ])
  })

  test('with an upstream, everything is enabled except Publish', () => {
    const items = menuItems(ready)
    expect(items.filter((i) => !i.enabled).map((i) => i.id)).toEqual(['publish'])
    expect(byId(items, 'publish').title).toBe('Branch already has an upstream')
  })

  test('separators sit after the commit group and before the abort row', () => {
    const items = menuItems(ready)
    expect(items.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(['push'])
    const merging = menuItems(state({ status: status({ operation: 'merge' }) }))
    expect(merging.filter((i) => i.separatorBefore).map((i) => i.id)).toEqual(['push', 'abort'])
  })

  test('commit rows follow the commit reason and name it', () => {
    const noMessage = menuItems(state({ status: status({ entries: staged }) }))
    for (const id of ['commit', 'commit-push', 'commit-sync']) {
      expect(byId(noMessage, id)).toMatchObject({ enabled: false, title: 'Enter a commit message to commit' })
    }
    const nothingStaged = menuItems(state({ message: 'm' }))
    expect(byId(nothingStaged, 'commit')).toMatchObject({ enabled: false, title: 'Stage at least one file to commit' })
    const conflict = entry('c.ts', 'conflicts', { conflict: { kind: 'both_modified', state: 'unresolved' } })
    const conflicted = menuItems(state({ message: 'm', status: status({ entries: [conflict, ...staged] }) }))
    expect(byId(conflicted, 'commit')).toMatchObject({ enabled: false, title: 'Resolve conflicts before committing' })
  })

  test('commit rows are enabled with staged files and a message', () => {
    const items = menuItems(ready)
    expect(['commit', 'commit-push', 'commit-sync'].map((id) => byId(items, id).enabled)).toEqual([true, true, true])
  })

  test('under the lease predicate Commit & Push is Commit & Force Push and Sync rows are off', () => {
    const lease = state({
      message: 'm',
      status: status({ entries: staged, up: { ahead: 2, behind: 1, behindPatchEquivalent: true } })
    })
    const items = menuItems(lease)
    expect(byId(items, 'commit-push').label).toBe('Commit & Force Push')
    expect(byId(items, 'commit-push').enabled).toBe(true)
    expect(byId(items, 'commit-sync')).toMatchObject({ enabled: false, title: 'Force Push first' })
    expect(byId(items, 'sync')).toMatchObject({ enabled: false, title: 'Force Push first' })
    expect(byId(items, 'pull').enabled).toBe(true)
  })

  test('without an upstream: Push and Force Push work, upstream-only rows are off, Publish is on', () => {
    const items = menuItems(state({ message: 'm', status: status({ entries: staged, up: { hasUpstream: false, name: null } }) }))
    expect(byId(items, 'push')).toMatchObject({ label: 'Push', enabled: true })
    expect(byId(items, 'force-push')).toMatchObject({ label: 'Force Push', enabled: true })
    expect(byId(items, 'commit-push').enabled).toBe(true)
    for (const id of ['commit-sync', 'pull', 'fast-forward', 'sync']) {
      expect(byId(items, id)).toMatchObject({ enabled: false, title: 'Publish Branch' })
    }
    expect(byId(items, 'publish').enabled).toBe(true)
    expect(byId(items, 'fetch').enabled).toBe(true)
  })

  test('detached HEAD turns off every row that needs a branch', () => {
    const items = menuItems(
      state({ message: 'm', status: status({ entries: staged, detached: true, branch: null, up: { hasUpstream: false, name: null } }) })
    )
    for (const id of ['commit-push', 'commit-sync', 'push', 'force-push', 'pull', 'fast-forward', 'sync', 'publish']) {
      expect(byId(items, id)).toMatchObject({ enabled: false, title: 'Check out a branch first' })
    }
    expect(byId(items, 'commit').enabled).toBe(true)
    expect(byId(items, 'fetch').enabled).toBe(true)
  })

  test('rebase needs a base ref with a slash and strips remote prefixes', () => {
    expect(byId(menuItems(state({ base: 'refs/remotes/origin/main' })), 'rebase')).toMatchObject({
      label: 'Rebase from origin/main',
      enabled: true
    })
    expect(byId(menuItems(state({ base: 'remotes/origin/dev' })), 'rebase').label).toBe('Rebase from origin/dev')
    expect(byId(menuItems(state({ base: 'main' })), 'rebase')).toMatchObject({
      label: 'Rebase from main',
      enabled: false,
      title: 'Base branch is not on the remote'
    })
    expect(byId(menuItems(state({ base: null })), 'rebase')).toMatchObject({
      label: 'Rebase from Base',
      enabled: false,
      title: 'Base branch is not on the remote'
    })
  })

  test('counts are left out when zero', () => {
    const items = menuItems(state())
    expect(['push', 'force-push', 'pull', 'fast-forward', 'sync'].map((id) => byId(items, id).label)).toEqual([
      'Push',
      'Force Push',
      'Pull',
      'Fast-forward',
      'Sync'
    ])
  })

  test('fetch carries its description', () => {
    expect(byId(menuItems(state()), 'fetch').title).toBe('Fetch from remote without merging')
  })

  test('loading upstream status keeps compound rows and remote rows off', () => {
    const items = menuItems(state({ status: null, message: 'm' }))
    expect(items.every((i) => !i.enabled)).toBe(true)
    expect(byId(items, 'fetch').title).toBe('Loading status…')
  })

  test('every row is disabled while committing or a remote operation runs', () => {
    const committing = menuItems({ ...ready, committing: true })
    expect(committing.every((i) => !i.enabled)).toBe(true)
    expect(committing[0].title).toBe('Commit in progress…')
    const running = menuItems(state({ message: 'm', status: status({ entries: staged, busy: 'fetch' }) }))
    expect(running.every((i) => !i.enabled)).toBe(true)
    expect(running[0].title).toBe('Fetch in progress…')
  })

  test('abort rows appear only during a merge or a rebase', () => {
    expect(menuItems(state()).some((i) => i.id === 'abort')).toBe(false)
    expect(menuItems(state({ status: status({ operation: 'cherry-pick' }) })).some((i) => i.id === 'abort')).toBe(false)
    const merge = menuItems(state({ status: status({ operation: 'merge' }) })).at(-1)!
    expect(merge).toMatchObject({ id: 'abort', label: 'Abort merge', enabled: true })
    const rebase = menuItems(state({ status: status({ operation: 'rebase' }) })).at(-1)!
    expect(rebase).toMatchObject({ id: 'abort', label: 'Abort rebase', enabled: true })
  })

  test('commit rows are off during a merge in progress with unresolved conflicts', () => {
    const conflict = entry('c.ts', 'conflicts', { conflict: { kind: 'both_modified', state: 'unresolved' } })
    const items = menuItems(state({ message: 'm', status: status({ operation: 'merge', entries: [conflict, ...staged] }) }))
    expect(byId(items, 'commit').enabled).toBe(false)
    expect(byId(items, 'abort').enabled).toBe(true)
  })
})
