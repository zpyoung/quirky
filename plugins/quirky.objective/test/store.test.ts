import { expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PluginContext, StoreMigration } from '@quirky/protocol'
import { openPluginStore } from '../../../packages/daemon/src/plugins/stores'
import { createObjectiveStore, type AcceptedReport, type CheckRecord, type Issued, type LandingRecord, type OverrunRecord, type VerdictRecord } from '../src/store'
import { captureFolderObservation, isTaskBaseline } from '../src/folder-workspace'
import type { TaskBaseline } from '../src/folder-workspace'
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
function seedV3Store(file: string): void {
  const db = new Database(file)
  try {
    db.exec(`
      CREATE TABLE issued (
        attempt_id TEXT PRIMARY KEY, watcher_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('planner','implementer','reviewer','integrator')),
        revision INTEGER, task_key TEXT, report_path TEXT NOT NULL, issued_at_ms INTEGER NOT NULL,
        planner_mode TEXT, baseline_tree TEXT, content_identity TEXT
      );
      CREATE TABLE landing (
        watcher_id TEXT NOT NULL,
        rung TEXT NOT NULL CHECK (rung IN ('files-on-disk','committed-local-branch','pushed-ref','hosted-review')),
        content_identity TEXT NOT NULL, attempt_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        recorded_at_ms INTEGER NOT NULL, PRIMARY KEY (watcher_id, rung, content_identity)
      );
    `)
    db.query('INSERT INTO issued VALUES (?,?,?,?,?,?,?,?,?,?)').run(
      'legacy-git', 'watcher', 'implementer', 1, 'task-one', '/legacy-report.json', 1,
      null, 'legacy-tree', 'objective-tree:legacy-tree'
    )
    const insertLanding = db.query('INSERT INTO landing VALUES (?,?,?,?,?,?)')
    insertLanding.run('watcher', 'committed-local-branch', 'local-tree', 'legacy-git', JSON.stringify({ branch: 'work' }), 2)
    insertLanding.run('watcher', 'pushed-ref', 'pushed-tree', 'legacy-git', JSON.stringify({ ref: 'refs/heads/work' }), 3)
    insertLanding.run('watcher', 'hosted-review', 'review-tree', 'legacy-git', JSON.stringify({ reviewId: 'review-1' }), 4)
    db.exec('PRAGMA user_version = 3')
  } finally {
    db.close()
  }
}

