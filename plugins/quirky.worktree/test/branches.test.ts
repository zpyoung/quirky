import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { commitFiles, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { BranchCleaner } from '../src/daemon/branches'
import { KeyedQueue } from '../src/daemon/queue'
import { makeOrigin, makeProject } from './fixtures/repos'

const { scratch } = isolateGitConfig()

/** A project cloned from a local origin, so `origin/main` exists next to `main`. */
function project(): string {
  return makeProject(join(scratch(), 'api'), { origin: makeOrigin(join(scratch(), 'origin.git')) })
}

/** A branch `name` cut from main with `files` committed on it, not checked out anywhere. */
function branchWith(repo: string, name: string, ...commits: Record<string, string>[]): string {
  const folder = join(scratch(), name.replaceAll('/', '-'))
  git(repo, 'worktree', 'add', '-q', '-b', name, folder, 'main')
  for (const files of commits) commitFiles(folder, files)
  const head = git(folder, 'rev-parse', 'HEAD')
  git(repo, 'worktree', 'remove', '--force', folder)
  return head
}

const exists = (repo: string, branch: string) => Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, env: process.env }).exitCode === 0
const input = (repoPath: string, branch: string, extra: Partial<{ keepBranch: boolean; baseRef: string | null }> = {}) => ({ repoPath, branch, keepBranch: false, baseRef: null, ...extra })

describe('BranchCleaner.cleanUp', () => {
  test('a merged branch goes with git branch -d', async () => {
    const repo = project()
    branchWith(repo, 'merged')
    expect(await new BranchCleaner().cleanUp(input(repo, 'merged'))).toEqual({ status: 'deleted' })
    expect(exists(repo, 'merged')).toBe(false)
  })

  test('a branch to keep is left alone and nothing is reported', async () => {
    const repo = project()
    branchWith(repo, 'reused')
    expect(await new BranchCleaner().cleanUp(input(repo, 'reused', { keepBranch: true }))).toEqual({ status: 'skipped' })
    expect(exists(repo, 'reused')).toBe(true)
  })

  test('an unmerged branch is kept and reported with its head', async () => {
    const repo = project()
    const head = branchWith(repo, 'unmerged', { 'x.txt': 'x\n' })
    expect(await new BranchCleaner().cleanUp(input(repo, 'unmerged', { baseRef: 'origin/main' }))).toEqual({ status: 'kept', name: 'unmerged', head })
    expect(exists(repo, 'unmerged')).toBe(true)
  })

  test('a branch already gone needs nothing', async () => {
    const repo = project()
    expect(await new BranchCleaner().cleanUp(input(repo, 'never-existed'))).toEqual({ status: 'deleted' })
  })

  test('a squash merge into the recorded base counts as merged', async () => {
    const repo = project()
    branchWith(repo, 'squashed', { 'one.txt': '1\n' }, { 'two.txt': '2\n' })
    git(repo, 'merge', '--squash', 'squashed')
    git(repo, 'commit', '-q', '-m', 'squash')
    git(repo, 'push', '-q', 'origin', 'main')
    expect(await new BranchCleaner().cleanUp(input(repo, 'squashed', { baseRef: 'origin/main' }))).toEqual({ status: 'deleted' })
    expect(exists(repo, 'squashed')).toBe(false)
  })

  test('a squash merge into the detected default base counts even without a recorded base', async () => {
    const repo = project()
    branchWith(repo, 'squashed', { 'one.txt': '1\n' })
    git(repo, 'merge', '--squash', 'squashed')
    git(repo, 'commit', '-q', '-m', 'squash')
    git(repo, 'push', '-q', 'origin', 'main')
    expect(await new BranchCleaner().cleanUp(input(repo, 'squashed'))).toEqual({ status: 'deleted' })
  })

  test('a squash merge into the upstream counts', async () => {
    const repo = project()
    branchWith(repo, 'tracked', { 'one.txt': '1\n' })
    git(repo, 'push', '-q', 'origin', 'main:landed')
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'branch', '--set-upstream-to=origin/landed', 'tracked')
    git(repo, 'checkout', '-q', '-b', 'landing', 'origin/landed')
    git(repo, 'merge', '--squash', 'tracked')
    git(repo, 'commit', '-q', '-m', 'squash')
    git(repo, 'push', '-q', 'origin', 'landing:landed')
    git(repo, 'checkout', '-q', 'main')
    expect(await new BranchCleaner().cleanUp(input(repo, 'tracked'))).toEqual({ status: 'deleted' })
    expect(exists(repo, 'tracked')).toBe(false)
  })

  test('a registration whose folder was deleted is pruned so the branch can go', async () => {
    const repo = project()
    const folder = join(scratch(), 'gone')
    git(repo, 'worktree', 'add', '-q', '-b', 'gone', folder, 'main')
    rmSync(folder, { recursive: true, force: true })
    expect(await new BranchCleaner().cleanUp(input(repo, 'gone'))).toEqual({ status: 'deleted' })
    expect(exists(repo, 'gone')).toBe(false)
  })

  test('a branch still checked out is kept, never deleted by reference', async () => {
    const repo = project()
    const folder = join(scratch(), 'busy')
    git(repo, 'worktree', 'add', '-q', '-b', 'busy', folder, 'main')
    const outcome = await new BranchCleaner().cleanUp(input(repo, 'busy'))
    expect(outcome.status).toBe('kept')
    expect(exists(repo, 'busy')).toBe(true)
  })

  test('cleanups of one repository run one at a time', async () => {
    const repo = project()
    for (const name of ['a', 'b', 'c']) branchWith(repo, name)
    let active = 0
    let peak = 0
    class Watching extends KeyedQueue {
      override run<T>(key: string, task: () => Promise<T>): Promise<T> {
        return super.run(key, async () => {
          active++
          peak = Math.max(peak, active)
          try {
            return await task()
          } finally {
            active--
          }
        })
      }
    }
    const cleaner = new BranchCleaner(new Watching())
    await Promise.all(['a', 'b', 'c'].map((name) => cleaner.cleanUp(input(repo, name))))
    expect(peak).toBe(1)
    for (const name of ['a', 'b', 'c']) expect(exists(repo, name)).toBe(false)
  })
})

describe('BranchCleaner.deleteAt', () => {
  test('deletes the branch only while it is at the given head', async () => {
    const repo = project()
    const head = branchWith(repo, 'later', { 'x.txt': 'x\n' })
    const cleaner = new BranchCleaner()
    const tree = git(repo, 'rev-parse', 'later^{tree}')
    const moved = git(repo, 'commit-tree', tree, '-p', 'later', '-m', 'more')
    git(repo, 'update-ref', 'refs/heads/later', moved)

    expect(await cleaner.deleteAt(repo, 'later', head)).toEqual({ deleted: false, head: moved })
    expect(exists(repo, 'later')).toBe(true)
    expect(await cleaner.deleteAt(repo, 'later', moved)).toEqual({ deleted: true })
    expect(exists(repo, 'later')).toBe(false)
  })

  test('a branch that no longer exists reports no head', async () => {
    const repo = project()
    expect(await new BranchCleaner().deleteAt(repo, 'nope', 'a'.repeat(40))).toEqual({ deleted: false, head: null })
  })
})
