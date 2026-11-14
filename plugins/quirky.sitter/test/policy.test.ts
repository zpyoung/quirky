import { expect, test } from 'bun:test'
import type { Attempt, CapabilityMode, CheckState, JournalEntry, SitterAction, SitterCheck, SitterPayload, SitterWorld, Snapshot, StopResult } from '../src/policy'
import {
  contentIdentity,
  decide,
  pace,
  resolveOutcome,
  RETRY_DELAY_MS,
  RETRY_LIMIT,
  stop,
  UNOBSERVED_EFFECT_MS,
  worldFromHosting
} from '../src/policy'

const H1 = '1'.repeat(40)
const H2 = '2'.repeat(40)
const B1 = 'b'.repeat(40)
const B2 = 'c'.repeat(40)
const T = Date.parse('2026-01-01T00:00:00.000Z')
const REVIEW_URL = 'https://github.com/test-owner/test-repo/pull/7'

const payload: SitterPayload = {
  worktreeId: 'w1',
  branch: 'feature',
  headRefName: 'feature',
  provider: 'github',
  reviewNumber: 7,
  reviewUrl: REVIEW_URL,
  repository: { host: 'github.com', owner: 'test-owner', repo: 'test-repo' },
  branchUpdateMode: 'merge-base-update',
  mergeMethod: null,
  mergeCheckScope: 'all'
}

type CheckFixture = SitterCheck & {
  checkRunId: number | null
  failureSignature: string | null
  failureExcerpt: string | null
}

type PreparedFixture = {
  sha: string
  parentCount: number
  primaryParentSha: string | null
  attemptTrailer: string | null
  dirty: boolean
  policyViolation: string | null
}

type WorldFixture = SitterWorld & {
  baseRefName: string
  localHeadSha: string | null
  localDirty: boolean
  localPrepared: PreparedFixture | null
}

const BUILD_CHECK_KEY = JSON.stringify(['check_run', 'build'])

function check(overrides: Partial<CheckFixture> = {}): CheckFixture {
  return {
    name: 'build',
    kind: 'check_run',
    state: 'passed',
    observation: 'check_run:9001:41:completed:success',
    rerunTarget: 'workflow:41',
    workflowRunId: 41,
    checkRunId: 9001,
    failureSignature: null,
    failureExcerpt: null,
    ...overrides
  }
}

function world(overrides: Partial<WorldFixture> = {}): WorldFixture {
  return {
    reviewNumber: 7,
    reviewUrl: REVIEW_URL,
    lifecycle: 'open',
    draft: false,
    headSha: H1,
    baseSha: B1,
    baseRefName: 'main',
    headRefName: 'feature',
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    defaultMergeMethod: 'squash',
    allowedMergeMethods: ['squash', 'merge', 'rebase'],
    checksComplete: true,
    checks: [check()],
    localHeadSha: H1,
    localDirty: false,
    localPrepared: null,
    ...overrides
  }
}

function preparedCommit(overrides: Partial<PreparedFixture> = {}): PreparedFixture {
  return {
    sha: B2,
    parentCount: 1,
    primaryParentSha: H1,
    attemptTrailer: 'fp-fix',
    dirty: false,
    policyViolation: null,
    ...overrides
  }
}

function prepareFixAction(signature = 'sha256:reproduced'): SitterAction {
  return {
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: 'fix-checks:failure-set',
    evidenceKey: `${H1}:failure-set`,
    expectedHeadSha: H1,
    failedChecks: [{
      key: BUILD_CHECK_KEY,
      name: 'build',
      failureSignature: signature,
      failureExcerpt: 'reproduced compiler failure'
    }]
  } as unknown as SitterAction
}

function prepareConflictAction(): SitterAction {
  return {
    kind: 'prepare-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: `resolve-conflicts:${B1}`,
    evidenceKey: `${H1}:${B1}`,
    expectedHeadSha: H1,
    baseSha: B1,
    baseRefName: 'main'
  } as unknown as SitterAction
}

function publishFixAction(): SitterAction {
  return {
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    recovery: 'replay-safe',
    contentIdentity: `publish-fix:${B2}`,
    evidenceKey: H1,
    preparedCommitSha: B2,
    expectedHeadSha: H1,
    prepareFingerprint: 'fp-fix'
  } as unknown as SitterAction
}

function publishConflictAction(): SitterAction {
  return {
    kind: 'publish-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'external',
    recovery: 'replay-safe',
    contentIdentity: `publish-conflict-resolution:${B2}`,
    evidenceKey: H1,
    preparedCommitSha: B2,
    expectedHeadSha: H1,
    prepareFingerprint: 'fp-conflict'
  } as unknown as SitterAction
}

function expectParked(
  result: StopResult,
  predicate: string,
  deviationKind: 'check-failed' | 'report-rejected' | 'landing-failed',
  naturalKey: string
) {
  expect(result?.kind).toBe('park')
  if (result?.kind !== 'park') return
  expect(result.reason).toBe('stop-predicate')
  expect(result.detail.startsWith(`${predicate}: `)).toBe(true)
  expect(result.deviation).toEqual({
    kind: deviationKind,
    naturalKey,
    detail: result.detail
  })
}

function caps(overrides: Partial<Record<'updateBranch' | 'resolveConflicts' | 'fixChecks' | 'merge', CapabilityMode>> = {}): Record<string, CapabilityMode> {
  return {
    updateBranch: 'on',
    resolveConflicts: 'off',
    fixChecks: 'on',
    merge: 'on',
    ...overrides
  }
}

function enrollment(capabilities = caps()) {
  return { capabilities, kindPayload: payload }
}

function snapshot(value: SitterWorld = world(), observedAtMs = T): Snapshot<SitterWorld> {
  return { freshness: 'live', contentIdentity: contentIdentity(value), observedAtMs, world: value }
}

function review(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: 7,
    url: REVIEW_URL,
    state: 'open',
    headRefName: 'feature',
    headRefOid: H1,
    baseRefOid: B1,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    mergeMethods: { default: 'squash', allowed: ['squash', 'merge', 'rebase'] },
    ...overrides
  }
}

function hostingChecks(checks: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { headSha: H1, partial: false, checks, ...overrides }
}

function actionFor(value: SitterWorld = world(), capabilities = caps(), journal: JournalEntry[] = []) {
  return decide(snapshot(value), journal, enrollment(capabilities)).action
}

function attempt(action: SitterAction, overrides: Partial<Attempt> = {}): Attempt {
  const seq = overrides.seq ?? 1
  const attemptId = overrides.attemptId ?? `attempt-${seq}`
  return {
    seq,
    eventId: `attempt-event-${seq}`,
    watcherId: 'watcher-1',
    atMs: T,
    class: 'fact',
    origin: 'owner',
    kind: 'attempt',
    resolved: true,
    attemptId,
    fingerprint: action.evidenceKey,
    action,
    state: 'settled',
    effect: 'landed',
    ...overrides
  }
}

