import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeAttemptFingerprint } from '../../shared/fork-heimdall/attempt-fingerprint'
import type { ExecuteContext } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveAction } from '../../shared/fork-heimdall-objective/objective-actions'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type { ObjectiveWorld } from '../../shared/fork-heimdall-objective/detail-types'
import type { PlannerReport } from '../../shared/fork-heimdall-objective/plan-schema'
import type { QuirkyRuntimeService } from '../runtime/quirky-runtime'
import type { ObjectiveSnapshotBinding } from './execution-context'
import { ObjectiveNodeIngestRejectedError } from './merge-train-git'
import { ingestObjectiveNodeReport } from './local-node-report-action'
import { captureObjectiveWorkspaceBaseline } from './observed-workspace-changes'
import { issueObjectiveReportPath } from './report-ingestion'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'

const { queueObjectiveDispatchReportMock } = vi.hoisted(() => ({
  queueObjectiveDispatchReportMock: vi.fn()
}))
vi.mock('./merge-train-report', () => ({
  queueObjectiveDispatchReport: queueObjectiveDispatchReportMock
}))

const { resolveObjectiveDispatchTargetMock } = vi.hoisted(() => ({
  resolveObjectiveDispatchTargetMock: vi.fn()
}))
vi.mock('./dispatch-worktree', () => ({
  resolveObjectiveDispatchTarget: resolveObjectiveDispatchTargetMock
}))

const WATCHER_ID = 'watcher-1'

const PLAN: PlannerReport = {
  plan: [
    {
      taskKey: 'node-1',
      title: 'Node 1',
      spec: 'Execute node one',
      deps: [],
      criteria: [
        { body: 'The workspace check passes', shellCheckable: true, checkCommand: 'true' }
      ],
      declaresDependencyChange: false
    }
  ]
}

type Fixture = {
  action: Extract<ObjectiveAction, { kind: 'ingest-report' }>
  binding: ObjectiveSnapshotBinding
  context: ExecuteContext<ObjectiveWorld>
  objectiveStore: ObjectiveStore
  runtime: QuirkyRuntimeService
  workspacePath: string
  database: ObjectiveDatabase
}

