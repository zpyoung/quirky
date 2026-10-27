import { describe, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import { changeList, compare } from '../src/compare'

const fixture = isolateGitConfig()

function commitAll(dir: string, files: Record<string, string>, message = 'update'): string {
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', message)
  return git(dir, 'rev-parse', 'HEAD')
}

const lines = (n: number, tag = 'l') => Array.from({ length: n }, (_, i) => `${tag}${i}\n`).join('')

/** `main` has one commit feat lacks; feat has two commits changing math.ts and adding util.ts. */
function featRepo(): string {
  const dir = makeRepo(fixture.scratch(), { 'math.ts': lines(10) })
  git(dir, 'checkout', '-q', '-b', 'feat')
  commitAll(dir, { 'math.ts': lines(10).replace('l0\n', 'x0\nx1\nx2\nx3\nx4\nx5\nx6\nx7\nx8\nx9\nx10\nx11\nx12\n').replace('l9\n', '') })
  commitAll(dir, { 'util.ts': lines(40, 'u') })
  git(dir, 'checkout', '-q', 'main')
  commitAll(dir, { 'other.ts': 'main only\n' })
  git(dir, 'checkout', '-q', 'feat')
  return dir
}

describe('changeList', () => {
  test('reports statuses, rename sources and numstat counts', async () => {
    const dir = makeRepo(fixture.scratch(), {
      'keep.txt': lines(20),
      'old.txt': lines(30, 'o'),
      'gone.txt': 'bye\n',
      'mode.sh': 'echo\n'
    })
    const from = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'mv', 'old.txt', 'new.txt')
    git(dir, 'rm', '-q', 'gone.txt')
    writeFileSync(join(dir, 'keep.txt'), lines(20).replace('l1\n', 'changed\n'))
    writeFileSync(join(dir, 'added.txt'), 'a\nb\n')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 0, 3]))
    chmodSync(join(dir, 'mode.sh'), 0o755)
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'change')
    const to = git(dir, 'rev-parse', 'HEAD')

    const byPath = Object.fromEntries((await changeList(dir, from, to)).map((c) => [c.path, c]))
    expect(byPath['keep.txt']).toEqual({ path: 'keep.txt', status: 'modified', added: 1, removed: 1, binary: false })
    expect(byPath['added.txt']).toEqual({ path: 'added.txt', status: 'added', added: 2, removed: 0, binary: false })
    expect(byPath['gone.txt']).toEqual({ path: 'gone.txt', status: 'deleted', added: 0, removed: 1, binary: false })
    expect(byPath['new.txt']).toEqual({ path: 'new.txt', oldPath: 'old.txt', status: 'renamed', added: 0, removed: 0, binary: false })
    expect(byPath['bin.dat']).toEqual({ path: 'bin.dat', status: 'added', added: null, removed: null, binary: true })
    expect(byPath['mode.sh']!.status).toBe('modified')
    expect(byPath['old.txt']).toBeUndefined()
  })

  test('a null from lists a root commit as additions', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'one\ntwo\n' })
    const root = git(dir, 'rev-parse', 'HEAD')
    expect(await changeList(dir, null, root)).toEqual([
      { path: 'a.txt', status: 'added', added: 2, removed: 0, binary: false }
    ])
  })

  test('a type change is a modification', async () => {
    const dir = makeRepo(fixture.scratch(), { 'f.txt': 'x\n' })
    const from = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'rm', '-q', 'f.txt')
    Bun.spawnSync(['ln', '-s', 'target', 'f.txt'], { cwd: dir })
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'to symlink')
    const [change] = await changeList(dir, from, git(dir, 'rev-parse', 'HEAD'))
    expect(change!.status).toBe('modified')
  })

  test('paths with spaces, tabs and unicode survive -z', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    const from = git(dir, 'rev-parse', 'HEAD')
    commitAll(dir, { 'sp aceé.txt': 'hi\n' })
    const list = await changeList(dir, from, git(dir, 'rev-parse', 'HEAD'))
    expect(list.map((c) => c.path)).toEqual(['sp aceé.txt'])
  })
})

