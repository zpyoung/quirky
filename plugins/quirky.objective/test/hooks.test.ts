import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { PluginContext, PluginStore, RunOptions, StoreMigration, StoreValue } from '@quirky/protocol'
import { createObjectiveStore } from '../src/store'
import { createObjectiveHooks } from '../src/hooks'
import { reportDigest } from '../src/plan'
import type { ObjectiveAction, ObjectiveJournalEntry, ObjectiveSnapshot } from '../src/decide'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function rig(tier: 'express' | 'standard' = 'express') {
  const root = mkdtempSync(join(tmpdir(), 'objective-submission-'))
  cleanup.push(() => rmSync(root, { recursive: true, force: true }))
  const dataDir = mkdtempSync(join(tmpdir(), 'objective-data-'))
  cleanup.push(() => rmSync(dataDir, { recursive: true, force: true }))
  const db = new Database(':memory:')
  cleanup.push(() => db.close())
  const sql: PluginStore = {
    version: 1,
    exec: text => { db.exec(text) },
    run: (text, ...args) => {
      const result = db.query(text).run(...args.map(value => typeof value === 'boolean' ? Number(value) : value))
      return { changes: result.changes, lastInsertRowid: Number(result.lastInsertRowid) }
    },
    get<T>(text: string, ...args: StoreValue[]) { return db.query(text).get(...args.map(value => typeof value === 'boolean' ? Number(value) : value)) as T | null },
    all<T>(text: string, ...args: StoreValue[]) { return db.query(text).all(...args.map(value => typeof value === 'boolean' ? Number(value) : value)) as T[] },
    transaction: work => db.transaction(work)()
  }
  const enrollment = {
    watcherId: 'watcher', kind: 'objective', workspacePath: root, worktreeId: 'wt',
    capabilities: { plan: 'gated' as const, implement: 'on' as const },
    kindPayload: { objectiveText: 'Add multiply', tier, landingBar: 'files-on-disk' as const, writeTerritory: ['**'], roleAgents: {}, gates: [], worktree: 'id:wt', lanesEnabled: true, maxConcurrency: 3 }
  }
  const journal: ObjectiveJournalEntry[] = [{ seq: 1, kind: 'attempt', attemptId: 'attempt', state: 'running', dispatchId: 'dispatch', action: { kind: 'dispatch-planner' } }]
  const calls: string[] = []
  const context = {
    dataDir,
    error: (_kind: string, message: string) => new Error(message),
    openStore: (migrations: StoreMigration[]) => {
      db.transaction(() => { for (const migration of migrations) typeof migration === 'string' ? db.exec(migration) : migration(sql) })()
      return sql
    },
    call: async (method: string) => {
      calls.push(method)
      if (method === 'quirky.heimdall/reconcile') return {}
      if (method !== 'quirky.heimdall/inspect') throw new Error(`unexpected call ${method}`)
      return [{ enrollment, journal }]
    },
    process: {
      async run(argv: readonly string[], options?: RunOptions) {
        const result = Bun.spawnSync([...argv], { cwd: options?.cwd, env: options?.env, stdout: 'pipe', stderr: 'pipe' })
        return { stdout: result.stdout, stdoutText: result.stdout.toString(), stderr: result.stderr.toString(),
          exitCode: result.exitCode, signal: null, durationMs: 0 }
      }
    }
  } as unknown as PluginContext
  const store = createObjectiveStore(context)
  const path = join(root, '.quirky', 'objective', 'watcher', 'attempt.json')
  mkdirSync(join(root, '.quirky', 'objective', 'watcher'), { recursive: true })
  store.issue({ attemptId: 'attempt', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null, reportPath: path, issuedAtMs: 1 })
  const hooks = createObjectiveHooks(context, store)
  const submit = (reportPath?: string, outcome = 'succeeded') => hooks.submission({
    enrollment,
    submission: { runId: 'run', taskId: 'task', dispatchId: 'dispatch', type: 'worker_done', subject: 'Plan', body: 'Plan', payload: { outcome, ...(reportPath === undefined ? {} : { reportPath }) } }
  })
  return { root, path, context, store, submit, hooks, enrollment, journal, calls }
}

