import { mkdirSync } from 'node:fs'
import { Database } from 'bun:sqlite'
import { afterEach, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { Repo, WorktreeCreateResult } from '@quirky/protocol'
import { spawnCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { githubUser, makeOrigin, makeProject, setSetting, startWorld, useGlobalGitConfig, type World } from './fixtures/repos'

const { scratch } = isolateGitConfig()
let world: World | undefined

afterEach(async () => {
  await world?.t.cleanup()
  world = undefined
})

let fixtureNumber = 0

async function start(files: Record<string, string> = { 'a.txt': 'one\n' }): Promise<World & { dir: string; repo: Repo }> {
  useGlobalGitConfig(scratch, githubUser('zoe'))
  const started = await startWorld('fake')
  fixtureNumber += 1
  const origin = makeOrigin(join(scratch(), `prepared-origin-${fixtureNumber}.git`), { files })
  const dir = makeProject(join(scratch(), `prepared-project-${fixtureNumber}`), { origin })
  const repo = await started.add(dir)
  await setSetting(started.client, 'worktreesRoot', started.root)
  world = started
  return { ...started, dir, repo }
}

const countRegistrations = (dir: string) => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length

const call = (w: World, method: string, params: Record<string, unknown> = {}) => w.client.callAny(method, params)

test('the CLI prefetch is consumed by canonical create only for the exact repo and base', async () => {
  const w = await start()
  const proc = spawnCli(['worktree', 'prefetch', w.repo.id, '--base', 'origin/main', '--json'], { home: w.t.h.home })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  expect(code).toBe(0)
  expect(stderr).toBe('')
  expect(JSON.parse(stdout)).toMatchObject({ prepared: true, repoId: w.repo.id, base: 'origin/main' })
  expect(countRegistrations(w.dir)).toBe(2)
  const visible = await call(w, 'quirky.worktree/list') as Array<{ path: string }>
  expect(visible.some((worktree) => worktree.path.includes('.quirky-preparing'))).toBe(false)

  const cli = spawnCli(['worktree', 'create', '--repo', w.repo.id, '--name', 'from-prepared', '--base', 'origin/main', '--json'], { home: w.t.h.home })
  const [createdOut, createdErr, createCode] = await Promise.all([new Response(cli.stdout).text(), new Response(cli.stderr).text(), cli.exited])
  expect(createCode).toBe(0)
  expect(createdErr).toBe('')
  const created = JSON.parse(createdOut) as {
    worktree: { name: string }
    creationReceipt: { preparedCheckout: boolean }
  }
  expect(created).toMatchObject({
    worktree: { name: 'from-prepared' },
    creationReceipt: { preparedCheckout: true }
  })
  expect(countRegistrations(w.dir)).toBe(2)
  expect(git(w.dir, 'worktree', 'list', '--porcelain')).not.toContain('.quirky-preparing')
})

test('dirty, sparse, and existing-branch creates never claim a prepared checkout', async () => {
  const w = await start({ 'src/main.ts': 'export {}\n', 'docs/readme.md': 'docs\n' })
  await call(w, 'quirky.worktree/prefetchCreate', { repo: w.repo.id, base: 'origin/main' })
  git(w.dir, 'branch', 'pre-existing', 'origin/main')

  const sparse = await call(w, 'quirky.worktree/create', {
    repo: w.repo.id,
    name: 'sparse-create',
    base: 'origin/main',
    sparsePaths: ['src']
  }) as WorktreeCreateResult & { creationReceipt: { preparedCheckout?: boolean } }
  expect(sparse.creationReceipt.preparedCheckout).toBe(false)
  expect(git(sparse.worktree.path, 'sparse-checkout', 'list')).toContain('src')

  const existing = await call(w, 'quirky.worktree/create', {
    repo: w.repo.id,
    branch: 'pre-existing',
    name: 'existing-branch-create'
  }) as WorktreeCreateResult & { creationReceipt: { preparedCheckout?: boolean } }
  expect(existing.creationReceipt.preparedCheckout).toBe(false)
  expect(git(existing.worktree.path, 'rev-parse', 'HEAD')).toBe(git(w.dir, 'rev-parse', 'origin/main'))

  await call(w, 'quirky.worktree/prefetchCreate', { repo: w.repo.id, base: 'origin/main' })
  git(w.dir, 'config', 'user.name', 'Test')
  await Bun.write(join(w.dir, 'dirty.txt'), 'dirty\n')
  const dirty = await call(w, 'quirky.worktree/create', {
    repo: w.repo.id,
    name: 'dirty-primary-create',
    base: 'origin/main'
  }) as WorktreeCreateResult & { creationReceipt: { preparedCheckout?: boolean } }
  expect(dirty.creationReceipt.preparedCheckout).toBe(false)
  expect(await Bun.file(join(w.dir, 'dirty.txt')).text()).toBe('dirty\n')
})

test('prepared pool remains bounded to three entries and expires persisted stale checkouts', async () => {
  const first = await start()
  const secondDir = makeProject(join(scratch(), 'prepared-second'), { files: { 'a.txt': 'two\n' } })
  const second = await first.add(secondDir)
  const thirdDir = makeProject(join(scratch(), 'prepared-third'), { files: { 'a.txt': 'three\n' } })
  const third = await first.add(thirdDir)
  const fourthDir = makeProject(join(scratch(), 'prepared-fourth'), { files: { 'a.txt': 'four\n' } })
  const fourth = await first.add(fourthDir)

  const results: unknown[] = []
  for (const repo of [first.repo.id, second.id, third.id, fourth.id]) {
    results.push(await call(first, 'quirky.worktree/prefetchCreate', { repo, base: 'main' }))
  }
  expect(results.filter((row) => (row as { prepared: boolean }).prepared)).toHaveLength(3)

  const db = new Database(join(first.t.h.home, 'plugin-data', 'quirky.worktree', 'store.db'))
  try {
    db.query('UPDATE prepared_worktrees SET created_at = 0').run()
  } finally {
    db.close()
  }
  await call(first, 'quirky.worktree/prefetchCreate', { repo: first.repo.id, base: 'main' })
  expect(git(first.dir, 'worktree', 'list', '--porcelain').match(/\.quirky-preparing/g)).toHaveLength(1)
})
test('restart removes only the exact owned preparation and preserves a foreign locked worktree', async () => {
  const w = await start()
  const preparation = await call(w, 'quirky.worktree/prefetchCreate', { repo: w.repo.id, base: 'origin/main' }) as { prepared: boolean }
  expect(preparation.prepared).toBe(true)
  const db = new Database(join(w.t.h.home, 'plugin-data', 'quirky.worktree', 'store.db'))
  let preparedPath = ''
  try {
    const row = db.query('SELECT path FROM prepared_worktrees').get() as { path: string } | null
    if (!row) throw new Error('prefetch did not persist its exact checkout path')
    preparedPath = row.path
  } finally {
    db.close()
  }

  const foreignPath = join(w.root, '.quirky-preparing', 'foreign-registration')
  mkdirSync(join(w.root, '.quirky-preparing'), { recursive: true })
  git(w.dir, 'worktree', 'add', '--detach', '--no-checkout', '--lock', '--reason', 'foreign-owner', foreignPath, 'origin/main')
  await w.t.restart()
  await w.t.client.callAny('quirky.worktree/list', {})
  const registrations = git(w.dir, 'worktree', 'list', '--porcelain')
  expect(registrations).toContain(foreignPath)
  expect(registrations).not.toContain(preparedPath)
})

