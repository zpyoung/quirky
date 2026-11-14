import { describe, expect, test } from 'bun:test'
import {
  decideObjective,
  deriveProgress,
  nextStep,
  paceObjective,
  stopObjective,
  type ObjectiveWorld
} from '../src/decide'

type Journal = Parameters<typeof nextStep>[1]
type JournalRow = Journal[number]
type AttemptKind =
  | 'dispatch-planner' | 'activate-plan' | 'dispatch-node' | 'run-check' | 'run-gate'
  | 'dispatch-reviewer' | 'dispatch-integrator' | 'apply-plan-repair' | 'record-landing' | 'commit-local-branch'
type AttemptState = 'attempted' | 'running' | 'settled'
type AttemptEffect = 'landed' | 'not-landed' | 'indeterminate'

const identity = 'objective-tree:abc'
const contract = {
  objectiveText: 'Complete the objective',
  tier: 'express' as const,
  landingBar: 'files-on-disk' as const,
  lanesEnabled: true,
  maxConcurrency: 1,
  writeTerritory: ['**'],
  roleAgents: {},
  gates: [],
  worktree: 'id:worktree'
}
type TestWorld = ObjectiveWorld & Required<Pick<
  ObjectiveWorld,
  'checks' | 'verdicts' | 'landings' | 'rejectedDrafts' | 'overruns' | 'repairs'
>>

function world(overrides: Partial<ObjectiveWorld> = {}): TestWorld {
  const planMode = overrides.planMode ?? 'gated'
  const capabilities = {
    plan: planMode,
    implement: 'on' as const,
    check: 'on' as const,
    review: 'on' as const,
    land: 'on' as const,
    ...overrides.capabilities
  }
  return {
    planMode,
    contract,
    contentIdentity: identity,
    observedAtMs: 1,
    git: { branch: 'main', headSha: 'head-1' },
    revision: null,
    reports: [],
    issued: [],
    checks: [],
    verdicts: [],
    landings: [],
    rejectedDrafts: [],
    overruns: [],
    repairs: [],
    ...overrides,
    capabilities
  }
}

function snapshot(value: ObjectiveWorld, contentIdentity = identity, observedAtMs = 1) {
  return { freshness: 'live' as const, contentIdentity, observedAtMs, world: value }
}

function attempt(
  attemptId: string,
  seq: number,
  kind: AttemptKind,
  options: {
    state?: AttemptState
    effect?: AttemptEffect
    dispatchId?: string
    revision?: number
    taskKey?: string
    ordinal?: number
    evidenceKey?: string
    reason?: string
    contentIdentity?: string
    plannerMode?: 'initial' | 'repair'
    repairEpisode?: number
    role?: 'reviewer' | 'integrator'
    gateName?: string
    targetKey?: string
    branch?: string
    headSha?: string
  } = {}
): JournalRow {
  const review = kind === 'dispatch-reviewer' || kind === 'dispatch-integrator'
  const checking = kind === 'run-check' || kind === 'run-gate'
  return {
    seq,
    kind: 'attempt',
    attemptId,
    action: {
      kind,
      capability: kind === 'dispatch-node' ? 'implement' : review ? 'review' : checking ? 'check' : kind === 'commit-local-branch' ? 'land' : kind === 'record-landing' ? 'land' : 'plan',
      visibility: 'local',
      ...(options.evidenceKey === undefined ? {} : { evidenceKey: options.evidenceKey }),
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
      ...(options.ordinal === undefined ? {} : { ordinal: options.ordinal }),
      ...(options.contentIdentity === undefined ? {} : { contentIdentity: options.contentIdentity }),
      ...(options.plannerMode === undefined ? {} : { plannerMode: options.plannerMode }),
      ...(options.repairEpisode === undefined ? {} : { repairEpisode: options.repairEpisode }),
      ...(options.role === undefined ? {} : { role: options.role }),
      ...(options.gateName === undefined ? {} : { gateName: options.gateName }),
      ...(options.targetKey === undefined ? {} : { targetKey: options.targetKey }),
      ...(options.branch === undefined ? {} : { branch: options.branch }),
      ...(options.headSha === undefined ? {} : { headSha: options.headSha })
    },
    state: options.state ?? 'running',
    ...(options.effect === undefined ? {} : { effect: options.effect }),
    ...(options.dispatchId === undefined ? {} : { dispatchId: options.dispatchId }),
    ...(options.reason === undefined ? {} : { reason: options.reason })
  }
}

function plannerIssue(attemptId: string, options: {
  revision?: number | null; plannerMode?: 'initial' | 'repair'; contentIdentity?: string
} = {}) {
  return {
    attemptId, role: 'planner' as const, revision: options.revision ?? null, taskKey: null,
    ...options
  }
}

function plannerReport(attemptId: string, digest = 'plan-digest') {
  return { attemptId, role: 'planner' as const, taskKey: null, digest }
}

function revision(
  tasks: { taskKey: string; deps: string[]; criteriaCount?: number; criteria?: Criterion[] }[],
  number = 1
) {
  const plannedTasks = tasks.map(({ taskKey, deps, criteriaCount = 1, criteria }) => {
    const selectedCriteria = criteria ?? Array.from({ length: criteriaCount }, (_, index) => ({
      body: `Criterion ${index + 1} for ${taskKey}`,
      shellCheckable: false,
      checkCommand: null
    }))
    return {
      taskKey, deps, criteriaCount: selectedCriteria.length, criteria: selectedCriteria,
      title: `Task ${taskKey}`, spec: `Complete ${taskKey}`, territory: ['**']
    }
  })
  return {
    number,
    digest: `revision-${number}`,
    tasks: plannedTasks,
    plan: { plan: { tasks: plannedTasks }, assumptions: [] }
  }
}

