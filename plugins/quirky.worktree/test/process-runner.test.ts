import { afterEach, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFakeGit, useTestGit, type FakeGit } from '@quirky/git/testing'
import {
  PLUGIN_API_VERSION,
  pluginApiCompatibilityError,
  type EffectiveHooks,
  type GitHubWorktreeSource,
  type PluginStore,
  type ProcessRunner,
  type Repo,
  type RunOptions,
  type RunResult
} from '@quirky/protocol'
import { scanSourceContent } from '../../../scripts/spawn-lint'
import { createWorkspace, prefetchWorktreeCreateBase, type CreateEnv } from '../src/daemon/create'
import {
  addPushRemote,
  planPullRequest,
  removePushRemote,
  restoreBranchConfig,
  restorePullRef,
  type PullRequestPlan,
  snapshotBranchConfig
} from '../src/daemon/github'
import {
  claimPreparedCheckout,
  cleanupActivationPreparedCheckouts,
  cleanupExpiredPreparedCheckouts,
  prepareCheckout
} from '../src/daemon/prepared'
import { KeyedQueue } from '../src/daemon/queue'
import type { CallerIdentity } from '../selector'

const BASE_OID = 'a'.repeat(40)
const OLD_HEAD = 'b'.repeat(40)
const CHANGED_HEAD = 'c'.repeat(40)
const CHANGED_BASE = 'd'.repeat(40)
const OLD_BASE = 'e'.repeat(40)
const OWNER_ID = 'owner-fixture'
const GIT_OUTPUT_LIMIT = 64 * 1024
const PREPARATION_DEADLINE = 86_400_000
const SHORT_DEADLINE = 30_000
const fixtures: Fixture[] = []

