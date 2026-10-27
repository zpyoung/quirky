import { describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitError } from '../src/index'
import {
  NotAllowedError,
  abortOperation,
  continueOperation,
  hasConflictMarkers,
  readConflictFile
} from '../src/conflicts'
import { commitFiles, git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()

const porcelain = (dir: string): string[] => git(dir, 'status', '--porcelain', '--branch').split('\n').filter((l) => l.length > 0 && !l.startsWith('## '))

describe('hasConflictMarkers', () => {
  const cases: [string, string, boolean][] = [
    ['no markers', 'one\ntwo\n', false],
    ['ours marker', 'a\n<<<<<<< HEAD\nb\n', true],
    ['base marker', 'a\n||||||| base\nb\n', true],
    ['separator', 'a\n=======\nb\n', true],
    ['theirs marker', 'a\n>>>>>>> other\nb\n', true],
    ['CRLF separator', 'a\r\n=======\r\nb\r\n', true],
    ['CRLF ours marker', '<<<<<<< HEAD\r\n', true],
    ['marker with no trailing text', '<<<<<<<\n', false],
    ['longer separator', '========\n', false],
    ['separator with trailing text', '======= x\n', false],
    ['indented marker', '  <<<<<<< HEAD\n', false],
    ['marker mid-line', 'x <<<<<<< HEAD\n', false],
    ['marker on the last line without newline', 'a\n>>>>>>> other', true],
    ['empty', '', false]
  ]
  for (const [name, text, expected] of cases) {
    test(name, () => expect(hasConflictMarkers(text)).toBe(expected))
  }
})

describe('readConflictFile', () => {
  test('reads text with a sha-256 of its bytes', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 't.txt'), 'hello\n')
    const result = await readConflictFile(repo, 't.txt')
    expect(result.content).toBe('hello\n')
    expect(result.hash).toBe('5891b5b522d5df086d0ff0b110fbd9d21bb4fc7163af34d08286a2e846f6be03')
  })

  test('reports a missing file as null', async () => {
    const repo = makeRepo(scratch())
    expect(await readConflictFile(repo, 'nope.txt')).toEqual({ content: null, hash: null })
  })

  test('refuses a symlink, even a dangling one', async () => {
    const repo = makeRepo(scratch())
    symlinkSync('a.txt', join(repo, 'link'))
    symlinkSync('missing', join(repo, 'dangling'))
    for (const name of ['link', 'dangling']) {
      const error = await readConflictFile(repo, name).catch((e) => e)
      expect(error).toBeInstanceOf(NotAllowedError)
      expect(error.name).toBe('NotAllowedError')
      expect(error.message).toBe(`${name} is a symlink`)
    }
  })

  test('refuses a binary file', async () => {
    const repo = makeRepo(scratch())
    writeFileSync(join(repo, 'b.bin'), new Uint8Array([1, 2, 0, 3]))
    const error = await readConflictFile(repo, 'b.bin').catch((e) => e)
    expect(error).toBeInstanceOf(NotAllowedError)
    expect(error.message).toBe('b.bin is binary')
  })
})

/** `main` and `other` both change `c.txt` (and `d.txt`, when `two`) from the base commit. */
function diverged(dir: string, two = false): string {
  const repo = makeRepo(dir, { 'c.txt': 'base\n', 'd.txt': 'base\n' })
  git(repo, 'checkout', '-q', '-b', 'other')
  commitFiles(repo, { 'c.txt': 'theirs\n' })
  if (two) commitFiles(repo, { 'd.txt': 'theirs\n' })
  git(repo, 'checkout', '-q', 'main')
  commitFiles(repo, { 'c.txt': 'ours\n' })
  if (two) commitFiles(repo, { 'd.txt': 'ours\n' })
  return repo
}

