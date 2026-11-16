import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { builtinsDir, startHarness, waitForAsync, type Harness } from '../../../packages/daemon/test/helpers'
import type { FleetSnapshot, WatcherDetail } from '../../quirky.heimdall/src/control-contracts'
import { bootHosting, type HostingTest } from '../../quirky.hosting/test/helpers'
import { GITHUB_STAND_IN, standInState, type StandInState } from './github-stand-in'

let host: HostingTest

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)
const repository = { host: 'github.com', owner: 'test-owner', repo: 'test-repo' }
const extraBuiltins = [
  'quirky.heimdall',
  'quirky.sitter',
  'quirky.orchestration',
  'quirky.session',
  'quirky.agent-status',
  'quirky.terminal',
  'quirky.agents',
  'quirky.git'
]


beforeAll(async () => {
  host = await bootHosting(GITHUB_STAND_IN, { extraBuiltins })
  host.writeState(standInState({ mergeVisible: false }))
}, 30_000)
afterAll(async () => { await host?.cleanup() })

function cli(host: HostingTest, args: string[]) {
  return host.cli(['heimdall', ...args])
}

function cliJson<T>(output: { stdout: string }, command: string): T {
  try {
    return JSON.parse(output.stdout) as T
  } catch {
    throw new Error(`${command} did not print JSON: ${output.stdout}`)
  }
}

async function detail(host: HostingTest, watcherId: string): Promise<WatcherDetail> {
  return await host.client.callAny('quirky.heimdall/detail', { target: { watcherId } }) as WatcherDetail
}

async function waitFor<T>(read: () => Promise<T>, ready: (value: T) => boolean, description: string): Promise<T> {
  let latest: T | undefined
  try {
    return await waitForAsync(async () => {
      latest = await read()
      return ready(latest) ? latest : undefined
    }, 10_000)
  } catch (error) {
    throw new Error(`Timed out waiting for ${description}: ${JSON.stringify(latest)}`, { cause: error })
  }
}

async function reconcile(host: HostingTest, watcherId: string): Promise<void> {
  await host.client.callAny('quirky.heimdall/reconcile', { watcherId })
}

function attempt(detailValue: WatcherDetail, kind: string) {
  return detailValue.journal.findLast((entry) => entry.kind === 'attempt' &&
    (entry as { action?: { kind?: unknown } }).action?.kind === kind)
}

function attemptEffects(detailValue: WatcherDetail, kind: string): unknown[] {
  return detailValue.journal.flatMap((entry) => {
    if (entry.kind !== 'attempt') return []
    const value = entry as { action?: { kind?: unknown }; effect?: unknown }
    return value.action?.kind === kind ? [value.effect] : []
  })
}

function expectSingleInvocation(
  host: HostingTest,
  matches: (args: string[]) => boolean,
  expectedArgs: string[],
  expectedInput: string,
) {
  const invocations = host.invocations().filter(({ args }) => matches(args))
  expect(invocations).toHaveLength(1)
  const invocation = invocations[0]
  if (!invocation) throw new Error('Expected one GitHub stand-in invocation')
  expect(invocation.args).toEqual(expectedArgs)
  expect(invocation.input).toBe(expectedInput)
}

function watcherIdFrom(value: { enrollment?: { watcherId?: unknown } }): string {
  const watcherId = value.enrollment?.watcherId
  if (typeof watcherId !== 'string' || watcherId.length === 0) throw new Error('Enrollment did not return a watcher ID')
  return watcherId
}

test('enrollment refuses bogus branch-update and check-scope values and closed pull requests while protecting sitter hooks', async () => {

  const active = await cli(host, ['create', 'hosted-review', '--json'])
  expect(active.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string; detail: string }>(active, 'active-worktree enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
    detail: expect.stringContaining('worktree-unresolved'),
  })
  expect(JSON.parse(active.stdout).detail).toContain('--worktree')

  const invalidBranchUpdate = await cli(host, [
    'create', 'hosted-review', '--worktree', `id:${host.worktree}`,
    '--spec', JSON.stringify({ kindPayload: { branchUpdateMode: 'bogus' } }), '--json',
  ])
  expect(invalidBranchUpdate.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string }>(invalidBranchUpdate, 'invalid branch-update enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
  })

  const invalidCheckScope = await cli(host, [
    'create', 'hosted-review', '--worktree', `id:${host.worktree}`,
    '--spec', JSON.stringify({ kindPayload: { mergeCheckScope: 'bogus' } }), '--json',
  ])
  expect(invalidCheckScope.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string }>(invalidCheckScope, 'invalid check-scope enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
  })

  const state = host.readState() as StandInState
  const pull = state.prs[0]
  if (!pull) throw new Error('The stand-in pull request is missing')
  pull.state = 'CLOSED'
  host.writeState(state)
  const closed = await cli(host, ['create', 'hosted-review', '--worktree', `id:${host.worktree}`, '--json'])
  expect(closed.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string; detail: string }>(closed, 'closed pull request enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
    detail: expect.stringContaining('Only an open pull request can be enrolled; #7 is closed.'),
  })
  pull.state = 'OPEN'
  host.writeState(state)


  const kindPayload = {
    worktreeId: host.worktree,
    branch: 'feature',
    headRefName: 'feature',
    provider: 'github',
    reviewNumber: 7,
    reviewUrl: 'https://github.com/test-owner/test-repo/pull/7',
    repository,
    branchUpdateMode: 'rebase',
    mergeMethod: null,
    mergeCheckScope: 'required',
  }
  await expect(host.client.callAny('quirky.sitter/execute', {
    action: {
      kind: 'merge',
      capability: 'merge',
      visibility: 'external',
      contentIdentity: JSON.stringify([H1, B1]),
      evidenceKey: JSON.stringify(['merge', H1, 'squash', 1]),
      expectedState: { target: kindPayload.reviewUrl, before: H1 },
      head: H1,
      method: 'squash',
      ordinal: 1,
    },
    enrollment: {
      watcherId: 'forged-watcher',
      kind: 'hosted-review',
      kindPayload,
      capabilities: { updateBranch: 'off', resolveConflicts: 'off', fixChecks: 'off', merge: 'gated' },
    },
    attemptId: 'forged-attempt',
    fingerprint: 'forged-fingerprint',
  })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })

  const fleet = await host.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot
  expect(fleet.rows).toEqual([])

  expect(host.invocations().filter(({ args }) =>
    args.some((arg) => arg.endsWith('/rerun-failed-jobs') || arg.endsWith('/update-branch')) ||
    args[0] === 'pr' && args[1] === 'merge')).toEqual([])
}, 60_000)

