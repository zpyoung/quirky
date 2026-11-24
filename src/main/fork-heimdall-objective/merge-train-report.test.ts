import { describe, expect, it, vi } from 'vitest'
import type { LeaseGuard } from '../../shared/fork-heimdall/kind-contract'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import type {
  ImplementerReport,
  ObjectivePlanTask
} from '../../shared/fork-heimdall-objective/plan-schema'
import type { ObjectiveWorkspaceTarget } from './content-identity'
import { ObjectiveNodeIngestRejectedError } from './merge-train-git'
import { queueObjectiveDispatchReport } from './merge-train-report'
import type { ObjectiveStore } from './objective-store'

const assertHeld = vi.fn(async () => {})
const leaseGuard: LeaseGuard = {
  epoch: 1,
  holder: 'merge-train-report-test',
  assertHeld,
  renewLoop: () => ({ dispose() {} })
}

const target: ObjectiveWorkspaceTarget = {
  kind: 'folder',
  executionHostId: 'local',
  workspacePath: '/does-not-matter'
}

const TASK: ObjectivePlanTask = {
  taskKey: 'node-1',
  title: 'Node 1',
  spec: 'Execute node one',
  deps: [],
  criteria: [{ body: 'The workspace check passes', shellCheckable: true, checkCommand: 'true' }],
  declaresDependencyChange: false
}

const REPORT: ImplementerReport = {
  taskKey: 'node-1',
  summary: 'Implemented node one.',
  filesModified: ['src/node-1.ts'],
  criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Verified locally.' }]
}

function baseRecord(overrides: Partial<ObjectiveDispatchRecord> = {}): ObjectiveDispatchRecord {
  return {
    attemptFingerprint: 'attempt-node-1',
    watcherId: 'watcher-1',
    executionHostId: 'local',
    planTaskDigest: 'plan-task-digest-1',
    revisionId: 'revision-1',
    taskKey: 'node-1',
    dispatchId: 'dispatch-node-1',
    workspaceId: 'worktree-node-1',
    workspacePath: '/does-not-matter',
    baseCommit: '0000000000000000000000000000000000000a',
    laneTaskKeys: ['node-1'],
    sessionNodeCount: 1,
    state: 'running',
    commitSha: null,
    appliedCommitSha: null,
    reportDigest: null,
    conflictPaths: [],
    conflictingTaskKeys: [],
    conflictingDispatchIds: [],
    createdAtMs: 1,
    completedAtMs: null,
    terminalHandle: null,
    setupState: 'ready',
    reportPath: null,
    report: null,
    task: TASK,
    ...overrides
  }
}

function objectiveStoreStub(record: ObjectiveDispatchRecord): ObjectiveStore {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial double of ObjectiveStore, a class with private fields no object literal can structurally satisfy; only the methods below are exercised.
  return {
    saveDispatch: vi.fn((next: ObjectiveDispatchRecord) => next),
    dispatchForId: vi.fn(() => record)
  } as unknown as ObjectiveStore
}

describe('queueObjectiveDispatchReport durable digest checkpoint', () => {
  it('rejects a replayed report with a different digest via a typed, deterministic error', async () => {
    const record = baseRecord({ reportDigest: 'digest-original' })
    const objectiveStore = objectiveStoreStub(record)

    await expect(
      queueObjectiveDispatchReport({
        record,
        target,
        objectiveStore,
        lease: leaseGuard,
        reportPath: '.quirky/heimdall/objective/reports/node-1.json',
        report: REPORT,
        reportDigest: 'digest-changed',
        completedAtMs: 2
      })
    ).rejects.toThrow(ObjectiveNodeIngestRejectedError)
    await expect(
      queueObjectiveDispatchReport({
        record,
        target,
        objectiveStore,
        lease: leaseGuard,
        reportPath: '.quirky/heimdall/objective/reports/node-1.json',
        report: REPORT,
        reportDigest: 'digest-changed',
        completedAtMs: 2
      })
    ).rejects.toThrow('Durable dispatch report checkpoint has a different digest')
    expect(objectiveStore.saveDispatch).not.toHaveBeenCalled()
  })
})
