import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ObjectiveDispatchRecord } from '../../shared/fork-heimdall-objective/parallel-types'
import { ObjectiveDatabase } from './objective-database'
import { ObjectiveStore } from './objective-store'
import { CONTRACT, REPORT, WATCHER_ID } from './objective-store-test-fixtures'

let database: ObjectiveDatabase
let store: ObjectiveStore

beforeEach(() => {
  database = new ObjectiveDatabase(':memory:')
  store = new ObjectiveStore(database, () => 9_999)
})

afterEach(() => {
  database.close()
})

describe('ObjectiveStore durable dispatches', () => {
  it('persists setup recovery and projects train state across store instances', () => {
    const revision = store.ingestPlan({
      watcherId: WATCHER_ID,
      revisionNumber: 1,
      dispatchId: 'planner-1',
      report: REPORT,
      digest: 'plan-digest-1',
      createdAtMs: 101
    })
    const record: ObjectiveDispatchRecord = {
      attemptFingerprint: 'attempt-node-a',
      watcherId: WATCHER_ID,
      executionHostId: 'local',
      planTaskDigest: 'plan-task-digest-a',
      revisionId: revision.revisionId,
      taskKey: 'task-a',
      dispatchId: 'dispatch-node-a',
      workspaceId: 'worktree-node-a',
      workspacePath: '/workspace/node-a',
      baseCommit: 'base-sha',
      laneTaskKeys: ['task-a', 'task-b'],
      sessionNodeCount: 1,
      state: 'waiting-to-apply',
      commitSha: 'node-commit-sha',
      appliedCommitSha: null,
      reportDigest: 'report-digest-a',
      conflictPaths: [],
      conflictingTaskKeys: [],
      conflictingDispatchIds: [],
      createdAtMs: 700,
      completedAtMs: 800,
      terminalHandle: 'terminal-node-a',
      setupState: 'ready',
      reportPath: '.quirky/reports/task-a.json',
      report: {
        taskKey: 'task-a',
        summary: 'Implemented task A',
        filesModified: ['src/a.ts'],
        criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Checked' }]
      },
      task: REPORT.plan[0]!
    }
    store.saveDispatch({
      ...record,
      dispatchId: null,
      workspaceId: 'pending:attempt-node-a',
      workspacePath: 'pending:attempt-node-a',
      state: 'running',
      commitSha: null,
      reportDigest: null,
      completedAtMs: null,
      terminalHandle: null,
      setupState: 'pending',
      reportPath: null,
      report: null
    })
    store.saveDispatch(record)
    store.setParallelNote(WATCHER_ID, 'Train paused by operator edits.')

    const reopened = new ObjectiveStore(database, () => 10_000)
    expect(reopened.getDispatch(record.attemptFingerprint)).toEqual(record)
    expect(reopened.dispatchForId(WATCHER_ID, 'dispatch-node-a')).toEqual(record)
    expect(reopened.listDispatches(WATCHER_ID)).toEqual([record])
    expect(reopened.parallelProjection(WATCHER_ID, { ...CONTRACT, maxConcurrency: 3 })).toEqual({
      effectiveMaxConcurrency: 3,
      runningCount: 1,
      note: 'Train paused by operator edits.',
      dispatches: [record]
    })
    expect(
      reopened.parallelProjection(WATCHER_ID, {
        ...CONTRACT,
        workspaceKind: 'folder',
        maxConcurrency: 3
      })
    ).toMatchObject({
      effectiveMaxConcurrency: 1,
      note: expect.stringContaining('Folder workspaces'),
      runningCount: 1
    })
  })
})