test('sitter enrollment accepts rebase branch mode and required-check scope', async () => {
  const fixture = await startFixFixture()
  try {
    const accepted = await cli(fixture, [
      'create', 'hosted-review', '--worktree', `id:${fixture.worktree}`,
      '--branch-update', 'rebase',
      '--spec', JSON.stringify({ kindPayload: { mergeCheckScope: 'required' } }), '--json',
    ])
    expect(accepted.code).toBe(0)
    const acceptedEnrollment = cliJson<{ kind: string; enrollment?: { watcherId?: unknown } }>(accepted, 'supported sitter options')
    expect(acceptedEnrollment.kind).toBe('enrolled')
    const watcherId = watcherIdFrom(acceptedEnrollment)
    expect((await detail(fixture, watcherId)).enrollment.kindPayload).toMatchObject({
      branchUpdateMode: 'rebase',
      mergeCheckScope: 'required',
    })
    expect((await fixture.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot).rows).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('a GitHub pull request is rerun, brought up to date, held for merge approval the operator grants through the CLI, merged once on the stand-in, and the watcher completes', async () => {
  const createArgs = [
    'create', 'hosted-review', '--worktree', `id:${host.worktree}`,
    '--cap', 'fixChecks=on', '--cap', 'updateBranch=on', '--cap', 'merge=gated', '--json',
  ]
  const created = await cli(host, createArgs)
  expect(created.code).toBe(0)
  const enrollment = cliJson<{ kind: string; enrollment: { watcherId: string } }>(created, 'hosted-review enrollment')
  expect(enrollment.kind).toBe('enrolled')
  const watcherId = watcherIdFrom(enrollment)

  const shown = await cli(host, ['show', watcherId, '--json'])
  expect(shown.code).toBe(0)
  expect(cliJson<WatcherDetail>(shown, 'heimdall show')).toMatchObject({
    enrollment: {
      kind: 'hosted-review',
      kindPayload: { reviewNumber: 7 },
      capabilities: { updateBranch: 'on', resolveConflicts: 'off', fixChecks: 'on', merge: 'gated' },
    },
  })

  const duplicate = await cli(host, createArgs)
  expect(duplicate.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string }>(duplicate, 'duplicate enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'duplicate-workspace',
  })

  await reconcile(host, watcherId)
  const rerunDetail = await waitFor(
    () => detail(host, watcherId),
    (value) => attempt(value, 'rerun-check')?.state === 'settled' && attempt(value, 'rerun-check')?.effect === 'landed',
    'the failed-check rerun',
  )
  expect(attempt(rerunDetail, 'rerun-check')).toMatchObject({ state: 'settled', effect: 'landed', action: { kind: 'rerun-check' } })
  const rerunEndpoint = 'repos/test-owner/test-repo/actions/runs/41/rerun-failed-jobs'
  expectSingleInvocation(host, (args) => args[0] === 'api' && args.includes(rerunEndpoint), [
    'api', '--hostname', 'github.com', rerunEndpoint, '-X', 'POST',
  ], '')
  expect((host.readState() as StandInState).checkRuns).toMatchObject([
    { databaseId: 9002, status: 'QUEUED', conclusion: null }
  ])

  const updatedState = host.readState() as StandInState
  const updatedPull = updatedState.prs[0]
  if (!updatedPull) throw new Error('The stand-in pull request is missing')
  updatedPull.mergeStateStatus = 'BEHIND'
  updatedState.updatedHead = H2
  updatedState.checkRuns = [{
    __typename: 'CheckRun',
    databaseId: 9002,
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'SUCCESS',
    detailsUrl: 'https://github.com/test-owner/test-repo/actions/runs/41/job/9002',
    workflowRunId: 41,
  }]
  host.writeState(updatedState)

  await reconcile(host, watcherId)
  const updateDetail = await waitFor(
    () => detail(host, watcherId),
    (value) => attempt(value, 'update-branch')?.state === 'settled' && attempt(value, 'update-branch')?.effect === 'landed',
    'the branch update',
  )
  expect(attempt(updateDetail, 'update-branch')).toMatchObject({
    state: 'settled',
    effect: 'landed',
    action: { kind: 'update-branch', head: H1 },
    expectedAfter: { head: H2 },
  })
  const updateEndpoint = 'repos/test-owner/test-repo/pulls/7/update-branch'
  expectSingleInvocation(host, (args) => args[0] === 'api' && args.includes(updateEndpoint), [
    'api', '--hostname', 'github.com', updateEndpoint, '-X', 'PUT', '--input', '-',
  ], JSON.stringify({ expected_head_sha: H1 }))

  await reconcile(host, watcherId)
  const held = await waitFor(
    () => detail(host, watcherId),
    (value) => value.status?.state === 'held' && value.status?.reason === 'awaiting-approval',
    'the held merge approval',
  )
  expect(held.openEscalations).toHaveLength(1)
  const escalation = held.openEscalations[0]
  if (!escalation?.approvalScope) throw new Error('The held merge has no approval scope')
  const approvalScope = {
    actionKind: 'merge',
    contentIdentity: JSON.stringify([H2, B1]),
    evidenceKey: JSON.stringify(['merge', H2, 'squash', 1]),
  }
  expect(escalation.approvalScope).toEqual(approvalScope)
  expect(host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toEqual([])

  const stillHeld = await cli(host, ['show', watcherId, '--json'])
  expect(stillHeld.code).toBe(0)
  expect(cliJson<WatcherDetail>(stillHeld, 'held heimdall show')).toMatchObject({
    status: { state: 'held', reason: 'awaiting-approval' },
    openEscalations: [{ escalationId: escalation.escalationId, approvalScope }],
  })
  await reconcile(host, watcherId)
  expect((await detail(host, watcherId)).status).toMatchObject({ state: 'held', reason: 'awaiting-approval' })
  expect(host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toEqual([])

  const approved = await cli(host, ['approve', watcherId, escalation.escalationId, '--json'])
  expect(approved.code).toBe(0)
  expect(cliJson<{ kind: string }>(approved, 'heimdall approval')).toMatchObject({ kind: 'applied' })
  await reconcile(host, watcherId)
  const mergedDetail = await waitFor(
    () => detail(host, watcherId),
    (value) => attempt(value, 'merge')?.state === 'settled' && attempt(value, 'merge')?.effect === 'landed',
    'the approved merge',
  )
  expect(attempt(mergedDetail, 'merge')).toMatchObject({ state: 'settled', effect: 'landed', action: { kind: 'merge', head: H2, method: 'squash' } })
  expectSingleInvocation(host, (args) => args[0] === 'pr' && args[1] === 'merge', [
    'pr', 'merge', '7', '--squash', '--match-head-commit', H2, '--repo', 'github.com/test-owner/test-repo',
  ], '')
  const mergedState = host.readState() as StandInState
  expect(mergedState.prs[0]).toMatchObject({ state: 'MERGED', headRefOid: H2 })
  mergedState.mergeVisible = true
  host.writeState(mergedState)

  await reconcile(host, watcherId)
  const terminal = await waitFor(
    () => detail(host, watcherId),
    (value) => value.status?.state === 'terminal' && value.summary?.state === 'merged',
    'the merged terminal state',
  )
  expect(terminal).toMatchObject({ status: { state: 'terminal' }, summary: { state: 'merged' } })
  const fleet = await host.client.callAny('quirky.heimdall/fleet', {}) as FleetSnapshot
  const row = fleet.rows.find((candidate) => candidate.target.watcherId === watcherId)
  expect(row).toMatchObject({ status: { state: 'terminal' }, enrollment: { enabled: false, terminalAtMs: expect.any(Number) } })
  expect(fleet.activeCount).toBe(0)
  expect(host.invocations().filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')).toHaveLength(1)
}, 60_000)
test('required-check scope ignores optional failing and pending checks when required metadata is complete', async () => {
  const fixture = await startFixFixture()
  try {
    const state = fixture.readState() as StandInState
    const pull = state.prs[0]
    if (!pull) throw new Error('fixture pull request is missing')
    pull.mergeStateStatus = 'UNSTABLE'
    state.checkRuns = [
      checkRun(9711, 'required-build', 'COMPLETED', 'SUCCESS', true),
      checkRun(9712, 'optional-failure', 'COMPLETED', 'FAILURE', false),
      checkRun(9713, 'optional-pending', 'IN_PROGRESS', null, false),
    ]
    fixture.writeState(state)

    const checks = await fixture.call('checks', { number: 7 }) as {
      partial: boolean
      checks: { name: string; required: boolean | null }[]
    }
    expect(checks.partial).toBe(false)
    expect(checks.checks).toHaveLength(3)
    expect(checks.checks).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'required-build', required: true }),
      expect.objectContaining({ name: 'optional-failure', required: false }),
      expect.objectContaining({ name: 'optional-pending', required: false }),
    ]))

    const watcherId = await enrollFixWatcher(fixture, { merge: 'on' }, { mergeCheckScope: 'required' })
    await reconcile(fixture, watcherId)
    const terminal = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'terminal' && value.summary?.state === 'merged',
    'the merged PR despite optional failures and pending checks')
    expect(terminal).toMatchObject({ status: { state: 'terminal' }, summary: { state: 'merged' } })
    const invocations = fixture.invocations()
    const merges = invocations.filter(({ args }) => args[0] === 'pr' && args[1] === 'merge')
    expect(merges).toHaveLength(1)
    expect(merges[0]?.args).toContain(fixture.head)
    expect(invocations.filter(({ args }) => args.some((arg) => arg.endsWith('/rerun-failed-jobs')))).toEqual([])
    expect(fixture.workerRequests()).toEqual([])
    const mergedState = fixture.readState() as StandInState
    expect(mergedState.prs[0]?.state).toBe('MERGED')
    expect(mergedState.checkRuns.find((check) => check.databaseId === 9712)).toMatchObject({
      status: 'COMPLETED',
      conclusion: 'FAILURE',
      required: false,
    })
    expect(mergedState.checkRuns.find((check) => check.databaseId === 9713)).toMatchObject({
      status: 'IN_PROGRESS',
      conclusion: null,
      required: false,
    })
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('incomplete required-check metadata falls back to all checks and reruns a failing optional check', async () => {
  for (const incomplete of ['unknown-requiredness', 'truncated'] as const) {
    const fixture = await startFixFixture()
    try {
      const head = fixture.head
      setCheckFailure(fixture, incomplete === 'unknown-requiredness' ? 9811 : 9812, head,
        incomplete === 'unknown-requiredness' ? null : false)
      const state = fixture.readState() as StandInState
      const pull = state.prs[0]
      if (!pull) throw new Error('fixture pull request is missing')
      pull.mergeStateStatus = 'UNSTABLE'
      state.checksPartial = incomplete === 'truncated'
      fixture.writeState(state)

      const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'on', merge: 'on' }, { mergeCheckScope: 'required' })
      await reconcile(fixture, watcherId)
      const rerun = await waitFor(() => detail(fixture, watcherId), (value) =>
        attempt(value, 'rerun-check')?.state === 'settled' && attempt(value, 'rerun-check')?.effect === 'landed',
      `${incomplete} required-check fallback`)
      expect(attempt(rerun, 'rerun-check')).toMatchObject({
        state: 'settled',
        effect: 'landed',
        action: { kind: 'rerun-check' },
      })
      expect(attempt(rerun, 'merge')).toBeUndefined()
      expect(fixture.workerRequests()).toEqual([])
      expect((fixture.readState() as StandInState).checkRuns[0]).toMatchObject({
        status: 'QUEUED',
        conclusion: null,
        required: incomplete === 'unknown-requiredness' ? null : false,
      })
    } finally {
      await fixture.cleanup()
    }
  }
}, 60_000)