function failedAttempts(action: SitterAction, count: number, startAtMs = T): Attempt[] {
  return Array.from({ length: count }, (_, index) => {
    const ordinal = index + 1
    let evidenceKey: string
    if (action.kind === 'rerun-check') evidenceKey = JSON.stringify(['rerun-check', action.head, action.checkNames, ordinal])
    else if (action.kind === 'update-branch') evidenceKey = JSON.stringify(['update-branch', action.head, action.base, ordinal])
    else evidenceKey = JSON.stringify(['merge', action.head, action.method, ordinal])
    const retryAction = { ...action, ordinal, evidenceKey }
    return attempt(retryAction, {
      seq: ordinal,
      eventId: `attempt-event-${ordinal}`,
      attemptId: `failed-${ordinal}`,
      atMs: startAtMs + index * RETRY_DELAY_MS,
      effect: 'not-landed',
      reason: 'merge_blocked: GitHub protection rules currently block this pull request from merging.'
    })
  })
}

function expectGate(value: Partial<SitterWorld>, detail: string, capabilities = caps(), selectedMethod: 'merge' | 'squash' | 'rebase' | null = null) {
  const currentEnrollment = { capabilities, kindPayload: { ...payload, mergeMethod: selectedMethod } }
  expect(decide(snapshot(world(value)), [], currentEnrollment)).toMatchObject({
    action: null,
    reason: 'merge-gates-unsatisfied',
    detail
  })
}

test('maps hosting results to a world and its content identity', () => {
  const open = worldFromHosting(review(), hostingChecks([
    { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 9001, workflowRunId: 41 },
    { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'failure', checkRunId: 9002, workflowRunId: null },
    { kind: 'status', name: 'deploy', status: 'success', conclusion: 'success', checkRunId: null, workflowRunId: null },
    { kind: 'approval', name: 'review gate', status: 'action_required', conclusion: 'action_required', checkRunId: null, workflowRunId: null }
  ]), payload)
  expect(open).toMatchObject({
    lifecycle: 'open',
    draft: false,
    headSha: H1,
    baseSha: B1,
    headRefName: 'feature',
    reviewDecision: 'APPROVED',
    mergeStateStatus: 'CLEAN',
    mergeable: 'MERGEABLE',
    mergeQueueRequired: false,
    mergeMetadataKnown: true,
    defaultMergeMethod: 'squash',
    allowedMergeMethods: ['squash', 'merge', 'rebase'],
    checksComplete: true
  })
  expect(open.checks).toEqual([
    {
      name: 'build', kind: 'check_run', state: 'passed', observation: 'check_run:9001:41:completed:success',
      rerunTarget: 'workflow:41', workflowRunId: 41, checkRunId: 9001, failureSignature: null, failureExcerpt: null
    },
    {
      name: 'lint', kind: 'check_run', state: 'failed', observation: 'check_run:9002::completed:failure',
      rerunTarget: 'check:9002', workflowRunId: null, checkRunId: 9002, failureSignature: null, failureExcerpt: null
    },
    {
      name: 'deploy', kind: 'status', state: 'passed', observation: 'status:::success:success',
      rerunTarget: null, workflowRunId: null, checkRunId: null, failureSignature: null, failureExcerpt: null
    },
    {
      name: 'review gate', kind: 'approval', state: 'pending', observation: 'approval:::action_required:action_required',
      rerunTarget: null, workflowRunId: null, checkRunId: null, failureSignature: null, failureExcerpt: null
    }
  ])
  expect(contentIdentity(open)).toBe(JSON.stringify([H1, B1]))

  for (const [state, lifecycle, draft] of [
    ['open', 'open', false], ['draft', 'open', true], ['merged', 'merged', false], ['closed', 'closed', false]
  ] as const) {
    expect(worldFromHosting(review({ state }), hostingChecks([]), payload)).toMatchObject({ lifecycle, draft })
  }

  const completedConclusions: Array<[string, CheckState]> = [
    ['success', 'passed'], ['neutral', 'passed'], ['skipped', 'passed'],
    ['failure', 'failed'], ['timed_out', 'failed'], ['action_required', 'failed'], ['startup_failure', 'failed'],
    ['stale', 'failed'], ['error', 'failed'], ['cancelled', 'failed'], ['unknown-conclusion', 'unknown']
  ]
  for (const [conclusion, state] of completedConclusions) {
    expect(worldFromHosting(review(), hostingChecks([
      { kind: 'check_run', name: 'build', status: 'completed', conclusion, checkRunId: 9001, workflowRunId: null }
    ]), payload).checks[0]?.state).toBe(state)
  }
  for (const status of ['queued', 'in_progress', 'requested', 'waiting', 'pending', 'expected']) {
    expect(worldFromHosting(review(), hostingChecks([
      { kind: 'check_run', name: 'build', status, conclusion: null, checkRunId: 9001, workflowRunId: null }
    ]), payload).checks[0]?.state).toBe('pending')
  }
  expect(worldFromHosting(review(), hostingChecks([
    { kind: 'check_run', name: 'build', status: 'completed', conclusion: null, checkRunId: 9001, workflowRunId: null }
  ]), payload).checks[0]?.state).toBe('unknown')
  for (const [status, state] of [
    ['success', 'passed'], ['failure', 'failed'], ['error', 'failed'], ['pending', 'pending'], ['expected', 'pending'], ['unknown', 'unknown']
  ] as const) {
    expect(worldFromHosting(review(), hostingChecks([
      { kind: 'status', name: 'ci', status, conclusion: status, checkRunId: null, workflowRunId: null }
    ]), payload).checks[0]?.state).toBe(state)
  }
  expect(worldFromHosting(review(), hostingChecks([
    { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 9001, workflowRunId: 41 }
  ], { partial: true }), payload).checksComplete).toBe(false)
  expect(worldFromHosting(review(), hostingChecks([], { headSha: H2 }), payload).checksComplete).toBe(false)

  expect(worldFromHosting(review({ mergeMethods: { default: null, allowed: [] } }), hostingChecks([]), payload)).toMatchObject({
    defaultMergeMethod: null, allowedMergeMethods: []
  })
  expect(worldFromHosting(review({ mergeMethods: undefined }), hostingChecks([]), payload)).toMatchObject({
    defaultMergeMethod: null, allowedMergeMethods: []
  })
  expect(worldFromHosting(review({ mergeMethods: { default: 'fast-forward', allowed: ['fast-forward', 'rebase', 'squash'] } }), hostingChecks([]), payload)).toMatchObject({
    defaultMergeMethod: null, allowedMergeMethods: ['rebase', 'squash']
  })
})