afterEach(() => {
  useTestGit(null)
  for (const fixture of fixtures.splice(0)) {
    fixture.db.close()
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

type Fixture = {
  root: string
  repo: Repo
  worktreesRoot: string
  fakeGit: FakeGit
  db: Database
  store: PluginStore
  logs: string[]
  branches: Set<string>
  primaryHead: string
  baseOid: string
}

type RecordedCall = { argv: string[]; options: RunOptions }
type RunnerHandler = (call: RecordedCall) => RunResult | Promise<RunResult>
type FailureHandler = (call: RecordedCall) => RunResult | Promise<RunResult>

function runResult(overrides: Partial<RunResult> = {}): RunResult {
  const stdoutText = overrides.stdoutText ?? ''
  return {
    stdout: overrides.stdout ?? new TextEncoder().encode(stdoutText),
    stdoutText,
    stderr: overrides.stderr ?? '',
    exitCode: overrides.exitCode === undefined ? 0 : overrides.exitCode,
    signal: overrides.signal === undefined ? null : overrides.signal,
    ...(overrides.stopped === undefined ? {} : { stopped: overrides.stopped }),
    ...(overrides.spawnError === undefined ? {} : { spawnError: overrides.spawnError }),
    ...(overrides.truncated === undefined ? {} : { truncated: overrides.truncated }),
    durationMs: overrides.durationMs ?? 1
  }
}

function recordingRunner(handler: RunnerHandler = () => runResult()) {
  const calls: RecordedCall[] = []
  const process: ProcessRunner = {
    run: async (argv, options = {}) => {
      const call = { argv: [...argv], options }
      calls.push(call)
      return handler(call)
    }
  }
  return { process, calls }
}

function stopped(reason: 'timeout' | 'aborted' | 'overflow', exitCode: number | null = null): RunResult {
  return runResult({ exitCode, signal: exitCode === null ? 'SIGKILL' : null, stopped: reason })
}

function makeStore(): { db: Database; store: PluginStore } {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE worktrees (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'git', path TEXT, name TEXT,
      display_name TEXT, comment TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'in-progress',
      pinned INTEGER NOT NULL DEFAULT 0, unread INTEGER NOT NULL DEFAULT 0, parent_id TEXT, created_at INTEGER,
      created_by TEXT NOT NULL DEFAULT 'external', base_ref TEXT, keep_branch INTEGER NOT NULL DEFAULT 0,
      birthtime INTEGER, group_id TEXT, project_group_id TEXT, last_activity_at INTEGER NOT NULL DEFAULT 0,
      instance_id TEXT NOT NULL DEFAULT '', created_root TEXT, linked_pr TEXT, linked_issue TEXT, push_target TEXT,
      manual_order INTEGER NOT NULL DEFAULT 0, sleeping INTEGER NOT NULL DEFAULT 0, sleep_changed_at INTEGER NOT NULL DEFAULT 0,
      cleanup_ignored_fingerprint TEXT, cleanup_ignored_at INTEGER, references_json TEXT NOT NULL DEFAULT '[]',
      archived_at INTEGER, automation_provenance TEXT
    );
    CREATE TABLE prepared_worktrees (
      id TEXT PRIMARY KEY, repo_id TEXT NOT NULL, repo_path TEXT NOT NULL, root_path TEXT NOT NULL,
      base_ref TEXT NOT NULL, base_oid TEXT NOT NULL, path TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE retired_names (repo_id TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (repo_id, name));
    CREATE TABLE worktree_origins (
      worktree_id TEXT NOT NULL, instance_id TEXT NOT NULL, creator_kind TEXT NOT NULL,
      creator_id TEXT, creator_role TEXT NOT NULL, PRIMARY KEY (worktree_id, instance_id)
    );
    CREATE TABLE project_preferences (
      repo_id TEXT PRIMARY KEY, external_visibility TEXT, external_inbox_suppressed INTEGER NOT NULL DEFAULT 0,
      icon TEXT, color TEXT, tracker_project TEXT, shared_directories TEXT NOT NULL DEFAULT '[]'
    );
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE, color TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE worktree_tags (worktree_id TEXT NOT NULL, tag_id TEXT NOT NULL, PRIMARY KEY (worktree_id, tag_id));
  `)
  const store = {
    version: 1,
    run(sql: string, ...params: unknown[]) {
      const info = db.query(sql).run(...params as never[])
      return { changes: info.changes, lastInsertRowid: Number(info.lastInsertRowid) }
    },
    get<T>(sql: string, ...params: unknown[]) {
      return (db.query(sql).get(...params as never[]) ?? null) as T | null
    },
    all<T>(sql: string, ...params: unknown[]) {
      return db.query(sql).all(...params as never[]) as T[]
    },
    exec(sql: string) { db.exec(sql) },
    transaction<T>(work: () => T) { return db.transaction(work)() }
  } as PluginStore
  return { db, store }
}

function makeFixture(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'g2-41-worktree-')))
  const repoPath = join(root, 'repo')
  const worktreesRoot = join(root, 'worktrees')
  mkdirSync(repoPath, { recursive: true })
  mkdirSync(worktreesRoot, { recursive: true })
  writeFileSync(join(repoPath, 'tracked.txt'), 'primary\n')
  const repo = {
    id: 'repo_process_fixture', name: 'process-fixture', displayName: 'Process fixture', groupId: null,
    path: repoPath, kind: 'git', addedAt: Date.now(), defaultBranch: 'main'
  } as Repo
  const { db, store } = makeStore()
  const fixture: Fixture = {
    root, repo, worktreesRoot, fakeGit: createFakeGit(), db, store, logs: [], branches: new Set(),
    primaryHead: BASE_OID, baseOid: BASE_OID
  }
  fixture.fakeGit.addRepo(repoPath)
  const main = fixture.fakeGit.worktreesByRepo.get(repoPath)![0]!
  main.head = BASE_OID
  fixture.fakeGit.listRegistrations = async (path) => (fixture.fakeGit.worktreesByRepo.get(path) ?? []).map((entry) => ({
    ...entry, exists: existsSync(entry.path), prunable: false
  }))
  fixture.fakeGit.listWorktrees = async (path) => (fixture.fakeGit.worktreesByRepo.get(path) ?? []).map((entry) => ({ ...entry }))
  fixture.fakeGit.status = async (cwd) => ({ branch: cwd === repoPath ? 'main' : 'fixture-branch', upstream: null, ahead: 0, behind: 0, files: [] })
  fixture.fakeGit.hasCommits = async () => true
  fixture.fakeGit.getConfig = async () => null
  fixture.fakeGit.setLocalConfig = async () => {}
  fixture.fakeGit.resolveCommit = async (_path, ref) => ref === 'HEAD' ? fixture.primaryHead : fixture.baseOid
  fixture.fakeGit.resolveBaseRef = async (_path, ref) => ref === 'origin/main' ? 'refs/remotes/origin/main' : `refs/heads/${ref}`
  fixture.fakeGit.detectDefaultBase = async () => 'origin/main'
  fixture.fakeGit.refExists = async (_path, ref) => ref === 'refs/remotes/origin/main'
  fixture.fakeGit.fetchRemote = async () => true
  fixture.fakeGit.listRemotes = async () => ['origin']
  fixture.fakeGit.checkRefFormatBranch = async () => true
  fixture.fakeGit.gitUsername = async () => null
  fixture.fakeGit.localBranchExists = async (_path, branch) => fixture.branches.has(branch)
  fixture.fakeGit.remoteBranchExists = async () => false
  fixture.fakeGit.dirtyEntries = async (path) => existsSync(join(path, 'dirty.txt')) ? ['dirty.txt'] : []
  fixture.fakeGit.addNewBranchWorktree = async (_repoPath, path, branch, base) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'tracked.txt'), `checkout at ${base}\n`)
    fixture.fakeGit.worktreesByRepo.get(repoPath)!.push({ path, branch, head: base, isMain: false, locked: null })
    fixture.branches.add(branch)
  }
  fixture.fakeGit.removeWorktree = async (path, worktree, force) => {
    fixture.fakeGit.calls.push({ fn: 'removeWorktree', args: [path, worktree, force] })
    if (existsSync(join(worktree, 'index.lock')) || existsSync(join(worktree, 'dirty.txt'))) {
      throw new Error('worktree contains changes or index.lock')
    }
    rmSync(worktree, { recursive: true, force: true })
    fixture.fakeGit.worktreesByRepo.set(path, (fixture.fakeGit.worktreesByRepo.get(path) ?? []).filter((entry) => entry.path !== worktree))
  }
  fixture.fakeGit.deleteRefIfAt = async (_path, branch, head) => {
    fixture.fakeGit.calls.push({ fn: 'deleteRefIfAt', args: [_path, branch, head] })
    fixture.branches.delete(branch)
    return true
  }
  fixture.fakeGit.compare = async () => ({
    status: 'ready', base: 'origin/main', baseSource: 'detected', message: null,
    headOid: fixture.primaryHead, baseOid: fixture.baseOid,
    mergeBase: fixture.primaryHead, ahead: 0, behind: fixture.primaryHead === fixture.baseOid ? 0 : 1,
    entries: [], added: 0, removed: 0
  })
  useTestGit(fixture.fakeGit)
  fixtures.push(fixture)
  return fixture
}

function gitPolicy(call: RecordedCall, timeoutMs: number): void {
  expect(call.options).toMatchObject({
    timeoutMs, killGraceMs: 2_000, maxOutputBytes: 16 * 1024 * 1024,
    outputMode: 'separate', overflow: 'stop',
    env: { GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1' }
  })
  expect(call.options.cwd).toBeUndefined()
}

function gitArgs(call: RecordedCall): string[] {
  return call.argv[0] === 'git' && call.argv[1] === '-C' ? call.argv.slice(3) : call.argv.slice(1)
}

function preparedEnv(fixture: Fixture, process: ProcessRunner) {
  return { store: fixture.store, ownerId: OWNER_ID, process, log: (message: string) => fixture.logs.push(message) }
}

type PreparedBehavior = {
  add?: 'timeout-clean' | 'timeout-dirty' | 'timeout-unregistered'
  move?: 'timeout-before' | 'timeout-after'
  checkout?: 'timeout-clean' | 'timeout-dirty' | 'timeout-index-lock'
}

function preparedRunner(fixture: Fixture, behavior: PreparedBehavior = {}) {
  return recordingRunner((call) => {
    const args = gitArgs(call)
    if (args[0] === 'worktree') {
      if (args[1] === 'add') {
        const reason = args[5]!
        const path = args[6]!
        mkdirSync(path, { recursive: true })
        writeFileSync(join(path, 'tracked.txt'), 'base\n')
        if (behavior.add === 'timeout-dirty') writeFileSync(join(path, 'dirty.txt'), 'partial\n')
        if (behavior.add !== 'timeout-unregistered') {
          fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.push({
            path, branch: null, head: fixture.baseOid, isMain: false, locked: reason
          })
        }
        return behavior.add ? stopped('timeout') : runResult()
      }
      if (args[1] === 'unlock') {
        const path = args[2]!
        const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === path)
        if (registration) registration.locked = null
        return runResult()
      }
      if (args[1] === 'lock') {
        const reason = args[3]!
        const path = args[4]!
        const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === path)
        if (registration) registration.locked = reason
        return runResult()
      }
      if (args[1] === 'move') {
        const from = args[2]!
        const to = args[3]!
        if (behavior.move === 'timeout-after' || behavior.checkout !== undefined) {
          renameSync(from, to)
          const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === from)
          if (registration) registration.path = to
        }
        return behavior.move ? stopped('timeout') : runResult()
      }
    }
    if (args[0] === 'checkout') {
      const branch = args[3]!
      fixture.branches.add(branch)
      if (behavior.checkout === 'timeout-dirty') writeFileSync(join(call.argv[2]!, 'dirty.txt'), 'partial\n')
      if (behavior.checkout === 'timeout-index-lock') writeFileSync(join(call.argv[2]!, 'index.lock'), 'index bytes\n')
      return behavior.checkout ? stopped('timeout') : runResult()
    }
    return runResult()
  })
}

async function prepare(fixture: Fixture, process: ProcessRunner) {
  return prepareCheckout(preparedEnv(fixture, process), [fixture.repo], fixture.repo, fixture.worktreesRoot,
    'refs/remotes/origin/main', fixture.baseOid)
}

function preparedRows(fixture: Fixture): Array<{ id: string; path: string; owner_id: string; created_at: number }> {
  return fixture.store.all('SELECT id, path, owner_id, created_at FROM prepared_worktrees')
}

function preparedCount(fixture: Fixture): number {
  return fixture.store.get<{ count: number }>('SELECT COUNT(*) AS count FROM prepared_worktrees')!.count
}

test('preparation add timeout cleans only the exact clean locked checkout and uses its 24-hour deadline', async () => {
  const fixture = makeFixture()
  const { process, calls } = preparedRunner(fixture, { add: 'timeout-clean' })
  const prepared = await prepare(fixture, process)
  expect(prepared).toEqual({ prepared: false, reason: 'git worktree stopped: timeout' })
  expect(preparedCount(fixture)).toBe(0)
  expect(calls.map((call) => gitArgs(call).slice(0, 2))).toEqual([['worktree', 'add'], ['worktree', 'unlock']])
  gitPolicy(calls[0]!, PREPARATION_DEADLINE)
  gitPolicy(calls[1]!, SHORT_DEADLINE)
  const path = gitArgs(calls[0]!)[6]!
  const addArgs = gitArgs(calls[0]!)
  expect(addArgs.slice(0, 5)).toEqual(['worktree', 'add', '--detach', '--lock', '--reason'])
  expect(addArgs[5]).toContain('quirky.worktree/prepared:v1:owner-fixture:')
  expect(addArgs[7]).toBe('refs/remotes/origin/main')
  expect(fixture.fakeGit.calls.some((call) => call.fn === 'removeWorktree' && call.args[2] === false)).toBe(true)
  expect(existsSync(path)).toBe(false)
  expect(fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)).toHaveLength(1)
  expect(existsSync(join(fixture.worktreesRoot, '.quirky-preparing'))).toBe(true)
})

test('preparation add timeout retains dirty and unregistered partial checkouts without inserting rows', async () => {
  const dirty = makeFixture()
  const dirtyRun = preparedRunner(dirty, { add: 'timeout-dirty' })
  expect((await prepare(dirty, dirtyRun.process)).prepared).toBe(false)
  const dirtyPath = gitArgs(dirtyRun.calls[0]!)[6]!
  expect(preparedCount(dirty)).toBe(0)
  expect(existsSync(join(dirtyPath, 'dirty.txt'))).toBe(true)
  expect(dirty.fakeGit.worktreesByRepo.get(dirty.repo.path)).toHaveLength(2)
  expect(dirty.logs.join('\n')).toContain('it contains user changes')

  const unregistered = makeFixture()
  const unregisteredRun = preparedRunner(unregistered, { add: 'timeout-unregistered' })
  expect((await prepare(unregistered, unregisteredRun.process)).prepared).toBe(false)
  const partialPath = gitArgs(unregisteredRun.calls[0]!)[6]!
  expect(existsSync(partialPath)).toBe(true)
  expect(unregistered.fakeGit.worktreesByRepo.get(unregistered.repo.path)).toHaveLength(1)
  expect(unregistered.logs.join('\n')).toContain('Git no longer proves its exact locked checkout identity')
})

test('preparation add maps resolved and rejected runner failures to refusal, including stopped exit zero', async () => {
  const failures: Array<{ label: string; value: RunResult | Error; reason: string }> = [
    { label: 'nonzero', value: runResult({ exitCode: 7, stderr: 'failure' }), reason: 'failure' },
    { label: 'signal', value: runResult({ exitCode: 0, signal: 'SIGTERM' }), reason: 'git worktree failed (exit 0)' },
    { label: 'spawn', value: runResult({ exitCode: 0, spawnError: { code: 'ENOENT', message: 'missing git' } }), reason: 'missing git' },
    { label: 'timeout', value: stopped('timeout'), reason: 'git worktree stopped: timeout' },
    { label: 'abort', value: stopped('aborted'), reason: 'git worktree stopped: aborted' },
    { label: 'overflow', value: stopped('overflow'), reason: 'git worktree stopped: overflow' },
    { label: 'stopped zero exit', value: stopped('timeout', 0), reason: 'git worktree stopped: timeout' },
    { label: 'rejection', value: new Error('runner rejected'), reason: 'runner rejected' }
  ]
  for (const { label, value, reason } of failures) {
    const fixture = makeFixture()
    let first = true
    const { process, calls } = recordingRunner(() => {
      if (!first) return runResult()
      first = false
      if (value instanceof Error) throw value
      return value
    })
    const prepared = await prepare(fixture, process)
    expect(prepared, label).toEqual({ prepared: false, reason })
    expect(preparedCount(fixture), label).toBe(0)
    gitPolicy(calls[0]!, PREPARATION_DEADLINE)
  }
})

test('prefetch forwards its activation runner to prepared checkout creation', async () => {
  const fixture = makeFixture()
  const { process, calls } = preparedRunner(fixture)
  const result = await prefetchWorktreeCreateBase(createEnv(fixture, process), { repo: fixture.repo.id })
  expect(result.prepared).toBe(true)
  expect(preparedCount(fixture)).toBe(1)
  expect(calls).toHaveLength(1)
  expect(gitArgs(calls[0]!).slice(0, 2)).toEqual(['worktree', 'add'])
  gitPolicy(calls[0]!, PREPARATION_DEADLINE)
})

test('create sparse validation fails closed for all runner failure outcomes', async () => {
  const matchingTreeEntry = `100644 blob ${BASE_OID}\ttracked.txt\0`

  const failures: Array<{ label: string; value: RunResult | Error }> = [
    { label: 'nonzero', value: runResult({ exitCode: 1, stderr: 'failed', stdoutText: matchingTreeEntry }) },
    { label: 'signal', value: runResult({ exitCode: 0, signal: 'SIGTERM', stdoutText: matchingTreeEntry }) },
    { label: 'spawn', value: runResult({ exitCode: 0, spawnError: { code: 'ENOENT', message: 'git missing' }, stdoutText: matchingTreeEntry }) },
    { label: 'timeout', value: runResult({ exitCode: 0, stopped: 'timeout', stdoutText: matchingTreeEntry }) },
    { label: 'abort', value: runResult({ exitCode: 0, stopped: 'aborted', stdoutText: matchingTreeEntry }) },
    { label: 'overflow', value: runResult({ exitCode: 0, stopped: 'overflow', stdoutText: matchingTreeEntry }) },
    { label: 'stopped zero exit', value: runResult({ exitCode: 0, stopped: 'timeout', stdoutText: matchingTreeEntry }) },
    { label: 'rejection', value: new Error('runner rejected') }
  ]
  for (const { label, value } of failures) {
    const fixture = makeFixture()
    const { process, calls } = createRunner(fixture, (call) => {
      if (gitArgs(call)[0] === 'ls-tree') {
        if (value instanceof Error) throw value
        return value
      }
      return runResult({ exitCode: 1 })
    })
    await expect(createWorkspace(createEnv(fixture, process), {
      repo: fixture.repo.id, name: 'validation-failure', sparsePaths: ['tracked.txt']
    }, {} as CallerIdentity, { creatorKind: 'client', creatorId: null, creatorRole: 'cli' }), label).rejects.toBeDefined()
    expect(calls).toHaveLength(1)
    expect(fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)).toHaveLength(1)
    gitPolicy(calls[0]!, SHORT_DEADLINE)
  }
})

test('claim move timeout before relocation relocks the pool checkout and activation cleanup removes it', async () => {
  const fixture = makeFixture()
  const setup = preparedRunner(fixture, { move: 'timeout-before' })
  expect((await prepare(fixture, setup.process)).prepared).toBe(true)
  const row = preparedRows(fixture)[0]!
  const destination = join(fixture.worktreesRoot, 'claimed')
  setup.calls.length = 0
  expect(await claimPreparedCheckout(preparedEnv(fixture, setup.process), fixture.repo, fixture.worktreesRoot,
    'refs/remotes/origin/main', fixture.baseOid, 'claimed', destination)).toBe(false)
  const registration = (await fixture.fakeGit.listRegistrations(fixture.repo.path)).find((entry) => entry.path === row.path)
  expect(registration).toMatchObject({ branch: null, head: fixture.baseOid, locked: expect.stringContaining(`:${row.id}`) })
  expect(existsSync(destination)).toBe(false)
  expect(preparedCount(fixture)).toBe(1)
  const unlock = setup.calls.find((call) => gitArgs(call)[1] === 'unlock')!
  const move = setup.calls.find((call) => gitArgs(call)[1] === 'move')!
  const lock = setup.calls.find((call) => gitArgs(call)[1] === 'lock')!
  gitPolicy(unlock, SHORT_DEADLINE)
  gitPolicy(move, PREPARATION_DEADLINE)
  gitPolicy(lock, SHORT_DEADLINE)
  await cleanupActivationPreparedCheckouts(preparedEnv(fixture, setup.process))
  expect(preparedCount(fixture)).toBe(0)
  expect(existsSync(row.path)).toBe(false)
})

test('claim move timeout after relocation preserves destination and stale-row cleanup never guesses ownership', async () => {
  const fixture = makeFixture()
  const setup = preparedRunner(fixture, { move: 'timeout-after' })
  expect((await prepare(fixture, setup.process)).prepared).toBe(true)
  const row = preparedRows(fixture)[0]!
  const destination = join(fixture.worktreesRoot, 'moved-before-timeout')
  setup.calls.length = 0
  expect(await claimPreparedCheckout(preparedEnv(fixture, setup.process), fixture.repo, fixture.worktreesRoot,
    'refs/remotes/origin/main', fixture.baseOid, 'moved-before-timeout', destination)).toBe(false)
  expect(existsSync(row.path)).toBe(false)
  expect(existsSync(join(destination, 'tracked.txt'))).toBe(true)
  expect((await fixture.fakeGit.listRegistrations(fixture.repo.path)).some((entry) => entry.path === destination)).toBe(true)
  expect(setup.calls.some((call) => gitArgs(call)[0] === 'checkout')).toBe(false)
  const move = setup.calls.find((call) => gitArgs(call)[1] === 'move')!
  gitPolicy(move, PREPARATION_DEADLINE)
  expect(preparedCount(fixture)).toBe(1)
  expect(preparedRows(fixture)[0]?.path).toBe(row.path)
  await cleanupExpiredPreparedCheckouts(preparedEnv(fixture, setup.process), [fixture.repo], Date.now() + 10 * 60_000)
  expect(preparedCount(fixture)).toBe(0)
  expect(existsSync(destination)).toBe(true)
})

test('claim checkout timeout removes clean destination and conditional branch but retains dirty or index-locked outcomes', async () => {
  const clean = makeFixture()
  const cleanRun = preparedRunner(clean, { checkout: 'timeout-clean' })
  expect((await prepare(clean, cleanRun.process)).prepared).toBe(true)
  cleanRun.calls.length = 0
  const cleanPath = join(clean.worktreesRoot, 'checkout-clean')
  expect(await claimPreparedCheckout(preparedEnv(clean, cleanRun.process), clean.repo, clean.worktreesRoot,
    'refs/remotes/origin/main', clean.baseOid, 'checkout-clean', cleanPath)).toBe(false)
  expect(existsSync(cleanPath)).toBe(false)
  expect(clean.branches.has('checkout-clean')).toBe(false)
  expect(preparedCount(clean)).toBe(0)
  const checkout = cleanRun.calls.find((call) => gitArgs(call)[0] === 'checkout')!
  expect(clean.fakeGit.calls.some((call) =>
    call.fn === 'deleteRefIfAt' && call.args[1] === 'checkout-clean' && call.args[2] === clean.baseOid
  )).toBe(true)
  gitPolicy(checkout, PREPARATION_DEADLINE)

  for (const mode of ['timeout-dirty', 'timeout-index-lock'] as const) {
    const fixture = makeFixture()
    const run = preparedRunner(fixture, { checkout: mode })
    expect((await prepare(fixture, run.process)).prepared).toBe(true)
    const row = preparedRows(fixture)[0]!
    const destination = join(fixture.worktreesRoot, `checkout-${mode}`)
    run.calls.length = 0
    expect(await claimPreparedCheckout(preparedEnv(fixture, run.process), fixture.repo, fixture.worktreesRoot,
      'refs/remotes/origin/main', fixture.baseOid, `checkout-${mode}`, destination)).toBe(false)
    expect(existsSync(destination)).toBe(true)
    expect(fixture.branches.has(`checkout-${mode}`)).toBe(true)
    expect(preparedCount(fixture)).toBe(1)
    expect(fixture.logs.join('\n')).toContain('kept failed preparation at')
    expect(fixture.fakeGit.calls.some((call) => call.fn === 'removeWorktree' && call.args[2] === false)).toBe(true)
    expect(fixture.fakeGit.calls.some((call) => call.fn === 'deleteRefIfAt')).toBe(false)
    if (mode === 'timeout-index-lock') {
      expect(readFileSync(join(destination, 'index.lock'))).toEqual(Buffer.from('index bytes\n'))
    } else {
      expect(readFileSync(join(destination, 'dirty.txt'), 'utf8')).toBe('partial\n')
    }
    const checkoutCall = run.calls.find((call) => gitArgs(call)[0] === 'checkout')!
    gitPolicy(checkoutCall, PREPARATION_DEADLINE)
    await cleanupExpiredPreparedCheckouts(preparedEnv(fixture, run.process), [fixture.repo], Date.now() + 10 * 60_000)
    expect(preparedCount(fixture)).toBe(0)
    expect(existsSync(destination)).toBe(true)
    expect(fixture.branches.has(`checkout-${mode}`)).toBe(true)
    expect(existsSync(join(destination, 'index.lock'))).toBe(mode === 'timeout-index-lock')
    expect(existsSync(row.path)).toBe(false)
  }
})

function createEnv(fixture: Fixture, process: ProcessRunner): CreateEnv {
  const fail = (_kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown) =>
    Object.assign(new Error(message), data === undefined ? {} : { data })
  const hooks: EffectiveHooks = { file: null, setup: null, archive: null, agentStartup: null, sharedDirectories: [], warnings: [] }
  const call = async (method: string) => {
    if (method === 'quirky.repo/show') return { settings: { defaultBase: 'origin/main', worktreeLocation: null }, hooks }
    if (method === 'quirky.repo/list') return [fixture.repo]
    if (method === 'quirky.repo/hooks') return hooks
    return undefined
  }
  return {
    store: fixture.store,
    groups: async () => [],
    log: (message) => fixture.logs.push(message),
    removing: new Set(),
    listed: new Map(),
    fail,
    changed: () => {},
    process,
    call,
    subscribe: () => () => {},
    getSetting: (name) => name === 'branchPrefix' ? 'none' : name === 'nestWorkspaces' ? false : undefined,
    dataDir: fixture.root,
    preparationOwnerId: OWNER_ID,
    worktreesRoot: () => fixture.worktreesRoot,
    worktreeDirName: async () => fixture.repo.name,
    resolveRepo: async () => fixture.repo,
    resolveGroup: async () => { throw new Error('unexpected group') },
    find: async () => { throw new Error('unexpected parent lookup') },
    queue: new KeyedQueue(),
    suggestions: new Map(),
    pending: new Set()
  }
}

function createRunner(fixture: Fixture, handler?: FailureHandler) {
  fixture.fakeGit.addNewBranchWorktree = async (_repo, path, branch, base) => {
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'tracked.txt'), `created from ${base}\n`)
    fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.push({ path, branch, head: base, isMain: false, locked: null })
    fixture.branches.add(branch)
  }
  return recordingRunner(handler ?? ((call) => {
    const args = gitArgs(call)
    if (args[0] === 'ls-tree') {
      const path = args.at(-1)!
      const mode = path === 'src' ? '040000 tree' : '100644 blob'
      return runResult({ stdoutText: `${mode} ${BASE_OID}\t${path}\0` })
    }
    if (args[0] === 'config') return runResult({ exitCode: 1 })
    return runResult()
  }))
}

test('create claim inline environment uses its runner to move and check out the prepared row', async () => {
  const fixture = makeFixture()
  const setup = preparedRunner(fixture)
  expect((await prepare(fixture, setup.process)).prepared).toBe(true)
  const { process, calls } = recordingRunner((call) => {
    const args = gitArgs(call)
    if (args[0] === 'config') return runResult({ exitCode: 1 })
    if (args[0] === 'worktree' && args[1] === 'unlock') {
      const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === args[2])
      if (registration) registration.locked = null
    }
    if (args[0] === 'worktree' && args[1] === 'move') {
      renameSync(args[2]!, args[3]!)
      const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === args[2])
      if (registration) registration.path = args[3]!
    }
    if (args[0] === 'checkout') {
      const registration = fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)!.find((worktree) => worktree.path === call.argv[2])
      if (registration) {
        registration.branch = args[3]!
        registration.head = args[4]!
      }
    }
    return runResult()
  })
  const created = await createWorkspace(createEnv(fixture, process), {
    repo: fixture.repo.id, name: 'claim-from-pool'
  }, {} as CallerIdentity, { creatorKind: 'client', creatorId: null, creatorRole: 'cli' })
  expect(created.creationReceipt.preparedCheckout).toBe(true)
  expect(preparedCount(fixture)).toBe(0)
  const move = calls.find((call) => gitArgs(call)[1] === 'move')!
  const checkout = calls.find((call) => gitArgs(call)[0] === 'checkout')!
  gitPolicy(move, PREPARATION_DEADLINE)
  gitPolicy(checkout, PREPARATION_DEADLINE)
  expect(existsSync(created.worktree.path)).toBe(true)
})

test('sparse validation, initialization and stdin set use injected runner with explicit deadlines', async () => {
  const fixture = makeFixture()
  const { process, calls } = createRunner(fixture)
  const created = await createWorkspace(createEnv(fixture, process), {
    repo: fixture.repo.id, name: 'sparse-fixture', sparsePaths: ['src', 'docs/readme.md']
  }, {} as CallerIdentity, { creatorKind: 'client', creatorId: null, creatorRole: 'cli' })
  expect(created.creationReceipt.sparsePaths).toEqual(['src', 'docs/readme.md'])
  const validation = calls.filter((call) => gitArgs(call)[0] === 'ls-tree')
  expect(validation).toHaveLength(2)
  for (const call of validation) gitPolicy(call, SHORT_DEADLINE)
  const init = calls.find((call) => gitArgs(call).slice(0, 3).join(' ') === 'sparse-checkout init --no-cone')!
  const set = calls.find((call) => gitArgs(call).slice(0, 3).join(' ') === 'sparse-checkout set --no-cone')!
  gitPolicy(init, SHORT_DEADLINE)
  gitPolicy(set, PREPARATION_DEADLINE)
  expect(set.argv).toEqual(['git', '-C', created.worktree.path, 'sparse-checkout', 'set', '--no-cone', '--stdin'])
  expect(set.options.input).toBe('/src/\n/docs/readme.md\n')
})

test('sparse-set timeout enters create rollback instead of a successful receipt', async () => {
  const fixture = makeFixture()
  const { process, calls } = createRunner(fixture, (call) => {
    const args = gitArgs(call)
    if (args[0] === 'ls-tree') {
      const path = args.at(-1)!
      return runResult({ stdoutText: `100644 blob ${BASE_OID}\t${path}\0` })
    }
    if (args[0] === 'config') return runResult({ exitCode: 1 })
    if (args[0] === 'sparse-checkout' && args[1] === 'set') return stopped('timeout')
    return runResult()
  })
  await expect(createWorkspace(createEnv(fixture, process), {
    repo: fixture.repo.id, name: 'sparse-timeout', sparsePaths: ['README.md']
  }, {} as CallerIdentity, { creatorKind: 'client', creatorId: null, creatorRole: 'cli' })).rejects.toThrow('git sparse-checkout stopped: timeout')
  const set = calls.find((call) => gitArgs(call).slice(0, 2).join(' ') === 'sparse-checkout set')!
  gitPolicy(set, PREPARATION_DEADLINE)
  expect(set.options.input).toBe('/README.md\n')
  expect(fixture.fakeGit.worktreesByRepo.get(fixture.repo.path)).toHaveLength(1)
  expect(existsSync(join(fixture.worktreesRoot, 'sparse-timeout'))).toBe(false)
})

test('primary merge timeout returns not-updated and preserves modified files and index.lock bytes', async () => {
  const fixture = makeFixture()
  fixture.primaryHead = OLD_HEAD
  fixture.baseOid = BASE_OID
  const primaryBytes = Buffer.from('partially changed primary file\n')
  const lockBytes = Buffer.from('index lock bytes\0\xff')
  writeFileSync(join(fixture.repo.path, 'tracked.txt'), primaryBytes)
  writeFileSync(join(fixture.repo.path, 'index.lock'), lockBytes)
  const { process, calls } = createRunner(fixture, (call) => {
    const args = gitArgs(call)
    if (args[0] === 'config') return runResult({ exitCode: 1 })
    if (args[0] === 'merge') return stopped('timeout')
    return runResult()
  })
  const created = await createWorkspace(createEnv(fixture, process), {
    repo: fixture.repo.id, name: 'merge-timeout', keepMain: true
  }, {} as CallerIdentity, { creatorKind: 'client', creatorId: null, creatorRole: 'cli' })
  expect(created.creationReceipt.main).toEqual({ status: 'not-updated', reason: 'fast-forward-failed' })
  expect(fixture.logs.join('\n')).toContain('could not fast-forward the primary checkout')
  const primaryCalls = calls.filter((call) =>
    call.argv[0] === 'git' && call.argv[1] === '-C' && call.argv[2] === fixture.repo.path
  )
  const merges = primaryCalls.filter((call) => gitArgs(call)[0] === 'merge')
  expect(merges).toHaveLength(1)
  gitPolicy(merges[0]!, PREPARATION_DEADLINE)
  expect(primaryCalls.filter((call) => ['reset', 'checkout', 'restore', 'read-tree'].includes(gitArgs(call)[0]!))).toHaveLength(0)
  expect(readFileSync(join(fixture.repo.path, 'tracked.txt'))).toEqual(primaryBytes)
  expect(readFileSync(join(fixture.repo.path, 'index.lock'))).toEqual(lockBytes)
})

function githubSource(baseUrl = 'git@fixture-alias:owner/repo.git'): GitHubWorktreeSource {
  return {
    item: { kind: 'pullRequest', number: 7, title: 'Fixture pull request' },
    head: {
      oid: OLD_HEAD, refName: 'feature/fixture', maintainerCanModify: true,
      repository: { host: 'github.com', owner: 'fork-owner', repo: 'fork-repo' },
      httpsUrl: 'https://github.com/fork-owner/fork-repo.git',
      sshUrl: 'git@github.com:fork-owner/fork-repo.git'
    },
    base: {
      oid: BASE_OID, refName: 'main',
      repository: { host: 'github.com', owner: 'owner', repo: 'repo' },
      httpsUrl: 'https://github.com/owner/repo.git', sshUrl: baseUrl
    }
  } as unknown as GitHubWorktreeSource
}

function githubEnv(process: ProcessRunner) {
  return {
    process,
    call: async () => undefined,
    fail: (_kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown) =>
      Object.assign(new Error(message), data === undefined ? {} : { data })
  }
}

function githubRefs(fixture: Fixture, url: string, movedAfterFetch = true) {
  const trackingRef = `refs/quirky/pull/${createHash('sha256').update(url).digest('hex')}/7`
  const baseRef = 'refs/remotes/origin/main'
  let trackingReads = 0
  let baseReads = 0
  fixture.fakeGit.resolveCommit = async (_path, ref) => {
    if (ref === trackingRef) return trackingReads++ === 0 ? OLD_HEAD : movedAfterFetch ? CHANGED_HEAD : OLD_HEAD
    if (ref === baseRef) return baseReads++ === 0 ? OLD_BASE : movedAfterFetch ? CHANGED_BASE : BASE_OID
    return fixture.baseOid
  }
  return { trackingRef, baseRef }
}

function githubArgs(call: RecordedCall): string[] {
  return call.argv.slice(1)
}

function githubRunner(
  fixture: Fixture,
  fetchOutcome: RunResult | Error,
  url = 'git@fixture-alias:owner/repo.git',
  movedAfterFetch = true
) {
  const refs = githubRefs(fixture, url, movedAfterFetch)
  const { process, calls } = recordingRunner((call) => {
    if (call.argv[0] === 'ssh') return runResult({ stdoutText: 'hostname GitHub.COM\n' })
    const args = githubArgs(call)
    if (args[0] === 'config' && args[3] === 'remote.origin.url') return runResult({ stdoutText: `${url}\n` })
    if (args[0] === 'config') return runResult({ exitCode: 1 })
    if (args[0] === 'fetch') {
      if (fetchOutcome instanceof Error) throw fetchOutcome
      return fetchOutcome
    }
    return runResult()
  })
  return { process, calls, refs }
}

test('GitHub fetch timeout routes alias and CAS restoration through the same runner with network SSH config', async () => {
  const fixture = makeFixture()
  const oldSshCommand = process.env.GIT_SSH_COMMAND
  const inheritedMarker = 'QUIRKY_WORKTREE_PROCESS_RUNNER_INHERITED'
  const oldInheritedMarker = process.env[inheritedMarker]
  process.env.GIT_SSH_COMMAND = 'ssh -i /tmp/fixture-key'
  process.env[inheritedMarker] = 'present'
  try {
    const run = githubRunner(fixture, stopped('timeout'))
    const error = await planPullRequest(githubEnv(run.process), fixture.repo, githubSource()).then(
      () => null,
      (reason: unknown) => reason as Error & { data?: Record<string, unknown> }
    )
    expect(error?.data).toMatchObject({ reason: 'github-head-fetch-failed', timedOut: true })
    const ssh = run.calls.find((call) => call.argv[0] === 'ssh')!
    expect(ssh.argv).toEqual(['ssh', '-G', '--', 'fixture-alias'])
    expect(ssh.options).toMatchObject({
      timeoutMs: 5_000, killGraceMs: 0, maxOutputBytes: GIT_OUTPUT_LIMIT,
      outputMode: 'separate', overflow: 'stop'
    })
    expect(ssh.options.env?.[inheritedMarker]).toBe('present')
    const fetch = run.calls.find((call) => githubArgs(call)[0] === 'fetch')!
    expect(fetch.argv).toEqual([
      'git', 'fetch', '--no-tags', '--no-write-fetch-head', '--', 'origin',
      `+refs/pull/7/head:${run.refs.trackingRef}`, `+refs/heads/main:${run.refs.baseRef}`
    ])
    expect(fetch.options).toMatchObject({
      cwd: fixture.repo.path, timeoutMs: 60_000, killGraceMs: 5_000, maxOutputBytes: GIT_OUTPUT_LIMIT,
      outputMode: 'separate', overflow: 'truncate',
      env: {
        GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', SSH_ASKPASS: '',
        GIT_SSH_COMMAND: 'ssh -i /tmp/fixture-key -o BatchMode=yes',
        [inheritedMarker]: 'present'
      }
    })
    expect(run.calls.filter((call) => githubArgs(call)[0] === 'update-ref').map(githubArgs)).toEqual([
      ['update-ref', run.refs.trackingRef, OLD_HEAD, CHANGED_HEAD],
      ['update-ref', run.refs.baseRef, OLD_BASE, CHANGED_BASE]
    ])
    for (const call of run.calls.filter((entry) => entry.argv[0] === 'git' && githubArgs(entry)[0] !== 'fetch' && githubArgs(entry)[0] !== 'update-ref')) {
      expect(call.options.timeoutMs).toBe(SHORT_DEADLINE)
      expect(call.options.killGraceMs).toBe(5_000)
      expect(call.options.maxOutputBytes).toBe(GIT_OUTPUT_LIMIT)
    }
  } finally {
    if (oldSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = oldSshCommand
    if (oldInheritedMarker === undefined) delete process.env[inheritedMarker]
    else process.env[inheritedMarker] = oldInheritedMarker
  }
})
test('GitHub fetch uses core.sshCommand and GIT_SSH fallbacks with BatchMode selection', async () => {
  const oldSshCommand = process.env.GIT_SSH_COMMAND
  const oldSsh = process.env.GIT_SSH
  const selections = [
    {
      label: 'core.sshCommand precedes GIT_SSH and adds BatchMode',
      coreSshCommand: 'ssh -i /tmp/core-key',
      gitSsh: 'ssh -i /tmp/git-key -o BatchMode=no',
      expected: 'ssh -i /tmp/core-key -o BatchMode=yes'
    },
    {
      label: 'GIT_SSH fallback adds BatchMode',
      coreSshCommand: null,
      gitSsh: 'ssh -i /tmp/git-key',
      expected: 'ssh -i /tmp/git-key -o BatchMode=yes'
    },
    {
      label: 'GIT_SSH fallback preserves existing BatchMode=yes',
      coreSshCommand: null,
      gitSsh: 'ssh -i /tmp/git-key -o BatchMode=yes',
      expected: 'ssh -i /tmp/git-key -o BatchMode=yes'
    },
    {
      label: 'GIT_SSH fallback preserves existing BatchMode=no',
      coreSshCommand: null,
      gitSsh: 'ssh -i /tmp/git-key -o BatchMode=no',
      expected: 'ssh -i /tmp/git-key -o BatchMode=no'
    }
  ]
  try {
    delete process.env.GIT_SSH_COMMAND
    for (const selection of selections) {
      process.env.GIT_SSH = selection.gitSsh
      const fixture = makeFixture()
      fixture.fakeGit.getConfig = async (_path, key) =>
        key === 'core.sshCommand' ? selection.coreSshCommand : null
      const run = githubRunner(fixture, stopped('timeout'))
      await expect(planPullRequest(githubEnv(run.process), fixture.repo, githubSource())).rejects.toBeDefined()
      const fetch = run.calls.find((call) => githubArgs(call)[0] === 'fetch')!
      expect(fetch.options.env?.GIT_SSH_COMMAND, selection.label).toBe(selection.expected)
    }
  } finally {
    if (oldSshCommand === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = oldSshCommand
    if (oldSsh === undefined) delete process.env.GIT_SSH
    else process.env.GIT_SSH = oldSsh
  }
})


test('GitHub fetch failure matrix never uses a stale head and only timeout sets timedOut', async () => {
  const failures: Array<{ label: string; value: RunResult | Error; timeout: boolean }> = [
    { label: 'nonzero', value: runResult({ exitCode: 1, stderr: 'fetch failed' }), timeout: false },
    { label: 'signal', value: runResult({ exitCode: null, signal: 'SIGTERM' }), timeout: false },
    { label: 'spawn', value: runResult({ exitCode: null, spawnError: { code: 'ENOENT', message: 'missing git' } }), timeout: false },
    { label: 'abort', value: stopped('aborted'), timeout: false },
    { label: 'overflow', value: stopped('overflow'), timeout: false },
    { label: 'stopped timeout with exit zero', value: stopped('timeout', 0), timeout: true },
    { label: 'rejection', value: new Error('runner rejected'), timeout: false }
  ]
  for (const { label, value, timeout } of failures) {
    const fixture = makeFixture()
    const run = githubRunner(fixture, value)
    const error = await planPullRequest(githubEnv(run.process), fixture.repo, githubSource()).then(
      () => null,
      (reason: unknown) => reason as Error & { data?: Record<string, unknown> }
    )
    expect(error?.data, label).toMatchObject({ reason: 'github-head-fetch-failed', timedOut: timeout })
    expect(run.calls.filter((call) => githubArgs(call)[0] === 'fetch')).toHaveLength(1)
    expect(run.calls.filter((call) => githubArgs(call)[0] === 'update-ref')).toHaveLength(2)
  }
})

test('successful GitHub fetch resolves the SSH alias and configures the canonical push target', async () => {
  const fixture = makeFixture()
  const run = githubRunner(fixture, runResult(), undefined, false)
  const plan = await planPullRequest(githubEnv(run.process), fixture.repo, githubSource())
  expect(plan.fetchedHead).toBe(OLD_HEAD)
  expect(plan.fetchedBaseHead).toBe(BASE_OID)
  expect(plan.pushRemoteUrl).toBe('git@github.com:fork-owner/fork-repo.git')
  expect(run.calls.filter((call) => githubArgs(call)[0] === 'fetch')).toHaveLength(1)
  expect(run.calls.filter((call) => call.argv[0] === 'ssh').length).toBeGreaterThan(0)
  expect(run.calls.some((call) => githubArgs(call)[0] === 'update-ref')).toBe(false)
})
test('successful GitHub fetch accepts truncated stderr with empty stdout', async () => {
  const fixture = makeFixture()
  const fetchResult = runResult({ stderr: 'partial diagnostic', truncated: { stdout: false, stderr: true } })
  const run = githubRunner(fixture, fetchResult, undefined, false)
  const plan = await planPullRequest(githubEnv(run.process), fixture.repo, githubSource())
  expect(plan.fetchedHead).toBe(OLD_HEAD)
  expect(plan.fetchedBaseHead).toBe(BASE_OID)
  expect(run.calls.filter((call) => githubArgs(call)[0] === 'fetch')).toHaveLength(1)
})

test('successful fetch with a moved or missing PR head rejects it and restores only provable refs', async () => {
  const moved = makeFixture()
  const movedRun = githubRunner(moved, runResult())
  const movedError = await planPullRequest(githubEnv(movedRun.process), moved.repo, githubSource()).then(
    () => null,
    (reason: unknown) => reason as Error & { data?: Record<string, unknown> }
  )
  expect(movedError?.data?.reason).toBe('github-head-moved')
  expect(movedRun.calls.filter((call) => githubArgs(call)[0] === 'update-ref').map(githubArgs)).toEqual([
    ['update-ref', movedRun.refs.trackingRef, OLD_HEAD, CHANGED_HEAD],
    ['update-ref', movedRun.refs.baseRef, OLD_BASE, CHANGED_BASE]
  ])

  const missing = makeFixture()
  const missingRun = githubRunner(missing, runResult())
  let trackingReads = 0
  let baseReads = 0
  missing.fakeGit.resolveCommit = async (_path, ref) => {
    if (ref === missingRun.refs.trackingRef) return trackingReads++ === 0 ? OLD_HEAD : null
    if (ref === missingRun.refs.baseRef) return baseReads++ === 0 ? OLD_BASE : CHANGED_BASE
    return missing.baseOid
  }
  const missingError = await planPullRequest(githubEnv(missingRun.process), missing.repo, githubSource()).then(
    () => null,
    (reason: unknown) => reason as Error & { data?: Record<string, unknown> }
  )
  expect(missingError?.data?.reason).toBe('github-head-moved')
  expect(missingRun.calls.filter((call) => githubArgs(call)[0] === 'update-ref').map(githubArgs)).toEqual([
    ['update-ref', missingRun.refs.baseRef, OLD_BASE, CHANGED_BASE]
  ])
})

test('restorePullRef forwards compare-and-swap ref commands to the supplied runner', async () => {
  const fixture = makeFixture()
  const plan = {
    trackingRef: 'refs/quirky/pull/fixture/7', oldTrackingHead: null, fetchedHead: OLD_HEAD,
    baseTrackingRef: 'refs/remotes/origin/main', oldBaseTrackingHead: BASE_OID, fetchedBaseHead: OLD_HEAD
  } as PullRequestPlan
  const { process, calls } = recordingRunner()
  await restorePullRef(process, fixture.repo.path, plan)
  expect(calls.map(githubArgs)).toEqual([
    ['update-ref', '-d', plan.trackingRef, OLD_HEAD],
    ['update-ref', plan.baseTrackingRef, BASE_OID, OLD_HEAD]
  ])
  for (const call of calls) {
    expect(call.options).toMatchObject({
      cwd: fixture.repo.path, timeoutMs: SHORT_DEADLINE, killGraceMs: 5_000,
      maxOutputBytes: GIT_OUTPUT_LIMIT, outputMode: 'separate', overflow: 'truncate'
    })
  }
})

test('GitHub rejects alias failures, malformed hostnames and unchanged aliases before fetch', async () => {
  const validHostname = 'hostname github.com\n'
  const aliasFailures: Array<RunResult | Error> = [
    runResult({ exitCode: 1, stdoutText: validHostname }),
    runResult({ exitCode: 0, signal: 'SIGTERM', stdoutText: validHostname }),
    runResult({ exitCode: 0, spawnError: { code: 'ENOENT', message: 'ssh missing' }, stdoutText: validHostname }),
    runResult({ exitCode: 0, stopped: 'overflow', stdoutText: validHostname }),
    runResult({ exitCode: 0, stopped: 'timeout', stdoutText: validHostname }),
    new Error('runner rejected'),
    runResult({ stdoutText: 'not hostname output\n' }),
    runResult({ stdoutText: 'hostname fixture-alias\n' })
  ]
  for (const failure of aliasFailures) {
    const fixture = makeFixture()
    const url = 'git@fixture-alias:owner/repo.git'
    githubRefs(fixture, url)
    const { process, calls } = recordingRunner((call) => {
      if (call.argv[0] === 'ssh') {
        if (failure instanceof Error) throw failure
        return failure
      }
      if (githubArgs(call)[0] === 'config' && githubArgs(call)[3] === 'remote.origin.url') return runResult({ stdoutText: `${url}\n` })
      return runResult({ exitCode: 1 })
    })
    const error = await planPullRequest(githubEnv(process), fixture.repo, githubSource(url)).then(
      () => null,
      (reason: unknown) => reason as Error & { data?: Record<string, unknown> }
    )
    expect(error?.data?.reason).toBe('github-base-remote-missing')
    expect(calls.filter((call) => call.argv[0] === 'ssh')).toHaveLength(1)
    expect(calls.some((call) => githubArgs(call)[0] === 'fetch')).toBe(false)
  }
})

test('GitHub config rollback accepts unset exit five, retains config values and truncation markers', async () => {
  const fixture = makeFixture()
  const retained = 'x'.repeat(GIT_OUTPUT_LIMIT)
  const configRun = recordingRunner((call) => {
    const args = githubArgs(call)
    if (args[0] === 'config' && args[2] === '--get-all') {
      return runResult({ stdoutText: retained, truncated: { stdout: true, stderr: false } })
    }
    if (args[0] === 'config' && args[2] === '--unset-all') return runResult({ exitCode: 5 })
    return runResult()
  })
  const snapshot = await snapshotBranchConfig(configRun.process, fixture.repo.path, 'feature/fixture')
  expect(snapshot.get('branch.feature/fixture.base')).toEqual([retained, '[output truncated]'])
  expect(configRun.calls.filter((call) => githubArgs(call)[0] === 'config' && githubArgs(call)[2] === '--get-all')).toHaveLength(4)
  await restoreBranchConfig(configRun.process, fixture.repo.path, new Map([['branch.feature/fixture.base', ['origin/main']]]))
  expect(configRun.calls.some((call) => githubArgs(call).join(' ') === 'config --local --add branch.feature/fixture.base origin/main')).toBe(true)
  for (const call of configRun.calls) {
    expect(call.options).toMatchObject({
      cwd: fixture.repo.path, timeoutMs: SHORT_DEADLINE, killGraceMs: 5_000,
      maxOutputBytes: GIT_OUTPUT_LIMIT, outputMode: 'separate', overflow: 'truncate'
    })
  }

  const pushRemoteUrl = 'https://github.com/fork-owner/fork-repo.git'
  const remotePlan = {
    pushRemoteUrl,
    pushTarget: { remoteName: 'pr-fork-owner-fork-repo', branchName: 'feature/fixture', maintainerCanModify: true }
  } as PullRequestPlan
  const addRun = recordingRunner()
  expect(await addPushRemote(addRun.process, fixture.repo.path, remotePlan)).toBe(true)
  expect(addRun.calls[0]!.argv).toEqual(['git', 'remote', 'add', remotePlan.pushTarget.remoteName, pushRemoteUrl])
  expect(addRun.calls[0]!.options).toMatchObject({
    cwd: fixture.repo.path, timeoutMs: SHORT_DEADLINE, killGraceMs: 5_000,
    maxOutputBytes: GIT_OUTPUT_LIMIT, outputMode: 'separate', overflow: 'truncate'
  })
  const remoteRun = recordingRunner((call) => {
    const args = githubArgs(call)
    if (args[0] === 'remote' && args[1] === 'add') {
      return runResult({ exitCode: 1, stderr: retained, truncated: { stdout: false, stderr: true } })
    }
    if (args[0] === 'config' && args[3] === `remote.${remotePlan.pushTarget.remoteName}.url`) {
      return runResult({ stdoutText: `${remotePlan.pushRemoteUrl}\n` })
    }
    if (args[0] === 'config' && args[3] === `remote.${remotePlan.pushTarget.remoteName}.pushurl`) return runResult({ exitCode: 1 })
    return runResult()
  })
  await expect(addPushRemote(remoteRun.process, fixture.repo.path, remotePlan)).rejects.toThrow(
    `could not add Git remote ${remotePlan.pushTarget.remoteName}: ${retained}\n[output truncated]`
  )
  await removePushRemote(remoteRun.process, fixture.repo.path, remotePlan)
  expect(remoteRun.calls.some((call) => githubArgs(call).join(' ') === `remote remove ${remotePlan.pushTarget.remoteName}`)).toBe(true)
})

test('worktree scanner boundary is clear including the vm runner at its API floor', () => {
  const migratedFiles = [
    'plugins/quirky.worktree/src/daemon/create.ts',
    'plugins/quirky.worktree/src/daemon/github.ts',
    'plugins/quirky.worktree/src/daemon/prepared.ts',
    'plugins/quirky.worktree/src/daemon/hooks-run.ts',
    'plugins/quirky.worktree/src/daemon/vm.ts'
  ]
  for (const path of migratedFiles) expect(scanSourceContent(path, readFileSync(path, 'utf8'))).toEqual([])
  const baseline = JSON.parse(readFileSync('scripts/spawn-lint-baseline.json', 'utf8')) as Record<string, number>
  for (const path of migratedFiles) expect(baseline[path]).toBeUndefined()
  expect(baseline['plugins/quirky.worktree/src/daemon/vm.ts']).toBeUndefined()
  const manifest = JSON.parse(readFileSync('plugins/quirky.worktree/quirky-plugin.json', 'utf8')) as { apiVersion: string }
  expect(manifest.apiVersion).toBe('1.12.0')
  expect(PLUGIN_API_VERSION).toBe('1.14.0')
  expect(pluginApiCompatibilityError(manifest.apiVersion)).toBeNull()
})