test('rebase branch updates wait for a clean unoccupied worktree and lease-force-push onto the real base branch', async () => {
  const fixture = await startFixFixture({ behind: true })
  try {
    const headA = fixture.head
    const baseB = fixture.baseHead
    const state = fixture.readState() as StandInState
    state.checkRuns = [checkRun(9821, 'required-build', 'COMPLETED', 'SUCCESS', true)]
    fixture.writeState(state)
    const watcherId = await enrollFixWatcher(fixture, { updateBranch: 'on' }, { branchUpdateMode: 'rebase' })

    fixture.makeDirty()
    await reconcile(fixture, watcherId)
    const dirty = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy', 'the dirty rebase worktree hold')
    expect(dirty.status?.detail).toContain('uncommitted-changes')
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(headA)
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)

    fixture.clearDirty()
    fixture.setContention({ terminal: true })
    await reconcile(fixture, watcherId)
    const terminal = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy' &&
        value.status.detail?.includes('terminal') === true, 'the terminal-occupied rebase worktree hold')
    expect(terminal.status?.detail).toContain('terminal')

    fixture.setContention({ terminal: false, agent: true })
    await reconcile(fixture, watcherId)
    const agent = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy' &&
        value.status.detail?.includes('agent') === true, 'the foreground-agent rebase worktree hold')
    expect(agent.status?.detail).toContain('agent')

    fixture.setContention({ terminal: false, agent: false })
    await reconcile(fixture, watcherId)
    const updated = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'update-branch')?.state === 'settled' && attempt(value, 'update-branch')?.effect === 'landed',
    'the real local rebase and guarded push')
    expect(attempt(updated, 'update-branch')).toMatchObject({
      state: 'settled',
      effect: 'landed',
      action: { kind: 'update-branch', mode: 'rebase', head: headA, base: baseB, baseRefName: 'main' },
    })
    const rebasedHead = fixture.git(['rev-parse', 'HEAD'])
    expect(rebasedHead).not.toBe(headA)
    expect(fixture.git(['rev-parse', `${rebasedHead}^`])).toBe(baseB)
    expect(fixture.git(['status', '--porcelain'])).toBe('')
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(rebasedHead)
    expect((fixture.readState() as StandInState).prs[0]).toMatchObject({
      headRefOid: rebasedHead,
      baseRefOid: baseB,
    })
    const leasePushes = fixture.gitPushes().filter((command) => command.includes('--force-with-lease'))
    expect(leasePushes).toHaveLength(1)
    expect(leasePushes[0]).toContain(headA)
    expect(receivePackPushes(fixture)).toMatchObject([{ kind: 'receive-pack' }])
    expect(receivePackPushes(fixture)).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('a rebase conflict aborts cleanly and hands the pull request to the conflict-resolution worker', async () => {
  const fixture = await startFixFixture({ rebaseConflict: true, workerMode: 'conflict' })
  try {
    const headA = fixture.head
    const baseB = fixture.baseHead
    const state = fixture.readState() as StandInState
    state.checkRuns = [checkRun(9831, 'required-build', 'COMPLETED', 'SUCCESS', true)]
    fixture.writeState(state)
    const watcherId = await enrollFixWatcher(
      fixture,
      { updateBranch: 'on', resolveConflicts: 'gated' },
      { branchUpdateMode: 'rebase' },
    )

    await reconcile(fixture, watcherId)
    const held = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'update-branch')?.state === 'settled' &&
        attempt(value, 'update-branch')?.effect === 'not-landed' &&
        attempt(value, 'update-branch')?.reason === 'rebase-conflicts' &&
        value.openEscalations.some((item) => item.approvalScope?.actionKind === 'prepare-conflict-resolution'),
    'the aborted rebase and conflict-resolution approval')
    expect(attempt(held, 'update-branch')).toMatchObject({
      state: 'settled',
      effect: 'not-landed',
      reason: 'rebase-conflicts',
    })
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(headA)
    expect(fixture.git(['status', '--porcelain'])).toBe('')
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(receivePackPushes(fixture)).toEqual([])

    const escalation = held.openEscalations.find((item) =>
      item.approvalScope?.actionKind === 'prepare-conflict-resolution')
    if (!escalation) throw new Error('The conflict-resolution worker approval is missing')
    expect((await cli(fixture, ['approve', watcherId, escalation.escalationId, '--json'])).code).toBe(0)
    await reconcile(fixture, watcherId)
    const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'prepare-conflict-resolution')?.state === 'settled' &&
        attempt(value, 'prepare-conflict-resolution')?.effect === 'landed',
    'the prepared conflict-resolution worker commit')
    expect(attempt(prepared, 'prepare-conflict-resolution')).toMatchObject({
      state: 'settled',
      effect: 'landed',
      action: { kind: 'prepare-conflict-resolution', expectedHeadSha: headA, baseSha: baseB },
    })
    const mergeCommit = fixture.git(['rev-parse', 'HEAD'])
    expect(fixture.git(['rev-list', '--parents', '-n', '1', mergeCommit]).split(/\s+/u).slice(1)).toEqual([headA, baseB])
    expect(fixture.workerRequests()).toHaveLength(1)
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(receivePackPushes(fixture)).toEqual([])
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('an ambiguous merge-queue enqueue settles from the live queue entry and completes after merge', async () => {
  const fixture = await startFixFixture()
  try {
    const head = fixture.head
    const state = fixture.readState() as StandInState
    const pull = state.prs[0]
    if (!pull) throw new Error('fixture pull request is missing')
    pull.mergeStateStatus = 'CLEAN'
    state.mergeQueueRequired = true
    state.mergeAsyncOutcome = 'ambiguous-enqueued'
    state.checkRuns = [checkRun(9841, 'required-build', 'COMPLETED', 'SUCCESS', true)]
    fixture.writeState(state)

    const before = await fixture.call('review', { number: 7 }) as { review: Record<string, unknown> }
    expect(before.review).toMatchObject({
      inMergeQueue: false,
      mergeQueueEntry: null,
      mergeQueueKnown: true,
    })
    const watcherId = await enrollFixWatcher(fixture, { merge: 'on' })
    await reconcile(fixture, watcherId)
    const settled = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'enqueue')?.state === 'settled' &&
        attempt(value, 'enqueue')?.effect === 'landed' &&
        attemptEffects(value, 'enqueue').includes('indeterminate') &&
        value.traces.some((trace) =>
          (trace.decision as { reason?: unknown } | undefined)?.reason === 'awaiting-merge-queue' &&
          (trace.pacing as { tier?: unknown } | undefined)?.tier === 'rapid'),
    'the ambiguous enqueue settlement and rapid queue wait')
    expect(attempt(settled, 'enqueue')).toMatchObject({
      state: 'settled',
      effect: 'landed',
      action: { kind: 'enqueue', head, method: 'squash' },
    })
    expect(attemptEffects(settled, 'enqueue')).toContain('indeterminate')
    expect((fixture.readState() as StandInState).prs[0]?.mergeQueueEntry).toEqual({
      id: 'MQ_test_7',
      state: 'QUEUED',
      position: 1,
    })

    const queued = await fixture.call('review', { number: 7 }) as { review: Record<string, unknown> }
    expect(queued.review).toMatchObject({
      inMergeQueue: true,
      mergeQueueEntry: { id: 'MQ_test_7', state: 'QUEUED', position: 1 },
      mergeQueueKnown: true,
    })
    await reconcile(fixture, watcherId)
    expect(attempt(await detail(fixture, watcherId), 'enqueue')).toMatchObject({
      state: 'settled',
      effect: 'landed',
    })
    const mergeAsync = 'repos/test-owner/test-repo/pulls/7/merge-async'
    const queueCalls = fixture.invocations().filter((invocation) => invocation.args.includes(mergeAsync))
    expect(queueCalls).toHaveLength(1)
    expect(queueCalls[0]?.input).toBe(JSON.stringify({ merge_action: 'merge_queue', sha: head }))

    const mergedState = fixture.readState() as StandInState
    mergedState.prs[0]!.state = 'MERGED'
    mergedState.prs[0]!.mergeQueueEntry = null
    mergedState.mergeVisible = true
    fixture.writeState(mergedState)
    await reconcile(fixture, watcherId)
    const terminal = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'terminal' && value.summary?.state === 'merged',
    'merge after the queued commit settles')
    expect(terminal).toMatchObject({ status: { state: 'terminal' }, summary: { state: 'merged' } })
    expect(fixture.invocations().filter((invocation) => invocation.args.includes(mergeAsync))).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('a pull request ejected from the merge queue parks instead of enqueuing again', async () => {
  const fixture = await startFixFixture()
  try {
    const state = fixture.readState() as StandInState
    const pull = state.prs[0]
    if (!pull) throw new Error('fixture pull request is missing')
    pull.mergeStateStatus = 'CLEAN'
    state.mergeQueueRequired = true
    state.mergeAsyncOutcome = 'enqueued'
    state.checkRuns = [checkRun(9851, 'required-build', 'COMPLETED', 'SUCCESS', true)]
    fixture.writeState(state)

    const watcherId = await enrollFixWatcher(fixture, { merge: 'on' })
    await reconcile(fixture, watcherId)
    const queued = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'enqueue')?.state === 'settled' && attempt(value, 'enqueue')?.effect === 'landed',
    'the initial merge-queue enqueue')
    expect(attempt(queued, 'enqueue')).toMatchObject({ state: 'settled', effect: 'landed' })
    expect((await fixture.call('review', { number: 7 }) as { review: Record<string, unknown> }).review).toMatchObject({
      inMergeQueue: true,
      mergeQueueEntry: { id: 'MQ_test_7', state: 'QUEUED', position: 1 },
      mergeQueueKnown: true,
    })

    const ejectedState = fixture.readState() as StandInState
    ejectedState.prs[0]!.mergeQueueEntry = null
    fixture.writeState(ejectedState)
    expect((await fixture.call('review', { number: 7 }) as { review: Record<string, unknown> }).review).toMatchObject({
      inMergeQueue: false,
      mergeQueueEntry: null,
      mergeQueueKnown: true,
    })
    await reconcile(fixture, watcherId)
    const parked = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'parked' && value.status.reason === 'stop-predicate',
    'the non-merged queue ejection park')
    expect(parked.status?.detail).toContain('merge-queue-ejected:')
    expect(attempt(parked, 'enqueue')).toMatchObject({ state: 'settled', effect: 'landed' })
    expect(fixture.invocations().filter((invocation) =>
      invocation.args.includes('repos/test-owner/test-repo/pulls/7/merge-async'))).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('a persisted check failure is dispatched to a worker, published to the validated bare target, and parked when it repeats', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9001, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'on' })

    await reconcile(fixture, watcherId)
    const rerun = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'rerun-check')?.state === 'settled' && attempt(value, 'rerun-check')?.effect === 'landed', 'the persisted failure rerun')
    expect(attempt(rerun, 'rerun-check')).toMatchObject({ state: 'settled', effect: 'landed' })
    expect((fixture.readState() as StandInState).checkRuns).toMatchObject([{ databaseId: 9002, status: 'QUEUED', conclusion: null }])
    expectSingleInvocation(fixture, (args) =>
      args[0] === 'api' && args.includes('repos/test-owner/test-repo/actions/runs/41/rerun-failed-jobs'), [
      'api', '--hostname', 'github.com', 'repos/test-owner/test-repo/actions/runs/41/rerun-failed-jobs', '-X', 'POST'
    ], '')

    setCheckFailure(fixture, 9002, headA)
    await reconcile(fixture, watcherId)
    const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'prepare-fix')?.state === 'settled' && attempt(value, 'prepare-fix')?.effect === 'landed', 'the prepared local fix')
    const prepareAttempt = attempt(prepared, 'prepare-fix')!
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    expect(commitB).not.toBe(headA)
    expect(fixture.git(['rev-parse', `${commitB}^`])).toBe(headA)
    const commitMessage = fixture.git(['show', '-s', '--format=%B', commitB])
    expect(commitMessage.split('\n').filter((line) => line.startsWith('Orca-Heimdall-Attempt: '))).toEqual([
      `Orca-Heimdall-Attempt: ${prepareAttempt.fingerprint}`
    ])
    expect(fixture.git(['rev-list', '--count', `${headA}..${commitB}`])).toBe('1')
    const worker = fixture.workerRequests().at(-1)!
    expect(worker).toMatchObject({ agent: 'claude', mode: 'structured', worktree: `id:${fixture.worktree}` })
    expect(worker.spec).toContain('failure in the build job')
    expect(worker.spec).not.toContain('d'.repeat(40))
    expect(worker.spec).not.toContain('2026-11-14')
    expect(worker.spec).not.toContain('\u001b')
    expect(worker.spec).not.toContain('123e4567-e89b-12d3-a456-426614174000')
    expect(worker.spec).toContain(`Orca-Heimdall-Attempt: ${prepareAttempt.fingerprint}`)
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    const target = await fixture.client.callAny('quirky.git/pushTarget', {
      worktree: `id:${fixture.worktree}`, purpose: 'review'
    }) as { ready: boolean; headOid?: string }
    expect(target).toMatchObject({ ready: true, headOid: headA })

    await reconcile(fixture, watcherId)
    const published = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'publish-fix')?.state === 'settled' && attempt(value, 'publish-fix')?.effect === 'landed', 'the force-published fix')
    expect(attempt(published, 'publish-fix')).toMatchObject({
      state: 'settled',
      effect: 'landed',
      action: { kind: 'publish-fix', preparedCommitSha: commitB, expectedHeadSha: headA }
    })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitB)
    expect((fixture.readState() as StandInState).prs[0]?.headRefOid).toBe(commitB)
    expect(fixture.forcePushes()).toHaveLength(1)

    setCheckFailure(fixture, 9003, commitB)
    await reconcile(fixture, watcherId)
    const parked = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'parked' && value.status.reason === 'stop-predicate', 'the repeated failure stop')
    expect(parked.status?.detail).toContain('repeated-failure-after-own-fix:')
    expect(attempt(parked, 'prepare-fix')?.action).toMatchObject({ kind: 'prepare-fix', expectedHeadSha: headA })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitB)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('gated publication approval is scoped to the prepared commit and a changed commit needs new approval', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9101, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'gated' })
    await rerunThenPersistFailure(fixture, watcherId, headA, 9102)
    const held = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'awaiting-approval', 'approval for publishing the prepared fix')
    const escalation = held.openEscalations[0]
    if (!escalation?.approvalScope) throw new Error('The publish approval has no scope')
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    expect(escalation.approvalScope).toMatchObject({ actionKind: 'publish-fix', preparedCommitSha: commitB })
    const approved = await cli(fixture, ['approve', watcherId, escalation.escalationId, '--json'])
    expect(approved.code).toBe(0)

    fixture.amendPreparedCommit()
    const commitC = fixture.git(['rev-parse', 'HEAD'])
    expect(commitC).not.toBe(commitB)
    await reconcile(fixture, watcherId)
    const reheld = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'awaiting-approval' &&
      value.openEscalations.some((item) => item.approvalScope?.preparedCommitSha === commitC),
    'fresh approval after the prepared commit changes')
    expect(reheld.openEscalations).toContainEqual(expect.objectContaining({
      approvalScope: expect.objectContaining({ actionKind: 'publish-fix', preparedCommitSha: commitC })
    }))
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(fixture.forcePushes()).toEqual([])
  } finally {
    await fixture.cleanup()
  }
}, 60_000)
test('gated preparation and publication require their exact approvals and publish the prepared commit', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9201, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'gated' })
    await persistRerunFailure(fixture, watcherId, headA, 9202)

    await reconcile(fixture, watcherId)
    const prepareHeld = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'awaiting-approval' &&
      value.openEscalations.some((item) => item.approvalScope?.actionKind === 'prepare-fix'),
    'the exact preparation approval')
    const prepareApproval = prepareHeld.openEscalations.find((item) => item.approvalScope?.actionKind === 'prepare-fix')
    if (!prepareApproval?.approvalScope) throw new Error('The gated preparation has no exact approval scope')
    expect(prepareApproval.approvalScope).toMatchObject({
      actionKind: 'prepare-fix',
      contentIdentity: JSON.stringify([headA, fixture.baseHead])
    })
    expect(prepareApproval.approvalScope.evidenceKey).not.toBe('')
    expect(attempt(prepareHeld, 'prepare-fix')?.effect).not.toBe('landed')
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(fixture.forcePushes()).toEqual([])

    const prepareApproved = await cli(fixture, ['approve', watcherId, prepareApproval.escalationId, '--json'])
    expect(prepareApproved.code).toBe(0)
    await reconcile(fixture, watcherId)
    const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'prepare-fix')?.state === 'settled' && attempt(value, 'prepare-fix')?.effect === 'landed',
    'the approved prepared fix')
    expect(attempt(prepared, 'prepare-fix')).toMatchObject({ state: 'settled', effect: 'landed' })
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    expect(fixture.git(['rev-parse', `${commitB}^`])).toBe(headA)

    await reconcile(fixture, watcherId)
    const publishHeld = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'awaiting-approval' &&
      value.openEscalations.some((item) => item.approvalScope?.actionKind === 'publish-fix'),
    'the prepared-commit publication approval')
    const publishApproval = publishHeld.openEscalations.find((item) => item.approvalScope?.actionKind === 'publish-fix')
    if (!publishApproval?.approvalScope) throw new Error('The prepared publication has no exact approval scope')
    expect(publishApproval.approvalScope.actionKind).toBe('publish-fix')
    expect(publishApproval.approvalScope.preparedCommitSha).toBe(commitB)
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(fixture.forcePushes()).toEqual([])

    const publishApproved = await cli(fixture, ['approve', watcherId, publishApproval.escalationId, '--json'])
    expect(publishApproved.code).toBe(0)
    await reconcile(fixture, watcherId)
    const published = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'publish-fix')?.state === 'settled' && attempt(value, 'publish-fix')?.effect === 'landed',
    'the approved sitter publication')
    expect(attempt(published, 'publish-fix')).toMatchObject({
      state: 'settled',
      effect: 'landed',
      action: { kind: 'publish-fix', preparedCommitSha: commitB, expectedHeadSha: headA }
    })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitB)
    expect(fixture.forcePushes()).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)