describe('continueOperation', () => {
  test('commits a resolved merge without opening an editor', async () => {
    const repo = diverged(scratch())
    expect(() => git(repo, 'merge', 'other')).toThrow()
    writeFileSync(join(repo, 'c.txt'), 'merged\n')
    git(repo, 'add', 'c.txt')
    expect(await continueOperation(repo, 'merge')).toEqual({ finished: true })
    expect(git(repo, 'rev-list', '--parents', '-n1', 'HEAD').split(' ')).toHaveLength(3)
    expect(porcelain(repo)).toEqual([])
  })

  test('a rebase that stops on the second commit reports finished false, then finishes', async () => {
    const repo = diverged(scratch(), true)
    git(repo, 'checkout', '-q', 'other')
    expect(() => git(repo, 'rebase', 'main')).toThrow()
    writeFileSync(join(repo, 'c.txt'), 'merged\n')
    git(repo, 'add', 'c.txt')
    expect(await continueOperation(repo, 'rebase')).toEqual({ finished: false })
    expect(porcelain(repo)).toContain('UU d.txt')
    writeFileSync(join(repo, 'd.txt'), 'merged\n')
    git(repo, 'add', 'd.txt')
    expect(await continueOperation(repo, 'rebase')).toEqual({ finished: true })
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other')
    expect(git(repo, 'rev-list', '--count', 'main..HEAD')).toBe('2')
  })

  test('continues a cherry-pick', async () => {
    const repo = diverged(scratch())
    expect(() => git(repo, 'cherry-pick', 'other')).toThrow()
    writeFileSync(join(repo, 'c.txt'), 'picked\n')
    git(repo, 'add', 'c.txt')
    expect(await continueOperation(repo, 'cherry-pick')).toEqual({ finished: true })
    expect(git(repo, 'show', 'HEAD:c.txt')).toBe('picked')
    expect(porcelain(repo)).toEqual([])
  })

  test('a cherry-pick sequence that stops on its second commit is not finished', async () => {
    const repo = diverged(scratch(), true)
    const range = git(repo, 'rev-list', '--reverse', 'main..other').split('\n')
    expect(() => git(repo, 'cherry-pick', ...range)).toThrow()
    writeFileSync(join(repo, 'c.txt'), 'picked\n')
    git(repo, 'add', 'c.txt')
    expect(await continueOperation(repo, 'cherry-pick')).toEqual({ finished: false })
  })

  test('throws GitError with stderr while a conflict is unresolved', async () => {
    const repo = diverged(scratch())
    expect(() => git(repo, 'merge', 'other')).toThrow()
    const error = await continueOperation(repo, 'merge').catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.stderr.length).toBeGreaterThan(0)
  })

  test('a rebase with an unresolved conflict throws instead of reporting finished false', async () => {
    const repo = diverged(scratch())
    git(repo, 'checkout', '-q', 'other')
    expect(() => git(repo, 'rebase', 'main')).toThrow()
    await expect(continueOperation(repo, 'rebase')).rejects.toBeInstanceOf(GitError)
  })

  test('surfaces a failing hook as GitError', async () => {
    const repo = diverged(scratch())
    expect(() => git(repo, 'merge', 'other')).toThrow()
    writeFileSync(join(repo, 'c.txt'), 'merged\n')
    git(repo, 'add', 'c.txt')
    const hook = join(repo, '.git/hooks/pre-commit')
    mkdirSync(join(repo, '.git/hooks'), { recursive: true })
    writeFileSync(hook, '#!/bin/sh\necho hook-says-no >&2\nexit 1\n', { mode: 0o755 })
    const error = await continueOperation(repo, 'merge').catch((e) => e)
    expect(error).toBeInstanceOf(GitError)
    expect(error.stderr).toContain('hook-says-no')
  })
})

describe('abortOperation', () => {
  test('abort merge restores the pre-merge HEAD and tree', async () => {
    const repo = diverged(scratch())
    const before = git(repo, 'rev-parse', 'HEAD')
    expect(() => git(repo, 'merge', 'other')).toThrow()
    await abortOperation(repo, 'merge')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(porcelain(repo)).toEqual([])
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(false)
  })

  test('abort rebase restores the original branch and HEAD', async () => {
    const repo = diverged(scratch())
    git(repo, 'checkout', '-q', 'other')
    const before = git(repo, 'rev-parse', 'HEAD')
    expect(() => git(repo, 'rebase', 'main')).toThrow()
    await abortOperation(repo, 'rebase')
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(before)
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('other')
    expect(porcelain(repo)).toEqual([])
  })

  test('throws GitError when there is nothing to abort', async () => {
    const repo = makeRepo(scratch())
    await expect(abortOperation(repo, 'merge')).rejects.toBeInstanceOf(GitError)
  })
})
