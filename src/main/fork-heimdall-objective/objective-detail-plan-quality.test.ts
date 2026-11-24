import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectiveEnrollmentPayload } from '../../shared/fork-heimdall-objective/contract-types'
import type { ObjectivePlanTask } from '../../shared/fork-heimdall-objective/plan-schema'
import { buildObjectiveDetailPlanQuality } from './objective-detail-plan-quality'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const WATCHER_ID = 'watcher-quality-1'

const CONTRACT: ObjectiveEnrollmentPayload = {
  objectiveText: 'Implement the requested objective',
  tier: 'standard',
  landingBar: 'files-on-disk',
  maxConcurrency: 1,
  workspaceKind: 'git',
  writeTerritory: ['src/**'],
  roleAgents: {},
  sitterOverrides: {}
}

const TASK: ObjectivePlanTask = {
  taskKey: 'task-a',
  title: 'Task A',
  spec: 'Implement A',
  deps: [],
  territory: ['src/**'],
  criteria: [{ body: 'Works', shellCheckable: false, checkCommand: null }],
  declaresDependencyChange: false
}

let database: ObjectiveDatabase
let store: ObjectiveStore

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  database.close()
})

describe('buildObjectiveDetailPlanQuality', () => {
  it('returns an empty result when the objective has no plan revision yet', () => {
    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.nodeDetailByKey.size).toBe(0)
    expect(result.planLint).toBeUndefined()
    expect(result.assumptions).toBeUndefined()
    expect(result.planReviews).toBeUndefined()
    expect(result.pendingPatch).toBeUndefined()
    expect(result.gates).toBeUndefined()
    expect(result.noGateDeclared).toBe(true)
  })

  it('reads territory and lint off the draft revision when nothing is approved yet', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: { plan: [TASK], assumptions: [] },
      digest: 'digest-1',
      createdAtMs: 100
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.nodeDetailByKey.get(`${revision.revisionId}\0task-a`)).toEqual({
      territory: ['src/**']
    })
    expect(result.planLint?.findings).toEqual([
      { code: 'no-gate-declared', taskKey: null, detail: 'The objective declares no gates.' }
    ])
    expect(result.assumptions).toEqual([])
  })

  it('flags a dispatch report path outside the territory recorded on that dispatch', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: { plan: [TASK], assumptions: [] },
      digest: 'digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    store.saveDispatch({
      attemptFingerprint: 'fingerprint-task-a',
      watcherId: WATCHER_ID,
      executionHostId: 'local',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      planTaskDigest: 'task-a-digest',
      dispatchId: 'dispatch-task-a',
      workspaceId: 'worktree-task-a',
      workspacePath: '/workspace/task-a',
      baseCommit: 'base-commit',
      laneTaskKeys: ['task-a'],
      sessionNodeCount: 1,
      state: 'applied',
      commitSha: 'node-commit',
      appliedCommitSha: 'applied-commit',
      reportDigest: 'report-digest',
      conflictPaths: [],
      conflictingTaskKeys: [],
      conflictingDispatchIds: [],
      createdAtMs: 400,
      completedAtMs: 450,
      terminalHandle: null,
      setupState: 'retained',
      reportPath: '.quirky/reports/task-a.json',
      report: {
        taskKey: 'task-a',
        summary: 'Applied',
        filesModified: ['src/a.ts', 'docs/outside.md'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'ok' }]
      },
      task: TASK
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.nodeDetailByKey.get(`${revision.revisionId}\0task-a`)).toEqual({
      territory: ['src/**'],
      overrunPaths: ['docs/outside.md']
    })
  })

  it('carries status and evidence onto an assumption from the newest revision review', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: {
        plan: [TASK],
        assumptions: [{ claim: 'The API is stable', dependentTaskKeys: ['task-a'] }]
      },
      digest: 'digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: revision.revisionId,
      round: 1,
      dispatchId: 'plan-review-1',
      report: {
        verdict: 'approve',
        assumptions: [{ index: 0, status: 'verified', evidence: 'Checked the changelog' }],
        findings: [],
        summary: 'Looks solid'
      },
      reportDigest: 'review-digest-1',
      createdAtMs: 300
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.assumptions).toEqual([
      {
        claim: 'The API is stable',
        dependentTaskKeys: ['task-a'],
        status: 'verified',
        evidence: 'Checked the changelog'
      }
    ])
    expect(result.planReviews).toEqual([
      expect.objectContaining({
        targetKind: 'revision',
        targetId: revision.revisionId,
        round: 1,
        verdict: 'approve',
        summary: 'Looks solid'
      })
    ])
  })

  it('maps an applied patch assumption to its own review, not the revision review', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: {
        plan: [TASK],
        assumptions: [{ claim: 'Revision assumption', dependentTaskKeys: ['task-a'] }]
      },
      digest: 'digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'revision',
      targetId: revision.revisionId,
      round: 1,
      dispatchId: 'plan-review-1',
      report: {
        verdict: 'approve',
        assumptions: [{ index: 0, status: 'verified', evidence: 'Revision checked' }],
        findings: [],
        summary: 'Looks solid'
      },
      reportDigest: 'review-digest-1',
      createdAtMs: 300
    })

    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: {
        repair: {
          upsertTasks: [{ ...TASK, taskKey: 'task-b', title: 'Task B' }],
          dropTaskKeys: []
        },
        assumptions: [
          { claim: 'Patch assumption A', dependentTaskKeys: ['task-a'] },
          { claim: 'Patch assumption B', dependentTaskKeys: [] }
        ]
      },
      createdAtMs: 400
    })
    store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 500,
      frozenTaskKeys: []
    })
    store.recordPlanReviewAndRejectRoundOneTarget({
      watcherId: WATCHER_ID,
      targetKind: 'patch',
      targetId: patch.id,
      round: 1,
      dispatchId: 'plan-review-2',
      report: {
        verdict: 'approve',
        assumptions: [
          { index: 0, status: 'verified', evidence: 'A checked' },
          { index: 1, status: 'unverified', evidence: 'B pending' }
        ],
        findings: [],
        summary: 'Patch approved'
      },
      reportDigest: 'review-digest-2',
      createdAtMs: 600
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.assumptions).toEqual([
      {
        claim: 'Revision assumption',
        dependentTaskKeys: ['task-a'],
        status: 'verified',
        evidence: 'Revision checked'
      },
      {
        claim: 'Patch assumption A',
        dependentTaskKeys: ['task-a'],
        status: 'verified',
        evidence: 'A checked'
      },
      {
        claim: 'Patch assumption B',
        dependentTaskKeys: [],
        status: 'unverified',
        evidence: 'B pending'
      }
    ])
  })

  it('shows a rejected patch when it is the newest for the approved revision', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: { plan: [TASK], assumptions: [] },
      digest: 'digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: {
        repair: {
          upsertTasks: [{ ...TASK, taskKey: 'task-b', title: 'Task B' }],
          dropTaskKeys: []
        },
        assumptions: []
      },
      createdAtMs: 300,
      rejection: 'names a frozen task'
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.pendingPatch).toEqual({
      id: patch.id,
      status: 'rejected',
      rejection: 'names a frozen task',
      touchedTaskKeys: ['task-b']
    })
  })

  it('omits the pending patch once it applies', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: { plan: [TASK], assumptions: [] },
      digest: 'digest-1',
      createdAtMs: 100
    })
    store.activatePlan({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      digest: revision.digest,
      approvedAtMs: 200
    })
    const patch = store.ingestPlanPatch({
      watcherId: WATCHER_ID,
      revisionId: revision.revisionId,
      dispatchId: 'repair-1',
      repairOrdinal: 0,
      report: {
        repair: {
          upsertTasks: [{ ...TASK, taskKey: 'task-b', title: 'Task B' }],
          dropTaskKeys: []
        },
        assumptions: []
      },
      createdAtMs: 300
    })
    store.applyPlanPatch({
      watcherId: WATCHER_ID,
      patchId: patch.id,
      amendedAtMs: 400,
      frozenTaskKeys: []
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      CONTRACT,
      store.project(WATCHER_ID)
    )
    expect(result.pendingPatch).toBeUndefined()
  })

  it('reports pass, failure, and not-run for declared gates from their latest completed attempt', () => {
    const contract: ObjectiveEnrollmentPayload = {
      ...CONTRACT,
      gates: [
        { name: 'lint', command: 'pnpm lint', timeoutSeconds: 600 },
        { name: 'typecheck', command: 'pnpm typecheck', timeoutSeconds: 600 }
      ]
    }
    store.startGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'lint',
      contentIdentity: 'content-1',
      executionHostId: 'local',
      command: 'pnpm lint',
      epoch: 1,
      startedAtMs: 100
    })
    store.completeGateAttempt({
      watcherId: WATCHER_ID,
      gateName: 'lint',
      contentIdentity: 'content-1',
      exitCode: 1,
      timedOut: false,
      stdoutTail: '',
      stderrTail: 'lint failed',
      completedAtMs: 150
    })

    const result = buildObjectiveDetailPlanQuality(
      database,
      WATCHER_ID,
      contract,
      store.project(WATCHER_ID)
    )
    expect(result.gates).toEqual([
      {
        name: 'lint',
        command: 'pnpm lint',
        timeoutSeconds: 600,
        lastResult: {
          contentIdentity: 'content-1',
          pass: false,
          exitCode: 1,
          timedOut: false,
          completedAtMs: 150
        }
      },
      { name: 'typecheck', command: 'pnpm typecheck', timeoutSeconds: 600 }
    ])
    expect(result.noGateDeclared).toBeUndefined()
  })
})