test('a conflicting pull request is resolved locally as a two-parent commit and published', async () => {
  const fixture = await startFixFixture({ conflict: true })
  try {
    const headA = fixture.head
    const watcherId = await enrollFixWatcher(fixture, { resolveConflicts: 'on' })
    await reconcile(fixture, watcherId)
    const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'prepare-conflict-resolution')?.state === 'settled' &&
      attempt(value, 'prepare-conflict-resolution')?.effect === 'landed', 'the prepared conflict resolution')
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    const commit = fixture.git(['rev-list', '--parents', '-n', '1', commitB]).split(/\s+/u)
    expect(commit.slice(1)).toEqual([headA, fixture.baseHead])
    const conflictPrepare = attempt(prepared, 'prepare-conflict-resolution')!
    const commitMessage = fixture.git(['show', '-s', '--format=%B', commitB])
    expect(commitMessage.split('\n').filter((line) => line.startsWith('Orca-Heimdall-Attempt: '))).toEqual([
      `Orca-Heimdall-Attempt: ${conflictPrepare.fingerprint}`
    ])
    expect(fixture.git(['rev-list', '--first-parent', '--count', `${headA}..${commitB}`])).toBe('1')

    await reconcile(fixture, watcherId)
    const published = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'publish-conflict-resolution')?.state === 'settled' &&
      attempt(value, 'publish-conflict-resolution')?.effect === 'landed', 'the published conflict resolution')
    expect(attempt(published, 'publish-conflict-resolution')).toMatchObject({
      action: { kind: 'publish-conflict-resolution', preparedCommitSha: commitB, expectedHeadSha: headA }
    })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitB)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('dirty trees, live terminal sessions, and foreground agents hold preparation until each clears', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9201, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'on' })
    await persistRerunFailure(fixture, watcherId, headA, 9202)

    fixture.makeDirty()
    await reconcile(fixture, watcherId)
    const dirty = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy', 'the dirty worktree hold')
    expect(dirty.status?.detail).toContain('uncommitted-changes')

    fixture.clearDirty()
    fixture.setContention({ terminal: true })
    await reconcile(fixture, watcherId)
    const terminal = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy', 'the live terminal hold')
    expect(terminal.status?.detail).toContain('terminal')

    fixture.setContention({ terminal: false, agent: true })
    await reconcile(fixture, watcherId)
    const agent = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'held' && value.status.reason === 'worktree-busy', 'the foreground-agent hold')
    expect(agent.status?.detail).toContain('agent')

    fixture.setContention({ terminal: false, agent: false })
    await reconcile(fixture, watcherId)
    const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'prepare-fix')?.state === 'settled' && attempt(value, 'prepare-fix')?.effect === 'landed',
    'preparation after contention clears')
    expect(attempt(prepared, 'prepare-fix')).toMatchObject({ effect: 'landed' })
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('a worker commit that violates diff policy parks before any bare-remote push', async () => {
  const fixture = await startFixFixture({ workerMode: 'policy' })
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9301, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'on' })
    await rerunThenPersistFailure(fixture, watcherId, headA, 9302)
    await reconcile(fixture, watcherId)
    const parked = await waitFor(() => detail(fixture, watcherId), (value) =>
      value.status?.state === 'parked' && value.status.reason === 'stop-predicate', 'the diff-policy stop')
    expect(parked.status?.detail).toContain('diff-policy-violation:')
    expect(fixture.git(['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'])).toContain('.github/workflows')
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(headA)
    expect(fixture.forcePushes()).toEqual([])
  } finally {
    await fixture.cleanup()
  }
}, 60_000)
test('a lost force-push reply is recovered as landed when a live snapshot observes the pushed SHA', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9401, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'on' })
    fixture.dropNextPushReply()
    await rerunThenPersistFailure(fixture, watcherId, headA, 9402)
    await reconcile(fixture, watcherId)
    const uncertain = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'publish-fix')?.effect === 'indeterminate', 'the unknown push completion')
    expect(attempt(uncertain, 'publish-fix')).toMatchObject({ effect: 'indeterminate' })
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitB)
    expect((fixture.readState() as StandInState).prs[0]?.headRefOid).toBe(headA)

    const state = fixture.readState() as StandInState
    state.prs[0]!.headRefOid = commitB
    state.checkRuns = []
    fixture.writeState(state)
    await reconcile(fixture, watcherId)
    const recovered = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'publish-fix')?.state === 'settled' && attempt(value, 'publish-fix')?.effect === 'landed',
    'the live-snapshot publication recovery')
    expect(attempt(recovered, 'publish-fix')).toMatchObject({ state: 'settled', effect: 'landed' })
    expect(fixture.forcePushes()).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