test('migrates v1 store rows cleanly to v4 schema and persists checks, verdicts, landings, overruns, draft rejections, and repairs', () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-store-v4-'))
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
    expect(() => store.accept({ attemptId: 'never-issued', watcherId: 'watcher', dispatchId: 'unowned-dispatch',
      role: 'planner', report: plan, digest: reportDigest(plan), acceptedAtMs: 0 })).toThrow(/FOREIGN KEY/)
    expect(store.report('never-issued')).toBeNull()
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
    expect(reopened.issued('watcher')).toContainEqual(implementer)
    expect(reopened.issued('watcher')).toContainEqual({
      attemptId: 'draft-v1', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
      reportPath: '/report-v1.json', issuedAtMs: 1
    })
    expect(reopened.repairs('watcher')).toHaveLength(1)
    closes.pop()?.()

    const checkDb = new Database(storeFile)
    try {
      checkDb.exec('PRAGMA foreign_keys = ON')
      expect(checkDb.query('PRAGMA user_version').get()).toEqual({ user_version: 4 })
      expect(checkDb.query('PRAGMA foreign_key_check').all()).toEqual([])
      expect(checkDb.query("PRAGMA foreign_key_list('report')").all()).toContainEqual(expect.objectContaining({ table: 'issued' }))
      checkDb.exec('PRAGMA user_version = 5')
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
test('v4 adds durable immutable folder baselines and preserves v3 remote landing rows across reopen', async () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-store-v4-baseline-'))
  const dataDir = join(home, 'data')
  const storeDir = join(home, 'plugin-data', 'quirky.objective')
  const workspace = join(home, 'workspace')
  mkdirSync(storeDir, { recursive: true })
  mkdirSync(join(workspace, 'src'), { recursive: true })
  writeFileSync(join(workspace, 'src', 'result.txt'), 'dispatch-time bytes')
  const storeFile = join(storeDir, 'store.db')
  seedV3Store(storeFile)

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

  const remoteLandings: LandingRecord[] = [
    { watcherId: 'watcher', rung: 'committed-local-branch', contentIdentity: 'local-tree', attemptId: 'legacy-git', payload: { branch: 'work' }, recordedAtMs: 2 },
    { watcherId: 'watcher', rung: 'pushed-ref', contentIdentity: 'pushed-tree', attemptId: 'legacy-git', payload: { ref: 'refs/heads/work' }, recordedAtMs: 3 },
    { watcherId: 'watcher', rung: 'hosted-review', contentIdentity: 'review-tree', attemptId: 'legacy-git', payload: { reviewId: 'review-1' }, recordedAtMs: 4 }
  ]

  try {
    const baseline: TaskBaseline = await captureFolderObservation(workspace)
    expect(isTaskBaseline(baseline)).toBe(true)
    const issued: Issued = {
      attemptId: 'folder-dispatch', watcherId: 'watcher', role: 'implementer', revision: 1, taskKey: 'task-one',
      reportPath: '/folder-report.json', issuedAtMs: 5, contentIdentity: baseline.contentIdentity, baseline
    }
    const store = createObjectiveStore(context)
    expect(store.issued('watcher')).toEqual([{
      attemptId: 'legacy-git', watcherId: 'watcher', role: 'implementer', revision: 1, taskKey: 'task-one',
      reportPath: '/legacy-report.json', issuedAtMs: 1, baselineTree: 'legacy-tree', contentIdentity: 'objective-tree:legacy-tree'
    }])
    expect(store.landings('watcher')).toEqual(remoteLandings)
    store.issue(issued)
    expect(store.issued('watcher')).toContainEqual(issued)
    store.issue(issued)

    const mutableBaseline = await captureFolderObservation(workspace)
    const preservedBaseline = structuredClone(mutableBaseline)
    store.issue({ ...issued, attemptId: 'mutable-folder-dispatch', baseline: mutableBaseline })
    mutableBaseline.entries[0].digest = '0'.repeat(64)
    expect(store.issued('watcher').find(row => row.attemptId === 'mutable-folder-dispatch')?.baseline)
      .toEqual(preservedBaseline)

    const invalidBaseline = { ...baseline, contentIdentity: 'objective-folder-v1:' + '0'.repeat(64) }
    expect(isTaskBaseline(invalidBaseline)).toBe(false)
    expect(() => store.issue({ ...issued, baseline: invalidBaseline })).toThrow()
    expect(() => store.issue({ ...issued, attemptId: 'null-baseline', baseline: null })).toThrow()

    const alternateWorkspace = join(home, 'alternate-workspace')
    mkdirSync(alternateWorkspace)
    writeFileSync(join(alternateWorkspace, 'different.txt'), 'different dispatch bytes')
    const alternateBaseline = await captureFolderObservation(alternateWorkspace)
    expect(() => store.issue({ ...issued, baseline: alternateBaseline })).toThrow('Attempt was already issued with different authority')

    closes.pop()?.()
    const reopened = createObjectiveStore(context)
    expect(reopened.issued('watcher')).toContainEqual(issued)
    expect(reopened.landings('watcher')).toEqual(remoteLandings)
    reopened.issue(issued)
    closes.pop()?.()

    const checkDb = new Database(storeFile)
    try {
      expect(checkDb.query('PRAGMA user_version').get()).toEqual({ user_version: 4 })
      expect(checkDb.query("PRAGMA table_info('issued')").all()).toContainEqual(expect.objectContaining({ name: 'baseline_json' }))
      expect(() => checkDb.query('INSERT INTO landing VALUES (?,?,?,?,?,?)').run(
        'watcher', 'merged-into-base', 'unsupported-tree', 'legacy-git', '{}', 5
      )).toThrow()
    } finally {
      checkDb.close()
    }
  } finally {
    for (const close of closes.splice(0).reverse()) close()
    rmSync(home, { recursive: true, force: true })
  }
})

test('corrupt or invalid stored baseline JSON decodes to a null sentinel without Git-baseline fallback', () => {
  const home = mkdtempSync(join(tmpdir(), 'objective-store-corrupt-baseline-'))
  const dataDir = join(home, 'data')
  const storeDir = join(home, 'plugin-data', 'quirky.objective')
  mkdirSync(storeDir, { recursive: true })
  const storeFile = join(storeDir, 'store.db')
  seedV3Store(storeFile)

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
    createObjectiveStore(context)
    closes.pop()?.()

    const corruptDb = new Database(storeFile)
    try {
      corruptDb.query('UPDATE issued SET baseline_json=?, baseline_tree=? WHERE attempt_id=?')
        .run('{', 'legacy-tree', 'legacy-git')
      corruptDb.query(`INSERT INTO issued
        (attempt_id, watcher_id, role, revision, task_key, report_path, issued_at_ms, planner_mode,
          baseline_tree, content_identity, baseline_json)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        'invalid-baseline-json', 'watcher', 'implementer', 1, 'task-one', '/invalid-report.json', 2,
        null, 'another-legacy-tree', 'objective-tree:another-legacy-tree',
        JSON.stringify({ kind: 'folder', version: 1, contentIdentity: 'objective-folder-v1:' + '0'.repeat(64), entries: [] })
      )
    } finally {
      corruptDb.close()
    }

    const reopened = createObjectiveStore(context)
    const issuedRows = reopened.issued('watcher')
    const corrupt = issuedRows.find(row => row.attemptId === 'legacy-git')
    const invalid = issuedRows.find(row => row.attemptId === 'invalid-baseline-json')
    expect(corrupt).toMatchObject({ baseline: null, baselineTree: 'legacy-tree' })
    expect(invalid).toMatchObject({ baseline: null, baselineTree: 'another-legacy-tree' })
    expect(isTaskBaseline(corrupt?.baseline)).toBe(false)
    expect(isTaskBaseline(invalid?.baseline)).toBe(false)
    expect(() => reopened.issue({
      attemptId: 'corrupt-sentinel', watcherId: 'watcher', role: 'implementer', revision: 1, taskKey: 'task-one',
      reportPath: '/corrupt-report.json', issuedAtMs: 9, baseline: corrupt?.baseline ?? null
    })).toThrow()
    closes.pop()?.()

    const recheck = createObjectiveStore(context)
    expect(recheck.issued('watcher').find(row => row.attemptId === 'legacy-git')?.baseline).toBeNull()
    closes.pop()?.()
  } finally {
    for (const close of closes.splice(0).reverse()) close()
    rmSync(home, { recursive: true, force: true })
  }
})
