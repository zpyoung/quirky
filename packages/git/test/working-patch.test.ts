import { describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gitApi } from '../src/api'
import { MAX_BLOB_BYTES, workingPatch } from '../src/diffs'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'

const { scratch } = isolateGitConfig()

describe('workingPatch', () => {
  test('folds staged, unstaged, deleted and untracked changes into one patch against HEAD', async () => {
    const repo = makeRepo(scratch(), { 'staged.txt': 'one\ntwo\n', 'unstaged.txt': 'a\nb\n', 'gone.txt': 'bye\n', 'both.txt': 'x\n' })
    writeFileSync(join(repo, 'staged.txt'), 'one\n2\n')
    git(repo, 'add', 'staged.txt')
    writeFileSync(join(repo, 'unstaged.txt'), 'a\nB\n')
    rmSync(join(repo, 'gone.txt'))
    writeFileSync(join(repo, 'both.txt'), 'y\n')
    git(repo, 'add', 'both.txt')
    writeFileSync(join(repo, 'both.txt'), 'z\n')
    mkdirSync(join(repo, 'dir'))
    writeFileSync(join(repo, 'dir', 'fresh.txt'), 'brand new\n')

    const { patch, omitted } = await workingPatch(repo)
    expect(omitted).toBe(false)
    expect(patch).toContain('diff --git a/staged.txt b/staged.txt')
    expect(patch).toContain('-two\n+2\n')
    expect(patch).toContain('-b\n+B\n')
    expect(patch).toContain('deleted file mode')
    expect(patch).toContain('-bye\n')
    expect(patch).toContain('-x\n+z\n')
    expect(patch).not.toContain('+y\n')
    expect(patch).toContain('diff --git a/dir/fresh.txt b/dir/fresh.txt')
    expect(patch).toContain('new file mode')
    expect(patch).toContain('+brand new\n')
    expect(patch).not.toContain('\u001b')
  })

  test('leaves the index and the working tree untouched and adds no object but the empty blob', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    writeFileSync(join(repo, 'fresh.txt'), 'new\n')
    const objects = () => git(repo, 'cat-file', '--batch-all-objects', '--batch-check').split('\n')
    const known = objects()
    const before = git(repo, 'status', '--porcelain')

    await workingPatch(repo)
    expect(git(repo, 'status', '--porcelain')).toBe(before)
    expect(before).toBe('M a.txt\n?? fresh.txt')
    const emptyBlob = 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 blob 0'
    expect(objects().filter((line) => !known.includes(line) && line !== emptyBlob)).toEqual([])
    expect(readdirSync(join(repo, '.git')).filter((name) => name.startsWith('index.'))).toEqual([])
    expect(readFileSync(join(repo, 'fresh.txt'), 'utf8')).toBe('new\n')
  })

  test('is empty when nothing differs from HEAD', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    expect(await workingPatch(repo)).toEqual({ patch: '', omitted: false })
  })

  test('does not list ignored files', async () => {
    const repo = makeRepo(scratch(), { '.gitignore': 'skip.txt\n' })
    writeFileSync(join(repo, 'skip.txt'), 'hidden\n')
    expect(await workingPatch(repo)).toEqual({ patch: '', omitted: false })
  })

  test('names a binary file without its bytes, tracked or untracked', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    writeFileSync(join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3]))
    const { patch } = await workingPatch(repo)
    expect(patch).toContain('diff --git a/blob.bin b/blob.bin')
    expect(patch).toContain('Binary files /dev/null and b/blob.bin differ')
  })

  test('does not run a configured external diff tool', async () => {
    const repo = makeRepo(scratch(), { 'a.txt': 'one\n' })
    git(repo, 'config', 'diff.external', 'false')
    writeFileSync(join(repo, 'a.txt'), 'two\n')
    expect((await workingPatch(repo)).patch).toContain('+two\n')
  })

  test('compares an unborn HEAD with the empty tree', async () => {
    const repo = scratch()
    mkdirSync(repo, { recursive: true })
    git(repo, 'init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'staged.txt'), 'staged\n')
    git(repo, 'add', 'staged.txt')
    writeFileSync(join(repo, 'staged.txt'), 'staged\nmore\n')
    writeFileSync(join(repo, 'loose.txt'), 'loose\n')

    const { patch, omitted } = await workingPatch(repo)
    expect(omitted).toBe(false)
    expect(patch).toContain('diff --git a/staged.txt b/staged.txt')
    expect(patch).toContain('+staged\n+more\n')
    expect(patch).toContain('diff --git a/loose.txt b/loose.txt')
    expect(patch).toContain('+loose\n')
  })

  test('reports a patch over 10 MiB as omitted and empty, whether the bytes are tracked or untracked', async () => {
    const repo = makeRepo(scratch())
    const line = `${'x'.repeat(63)}\n`
    const big = line.repeat(Math.ceil((MAX_BLOB_BYTES + 1024) / line.length))
    writeFileSync(join(repo, 'big.txt'), big)
    expect(await workingPatch(repo)).toEqual({ patch: '', omitted: true })

    git(repo, 'add', 'big.txt')
    expect(await workingPatch(repo)).toEqual({ patch: '', omitted: true })
  })

  test('is reachable through gitApi', () => {
    expect(gitApi().workingPatch).toBe(workingPatch)
  })
})
