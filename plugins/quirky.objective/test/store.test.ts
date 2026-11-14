import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, StoreMigration } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createObjectiveStore, type AcceptedReport, type CheckRecord, type Issued, type LandingRecord, type OverrunRecord, type VerdictRecord } from '../src/store'
import { reportDigest, type PlannerReport, type RepairPlannerReport } from '../src/plan'

const plan: PlannerReport = {
  plan: { tasks: [{
    taskKey: 'task-one', title: 'One', spec: 'First task', deps: [],
    criteria: [{ body: 'It works', shellCheckable: false, checkCommand: null }], territory: ['src/**']
  }] },
  assumptions: []
}

function seedV1Store(file: string): void {
  const db = new Database(file)
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE issued (attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('planner','implementer')), revision INTEGER, task_key TEXT,
        report_path TEXT NOT NULL, issued_at_ms INTEGER NOT NULL);
      CREATE TABLE report (attempt_id TEXT PRIMARY KEY REFERENCES issued(attempt_id), watcher_id TEXT NOT NULL,
        dispatch_id TEXT NOT NULL, role TEXT NOT NULL, report_json TEXT NOT NULL, digest TEXT NOT NULL, accepted_at_ms INTEGER NOT NULL);
      CREATE TABLE revision (watcher_id TEXT NOT NULL, number INTEGER NOT NULL, plan_json TEXT NOT NULL, digest TEXT NOT NULL,
        source_attempt_id TEXT NOT NULL UNIQUE, approved_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, number));
      PRAGMA user_version = 1;
    `)
    const insertIssued = db.query('INSERT INTO issued VALUES (?,?,?,?,?,?,?)')
    insertIssued.run('draft-v1', 'watcher', 'planner', null, null, '/report-v1.json', 1)
    db.query('INSERT INTO report VALUES (?,?,?,?,?,?,?)').run(
      'draft-v1', 'watcher', 'dispatch-v1', 'planner', JSON.stringify(plan), 'draft-digest-v1', 2
    )
    db.query('INSERT INTO revision VALUES (?,?,?,?,?,?)').run(
      'watcher', 1, JSON.stringify(plan), 'revision-digest-v1', 'draft-v1', 3
    )
  } finally {
    db.close()
  }
}

test('migrates v1 store rows cleanly to v2 schema and persists checks, verdicts, landings, overruns, draft rejections, and repairs', () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-store-v2-'))
  const dataDir = join(home, 'data')
  const storeDir = join(home, 'plugin-data', 'quirky.objective')
  mkdirSync(storeDir, { recursive: true })
  const storeFile = join(storeDir, 'store.db')
  seedV1Store(storeFile)

  const closes: Array<() => void> = []
  const context = {
    dataDir,
    openStore(migrations: StoreMigration[], options?: { newerVersion?: 'read-only' }) {
      const opened = openPluginStore({
        home, pluginId: 'quirky.objective', migrations, isActive: () => true, newerVersion: options?.newerVersion
      })
      closes.push(opened.close)
      return opened.store
    }
  } as unknown as PluginContext

  try {
    const store = createObjectiveStore(context)
    expect(store.issued('watcher')).toContainEqual({
      attemptId: 'draft-v1', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
      reportPath: '/report-v1.json', issuedAtMs: 1
    })
    expect(store.reports('watcher')).toEqual([{
      attemptId: 'draft-v1', watcherId: 'watcher', dispatchId: 'dispatch-v1', role: 'planner',
      report: plan, digest: 'draft-digest-v1', acceptedAtMs: 2
    }])
    expect(store.revision('watcher')).toEqual({
      watcherId: 'watcher', number: 1, plan, digest: 'revision-digest-v1', sourceAttemptId: 'draft-v1', approvedAtMs: 3
    })

    const implementer: Issued = {
      attemptId: 'implementer-1', watcherId: 'watcher', role: 'implementer', revision: 1, taskKey: 'task-one',
      reportPath: '/implementer.json', issuedAtMs: 4, baselineTree: 'tree-before', contentIdentity: 'tree-after'
    }
    const reviewer: Issued = {
      attemptId: 'reviewer-1', watcherId: 'watcher', role: 'reviewer', revision: 1, taskKey: null,
      reportPath: '/reviewer.json', issuedAtMs: 5, contentIdentity: 'tree-after'
    }
    const rejectedDraft: Issued = {
      attemptId: 'rejected-draft-1', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
      reportPath: '/rejected.json', issuedAtMs: 6, plannerMode: 'initial'
    }
    const repairIssued: Issued = {
      attemptId: 'repair-1', watcherId: 'watcher', role: 'planner', revision: 1, taskKey: null,
      reportPath: '/repair.json', issuedAtMs: 7, plannerMode: 'repair'
    }
    store.issue(implementer)
    store.issue(reviewer)
    store.issue(rejectedDraft)
    store.issue(repairIssued)
    expect(store.issued('watcher')).toContainEqual(implementer)
    expect(store.issued('watcher')).toContainEqual(reviewer)

    const check: CheckRecord = {
      attemptId: 'check-1', watcherId: 'watcher', revision: 1, kind: 'criterion', targetKey: 'task-one:0',
      contentIdentity: 'tree-after', command: 'true', status: 'passed', exitCode: 0, timedOut: false,
      stdoutTail: 'ok', stderrTail: '', checkedAtMs: 8
    }
    store.recordCheck(check)
    expect(store.checks('watcher')).toEqual([check])

    const verdict: VerdictRecord = {
      attemptId: 'reviewer-1', watcherId: 'watcher', dispatchId: 'review-dispatch-1', revision: 1, role: 'reviewer',
      contentIdentity: 'tree-after', verdict: 'approve', criteriaResults: [{ taskKey: 'task-one', criterionIndex: 0, result: 'pass', note: 'ok' }],
      checksRun: [], summary: 'Looks good', digest: 'verdict-digest', acceptedAtMs: 9
    }
    expect(store.acceptVerdict(verdict)).toBe(true)
    expect(store.acceptVerdict(verdict)).toBe(true)
    expect(store.verdicts('watcher')).toEqual([verdict])

    const landing: LandingRecord = {
      watcherId: 'watcher', rung: 'files-on-disk', contentIdentity: 'tree-after', attemptId: 'implementer-1',
      payload: { files: ['src/file.ts'] }, recordedAtMs: 10
    }
    store.recordLanding(landing)
    expect(store.landings('watcher')).toEqual([landing])

    store.rejectDraft({ attemptId: 'rejected-draft-1', watcherId: 'watcher', digest: 'rejected-digest', reason: 'Try another plan', rejectedAtMs: 11 })
    expect(store.rejectedDrafts('watcher')).toEqual([{
      attemptId: 'rejected-draft-1', watcherId: 'watcher', digest: 'rejected-digest', reason: 'Try another plan', rejectedAtMs: 11
    }])

    const unreportedOverrun: OverrunRecord = {
      attemptId: 'implementer-1', watcherId: 'watcher', revision: 1, taskKey: 'task-one',
      observedPaths: ['src/file.ts'], outsidePaths: [], unreportedPaths: ['src/file.ts'],
      code: 'unreported-observed-change', recordedAtMs: 12
    }
    const overrun: OverrunRecord = {
      ...unreportedOverrun, observedPaths: ['src/file.ts', 'README.md'], outsidePaths: ['README.md'],
      code: 'observed-change-outside-write-territory', recordedAtMs: 13
    }
    store.recordOverrun(unreportedOverrun)
    store.recordOverrun(overrun)
    expect(store.overruns('watcher')).toEqual([overrun])
    store.recordOverrun({ ...unreportedOverrun, recordedAtMs: 14 })
    expect(store.overruns('watcher')).toEqual([overrun])

    const repair: RepairPlannerReport = {
      repair: { upsertTasks: [{
        taskKey: 'task-two', title: 'Two', spec: 'Second task', deps: ['task-one'],
        criteria: [{ body: 'It is complete', shellCheckable: false, checkCommand: null }], territory: ['src/**']
      }], dropTaskKeys: [] },
      assumptions: []
    }
    const acceptedRepair: AcceptedReport = {
      attemptId: 'repair-1', watcherId: 'watcher', dispatchId: 'repair-dispatch-1', role: 'planner',
      report: repair, digest: reportDigest(repair), acceptedAtMs: 13
    }
    expect(store.accept(acceptedRepair)).toBe(true)
    const repaired = store.applyRepair('watcher', 1, 1, 'repair-1', acceptedRepair.digest)
    expect(repaired.plan.plan.tasks.map(task => task.taskKey)).toEqual(['task-one', 'task-two'])
    expect(repaired.digest).toBe(reportDigest(repaired.plan))
    expect(store.repairs('watcher')).toEqual([{
      watcherId: 'watcher', revision: 1, ordinal: 1, attemptId: 'repair-1', beforeDigest: 'revision-digest-v1',
      afterDigest: repaired.digest, touchedTaskKeys: ['task-two'], patch: repair, appliedAtMs: expect.any(Number)
    }])
    expect(store.applyRepair('watcher', 1, 1, 'repair-1', acceptedRepair.digest)).toEqual(repaired)
    expect(store.repairs('watcher')).toHaveLength(1)

    closes.pop()?.()
    const reopened = createObjectiveStore(context)
    expect(reopened.checks('watcher')).toEqual([check])
    expect(reopened.verdicts('watcher')).toEqual([verdict])
    expect(reopened.landings('watcher')).toEqual([landing])
    expect(reopened.rejectedDrafts('watcher')).toHaveLength(1)
    expect(reopened.overruns('watcher')).toEqual([overrun])
    expect(reopened.repairs('watcher')).toHaveLength(1)
    closes.pop()?.()

    const checkDb = new Database(storeFile)
    try {
      checkDb.exec('PRAGMA foreign_keys = ON')
      expect(checkDb.query('PRAGMA user_version').get()).toEqual({ user_version: 2 })
      expect(checkDb.query('PRAGMA foreign_key_check').all()).toEqual([])
      expect(checkDb.query("PRAGMA foreign_key_list('report')").all()).toContainEqual(expect.objectContaining({ table: 'issued' }))
      checkDb.exec('PRAGMA user_version = 3')
    } finally {
      checkDb.close()
    }

    const future = createObjectiveStore(context)
    expect(() => future.issue({
      attemptId: 'write-to-newer-store', watcherId: 'watcher', role: 'planner', revision: null,
      taskKey: null, reportPath: '/future.json', issuedAtMs: 14
    })).toThrow('read-only')
    closes.pop()?.()
  } finally {
    for (const close of closes.splice(0).reverse()) close()
    rmSync(home, { recursive: true, force: true })
  }
})
