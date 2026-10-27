import { describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { discardPaths, stagePaths, stageScope, unstagePaths } from '../src/discard'
import { commitFiles, git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()

const lines = (out: string): string[] => out.split('\0').filter((l) => l.length > 0)
const staged = (dir: string): string[] => lines(git(dir, 'diff', '--cached', '--name-only', '-z'))
const porcelain = (dir: string): string[] => git(dir, 'status', '--porcelain', '--branch').split('\n').filter((l) => l.length > 0 && !l.startsWith('## '))

/** A repo whose merge of `other` into `main` stops on `c.txt`. */
function conflicted(dir: string): string {
  const repo = makeRepo(dir, { 'c.txt': 'base\n', 'm.txt': 'm\n' })
  git(repo, 'checkout', '-q', '-b', 'other')
  commitFiles(repo, { 'c.txt': 'theirs\n' })
  git(repo, 'checkout', '-q', 'main')
  commitFiles(repo, { 'c.txt': 'ours\n' })
  expect(() => git(repo, 'merge', 'other')).toThrow()
  return repo
}

describe('stagePaths', () => {
  test('takes names with spaces, glob characters and a leading colon literally', async () => {
    const repo = makeRepo(scratch())
    for (const name of ['a b.txt', '*.md', ':x', 'other.md']) writeFileSync(join(repo, name), 'x\n')
    await stagePaths(repo, ['a b.txt', '*.md', ':x'])
    expect(staged(repo).sort()).toEqual(['*.md', ':x', 'a b.txt'])
  })

  test('does nothing for an empty list', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 'n.txt'), 'x\n')
    await stagePaths(repo, [])
    expect(staged(repo)).toEqual([])
  })

  test('stages a path deleted on disk as a deletion', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    rmSync(join(repo, 'b.txt'))
    await stagePaths(repo, ['b.txt'])
    expect(porcelain(repo)).toEqual(['D  b.txt'])
  })

  test('resolves a conflicted path once its markers are gone', async () => {
    const repo = conflicted(scratch())
    expect(porcelain(repo)).toContain('UU c.txt')
    writeFileSync(join(repo, 'c.txt'), 'merged\n')
    await stagePaths(repo, ['c.txt'])
    expect(porcelain(repo)).toEqual(['M  c.txt'])
  })

  test('resolves a conflicted path whose file was deleted', async () => {
    const repo = conflicted(scratch())
    rmSync(join(repo, 'c.txt'))
    await stagePaths(repo, ['c.txt'])
    expect(porcelain(repo)).toEqual(['D  c.txt'])
  })
})

describe('stageScope', () => {
  function dirty(dir: string): string {
    const repo = makeRepo(dir, { 'm.txt': 'm\n', 'gone.txt': 'g\n' })
    writeFileSync(join(repo, 'm.txt'), 'changed\n')
    rmSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'u.txt'), 'u\n')
    writeFileSync(join(repo, 'x.txt'), 'x\n')
    return repo
  }

  test('all stages changes, deletions and untracked files', async () => {
    const repo = dirty(scratch())
    await stageScope(repo, 'all')
    expect(staged(repo).sort()).toEqual(['gone.txt', 'm.txt', 'u.txt', 'x.txt'])
  })

  test('all leaves excluded paths alone', async () => {
    const repo = dirty(scratch())
    await stageScope(repo, 'all', ['x.txt'])
    expect(staged(repo).sort()).toEqual(['gone.txt', 'm.txt', 'u.txt'])
    expect(porcelain(repo)).toContain('?? x.txt')
  })

  test('tracked skips untracked files', async () => {
    const repo = dirty(scratch())
    await stageScope(repo, 'tracked')
    expect(staged(repo).sort()).toEqual(['gone.txt', 'm.txt'])
  })

  test('with unmerged paths, all stages the rest and leaves the conflict unresolved', async () => {
    const repo = conflicted(scratch())
    writeFileSync(join(repo, 'm.txt'), 'changed\n')
    writeFileSync(join(repo, 'u.txt'), 'u\n')
    writeFileSync(join(repo, 'x.txt'), 'x\n')
    await stageScope(repo, 'all', ['x.txt'])
    const status = porcelain(repo)
    expect(status).toContain('UU c.txt')
    expect(status).toContain('M  m.txt')
    expect(status).toContain('A  u.txt')
    expect(status).toContain('?? x.txt')
  })

  test('with unmerged paths, tracked stages only tracked changes', async () => {
    const repo = conflicted(scratch())
    writeFileSync(join(repo, 'm.txt'), 'changed\n')
    writeFileSync(join(repo, 'u.txt'), 'u\n')
    await stageScope(repo, 'tracked')
    const status = porcelain(repo)
    expect(status).toContain('UU c.txt')
    expect(status).toContain('M  m.txt')
    expect(status).toContain('?? u.txt')
  })
})