type FixFixture = HostingTest & {
  head: string
  baseHead: string
  bareRemote: string
  git(args: string[]): string
  bareGit(args: string[]): string
  workerRequests(): Record<string, unknown>[]
  forcePushes(): unknown[]
  gitPushes(): string[]
  dropNextPushReply(): void
  injectConcurrentCommitAfterPublicationLookup(): void
  amendPreparedCommit(): void
  makeDirty(): void
  clearDirty(): void
  setContention(value: { terminal: boolean; agent?: boolean }): void
}

function receivePackPushes(fixture: FixFixture): unknown[] {
  return fixture.forcePushes().filter((entry) => {
    if (typeof entry !== 'object' || entry === null || !('kind' in entry)) return false
    return entry.kind === 'receive-pack'
  })
}

type FixFixtureOptions = {
  conflict?: boolean
  rebaseConflict?: boolean
  behind?: boolean
  workerMode?: 'fix' | 'conflict' | 'policy'
}

const FIXTURE_ENV = [
  'HOME', 'QUIRKY_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_TERMINAL_PROMPT', 'GIT_SSH', 'GIT_SSH_VARIANT',
  'QUIRKY_AGENT_SEARCH_DIRS', 'QUIRKY_TEST_FIXTURE_DIR', 'QUIRKY_TEST_GH_SOURCE', 'QUIRKY_TEST_GH_LOG',
  'QUIRKY_TEST_GIT_PUSH_LOG', 'QUIRKY_TEST_BARE_REMOTE', 'QUIRKY_TEST_WORKTREE_PATH', 'QUIRKY_TEST_ORIGINAL_PATH'
] as const

async function startFixFixture(options: FixFixtureOptions = {}): Promise<FixFixture> {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-sitter-acceptance-')))
  const home = join(root, 'home')
  const repoPath = join(root, 'repo')
  const bareRemote = join(root, 'remote.git')
  const fakebin = join(root, 'fakebin')
  const builtinPluginsDir = join(root, 'builtins')
  const statePath = join(root, 'state.json')
  const ghLog = join(root, 'gh.jsonl')
  const ghSource = join(root, 'github-stand-in.mjs')
  const ghPath = join(fakebin, 'gh')
  const gitPath = join(fakebin, 'git')
  const sshPath = join(fakebin, 'ssh')
  const workerStatePath = join(root, 'worker-state.json')
  const contentionPath = join(root, 'contention.json')
  const pushLog = join(root, 'pushes.jsonl')
  const gitPushLog = join(root, 'git-pushes.log')
  const dropReplyPath = join(root, 'drop-next-push-reply')
  const armConcurrentCommitPath = join(root, 'arm-concurrent-commit-after-lookup')
  const gitConfig = join(home, '.gitconfig')
  const previousEnvironment = new Map<string, string | undefined>(FIXTURE_ENV.map((key) => [key, process.env[key]]))
  let harness: Harness | undefined
  mkdirSync(home, { recursive: true })
  mkdirSync(fakebin, { recursive: true })
  mkdirSync(builtinPluginsDir, { recursive: true })
  mkdirSync(join(home, '.config', 'gh'), { recursive: true })
  writeFileSync(gitConfig, '')
  writeFileSync(ghLog, '')
  writeFileSync(pushLog, '')
  writeFileSync(gitPushLog, '')
  writeFileSync(ghSource, GITHUB_STAND_IN)
  writeFileSync(ghPath, GH_FIXTURE_WRAPPER)
  writeFileSync(gitPath, GIT_FIXTURE_WRAPPER)
  writeFileSync(sshPath, SSH_FIXTURE_WRAPPER)
  writeFileSync(join(fakebin, 'claude'), '#!/bin/sh\nprintf "Claude fixture\\n"\n')
  chmodSync(ghPath, 0o755)
  chmodSync(gitPath, 0o755)
  chmodSync(sshPath, 0o755)
  chmodSync(join(fakebin, 'claude'), 0o755)

  try {
    for (const id of [
      'quirky.hosting', 'quirky.repo', 'quirky.worktree', 'quirky.cli', 'quirky.git',
      'quirky.heimdall', 'quirky.sitter', 'quirky.agents', 'quirky.session'
    ]) symlinkSync(join(builtinsDir(), id), join(builtinPluginsDir, id))
    writeFixturePlugin(builtinPluginsDir, 'quirky.orchestration', ORCHESTRATION_FIXTURE, [
      'serviceRunCreate', 'serviceRegisterSubmissionPreflight', 'serviceWorkerStart',
      'serviceRunShow', 'serviceCheck', 'serviceWorkerRelease'
    ])
    writeFixturePlugin(builtinPluginsDir, 'quirky.terminal', TERMINAL_FIXTURE, ['sessions'], ['quirky.session'])
    writeFixturePlugin(builtinPluginsDir, 'quirky.agent-status', AGENT_STATUS_FIXTURE, ['list'], [
      'quirky.session', 'quirky.worktree'
    ], { type: 'array', items: { type: 'object', additionalProperties: true } })

    process.env.HOME = home
    process.env.QUIRKY_HOME = home
    process.env.XDG_CONFIG_HOME = join(home, '.config')
    process.env.GH_CONFIG_DIR = join(home, '.config', 'gh')
    process.env.GIT_CONFIG_GLOBAL = gitConfig
    process.env.GIT_CONFIG_SYSTEM = '/dev/null'
    process.env.GIT_CONFIG_NOSYSTEM = '1'
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key]
    process.env.GIT_TERMINAL_PROMPT = '0'
    process.env.QUIRKY_TEST_ORIGINAL_PATH = previousEnvironment.get('PATH') ?? ''
    process.env.PATH = `${fakebin}${delimiter}${process.env.QUIRKY_TEST_ORIGINAL_PATH}`
    process.env.GIT_SSH = sshPath
    process.env.GIT_SSH_VARIANT = 'ssh'
    process.env.QUIRKY_AGENT_SEARCH_DIRS = fakebin
    process.env.QUIRKY_TEST_FIXTURE_DIR = root
    process.env.QUIRKY_TEST_GH_SOURCE = ghSource
    process.env.QUIRKY_TEST_GH_LOG = ghLog
    process.env.QUIRKY_TEST_GIT_PUSH_LOG = gitPushLog
    process.env.QUIRKY_TEST_BARE_REMOTE = bareRemote
    process.env.QUIRKY_TEST_WORKTREE_PATH = repoPath
    process.env.GH_TOKEN = 'isolated-test-token'
    process.env.GITHUB_TOKEN = 'isolated-test-token'
    delete process.env.GH_ENTERPRISE_TOKEN
    delete process.env.GITHUB_ENTERPRISE_TOKEN
    process.env.GH_HOST = 'ambient-redirect.invalid'
    process.env.GH_REPO = 'ambient/redirect'
    process.env.GH_PROMPT_DISABLED = '1'

    mkdirSync(repoPath, { recursive: true })
    runGit(repoPath, ['init', '--quiet', '--initial-branch', 'main'])
    runGit(repoPath, ['config', 'user.name', 'Sitter Fixture'])
    runGit(repoPath, ['config', 'user.email', 'sitter-fixture@example.test'])
    runGit(repoPath, ['config', 'commit.gpgsign', 'false'])
    writeFileSync(join(repoPath, 'conflict.txt'), 'base\n')
    runGit(repoPath, ['add', 'conflict.txt'])
    runGit(repoPath, ['commit', '--quiet', '-m', 'base'])
    runGit(repoPath, ['checkout', '--quiet', '-b', 'feature'])
    writeFileSync(join(repoPath, 'conflict.txt'), 'feature version\n')
    runGit(repoPath, ['commit', '--quiet', '-am', 'feature change'])
    const head = runGit(repoPath, ['rev-parse', 'HEAD'])
    if (options.conflict || options.rebaseConflict || options.behind) {
      runGit(repoPath, ['checkout', '--quiet', 'main'])
      const baseUpdatePath = options.behind && !options.rebaseConflict && !options.conflict
        ? 'base-update.txt'
        : 'conflict.txt'
      writeFileSync(join(repoPath, baseUpdatePath), 'base update\n')
      runGit(repoPath, ['add', baseUpdatePath])
      runGit(repoPath, ['commit', '--quiet', '-m', 'base update'])
    }
    const baseHead = runGit(repoPath, ['rev-parse', 'main'])
    runGit(repoPath, ['checkout', '--quiet', 'feature'])
    runGit(root, ['init', '--quiet', '--bare', bareRemote])
    runGit(repoPath, ['push', '--quiet', bareRemote, 'feature:refs/heads/feature', 'main:refs/heads/main'])
    runGit(root, ['--git-dir', bareRemote, 'symbolic-ref', 'HEAD', 'refs/heads/feature'])
    runGit(repoPath, ['remote', 'add', 'origin', 'ssh://git@github.com/test-owner/test-repo.git'])
    runGit(repoPath, ['config', 'branch.feature.remote', 'origin'])
    runGit(repoPath, ['config', 'branch.feature.merge', 'refs/heads/feature'])
    runGit(repoPath, ['update-ref', 'refs/remotes/origin/feature', head])
    runGit(repoPath, ['update-ref', 'refs/remotes/origin/main', baseHead])

    const state = standInState()
    state.prs[0]!.headRefOid = head
    state.prs[0]!.baseRefOid = baseHead
    state.prs[0]!.mergeable = options.conflict ? 'CONFLICTING' : 'MERGEABLE'
    state.prs[0]!.mergeStateStatus = options.conflict
      ? 'DIRTY'
      : options.rebaseConflict || options.behind ? 'BEHIND' : 'CLEAN'
    state.checkRuns = []
    state.checkDetails = {}
    writeFileSync(statePath, JSON.stringify(state))
    writeFileSync(workerStatePath, JSON.stringify({
      runId: null,
      requests: [],
      workers: [],
      messages: [],
      workerMode: options.workerMode ?? (options.conflict || options.rebaseConflict ? 'conflict' : 'fix'),
      deliverySent: false
    }))
    writeFileSync(contentionPath, JSON.stringify({ worktreeId: null, terminal: false, agent: false }))

    harness = await startHarness({ home, builtinPluginsDir })
    const client = await harness.connect('cli')
    await client.callAny('setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: join(root, 'worktrees')
    })
    const repositoryValue = await client.callAny('quirky.repo/add', { path: repoPath })
    if (typeof repositoryValue !== 'object' || repositoryValue === null ||
      !('id' in repositoryValue) || typeof repositoryValue.id !== 'string') {
      throw new Error('fixture repository registration failed')
    }
    const worktrees = await client.callAny('quirky.worktree/list', { repo: repositoryValue.id })
    if (!Array.isArray(worktrees)) throw new Error('fixture worktree listing failed')
    const worktree = worktrees.find((row) => typeof row === 'object' && row !== null &&
      'path' in row && row.path === repoPath && 'id' in row && typeof row.id === 'string')
    if (typeof worktree !== 'object' || worktree === null || !('id' in worktree) || typeof worktree.id !== 'string') {
      throw new Error('fixture worktree was not registered')
    }
    const contention = JSON.parse(readFileSync(contentionPath, 'utf8')) as Record<string, unknown>
    contention.worktreeId = worktree.id
    writeFileSync(contentionPath, JSON.stringify(contention))

    let cleaned = false
    const fixture: FixFixture = {
      root, home, repoPath, worktree: worktree.id, client, head, baseHead, bareRemote,
      async call(name, params = {}) {
        const method = name.includes('/') ? name : `quirky.hosting/${name}`
        return client.callAny(method, { worktree: fixture.worktree, ...params })
      },
      async pluginCall(name, params = {}) {
        const method = name.includes('/') ? name : `quirky.hosting/${name}`
        return client.callAny(method, { worktree: fixture.worktree, ...params })
      },
      async cli(args) {
        const proc = Bun.spawn([process.execPath, CLI_ENTRY, ...args], {
          cwd: repoPath, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
        })
        const [stdout, stderr, code] = await Promise.all([
          new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited
        ])
        return { code, stdout, stderr }
      },
      writeState(value) {
        const temporary = statePath + '.' + process.pid + '.tmp'
        writeFileSync(temporary, JSON.stringify(value))
        renameSync(temporary, statePath)
      },
      readState() { return JSON.parse(readFileSync(statePath, 'utf8')) as unknown },
      invocations() {
        return readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as {
          args: string[]; input: string; env: Record<string, string>
        })
      },
      async connect(role = 'cli') { return harness!.connect(role) },
      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await harness?.cleanup()
        } finally {
          restoreFixtureEnvironment(previousEnvironment)
          rmSync(root, { recursive: true, force: true })
        }
      },
      git(args) { return runGit(repoPath, args) },
      bareGit(args) { return runGit(root, ['--git-dir', bareRemote, ...args]) },
      workerRequests() {
        return (JSON.parse(readFileSync(workerStatePath, 'utf8')) as { requests: Record<string, unknown>[] }).requests
      },
      forcePushes() {
        return readFileSync(pushLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
      },
      gitPushes() {
        return readFileSync(gitPushLog, 'utf8').split('\n').filter(Boolean)
      },
      dropNextPushReply() { writeFileSync(dropReplyPath, 'drop') },
      injectConcurrentCommitAfterPublicationLookup() { writeFileSync(armConcurrentCommitPath, 'armed') },
      amendPreparedCommit() {
        writeFileSync(join(repoPath, 'fix.txt'), 'amended worker change\n')
        runGit(repoPath, ['add', 'fix.txt'])
        runGit(repoPath, ['commit', '--quiet', '--amend', '--no-edit'])
      },
      makeDirty() { writeFileSync(join(repoPath, 'dirty-fixture.txt'), 'uncommitted\n') },
      clearDirty() { rmSync(join(repoPath, 'dirty-fixture.txt'), { force: true }) },
      setContention(value) {
        writeFileSync(contentionPath, JSON.stringify({
          worktreeId: fixture.worktree, terminal: value.terminal, agent: value.agent === true
        }))
      }
    }
    return fixture
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      restoreFixtureEnvironment(previousEnvironment)
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

