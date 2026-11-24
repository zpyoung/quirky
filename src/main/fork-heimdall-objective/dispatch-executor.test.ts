import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OWNER_INTERVENTION_TEXT_MAX_LENGTH } from '../../shared/fork-heimdall/owner/intervention'
import { OBJECTIVE_TASK_SPEC_MAX_LENGTH } from '../../shared/fork-heimdall-objective/contract-types'
import type { DispatchResult, ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { WatcherLedger } from '../../shared/fork-heimdall/ledger-types'
import {
  node,
  projection,
  snapshot
} from '../../shared/fork-heimdall-objective/decision-test-harness'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import { ObjectivePlanTaskSchema } from '../../shared/fork-heimdall-objective/plan-schema'
import type { Store } from '../persistence'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import { deriveObjectiveFailureContext } from './dispatch-failure-context'
import { executeObjectiveDispatch } from './dispatch-executor'
import type { ObjectiveSnapshotBinding } from './execution-context'
import type { ObjectiveStore } from './objective-store'
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: QuirkyRuntimeService is a class with private fields; executeObjectiveDispatch never calls it in these tests.
const runtime = {} as QuirkyRuntimeService
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Store is a class with private fields; executeObjectiveDispatch never calls it in these tests.
const store = {} as Store

const {
  issueReportPath,
  captureBaseline,
  resolveAgent,
  readRoleReport,
  buildRolePrompt,
  preparePlanReviewDispatchSpec
} = vi.hoisted(() => ({
  issueReportPath: vi.fn(),
  captureBaseline: vi.fn(),
  resolveAgent: vi.fn(),
  readRoleReport: vi.fn(),
  buildRolePrompt: vi.fn(),
  preparePlanReviewDispatchSpec: vi.fn()
}))
vi.mock('./report-ingestion', () => ({
  issueObjectiveReportPath: issueReportPath,
  readObjectiveRoleReport: readRoleReport
}))
vi.mock('./observed-workspace-changes', () => ({
  captureObjectiveWorkspaceBaseline: captureBaseline
}))
vi.mock('./role-prompts', () => ({
  buildObjectiveRolePrompt: buildRolePrompt,
  resolveObjectiveRoleAgent: resolveAgent
}))
vi.mock('./plan-review-input', () => ({
  preparePlanReviewDispatchSpec,
  planReviewRoutingScope: (target: { kind: string; revisionId?: string; patchId?: string }) =>
    target.kind === 'revision' ? target.revisionId : target.patchId
}))

const binding: ObjectiveSnapshotBinding = {
  enrollment: {
    watcherId: 'watcher-1',
    kind: 'objective',
    workspaceKey: 'local::/workspace',
    executionHostId: 'local',
    repoId: 'repo-1',
    worktreeId: null,
    workspacePath: '/workspace',
    schedulerOwner: 'local_host_service',
    capabilities: { plan: 'on', implement: 'on', review: 'on', check: 'on', land: 'on' },
    budget: { wallClockActiveMs: 60_000, turns: 10 },
    kindPayload: {},
    enabled: true,
    paused: false,
    commandRevision: 0,
    coordinatorIdentity: { handle: 'watcher-1', paneKey: 'pane-1' },
    orchestrationRunId: null,
    createdAtMs: 1,
    terminalAtMs: null
  },
  contract: {
    objectiveText: 'Implement the objective.',
    tier: 'standard',
    landingBar: 'files-on-disk',
    maxConcurrency: 1,
    workspaceKind: 'folder',
    writeTerritory: ['src/**'],
    roleAgents: {},
    sitterOverrides: {}
  },
  target: {
    kind: 'folder',
    executionHostId: 'local',
    workspacePath: '/workspace'
  }
}

const dispatchNode: ObjectiveAction = {
  kind: 'dispatch-node',
  capability: 'implement',
  visibility: 'local',
  contentIdentity: 'content-current',
  evidenceKey: 'revision-1:node-a',
  revisionId: 'revision-1',
  taskKey: 'node-a',
  depsOrchestrationIds: []
}

const retryDispatchNode: ObjectiveAction = {
  ...dispatchNode,
  evidenceKey: 'revision-1:node-a:r0',
  retryOf: 'revision-1:node-a'
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
const objectiveStore = {
  getPlan: () => [
    {
      taskKey: 'node-a',
      title: 'Node A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false,
      declaredPaths: ['src/a.ts']
    }
  ],
  getTask: () => ({
    taskKey: 'node-a',
    title: 'Node A',
    spec: 'Implement A',
    deps: [],
    criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
    declaresDependencyChange: false,
    declaredPaths: ['src/a.ts']
  }),
  clearParallelNoteWithPrefix: vi.fn()
} as unknown as ObjectiveStore

function context(
  ledger: WatcherLedger,
  dispatchResult: DispatchResult
): ExecuteContext<ObjectiveWorld> {
  return {
    snapshot: snapshot(projection({ revisions: [], nodes: [] })),
    lease: {
      epoch: 1,
      holder: 'test',
      assertHeld: vi.fn(async () => undefined),
      renewLoop: () => ({ dispose: () => undefined })
    },
    ledger,
    dispatchWorker: vi.fn(async () => dispatchResult)
  }
}

describe('executeObjectiveDispatch', () => {
  beforeEach(() => {
    issueReportPath.mockReset()
    captureBaseline.mockReset()
    resolveAgent.mockReset()
    readRoleReport.mockReset()
    buildRolePrompt.mockReset()
    issueReportPath.mockResolvedValue('/workspace/report.json')
    resolveAgent.mockReturnValue('claude')
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
    buildRolePrompt.mockReturnValue('implement the task')
  })

  it('dispatches a node and returns landed with the issued report path', async () => {
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'landed',
      result: { dispatchId: 'dispatch-1', reportPath: '/workspace/report.json' }
    })
  })

  it('passes model and effort to dispatchWorker when set for the dispatched role', async () => {
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding: {
        ...binding,
        contract: {
          ...binding.contract,
          roleLaunch: { implementer: { model: 'opus', effort: 'high' } }
        }
      },
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })
    expect(executeContext.dispatchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'opus', effort: 'high' })
    )
  })

  it('omits model and effort from dispatchWorker when unset for the role', async () => {
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })
    const call = vi.mocked(executeContext.dispatchWorker).mock.calls[0][0]
    expect(call).not.toHaveProperty('model')
    expect(call).not.toHaveProperty('effort')
  })

  it('tags a pre-dispatch failure as infra', async () => {
    resolveAgent.mockImplementation(() => {
      throw new Error('no agent configured')
    })
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'no agent configured'
    })
    expect(captureBaseline).not.toHaveBeenCalled()
  })

  it('tags a refused dispatch as infra', async () => {
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'refused', reason: 'fenced', detail: 'lease unavailable' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: 'fenced',
      result: { detail: 'lease unavailable' }
    })
  })

  it('classifies a Zod validation failure as criteria, not infra, since it will not clear on retry', async () => {
    const zodError = ObjectivePlanTaskSchema.safeParse({}).error
    issueReportPath.mockRejectedValue(zodError)
    const outcome = await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toMatchObject({ effect: 'not-landed', failureClass: 'criteria' })
  })

  it('refuses an owner-amended spec that exceeds the dispatch snapshot cap as criteria, not infra', async () => {
    const oversizedAction: ObjectiveAction = {
      ...dispatchNode,
      ownerAmendedSpec: 'x'.repeat(OBJECTIVE_TASK_SPEC_MAX_LENGTH)
    }
    const outcome = await executeObjectiveDispatch({
      action: oversizedAction,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toMatchObject({ effect: 'not-landed', failureClass: 'criteria' })
    expect(captureBaseline).not.toHaveBeenCalled()
  })

  it('refuses a retry as infra when its original dispatch is missing from the ledger', async () => {
    const outcome = await executeObjectiveDispatch({
      action: retryDispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })
    expect(outcome).toEqual({
      effect: 'not-landed',
      failureClass: 'infra',
      reason: "Objective retry's original dispatch is missing from the ledger: revision-1:node-a"
    })
    expect(captureBaseline).not.toHaveBeenCalled()
  })

  it('forwards a requested skip stage separately from the full owner rationale', async () => {
    const rationale = 'r'.repeat(OWNER_INTERVENTION_TEXT_MAX_LENGTH)
    const plannerAction: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:1:owner-directed:content-current',
      revisionNumber: 1,
      reason: 'owner-directed',
      requestedSkipStage: 'hosted-review',
      guidance: rationale
    }
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }))

    await executeObjectiveDispatch({
      action: plannerAction,
      binding,
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'planner',
        requestedSkipStage: 'hosted-review',
        ownerGuidance: rationale
      })
    )
  })

  it("carries the latest revise review's findings into a redispatched planner's prompt", async () => {
    const plannerRedispatch: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:3',
      revisionNumber: 3,
      reason: 'replan-after-block',
      plannerMode: 'full'
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods above are exercised.
    const reviewingStore = {
      ...objectiveStore,
      getPlanReviewReport: vi.fn().mockReturnValue({
        verdict: 'revise',
        assumptions: [
          { index: 0, status: 'unverified', evidence: 'could not verify the migration' }
        ],
        findings: [
          { taskKey: 'node-a', severity: 'blocking', body: 'ordering is wrong' },
          { taskKey: null, severity: 'advisory', body: 'minor nit' }
        ],
        summary: 'Needs task ordering fixed.'
      })
    } as unknown as ObjectiveStore
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(
      projection({
        revisions: [],
        nodes: [],
        planReviews: [
          {
            id: 'plan-review-1',
            targetKind: 'revision',
            targetId: 'revision-2',
            round: 1,
            dispatchId: 'review-dispatch-1',
            verdict: 'revise',
            reportDigest: 'review-digest-1',
            createdAtMs: 10
          }
        ]
      })
    )

    await executeObjectiveDispatch({
      action: plannerRedispatch,
      binding,
      context: executeContext,
      objectiveStore: reviewingStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        planReviewFindings:
          'Needs task ordering fixed.\nnode-a: ordering is wrong\nassumption[0]: could not verify the migration'
      })
    )
  })

  it('omits planReviewFindings when the latest review in the lineage approved', async () => {
    const plannerRedispatch: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:1',
      revisionNumber: 1,
      reason: 'initial',
      plannerMode: 'full'
    }
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }))

    await executeObjectiveDispatch({
      action: plannerRedispatch,
      binding,
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.not.objectContaining({ planReviewFindings: expect.anything() })
    )
  })

  it('defaults the concurrency cap to 1 and lanes to enabled when the world has no parallel projection', async () => {
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveMaxConcurrency: 1, lanesEnabled: true })
    )
  })

  it("reads the world's live effective concurrency cap so a mid-run set-concurrency reaches the next dispatch", async () => {
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }), {
      parallel: {
        effectiveMaxConcurrency: 5,
        runningCount: 2,
        dispatches: []
      }
    })

    await executeObjectiveDispatch({
      action: dispatchNode,
      binding,
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ effectiveMaxConcurrency: 5 })
    )
  })

  it('reads lanesEnabled off the contract, forwarding false only when explicitly disabled', async () => {
    await executeObjectiveDispatch({
      action: dispatchNode,
      binding: { ...binding, contract: { ...binding.contract, lanesEnabled: false } },
      context: context(
        { watcherId: 'watcher-1', entries: [] },
        { status: 'dispatched', dispatchId: 'dispatch-1' }
      ),
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(expect.objectContaining({ lanesEnabled: false }))
  })

  it('supplies the concurrency cap and lanesEnabled to a planner dispatch as well', async () => {
    const plannerAction: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan:1:initial',
      revisionNumber: 1,
      reason: 'initial'
    }
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(projection({ revisions: [], nodes: [] }), {
      parallel: { effectiveMaxConcurrency: 3, runningCount: 0, dispatches: [] }
    })

    await executeObjectiveDispatch({
      action: plannerAction,
      binding,
      context: executeContext,
      objectiveStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'planner', effectiveMaxConcurrency: 3, lanesEnabled: true })
    )
  })

  it('builds a repair-shaped planner prompt with frozen and open task context', async () => {
    const repairAction: ObjectiveAction = {
      kind: 'dispatch-planner',
      capability: 'plan',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'plan-repair:revision-1:1',
      revisionNumber: 1,
      reason: 'replan-after-failure',
      plannerMode: 'repair',
      repairOrdinal: 1,
      repairRevisionId: 'revision-1'
    }
    const openTask = {
      taskKey: 'node-b',
      title: 'Node B',
      spec: 'Implement B',
      deps: [],
      criteria: [{ body: 'B works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
    const frozenTask = {
      taskKey: 'node-a',
      title: 'Node A',
      spec: 'Implement A',
      deps: [],
      criteria: [{ body: 'A works', shellCheckable: false, checkCommand: null }],
      declaresDependencyChange: false
    }
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods above are exercised.
    const repairStore = {
      ...objectiveStore,
      getPlan: () => [frozenTask, openTask],
      project: () => ({
        revisions: [],
        nodes: [
          {
            revisionId: 'revision-1',
            taskKey: 'node-a',
            deps: [],
            orchestrationTaskId: null,
            dispatchId: 'dispatch-node-a',
            state: 'succeeded',
            criteria: []
          }
        ],
        verdicts: [],
        landing: []
      }),
      listDispatches: () => [
        {
          attemptFingerprint: 'fp-node-a',
          watcherId: 'watcher-1',
          executionHostId: 'local',
          revisionId: 'revision-1',
          taskKey: 'node-a',
          planTaskDigest: 'digest-node-a',
          dispatchId: 'dispatch-node-a',
          workspaceId: 'workspace-node-a',
          workspacePath: '/workspaces/node-a',
          baseCommit: 'base',
          laneTaskKeys: ['node-a'],
          sessionNodeCount: 1,
          state: 'applied',
          commitSha: 'commit',
          appliedCommitSha: 'commit',
          reportDigest: 'report-digest',
          conflictPaths: [],
          conflictingTaskKeys: [],
          conflictingDispatchIds: [],
          createdAtMs: 10,
          completedAtMs: 20,
          terminalHandle: null,
          setupState: 'retained',
          reportPath: '/reports/node-a.json',
          report: {
            taskKey: 'node-a',
            summary: 'Implemented node-a.',
            filesModified: ['src/a.ts'],
            criteriaSelfAssessment: []
          },
          task: frozenTask
        }
      ]
    } as unknown as ObjectiveStore
    const executeContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )
    executeContext.snapshot = snapshot(
      projection({ revisions: [], nodes: [node('node-a', { state: 'succeeded' })] })
    )

    await executeObjectiveDispatch({
      action: repairAction,
      binding,
      context: executeContext,
      objectiveStore: repairStore,
      store,
      runtime
    })

    expect(buildRolePrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'planner',
        plannerMode: 'repair',
        repairContext: {
          openTasks: [openTask],
          frozenTasks: [
            {
              taskKey: 'node-a',
              title: 'Node A',
              state: 'succeeded',
              summary: 'Implemented node-a.',
              filesModified: ['src/a.ts'],
              completedAtMs: 20
            }
          ]
        }
      })
    )
  })
})

