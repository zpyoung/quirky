import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient, Repo, Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { makeHomeWithoutAutoHooks } from '../../../packages/daemon/test/helpers'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { makeRepo, commitFiles, git, isolateGitConfig, failure } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import type { CleanupCandidate, CleanupRemovalResult, StockWorktreeOptions, WorktreeSleepState } from '../src/control-types'

const { scratch } = isolateGitConfig()

const controlPlugins = [
  'quirky.repo',
  'quirky.worktree',
  'quirky.agents',
  'quirky.session',
  'quirky.agent-status',
  'quirky.sidebar-extras',
  'quirky.terminal',
  'quirky.git',
  'quirky.editor'
]

type World = { t: PluginHarness; root: string; repoDir: string; repo: Repo }
let world: World | undefined

afterEach(async () => {
  await world?.t.cleanup()
  world = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function start(options: { plugins?: string[]; fakeSession?: boolean } = {}): Promise<World> {
  const t = await startPluginHarness({
    realGit: true,
    plugins: options.plugins ?? controlPlugins,
    fakeSession: options.fakeSession ?? false,
    home: makeHomeWithoutAutoHooks('qw-control-home-')
  })
  const root = realpathSync(makeTempDir('qw-control-root-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const repoDir = makeRepo(scratch())
  const repo = (await call(t.client, 'quirky.repo/add', { path: repoDir })) as Repo
  return { t, root, repoDir, repo }
}

const create = async (w: World, name: string, extra: Record<string, unknown> = {}) =>
  ((await call(w.t.client, 'quirky.worktree/create', { repo: w.repo.id, name, ...extra })) as WorktreeCreateResult).worktree

const list = async (w: World) => (await call(w.t.client, 'quirky.worktree/list')) as (Worktree & { sleeping?: boolean; manualOrder?: number })[]

function ageRows(w: World, worktrees: Worktree[], clearBaseRef: Worktree[] = []): void {
  const db = new Database(join(w.t.h.home, 'plugin-data', 'quirky.worktree', 'store.db'))
  try {
    for (const worktree of worktrees) {
      db.query('UPDATE worktrees SET last_activity_at = 1, created_at = 1 WHERE id = ?').run(worktree.id)
    }
    for (const worktree of clearBaseRef) {
      db.query('UPDATE worktrees SET base_ref = NULL WHERE id = ?').run(worktree.id)
    }
  } finally {
    db.close()
  }
}

const codes = (candidate: CleanupCandidate): string[] => candidate.blockers.map((blocker) => blocker.code)
const candidateFor = (rows: CleanupCandidate[], worktree: Worktree): CleanupCandidate => {
  const candidate = rows.find((row) => row.worktreeId === worktree.id)
  if (!candidate) throw new Error(`cleanup preview omitted ${worktree.id}`)
  return candidate
}

async function cli(w: World, args: string[]) {
  const proc = spawnCli(args, { home: w.t.h.home })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ])
  return { stdout, stderr, code }
}

describe('stock worktree options', () => {
  test('the public options and CLI persist project/status/none grouping, sort, and card properties across restart', async () => {
    const w = await start()
    world = w
    const defaults = (await call(w.t.client, 'quirky.worktree/options')) as StockWorktreeOptions
    expect(defaults).toMatchObject({
      groupBy: 'project',
      sortBy: 'recent',
      projectOrderBy: 'manual',
      compact: false,
      showBranch: true,
      showComment: true,
      showSleeping: true,
      hideCliCreated: false,
      hideDefaultBranch: false,
      hideDetached: false,
      hideArchived: true,
      externalVisibilityDefault: 'hide'
    })
    expect(defaults.showProperties).toContain('branch')

    const selected = (await call(w.t.client, 'quirky.worktree/setOptions', {
      groupBy: 'status',
      sortBy: 'name',
      compact: true,
      showBranch: false,
      showComment: true,
      showSleeping: false
    })) as StockWorktreeOptions
    expect(selected).toMatchObject({
      groupBy: 'status',
      sortBy: 'name',
      compact: true,
      showBranch: false,
      showComment: true,
      showSleeping: false
    })

    await w.t.restart()
    expect(await call(w.t.client, 'quirky.worktree/options')).toEqual(selected)

    const changed = await cli(w, [
      'worktree', 'options', '--group-by', 'none', '--sort-by', 'manual', '--compact',
      '--show-branch', '--hide-comment', '--show-sleeping', '--json'
    ])
    expect(changed.code).toBe(0)
    expect(JSON.parse(changed.stdout)).toMatchObject({
      groupBy: 'none',
      sortBy: 'manual',
      compact: true,
      showBranch: true,
      showComment: false,
      showSleeping: true
    })
  })

  test('manual reorder updates persisted ordering without changing pins or nested membership', async () => {
    const w = await start()
    world = w
    const parent = await create(w, 'parent')
    const child = await create(w, 'child')
    const sibling = await create(w, 'sibling')
    await call(w.t.client, 'quirky.worktree/set', { worktree: child.id, parent: parent.id, pinned: true })

    const ordered = await call(w.t.client, 'quirky.worktree/reorder', { worktrees: [sibling.id, parent.id] })
    expect(ordered).toEqual({ ok: true })
    await w.t.restart()
    const after = await list(w)
    expect(after.find((worktree) => worktree.id === child.id)).toMatchObject({ parentId: parent.id, pinned: true })
    expect(after.find((worktree) => worktree.id === sibling.id)!.manualOrder).toBeLessThan(after.find((worktree) => worktree.id === parent.id)!.manualOrder!)
  })
})

describe('reversible sleep and wake', () => {
  test('sleep and wake affect only the exact subtree, persist, and retain session history', async () => {
    const w = await start()
    world = w
    const parent = await create(w, 'parent')
    const child = await create(w, 'child')
    const sibling = await create(w, 'sibling')
    await call(w.t.client, 'quirky.worktree/set', { worktree: child.id, parent: parent.id })

    const one = await call(w.t.client, 'quirky.worktree/sleep', { worktree: parent.id }) as { worktrees: WorktreeSleepState[] }
    expect(one.worktrees.map((row) => row.worktreeId)).toEqual([parent.id])
    expect((await list(w)).find((row) => row.id === child.id)?.sleeping).toBe(false)

    const before = await call(w.t.client, 'quirky.session/list') as { id: string }[]
    const preview = await call(w.t.client, 'quirky.worktree/sleepPreview', {
      worktree: parent.id,
      withDescendants: true
    }) as { worktrees: Array<{ worktreeId: string; allowed: boolean }> }
    expect(preview.worktrees.map((row) => row.worktreeId).sort()).toEqual([parent.id, child.id].sort())
    expect(preview.worktrees.every((row) => row.allowed)).toBe(true)

    const slept = await call(w.t.client, 'quirky.worktree/sleep', {
      worktree: parent.id,
      withDescendants: true
    }) as { worktrees: WorktreeSleepState[] }
    expect(slept.worktrees.map((row) => row.worktreeId).sort()).toEqual([parent.id, child.id].sort())
    await w.t.restart()
    const restored = await list(w)
    expect(restored.find((row) => row.id === parent.id)?.sleeping).toBe(true)
    expect(restored.find((row) => row.id === child.id)?.sleeping).toBe(true)
    expect(restored.find((row) => row.id === sibling.id)?.sleeping).toBe(false)

    const woken = await call(w.t.client, 'quirky.worktree/wake', {
      worktree: parent.id,
      withDescendants: true
    }) as { worktrees: WorktreeSleepState[] }
    expect(woken.worktrees.every((row) => !row.sleeping)).toBe(true)
    expect(await call(w.t.client, 'quirky.session/list')).toEqual(before)
  })

  test('sleep closes only the selected live view and leaves its running terminal untouched', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'running')
    const sibling = await create(w, 'other-view')
    const session = await call(w.t.client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' }) as { id: string }
    const ui = await w.t.h.connect('ui')
    await ui.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: worktree.id } })

    const preview = await call(w.t.client, 'quirky.worktree/sleepPreview', { worktree: worktree.id }) as {
      worktrees: Array<{ allowed: boolean; blockers: Array<{ code: string }> }>
    }
    expect(preview.worktrees[0]).toMatchObject({ allowed: true, blockers: [] })
    await call(w.t.client, 'quirky.worktree/sleep', { worktree: worktree.id })
    expect((await call(w.t.client, 'ui.state') as { layout: { view: unknown } }).layout.view).toBeNull()
    const live = (await call(w.t.client, 'quirky.session/list', { worktree: worktree.id }) as Array<{ id: string; status: string }>).find((row) => row.id === session.id)
    expect(live?.status).not.toBe('exited')

    await call(w.t.client, 'quirky.worktree/wake', { worktree: worktree.id })
    await ui.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: sibling.id } })
    await call(w.t.client, 'quirky.worktree/sleep', { worktree: worktree.id })
    expect((await call(w.t.client, 'ui.state') as { layout: { view: { input?: { worktree?: string } } } }).layout.view?.input?.worktree).toBe(sibling.id)
  })

  test('unknown per-window visibility refuses sleep rather than closing another window view', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'two-windows')
    const firstWindow = await w.t.h.connect('ui')
    await w.t.h.connect('ui')
    await firstWindow.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: worktree.id } })

    const preview = await call(w.t.client, 'quirky.worktree/sleepPreview', { worktree: worktree.id }) as {
      worktrees: Array<{ allowed: boolean; blockers: Array<{ code: string }> }>
    }
    expect(preview.worktrees[0]).toMatchObject({ allowed: false })
    expect(preview.worktrees[0]!.blockers.map((blocker) => blocker.code)).toContain('ui-view-ambiguous')
    await expect(call(w.t.client, 'quirky.worktree/sleep', { worktree: worktree.id })).rejects.toThrow(/multiple windows/i)
    expect((await list(w)).find((row) => row.id === worktree.id)?.sleeping).toBe(false)
    expect((await call(w.t.client, 'ui.state') as { layout: { view: { input?: { worktree?: string } } } }).layout.view?.input?.worktree).toBe(worktree.id)
  })

  test('sleep does not require a session plugin or infer that a process is dead', async () => {
    const w = await start({ plugins: ['quirky.repo', 'quirky.worktree'], fakeSession: false })
    world = w
    const worktree = await create(w, 'no-session-plugin')
    const preview = await call(w.t.client, 'quirky.worktree/sleepPreview', { worktree: worktree.id }) as {
      worktrees: Array<{ allowed: boolean; blockers: Array<{ code: string }> }>
    }
    expect(preview.worktrees[0]).toMatchObject({ allowed: true, blockers: [] })
    const slept = await call(w.t.client, 'quirky.worktree/sleep', { worktree: worktree.id }) as { worktrees: WorktreeSleepState[] }
    expect(slept.worktrees[0]).toMatchObject({ worktreeId: worktree.id, sleeping: true })
    expect((await list(w)).find((row) => row.id === worktree.id)?.sleeping).toBe(true)
  })
})