async function enrollFixWatcher(
  fixture: FixFixture,
  capabilities: Record<string, 'off' | 'gated' | 'on'>,
  kindPayload?: Record<string, unknown>
): Promise<string> {
  const capArgs = Object.entries({ fixChecks: 'off', resolveConflicts: 'off', merge: 'off', ...capabilities })
    .flatMap(([key, value]) => ['--cap', `${key}=${value}`])
  const args = ['create', 'hosted-review', '--worktree', `id:${fixture.worktree}`, ...capArgs]
  if (kindPayload) args.push('--spec', JSON.stringify({ kindPayload }))
  args.push('--json')
  const result = await cli(fixture, args)
  if (result.code !== 0) throw new Error(`hosted-review enrollment failed: ${result.stdout}\n${result.stderr}`)
  return watcherIdFrom(cliJson<{ enrollment?: { watcherId?: unknown } }>(result, 'fixture watcher enrollment'))
}

function setCheckFailure(
  fixture: FixFixture,
  checkRunId: number,
  head: string,
  required: boolean | null = true
): void {
  const state = fixture.readState() as StandInState
  const pull = state.prs[0]
  if (!pull) throw new Error('fixture pull request is missing')
  pull.headRefOid = head
  const jobId = checkRunId + 10_000
  state.checkRuns = [{
    __typename: 'CheckRun',
    databaseId: checkRunId,
    name: 'build',
    status: 'COMPLETED',
    conclusion: 'FAILURE',
    detailsUrl: `https://github.com/test-owner/test-repo/actions/runs/41/job/${checkRunId}`,
    workflowRunId: 41,
    required
  }]
  state.checkDetails ??= {}
  state.checkDetails[String(checkRunId)] = {
    annotations: [{
      path: 'src/build.ts',
      annotation_level: 'failure',
      message: `2026-11-14T12:30:00Z \u001b[31mFAIL\u001b[0m failure in the build job dddddddddddddddddddddddddddddddddddddddd 123e4567-e89b-12d3-a456-426614174000`
    }],
    jobs: [{ id: jobId, name: 'build', status: 'completed', conclusion: 'failure' }],
    logs: {
      [String(jobId)]: `2026-11-14T12:30:00Z \u001b[31mFAIL\u001b[0m failure in the build job dddddddddddddddddddddddddddddddddddddddd 123e4567-e89b-12d3-a456-426614174000`
    }
  }
  fixture.writeState(state)
}

function checkRun(
  databaseId: number,
  name: string,
  status: string,
  conclusion: string | null,
  required: boolean | null
): StandInState['checkRuns'][number] {
  return {
    __typename: 'CheckRun',
    databaseId,
    name,
    status,
    conclusion,
    detailsUrl: `https://github.com/test-owner/test-repo/actions/runs/41/job/${databaseId}`,
    workflowRunId: 41,
    required,
  }
}

async function persistRerunFailure(fixture: FixFixture, watcherId: string, head: string, checkRunId: number): Promise<void> {
  await reconcile(fixture, watcherId)
  let rerun = await waitFor(() => detail(fixture, watcherId), (value) =>
    attempt(value, 'rerun-check')?.effect === 'landed' ||
      value.status?.state === 'held' && value.status.reason === 'awaiting-approval',
  'the failed-check rerun')
  if (attempt(rerun, 'rerun-check')?.effect !== 'landed') {
    const escalation = rerun.openEscalations[0]
    if (!escalation) throw new Error('The held check rerun has no approval request')
    const approved = await cli(fixture, ['approve', watcherId, escalation.escalationId, '--json'])
    expect(approved.code).toBe(0)
    await reconcile(fixture, watcherId)
    rerun = await waitFor(() => detail(fixture, watcherId), (value) =>
      attempt(value, 'rerun-check')?.state === 'settled' && attempt(value, 'rerun-check')?.effect === 'landed',
    'the approved failed-check rerun')
  }
  expect(attempt(rerun, 'rerun-check')).toMatchObject({ state: 'settled', effect: 'landed' })
  setCheckFailure(fixture, checkRunId, head)
}