async function buildFixture(): Promise<Fixture> {
  const database = new ObjectiveDatabase(':memory:')
  const objectiveStore = new ObjectiveStore(database)
  const revision = objectiveStore.ingestPlan({
    watcherId: WATCHER_ID,
    revisionNumber: 1,
    dispatchId: 'planner-1',
    report: PLAN,
    digest: 'digest-1',
    createdAtMs: 1
  })
  objectiveStore.activatePlan({
    watcherId: WATCHER_ID,
    revisionId: revision.revisionId,
    digest: revision.digest,
    approvedAtMs: 2
  })

  const workspacePath = await mkdtemp(join(tmpdir(), 'objective-node-report-'))
  const target = {
    kind: 'folder' as const,
    executionHostId: 'local' as const,
    workspacePath
  }

  const dispatchAction = {
    kind: 'dispatch-node',
    capability: 'implement',
    visibility: 'local',
    contentIdentity: 'content-original',
    evidenceKey: `${revision.revisionId}:node-1`,
    revisionId: revision.revisionId,
    taskKey: 'node-1',
    depsOrchestrationIds: []
  } satisfies ObjectiveAction
  const attemptFingerprint = makeAttemptFingerprint(
    dispatchAction.contentIdentity,
    dispatchAction.kind,
    dispatchAction.evidenceKey
  )

  const dispatchRecord: ObjectiveDispatchRecord = {
    attemptFingerprint,
    watcherId: WATCHER_ID,
    executionHostId: 'local',
    planTaskDigest: 'plan-task-digest-1',
    revisionId: revision.revisionId,
    taskKey: 'node-1',
    dispatchId: 'dispatch-node-1',
    workspaceId: 'worktree-node-1',
    workspacePath,
    baseCommit: 'base-sha-1',
    laneTaskKeys: ['node-1'],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    createdAtMs: 3,
    completedAtMs: null,
    terminalHandle: null,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: PLAN.plan[0]!
  }
  objectiveStore.saveDispatch(dispatchRecord)

  // baseline is captured before the reported file lands, matching what the real dispatch flow does
  await captureObjectiveWorkspaceBaseline(target, attemptFingerprint)
  await mkdir(join(workspacePath, 'src'), { recursive: true })
  await writeFile(join(workspacePath, 'src', 'node-1.ts'), 'export const done = true\n')

  const reportPath = await issueObjectiveReportPath(target, attemptFingerprint)
  await writeFile(
    reportPath,
    JSON.stringify({
      taskKey: 'node-1',
      summary: 'Implemented node one.',
      filesModified: ['src/node-1.ts'],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
    })
  )

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of the large ObjectiveSnapshotBinding (WatcherEnrollment/ObjectiveEnrollmentPayload) types; only the fields below are read by the report ingestion action.
  const binding = {
    enrollment: { watcherId: WATCHER_ID },
    contract: { writeTerritory: ['src/**'] },
    target
  } as unknown as ObjectiveSnapshotBinding

  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ExecuteContext; only the fields below are read by the report ingestion action.
  const context = {
    snapshot: { contentIdentity: 'content-current' },
    ledger: {
      watcherId: WATCHER_ID,
      entries: [
        {
          eventId: 'attempt-node-1',
          watcherId: WATCHER_ID,
          atMs: 3,
          origin: 'owner',
          class: 'fact',
          kind: 'attempt',
          attemptId: 'attempt-node-1',
          fingerprint: attemptFingerprint,
          action: dispatchAction,
          state: 'settled',
          effect: 'indeterminate',
          dispatch: { spec: 'Implement node one.', deps: [], dispatchKind: 'child' },
          dispatchId: 'dispatch-node-1'
        },
        {
          eventId: 'evidence-node-1',
          watcherId: WATCHER_ID,
          atMs: 4,
          origin: 'owner',
          class: 'fact',
          kind: 'evidence',
          evidenceKind: 'orchestration-mailbox',
          payload: {
            type: 'worker_done',
            payload: {
              dispatchId: 'dispatch-node-1',
              taskId: 'orchestration-node-1',
              outcome: 'succeeded',
              reportPath,
              filesModified: ['src/node-1.ts']
            }
          }
        }
      ]
    },
    lease: { assertHeld: vi.fn(async () => undefined) },
    dispatchWorker: vi.fn()
  } as unknown as ExecuteContext<ObjectiveWorld>

  const action: Extract<ObjectiveAction, { kind: 'ingest-report' }> = {
    kind: 'ingest-report',
    capability: 'implement',
    visibility: 'local',
    recovery: 'replay-safe',
    contentIdentity: 'content-current',
    evidenceKey: 'dispatch-node-1',
    revisionId: revision.revisionId,
    dispatchId: 'dispatch-node-1',
    taskKey: 'node-1',
    orchestrationTaskId: 'orchestration-node-1',
    reportPath,
    filesModified: ['src/node-1.ts'],
    dispatchedContentIdentity: dispatchAction.contentIdentity
  }

  resolveObjectiveDispatchTargetMock.mockResolvedValue(target)

  return {
    action,
    binding,
    context,
    objectiveStore,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: QuirkyRuntimeService is a class with private fields; never called in these tests.
    runtime: {} as QuirkyRuntimeService,
    workspacePath,
    database
  }
}

afterEach(() => {
  queueObjectiveDispatchReportMock.mockReset()
  resolveObjectiveDispatchTargetMock.mockReset()
})

describe('ingestObjectiveNodeReport queueing failure classification', () => {
  it('classifies a typed, deterministic ingest rejection as a criteria failure, not infra', async () => {
    const fixture = await buildFixture()
    try {
      queueObjectiveDispatchReportMock.mockRejectedValueOnce(
        new ObjectiveNodeIngestRejectedError(
          'Objective node HEAD does not descend from its dispatch baseline'
        )
      )

      await expect(
        ingestObjectiveNodeReport({
          action: fixture.action,
          binding: fixture.binding,
          context: fixture.context,
          objectiveStore: fixture.objectiveStore,
          runtime: fixture.runtime
        })
      ).resolves.toEqual({
        effect: 'not-landed',
        failureClass: 'criteria',
        reason: 'Objective node HEAD does not descend from its dispatch baseline'
      })
    } finally {
      fixture.database.close()
      await rm(fixture.workspacePath, { recursive: true, force: true })
    }
  })

  it('keeps a generic, untyped queueing failure classified as infra', async () => {
    const fixture = await buildFixture()
    try {
      queueObjectiveDispatchReportMock.mockRejectedValueOnce(
        new Error('git process spawn failed: ENOENT')
      )

      await expect(
        ingestObjectiveNodeReport({
          action: fixture.action,
          binding: fixture.binding,
          context: fixture.context,
          objectiveStore: fixture.objectiveStore,
          runtime: fixture.runtime
        })
      ).resolves.toEqual({
        effect: 'not-landed',
        failureClass: 'infra',
        reason: 'git process spawn failed: ENOENT'
      })
    } finally {
      fixture.database.close()
      await rm(fixture.workspacePath, { recursive: true, force: true })
    }
  })
})