function failedNodeAttempt(args: {
  dispatchId: string
  fingerprint: string
  failureClass?: 'infra' | 'environment' | 'criteria'
}): WatcherLedger['entries'][number] {
  return {
    eventId: 'event-failed-attempt',
    watcherId: 'watcher-1',
    atMs: 1,
    origin: 'owner',
    class: 'fact',
    kind: 'attempt',
    attemptId: 'attempt-failed',
    fingerprint: args.fingerprint,
    action: dispatchNode,
    state: 'settled',
    effect: 'not-landed',
    dispatchId: args.dispatchId,
    ...(args.failureClass === undefined ? {} : { failureClass: args.failureClass })
  }
}

function workerDoneEvidence(args: {
  dispatchId: string
  subject?: string
  body?: string
  reportPath?: string | null
}): WatcherLedger['entries'][number] {
  return {
    eventId: 'event-worker-done',
    watcherId: 'watcher-1',
    atMs: 5,
    origin: 'owner',
    class: 'fact',
    kind: 'evidence',
    evidenceKind: 'orchestration-mailbox',
    payload: {
      type: 'worker_done',
      payload: {
        dispatchId: args.dispatchId,
        taskId: 'orchestration-task-1',
        outcome: 'failed',
        reportPath: args.reportPath ?? null,
        filesModified: []
      },
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      ...(args.body === undefined ? {} : { body: args.body })
    }
  }
}