async function rerunThenPersistFailure(fixture: FixFixture, watcherId: string, head: string, checkRunId: number): Promise<void> {
  await persistRerunFailure(fixture, watcherId, head, checkRunId)
  await reconcile(fixture, watcherId)
  const preparation = await waitFor(() => detail(fixture, watcherId), (value) => {
    const current = attempt(value, 'prepare-fix')
    const landed = current?.state === 'settled' && current.effect === 'landed'
    const heldForPrepare = value.status?.state === 'held' && value.status.reason === 'awaiting-approval' &&
      value.openEscalations.some((item) => item.approvalScope?.actionKind === 'prepare-fix')
    return landed || heldForPrepare
  }, 'the prepared check fix or its approval')
  const prepareAttempt = attempt(preparation, 'prepare-fix')
  if (prepareAttempt?.state !== 'settled' || prepareAttempt.effect !== 'landed') {
    const escalation = preparation.openEscalations.find((item) => item.approvalScope?.actionKind === 'prepare-fix')
    if (!escalation?.approvalScope) throw new Error('The held check fix has no exact approval request')
    expect(escalation.approvalScope).toMatchObject({ actionKind: 'prepare-fix' })
    const approved = await cli(fixture, ['approve', watcherId, escalation.escalationId, '--json'])
    expect(approved.code).toBe(0)
    await reconcile(fixture, watcherId)
  }
  const prepared = await waitFor(() => detail(fixture, watcherId), (value) =>
    attempt(value, 'prepare-fix')?.state === 'settled' && attempt(value, 'prepare-fix')?.effect === 'landed',
  'the prepared check fix')
  expect(attempt(prepared, 'prepare-fix')).toMatchObject({ state: 'settled', effect: 'landed' })
}

function writeFixturePlugin(
  root: string,
  id: string,
  main: string,
  methods: string[],
  dependencies: string[] = [],
  resultSchema: Record<string, unknown> = { type: 'object', additionalProperties: true }
): void {
  const directory = join(root, id)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'quirky-plugin.json'), JSON.stringify({
    id, apiVersion: '1.12.0', name: 'Acceptance fixture', version: '0.1.0', main: 'main.ts',
    dependencies,
    contributes: {
      method: methods.map((method) => ({
        id: method,
        description: 'Local daemon acceptance fixture method.',
        readOnly: method === 'sessions' || method === 'list' || method === 'serviceRunShow',
        params: { type: 'object', additionalProperties: true },
        result: resultSchema
      })),
      ...(id === 'quirky.orchestration' ? {
        event: [{
          id: 'message-arrived',
          description: 'A worker message arrived in this local acceptance fixture.',
          data: {
            type: 'object',
            properties: {
              runId: { type: 'string' },
              messageId: { type: 'string' },
              type: { type: 'string', enum: ['worker_done', 'question', 'escalation'] }
            },
            required: ['runId', 'messageId', 'type'],
            additionalProperties: false
          }
        }]
      } : {})
    }
  }))
  writeFileSync(join(directory, 'main.ts'), main)
}

function runGit(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
  })
  if (result.exitCode !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${new TextDecoder().decode(result.stderr)}`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}

function restoreFixtureEnvironment(previous: Map<string, string | undefined>): void {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

const CLI_ENTRY = resolve(import.meta.dir, '../../../packages/cli/src/main.ts')

const GH_FIXTURE_WRAPPER = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const input = await new Response(Bun.stdin.stream()).text()
const args = process.argv.slice(2)
const env = {}
for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) {
  if (process.env[key] !== undefined) env[key] = process.env[key]
}
appendFileSync(process.env.QUIRKY_TEST_GH_LOG, JSON.stringify({ args, input, env }) + '\n')
const child = Bun.spawn([process.execPath, process.env.QUIRKY_TEST_GH_SOURCE, ...args], {
  cwd: process.cwd(), env: { ...process.env, QUIRKY_TEST_GH_INPUT: input },
  stdin: 'ignore', stdout: 'inherit', stderr: 'inherit'
})
const exitCode = await child.exited
const branchLookup = args[0] === 'api' && args.some((value) =>
  /^repos\/[^/]+\/[^/]+\/pulls\?head=/.test(value))
const fixtureDir = process.env.QUIRKY_TEST_FIXTURE_DIR ?? ''
const raceArmPath = join(fixtureDir, 'arm-concurrent-commit-after-lookup')
if (exitCode === 0 && branchLookup && existsSync(raceArmPath)) {
  unlinkSync(raceArmPath)
  writeFileSync(join(fixtureDir, 'concurrent-commit-after-lookup'), 'armed')
}
process.exitCode = exitCode
`

const GIT_FIXTURE_WRAPPER = String.raw`#!/bin/sh
REAL_GIT=$(PATH="$QUIRKY_TEST_ORIGINAL_PATH" command -v git)
RACE_MARKER="$QUIRKY_TEST_FIXTURE_DIR/concurrent-commit-after-lookup"
case " $* " in
  *" push "*) printf '%s\n' "$*" >> "$QUIRKY_TEST_GIT_PUSH_LOG" ;;
esac
if [ -f "$RACE_MARKER" ] && [ "$1" = "diff" ]; then
  case " $* " in
    *" --numstat "*) ;;
    *" --no-ext-diff "*)
      rm -f "$RACE_MARKER"
      "$REAL_GIT" "$@"
      result=$?
      if [ "$result" -eq 0 ]; then
        printf 'concurrent user commit\n' > "$QUIRKY_TEST_WORKTREE_PATH/concurrent.txt"
        "$REAL_GIT" -C "$QUIRKY_TEST_WORKTREE_PATH" add concurrent.txt
        "$REAL_GIT" -C "$QUIRKY_TEST_WORKTREE_PATH" commit --quiet -m 'Concurrent user change'
      fi
      exit "$result"
      ;;
  esac
fi
exec "$REAL_GIT" "$@"
`

const SSH_FIXTURE_WRAPPER = String.raw`#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const args = process.argv.slice(2)
const command = args.at(-1) ?? ''
const kind = command.includes('git-receive-pack') ? 'receive-pack' : command.includes('git-upload-pack') ? 'upload-pack' : ''
if (!kind) {
  process.stderr.write('fixture SSH rejected an unsupported command\n')
  process.exit(1)
}
appendFileSync(join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'pushes.jsonl'), JSON.stringify({ command, kind }) + '\n')
const remote = process.env.QUIRKY_TEST_BARE_REMOTE
const before = kind === 'receive-pack' ? Bun.spawnSync(['git', '--git-dir', remote, 'rev-parse', 'refs/heads/feature'], {
  cwd: process.cwd(), env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
}) : null
const beforeHead = before?.exitCode === 0 ? new TextDecoder().decode(before.stdout).trim() : null
const child = Bun.spawn(['git', kind, remote], {
  cwd: process.cwd(), env: process.env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit'
})
const dropReplyPath = join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'drop-next-push-reply')
const dropReply = kind === 'receive-pack' && existsSync(dropReplyPath)
const code = await child.exited
if (code === 0 && kind === 'receive-pack' && !dropReply) {
  const head = Bun.spawnSync(['git', '--git-dir', remote, 'rev-parse', 'refs/heads/feature'], {
    cwd: process.cwd(), env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe'
  })
  const headSha = new TextDecoder().decode(head.stdout).trim()
  const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'state.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  const pull = state.prs?.find((item) => item.headRefName === 'feature')
  if (head.exitCode === 0 && pull && headSha !== beforeHead && /^[0-9a-f]{40,64}$/u.test(headSha)) {
    pull.headRefOid = headSha
    pull.mergeable = 'MERGEABLE'
    pull.mergeStateStatus = 'CLEAN'
    state.updatedHead = headSha
    state.checkRuns = (state.checkRuns ?? []).map((check) => ({ ...check, status: 'QUEUED', conclusion: null }))
    const temporary = statePath + '.' + process.pid + '.tmp'
    writeFileSync(temporary, JSON.stringify(state))
    renameSync(temporary, statePath)
  }
}
if (code === 0 && kind === 'receive-pack' && dropReply) unlinkSync(dropReplyPath)
process.exitCode = code === 0 && kind === 'receive-pack' && dropReply ? 255 : code
`


const ORCHESTRATION_FIXTURE = String.raw`import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const statePath = join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'worker-state.json')
const readState = () => JSON.parse(readFileSync(statePath, 'utf8'))
const save = (state) => writeFileSync(statePath, JSON.stringify(state))
const receipt = (requestId, replayed = false) => ({ requestId, replayed })
const git = (cwd, args, allowFailure = false) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0 && !allowFailure) {
    throw new Error('fixture worker git failed: ' + new TextDecoder().decode(result.stderr))
  }
  return { code: result.exitCode, stdout: new TextDecoder().decode(result.stdout).trim() }
}
const writeAndCommit = (mode, fingerprint) => {
  const cwd = process.env.QUIRKY_TEST_WORKTREE_PATH
  if (mode === 'conflict') {
    git(cwd, ['merge', 'main'], true)
    writeFileSync(join(cwd, 'conflict.txt'), 'resolved by acceptance worker\n')
    git(cwd, ['add', 'conflict.txt'])
    git(cwd, ['commit', '--quiet', '-m', 'Resolve pull request conflict', '-m', 'Orca-Heimdall-Attempt: ' + fingerprint])
  } else if (mode === 'policy') {
    const path = join(cwd, '.github', 'workflows', 'unsafe.yml')
    mkdirSync(join(cwd, '.github', 'workflows'), { recursive: true })
    writeFileSync(path, 'name: disabled checks\n')
    git(cwd, ['add', '.github/workflows/unsafe.yml'])
    git(cwd, ['commit', '--quiet', '-m', 'Fix check', '-m', 'Orca-Heimdall-Attempt: ' + fingerprint])
  } else {
    writeFileSync(join(cwd, 'fix.txt'), 'fixed build failure\n')
    git(cwd, ['add', 'fix.txt'])
    git(cwd, ['commit', '--quiet', '-m', 'Fix build check', '-m', 'Orca-Heimdall-Attempt: ' + fingerprint])
  }
  return git(cwd, ['rev-parse', 'HEAD']).stdout
}
export function activate(context) {
  const provide = (name, handler) => context.provide('method:quirky.orchestration/' + name, handler)
  provide('serviceRunCreate', (params) => {
    const state = readState()
    state.runId = state.runId ?? 'run_sitter_acceptance'
    save(state)
    return { run: { id: state.runId }, mutation: receipt(params.requestId) }
  })
  provide('serviceRegisterSubmissionPreflight', (params) => {
    const state = readState()
    state.preflight = { runId: params.runId, method: params.method }
    save(state)
    return { ...state.preflight, registered: true, mutation: receipt(params.requestId) }
  })
  provide('serviceWorkerStart', (params) => {
    const state = readState()
    if (state.preflight?.runId !== params.runId) throw new Error('worker submission preflight was not registered')
    const previous = state.requests.find((item) => item.requestId === params.requestId)
    if (previous) return {
      mutation: receipt(params.requestId, true), runId: state.runId, state: 'ready', dispatchId: previous.dispatchId
    }
    const dispatchId = 'ctx_fixture_' + (state.requests.length + 1)
    const spec = typeof params.spec === 'string' ? params.spec : ''
    const trailerPrefix = 'Put this exact trailer in the commit footer: Orca-Heimdall-Attempt: '
    const trailerLine = spec.split('\n').find((line) => line.startsWith(trailerPrefix))
    const fingerprint = trailerLine?.slice(trailerPrefix.length)
    if (!fingerprint) throw new Error('worker spec omitted the required attempt trailer')
    const commit = writeAndCommit(state.workerMode, fingerprint)
    const request = { ...params, dispatchId, fingerprint, commit }
    state.requests.push(request)
    state.workers.push({
      dispatchId, sessionId: null, processIncarnation: null, state: 'exited',
      assignmentActive: false, lastContactAtMs: null
    })
    state.messages.push({
      id: 'msg_fixture_' + state.requests.length,
      type: 'worker_done',
      body: 'The local commit is ready.',
      sender: { kind: 'dispatch', dispatchId },
      payload: { dispatchId, outcome: 'succeeded' }
    })
    save(state)
    return { mutation: receipt(params.requestId), runId: state.runId, state: 'ready', dispatchId }
  })
  provide('serviceRunShow', (params) => {
    const state = readState()
    return { run: { id: params.runId }, workers: state.workers, questions: [] }
  })
  provide('serviceCheck', (params) => {
    const state = readState()
    if (typeof params.ackDeliveryId === 'string') {
      state.messages = []
      state.deliverySent = false
      save(state)
      return {
        mode: 'consume', runId: params.runId, mutation: receipt(params.requestId),
        messages: [], questions: [], deliveryId: null, acknowledged: params.ackDeliveryId
      }
    }
    const messages = state.deliverySent ? [] : state.messages
    if (messages.length > 0) state.deliverySent = true
    save(state)
    return {
      mode: 'consume', runId: params.runId, mutation: receipt(params.requestId),
      messages, questions: [], deliveryId: messages.length > 0 ? 'delivery_fixture' : null
    }
  })
  provide('serviceWorkerRelease', (params) => ({
    dispatchId: params.dispatchId, state: 'released', processAction: 'none', mutation: receipt(params.requestId)
  }))
}
`

const TERMINAL_FIXTURE = String.raw`import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export function activate(context) {
  context.provide('method:quirky.terminal/sessions', () => {
    const state = JSON.parse(readFileSync(join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'contention.json'), 'utf8'))
    return { sessions: state.terminal ? [{
      sessionId: 'fixture-terminal', state: 'running', alive: true, pid: 1,
      cwd: process.env.QUIRKY_TEST_WORKTREE_PATH, shellState: 'running',
      worktreeId: state.worktreeId, workspace: 'acceptance'
    }] : [] }
  })
}
`

const AGENT_STATUS_FIXTURE = String.raw`import { readFileSync } from 'node:fs'
import { join } from 'node:path'
export function activate(context) {
  context.provide('method:quirky.agent-status/list', (params) => {
    const state = JSON.parse(readFileSync(join(process.env.QUIRKY_TEST_FIXTURE_DIR, 'contention.json'), 'utf8'))
    return state.agent ? [{
      sessionId: 'fixture-agent', worktreeId: state.worktreeId, worktree: params.worktree,
      state: 'working', dispatchId: 'ctx_external_agent', attemptId: 'external-attempt'
    }] : []
  })
}
`

test('force-push rejects a local commit that replaced the prepared publication SHA', async () => {
  const fixture = await startFixFixture()
  try {
    setCheckFailure(fixture, 9501, fixture.head)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'gated' })
    await rerunThenPersistFailure(fixture, watcherId, fixture.head, 9502)
    await reconcile(fixture, watcherId)
    const prepared = fixture.git(['rev-parse', 'HEAD'])
    const held = await waitFor(() => detail(fixture, watcherId), value =>
      value.openEscalations.some(entry => entry.approvalScope?.actionKind === 'publish-fix' &&
        entry.approvalScope.preparedCommitSha === prepared), 'the prepared-SHA publication approval')
    const publishApproval = held.openEscalations.find(entry =>
      entry.approvalScope?.actionKind === 'publish-fix' && entry.approvalScope.preparedCommitSha === prepared)
    if (!publishApproval) throw new Error('The prepared-SHA publication approval is missing')
    expect(publishApproval.approvalScope).toMatchObject({ actionKind: 'publish-fix', preparedCommitSha: prepared })
    expect(held.openEscalations.some(entry => entry.approvalScope?.preparedCommitSha === prepared)).toBe(true)
    writeFileSync(join(fixture.repoPath, 'concurrent.txt'), 'concurrent user commit\n')
    fixture.git(['add', 'concurrent.txt'])
    fixture.git(['commit', '--quiet', '-m', 'Concurrent user change'])
    expect(fixture.git(['rev-parse', 'HEAD'])).not.toBe(prepared)
    await expect(fixture.client.callAny('quirky.git/forcePush', {
      worktree: `id:${fixture.worktree}`, purpose: 'review', expected: fixture.head,
      expectedLocalHead: prepared, yes: true
    })).rejects.toMatchObject({ data: { reason: 'stale-target' } })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(fixture.head)
    expect(fixture.forcePushes()).toEqual([])

    fixture.git(['reset', '--hard', prepared])
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(prepared)
    const approved = await cli(fixture, ['approve', watcherId, publishApproval.escalationId, '--json'])
    expect(approved.code).toBe(0)
    fixture.injectConcurrentCommitAfterPublicationLookup()
    await reconcile(fixture, watcherId)
    const publication = await waitFor(() => detail(fixture, watcherId), value =>
      attempt(value, 'publish-fix')?.state === 'settled' && attempt(value, 'publish-fix')?.effect === 'not-landed',
    'the sitter publication rejected after the concurrent local commit')
    expect(attempt(publication, 'publish-fix')).toMatchObject({
      state: 'settled',
      effect: 'not-landed',
      reason: 'head-moved',
      action: { kind: 'publish-fix', preparedCommitSha: prepared, expectedHeadSha: fixture.head }
    })
    expect(fixture.git(['rev-parse', 'HEAD'])).not.toBe(prepared)
    expect(fixture.git(['show', '-s', '--format=%s', 'HEAD'])).toBe('Concurrent user change')
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(fixture.head)
    expect(fixture.forcePushes()).toEqual([])
  } finally {
    await fixture.cleanup()
  }
}, 60_000)