test('only an explicit null hosting checks result is complete', () => {
  const malformedChecks: unknown[] = ['x', [], undefined, 17, false]
  for (const checks of malformedChecks) {
    const current = worldFromHosting(review(), checks, payload)
    expect(current.checksComplete).toBe(false)
    expect(decide(snapshot(current), [], enrollment())).toMatchObject({
      action: null, reason: 'merge-gates-unsatisfied', detail: 'checks'
    })
  }

  const malformedLists: unknown[] = [
    { headSha: H1, partial: false, checks: 'x' },
    { headSha: H1, partial: false, checks: [null] }
  ]
  for (const checks of malformedLists) {
    const current = worldFromHosting(review(), checks, payload)
    expect(current.checksComplete).toBe(false)
    expect(decide(snapshot(current), [], enrollment())).toMatchObject({
      action: null, reason: 'merge-gates-unsatisfied', detail: 'checks'
    })
  }

  const complete = worldFromHosting(review(), null, payload)
  expect(complete.checksComplete).toBe(true)
  expect(decide(snapshot(complete), [], enrollment()).action).toMatchObject({ kind: 'merge' })
})

test('a closed or merged review takes no action and stops', () => {
  for (const [lifecycle, state, reason] of [
    ['merged', 'merged', 'review merged'], ['closed', 'closed', 'review closed']
  ] as const) {
    const current = snapshot(world({ lifecycle }))
    expect(decide(current, [], enrollment())).toMatchObject({ action: null, reason: 'review-not-open' })
    expect(stop(current, [], enrollment())).toEqual({ kind: 'terminal', state, reason })
    expect(pace(current, [])).toBe('stopped')
  }
})

test('conflicts stop evaluation before checks, update and merge', () => {
  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  for (const overrides of [
    { mergeable: 'CONFLICTING' as const, mergeStateStatus: 'BEHIND' },
    { mergeable: 'MERGEABLE' as const, mergeStateStatus: 'DIRTY' }
  ]) {
    expect(decide(snapshot(world({ ...overrides, checks: [failed] })), [], enrollment())).toMatchObject({
      action: null,
      reason: 'conflicts-present',
      considered: ['lifecycle', 'conflicts']
    })
  }
})

test('a failed rerunnable check proposes one rerun with exact identity', () => {
  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const decision = decide(snapshot(world({ checks: [failed] })), [], enrollment())
  expect(decision.action).toEqual({
    kind: 'rerun-check',
    capability: 'fixChecks',
    visibility: 'external',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: JSON.stringify(['rerun-check', H1, ['build'], 1]),
    expectedState: { target: `${REVIEW_URL}#checks`, before: H1 },
    observations: ['check_run:9001:41:completed:failure'],
    checkNames: ['build'],
    head: H1,
    ordinal: 1
  })
})

test('an incomplete failed rerunnable check prevents a rerun', () => {
  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const decision = decide(
    snapshot(world({ checksComplete: false, checks: [failed] })),
    [],
    enrollment(caps({ fixChecks: 'on' }))
  )
  expect(decision).toMatchObject({ action: null, reason: 'checks-incomplete' })
})

test('an incomplete behind branch with passed checks is not updated', () => {
  const passed = check({ state: 'passed' })
  const decision = decide(
    snapshot(world({ mergeStateStatus: 'BEHIND', checksComplete: false, checks: [passed] })),
    [],
    enrollment()
  )
  expect(decision).toMatchObject({ action: null, reason: 'checks-incomplete' })
})

test('a rerun waits for the workflow run, then for its result, and is not repeated on the same head', () => {
  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const start = world({ checks: [failed] })
  const firstAction = actionFor(start)
  expect(firstAction?.kind).toBe('rerun-check')
  const rerun = firstAction!
  const pendingSibling = check({
    name: 'unit tests', state: 'pending', observation: 'check_run:9003:41:in_progress:', rerunTarget: 'workflow:41'
  })
  expect(decide(snapshot(world({ checks: [failed, pendingSibling] })), [], enrollment())).toMatchObject({
    action: null, reason: 'awaiting-workflow-run'
  })
  expect(decide(snapshot(start), [attempt(rerun, { state: 'running', effect: undefined })], enrollment())).toMatchObject({
    action: null, reason: 'rerun-in-flight'
  })
  const landed = attempt(rerun, { effect: 'landed' })
  expect(decide(snapshot(start), [landed], enrollment())).toMatchObject({ action: null, reason: 'awaiting-rerun-result' })
  expect(pace(snapshot(start), [landed])).toBe('rapid')

  const persisted = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  const afterRerun = decide(snapshot(world({ checks: [persisted] })), [landed], enrollment())
  expect(afterRerun.action).toMatchObject({
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    recovery: 'replay-safe',
    expectedHeadSha: H1,
    failedChecks: [{
      key: BUILD_CHECK_KEY,
      name: 'build',
      failureSignature: 'sha256:reproduced',
      failureExcerpt: 'compiler failure at src/build.ts'
    }]
  })

  const lint = check({
    name: 'lint',
    state: 'failed',
    observation: 'check_run:9003:43:completed:failure',
    workflowRunId: 43,
    rerunTarget: 'workflow:43'
  })
  const secondFailed = decide(snapshot(world({ checks: [lint] })), [landed], enrollment())
  expect(secondFailed.action).toMatchObject({ kind: 'rerun-check', checkNames: ['lint'] })
})

test('owner-only failures and capability-off are recorded, not acted on', () => {
  const statusFailure = check({
    kind: 'status', state: 'failed', observation: 'status:::failure:failure', rerunTarget: null, workflowRunId: null,
    checkRunId: null, failureSignature: null, failureExcerpt: null
  })
  const statusDecision = decide(snapshot(world({ checks: [statusFailure] })), [], enrollment())
  expect(statusDecision).toMatchObject({ action: null, reason: 'merge-gates-unsatisfied', detail: 'checks' })
  expect(statusDecision.considered).toContain('fix-checks: check-rerun-unavailable')

  const rerunnableFailure = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const offDecision = decide(snapshot(world({ checks: [rerunnableFailure] })), [], enrollment(caps({ fixChecks: 'off' })))
  expect(offDecision.action).toBeNull()
  expect(offDecision.considered).toContain('fix-checks: capability-off')
})