describe('executeObjectiveDispatch for dispatch-plan-review', () => {
  beforeEach(() => {
    issueReportPath.mockReset()
    resolveAgent.mockReset()
    preparePlanReviewDispatchSpec.mockReset()
    issueReportPath.mockResolvedValue('/workspace/reports/abc.json')
    resolveAgent.mockReturnValue('claude')
  })

  it('dispatches a plan review for a revision target using its prepared task key and spec', async () => {
    const action: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'revision-1:1',
      target: { kind: 'revision', revisionId: 'revision-1' },
      round: 1
    }
    preparePlanReviewDispatchSpec.mockResolvedValue({
      role: 'reviewer',
      taskKey: 'objective-plan-review-revision-1-1',
      spec: 'review the plan'
    })
    const dispatchContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-1' }
    )

    const outcome = await executeObjectiveDispatch({
      action,
      binding,
      context: dispatchContext,
      objectiveStore,
      store,
      runtime
    })

    expect(outcome).toEqual({
      effect: 'landed',
      result: { dispatchId: 'dispatch-1', reportPath: '/workspace/reports/abc.json' }
    })
    expect(preparePlanReviewDispatchSpec).toHaveBeenCalledWith(
      expect.objectContaining({ action, reportPath: '/workspace/reports/abc.json' })
    )
    expect(dispatchContext.dispatchWorker).toHaveBeenCalledWith(
      expect.objectContaining({
        spec: 'review the plan',
        taskKey: 'objective-plan-review-revision-1-1'
      })
    )
  })

  it('dispatches a plan review for a patch target using the patch id in its task key', async () => {
    const action: ObjectiveAction = {
      kind: 'dispatch-plan-review',
      capability: 'review',
      visibility: 'local',
      contentIdentity: 'content-current',
      evidenceKey: 'patch-1:2',
      target: { kind: 'patch', patchId: 'patch-1' },
      round: 2
    }
    preparePlanReviewDispatchSpec.mockResolvedValue({
      role: 'reviewer',
      taskKey: 'objective-plan-review-patch-1-2',
      spec: 'review the patch'
    })
    const dispatchContext = context(
      { watcherId: 'watcher-1', entries: [] },
      { status: 'dispatched', dispatchId: 'dispatch-2' }
    )

    const outcome = await executeObjectiveDispatch({
      action,
      binding,
      context: dispatchContext,
      objectiveStore,
      store,
      runtime
    })

    expect(outcome).toEqual({
      effect: 'landed',
      result: { dispatchId: 'dispatch-2', reportPath: '/workspace/reports/abc.json' }
    })
    expect(dispatchContext.dispatchWorker).toHaveBeenCalledWith(
      expect.objectContaining({ taskKey: 'objective-plan-review-patch-1-2' })
    )
  })
})

