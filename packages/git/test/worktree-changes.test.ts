import { describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { worktreeChangeList } from '../src/compare'
import { MAX_BLOB_BYTES, contentHash, diffSource } from '../src/diffs'

const fixture = isolateGitConfig()

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join('')
const bytes = (text: string) => new TextEncoder().encode(text)

function commitAll(dir: string, files: Record<string, string | Uint8Array>, message = 'update'): string {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

/** A feature branch off main; returns the repo and the merge base of feat and main. */
function featRepo(files: Record<string, string>): { dir: string; base: string } {
  const dir = makeRepo(fixture.scratch(), files)
  const base = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'checkout', '-q', '-b', 'feat')
  return { dir, base }
}

const byPath = <T extends { path: string }>(list: T[]) => Object.fromEntries(list.map((c) => [c.path, c]))

describe('worktreeChangeList', () => {
  test('folds committed, staged, unstaged and untracked changes into one list, each file once', async () => {
    const { dir, base } = featRepo({
      'committed.ts': lines(5),
      'staged.ts': lines(5),
      'unstaged.ts': lines(5),
      'both.ts': lines(5),
      'untouched.ts': lines(5)
    })
    commitAll(dir, { 'committed.ts': lines(5).replace('l0\n', 'x0\nx1\n') })
    commitAll(dir, { 'both.ts': lines(5).replace('l0\n', 'c0\n') })
    writeFileSync(join(dir, 'both.ts'), lines(5).replace('l0\n', 'c0\n').replace('l1\n', 'd1\n'))
    writeFileSync(join(dir, 'staged.ts'), lines(5).replace('l2\n', 's2\n'))
    git(dir, 'add', 'staged.ts')
    writeFileSync(join(dir, 'unstaged.ts'), lines(5).replace('l3\n', 'u3\n'))
    writeFileSync(join(dir, 'fresh.ts'), 'a\nb\nc\n')

    const { changes, capped } = await worktreeChangeList(dir, base)
    expect(capped).toBe(false)
    expect(changes.map((c) => c.path).sort()).toEqual(['both.ts', 'committed.ts', 'fresh.ts', 'staged.ts', 'unstaged.ts'])
    const map = byPath(changes)
    expect(map['committed.ts']).toEqual({ path: 'committed.ts', status: 'modified', added: 2, removed: 1, binary: false })
    expect(map['staged.ts']).toEqual({ path: 'staged.ts', status: 'modified', added: 1, removed: 1, binary: false })
    expect(map['unstaged.ts']).toEqual({ path: 'unstaged.ts', status: 'modified', added: 1, removed: 1, binary: false })
    // counts run base to disk, not branch to index
    expect(map['both.ts']).toEqual({ path: 'both.ts', status: 'modified', added: 2, removed: 2, binary: false })
    expect(map['fresh.ts']).toEqual({ path: 'fresh.ts', status: 'untracked', added: 3, removed: 0, binary: false })
  })

  test('lists deleted, renamed and binary files', async () => {
    const { dir, base } = featRepo({ 'gone.txt': 'bye\n', 'old.txt': lines(30, 'o'), 'bin.dat': 'text\n' })
    rmSync(join(dir, 'gone.txt'))
    git(dir, 'mv', 'old.txt', 'new.txt')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    writeFileSync(join(dir, 'raw.bin'), Buffer.from([9, 0, 9]))

    const map = byPath((await worktreeChangeList(dir, base)).changes)
    expect(map['gone.txt']).toEqual({ path: 'gone.txt', status: 'deleted', added: 0, removed: 1, binary: false })
    expect(map['new.txt']).toEqual({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', added: 0, removed: 0, binary: false })
    expect(map['old.txt']).toBeUndefined()
    expect(map['bin.dat']).toMatchObject({ status: 'modified', added: null, removed: null, binary: true })
    expect(map['raw.bin']).toEqual({ path: 'raw.bin', status: 'untracked', added: null, removed: null, binary: true })
  })

  test('an untracked file over the blob cap has null counts and is not binary', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    writeFileSync(join(dir, 'huge.txt'), 'x'.repeat(MAX_BLOB_BYTES + 1))
    const map = byPath((await worktreeChangeList(dir, base)).changes)
    expect(map['huge.txt']).toEqual({ path: 'huge.txt', status: 'untracked', added: null, removed: null, binary: false })
  })

  test('a file that matches the base again is not listed', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    commitAll(dir, { 'a.txt': 'two\n' })
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    expect((await worktreeChangeList(dir, base)).changes).toEqual([])
  })

  test('limit caps the list and reports capped; exactly the limit is not capped', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    for (const name of ['t1.txt', 't2.txt', 't3.txt']) writeFileSync(join(dir, name), 'x\n')
    writeFileSync(join(dir, 'a.txt'), 'changed\n')

    const capped = await worktreeChangeList(dir, base, { limit: 3 })
    expect(capped.capped).toBe(true)
    expect(capped.changes).toHaveLength(3)
    const exact = await worktreeChangeList(dir, base, { limit: 4 })
    expect(exact.capped).toBe(false)
    expect(exact.changes).toHaveLength(4)
  })

  test('sharedSymlinks that are symlinks are left out, real paths of the same name are kept', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    mkdirSync(join(dir, 'target'))
    symlinkSync(join(dir, 'target'), join(dir, 'node_modules'))
    mkdirSync(join(dir, 'real_dir'))
    writeFileSync(join(dir, 'real_dir', 'f.txt'), 'x\n')
    symlinkSync('a.txt', join(dir, 'shared.txt'))
    writeFileSync(join(dir, 'plain.txt'), 'x\n')

    const { changes } = await worktreeChangeList(dir, base, { sharedSymlinks: ['node_modules', 'real_dir', 'shared.txt'] })
    expect(changes.map((c) => c.path).sort()).toEqual(['plain.txt', 'real_dir/f.txt'])
  })

  test('it never reads the index as the comparison side', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    writeFileSync(join(dir, 'a.txt'), 'two\n')
    git(dir, 'add', 'a.txt')
    writeFileSync(join(dir, 'a.txt'), 'one\n')
    expect((await worktreeChangeList(dir, base)).changes).toEqual([])
  })
})