const report = {
  plan: { tasks: [{ taskKey: 'multiply', title: 'Add multiply', spec: 'Export multiply', deps: [], territory: ['math.ts'], criteria: [{ body: 'Export exists', shellCheckable: true, checkCommand: 'grep -q multiply math.ts' }] }] },
  assumptions: []
}

test('submission rejects missing, aliased, oversized and malformed reports without settling an attempt', async () => {
  const r = rig()
  expect(await r.submit()).toMatchObject({ kind: 'rejected', code: 'missing-report' })
  expect(await r.submit(join(r.root, 'elsewhere.json'))).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  writeFileSync(r.path, JSON.stringify(report))
  const alias = join(r.root, 'alias.json')
  symlinkSync(r.path, alias)
  expect(await r.submit(alias)).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  rmSync(r.path)
  symlinkSync(alias, r.path)
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-path-mismatch' })
  rmSync(r.path)
  writeFileSync(r.path, 'x'.repeat(262145))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-too-large' })
  writeFileSync(r.path, '{')
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'invalid-report' })
  writeFileSync(r.path, JSON.stringify({ plan: { tasks: [] }, assumptions: [] }))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'invalid-report', reason: expect.stringContaining('tasks') })
  expect(r.store.reports('watcher')).toEqual([])
  expect(await r.submit(undefined, 'failed')).toEqual({ kind: 'accepted' })
})

test('an accepted report is immutable but the same digest is safe to submit again', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const accepted = r.store.reports('watcher')
  expect(accepted[0]?.report).toEqual(report)
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  expect(r.store.reports('watcher')).toEqual(accepted)
  writeFileSync(r.path, JSON.stringify({ ...report, assumptions: [{ claim: 'A changed report', dependentTaskKeys: ['multiply'] }] }))
  expect(await r.submit(r.path)).toMatchObject({ kind: 'rejected', code: 'report-already-accepted' })
  expect(r.store.reports('watcher')).toEqual(accepted)
})

test('deciding and stopping trust reports accepted after the tree snapshot was read', async () => {
  const r = rig()
  const snapshot: ObjectiveSnapshot = { freshness: 'live', contentIdentity: 'tree:before', observedAtMs: 1,
    world: { planMode: 'gated', revision: null, reports: [], issued: r.store.issued('watcher') } }
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const journal: ObjectiveJournalEntry[] = [1, 2, 3].map(seq => ({
    seq, kind: 'attempt', attemptId: seq === 3 ? 'attempt' : `failed-${seq}`, state: 'settled',
    effect: seq === 3 ? 'landed' : 'not-landed', action: { kind: 'dispatch-planner' }
  }))
  expect(r.hooks.stop({ snapshot, journal, enrollment: r.enrollment })).toBeNull()
  expect(r.hooks.decide({ snapshot, journal, enrollment: r.enrollment })).toMatchObject({
    action: { kind: 'activate-plan', plannerAttemptId: 'attempt', contentIdentity: 'tree:before' }
  })
})

