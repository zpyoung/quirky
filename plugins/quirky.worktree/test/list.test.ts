import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { realpathSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Worktree } from '@quirky/protocol'
import { makeTempHome } from '../../../packages/daemon/test/helpers'
import { call, failure, git, isolateGitConfig, makeRepo } from '../../quirky.repo/test/git-fixtures'
import { startPluginHarness } from '../../quirky.repo/test/harness'
import { addExternalWorktree, listWorktrees, startRealProject, storedRows, type RealProject } from './fixtures/real-project'

const { scratch } = isolateGitConfig()
let p: RealProject | undefined
afterEach(async () => {
  await p?.t.cleanup()
  p = undefined
})

async function start() {
  p = await startRealProject(scratch)
  return p
}

describe('list reconcile: rows follow git and the folder', () => {
  test('a worktree seen with no row gets one on first sight: external, in-progress, created when its folder was', async () => {
    const { client, repoDir, repo, t } = await start()
    const path = addExternalWorktree(repoDir, join(scratch(), 'ext'), 'zoe/ext')

    const listed = await listWorktrees(client, { repo: repo.id })
    const external = listed.find((w) => w.path === path)!
    expect(external).toMatchObject({
      isMain: false,
      kind: 'git',
      branch: 'zoe/ext',
      name: 'ext',
      displayName: null,
      comment: '',
      status: 'in-progress',
      pinned: false,
      unread: false,
      parentId: null,
      createdBy: 'external',
      baseRef: null,
      keepBranch: false,
      removing: false,
      groupId: null,
      createdAt: Math.round(statSync(path).birthtimeMs)
    })
    expect(storedRows(t.h.home, 'id = ?', external.id)).toMatchObject([{ repo_id: repo.id, created_by: 'external', birthtime: external.createdAt, path }])
  })

  test('the name is the display name, else the branch for the primary and the folder name for the rest', async () => {
    const { client, repoDir, repo } = await start()
    const path = addExternalWorktree(repoDir, join(scratch(), 'fix-login'), 'zoe/fix-login')
    let [main, fixLogin] = await listWorktrees(client, { repo: repo.id })
    expect([main!.name, fixLogin!.name]).toEqual(['main', 'fix-login'])

    git(repoDir, 'checkout', '-q', '--detach')
    ;[main] = await listWorktrees(client, { repo: repo.id })
    expect(main).toMatchObject({ name: repo.name, branch: null, isMain: true })

    await call(client, 'quirky.worktree/set', { worktree: `path:${path}`, displayName: 'Login fix' })
    ;[, fixLogin] = await listWorktrees(client, { repo: repo.id })
    expect(fixLogin).toMatchObject({ name: 'Login fix', displayName: 'Login fix', branch: 'zoe/fix-login' })
  })

  test('order is the primary first, then oldest first', async () => {
    const { client, repoDir, repo } = await start()
    const older = addExternalWorktree(repoDir, join(scratch(), 'older'), 'older')
    await Bun.sleep(15)
    const newer = addExternalWorktree(repoDir, join(scratch(), 'newer'), 'newer')
    expect((await listWorktrees(client, { repo: repo.id })).map((w) => w.path)).toEqual([repoDir, older, newer])
  })

  test('a prunable registration is hidden but keeps its row until git forgets it', async () => {
    const { client, repoDir, repo, t } = await start()
    const path = addExternalWorktree(repoDir, join(scratch(), 'gone'), 'gone')
    const [, gone] = await listWorktrees(client, { repo: repo.id })
    await call(client, 'quirky.worktree/set', { worktree: gone!.id, comment: 'keep me' })

    rmSync(path, { recursive: true })
    expect((await listWorktrees(client, { repo: repo.id })).map((w) => w.id)).not.toContain(gone!.id)
    expect(storedRows(t.h.home, 'id = ?', gone!.id)).toMatchObject([{ comment: 'keep me' }])

    git(repoDir, 'worktree', 'prune')
    await listWorktrees(client, { repo: repo.id })
    expect(storedRows(t.h.home, 'id = ?', gone!.id)).toEqual([])
  })

  test('an unregistered row whose folder exists is kept as an orphan and hidden', async () => {
    const { client, repoDir, repo, t } = await start()
    const path = addExternalWorktree(repoDir, join(scratch(), 'orphan'), 'orphan')
    const [, orphan] = await listWorktrees(client, { repo: repo.id })

    rmSync(join(repoDir, '.git', 'worktrees'), { recursive: true })
    expect((await listWorktrees(client, { repo: repo.id })).map((w) => w.path)).toEqual([repoDir])
    expect(storedRows(t.h.home, 'id = ?', orphan!.id)).toMatchObject([{ path }])
  })

  test('a failed git call deletes nothing', async () => {
    const { client, repoDir, repo, t } = await start()
    addExternalWorktree(repoDir, join(scratch(), 'kept'), 'kept')
    await listWorktrees(client, { repo: repo.id })
    const before = storedRows(t.h.home).length
    expect(before).toBe(2)

    const away = `${repoDir}-away`
    renameSync(repoDir, away)
    try {
      expect((await failure(call(client, 'quirky.worktree/list', { repo: repo.id }))).code).toBeDefined()
      expect(await listWorktrees(client)).toEqual([])
      expect(storedRows(t.h.home)).toHaveLength(before)
    } finally {
      renameSync(away, repoDir)
    }
    expect(await listWorktrees(client, { repo: repo.id })).toHaveLength(2)
  })

  test('a row for a reused path is discarded and the new folder starts from defaults', async () => {
    const { client, repoDir, repo } = await start()
    const path = addExternalWorktree(repoDir, join(scratch(), 'reused'), 'reused')
    const [, first] = await listWorktrees(client, { repo: repo.id })
    await call(client, 'quirky.worktree/set', { worktree: first!.id, displayName: 'Old', status: 'done', pinned: true })

    git(repoDir, 'worktree', 'remove', '--force', path)
    await Bun.sleep(15)
    git(repoDir, 'worktree', 'add', '-q', path, 'reused')
    const [, second] = await listWorktrees(client, { repo: repo.id })
    expect(second).toMatchObject({ id: first!.id, displayName: null, status: 'in-progress', pinned: false, createdBy: 'external' })
    expect(second!.createdAt).toBeGreaterThan(first!.createdAt)
  })

  test('list without a repo covers every project, and one that git cannot list is left out', async () => {
    const { client, repoDir } = await start()
    const other = (await call(client, 'quirky.repo/add', { path: makeRepo(join(scratch(), 'web')) })) as Repo
    expect((await listWorktrees(client)).map((w) => w.repoId)).toEqual([expect.any(String), other.id])
    renameSync(repoDir, `${repoDir}-away`)
    try {
      expect((await listWorktrees(client)).map((w) => w.repoId)).toEqual([other.id])
    } finally {
      renameSync(`${repoDir}-away`, repoDir)
    }
  })
})

