import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GitError, listRegistrations, listWorktrees } from '../src/index'
import { git, runGit } from '../src/run'

type Stats = { hits: number; spawns: number; uncacheable: number; entries: number }
type Reader = { read(repo: string): Promise<string>; stats(): Stats }

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-worktree-list-test-')))
const savedEnvironment: Record<string, string | undefined> = {}
const environmentOverrides: Record<string, string | undefined> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_DIR: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_WORK_TREE: undefined
}
let counter = 0

beforeAll(() => {
  for (const [key, value] of Object.entries(environmentOverrides)) {
    savedEnvironment[key] = process.env[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

afterAll(() => {
  for (const key of Object.keys(environmentOverrides)) {
    if (savedEnvironment[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnvironment[key]
  }
  rmSync(scratch, { recursive: true, force: true })
})

function gitSync(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function makeRepository(name = 'repo'): string {
  const repo = join(scratch, `${name}-${counter++}`)
  mkdirSync(repo, { recursive: true })
  gitSync(repo, 'init', '-q', '-b', 'main')
  gitSync(repo, 'config', 'user.name', 'Worktree List Tests')
  gitSync(repo, 'config', 'user.email', 'worktree-list@example.invalid')
  gitSync(repo, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(repo, 'seed.txt'), 'seed\n')
  gitSync(repo, 'add', 'seed.txt')
  gitSync(repo, 'commit', '-q', '-m', 'initial')
  return repo
}

function worktreePath(name: string): string {
  return join(scratch, `${name}-${counter++}`)
}

function addBranchWorktree(repo: string, name = 'wt1', branch = 'one'): string {
  const path = worktreePath(name)
  gitSync(repo, 'worktree', 'add', '-b', branch, path)
  return path
}

function freshListing(repo: string): string {
  return gitSync(repo, 'worktree', 'list', '--porcelain')
}

function commitFile(cwd: string, message: string): void {
  const file = `change-${counter++}.txt`
  writeFileSync(join(cwd, file), `${message}\n`)
  gitSync(cwd, 'add', '--', file)
  gitSync(cwd, 'commit', '-q', '-m', message)
}

function noQuietPeriod(): number {
  return Date.now() + 10_000
}

function delay(ms: number): Promise<void> {
  // Git reads real filesystem timestamps, so the quiet-period integration tests need real elapsed time.
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

async function expectUncacheableReads(reader: Reader, repo: string): Promise<void> {
  const fresh = freshListing(repo)
  expect(await reader.read(repo)).toBe(fresh)
  expect(await reader.read(repo)).toBe(fresh)
  expect(reader.stats()).toEqual({ hits: 0, spawns: 2, uncacheable: 2, entries: 0 })
}

// Body-local reader imports keep existing integration tests runnable before the new module exists.
describe('worktree-list reader', () => {
  test('returns an unchanged listing from one git run', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('unchanged')
    addBranchWorktree(repo)
    const reader = createWorktreeListReader({ now: noQuietPeriod })
    const fresh = freshListing(repo)

    expect(await reader.read(repo)).toBe(fresh)
    expect(await reader.read(repo)).toBe(fresh)
    expect(await reader.read(repo)).toBe(fresh)
    expect(reader.stats()).toEqual({ hits: 2, spawns: 1, uncacheable: 0, entries: 1 })
  })

  test('invalidates for every file and worktree change used by git listing', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('changes')
    const wt1 = addBranchWorktree(repo)
    const wt2 = worktreePath('wt2')
    const wt3 = worktreePath('wt3')
    const wt3b = worktreePath('wt3b')
    const reader = createWorktreeListReader({ now: noQuietPeriod })

    await reader.read(repo)
    const changes: Array<{ name: string; apply: () => void }> = [
      { name: 'add a branch worktree', apply: () => gitSync(repo, 'worktree', 'add', '-b', 'two', wt2) },
      { name: 'add a detached worktree', apply: () => gitSync(repo, 'worktree', 'add', '--detach', wt3) },
      { name: 'commit in the linked worktree', apply: () => commitFile(wt1, 'linked commit') },
      { name: 'commit in the main worktree', apply: () => commitFile(repo, 'main commit') },
      { name: 'switch the linked worktree branch', apply: () => gitSync(wt1, 'switch', '-c', 'other') },
      { name: 'lock a detached worktree', apply: () => gitSync(repo, 'worktree', 'lock', '--reason', 'held', wt3) },
      { name: 'unlock a detached worktree', apply: () => gitSync(repo, 'worktree', 'unlock', wt3) },
      { name: 'pack refs', apply: () => gitSync(repo, 'pack-refs', '--all') },
      { name: 'commit in the linked worktree after packing refs', apply: () => commitFile(wt1, 'linked commit after pack') },
      { name: 'run git gc', apply: () => gitSync(repo, 'gc') },
      { name: 'rename the checked-out branch', apply: () => gitSync(wt1, 'branch', '-m', 'other', 'renamed') },
      { name: 'move a detached worktree', apply: () => gitSync(repo, 'worktree', 'move', wt3, wt3b) },
      { name: 'delete the moved worktree folder', apply: () => rmSync(wt3b, { recursive: true, force: true }) },
      { name: 'prune worktrees', apply: () => gitSync(repo, 'worktree', 'prune') },
      { name: 'update the checked-out ref', apply: () => gitSync(wt1, 'update-ref', 'refs/heads/renamed', 'HEAD~1') },
      { name: 'detach the linked worktree', apply: () => gitSync(wt1, 'checkout', '--detach') },
      { name: 'remove the linked worktree', apply: () => gitSync(repo, 'worktree', 'remove', '--force', wt1) }
    ]

    for (const change of changes) {
      const before = reader.stats()
      change.apply()
      const fresh = freshListing(repo)

      expect(await reader.read(repo)).toBe(fresh)
      expect(await reader.read(repo)).toBe(fresh)
      expect(reader.stats()).toEqual({
        hits: before.hits + 1,
        spawns: before.spawns + 1,
        uncacheable: before.uncacheable,
        entries: 1
      })
    }
  }, 30_000)

  test('never remembers a listing during the quiet period', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('quiet')
    const reader = createWorktreeListReader()

    await delay(2_100)
    const initial = freshListing(repo)
    expect(await reader.read(repo)).toBe(initial)
    expect(reader.stats()).toEqual({ hits: 0, spawns: 1, uncacheable: 0, entries: 1 })

    const wt4 = worktreePath('wt4')
    gitSync(repo, 'worktree', 'add', '-b', 'fast', wt4)
    const changed = freshListing(repo)
    const before = reader.stats()
    expect(await reader.read(repo)).toBe(changed)
    expect(await reader.read(repo)).toBe(changed)
    expect(reader.stats()).toEqual({
      hits: before.hits,
      spawns: before.spawns + 2,
      uncacheable: before.uncacheable + 2,
      entries: 0
    })

    const longQuiet = createWorktreeListReader({ quietMs: 3_600_000 })
    expect(await longQuiet.read(repo)).toBe(changed)
    expect(await longQuiet.read(repo)).toBe(changed)
    expect(longQuiet.stats()).toEqual({ hits: 0, spawns: 2, uncacheable: 2, entries: 0 })

    const noQuiet = createWorktreeListReader({ quietMs: 0 })
    expect(await noQuiet.read(repo)).toBe(changed)
    expect(await noQuiet.read(repo)).toBe(changed)
    expect(noQuiet.stats()).toEqual({ hits: 1, spawns: 1, uncacheable: 0, entries: 1 })
  }, 30_000)

  test('always runs git from a linked worktree whose .git is a file', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('linked-path')
    const linked = addBranchWorktree(repo)
    expect(statSync(join(linked, '.git')).isFile()).toBe(true)
    const reader = createWorktreeListReader({ now: noQuietPeriod })

    await expectUncacheableReads(reader, linked)
  })

  test('always runs git when a reftable directory exists', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('reftable')
    mkdirSync(join(repo, '.git', 'reftable'))
    const reader = createWorktreeListReader({ now: noQuietPeriod })

    await expectUncacheableReads(reader, repo)
  })

  test('always runs git when HEAD names a ref outside refs/heads', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('external-head')
    gitSync(repo, 'symbolic-ref', 'HEAD', 'refs/tags/v1')
    const reader = createWorktreeListReader({ now: noQuietPeriod })

    await expectUncacheableReads(reader, repo)
  })

  test('always runs git when the checked-out branch is a symbolic ref', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('symbolic-branch')
    gitSync(repo, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main')
    gitSync(repo, 'symbolic-ref', 'HEAD', 'refs/heads/alias')
    const reader = createWorktreeListReader({ now: noQuietPeriod })

    await expectUncacheableReads(reader, repo)
  })

  test('always runs git when its environment overrides the worktree location', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('overridden-env')

    for (const variable of ['GIT_DIR', 'GIT_COMMON_DIR', 'GIT_WORK_TREE']) {
      const reader = createWorktreeListReader({
        now: noQuietPeriod,
        env: { [variable]: '/unrelated/git/location' },
        run: async (path: string) => freshListing(path)
      })
      await expectUncacheableReads(reader, repo)
    }
  })

  test('rejects with the GitError from git when the repository cannot be listed', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = join(scratch, `not-a-repository-${counter++}`)
    mkdirSync(repo)
    const reader = createWorktreeListReader({ now: noQuietPeriod })
    const expected = await git(repo, ['worktree', 'list', '--porcelain'], { readOnly: true }).catch((error: unknown) => error)
    const actual = await reader.read(repo).catch((error: unknown) => error)

    expect(expected).toBeInstanceOf(GitError)
    expect(actual).toBeInstanceOf(GitError)
    if (expected instanceof GitError && actual instanceof GitError) {
      expect(actual.constructor).toBe(expected.constructor)
      expect(actual).toMatchObject({ message: expected.message, stderr: expected.stderr, exitCode: expected.exitCode })
    }
    expect(reader.stats()).toMatchObject({ hits: 0, spawns: 1, entries: 0 })
  })

  test('does not remember output when the repository changes while git runs', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('changes-during-read')
    const wt1 = addBranchWorktree(repo)
    let locked = false
    const reader = createWorktreeListReader({
      now: noQuietPeriod,
      run: async (path: string) => {
        if (!locked) {
          gitSync(path, 'worktree', 'lock', wt1)
          locked = true
        }
        return freshListing(path)
      }
    })

    expect(await reader.read(repo)).toBe(freshListing(repo))
    expect(reader.stats().entries).toBe(0)
    expect(await reader.read(repo)).toBe(freshListing(repo))
    expect(reader.stats().spawns).toBe(2)
  })

  test('does not repopulate the cache when dropped during a read', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repo = makeRepository('drop-during-read')
    const listing = freshListing(repo)
    const gate = Promise.withResolvers<void>()
    let calls = 0
    const reader = createWorktreeListReader({
      now: noQuietPeriod,
      run: async () => {
        calls++
        if (calls === 1) await gate.promise
        return listing
      }
    })

    const pending = reader.read(repo)
    reader.drop()
    gate.resolve()

    expect(await pending).toBe(listing)
    expect(reader.stats().entries).toBe(0)
    expect(await reader.read(repo)).toBe(listing)
    expect(reader.stats().spawns).toBe(2)
  })


  test('evicts the oldest repository when its bounded cache fills', async () => {
    const { createWorktreeListReader } = await import('../src/worktree-list')
    const repos = [makeRepository('fifo-a'), makeRepository('fifo-b'), makeRepository('fifo-c')]
    const reader = createWorktreeListReader({ now: noQuietPeriod, maxEntries: 2 })

    for (const repo of repos) expect(await reader.read(repo)).toBe(freshListing(repo))
    expect(reader.stats()).toEqual({ hits: 0, spawns: 3, uncacheable: 0, entries: 2 })
    expect(await reader.read(repos[0]!)).toBe(freshListing(repos[0]!))
    expect(reader.stats()).toEqual({ hits: 0, spawns: 4, uncacheable: 0, entries: 2 })
  })
})

