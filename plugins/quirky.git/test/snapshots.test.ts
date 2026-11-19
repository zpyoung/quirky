import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { startGitHarness, type GitHarness } from './support'

let g: GitHarness
afterEach(() => g.cleanup())

const git = (cwd: string, ...args: string[]): string => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const snapshot = async (worktree = g.main.id): Promise<string> => (await g.call('quirky.git/snapshotTree', { worktree })).tree
const changes = async (from: string, to: string) => (await g.call('quirky.git/treeChanges', { worktree: g.main.id, from, to })).changes
const listing = (tree: string): string[] => git(g.main.path, 'ls-tree', '-r', '--name-only', tree).split('\n').filter(Boolean)

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to fail')
}

describe('quirky.git/snapshotTree', () => {
  test('counts an untracked file and leaves an ignored one out', async () => {
    g = await startGitHarness({ realGit: true })
    writeFileSync(join(g.main.path, '.gitignore'), 'ignored.log\n')
    writeFileSync(join(g.main.path, 'new.txt'), 'fresh\n')
    writeFileSync(join(g.main.path, 'ignored.log'), 'noise\n')

    expect(listing(await snapshot())).toEqual(['.gitignore', 'a.txt', 'new.txt'])
  })

  test('records the working content of a tracked file and drops a deleted one', async () => {
    g = await startGitHarness({ realGit: true })
    writeFileSync(join(g.main.path, 'a.txt'), 'changed\n')
    expect(git(g.main.path, 'show', `${await snapshot()}:a.txt`)).toBe('changed')

    rmSync(join(g.main.path, 'a.txt'))
    expect(listing(await snapshot())).toEqual([])
  })

  test('keeps a tracked file that .gitignore also matches', async () => {
    g = await startGitHarness({ realGit: true })
    writeFileSync(join(g.main.path, '.gitignore'), 'a.txt\n')
    writeFileSync(join(g.main.path, 'a.txt'), 'still tracked\n')
    expect(git(g.main.path, 'show', `${await snapshot()}:a.txt`)).toBe('still tracked')
  })

  test('never touches the real index, HEAD or refs', async () => {
    g = await startGitHarness({ realGit: true })
    writeFileSync(join(g.main.path, 'staged.txt'), 'staged\n')
    git(g.main.path, 'add', 'staged.txt')
    writeFileSync(join(g.main.path, 'a.txt'), 'edited\n')
    writeFileSync(join(g.main.path, 'untracked.txt'), 'loose\n')
    const before = {
      index: readFileSync(join(g.main.path, '.git', 'index')),
      head: git(g.main.path, 'rev-parse', 'HEAD'),
      refs: git(g.main.path, 'for-each-ref'),
      status: git(g.main.path, 'status', '--porcelain')
    }

    const tree = await snapshot()

    expect(listing(tree)).toEqual(['a.txt', 'staged.txt', 'untracked.txt'])
    expect(readFileSync(join(g.main.path, '.git', 'index')).equals(before.index)).toBe(true)
    expect(git(g.main.path, 'rev-parse', 'HEAD')).toBe(before.head)
    expect(git(g.main.path, 'for-each-ref')).toBe(before.refs)
    expect(git(g.main.path, 'status', '--porcelain')).toBe(before.status)
  })

  test('is the same tree twice while nothing changes', async () => {
    g = await startGitHarness({ realGit: true })
    writeFileSync(join(g.main.path, 'new.txt'), 'fresh\n')
    expect(await snapshot()).toBe(await snapshot())
  })

  test('works on an unborn HEAD', async () => {
    g = await startGitHarness({ realGit: true })
    rmSync(join(g.main.path, '.git'), { recursive: true })
    git(g.main.path, 'init', '-b', 'main')
    writeFileSync(join(g.main.path, 'first.txt'), 'one\n')

    const tree = await snapshot()

    expect(listing(tree)).toEqual(['a.txt', 'first.txt'])
    expect(Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', 'HEAD'], { cwd: g.main.path }).exitCode).not.toBe(0)
  })

  test('a folder that is not a git work tree is invalid-params', async () => {
    g = await startGitHarness({ realGit: true })
    const error = await failure(g.call('quirky.git/snapshotTree', { worktree: g.fixLogin.id }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toBe('not a git work tree')
  })
})

describe('quirky.git/treeChanges', () => {
  test('lists edits, additions and deletions between two snapshots with line counts', async () => {
    g = await startGitHarness({ realGit: true })
    mkdirSync(join(g.main.path, 'src'))
    writeFileSync(join(g.main.path, 'src', 'keep.ts'), 'a\nb\nc\n')
    const from = await snapshot()

    writeFileSync(join(g.main.path, 'a.txt'), 'new\nmore\n')
    writeFileSync(join(g.main.path, 'src', 'keep.ts'), 'a\nB\nc\n')
    writeFileSync(join(g.main.path, 'added.txt'), '1\n2\n3\n')
    const to = await snapshot()

    const list = await changes(from, to)
    const byPath = Object.fromEntries(list.map((change: { path: string }) => [change.path, change]))
    expect(Object.keys(byPath).sort()).toEqual(['a.txt', 'added.txt', 'src/keep.ts'])
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', status: 'modified', added: 2, removed: 1, binary: false })
    expect(byPath['added.txt']).toEqual({ path: 'added.txt', status: 'added', added: 3, removed: 0, binary: false })
    expect(byPath['src/keep.ts']).toMatchObject({ status: 'modified', added: 1, removed: 1 })

    rmSync(join(g.main.path, 'added.txt'))
    expect(await changes(to, await snapshot())).toEqual([{ path: 'added.txt', status: 'deleted', added: 0, removed: 3, binary: false }])
  })

  test('detects a rename and reports binary files with null counts', async () => {
    g = await startGitHarness({ realGit: true })
    const body = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n') + '\n'
    writeFileSync(join(g.main.path, 'before.txt'), body)
    const from = await snapshot()

    rmSync(join(g.main.path, 'before.txt'))
    writeFileSync(join(g.main.path, 'after.txt'), body)
    writeFileSync(join(g.main.path, 'blob.bin'), new Uint8Array([0, 1, 2, 3, 0, 255]))
    const list = await changes(from, await snapshot())

    expect(list.find((change: { path: string }) => change.path === 'after.txt')).toMatchObject({ status: 'renamed', oldPath: 'before.txt', added: 0, removed: 0 })
    expect(list.find((change: { path: string }) => change.path === 'blob.bin')).toEqual({ path: 'blob.bin', status: 'added', added: null, removed: null, binary: true })
  })

  test('two equal snapshots have no changes', async () => {
    g = await startGitHarness({ realGit: true })
    const tree = await snapshot()
    expect(await changes(tree, tree)).toEqual([])
  })

  test('an unknown tree oid is invalid-params', async () => {
    g = await startGitHarness({ realGit: true })
    const tree = await snapshot()
    const unknown = 'f'.repeat(40)
    for (const [from, to] of [[unknown, tree], [tree, unknown]]) {
      const error = await failure(g.call('quirky.git/treeChanges', { worktree: g.main.id, from, to }))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.message).toBe(`unknown tree ${unknown}`)
    }
    expect((await failure(g.call('quirky.git/treeChanges', { worktree: g.main.id, from: 'main', to: tree }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('quirky.git/diff with source trees', () => {
  test('reads one path from the from tree and the to tree', async () => {
    g = await startGitHarness({ realGit: true })
    const from = await snapshot()
    writeFileSync(join(g.main.path, 'a.txt'), 'new\n')
    writeFileSync(join(g.main.path, 'fresh.txt'), 'hello\n')
    const to = await snapshot()

    expect(await g.call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt', source: 'trees', from, to })).toMatchObject({
      path: 'a.txt',
      source: 'trees',
      staged: false,
      kind: 'text',
      original: 'old\n',
      modified: 'new\n'
    })
    expect(await g.call('quirky.git/diff', { worktree: g.main.id, path: 'fresh.txt', source: 'trees', from, to })).toMatchObject({ original: '', modified: 'hello\n' })
  })

  test('follows a rename through oldPath', async () => {
    g = await startGitHarness({ realGit: true })
    const from = await snapshot()
    rmSync(join(g.main.path, 'a.txt'))
    writeFileSync(join(g.main.path, 'b.txt'), 'old\nplus\n')
    const to = await snapshot()
    expect(await g.call('quirky.git/diff', { worktree: g.main.id, path: 'b.txt', oldPath: 'a.txt', source: 'trees', from, to })).toMatchObject({
      original: 'old\n',
      modified: 'old\nplus\n'
    })
  })

  test('needs both trees, and refuses one that does not exist', async () => {
    g = await startGitHarness({ realGit: true })
    const tree = await snapshot()
    const missing = await failure(g.call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt', source: 'trees', from: tree }))
    expect(missing.code).toBe(RpcErrorCode.InvalidParams)
    const unknown = 'e'.repeat(40)
    const error = await failure(g.call('quirky.git/diff', { worktree: g.main.id, path: 'a.txt', source: 'trees', from: unknown, to: tree }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(error.message).toBe(`unknown tree ${unknown}`)
  })
})
