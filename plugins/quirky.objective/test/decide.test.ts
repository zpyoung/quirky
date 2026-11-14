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
type AttemptKind = 'dispatch-planner' | 'activate-plan' | 'dispatch-node'
type AttemptState = 'attempted' | 'running' | 'settled'
type AttemptEffect = 'landed' | 'not-landed' | 'indeterminate'

function world(overrides: Partial<ObjectiveWorld> = {}): ObjectiveWorld {
  return {
    planMode: 'gated',
    revision: null,
    reports: [],
    issued: [],
    ...overrides
  }
}

function snapshot(value: ObjectiveWorld, contentIdentity = 'objective-tree:abc') {
  return { freshness: 'live' as const, contentIdentity, observedAtMs: 1, world: value }
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
  } = {}
): JournalRow {
  return {
    seq,
    kind: 'attempt',
    attemptId,
    action: {
      kind,
      capability: kind === 'dispatch-node' ? 'implement' : 'plan',
      visibility: 'local',
      ...(options.evidenceKey === undefined ? {} : { evidenceKey: options.evidenceKey }),
      ...(options.revision === undefined ? {} : { revision: options.revision }),
      ...(options.taskKey === undefined ? {} : { taskKey: options.taskKey }),
      ...(options.ordinal === undefined ? {} : { ordinal: options.ordinal })
    },
    state: options.state ?? 'running',
    ...(options.effect === undefined ? {} : { effect: options.effect }),
    ...(options.dispatchId === undefined ? {} : { dispatchId: options.dispatchId }),
    ...(options.reason === undefined ? {} : { reason: options.reason })
  }
}

function plannerIssue(attemptId: string) {
  return { attemptId, role: 'planner' as const, revision: null, taskKey: null }
}

function plannerReport(attemptId: string, digest = 'plan-digest') {
  return { attemptId, role: 'planner' as const, taskKey: null, digest }
}

function revision(tasks: { taskKey: string; deps: string[]; criteriaCount?: number }[], number = 1) {
  return {
    number,
    digest: `revision-${number}`,
    tasks: tasks.map(({ taskKey, deps, criteriaCount = 1 }) => ({ taskKey, deps, criteriaCount }))
  }
}

function taskIssue(attemptId: string, taskKey: string, revisionNumber = 1) {
  return { attemptId, role: 'implementer' as const, revision: revisionNumber, taskKey }
}

function taskReport(attemptId: string, taskKey: string, summary = `Finished ${taskKey}.`) {
  return { attemptId, role: 'implementer' as const, taskKey, digest: `report-${attemptId}`, summary }
}

function nodeAttempt(
  attemptId: string,
  seq: number,
  taskKey: string,
  ordinal: number,
  options: Parameters<typeof attempt>[3] = {}
) {
  return attempt(attemptId, seq, 'dispatch-node', {
    revision: 1,
    taskKey,
    ordinal,
    evidenceKey: `node:1:${taskKey}:${ordinal}`,
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
      contentIdentity: 'objective-tree:abc',
      evidenceKey
    }
  }
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
      ordinal: 1
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
      digest: 'plan-digest'
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
        ordinal: 2
      }
    })
    expect(nextStep(initialWorld, [firstFailure, secondFailure])).toEqual({
      action: {
        kind: 'dispatch-planner',
        capability: 'plan',
        visibility: 'local',
        evidenceKey: 'plan:3',
        ordinal: 3
      }
    })
    expect(decideObjective(snapshot(initialWorld), [firstFailure, secondFailure, thirdFailure])).toEqual({
      action: null,
      reason: 'planner-retry-exhausted'
    })
    expect(stopObjective(snapshot(initialWorld), [firstFailure, secondFailure, thirdFailure])).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'The planner failed 3 times without an accepted plan.'
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
      ordinal: 1
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
        ordinal: 1
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
        ordinal: 1
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
    expect(nextStep(failedAWorld, failedA)).toEqual({ action: null, reason: 'node-retry-exhausted' })
    expect(stopObjective(snapshot(failedAWorld), failedA)).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'Task a failed 3 times.'
    })

    const approvedPlanWithOffCapability = world({ planMode: 'off', revision: revision(tasks) })
    expect(nextStep(approvedPlanWithOffCapability, [])).toEqual({ action: firstAction })
  })

  test('parks with verification-unavailable once every task succeeded', () => {
    const tasks = [
      { taskKey: 'a', deps: [] },
      { taskKey: 'b', deps: ['a'] },
      { taskKey: 'c', deps: [] }
    ]
    const completeWorld = world({
      revision: revision(tasks),
      issued: [taskIssue('a-1', 'a'), taskIssue('b-1', 'b'), taskIssue('c-1', 'c')],
      reports: [taskReport('a-1', 'a'), taskReport('b-1', 'b'), taskReport('c-1', 'c')]
    })
    const completeJournal = [
      nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' }),
      nodeAttempt('b-1', 2, 'b', 1, { state: 'settled', effect: 'landed' }),
      nodeAttempt('c-1', 3, 'c', 1, { state: 'settled', effect: 'landed' })
    ]

    expect(nextStep(completeWorld, completeJournal)).toEqual({ action: null, reason: 'verification-unavailable' })
    expect(stopObjective(snapshot(completeWorld), completeJournal)).toEqual({
      kind: 'park',
      reason: 'stop-predicate',
      detail: 'All 3 plan tasks succeeded. Acceptance checks, review and landing are not available in this Quirky version.'
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
    })), [nodeAttempt('a-1', 1, 'a', 1, { state: 'settled', effect: 'landed' })])).toBe('idle')
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
      detail: 'Plan is off and this watcher has no approved plan. Enroll it again with --cap plan=gated or --cap plan=on.'
    })
  })
})