describe('safe cleanup preview and removal', () => {
  test('preview exposes the supported blockers and still identifies a genuinely unused clean workspace', async () => {
    const w = await start()
    world = w
    const main = ((await call(w.t.client, 'quirky.worktree/list', { repo: w.repo.id })) as Worktree[])[0]!
    const eligible = await create(w, 'eligible')
    const pinned = await create(w, 'pinned')
    const dirty = await create(w, 'dirty')
    const locked = await create(w, 'locked')
    const unpushed = await create(w, 'unpushed')
    const active = await create(w, 'active')
    const editor = await create(w, 'editor-draft')
    const visible = await create(w, 'recent-visible')
    const running = await create(w, 'running-terminal')
    const unknownBaseRepoPath = makeTempDir('qw-trunk-')
    git(unknownBaseRepoPath, 'init', '-q', '-b', 'trunk')
    git(unknownBaseRepoPath, 'config', 'user.name', 'Test')
    git(unknownBaseRepoPath, 'config', 'user.email', 'test@example.com')
    commitFiles(unknownBaseRepoPath, { 'trunk.txt': 'one\n' })
    const unknownBaseRepo = await call(w.t.client, 'quirky.repo/add', { path: unknownBaseRepoPath }) as Repo
    const unknownBase = ((await call(w.t.client, 'quirky.worktree/create', {
      repo: unknownBaseRepo.id,
      name: 'unknown-base',
      base: 'trunk'
    })) as WorktreeCreateResult).worktree
    const folderPath = realpathSync(makeTempDir('qw-folder-'))
    const folderRepo = await call(w.t.client, 'quirky.repo/add', { path: folderPath, folder: true }) as Repo
    const folder = ((await call(w.t.client, 'quirky.worktree/list', { repo: folderRepo.id })) as Worktree[])[0]!

    await call(w.t.client, 'quirky.worktree/set', { worktree: pinned.id, pinned: true })
    writeFileSync(join(dirty.path, 'untracked.txt'), 'dirty\n')
    git(w.repoDir, 'worktree', 'lock', '--reason', 'cleanup test lock', locked.path)
    commitFiles(unpushed.path, { 'unpublished.txt': 'not pushed\n' })
    const ui = await w.t.h.connect('ui')
    await ui.callAny('ui.view.open', { id: 'view:quirky.session/worktree', input: { worktree: active.id } })
    const opened = await call(w.t.client, 'quirky.editor/open', { worktree: editor.id, path: 'a.txt' }) as { id: string; contentRevision: number }
    await call(w.t.client, 'quirky.editor/draft', { bufferId: opened.id, content: 'unsaved draft\n', expectedRevision: opened.contentRevision })
    await call(w.t.client, 'quirky.sidebar-extras/activate', { worktree: visible.id })
    await call(w.t.client, 'quirky.sidebar-extras/activate', { worktree: null })
    await call(w.t.client, 'quirky.session/create', { worktree: running.id, agent: 'shell' })

    const all = [...await list(w), unknownBase, folder]
    ageRows(w, all, [unknownBase])
    const preview = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    expect(candidateFor(preview.candidates, eligible).eligible).toBe(true)
    expect(codes(candidateFor(preview.candidates, main))).toContain('main-worktree')
    expect(codes(candidateFor(preview.candidates, folder))).toContain('folder-repo')
    expect(codes(candidateFor(preview.candidates, pinned))).toContain('pinned')
    expect(codes(candidateFor(preview.candidates, dirty))).toContain('dirty-files')
    expect(codes(candidateFor(preview.candidates, locked))).toContain('locked')
    expect(codes(candidateFor(preview.candidates, unpushed))).toContain('unpushed-commits')
    expect(codes(candidateFor(preview.candidates, active))).toContain('active-workspace')
    expect(codes(candidateFor(preview.candidates, editor))).toContain('dirty-editor-buffer')
    expect(codes(candidateFor(preview.candidates, visible))).toContain('recent-visible-context')
    expect(codes(candidateFor(preview.candidates, running))).toContain('running-terminal')
    expect(codes(candidateFor(preview.candidates, unknownBase))).toContain('unknown-base')
  })

  test('ignore and restore survive restart, while a stale clean preview refuses a dirty checkout', async () => {
    const w = await start()
    world = w
    const worktree = await create(w, 'candidate')
    ageRows(w, [worktree])
    const first = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    const snapshot = candidateFor(first.candidates, worktree)
    expect(snapshot.eligible).toBe(true)

    await call(w.t.client, 'quirky.worktree/cleanupIgnore', { worktreeId: worktree.id, fingerprint: snapshot.fingerprint })
    await w.t.restart()
    const ignored = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    const dismissed = candidateFor(ignored.candidates, worktree)
    expect(dismissed.ignored).toBe(true)
    expect(codes(dismissed)).toContain('dismissed')

    const restored = await call(w.t.client, 'quirky.worktree/cleanupRestoreIgnored') as { restored: number }
    expect(restored.restored).toBe(1)
    const available = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    const clean = candidateFor(available.candidates, worktree)
    expect(clean).toMatchObject({ ignored: false, eligible: true })

    writeFileSync(join(worktree.path, 'new-dirty-file.txt'), 'changed after preview\n')
    const result = await call(w.t.client, 'quirky.worktree/cleanupRemove', {
      selection: [{ worktreeId: worktree.id, fingerprint: clean.fingerprint }],
      confirmed: true,
      yes: true
    }) as { results: CleanupRemovalResult[] }
    expect(result.results).toHaveLength(1)
    expect(result.results[0]).toMatchObject({ worktreeId: worktree.id, removed: false })
    expect(result.results[0]!.error).toMatch(/stale|dirty/i)
    expect(realpathSync(worktree.path)).toBe(worktree.path)
  })

  test('a confirmed bulk request revalidates each selected row and reports partial failure truthfully', async () => {
    const w = await start()
    world = w
    const locked = await create(w, 'locked-after-preview')
    const removable = await create(w, 'removable')
    ageRows(w, [locked, removable])
    const before = await call(w.t.client, 'quirky.worktree/cleanupPreview') as { candidates: CleanupCandidate[] }
    const lockedPreview = candidateFor(before.candidates, locked)
    const removablePreview = candidateFor(before.candidates, removable)
    expect(lockedPreview.eligible).toBe(true)
    expect(removablePreview.eligible).toBe(true)

    git(w.repoDir, 'worktree', 'lock', '--reason', 'locked after preview', locked.path)
    const result = await call(w.t.client, 'quirky.worktree/cleanupRemove', {
      selection: [
        { worktreeId: locked.id, fingerprint: lockedPreview.fingerprint },
        { worktreeId: removable.id, fingerprint: removablePreview.fingerprint }
      ],
      confirmed: true,
      yes: true
    }) as { results: CleanupRemovalResult[] }

    expect(result.results).toHaveLength(2)
    expect(result.results[0]).toMatchObject({ worktreeId: locked.id, removed: false })
    expect(result.results[0]!.error).toContain('locked')
    expect(result.results[1]).toMatchObject({ worktreeId: removable.id, removed: true })
    expect(realpathSync(locked.path)).toBe(locked.path)
    expect(() => realpathSync(removable.path)).toThrow()
    expect(git(w.repoDir, 'branch', '--list', 'removable')).toBe('')
  })

  test('cleanup preview and options are scriptable through an isolated CLI process', async () => {
    const w = await start()
    world = w
    const stale = await create(w, 'cli-stale')
    ageRows(w, [stale])

    const options = await cli(w, ['worktree', 'options', '--group-by', 'status', '--sort-by', 'name', '--compact', '--json'])
    expect(options.code).toBe(0)
    expect(JSON.parse(options.stdout)).toMatchObject({ groupBy: 'status', sortBy: 'name', compact: true })

    const preview = await cli(w, ['worktree', 'cleanup-preview', '--json'])
    expect(preview.code).toBe(0)
    expect((JSON.parse(preview.stdout) as { candidates: CleanupCandidate[] }).candidates.map((candidate) => candidate.worktreeId)).toContain(stale.id)

    const candidate = candidateFor((JSON.parse(preview.stdout) as { candidates: CleanupCandidate[] }).candidates, stale)
    const removed = await cli(w, [
      'worktree', 'cleanup-remove', '--selection', JSON.stringify([{ worktreeId: stale.id, fingerprint: candidate.fingerprint }]),
      '--confirm', '--yes', '--json'
    ])
    expect(removed.code).toBe(0)
    expect((JSON.parse(removed.stdout) as { results: CleanupRemovalResult[] }).results).toMatchObject([
      { worktreeId: stale.id, removed: true }
    ])
  })
})