test('tree identity includes ignored tracked files and newly staged ignored files without changing the real index', async () => {
  const r = rig()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', r.root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'pipe', stderr: 'pipe'
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
    return result.stdout.toString().trim()
  }
  git('init', '-q')
  writeFileSync(join(r.root, '.gitignore'), '*.ts\n.quirky/\n')
  writeFileSync(join(r.root, 'math.ts'), 'export const x = 1\n')
  git('add', '-f', '.gitignore', 'math.ts')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  const indexPath = git('rev-parse', '--git-path', 'index')
  const index = () => readFileSync(isAbsolute(indexPath) ? indexPath : join(r.root, indexPath))
  const originalIndex = index()
  const before = await r.hooks.read({ enrollment: r.enrollment })
  expect(r.hooks.pace({ snapshot: before, journal: [] })).toBe('rapid')
  writeFileSync(join(r.root, 'math.ts'), 'export const x = 2\n')
  const changed = await r.hooks.read({ enrollment: r.enrollment })
  expect(changed.contentIdentity).not.toBe(before.contentIdentity)
  expect(index()).toEqual(originalIndex)
  writeFileSync(join(r.root, 'new.ts'), 'export const y = 1\n')
  git('add', '-f', 'new.ts')
  const stagedIndex = index()
  const staged = await r.hooks.read({ enrollment: r.enrollment })
  expect(staged.contentIdentity).not.toBe(changed.contentIdentity)
  writeFileSync(join(r.root, 'new.ts'), 'export const y = 2\n')
  expect((await r.hooks.read({ enrollment: r.enrollment })).contentIdentity).not.toBe(staged.contentIdentity)
  expect(index()).toEqual(stagedIndex)
  const failedPlanners: ObjectiveJournalEntry[] = [1, 2, 3].map(seq => ({
    seq, kind: 'attempt', attemptId: seq === 3 ? 'attempt' : `failed-${seq}`, state: 'settled',
    effect: 'not-landed', action: { kind: 'dispatch-planner' }
  }))
  expect(r.hooks.pace({ snapshot: before, journal: failedPlanners })).toBe('idle')
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  failedPlanners[2] = { ...failedPlanners[2]!, effect: 'landed' }
  expect(r.hooks.pace({ snapshot: before, journal: failedPlanners })).toBe('rapid')
})

test('draft rejection checks the digest, persists feedback and cannot reject the same draft twice', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.journal.push({ seq: 2, kind: 'attempt', attemptId: 'attempt', state: 'settled', effect: 'landed', action: { kind: 'dispatch-planner' } })
  const digest = r.store.report('attempt')!.digest
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher', digest: 'wrong' })).rejects.toThrow('draft-digest-mismatch')
  expect(r.store.rejectedDrafts('watcher')).toEqual([])
  expect(await r.hooks.rejectDraft({ watcherId: 'watcher', digest, reason: 'Use a narrower plan.' }))
    .toEqual({ rejected: true, attemptId: 'attempt', digest, reason: 'Use a narrower plan.' })
  expect(r.store.rejectedDrafts('watcher')[0]).toMatchObject({ attemptId: 'attempt', digest, reason: 'Use a narrower plan.' })
  expect(r.calls.filter(method => method === 'quirky.heimdall/reconcile')).toEqual(['quirky.heimdall/reconcile'])
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher' })).rejects.toThrow('no-pending-draft')
})

test('draft rejection cannot revoke an already approved revision', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.journal.push({ seq: 2, kind: 'attempt', attemptId: 'attempt', state: 'settled', effect: 'landed', action: { kind: 'dispatch-planner' } })
  const revision = r.store.activate('watcher', 'attempt', r.store.report('attempt')!.digest)
  await expect(r.hooks.rejectDraft({ watcherId: 'watcher' })).rejects.toThrow('no-pending-draft')
  expect(r.store.revision('watcher')).toEqual(revision)
  expect(r.store.rejectedDrafts('watcher')).toEqual([])
})