test('a behind branch is updated when ready, but persisted failures are fixed first', () => {
  const behind = world({ mergeStateStatus: 'BEHIND' })
  const update = actionFor(behind)
  expect(update).toEqual({
    kind: 'update-branch',
    capability: 'updateBranch',
    visibility: 'external',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: JSON.stringify(['update-branch', H1, B1, 1]),
    expectedState: { target: `${REVIEW_URL}#head`, before: H1 },
    head: H1,
    base: B1,
    ordinal: 1
  })

  const rerun = actionFor(world({ checks: [check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })] }))!
  const persistedFailure = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  const redBehind = decide(snapshot(world({ mergeStateStatus: 'BEHIND', checks: [persistedFailure] })), [attempt(rerun, { effect: 'landed' })], enrollment())
  expect(redBehind.action).toMatchObject({
    kind: 'prepare-fix',
    capability: 'fixChecks',
    recovery: 'replay-safe',
    expectedHeadSha: H1,
    failedChecks: [{
      key: BUILD_CHECK_KEY,
      failureSignature: 'sha256:reproduced',
      failureExcerpt: 'compiler failure at src/build.ts'
    }]
  })

  expect(decide(snapshot(world({ mergeStateStatus: 'BEHIND', draft: true })), [], enrollment())).toMatchObject({
    action: null, reason: 'merge-gates-unsatisfied'
  })
  expect(decide(snapshot(world({ mergeStateStatus: 'BEHIND', checks: [check({ state: 'pending', observation: 'check_run:9001:41:in_progress:' })] })), [], enrollment())).toMatchObject({
    action: null, reason: 'awaiting-checks'
  })
  const off = decide(snapshot(behind), [], enrollment(caps({ updateBranch: 'off' })))
  expect(off).toMatchObject({ action: null, reason: 'merge-gates-unsatisfied', detail: 'readiness' })
  expect(off.considered).toContain('update-branch: capability-off')

  const landedUpdate = attempt(update!, { effect: 'landed' })
  expect(decide(snapshot(behind), [landedUpdate], enrollment())).toMatchObject({
    action: null, reason: 'awaiting-branch-update'
  })
  expect(pace(snapshot(behind), [landedUpdate])).toBe('rapid')
})

test('merge gates are listed in a fixed order and all must hold', () => {
  expect(actionFor()).toMatchObject({ kind: 'merge' })
  expectGate({}, 'capability', caps({ merge: 'off' }))
  expectGate({ draft: true }, 'draft')
  expectGate({ mergeable: 'UNKNOWN' }, 'conflicts')
  expectGate({ checks: [check({ state: 'pending', observation: 'check_run:9001:41:in_progress:' })] }, 'checks')
  expectGate({ checks: [check({ state: 'unknown', observation: 'check_run:9001:41:completed:' })] }, 'checks')
  expectGate({ checksComplete: false }, 'checks')
  expectGate({ reviewDecision: 'REVIEW_REQUIRED' }, 'approvals')
  expectGate({ reviewDecision: 'CHANGES_REQUESTED' }, 'approvals')
  expectGate({ reviewDecision: 'UNKNOWN' }, 'approvals')
  expect(actionFor(world({ reviewDecision: 'NONE' }))).toMatchObject({ kind: 'merge' })
  for (const mergeStateStatus of ['BLOCKED', 'UNKNOWN', 'UNSTABLE', 'HAS_HOOKS', 'DRAFT']) {
    expectGate({ mergeStateStatus }, 'readiness')
  }
  expectGate({ mergeStateStatus: 'BEHIND' }, 'readiness', caps({ updateBranch: 'off' }))
  expectGate({ mergeQueueRequired: true }, 'merge-queue')
  expectGate({ mergeQueueRequired: null }, 'merge-queue')
  expectGate({ mergeMetadataKnown: false }, 'merge-queue')
  expectGate({ defaultMergeMethod: null }, 'merge-method')
  expectGate({ allowedMergeMethods: ['squash'] }, 'merge-method', caps(), 'merge')

  expectGate({ draft: true, checks: [check({ state: 'pending', observation: 'check_run:9001:41:in_progress:' })] }, 'draft,checks')
  expectGate({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }, 'approvals,readiness')
})

test('a green open review proposes a merge pinned to its head and method', () => {
  expect(actionFor()).toEqual({
    kind: 'merge',
    capability: 'merge',
    visibility: 'external',
    contentIdentity: JSON.stringify([H1, B1]),
    evidenceKey: JSON.stringify(['merge', H1, 'squash', 1]),
    expectedState: { target: REVIEW_URL, before: H1 },
    head: H1,
    method: 'squash',
    ordinal: 1
  })
  expect(actionFor(world(), caps(), [], )).toMatchObject({ kind: 'merge', method: 'squash' })
  const rebaseEnrollment = { ...enrollment(), kindPayload: { ...payload, mergeMethod: 'rebase' as const } }
  expect(decide(snapshot(), [], rebaseEnrollment).action).toMatchObject({ method: 'rebase' })

  const merge = actionFor()!
  expect(decide(snapshot(), [attempt(merge, { effect: 'landed' })], enrollment())).toMatchObject({
    action: null, reason: 'awaiting-merge-state'
  })
})

test('outcomes resolve from the next live snapshot and never wedge', () => {
  const merge = actionFor()!
  const mergeAttempt = attempt(merge)
  expect(resolveOutcome(mergeAttempt, snapshot(world({ lifecycle: 'merged' })))).toEqual({ effect: 'landed' })
  expect(resolveOutcome(mergeAttempt, snapshot(world(), T + UNOBSERVED_EFFECT_MS - 1))).toBeNull()
  expect(resolveOutcome(mergeAttempt, snapshot(world(), T + UNOBSERVED_EFFECT_MS))).toEqual({
    effect: 'not-landed', reason: 'no-merge-observed'
  })
  expect(resolveOutcome(mergeAttempt, snapshot(world({ headSha: H2 }), T + 1))).toEqual({
    effect: 'not-landed', reason: 'head-moved'
  })

  const update = actionFor(world({ mergeStateStatus: 'BEHIND' }))!
  const updateAttempt = attempt(update)
  expect(resolveOutcome(updateAttempt, snapshot(world({ headSha: H2 }), T + 1))).toEqual({
    effect: 'landed', expectedAfter: { head: H2 }
  })
  expect(resolveOutcome(updateAttempt, snapshot(world({ mergeStateStatus: 'BEHIND' }), T + UNOBSERVED_EFFECT_MS - 1))).toBeNull()
  expect(resolveOutcome(updateAttempt, snapshot(world({ mergeStateStatus: 'BEHIND' }), T + UNOBSERVED_EFFECT_MS))).toEqual({
    effect: 'not-landed', reason: 'no-update-observed'
  })

  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const rerun = actionFor(world({ checks: [failed] }))!
  const rerunAttempt = attempt(rerun)
  expect(resolveOutcome(rerunAttempt, snapshot(world({ checks: [check({ observation: 'check_run:9002:42:completed:success', workflowRunId: 42, rerunTarget: 'workflow:42' })] }), T + 1))).toEqual({
    effect: 'landed'
  })
  expect(resolveOutcome(rerunAttempt, snapshot(world({ headSha: H2, checks: [failed] }), T + 1))).toEqual({
    effect: 'not-landed', reason: 'head-moved'
  })
  expect(resolveOutcome(rerunAttempt, snapshot(world({ checks: [failed] }), T + UNOBSERVED_EFFECT_MS - 1))).toBeNull()
  expect(resolveOutcome(rerunAttempt, snapshot(world({ checks: [failed] }), T + UNOBSERVED_EFFECT_MS))).toEqual({
    effect: 'not-landed', reason: 'no-rerun-observed'
  })
})