describe('diffSource with the worktree source', () => {
  test('compares the blob at from with the file on disk and hashes the disk bytes', async () => {
    const { dir, base } = featRepo({ 'math.ts': 'v1\n' })
    commitAll(dir, { 'math.ts': 'v2\n' })
    writeFileSync(join(dir, 'math.ts'), 'v3\n')
    const d = await diffSource(dir, { path: 'math.ts', source: 'worktree', from: base })
    expect(d).toMatchObject({ path: 'math.ts', original: 'v1\n', modified: 'v3\n', kind: 'text', binary: false })
    expect(d.modifiedHash).toBe(contentHash(bytes('v3\n')))
    expect(d.modifiedDeleted).toBeUndefined()
  })

  test('a file deleted on disk is marked deleted with the base content on the left', async () => {
    const { dir, base } = featRepo({ 'gone.ts': 'bye\n' })
    rmSync(join(dir, 'gone.ts'))
    const d = await diffSource(dir, { path: 'gone.ts', source: 'worktree', from: base })
    expect(d).toMatchObject({ original: 'bye\n', modified: '', modifiedDeleted: true, modifiedHash: null })
  })

  test('an untracked or newly added file has an empty original side', async () => {
    const { dir, base } = featRepo({ 'a.txt': 'one\n' })
    commitAll(dir, { 'added.txt': 'new\n' })
    writeFileSync(join(dir, 'notes.txt'), 'notes\n')
    expect(await diffSource(dir, { path: 'notes.txt', source: 'worktree', from: base })).toMatchObject({
      original: '',
      modified: 'notes\n'
    })
    expect(await diffSource(dir, { path: 'added.txt', source: 'worktree', from: base })).toMatchObject({
      original: '',
      modified: 'new\n'
    })
  })

  test('a rename reads the original from oldPath', async () => {
    const { dir, base } = featRepo({ 'old.ts': 'a\nb\n' })
    git(dir, 'mv', 'old.ts', 'new.ts')
    const d = await diffSource(dir, { path: 'new.ts', oldPath: 'old.ts', source: 'worktree', from: base })
    expect(d).toMatchObject({ original: 'a\nb\n', modified: 'a\nb\n', oldPath: 'old.ts' })
  })

  test('an empty from (unborn HEAD) gives an empty original side', async () => {
    const { dir } = featRepo({ 'a.txt': 'one\n' })
    const d = await diffSource(dir, { path: 'a.txt', source: 'worktree', from: '' })
    expect(d).toMatchObject({ original: '', modified: 'one\n' })
  })

  test('from is required', async () => {
    const { dir } = featRepo({ 'a.txt': 'one\n' })
    await expect(diffSource(dir, { path: 'a.txt', source: 'worktree' })).rejects.toThrow()
  })
})