describe('store migration 2', () => {
  test('a v1 row (ID and repo only) keeps defaults and is filled on first sight', async () => {
    const repoDir = makeRepo(join(scratch(), 'legacy'))
    const external = addExternalWorktree(repoDir, join(scratch(), 'legacy-ext'), 'legacy-ext')
    const idOf = (path: string) => `wt_${createHash('sha1').update(realpathSync(path)).digest('hex').slice(0, 12)}`

    const home = makeTempHome()
    const db = new Database(join(home, 'quirky.db'), { create: true })
    db.exec(`
      CREATE TABLE repos (id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL UNIQUE, added_at INTEGER NOT NULL);
      CREATE TABLE worktrees (id TEXT PRIMARY KEY, repo_id TEXT NOT NULL);
    `)
    db.query("INSERT INTO repos VALUES ('repo_legacy', 'legacy', ?, 1700000000000)").run(repoDir)
    db.query("INSERT INTO worktrees VALUES (?, 'repo_legacy')").run(idOf(external))
    db.close()

    const t = await startPluginHarness({ realGit: true, home })
    p = { t, client: t.client, repoDir, root: '', repo: undefined as never }
    const listed = await listWorktrees(t.client, { repo: 'repo_legacy' })
    expect(listed.find((w) => w.id === idOf(external))).toMatchObject({ status: 'in-progress', createdBy: 'external', createdAt: Math.round(statSync(external).birthtimeMs) })
    expect(storedRows(home, 'id = ?', idOf(external))).toMatchObject([
      { kind: 'git', status: 'in-progress', created_by: 'external', birthtime: Math.round(statSync(external).birthtimeMs), path: external }
    ])
  })
})