test('a refused action is retried twice on the same head, two minutes apart, then the watcher parks', () => {
  expect(RETRY_LIMIT).toBe(3)
  expect(RETRY_DELAY_MS).toBe(120_000)
  const merge = actionFor()!
  const oneFailure = failedAttempts(merge, 1)
  const waitingSnapshot = snapshot(world(), T + 60_000)
  const waiting = decide(waitingSnapshot, oneFailure, enrollment())
  expect(waiting).toMatchObject({
    action: null,
    reason: 'retry-waiting',
    detail: `merge attempt 2 after ${new Date(T + RETRY_DELAY_MS).toISOString()}`
  })
  expect(pace(waitingSnapshot, oneFailure)).toBe('active')

  const retrySnapshot = snapshot(world(), T + RETRY_DELAY_MS)
  const second = decide(retrySnapshot, oneFailure, enrollment()).action
  expect(second).toMatchObject({
    kind: 'merge', ordinal: 2,
    evidenceKey: JSON.stringify(['merge', H1, 'squash', 2])
  })
  expect(second?.evidenceKey).not.toBe(merge.evidenceKey)
  const staleApproval: JournalEntry = {
    seq: 2, eventId: 'approval-1', watcherId: 'watcher-1', atMs: T, class: 'fact', origin: 'owner',
    kind: 'approval', resolved: true, status: 'approved',
    approvalScope: { actionKind: 'merge', contentIdentity: contentIdentity(world()), evidenceKey: merge.evidenceKey }
  }
  expect(second?.evidenceKey).not.toBe(staleApproval.approvalScope && (staleApproval.approvalScope as { evidenceKey: string }).evidenceKey)

  const twoFailures = failedAttempts(merge, 2)
  expect(decide(snapshot(world(), T + 3 * RETRY_DELAY_MS), twoFailures, enrollment()).action).toMatchObject({
    kind: 'merge', ordinal: 3, evidenceKey: JSON.stringify(['merge', H1, 'squash', 3])
  })
  const threeFailures = failedAttempts(merge, 3)
  const exhaustedSnapshot = snapshot(world(), T + 4 * RETRY_DELAY_MS)
  const parkedDetail = `merge failed 3 times on ${H1.slice(0, 12)}: merge_blocked: GitHub protection rules currently block this pull request from merging.`
  expect(stop(exhaustedSnapshot, threeFailures, enrollment())).toEqual({
    kind: 'park', reason: 'stop-predicate', detail: parkedDetail
  })
  expect(decide(exhaustedSnapshot, threeFailures, enrollment())).toMatchObject({
    action: null, reason: 'retries-exhausted', detail: parkedDetail
  })

  const operatorResume: JournalEntry = {
    seq: 4, eventId: 'operator-resume', watcherId: 'watcher-1', atMs: T + 3 * RETRY_DELAY_MS,
    class: 'fact', origin: 'client', kind: 'evidence', resolved: true, evidenceKind: 'operator-resume'
  }
  const afterResume = [...threeFailures, operatorResume]
  expect(stop(exhaustedSnapshot, afterResume, enrollment())).toBeNull()
  expect(decide(exhaustedSnapshot, afterResume, enrollment()).action).toMatchObject({
    kind: 'merge', ordinal: 4, evidenceKey: JSON.stringify(['merge', H1, 'squash', 4])
  })
  const afterBudgetGeneration = [...threeFailures, {
    ...operatorResume, seq: 5, eventId: 'budget-generation', evidenceKind: 'budget-generation'
  }]
  expect(stop(exhaustedSnapshot, afterBudgetGeneration, enrollment())).toBeNull()

  const priorAttempts = failedAttempts(merge, 3)
  const reset = {
    ...operatorResume, seq: 4, atMs: T + 3 * RETRY_DELAY_MS, eventId: 'reset-before-new-failures'
  }
  const postResetFailures = failedAttempts(merge, 3, T + 4 * RETRY_DELAY_MS).map((entry, index) => ({
    ...entry, seq: index + 5, attemptId: `post-reset-${index + 1}`
  }))
  const afterResetPark = stop(snapshot(world(), T + 7 * RETRY_DELAY_MS), [...priorAttempts, reset, ...postResetFailures], enrollment())
  expect(afterResetPark).toMatchObject({ kind: 'park', detail: parkedDetail })
  expect(decide(snapshot(world(), T + 7 * RETRY_DELAY_MS), [...priorAttempts, reset, ...postResetFailures], enrollment()).action).toBeNull()

  const latestRevisionWins = [
    ...failedAttempts(merge, 1),
    attempt(merge, { seq: 2, eventId: 'same-attempt-settled-again', attemptId: 'failed-1', effect: 'landed' })
  ]
  expect(stop(retrySnapshot, latestRevisionWins, enrollment())).toBeNull()
  expect(decide(retrySnapshot, latestRevisionWins, enrollment())).toMatchObject({ action: null, reason: 'awaiting-merge-state' })
  const latestRevisionFailure = [
    ...failedAttempts(merge, 1),
    attempt(merge, { seq: 2, eventId: 'same-attempt-live-failure', attemptId: 'failed-1', effect: 'not-landed', reason: 'no-merge-observed' })
  ]
  expect(decide(retrySnapshot, latestRevisionFailure, enrollment()).action).toMatchObject({
    kind: 'merge', ordinal: 2, evidenceKey: JSON.stringify(['merge', H1, 'squash', 2])
  })
  const unresolvedRevisionWins = [
    ...failedAttempts(merge, 1),
    attempt(merge, { seq: 2, eventId: 'same-attempt-running-again', attemptId: 'failed-1', state: 'running', effect: undefined })
  ]
  expect(decide(retrySnapshot, unresolvedRevisionWins, enrollment())).toMatchObject({
    action: null, reason: 'awaiting-merge-state'
  })

  const movedHead = snapshot(world({ headSha: H2 }), T + 4 * RETRY_DELAY_MS)
  expect(stop(movedHead, threeFailures, enrollment())).toBeNull()
  expect(decide(movedHead, threeFailures, enrollment()).action).toMatchObject({
    kind: 'merge', head: H2, ordinal: 1, evidenceKey: JSON.stringify(['merge', H2, 'squash', 1])
  })

  const updateWorld = world({ mergeStateStatus: 'BEHIND' })
  const update = actionFor(updateWorld)!
  const updateFailures = failedAttempts(update, 3)
  const changedBase = snapshot(world({ mergeStateStatus: 'BEHIND', baseSha: B2 }), T + 4 * RETRY_DELAY_MS)
  expect(stop(changedBase, updateFailures, enrollment())).toBeNull()
  expect(decide(changedBase, updateFailures, enrollment()).action).toMatchObject({
    kind: 'update-branch', base: B2, ordinal: 1, evidenceKey: JSON.stringify(['update-branch', H1, B2, 1])
  })
  expect(stop(snapshot(updateWorld, T + 4 * RETRY_DELAY_MS), updateFailures, enrollment())).toMatchObject({
    kind: 'park', detail: `update-branch failed 3 times on ${H1.slice(0, 12)}: merge_blocked: GitHub protection rules currently block this pull request from merging.`
  })

  const rerunWorld = world({ checks: [check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })] })
  const rerun = actionFor(rerunWorld)!
  const rerunFailures = failedAttempts(rerun, 3)
  expect(decide(snapshot(rerunWorld, T + 4 * RETRY_DELAY_MS), rerunFailures, enrollment())).toMatchObject({
    action: null, reason: 'retries-exhausted'
  })
  expect(stop(snapshot(rerunWorld, T + 4 * RETRY_DELAY_MS), rerunFailures, enrollment())).toMatchObject({
    kind: 'park', detail: `rerun-check failed 3 times on ${H1.slice(0, 12)}: merge_blocked: GitHub protection rules currently block this pull request from merging.`
  })
  expect(decide(snapshot(rerunWorld, T + 4 * RETRY_DELAY_MS), [...rerunFailures, operatorResume], enrollment()).action).toMatchObject({
    kind: 'rerun-check', ordinal: 4, evidenceKey: JSON.stringify(['rerun-check', H1, ['build'], 4])
  })
  const differentCheck = snapshot(world({ checks: [check({
    name: 'lint', state: 'failed', observation: 'check_run:9002:42:completed:failure', workflowRunId: 42, rerunTarget: 'workflow:42'
  })] }), T + 4 * RETRY_DELAY_MS)
  expect(stop(differentCheck, rerunFailures, enrollment())).toBeNull()
  expect(decide(differentCheck, rerunFailures, enrollment()).action).toMatchObject({
    kind: 'rerun-check', checkNames: ['lint'], ordinal: 1
  })

  const differentMethodEnrollment = { ...enrollment(), kindPayload: { ...payload, mergeMethod: 'rebase' as const } }
  expect(decide(retrySnapshot, threeFailures, differentMethodEnrollment).action).toMatchObject({
    kind: 'merge', method: 'rebase', ordinal: 1, evidenceKey: JSON.stringify(['merge', H1, 'rebase', 1])
  })
  expect(stop(snapshot(updateWorld, T + 4 * RETRY_DELAY_MS), updateFailures, enrollment(caps({ updateBranch: 'off' })))).toBeNull()
})