function taskIssue(attemptId: string, taskKey: string, revisionNumber = 1) {
  return { attemptId, role: 'implementer' as const, revision: revisionNumber, taskKey }
}

function taskReport(attemptId: string, taskKey: string, summary = `Finished ${taskKey}.`) {
  return { attemptId, role: 'implementer' as const, taskKey, digest: `report-${attemptId}`, summary, filesModified: [`${taskKey}.ts`] }
}

function nodeAttempt(
  attemptId: string,
  seq: number,
  taskKey: string,
  ordinal: number,
  options: Parameters<typeof attempt>[3] = {}
) {
  const suffix = options.repairEpisode === undefined ? `${ordinal}` : `r${options.repairEpisode}:${ordinal}`
  return attempt(attemptId, seq, 'dispatch-node', {
    revision: 1,
    taskKey,
    ordinal,
    evidenceKey: `node:1:${taskKey}:${suffix}`,
    ...options
  })
}

function escalation(
  seq: number,
  escalationId: string,
  status: string,
  actionKind = 'dispatch-planner',
  evidenceKey = 'plan:1'
): JournalRow {
  return {
    seq,
    kind: 'escalation',
    escalationId,
    escalationKind: 'awaiting-approval',
    status,
    foldCount: 1,
    approvalScope: {
      actionKind,
      contentIdentity: identity,
      evidenceKey
    }
  }
}

type Criterion = NonNullable<NonNullable<ObjectiveWorld['revision']>['tasks'][number]['criteria']>[number]

function checkRow(
  attemptId: string,
  kind: 'criterion' | 'gate',
  targetKey: string,
  status: 'passed' | 'failed' | 'stale',
  options: { contentIdentity?: string; revision?: number; checkedAtMs?: number; command?: string } = {}
) {
  return {
    attemptId, watcherId: 'watcher', revision: options.revision ?? 1, kind, targetKey,
    contentIdentity: options.contentIdentity ?? identity, command: options.command ?? 'true',
    status, exitCode: status === 'passed' ? 0 : 1, timedOut: false, stdoutTail: '', stderrTail: '',
    checkedAtMs: options.checkedAtMs ?? 1
  }
}

function completedWorld(
  tier: 'express' | 'standard' | 'full' = 'express',
  overrides: Partial<ObjectiveWorld> = {}
) {
  const payload = { ...contract, tier }
  return world({
    contract: payload,
    revision: revision([{ taskKey: 'a', deps: [] }]),
    issued: [taskIssue('a-1', 'a')],
    reports: [taskReport('a-1', 'a')],
    ...overrides
  })
}

function completedJournal() {
  return [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })]
}

function verdictRow(
  attemptId: string,
  role: 'reviewer' | 'integrator',
  verdict: 'approve' | 'block',
  contentIdentity = identity
) {
  return {
    attemptId, watcherId: 'watcher', dispatchId: `dispatch-${attemptId}`, revision: 1, role,
    contentIdentity, verdict, criteriaResults: [], checksRun: [], summary: `${verdict} by ${role}`,
    digest: `digest-${attemptId}`, acceptedAtMs: 1
  }
}
function reviewIssue(attemptId: string, role: 'reviewer' | 'integrator', contentIdentity = identity) {
  return { attemptId, role, revision: 1, taskKey: null, contentIdentity }
}

function reviewAttempt(
  attemptId: string,
  seq: number,
  role: 'reviewer' | 'integrator',
  options: { state?: AttemptState; effect?: AttemptEffect; contentIdentity?: string } = {}
) {
  return attempt(attemptId, seq, role === 'reviewer' ? 'dispatch-reviewer' : 'dispatch-integrator', {
    state: options.state ?? 'settled',
    effect: options.effect ?? 'landed',
    dispatchId: `dispatch-${attemptId}`,
    revision: 1,
    ordinal: 1,
    contentIdentity: options.contentIdentity ?? identity
  })
}

function repairIssue(
  attemptId: string,
  episode: number,
  ordinal: number,
  options: { revision?: number; mode?: 'repair' } = {}
) {
  return attempt(attemptId, ordinal, 'dispatch-planner', {
    state: 'settled',
    effect: 'not-landed',
    revision: options.revision ?? 1,
    ordinal,
    evidenceKey: `plan-repair:${options.revision ?? 1}:${episode}:${ordinal}`,
    plannerMode: options.mode ?? 'repair',
    repairEpisode: episode
  })
}

function landingRow(rung: 'files-on-disk' | 'committed-local-branch', contentIdentity = identity) {
  return {
    watcherId: 'watcher', rung, contentIdentity, attemptId: `landing-${rung}`,
    payload: {}, recordedAtMs: 1
  }
}

function repairRecord(ordinal: number, touchedTaskKeys: string[]) {
  return {
    watcherId: 'watcher', revision: 1, ordinal, attemptId: `repair-${ordinal}`,
    beforeDigest: `before-${ordinal}`, afterDigest: `after-${ordinal}`, touchedTaskKeys,
    patch: { repair: { upsertTasks: [], dropTaskKeys: [] }, assumptions: [] }, appliedAtMs: ordinal
  }
}

function rejectedDraft(attemptId: string, digest: string, rejectedAtMs = 1) {
  return { attemptId, watcherId: 'watcher', digest, reason: 'Please revise the plan.', rejectedAtMs }
}

