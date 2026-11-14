import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import type { PluginContext, PluginStore, RunOptions, StoreValue } from '@quirky/protocol'
import { createObjectiveStore } from '../src/store'
import { createObjectiveHooks } from '../src/hooks'
import type { ObjectiveJournalEntry, ObjectiveSnapshot } from '../src/decide'

const cleanup: (() => void)[] = []
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close() })

function rig() {
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
    kindPayload: { objectiveText: 'Add multiply', tier: 'express' as const, landingBar: 'files-on-disk' as const, writeTerritory: ['**'], roleAgents: {}, gates: [], worktree: 'id:wt', lanesEnabled: true, maxConcurrency: 3 }
  }
  const context = {
    dataDir,
    openStore: (migrations: string[]) => { for (const migration of migrations) db.exec(migration); return sql },
    call: async (method: string) => {
      if (method !== 'quirky.heimdall/inspect') throw new Error(`unexpected call ${method}`)
      return [{ enrollment, journal: [{ seq: 1, kind: 'attempt', attemptId: 'attempt', state: 'running', dispatchId: 'dispatch', action: { kind: 'dispatch-planner' } }] }]
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
  return { root, path, store, submit, hooks, enrollment }
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
})