describe('compare', () => {
  test('SC-47: ready lists what the branch changed since the merge base', async () => {
    const dir = featRepo()
    const result = await compare(dir, 'main')
    expect(result.status).toBe('ready')
    expect(result.base).toBe('main')
    expect(result.baseSource).toBeNull()
    expect(result.message).toBeNull()
    expect(result.ahead).toBe(2)
    expect(result.behind).toBe(1)
    expect(result.headOid).toBe(git(dir, 'rev-parse', 'feat'))
    expect(result.baseOid).toBe(git(dir, 'rev-parse', 'main'))
    expect(result.mergeBase).toBe(git(dir, 'rev-parse', 'main~1'))
    const byPath = Object.fromEntries(result.entries.map((c) => [c.path, c]))
    expect(Object.keys(byPath).sort()).toEqual(['math.ts', 'util.ts'])
    expect(byPath['math.ts']).toMatchObject({ status: 'modified', added: 13, removed: 2 })
    expect(byPath['util.ts']).toMatchObject({ status: 'added', added: 40, removed: 0 })
    expect(result.added).toBe(53)
    expect(result.removed).toBe(2)
  })

  test('binary files count nothing toward the totals', async () => {
    const dir = makeRepo(fixture.scratch(), { 'a.txt': 'x\n' })
    git(dir, 'checkout', '-q', '-b', 'feat')
    commitAll(dir, { 'b.txt': 'one\ntwo\n' })
    writeFileSync(join(dir, 'p.bin'), Buffer.from([0, 0, 1]))
    commitAll(dir, {})
    const result = await compare(dir, 'main')
    expect(result.entries.find((c) => c.path === 'p.bin')).toMatchObject({ binary: true, added: null, removed: null })
    expect([result.added, result.removed]).toEqual([2, 0])
  })

  test('SC-48a: an unresolvable base is invalid-base, not an error', async () => {
    const dir = featRepo()
    const result = await compare(dir, 'origin/gone')
    expect(result.status).toBe('invalid-base')
    expect(result.message).toBe('Base ref origin/gone could not be resolved in this repository.')
    expect(result.base).toBe('origin/gone')
    expect(result.entries).toEqual([])
    expect([result.ahead, result.behind, result.added, result.removed]).toEqual([0, 0, 0, 0])
    expect(result.baseOid).toBeNull()
    expect(result.mergeBase).toBeNull()
  })

  test('a base that looks like an option is just unresolvable', async () => {
    const dir = featRepo()
    expect((await compare(dir, '--all')).status).toBe('invalid-base')
  })

  test('SC-48b: an unborn HEAD is unborn-head', async () => {
    const dir = featRepo()
    git(dir, 'checkout', '-q', '--orphan', 'fresh')
    const result = await compare(dir, 'main')
    expect(result.status).toBe('unborn-head')
    expect(result.message).toBe('This branch does not have a committed HEAD yet, so compare-to-base is unavailable.')
    expect(result.headOid).toBeNull()
    expect(result.baseOid).toBe(git(dir, 'rev-parse', 'main'))
    expect(result.entries).toEqual([])
  })

  test('SC-48c: unrelated histories are no-merge-base', async () => {
    const dir = featRepo()
    git(dir, 'checkout', '-q', '--orphan', 'island')
    git(dir, 'rm', '-rfq', '.')
    commitAll(dir, { 'solo.txt': 'alone\n' })
    const result = await compare(dir, 'main')
    expect(result.status).toBe('no-merge-base')
    expect(result.message).toBe('This branch and main do not share a merge base, so compare-to-base is unavailable.')
    expect(result.baseOid).toBe(git(dir, 'rev-parse', 'main'))
    expect(result.headOid).toBe(git(dir, 'rev-parse', 'island'))
    expect(result.mergeBase).toBeNull()
    expect(result.entries).toEqual([])
    expect([result.ahead, result.behind]).toEqual([0, 0])
  })

  test('comparing a branch with itself is ready and empty', async () => {
    const dir = featRepo()
    const result = await compare(dir, 'feat')
    expect(result).toMatchObject({ status: 'ready', ahead: 0, behind: 0, entries: [], added: 0, removed: 0 })
  })
})