describe('objective decisions', () => {
  test('asks for a planner, waits on it, then offers its draft for activation', () => {
    const initialWorld = world()
    const initialSnapshot = snapshot(initialWorld)
    const expectedPlannerAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      evidenceKey: 'plan:1',
      ordinal: 1,
      plannerMode: 'initial'
    } as const

    expect(nextStep(initialWorld, [])).toEqual({ action: expectedPlannerAction })
    expect(decideObjective(initialSnapshot, [])).toEqual({
      action: { ...expectedPlannerAction, contentIdentity: 'objective-tree:abc' }
    })

    const waitingJournal = [
      attempt('planner-1', 2, 'dispatch-planner', {
        state: 'running',
        dispatchId: 'dispatch-1',
        evidenceKey: 'plan:1'
      }),
      attempt('planner-1', 1, 'dispatch-planner', {
        state: 'settled',
        effect: 'not-landed',
        evidenceKey: 'plan:1'
      })
    ]
    expect(nextStep(initialWorld, waitingJournal)).toEqual({ action: null, reason: 'planner-in-flight' })

    const draftWorld = world({
      issued: [plannerIssue('planner-1')],
      reports: [plannerReport('planner-1')]
    })
    const landedPlanner = [attempt('planner-1', 3, 'dispatch-planner', {
      state: 'settled',
      effect: 'landed',
      evidenceKey: 'plan:1'
    })]
    expect(deriveProgress(draftWorld, landedPlanner).draft).toEqual({
      plannerAttemptId: 'planner-1',
      digest: 'plan-digest',
      kind: 'initial'
    })
    expect(nextStep(draftWorld, landedPlanner)).toEqual({
      action: {
        kind: 'activate-plan',
        capability: 'plan',
        visibility: 'local',
        recovery: 'replay-safe',
        evidenceKey: 'activate-plan:planner-1',
        plannerAttemptId: 'planner-1',
        digest: 'plan-digest'
      }
    })
    expect(decideObjective(snapshot(draftWorld), landedPlanner)).toEqual({
      action: {
        kind: 'activate-plan',
        capability: 'plan',
        visibility: 'local',
        recovery: 'replay-safe',
        evidenceKey: 'activate-plan:planner-1',
        plannerAttemptId: 'planner-1',
        digest: 'plan-digest',
        contentIdentity: 'objective-tree:abc'
      }
    })
    const activatedWorld = world({
      revision: revision([{ taskKey: 'approved', deps: [] }]),
      issued: [plannerIssue('planner-1')],
      reports: [plannerReport('planner-1')]
    })
    expect(deriveProgress(activatedWorld, landedPlanner).draft).toBeNull()
  })

  test('retries a failed planner twice and then parks', () => {
    const initialWorld = world({
      issued: [plannerIssue('planner-1'), plannerIssue('planner-2'), plannerIssue('planner-3')]
    })
    const firstFailure = attempt('planner-1', 1, 'dispatch-planner', {
      state: 'settled',
      effect: 'not-landed',
      evidenceKey: 'plan:1',
      reason: 'worker dispatch refused'
    })
    const secondFailure = attempt('planner-2', 2, 'dispatch-planner', {
      state: 'settled',
      effect: 'not-landed',
      evidenceKey: 'plan:2',
      reason: 'worker reported failure'
    })
    const thirdFailure = attempt('planner-3', 3, 'dispatch-planner', {
      state: 'settled',
      effect: 'not-landed',
      evidenceKey: 'plan:3',
      reason: 'worker stopped'
    })

    expect(nextStep(initialWorld, [firstFailure])).toEqual({
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        evidenceKey: 'plan:2',
        ordinal: 2,
        plannerMode: 'initial'
      }
    })
    expect(nextStep(initialWorld, [firstFailure, secondFailure])).toEqual({
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        evidenceKey: 'plan:3',
        ordinal: 3,
        plannerMode: 'initial'
      }
    })
    expect(decideObjective(snapshot(initialWorld), [firstFailure, secondFailure, thirdFailure])).toEqual({
      action: null,
      reason: 'planner-retry-exhausted'
    })
    expect(stopObjective(snapshot(initialWorld), [firstFailure, secondFailure, thirdFailure])).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'The planner failed 3 times without an accepted plan.',
      deviation: {
        kind: 'plan-failed',
        naturalKey: 'planner-retry-exhausted',
        detail: 'The planner failed 3 times without an accepted plan.'
      }
  })
  })

  test('dispatches approved tasks one at a time in plan order once their dependencies succeed', () => {
    const tasks = [
      { taskKey: 'a', deps: [] },
      { taskKey: 'b', deps: ['a'] },
      { taskKey: 'c', deps: [] }
    ]
    const planWorld = world({ revision: revision(tasks) })
    const firstAction = {
      kind: 'dispatch-node',
      capability: 'implement',
      visibility: 'local',
      evidenceKey: 'node:1:a:1',
      revision: 1,
      taskKey: 'a',
      ordinal: 1,
      repairEpisode: 0
    } as const
    expect(nextStep(planWorld, [])).toEqual({ action: firstAction })

    const runningA = [nodeAttempt('a-1', 1, 'a', 1, { state: 'running', dispatchId: 'dispatch-a' })]
    expect(nextStep(planWorld, runningA)).toEqual({ action: null, reason: 'node-in-flight' })
    expect(deriveProgress(planWorld, runningA).tasks[0]).toEqual({
      taskKey: 'a',
      state: 'in-flight',
      attempts: 1,
      successfulAttemptId: null,
      summary: null
    })

    const landedWithoutReport = [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })]
    expect(deriveProgress(planWorld, landedWithoutReport).tasks[0]).toEqual({
      taskKey: 'a',
      state: 'failed',
      attempts: 1,
      successfulAttemptId: null,
      summary: null
    })
    expect(nextStep(planWorld, landedWithoutReport)).toEqual({
      action: { ...firstAction, evidenceKey: 'node:1:a:2', ordinal: 2 }
    })

    const uncertainA = [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'indeterminate' })]
    expect(nextStep(planWorld, uncertainA)).toEqual({ action: null, reason: 'node-in-flight' })

    const successAWorld = world({
      revision: revision(tasks),
      issued: [taskIssue('a-1', 'a')],
      reports: [taskReport('a-1', 'a', 'Finished A.')]
    })
    const successA = [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })]
    expect(deriveProgress(successAWorld, successA).tasks[0]).toEqual({
      taskKey: 'a',
      state: 'succeeded',
      attempts: 1,
      successfulAttemptId: 'a-1',
      summary: 'Finished A.'
    })
    expect(nextStep(successAWorld, successA)).toEqual({
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        evidenceKey: 'node:1:b:1',
        revision: 1,
        taskKey: 'b',
        ordinal: 1,
        repairEpisode: 0
      }
    })

    const successBWorld = world({
      revision: revision(tasks),
      issued: [taskIssue('a-1', 'a'), taskIssue('b-1', 'b')],
      reports: [taskReport('a-1', 'a'), taskReport('b-1', 'b')]
    })
    const successAAndB = [
      nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' }),
      nodeAttempt('b-1', 2, 'b', 1, { state: 'settled', effect: 'landed' })
    ]
    expect(nextStep(successBWorld, successAAndB)).toEqual({
      action: {
        kind: 'dispatch-node',
        capability: 'implement',
        visibility: 'local',
        evidenceKey: 'node:1:c:1',
        revision: 1,
        taskKey: 'c',
        ordinal: 1,
        repairEpisode: 0
      }
    })

    const failedAWorld = world({
      revision: revision(tasks),
      issued: [taskIssue('a-1', 'a'), taskIssue('a-2', 'a'), taskIssue('a-3', 'a')]
    })
    const failedA = [
      nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'not-landed' }),
      nodeAttempt('a-2', 2, 'a', 2, { state: 'settled', effect: 'not-landed' }),
      nodeAttempt('a-3', 3, 'a', 3, { state: 'settled', effect: 'not-landed' })
    ]
    expect(deriveProgress(failedAWorld, failedA).tasks[0]).toEqual({
      taskKey: 'a',
      state: 'exhausted',
      attempts: 3,
      successfulAttemptId: null,
      summary: null
    })
    expect(nextStep(failedAWorld, failedA)).toEqual({
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        evidenceKey: 'plan-repair:1:1:1',
        revision: 1,
        ordinal: 1,
        plannerMode: 'repair',
        repairEpisode: 1
      }
    })

    const approvedPlanWithOffCapability = world({ planMode: 'off', revision: revision(tasks) })
    expect(nextStep(approvedPlanWithOffCapability, [])).toEqual({ action: firstAction })
  })

  test('advances succeeded tasks through shell checks, gates, express landing, and terminal stop', () => {
    const criteria = [{ body: 'tests pass', shellCheckable: true, checkCommand: 'pnpm test' }]
    const completeWorld = completedWorld('express', {
      contract: { ...contract, gates: [{ name: 'smoke', command: 'pnpm smoke', timeoutSeconds: 90 }] },
      revision: revision([{ taskKey: 'a', deps: [], criteria }])
    })
    const journal = completedJournal()
    expect(nextStep(completeWorld, journal)).toEqual({
      action: {
        kind: 'run-check',
        capability: 'check',
        visibility: 'local',
        evidenceKey: `check:1:a:0:${identity}`,
        revision: 1,
        taskKey: 'a',
        criterionIndex: 0,
        command: 'pnpm test',
        contentIdentity: identity
      }
    })

    const checkedWorld = world({
      ...completeWorld,
      checks: [checkRow('check-1', 'criterion', 'a:0', 'passed', { command: 'pnpm test' })]
    })
    expect(nextStep(checkedWorld, journal)).toEqual({
      action: {
        kind: 'run-gate',
        capability: 'check',
        visibility: 'local',
        evidenceKey: `gate:1:smoke:${identity}`,
        revision: 1,
        gateName: 'smoke',
        command: 'pnpm smoke',
        timeoutSeconds: 90,
        contentIdentity: identity
      }
    })

    const gatedWorld = world({
      ...checkedWorld,
      checks: [...checkedWorld.checks, checkRow('gate-1', 'gate', 'smoke', 'passed', { command: 'pnpm smoke' })]
    })
    const landing = {
      kind: 'record-landing',
      capability: 'land',
      visibility: 'local',
      recovery: 'replay-safe',
      evidenceKey: `files-on-disk:${identity}`,
      revision: 1,
      contentIdentity: identity
    } as const
    expect(nextStep(gatedWorld, journal)).toEqual({ action: landing })
    expect(nextStep(world({ ...gatedWorld, landings: [landingRow('files-on-disk')] }), journal)).toEqual({
      action: null,
      reason: 'objective-bar-reached'
    })
    expect(stopObjective(snapshot(gatedWorld, identity, 20), journal)).toBeNull()
    expect(stopObjective(snapshot(world({ ...gatedWorld, landings: [landingRow('files-on-disk')] }), identity, 20), journal)).toEqual({
      kind: 'terminal',
      state: 'landed',
      reason: 'files-on-disk landing bar reached'
    })

    const copiedSnapshot = snapshot(world({ ...completeWorld, contentIdentity: 'stale-tree', observedAtMs: 0 }), 'objective-tree:next', 55)
    expect(decideObjective(copiedSnapshot, journal).action?.contentIdentity).toBe('objective-tree:next')
  })

  test('breaks same-tick stale check loops cleanly and re-issues up to 3 stale retries across ticks', () => {
    const criteria = [{ body: 'tests pass', shellCheckable: true, checkCommand: 'pnpm test' }]
    const base = completedWorld('express', {
      observedAtMs: 10,
      revision: revision([{ taskKey: 'a', deps: [], criteria }])
    })
    const sameTickStale = checkRow('same-tick-stale', 'criterion', 'a:0', 'stale', {
      checkedAtMs: 11, command: 'pnpm test'
    })
    const staleSnapshotWorld = world({ ...base, checks: [sameTickStale] })
    expect(decideObjective(snapshot(staleSnapshotWorld, identity, 10), completedJournal()).reason).toBe('workspace-changed')

    const stale1 = checkRow('stale-1', 'criterion', 'a:0', 'stale', { checkedAtMs: 11, command: 'pnpm test' })
    const tick1 = world({ ...base, observedAtMs: 11, checks: [stale1] })
    expect(nextStep(tick1, completedJournal()).action).toMatchObject({
      kind: 'run-check', evidenceKey: `check:1:a:0:${identity}#stale-1`
    })

    const stale2 = checkRow('stale-2', 'criterion', 'a:0', 'stale', { checkedAtMs: 12, command: 'pnpm test' })
    const tick2 = world({ ...base, observedAtMs: 12, checks: [stale1, stale2] })
    expect(nextStep(tick2, completedJournal()).action).toMatchObject({
      kind: 'run-check', evidenceKey: `check:1:a:0:${identity}#stale-2`
    })

    const stale3 = checkRow('stale-3', 'criterion', 'a:0', 'stale', { checkedAtMs: 13, command: 'pnpm test' })
    const tick3 = world({ ...base, observedAtMs: 13, checks: [stale1, stale2, stale3] })
    expect(nextStep(tick3, completedJournal()).action).toMatchObject({
      kind: 'run-check', evidenceKey: `check:1:a:0:${identity}#stale-3`
    })
    const stale4 = checkRow('stale-4', 'criterion', 'a:0', 'stale', { checkedAtMs: 14, command: 'pnpm test' })
    const exhausted = world({ ...base, observedAtMs: 14, checks: [stale1, stale2, stale3, stale4] })
    expect(nextStep(exhausted, completedJournal()).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
    })
  })

  test('sequences reviewer for standard tier and reviewer then integrator for full tier', () => {
    const standard = completedWorld('standard')
    const standardJournal = completedJournal()
    const reviewer = nextStep(standard, standardJournal).action
    expect(reviewer).toMatchObject({
      kind: 'dispatch-reviewer', revision: 1, contentIdentity: identity, ordinal: 1
    })
    const reviewerDispatch = reviewAttempt('review-1', 2, 'reviewer')
    const reviewerApproved = world({
      ...standard,
      issued: [...standard.issued, reviewIssue('review-1', 'reviewer')],
      verdicts: [verdictRow('review-1', 'reviewer', 'approve')]
    })
    expect(nextStep(reviewerApproved, [...standardJournal, reviewerDispatch])).toMatchObject({
      action: { kind: 'record-landing' }
    })
    expect(nextStep(world({
      ...reviewerApproved,
      verdicts: [verdictRow('review-1', 'reviewer', 'approve')]
    }), standardJournal)).toMatchObject({
      action: { kind: 'dispatch-reviewer' }
    })
    expect(nextStep(standard, [...standardJournal, reviewAttempt('review-running', 2, 'reviewer', { state: 'running' })])).toEqual({
      action: null,
      reason: 'reviewer-in-flight'
    })

    const criteria = [{ body: 'tests pass', shellCheckable: true, checkCommand: 'pnpm test' }]
    const full = completedWorld('full', {
      revision: revision([{ taskKey: 'a', deps: [], criteria }]),
      checks: [checkRow('check-1', 'criterion', 'a:0', 'passed', { command: 'pnpm test' })]
    })
    const fullJournal = completedJournal()
    expect(nextStep(full, fullJournal).action).toMatchObject({ kind: 'dispatch-reviewer' })
    const firstReviewer = reviewAttempt('full-review-1', 2, 'reviewer')
    const approvedFull = world({
      ...full,
      issued: [...full.issued, reviewIssue('full-review-1', 'reviewer')],
      verdicts: [verdictRow('full-review-1', 'reviewer', 'approve')]
    })
    const afterReviewer = nextStep(approvedFull, [...fullJournal, firstReviewer])
    expect(afterReviewer.action).toMatchObject({ kind: 'dispatch-integrator' })

    const integratorDispatch = reviewAttempt('integrate-1', 3, 'integrator')
    const integratorEdits = 'objective-tree:def'
    const afterEdit = world({
      ...approvedFull,
      contentIdentity: integratorEdits,
      issued: [...approvedFull.issued, reviewIssue('integrate-1', 'integrator')],
      verdicts: [...approvedFull.verdicts, verdictRow('integrate-1', 'integrator', 'approve', integratorEdits)]
    })
    const afterIntegratorEditJournal = [...fullJournal, firstReviewer, integratorDispatch]
    expect(nextStep(afterEdit, afterIntegratorEditJournal)).toMatchObject({
      action: { kind: 'run-check', contentIdentity: integratorEdits }
    })
    const rechecked = world({
      ...afterEdit,
      checks: [...afterEdit.checks, checkRow('check-2', 'criterion', 'a:0', 'passed', {
        contentIdentity: integratorEdits, command: 'pnpm test'
      })]
    })
    expect(nextStep(rechecked, afterIntegratorEditJournal).action).toMatchObject({
      kind: 'dispatch-reviewer', contentIdentity: integratorEdits
    })

    const secondReviewer = reviewAttempt('full-review-2', 4, 'reviewer', { contentIdentity: integratorEdits })
    const reviewerAtEditedIdentity = world({
      ...rechecked,
      issued: [...rechecked.issued, reviewIssue('full-review-2', 'reviewer', integratorEdits)],
      verdicts: [...rechecked.verdicts, verdictRow('full-review-2', 'reviewer', 'approve', integratorEdits)]
    })
    expect(nextStep(reviewerAtEditedIdentity, [...afterIntegratorEditJournal, secondReviewer]).action).toMatchObject({
      kind: 'dispatch-integrator', contentIdentity: integratorEdits
    })
  })

  test('triggers repair replanning on failed checks, exhausted tasks, or reviewer blocks up to 3 episodes', () => {
    const criteria = [{ body: 'tests pass', shellCheckable: true, checkCommand: 'pnpm test' }]
    const verifiedWorld = completedWorld('express', {
      revision: revision([{ taskKey: 'a', deps: [], criteria }]),
      checks: [checkRow('check-failed', 'criterion', 'a:0', 'failed', { command: 'pnpm test' })]
    })
    expect(nextStep(verifiedWorld, completedJournal()).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1, ordinal: 1
    })

    const failedWorld = world({
      revision: revision([{ taskKey: 'a', deps: [] }]),
      issued: [taskIssue('a-1', 'a'), taskIssue('a-2', 'a'), taskIssue('a-3', 'a')]
    })
    const failedJournal = [
      nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'not-landed' }),
      nodeAttempt('a-2', 2, 'a', 2, { state: 'settled', effect: 'not-landed' }),
      nodeAttempt('a-3', 3, 'a', 3, { state: 'settled', effect: 'not-landed' })
    ]
    expect(nextStep(failedWorld, failedJournal).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
    })

    const overrun = {
      attemptId: 'outside-1',
      watcherId: 'watcher',
      revision: 1,
      taskKey: 'a',
      observedPaths: ['outside.txt'],
      outsidePaths: ['outside.txt'],
      unreportedPaths: [],
      code: 'observed-change-outside-write-territory',
      recordedAtMs: 1
    }
    const overrunWorld = world({
      revision: revision([{ taskKey: 'a', deps: [] }]),
      overruns: [overrun]
    })
    expect(nextStep(overrunWorld, [nodeAttempt('outside-1', 1, 'a', 1, {
      state: 'running', dispatchId: 'dispatch-outside'
    })])).toEqual({ action: null, reason: 'node-in-flight' })
    expect(nextStep(overrunWorld, [nodeAttempt('outside-1', 1, 'a', 1, {
      state: 'settled', effect: 'not-landed'
    })]).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
    })
    const unreportedButCorrected = world({
      revision: revision([{ taskKey: 'a', deps: [] }]),
      issued: [taskIssue('corrected-1', 'a')],
      reports: [taskReport('corrected-1', 'a')],
      overruns: [{
        ...overrun,
        attemptId: 'corrected-1',
        code: 'unreported-observed-change'
      }]
    })
    expect(nextStep(unreportedButCorrected, [
      nodeAttempt('corrected-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })
    ]).action).toMatchObject({ kind: 'record-landing' })
    const standard = completedWorld('standard', {
      issued: [...completedWorld('standard').issued, reviewIssue('blocked-review', 'reviewer')],
      verdicts: [verdictRow('blocked-review', 'reviewer', 'block')]
    })
    expect(nextStep(standard, [
      ...completedJournal(),
      reviewAttempt('blocked-review', 2, 'reviewer')
    ]).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
    })
    const repairDraftAttempt = attempt('repair-draft', 2, 'dispatch-planner', {
      state: 'settled',
      effect: 'landed',
      revision: 1,
      ordinal: 1,
      plannerMode: 'repair',
      repairEpisode: 1,
      evidenceKey: 'plan-repair:1:1:1'
    })
    const repairDraftWorld = world({
      ...verifiedWorld,
      issued: [...verifiedWorld.issued, plannerIssue('repair-draft', { revision: 1, plannerMode: 'repair' })],
      reports: [...verifiedWorld.reports, plannerReport('repair-draft', 'repair-digest')]
    })
    expect(deriveProgress(repairDraftWorld, [...completedJournal(), repairDraftAttempt]).draft).toEqual({
      plannerAttemptId: 'repair-draft',
      digest: 'repair-digest',
      kind: 'repair',
      repairEpisode: 1
    })
    expect(nextStep(repairDraftWorld, [...completedJournal(), repairDraftAttempt]).action).toMatchObject({
      kind: 'apply-plan-repair',
      revision: 1,
      repairEpisode: 1,
      plannerAttemptId: 'repair-draft',
      digest: 'repair-digest'
    })
    const rejectedRepairDraft = world({
      ...repairDraftWorld,
      rejectedDrafts: [rejectedDraft('repair-draft', 'repair-digest')]
    })
    expect(deriveProgress(rejectedRepairDraft, [...completedJournal(), repairDraftAttempt]).draft).toBeNull()
    expect(nextStep(rejectedRepairDraft, [...completedJournal(), repairDraftAttempt]).action).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1, ordinal: 2
    })

    const rejectedRepairIds = ['repair-reject-1', 'repair-reject-2', 'repair-reject-3']
    const rejectedRepairStage = world({
      ...verifiedWorld,
      issued: [
        ...verifiedWorld.issued,
        ...rejectedRepairIds.map((attemptId) =>
          plannerIssue(attemptId, { revision: 1, plannerMode: 'repair' })
        )
      ],
      rejectedDrafts: rejectedRepairIds.map((attemptId) => rejectedDraft(attemptId, attemptId))
    })
    const rejectedRepairJournal = rejectedRepairIds.map((attemptId, index) =>
      repairIssue(attemptId, 1, index + 1)
    )
    expect(nextStep(rejectedRepairStage, [...completedJournal(), ...rejectedRepairJournal])).toEqual({
      action: null,
      reason: 'draft-rejections-exhausted'
    })

    const repairAttempts = [
      repairIssue('repair-1', 1, 1),
      repairIssue('repair-2', 1, 2)
    ]
    const thirdRepairAttempt = nextStep(world({
      ...verifiedWorld,
      repairs: [],
      issued: [...verifiedWorld.issued, plannerIssue('repair-1', { revision: 1, plannerMode: 'repair' }), plannerIssue('repair-2', { revision: 1, plannerMode: 'repair' })]
    }), [...completedJournal(), ...repairAttempts]).action
    expect(thirdRepairAttempt).toMatchObject({
      kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1, ordinal: 3, approvalRequired: true
    })

    const exhaustedEpisodes = world({
      ...verifiedWorld,
      observedAtMs: 10,
      checks: [checkRow('post-repair-failed', 'criterion', 'a:0', 'failed', {
        checkedAtMs: 10, command: 'pnpm test'
      })],
      repairs: [repairRecord(1, ['new-a']), repairRecord(2, ['new-b']), repairRecord(3, ['new-c'])]
    })
    expect(nextStep(exhaustedEpisodes, completedJournal())).toEqual({
      action: null,
      reason: 'repair-episodes-exhausted'
    })
    expect(stopObjective(snapshot(exhaustedEpisodes), completedJournal())).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'Repair limit of 3 episodes reached for revision 1.',
      deviation: {
        kind: 'retry-exhausted',
        naturalKey: 'repair-episodes-exhausted:1',
        detail: 'Repair limit of 3 episodes reached for revision 1.'
      }
    })

    const touchedTask = world({
      revision: revision([{ taskKey: 'a', deps: [] }]),
      reports: [taskReport('old-a', 'a')],
      issued: [taskIssue('old-a', 'a')],
      repairs: [repairRecord(1, ['a'])]
    })
    const afterRepairFailure = nodeAttempt('new-a-1', 4, 'a', 1, {
      state: 'settled', effect: 'not-landed', repairEpisode: 1
    })
    expect(deriveProgress(touchedTask, [...failedJournal, afterRepairFailure]).tasks[0]).toMatchObject({
      state: 'failed', attempts: 1
    })
    expect(nextStep(touchedTask, [...failedJournal, afterRepairFailure]).action).toMatchObject({
      kind: 'dispatch-node', taskKey: 'a', ordinal: 2, repairEpisode: 1,
      evidenceKey: 'node:1:a:r1:2'
    })
    const recheckedPlan = world({
      revision: revision([
        { taskKey: 'a', deps: [], criteria },
        { taskKey: 'repair-a', deps: [] }
      ]),
      issued: [taskIssue('a-1', 'a'), taskIssue('repair-task', 'repair-a')],
      reports: [taskReport('a-1', 'a'), taskReport('repair-task', 'repair-a')],
      checks: [checkRow('pre-repair-check', 'criterion', 'a:0', 'failed', {
        checkedAtMs: 1, command: 'pnpm test'
      })],
      overruns: [{
        attemptId: 'pre-repair-overrun',
        watcherId: 'watcher',
        revision: 1,
        taskKey: 'a',
        observedPaths: ['outside.txt'],
        outsidePaths: ['outside.txt'],
        unreportedPaths: [],
        code: 'observed-change-outside-write-territory',
        recordedAtMs: 1
      }],
      repairs: [{ ...repairRecord(1, ['repair-a']), appliedAtMs: 10 }],
      observedAtMs: 20
    })
    const recheckedJournal = [
      nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' }),
      nodeAttempt('pre-repair-overrun', 2, 'a', 2, { state: 'settled', effect: 'not-landed' }),
      nodeAttempt('repair-task', 3, 'repair-a', 1, {
        state: 'settled', effect: 'landed', repairEpisode: 1
      })
    ]
    expect(nextStep(recheckedPlan, recheckedJournal).action).toMatchObject({
      kind: 'run-check',
      taskKey: 'a',
      evidenceKey: `check:1:a:0:${identity}:r1`
    })
  })

  test('ignores rejected drafts, holds committed-local-branch on detached HEAD, and parks when capabilities are off', () => {
    const rejectedFirst = world({
      issued: [plannerIssue('draft-1'), plannerIssue('draft-2')],
      reports: [plannerReport('draft-1')],
      rejectedDrafts: [rejectedDraft('draft-1', 'plan-digest')]
    })
    const rejectedJournal = [
      attempt('draft-1', 1, 'dispatch-planner', {
        state: 'settled', effect: 'landed', plannerMode: 'initial', ordinal: 1
      })
    ]
    expect(deriveProgress(rejectedFirst, rejectedJournal).draft).toBeNull()
    expect(nextStep(rejectedFirst, rejectedJournal)).toMatchObject({
      action: { kind: 'dispatch-planner', plannerMode: 'initial', ordinal: 2 }
    })

    const rejectedThree = world({
      issued: [plannerIssue('draft-1'), plannerIssue('draft-2'), plannerIssue('draft-3')],
      rejectedDrafts: [
        rejectedDraft('draft-1', 'd1'),
        rejectedDraft('draft-2', 'd2'),
        rejectedDraft('draft-3', 'd3')
      ]
    })
    const rejectionJournal = [1, 2, 3].map((ordinal) => attempt(`draft-${ordinal}`, ordinal, 'dispatch-planner', {
      state: 'settled', effect: 'landed', plannerMode: 'initial', ordinal
    }))
    expect(nextStep(rejectedThree, rejectionJournal)).toEqual({
      action: null,
      reason: 'draft-rejections-exhausted'
    })
    expect(stopObjective(snapshot(rejectedThree), rejectionJournal)).toMatchObject({
      kind: 'park', deviation: { kind: 'plan-failed', naturalKey: 'draft-rejections-exhausted:initial' }
    })

    const detached = completedWorld('express', {
      contract: { ...contract, landingBar: 'committed-local-branch' },
      landings: [landingRow('files-on-disk')],
      git: { branch: null, headSha: 'head-1' }
    })
    expect(nextStep(detached, completedJournal())).toEqual({ action: null, reason: 'branch-not-attached' })
    expect(paceObjective(snapshot(detached), completedJournal())).toBe('idle')
    const attached = completedWorld('express', {
      contract: { ...contract, landingBar: 'committed-local-branch' },
      landings: [landingRow('files-on-disk')],
      git: { branch: 'main', headSha: 'head-1' }
    })
    expect(nextStep(attached, completedJournal())).toEqual({
      action: {
        kind: 'commit-local-branch',
        capability: 'land',
        visibility: 'local',
        recovery: 'replay-safe',
        evidenceKey: `committed-local-branch:${identity}:main:head-1`,
        revision: 1,
        contentIdentity: identity,
        branch: 'main',
        headSha: 'head-1'
      }
    })
    const failedCommits = [1, 2, 3].map((ordinal) => attempt(`commit-${ordinal}`, ordinal, 'commit-local-branch', {
      state: 'settled',
      effect: 'not-landed',
      revision: 1,
      contentIdentity: identity,
      evidenceKey: `committed-local-branch:${identity}:main:head-1`,
      branch: 'main',
      headSha: 'head-1'
    }))
    expect(nextStep(attached, [...completedJournal(), ...failedCommits])).toEqual({
      action: null,
      reason: 'landing-retry-exhausted'
    })
    expect(stopObjective(snapshot(attached), [...completedJournal(), ...failedCommits])).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'Local branch commit failed 3 times for the current workspace state.',
      deviation: {
        kind: 'landing-failed',
        naturalKey: `landing-retry-exhausted:${identity}`,
        detail: 'Local branch commit failed 3 times for the current workspace state.'
      }
    })
    const committed = world({
      ...attached,
      landings: [...attached.landings, landingRow('committed-local-branch')]
    })
    expect(stopObjective(snapshot(committed), completedJournal())).toEqual({
      kind: 'terminal',
      state: 'landed',
      reason: 'committed-local-branch landing bar reached'
    })

    const checkOff = completedWorld('express', {
      revision: revision([{ taskKey: 'a', deps: [], criteria: [{
        body: 'tests pass', shellCheckable: true, checkCommand: 'pnpm test'
      }] }]),
      capabilities: { plan: 'gated', implement: 'on', check: 'off', review: 'on', land: 'on' }
    })
    expect(nextStep(checkOff, completedJournal())).toEqual({ action: null, reason: 'check-capability-off' })
    expect(stopObjective(snapshot(checkOff), completedJournal())).toMatchObject({
      kind: 'park', deviation: { kind: 'gate-held', naturalKey: 'check-capability-off' }
    })

    const reviewOff = completedWorld('standard', {
      capabilities: { plan: 'gated', implement: 'on', check: 'on', review: 'off', land: 'on' }
    })
    expect(nextStep(reviewOff, completedJournal())).toEqual({ action: null, reason: 'review-capability-off' })
    expect(stopObjective(snapshot(reviewOff), completedJournal())).toMatchObject({
      kind: 'park', deviation: { kind: 'gate-held', naturalKey: 'review-capability-off' }
    })

    const landOff = completedWorld('express', {
      capabilities: { plan: 'gated', implement: 'on', check: 'on', review: 'on', land: 'off' }
    })
    expect(nextStep(landOff, completedJournal())).toEqual({ action: null, reason: 'land-capability-off' })
    expect(stopObjective(snapshot(landOff), completedJournal())).toMatchObject({
      kind: 'park', deviation: { kind: 'gate-held', naturalKey: 'land-capability-off' }
    })
  })

  test('paces active while work is out, idle while an approval waits or nothing can act, and rapid only when the next tick acts', () => {
    expect(paceObjective(snapshot(world()), [attempt('planner-1', 1, 'dispatch-planner', {
      state: 'running',
      dispatchId: 'dispatch-1',
      evidenceKey: 'plan:1'
    })])).toBe('active')

    const approvedTaskWorld = world({ revision: revision([{ taskKey: 'a', deps: [] }]) })
    expect(paceObjective(snapshot(approvedTaskWorld), [nodeAttempt('a-1', 1, 'a', 1, {
      state: 'settled',
      effect: 'indeterminate'
    })])).toBe('active')

    expect(paceObjective(snapshot(world()), [escalation(1, 'planner-approval', 'open')])).toBe('idle')
    const activationWorld = world({
      issued: [plannerIssue('planner-1')],
      reports: [plannerReport('planner-1')]
    })
    const activationAttempt = [attempt('planner-1', 1, 'dispatch-planner', {
      state: 'settled',
      effect: 'landed',
      evidenceKey: 'plan:1'
    })]
    expect(paceObjective(snapshot(activationWorld), [
      escalation(2, 'activation-approval', 'open', 'activate-plan', 'activate-plan:planner-1')
    ])).toBe('idle')

    expect(paceObjective(snapshot(world()), [])).toBe('rapid')
    expect(paceObjective(snapshot(world({ planMode: 'off' })), [])).toBe('idle')
    expect(paceObjective(snapshot(world({
      revision: revision([{ taskKey: 'a', deps: [] }]),
      issued: [taskIssue('a-1', 'a')],
      reports: [taskReport('a-1', 'a')]
    })), [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })])).toBe('rapid')
    expect(paceObjective(snapshot(world()), [
      escalation(1, 'closed-approval', 'open'),
      escalation(2, 'closed-approval', 'acknowledged')
    ])).toBe('rapid')
    expect(paceObjective(snapshot(activationWorld), activationAttempt)).toBe('rapid')
  })

  test('parks when plan is off and no plan was approved', () => {
    const offSnapshot = snapshot(world({ planMode: 'off' }))

    expect(decideObjective(offSnapshot, [])).toEqual({
      action: null,
      reason: 'plan-off-without-usable-plan'
    })
    expect(stopObjective(offSnapshot, [])).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'Plan is off and this watcher has no approved plan. Enroll it again with --cap plan=gated or --cap plan=on.',
      deviation: {
        kind: 'gate-held',
        naturalKey: 'plan-capability-off',
        detail: 'Plan is off and this watcher has no approved plan. Enroll it again with --cap plan=gated or --cap plan=on.'
      }
    })
  })
})