describe('deriveObjectiveFailureContext', () => {
  const plannerReplanAfterFailure: Extract<ObjectiveAction, { kind: 'dispatch-planner' }> = {
    kind: 'dispatch-planner',
    capability: 'plan',
    visibility: 'local',
    contentIdentity: 'content-current',
    evidenceKey: 'plan:2',
    revisionNumber: 2,
    reason: 'replan-after-failure'
  }

  beforeEach(() => {
    readRoleReport.mockReset()
    readRoleReport.mockResolvedValue({ ok: false, reason: 'missing' })
  })

  it('joins the failed node, its failure class, and the worker narrative from the ledger', async () => {
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [
        failedNodeAttempt({
          dispatchId: 'dispatch-1',
          fingerprint: 'fp-1',
          failureClass: 'environment'
        }),
        workerDoneEvidence({
          dispatchId: 'dispatch-1',
          subject: 'Node A failed',
          body: 'The health check assertion failed on line 42.'
        })
      ]
    }

    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger,
      objectiveStore,
      activeRevisionId: 'revision-1'
    })

    expect(context).toEqual({
      taskKey: 'node-a',
      failureClass: 'environment',
      narrative: 'Node A failed\nThe health check assertion failed on line 42.',
      failingCriteria: []
    })
  })

  it('joins the specific criteria the implementer self-assessed as failed', async () => {
    readRoleReport.mockResolvedValue({
      ok: true,
      role: 'implementer',
      path: '/workspace/report.json',
      report: {
        taskKey: 'node-a',
        summary: 'Could not make the check pass.',
        filesModified: [],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'fail', note: 'Assertion mismatch.' }]
      },
      reportDigest: 'digest-1'
    })
    const ledger: WatcherLedger = {
      watcherId: 'watcher-1',
      entries: [
        failedNodeAttempt({
          dispatchId: 'dispatch-1',
          fingerprint: 'fp-1',
          failureClass: 'criteria'
        }),
        workerDoneEvidence({
          dispatchId: 'dispatch-1',
          body: 'Assertion failed.',
          reportPath: '/workspace/report.json'
        })
      ]
    }

    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger,
      objectiveStore,
      activeRevisionId: 'revision-1'
    })

    expect(context?.failingCriteria).toEqual(['A works — Assertion mismatch.'])
  })

  it('returns undefined for a reason other than replan-after-failure', async () => {
    const context = await deriveObjectiveFailureContext({
      action: { ...plannerReplanAfterFailure, reason: 'replan-after-block' },
      binding,
      ledger: { watcherId: 'watcher-1', entries: [] },
      objectiveStore,
      activeRevisionId: 'revision-1'
    })
    expect(context).toBeUndefined()
  })

  it('returns undefined when no failed dispatch-node report matches the active revision', async () => {
    const context = await deriveObjectiveFailureContext({
      action: plannerReplanAfterFailure,
      binding,
      ledger: {
        watcherId: 'watcher-1',
        entries: [
          failedNodeAttempt({
            dispatchId: 'dispatch-1',
            fingerprint: 'fp-1',
            failureClass: 'criteria'
          }),
          workerDoneEvidence({ dispatchId: 'dispatch-1' })
        ]
      },
      objectiveStore,
      activeRevisionId: 'revision-other'
    })
    expect(context).toBeUndefined()
  })
})