test('sitter publication reports head-moved when the bare branch diverges from the hosting head', async () => {
  const fixture = await startFixFixture()
  try {
    const headA = fixture.head
    setCheckFailure(fixture, 9601, headA)
    const watcherId = await enrollFixWatcher(fixture, { fixChecks: 'gated' })
    await rerunThenPersistFailure(fixture, watcherId, headA, 9602)
    const commitB = fixture.git(['rev-parse', 'HEAD'])
    expect(fixture.git(['rev-parse', `${commitB}^`])).toBe(headA)

    fixture.git(['checkout', '--quiet', '-b', 'remote-divergence', headA])
    writeFileSync(join(fixture.repoPath, 'remote-only.txt'), 'remote divergence\n')
    fixture.git(['add', 'remote-only.txt'])
    fixture.git(['commit', '--quiet', '-m', 'Remote divergence X'])
    const commitX = fixture.git(['rev-parse', 'HEAD'])
    expect(fixture.git(['rev-parse', `${commitX}^`])).toBe(headA)
    fixture.git(['checkout', '--quiet', 'feature'])
    expect(fixture.git(['rev-parse', 'HEAD'])).toBe(commitB)
    expect(fixture.git(['merge-base', commitB, commitX])).toBe(headA)

    fixture.git(['push', '--quiet', fixture.bareRemote, `${commitX}:refs/heads/feature`])
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitX)
    expect((fixture.readState() as StandInState).prs[0]?.headRefOid).toBe(headA)
    const held = await waitFor(() => detail(fixture, watcherId), value =>
      value.openEscalations.some(entry => entry.approvalScope?.actionKind === 'publish-fix' &&
        entry.approvalScope.preparedCommitSha === commitB), 'the leased publication approval')
    const approval = held.openEscalations.find(entry => entry.approvalScope?.actionKind === 'publish-fix' &&
      entry.approvalScope.preparedCommitSha === commitB)!
    expect((await cli(fixture, ['approve', watcherId, approval.escalationId, '--json'])).code).toBe(0)
    await reconcile(fixture, watcherId)
    const publication = await waitFor(() => detail(fixture, watcherId), value =>
      attempt(value, 'publish-fix')?.state === 'settled' && attempt(value, 'publish-fix')?.effect === 'not-landed',
    'the sitter publication rejected by the force-with-lease')
    expect(attempt(publication, 'publish-fix')).toMatchObject({
      state: 'settled',
      effect: 'not-landed',
      reason: 'head-moved',
      action: { kind: 'publish-fix', preparedCommitSha: commitB, expectedHeadSha: headA }
    })
    expect(fixture.bareGit(['rev-parse', 'refs/heads/feature'])).toBe(commitX)
    expect((fixture.readState() as StandInState).prs[0]?.headRefOid).toBe(headA)
    expect(fixture.forcePushes()).toMatchObject([{ kind: 'receive-pack' }])
    expect(fixture.forcePushes()).toHaveLength(1)
  } finally {
    await fixture.cleanup()
  }
}, 60_000)