test('observed territory overruns remain visible even when the worker reports the forbidden path', async () => {
  const r = rig()
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', '-C', r.root, ...args], {
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'pipe', stderr: 'pipe'
    })
    if (result.exitCode !== 0) throw new Error(result.stderr.toString())
  }
  git('init', '-q')
  writeFileSync(join(r.root, 'math.ts'), 'export const multiply = (a, b) => a * b\n')
  git('add', 'math.ts')
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'init')
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  r.store.activate('watcher', 'attempt', r.store.report('attempt')!.digest)
  r.enrollment.kindPayload.writeTerritory = ['math.ts']
  const baseline = await r.hooks.read({ enrollment: r.enrollment })
  const workerPath = join(r.root, '.quirky', 'objective', 'watcher', 'worker-attempt.json')
  r.store.issue({ attemptId: 'worker-attempt', watcherId: 'watcher', role: 'implementer', revision: 1,
    taskKey: 'multiply', reportPath: workerPath, issuedAtMs: 2, baselineTree: baseline.contentIdentity.slice('objective-tree:'.length) })
  r.journal.splice(0, r.journal.length, { seq: 2, kind: 'attempt', attemptId: 'worker-attempt', state: 'running',
    dispatchId: 'dispatch', action: { kind: 'dispatch-node', revision: 1, taskKey: 'multiply' } })
  writeFileSync(join(r.root, 'outside.txt'), 'Outside the assigned write territory.\n')
  writeFileSync(workerPath, JSON.stringify({ taskKey: 'multiply', summary: 'Changed outside territory.',
    filesModified: ['outside.txt'], criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass', note: 'Implemented.' }] }))
  expect(await r.submit(workerPath)).toMatchObject({ kind: 'rejected', code: 'observed-change-outside-write-territory',
    reason: expect.stringContaining('outside.txt') })
  expect(r.store.overruns('watcher')).toContainEqual(expect.objectContaining({
    attemptId: 'worker-attempt', code: 'observed-change-outside-write-territory', outsidePaths: ['outside.txt']
  }))
})

test('reconciles persisted local effects only with the matching action authority', async () => {
  const r = rig()
  writeFileSync(r.path, JSON.stringify(report))
  expect(await r.submit(r.path)).toEqual({ kind: 'accepted' })
  const digest = r.store.report('attempt')!.digest
  const resolve = (action: ObjectiveAction & { contentIdentity: string }, attemptId = 'action-attempt') =>
    r.hooks.resolveOutcome({ attempt: { attemptId, action }, enrollment: r.enrollment })
  const activation = { kind: 'activate-plan', capability: 'plan', visibility: 'local', recovery: 'replay-safe',
    evidenceKey: 'activate-plan:attempt', plannerAttemptId: 'attempt', digest, contentIdentity: 'objective-tree:verified' } as const
  expect(resolve(activation)).toBeNull()
  r.store.activate('watcher', 'attempt', digest)
  expect(resolve(activation)).toEqual({ effect: 'landed' })
  expect(resolve({ ...activation, digest: 'different' })).toBeNull()

  const landing = { kind: 'record-landing', capability: 'land', visibility: 'local', recovery: 'replay-safe',
    evidenceKey: 'files-on-disk:objective-tree:verified', revision: 1, contentIdentity: 'objective-tree:verified' } as const
  expect(resolve(landing)).toBeNull()
  r.store.recordLanding({ watcherId: 'watcher', rung: 'files-on-disk', contentIdentity: landing.contentIdentity,
    attemptId: 'action-attempt', payload: { revision: 1 }, recordedAtMs: 10 })
  expect(resolve(landing)).toEqual({ effect: 'landed' })
  expect(resolve({ ...landing, revision: 2 })).toBeNull()
  const commit = { ...landing, kind: 'commit-local-branch', capability: 'land',
    evidenceKey: 'committed-local-branch:objective-tree:verified:main:before', branch: 'main', headSha: 'before' } as const
  expect(resolve(commit)).toBeNull()
  r.store.recordLanding({ watcherId: 'watcher', rung: 'committed-local-branch', contentIdentity: landing.contentIdentity,
    attemptId: 'commit-attempt', payload: { revision: 1, headSha: 'after', committedPaths: ['math.ts'] }, recordedAtMs: 11 })
  expect(resolve(commit, 'commit-attempt')).toEqual({ effect: 'landed' })
  expect(resolve(commit, 'other-attempt')).toBeNull()
})

test('lands a verification-only repair after a historical block and stops terminally', async () => {
  const r = rig('standard')
  async function runGit(...args: string[]): Promise<void> {
    const result = await r.context.process.run(['git', ...args], { cwd: r.root })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  await runGit('init', '-q')
  await runGit('config', 'user.name', 'Fixture')
  await runGit('config', 'user.email', 'fixture@example.test')
  await runGit('config', 'commit.gpgsign', 'false')
  mkdirSync(join(r.root, 'src'), { recursive: true })
  writeFileSync(join(r.root, 'src', 'main.ts'), 'export const value = 1\n')
  await runGit('add', '-A')
  await runGit('commit', '-m', 'baseline')
  const snapshot = await r.hooks.read({ enrollment: r.enrollment })
  const contentIdentity = snapshot.contentIdentity
  r.journal.splice(0)

  const initialPlan = {
    plan: { tasks: [{
      taskKey: 'implement', title: 'Existing implementation', spec: 'No source changes are needed.',
      deps: [], territory: ['src/**'],
      criteria: [{ body: 'The existing source is ready.', shellCheckable: false, checkCommand: null }]
    }] },
    assumptions: []
  }
  const initialDigest = reportDigest(initialPlan)
  r.store.issue({
    attemptId: 'initial-plan', watcherId: 'watcher', role: 'planner', revision: null, taskKey: null,
    reportPath: r.path, issuedAtMs: 1
  })
  r.store.accept({
    attemptId: 'initial-plan', watcherId: 'watcher', dispatchId: 'initial-plan-dispatch', role: 'planner',
    report: initialPlan, digest: initialDigest, acceptedAtMs: 1
  })
  r.store.activate('watcher', 'initial-plan', initialDigest)

  function settleTask(attemptId: string, taskKey: string, seq: number, repairEpisode?: number): void {
    const dispatchId = `${attemptId}-dispatch`
    const taskReport = {
      taskKey, summary: 'Verified without modifying files.', filesModified: [],
      criteriaSelfAssessment: [{ criterionIndex: 0, result: 'pass' as const, note: 'Verified.' }]
    }
    r.store.issue({
      attemptId, watcherId: 'watcher', role: 'implementer', revision: 1, taskKey,
      reportPath: r.path, issuedAtMs: seq
    })
    r.store.accept({
      attemptId, watcherId: 'watcher', dispatchId, role: 'implementer',
      report: taskReport, digest: reportDigest(taskReport), acceptedAtMs: seq
    })
    r.journal.push({
      seq, kind: 'attempt', attemptId, state: 'settled', effect: 'landed', dispatchId,
      action: {
        kind: 'dispatch-node', revision: 1, taskKey,
        ...(repairEpisode === undefined ? {} : { repairEpisode })
      }
    })
  }
  settleTask('implementation-completed', 'implement', 1)

  r.store.issue({
    attemptId: 'historical-review', watcherId: 'watcher', role: 'reviewer', revision: 1, taskKey: null,
    reportPath: r.path, issuedAtMs: 2, contentIdentity
  })
  r.store.acceptVerdict({
    attemptId: 'historical-review', watcherId: 'watcher', dispatchId: 'historical-review-dispatch',
    revision: 1, role: 'reviewer', contentIdentity, verdict: 'block',
    criteriaResults: [], checksRun: [], summary: 'The initial review blocked.', digest: 'historical-review-digest', acceptedAtMs: 2
  })
  r.journal.push({
    seq: 2, kind: 'attempt', attemptId: 'historical-review', state: 'settled', effect: 'landed',
    dispatchId: 'historical-review-dispatch',
    action: {
      kind: 'dispatch-reviewer', revision: 1, contentIdentity,
      evidenceKey: `review:1:reviewer:${contentIdentity}:1`
    }
  })
  const verificationCommand = 'test -f src/main.ts'
  r.store.recordCheck({
    attemptId: 'old-verification-check', watcherId: 'watcher', revision: 1, kind: 'criterion',
    targetKey: 'verification:0', contentIdentity, command: verificationCommand, status: 'passed',
    exitCode: 0, timedOut: false, stdoutTail: '', stderrTail: '', checkedAtMs: 3
  })
  r.journal.push({
    seq: 3, kind: 'attempt', attemptId: 'old-verification-check', state: 'settled', effect: 'landed',
    action: {
      kind: 'run-check', revision: 1, taskKey: 'verification', criterionIndex: 0, command: verificationCommand,
      contentIdentity, evidenceKey: `check:1:verification:0:${contentIdentity}`
    }
  })
  expect(r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment }).action).toMatchObject({
    kind: 'dispatch-planner', plannerMode: 'repair', repairEpisode: 1
  })

  const repairReport = {
    repair: {
      upsertTasks: [{
        taskKey: 'verification', title: 'Verify existing source', spec: 'Run the existing-file check only.',
        deps: ['implement'], territory: ['src/**'],
        criteria: [{ body: 'The source file exists.', shellCheckable: true, checkCommand: verificationCommand }]
      }],
      dropTaskKeys: []
    },
    assumptions: []
  }
  const repairDigest = reportDigest(repairReport)
  r.store.issue({
    attemptId: 'repair-planner', watcherId: 'watcher', role: 'planner', revision: 1, taskKey: null,
    plannerMode: 'repair', reportPath: r.path, issuedAtMs: 4
  })
  r.store.accept({
    attemptId: 'repair-planner', watcherId: 'watcher', dispatchId: 'repair-planner-dispatch', role: 'planner',
    report: repairReport, digest: repairDigest, acceptedAtMs: 4
  })
  r.store.applyRepair('watcher', 1, 1, 'repair-planner', repairDigest)
  const repair = r.store.repairs('watcher')[0]!
  settleTask('verification-completed', 'verification', 4, 1)
  const checkDecision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(checkDecision.action).toMatchObject({
    kind: 'run-check', taskKey: 'verification', evidenceKey: `check:1:verification:0:${contentIdentity}:r1`
  })
  if (checkDecision.action?.kind !== 'run-check') throw new Error('Expected a verification run-check action')
  expect(await r.hooks.execute({
    action: checkDecision.action, enrollment: r.enrollment, attemptId: 'verification-check'
  })).toEqual({ effect: 'landed' })
  r.journal.push({
    seq: 5, kind: 'attempt', attemptId: 'verification-check', state: 'settled', effect: 'landed',
    dispatchId: 'verification-check-dispatch', action: checkDecision.action
  })
  const reviewDecision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(reviewDecision.action).toMatchObject({ kind: 'dispatch-reviewer', ordinal: 2 })
  if (reviewDecision.action?.kind !== 'dispatch-reviewer') throw new Error('Expected a fresh reviewer action')
  const freshReviewAction = reviewDecision.action
  r.store.issue({
    attemptId: 'fresh-review', watcherId: 'watcher', role: 'reviewer', revision: 1, taskKey: null,
    reportPath: r.path, issuedAtMs: repair.appliedAtMs + 1, contentIdentity
  })
  r.store.acceptVerdict({
    attemptId: 'fresh-review', watcherId: 'watcher', dispatchId: 'fresh-review-dispatch',
    revision: 1, role: 'reviewer', contentIdentity, verdict: 'approve',
    criteriaResults: [
      { taskKey: 'implement', criterionIndex: 0, result: 'pass', note: 'Verified.' },
      { taskKey: 'verification', criterionIndex: 0, result: 'pass', note: 'Verified.' }
    ],
    checksRun: [], summary: 'Approved after repair.', digest: 'fresh-review-digest', acceptedAtMs: repair.appliedAtMs + 1
  })
  r.journal.push({
    seq: 6, kind: 'attempt', attemptId: 'fresh-review', state: 'settled', effect: 'landed',
    dispatchId: 'fresh-review-dispatch', action: freshReviewAction
  })

  expect((await r.hooks.read({ enrollment: r.enrollment })).contentIdentity).toBe(contentIdentity)
  const decision = r.hooks.decide({ snapshot, journal: r.journal, enrollment: r.enrollment })
  expect(decision.action).toMatchObject({ kind: 'record-landing', contentIdentity })
  if (decision.action?.kind !== 'record-landing') throw new Error('Expected a record-landing action')
  expect(await r.hooks.execute({
    action: decision.action, enrollment: r.enrollment, attemptId: 'record-landing-attempt'
  })).toEqual({ effect: 'landed' })
  expect(r.store.verdicts('watcher')).toContainEqual(expect.objectContaining({
    attemptId: 'historical-review', verdict: 'block'
  }))
  expect(r.store.landings('watcher')).toHaveLength(1)
  expect(r.hooks.stop({ snapshot, journal: r.journal, enrollment: r.enrollment })).toEqual({
    kind: 'terminal', state: 'landed', reason: 'files-on-disk landing bar reached'
  })
}, 30_000)