describe('worktree listing integration', () => {
  test('loads run before index and the reader in a fresh process', () => {
    // A fresh module graph is required because this test file has already imported index.
    const runUrl = new URL('../src/run.ts', import.meta.url).href
    const indexUrl = new URL('../src/index.ts', import.meta.url).href
    const readerUrl = new URL('../src/worktree-list.ts', import.meta.url).href
    const script = [
      '(async () => {',
      `  await import(${JSON.stringify(runUrl)})`,
      `  await import(${JSON.stringify(indexUrl)})`,
      `  await import(${JSON.stringify(readerUrl)})`,
      "  process.stdout.write('loaded')",

      '})().catch((error) => { console.error(error); process.exitCode = 1 })'
    ].join('\n')
    const result = Bun.spawnSync([process.execPath, '-e', script], { cwd: scratch, env: process.env })

    expect(result.exitCode).toBe(0)
    expect(result.stdout.toString()).toContain('loaded')
  })

  test('listRegistrations and listWorktrees share a cached listing', async () => {
    const repo = makeRepository('shared-listing')
    const linked = addBranchWorktree(repo)
    await delay(2_100)

    const registrationsBefore = await listRegistrations(repo)
    const worktreesBefore = await listWorktrees(repo)
    expect(registrationsBefore.map((worktree) => worktree.path)).toEqual([repo, linked])
    expect(worktreesBefore.map((worktree) => worktree.path)).toEqual([repo, linked])

    const { dropWorktreeListCache, worktreeListStats } = await import('../src/worktree-list')
    dropWorktreeListCache()
    const before = worktreeListStats()
    const registrations = await listRegistrations(repo)
    const worktrees = await listWorktrees(repo)
    const after = worktreeListStats()

    expect(registrations.map((worktree) => worktree.path)).toEqual([repo, linked])
    expect(worktrees.map((worktree) => worktree.path)).toEqual([repo, linked])
    expect(after.spawns - before.spawns).toBe(1)
    expect(after.hits - before.hits).toBe(1)
    expect(after.entries).toBe(1)
  }, 30_000)

  test('reports a deleted linked folder as missing and prunable without waiting', async () => {
    const repo = makeRepository('deleted-folder')
    const linked = addBranchWorktree(repo)
    await delay(2_100)
    expect((await listRegistrations(repo)).find((worktree) => worktree.path === linked)?.exists).toBe(true)

    rmSync(linked, { recursive: true, force: true })
    const registration = (await listRegistrations(repo)).find((worktree) => worktree.path === linked)
    expect(registration).toMatchObject({ exists: false, prunable: true })
  }, 30_000)

  test('runGit mutations drop remembered listings and the next listing sees the lock', async () => {
    const repo = makeRepository('mutation-invalidation')
    const linked = addBranchWorktree(repo)
    await delay(2_100)

    expect((await listRegistrations(repo)).find((worktree) => worktree.path === linked)?.locked).toBeNull()
    expect((await runGit(repo, ['worktree', 'lock', linked])).exitCode).toBe(0)
    expect((await listRegistrations(repo)).find((worktree) => worktree.path === linked)?.locked).toBe('')

    const { dropWorktreeListCache, worktreeListStats } = await import('../src/worktree-list')
    dropWorktreeListCache()
    expect((await runGit(repo, ['worktree', 'unlock', linked])).exitCode).toBe(0)
    await delay(2_100)
    expect((await listRegistrations(repo)).find((worktree) => worktree.path === linked)?.locked).toBeNull()
    expect(worktreeListStats().entries).toBe(1)

    expect((await runGit(repo, ['worktree', 'lock', linked])).exitCode).toBe(0)
    expect(worktreeListStats().entries).toBe(0)
    expect((await listRegistrations(repo)).find((worktree) => worktree.path === linked)?.locked).toBe('')
    dropWorktreeListCache()
  }, 30_000)
})
