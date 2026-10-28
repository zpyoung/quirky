import { afterEach, describe, expect, test } from 'bun:test'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import { diverge, isolateScenarioGit, startScenario, type Scenario } from './fixture'

const { scratch } = isolateScenarioGit()
let s: Scenario | undefined

afterEach(async () => {
  await s?.cleanup()
  s = undefined
})

describe('switchBranch', () => {
  test('switches to an advertised local branch with a fresh source snapshot and one changed event', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'release/mobile')
    const status = await s.api('status')
    const branches = await s.api('branches')
    expect(branches.refs).toContainEqual({ name: 'release/mobile', kind: 'local' })

    const description = await s.api('describeSwitchBranch', { branch: 'release/mobile' })
    expect(description).toContain('release/mobile')
    expect(description).toContain('zoe/feat')

    const before = s.changedEvents()
    const switched = await s.api('switchBranch', {
      yes: true,
      branch: 'release/mobile',
      expectedBranch: status.branch,
      expectedHead: status.head
    })
    await waitFor(() => s!.changedEvents() === before + 1)
    expect(s.changedEvents()).toBe(before + 1)
    expect(switched).toMatchObject({ previousBranch: 'zoe/feat', branch: 'release/mobile', changed: true })
    expect((await s.api('status')).branch).toBe('release/mobile')
  })

  test('switches to a listed remote branch by creating a tracking local branch', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'topic/mobile-review')
    s.gitIn('push', 'origin', 'topic/mobile-review')
    s.gitIn('branch', '-D', 'topic/mobile-review')
    s.gitIn('fetch', 'origin')
    const branches = await s.api('branches')
    expect(branches.refs).toContainEqual({ name: 'origin/topic/mobile-review', kind: 'remote' })

    const switched = await s.api('switchBranch', { yes: true, branch: 'origin/topic/mobile-review' })
    expect(switched).toMatchObject({ branch: 'topic/mobile-review', createdTrackingBranch: true })
    expect((await s.api('status'))).toMatchObject({
      branch: 'topic/mobile-review',
      upstreamStatus: { hasUpstream: true, name: 'origin/topic/mobile-review' }
    })
  })

  test('rejects absent and option-looking refs without changing HEAD', async () => {
    s = await startScenario(scratch)
    const before = s.gitIn('rev-parse', 'HEAD')
    for (const branch of ['--detach', 'not/a/branch']) {
      const failure = await s.fails(s.api('switchBranch', { yes: true, branch }))
      expect(failure.data.reason).toBe('not-allowed')
      expect(s.gitIn('rev-parse', 'HEAD')).toBe(before)
    }
  })

  test('rejects staged, modified, and untracked worktree state', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'release/clean-only')
    s.write('README.md', 'modified\n')
    const modified = await s.fails(s.api('switchBranch', { yes: true, branch: 'release/clean-only' }))
    expect(modified.data.reason).toBe('local-changes')
    s.gitIn('checkout', '--', 'README.md')

    s.write('untracked-mobile.txt', 'untracked\n')
    const untracked = await s.fails(s.api('switchBranch', { yes: true, branch: 'release/clean-only' }))
    expect(untracked.data.reason).toBe('local-changes')
    expect(s.gitIn('branch', '--show-current')).toBe('zoe/feat')
  })

  test('rejects when a changed file is staged', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'release/staged-guard')
    s.write('README.md', 'staged\n')
    s.gitIn('add', 'README.md')
    const failure = await s.fails(s.api('switchBranch', { yes: true, branch: 'release/staged-guard' }))
    expect(failure.data.reason).toBe('local-changes')
    expect(s.gitIn('branch', '--show-current')).toBe('zoe/feat')
  })

  test('rejects active conflicts before attempting to switch', async () => {
    s = await startScenario(scratch)
    diverge(s, { 'README.md': 'theirs\n' }, { 'README.md': 'ours\n' })
    expect(s.gitTry(undefined, 'merge', 'other').code).not.toBe(0)
    const failure = await s.fails(s.api('switchBranch', { yes: true, branch: 'other' }))
    expect(failure.data.reason).toBe('conflicts')
    expect((await s.api('status')).operation).toBe('merge')
  })

  test('rejects a stale expected HEAD before changing branches', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'release/stale')
    const old = await s.api('status')
    s.gitIn('commit', '--allow-empty', '-m', 'advance head after page read')
    const failure = await s.fails(
      s.api('switchBranch', { yes: true, branch: 'release/stale', expectedBranch: old.branch, expectedHead: old.head })
    )
    expect(failure.data.reason).toBe('branch-changed')
    expect(s.gitIn('branch', '--show-current')).toBe('zoe/feat')
  })

  test('requires explicit confirmation for the generated CLI command', async () => {
    s = await startScenario(scratch)
    s.gitIn('branch', 'release/confirm')
    const source = await s.api('status')
    const args = ['git', 'switchBranch', '--branch', 'release/confirm', '--expected-branch', String(source.branch), '--expected-head', String(source.head)]
    const declined = await s.cliAsk(args, false)
    expect(declined.code).not.toBe(0)
    expect(declined.stderr).toContain('release/confirm')
    expect(s.gitIn('branch', '--show-current')).toBe('zoe/feat')

    const confirmed = await s.cliAsk(args, true)
    expect(confirmed.code).toBe(0)
    expect(s.gitIn('branch', '--show-current')).toBe('release/confirm')
  })
})