test('hosting-refused action-required, stale and error checks stay failed and cannot be rerun', () => {
  for (const conclusion of ['action_required', 'stale', 'error']) {
    const current = worldFromHosting(review(), hostingChecks([{
      kind: 'check_run', name: 'build', status: 'completed', conclusion, checkRunId: 9001, workflowRunId: 41
    }]), payload)
    expect(current.checks).toMatchObject([{ state: 'failed', rerunTarget: null }])
    expect(decide(snapshot(current), [], enrollment())).toMatchObject({
      action: null, reason: 'merge-gates-unsatisfied', detail: 'checks'
    })
  }
})

test('a refused check run does not hold a rerun open after the selected check passes', () => {
  const before = worldFromHosting(review(), hostingChecks([
    { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'failure', checkRunId: 9001, workflowRunId: 41 },
    { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'stale', checkRunId: 9002, workflowRunId: 42 }
  ]), payload)
  const rerun = actionFor(before)!
  if (rerun.kind !== 'rerun-check') throw new Error('Expected a rerun-check action')
  expect(rerun).toMatchObject({
    kind: 'rerun-check',
    checkNames: ['build'],
    observations: ['check_run:9001:41:completed:failure']
  })

  const after = worldFromHosting(review(), hostingChecks([
    { kind: 'check_run', name: 'build', status: 'completed', conclusion: 'success', checkRunId: 9001, workflowRunId: 41 },
    { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'stale', checkRunId: 9002, workflowRunId: 42 }
  ]), payload)
  expect(after.checks[0]).toMatchObject({ name: 'build', state: 'passed' })
  expect(after.checks[0]?.observation).not.toBe(rerun.observations[0])
  expect(after.checks[1]).toMatchObject({ name: 'lint', state: 'failed', rerunTarget: null })

  const landed = attempt(rerun, { effect: 'landed' })
  expect(decide(snapshot(after), [landed], enrollment())).toMatchObject({
    action: null, reason: 'merge-gates-unsatisfied', detail: 'checks'
  })
  expect(pace(snapshot(after), [landed])).toBe('active')
})

test('pacing follows one ordered rule list; the first match wins', () => {
  const merge = actionFor()!
  expect(pace(snapshot(), [])).toBe('idle')
  expect(pace(snapshot(), [],)).toBe('idle')
  expect(pace(snapshot(world({ lifecycle: 'merged' })), [attempt(merge, { state: 'running', effect: undefined })])).toBe('stopped')
  expect(pace(snapshot(world({ lifecycle: 'merged' })), [])).toBe('stopped')
  expect(pace(snapshot(), [attempt(merge, { state: 'running', effect: undefined })])).toBe('rapid')
  expect(pace(snapshot(), [attempt(merge, { effect: 'indeterminate' })])).toBe('rapid')
  expect(pace(snapshot(world({ checks: [check({ state: 'pending', observation: 'check_run:9001:41:in_progress:' })] })), [])).toBe('rapid')

  const failed = check({ state: 'failed', observation: 'check_run:9001:41:completed:failure' })
  const rerun = actionFor(world({ checks: [failed] }))!
  expect(pace(snapshot(world({ checks: [failed] })), [attempt(rerun, { effect: 'landed' })])).toBe('rapid')
  const update = actionFor(world({ mergeStateStatus: 'BEHIND' }))!
  expect(pace(snapshot(world({ mergeStateStatus: 'BEHIND' })), [attempt(update, { effect: 'landed' })])).toBe('rapid')
  expect(pace(snapshot(), [attempt(merge, { effect: 'landed' })])).toBe('rapid')

  const rerunPersisted = check({ state: 'failed', observation: 'check_run:9002:42:completed:failure', workflowRunId: 42, rerunTarget: 'workflow:42' })
  expect(pace(snapshot(world({ checks: [rerunPersisted] })), [attempt(rerun, { effect: 'landed' })])).toBe('active')
  expect(pace(snapshot(world({ mergeStateStatus: 'BEHIND' })), [])).toBe('active')
  expect(pace(snapshot(world({ mergeable: 'CONFLICTING' })), [])).toBe('active')

  const oneFailure = failedAttempts(merge, 1)
  expect(pace(snapshot(world(), T + 60_000), oneFailure)).toBe('active')
  const movedBase = snapshot(world({ baseSha: B2 }), T + 60_000)
  expect(decide(movedBase, oneFailure, enrollment())).toMatchObject({ action: null, reason: 'retry-waiting' })
  expect(pace(movedBase, oneFailure)).toBe('active')
  expect(pace(snapshot(world(), T + 60_000), [
    attempt(merge, { state: 'running', effect: undefined }),
    ...oneFailure
  ])).toBe('rapid')
})