describe('unstagePaths', () => {
  test('resets both sides of a rename when given both paths', async () => {
    const repo = makeRepo(scratch(), { 'old.txt': 'content\n' })
    git(repo, 'mv', 'old.txt', 'new.txt')
    await unstagePaths(repo, ['old.txt', 'new.txt'])
    expect(porcelain(repo).sort()).toEqual([' D old.txt', '?? new.txt'])
  })

  test('works before the first commit', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    writeFileSync(join(dir, 'f.txt'), 'x\n')
    git(dir, 'add', 'f.txt')
    await unstagePaths(dir, ['f.txt'])
    expect(porcelain(dir)).toEqual(['?? f.txt'])
  })

  test('does nothing for an empty list', async () => {
    const repo = makeRepo(scratch())
    await unstagePaths(repo, [])
  })
})

describe('discardPaths', () => {
  test('restores a modified file and a deleted file', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n', 'b.txt': 'two\n' })
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    rmSync(join(repo, 'b.txt'))
    expect(await discardPaths(repo, ['a.txt', 'b.txt'])).toEqual({ failures: [] })
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')
    expect(readFileSync(join(repo, 'b.txt'), 'utf8')).toBe('two\n')
    expect(porcelain(repo)).toEqual([])
  })

  test('deletes an untracked file and an untracked folder', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 'new.txt'), 'x\n')
    mkdirSync(join(repo, 'dir/sub'), { recursive: true })
    writeFileSync(join(repo, 'dir/sub/f.txt'), 'x\n')
    expect(await discardPaths(repo, ['new.txt', 'dir'])).toEqual({ failures: [] })
    expect(existsSync(join(repo, 'new.txt'))).toBe(false)
    expect(existsSync(join(repo, 'dir'))).toBe(false)
  })

  test('deletes a new file that was staged and then unstaged', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 'n.txt'), 'x\n')
    git(repo, 'add', 'n.txt')
    await unstagePaths(repo, ['n.txt'])
    await discardPaths(repo, ['n.txt'])
    expect(existsSync(join(repo, 'n.txt'))).toBe(false)
  })

  test('takes glob characters literally', async () => {
    const repo = makeRepo(scratch(), { 'a.md': 'a\n' })
    writeFileSync(join(repo, '*.md'), 'x\n')
    writeFileSync(join(repo, 'a.md'), 'changed\n')
    await discardPaths(repo, ['*.md'])
    expect(readFileSync(join(repo, 'a.md'), 'utf8')).toBe('changed\n')
    expect(existsSync(join(repo, '*.md'))).toBe(false)
  })

  test('attributes a failure to its path and still discards the rest', async () => {
    const repo = makeRepo(scratch())
    mkdirSync(join(repo, 'locked'))
    writeFileSync(join(repo, 'locked/stuck.txt'), 'x\n')
    writeFileSync(join(repo, 'ok.txt'), 'x\n')
    chmodSync(join(repo, 'locked'), 0o555)
    try {
      const result = await discardPaths(repo, ['ok.txt', 'locked/stuck.txt'])
      expect(result.failures.map((f) => f.path)).toEqual(['locked/stuck.txt'])
      expect(result.failures[0]!.message.length).toBeGreaterThan(0)
      expect(existsSync(join(repo, 'ok.txt'))).toBe(false)
    } finally {
      chmodSync(join(repo, 'locked'), 0o755)
    }
  })
})
