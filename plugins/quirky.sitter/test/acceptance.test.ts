import { afterAll, beforeAll, expect, test } from 'bun:test'
import { RpcErrorCode } from '@quirky/protocol'
import { waitForAsync } from '../../../packages/daemon/test/helpers'
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

test('enrollment refuses an unresolvable active worktree, rebase updates, required-check scope and a closed pull request, and the kind\'s hooks refuse any caller but Heimdall', async () => {

  const active = await cli(host, ['create', 'hosted-review', '--json'])
  expect(active.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string; detail: string }>(active, 'active-worktree enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
    detail: expect.stringContaining('worktree-unresolved'),
  })
  expect(JSON.parse(active.stdout).detail).toContain('--worktree')

  const rebase = await cli(host, ['create', 'hosted-review', '--worktree', `id:${host.worktree}`, '--branch-update', 'rebase', '--json'])
  expect(rebase.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string; detail: string }>(rebase, 'rebase enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
    detail: expect.stringContaining('rebase is not supported'),
  })

  const requiredChecks = await cli(host, [
    'create', 'hosted-review', '--worktree', `id:${host.worktree}`,
    '--spec', JSON.stringify({ kindPayload: { mergeCheckScope: 'required' } }), '--json',
  ])
  expect(requiredChecks.code).not.toBe(0)
  expect(cliJson<{ kind: string; reason: string; detail: string }>(requiredChecks, 'required-check-scope enrollment')).toMatchObject({
    kind: 'refused',
    reason: 'owner-not-executable',
    detail: expect.stringContaining('all-checks merge scope'),
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
    branchUpdateMode: 'merge-base-update',
    mergeMethod: null,
    mergeCheckScope: 'all',
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