test('a settled rerun with changed observations prepares a fix exactly once', () => {
  const originalFailure = check({
    state: 'failed',
    observation: 'check_run:9001:41:completed:failure',
    failureSignature: 'sha256:first-failure',
    failureExcerpt: 'initial compiler failure'
  })
  const originalWorld = world({ checks: [originalFailure] })
  const rerun = actionFor(originalWorld)!
  expect(rerun.kind).toBe('rerun-check')
  const landedRerun = attempt(rerun, { effect: 'landed' })

  const reproducedFailure = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  expect(reproducedFailure.observation).not.toBe(originalFailure.observation)
  const current = snapshot(world({ checks: [reproducedFailure] }))
  const decision = decide(current, [landedRerun], enrollment(caps({ fixChecks: 'gated' })))
  expect(decision.action).toMatchObject({
    kind: 'prepare-fix',
    capability: 'fixChecks',
    visibility: 'local',
    recovery: 'replay-safe',
    expectedHeadSha: H1,
    failedChecks: [{
      key: BUILD_CHECK_KEY,
      name: 'build',
      failureSignature: 'sha256:reproduced',
      failureExcerpt: 'compiler failure at src/build.ts'
    }]
  })
  if (!decision.action) return
  const action = decision.action as SitterAction & { contentIdentity: string; evidenceKey: string }
  expect(action.contentIdentity.startsWith('fix-checks:')).toBe(true)
  expect(action.evidenceKey).toBe(`${H1}:${action.contentIdentity.slice('fix-checks:'.length)}`)

  for (const unresolved of [
    attempt(action, { seq: 2, state: 'running', effect: undefined, resolved: false }),
    attempt(action, { seq: 2, state: 'settled', effect: 'indeterminate', resolved: false })
  ]) {
    expect(decide(current, [landedRerun, unresolved], enrollment()).action).toBeNull()
  }
})

test('enabled conflict resolution takes precedence over failed checks', () => {
  const failed = check({
    state: 'failed',
    observation: 'check_run:9001:41:completed:failure',
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  const decision = decide(
    snapshot(world({ mergeable: 'CONFLICTING', checks: [failed] })),
    [],
    enrollment(caps({ resolveConflicts: 'gated', fixChecks: 'on' }))
  )
  expect(decision.action).toMatchObject({
    kind: 'prepare-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: `resolve-conflicts:${B1}`,
    evidenceKey: `${H1}:${B1}`,
    expectedHeadSha: H1,
    baseSha: B1,
    baseRefName: 'main'
  })
})

test('persisted failures and conflicts park when their fix capabilities are off', () => {
  const initial = check({
    state: 'failed',
    observation: 'check_run:9001:41:completed:failure',
    failureSignature: 'sha256:first-failure',
    failureExcerpt: 'initial compiler failure'
  })
  const rerun = actionFor(world({ checks: [initial] }))!
  const landedRerun = attempt(rerun, { effect: 'landed' })
  const persisted = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  expectParked(
    stop(snapshot(world({ checks: [persisted] })), [landedRerun], enrollment(caps({ fixChecks: 'off' }))),
    'failure-persisted-after-rerun',
    'check-failed',
    `failure-persisted-after-rerun:${H1}`
  )
  expectParked(
    stop(snapshot(world({ mergeable: 'CONFLICTING' })), [], enrollment(caps({ resolveConflicts: 'off' }))),
    'conflicts-present',
    'landing-failed',
    `conflicts-present:${H1}`
  )
})

test('clean landed prepares publish only their verified commit SHA', () => {
  const fixPrepare = prepareFixAction()
  const fixPrepared = attempt(fixPrepare, { fingerprint: 'fp-fix' })
  const fixWorld = world({
    checks: [check({
      state: 'failed',
      observation: 'check_run:9002:42:completed:failure',
      workflowRunId: 42,
      rerunTarget: 'workflow:42',
      checkRunId: 9002,
      failureSignature: 'sha256:reproduced',
      failureExcerpt: 'compiler failure at src/build.ts'
    })],
    localHeadSha: B2,
    localPrepared: preparedCommit()
  })
  const fixPublish = decide(snapshot(fixWorld), [fixPrepared], enrollment(caps({ fixChecks: 'gated' }))).action
  expect(fixPublish).toMatchObject({
    kind: 'publish-fix',
    capability: 'fixChecks',
    visibility: 'external',
    recovery: 'replay-safe',
    contentIdentity: `publish-fix:${B2}`,
    evidenceKey: H1,
    preparedCommitSha: B2,
    expectedHeadSha: H1,
    prepareFingerprint: 'fp-fix'
  })

  for (const unresolved of [
    attempt(fixPrepare, { state: 'running', effect: undefined, resolved: false }),
    attempt(fixPrepare, { state: 'settled', effect: 'indeterminate', resolved: false }),
    attempt(fixPrepare, { state: 'settled', effect: 'not-landed', reason: 'worker-failed' }),
    attempt(fixPrepare, { fingerprint: 'other-fingerprint' })
  ]) {
    expect(decide(snapshot(fixWorld), [unresolved], enrollment()).action?.kind).not.toBe('publish-fix')
  }
  expect(decide(
    snapshot(world({ ...fixWorld, headSha: H2 })),
    [fixPrepared],
    enrollment(caps({ fixChecks: 'on' }))
  ).action?.kind).not.toBe('publish-fix')
  const revisedPrepare = attempt(fixPrepare, {
    seq: 2,
    attemptId: fixPrepared.attemptId,
    effect: 'not-landed',
    reason: 'worker-failed'
  })
  expect(decide(snapshot(fixWorld), [fixPrepared, revisedPrepare], enrollment()).action?.kind).not.toBe('publish-fix')

  const conflictPrepare = prepareConflictAction()
  const conflictPrepared = attempt(conflictPrepare, { fingerprint: 'fp-conflict' })
  const conflictWorld = world({
    mergeable: 'CONFLICTING',
    localHeadSha: B2,
    localPrepared: preparedCommit({ parentCount: 2, attemptTrailer: 'fp-conflict' })
  })
  const conflictPublish = decide(
    snapshot(conflictWorld),
    [conflictPrepared],
    enrollment(caps({ resolveConflicts: 'gated' }))
  ).action
  expect(conflictPublish).toMatchObject({
    kind: 'publish-conflict-resolution',
    capability: 'resolveConflicts',
    visibility: 'external',
    recovery: 'replay-safe',
    contentIdentity: `publish-conflict-resolution:${B2}`,
    evidenceKey: H1,
    preparedCommitSha: B2,
    expectedHeadSha: H1,
    prepareFingerprint: 'fp-conflict'
  })
  for (const unresolved of [
    attempt(conflictPrepare, { state: 'running', effect: undefined, resolved: false, fingerprint: 'fp-conflict' }),
    attempt(conflictPrepare, { fingerprint: 'other-fingerprint' })
  ]) {
    expect(decide(
      snapshot(conflictWorld),
      [unresolved],
      enrollment(caps({ resolveConflicts: 'on' }))
    ).action?.kind).not.toBe('publish-conflict-resolution')
  }
  expect(decide(
    snapshot(world({ ...conflictWorld, baseSha: B2 })),
    [conflictPrepared],
    enrollment(caps({ resolveConflicts: 'on' }))
  ).action?.kind).not.toBe('publish-conflict-resolution')
  expect(decide(
    snapshot(world({ ...conflictWorld, headSha: H2 })),
    [conflictPrepared],
    enrollment(caps({ resolveConflicts: 'on' }))
  ).action?.kind).not.toBe('publish-conflict-resolution')
})

test('a prepared commit with a diff-policy violation parks for review', () => {
  const prepared = attempt(prepareFixAction(), { fingerprint: 'fp-fix' })
  expectParked(
    stop(snapshot(world({
      checks: [check({
        state: 'failed',
        observation: 'check_run:9002:42:completed:failure',
        workflowRunId: 42,
        rerunTarget: 'workflow:42',
        checkRunId: 9002,
        failureSignature: 'sha256:reproduced',
        failureExcerpt: 'compiler failure at src/build.ts'
      })],
      localHeadSha: B2,
      localPrepared: preparedCommit({ policyViolation: 'removed test assertions' })
    })), [prepared], enrollment()),
    'diff-policy-violation',
    'report-rejected',
    `diff-policy-violation:${B2}`
  )
})

test('broken prepare workers and commits park for review', () => {
  const fixPrepare = prepareFixAction()
  const currentFailure = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'compiler failure at src/build.ts'
  })
  const failureWorld = world({ checks: [currentFailure] })
  const failures = [
    {
      name: 'worker failure',
      journal: [attempt(fixPrepare, { effect: 'not-landed', reason: 'worker-failed', fingerprint: 'fp-fix' })],
      value: failureWorld
    },
    {
      name: 'missing attempt trailer',
      journal: [attempt(fixPrepare, { fingerprint: 'fp-fix' })],
      value: world({ ...failureWorld, localHeadSha: B2, localPrepared: preparedCommit({ attemptTrailer: null }) })
    },
    {
      name: 'dirty worktree',
      journal: [attempt(fixPrepare, { fingerprint: 'fp-fix' })],
      value: world({
        ...failureWorld,
        localHeadSha: B2,
        localDirty: true,
        localPrepared: preparedCommit({ dirty: true })
      })
    },
    {
      name: 'wrong primary parent',
      journal: [attempt(fixPrepare, { fingerprint: 'fp-fix' })],
      value: world({ ...failureWorld, localHeadSha: B2, localPrepared: preparedCommit({ primaryParentSha: B1 }) })
    },
    {
      name: 'multiple parents on a fix',
      journal: [attempt(fixPrepare, { fingerprint: 'fp-fix' })],
      value: world({ ...failureWorld, localHeadSha: B2, localPrepared: preparedCommit({ parentCount: 2 }) })
    }
  ]
  for (const failure of failures) {
    expectParked(
      stop(snapshot(failure.value), failure.journal, enrollment()),
      'unverified-prepared-commit',
      'report-rejected',
      `unverified-prepared-commit:${H1}`
    )
  }

  const conflictPrepare = prepareConflictAction()
  expectParked(
    stop(snapshot(world({
      mergeable: 'CONFLICTING',
      checks: [currentFailure],
      localHeadSha: B2,
      localPrepared: preparedCommit({ parentCount: 3, attemptTrailer: 'fp-conflict' })
    })), [attempt(conflictPrepare, { fingerprint: 'fp-conflict' })], enrollment(caps({ resolveConflicts: 'on' }))),
    'unverified-prepared-commit',
    'report-rejected',
    `unverified-prepared-commit:${H1}`
  )
})

test('an unverifiable persisted failure stops instead of preparing a fix', () => {
  const initial = check({
    state: 'failed',
    observation: 'check_run:9001:41:completed:failure',
    failureSignature: 'sha256:first-failure',
    failureExcerpt: 'initial compiler failure'
  })
  const rerun = actionFor(world({ checks: [initial] }))!
  const landedRerun = attempt(rerun, { effect: 'landed' })
  const unverifiable = check({
    state: 'failed',
    observation: 'check_run:9002:42:completed:failure',
    workflowRunId: 42,
    rerunTarget: 'workflow:42',
    checkRunId: 9002,
    failureSignature: null,
    failureExcerpt: null
  })
  expectParked(
    stop(snapshot(world({ checks: [unverifiable] })), [landedRerun], enrollment(caps({ fixChecks: 'gated' }))),
    'unverifiable-reproduced-failure',
    'check-failed',
    `unverifiable-reproduced-failure:${H1}`
  )
})

test('only the same check key and signature after its own published fix parks', () => {
  const fixPrepare = prepareFixAction()
  const prepared = attempt(fixPrepare, { fingerprint: 'fp-fix' })
  const published = attempt(publishFixAction(), { seq: 2, fingerprint: 'fp-publish' })
  const sameFailure = check({
    state: 'failed',
    observation: 'check_run:9003:43:completed:failure',
    workflowRunId: 43,
    rerunTarget: 'workflow:43',
    checkRunId: 9003,
    failureSignature: 'sha256:reproduced',
    failureExcerpt: 'same compiler failure'
  })
  const afterOwnFix = snapshot(world({ headSha: B2, localHeadSha: B2, checks: [sameFailure] }))
  expectParked(
    stop(afterOwnFix, [prepared, published], enrollment()),
    'repeated-failure-after-own-fix',
    'check-failed',
    `repeated-failure-after-own-fix:${B2}`
  )

  const changedSignature = check({ ...sameFailure, failureSignature: 'sha256:changed' })
  const changed = snapshot(world({ headSha: B2, localHeadSha: B2, checks: [changedSignature] }))
  expect(stop(changed, [prepared, published], enrollment())).toBeNull()
  expect(decide(changed, [prepared, published], enrollment()).action).toMatchObject({ kind: 'rerun-check' })

  const unlinkedPublish = {
    ...publishFixAction(),
    prepareFingerprint: 'unrelated-prepare'
  } as unknown as SitterAction
  expect(stop(afterOwnFix, [prepared, attempt(unlinkedPublish, { seq: 2 })], enrollment())).toBeNull()
  expect(stop(afterOwnFix, [
    prepared,
    published,
    attempt(publishFixAction(), { seq: 3, attemptId: 'attempt-2', effect: 'not-landed', reason: 'head-moved' })
  ], enrollment())).toBeNull()
})

test('indeterminate publish attempts resolve from live head observations', () => {
  for (const action of [publishFixAction(), publishConflictAction()]) {
    const indeterminate = attempt(action, { effect: 'indeterminate', resolved: false })
    expect(resolveOutcome(indeterminate, snapshot(world({ headSha: B2 })))).toEqual({ effect: 'landed' })
    expect(resolveOutcome(indeterminate, snapshot(world({ headSha: H2 })))).toMatchObject({ effect: 'not-landed' })
    expect(resolveOutcome(
      indeterminate,
      snapshot(world({ headSha: H1 }), T + UNOBSERVED_EFFECT_MS)
    )).toBeNull()
  }
})
