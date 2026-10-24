import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GitError,
  addWorktree,
  commit,
  diff,
  listWorktrees,
  removeWorktree,
  resolveRepoRoot,
  stage,
  status,
  unstage
} from '../../src/git'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-git-test-')))
const saved: Record<string, string | undefined> = {}
const envOverrides: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1'
}
let counter = 0

beforeAll(() => {
  for (const [k, v] of Object.entries(envOverrides)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})

afterAll(() => {
  for (const k of Object.keys(envOverrides)) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(scratch, { recursive: true, force: true })
})

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(['git', ...args], { cwd, env: process.env })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.toString()}`)
  return r.stdout.toString().trim()
}

function freshDir(name: string): string {
  const dir = join(scratch, `${name}-${counter++}`)
  mkdirSync(dir, { recursive: true })
  return dir
}

function initRepo(name = 'repo'): string {
  const dir = freshDir(name)
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function write(dir: string, rel: string, content: string | Uint8Array): void {
  const full = join(dir, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

function repoWithCommit(name = 'repo'): string {
  const dir = initRepo(name)
  write(dir, 'a.txt', 'one\n')
  git(dir, 'add', '.')
  git(dir, 'commit', '-q', '-m', 'init')
  return dir
}

describe('resolveRepoRoot', () => {
  test('resolves from a subdirectory', async () => {
    const dir = repoWithCommit()
    mkdirSync(join(dir, 'sub/deep'), { recursive: true })
    expect(await resolveRepoRoot(join(dir, 'sub/deep'))).toBe(dir)
  })

  test('throws GitError outside a repo', async () => {
    const dir = freshDir('plain')
    const err = await resolveRepoRoot(dir).catch((e) => e)
    expect(err).toBeInstanceOf(GitError)
    expect(err.exitCode).not.toBe(0)
    expect(err.stderr.length).toBeGreaterThan(0)
  })
})

describe('status', () => {
  test('clean repo reports branch and no files', async () => {
    const dir = repoWithCommit()
    expect(await status(dir)).toEqual({
      branch: 'main',
      upstream: null,
      ahead: 0,
      behind: 0,
      files: []
    })
  })

  test('modified, staged, untracked and deleted files', async () => {
    const dir = repoWithCommit()
    write(dir, 'b.txt', 'b\n')
    write(dir, 'c.txt', 'c\n')
    git(dir, 'add', 'b.txt', 'c.txt')
    git(dir, 'commit', '-q', '-m', 'more')
    write(dir, 'a.txt', 'changed\n')
    write(dir, 'b.txt', 'changed\n')
    git(dir, 'add', 'b.txt')
    rmSync(join(dir, 'c.txt'))
    write(dir, 'new/untracked.txt', 'u\n')

    const s = await status(dir)
    const byPath = Object.fromEntries(s.files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toEqual({ path: 'a.txt', index: ' ', worktree: 'M', untracked: false })
    expect(byPath['b.txt']).toEqual({ path: 'b.txt', index: 'M', worktree: ' ', untracked: false })
    expect(byPath['c.txt']).toEqual({ path: 'c.txt', index: ' ', worktree: 'D', untracked: false })
    expect(byPath['new/untracked.txt']).toEqual({
      path: 'new/untracked.txt',
      index: '?',
      worktree: '?',
      untracked: true
    })
    expect(s.files).toHaveLength(4)
  })

  test('renames carry origPath', async () => {
    const dir = repoWithCommit()
    git(dir, 'mv', 'a.txt', 'renamed file.txt')
    const s = await status(dir)
    expect(s.files).toEqual([
      { path: 'renamed file.txt', index: 'R', worktree: ' ', untracked: false, origPath: 'a.txt' }
    ])
  })

  test('paths with spaces and unicode are not quoted', async () => {
    const dir = repoWithCommit()
    write(dir, 'dir with space/fü ☃.txt', 'x')
    const s = await status(dir)
    expect(s.files.map((f) => f.path)).toEqual(['dir with space/fü ☃.txt'])
  })

  test('repo with no commits', async () => {
    const dir = initRepo()
    write(dir, 'a.txt', 'a')
    write(dir, 'b.txt', 'b')
    git(dir, 'add', 'a.txt')
    const s = await status(dir)
    expect(s.branch).toBe('main')
    expect(s.upstream).toBeNull()
    expect(s.ahead).toBe(0)
    expect(s.behind).toBe(0)
    expect(s.files).toEqual([
      { path: 'a.txt', index: 'A', worktree: ' ', untracked: false },
      { path: 'b.txt', index: '?', worktree: '?', untracked: true }
    ])
  })

  test('detached HEAD has a null branch', async () => {
    const dir = repoWithCommit()
    git(dir, 'checkout', '-q', '--detach')
    const s = await status(dir)
    expect(s.branch).toBeNull()
    expect(s.upstream).toBeNull()
  })

  test('ahead and behind against an upstream', async () => {
    const remote = freshDir('remote')
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    const dir = repoWithCommit('local')
    git(dir, 'remote', 'add', 'origin', remote)
    git(dir, 'push', '-q', '-u', 'origin', 'main')

    const other = freshDir('other')
    git(other, 'clone', '-q', remote, 'c')
    const clone = join(other, 'c')
    git(clone, 'config', 'user.name', 'Test')
    git(clone, 'config', 'user.email', 'test@example.com')
    write(clone, 'r1.txt', '1')
    git(clone, 'add', '.')
    git(clone, 'commit', '-q', '-m', 'r1')
    git(clone, 'push', '-q')

    write(dir, 'l1.txt', '1')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'l1')
    write(dir, 'l2.txt', '2')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'l2')
    git(dir, 'fetch', '-q')

    const s = await status(dir)
    expect(s.branch).toBe('main')
    expect(s.upstream).toBe('origin/main')
    expect(s.ahead).toBe(2)
    expect(s.behind).toBe(1)
  })

  test('throws GitError outside a repo', async () => {
    expect(status(freshDir('plain'))).rejects.toBeInstanceOf(GitError)
  })
})

describe('worktrees', () => {
  test('add, list and remove', async () => {
    const dir = repoWithCommit()
    const wtPath = join(freshDir('wts'), 'nested', 'feature wt')
    await addWorktree(dir, wtPath, 'feature/x')

    const list = await listWorktrees(dir)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ path: dir, branch: 'main', isMain: true })
    expect(list[0]!.head).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(list[1]).toMatchObject({ path: wtPath, branch: 'feature/x', isMain: false })

    await removeWorktree(dir, wtPath, false)
    expect(await listWorktrees(dir)).toHaveLength(1)
  })

  test('addWorktree honours baseRef', async () => {
    const dir = repoWithCommit()
    const first = git(dir, 'rev-parse', 'HEAD')
    write(dir, 'b.txt', 'b')
    git(dir, 'add', '.')
    git(dir, 'commit', '-q', '-m', 'second')
    const wtPath = join(freshDir('wts'), 'wt')
    await addWorktree(dir, wtPath, 'from-first', first)
    const list = await listWorktrees(dir)
    expect(list.find((w) => w.branch === 'from-first')!.head).toBe(first)
  })

  test('addWorktree surfaces git errors', async () => {
    const dir = repoWithCommit()
    const base = freshDir('wts')
    await addWorktree(dir, join(base, 'one'), 'dup')
    const branchErr = await addWorktree(dir, join(base, 'two'), 'dup').catch((e) => e)
    expect(branchErr).toBeInstanceOf(GitError)
    const pathErr = await addWorktree(dir, join(base, 'one'), 'other').catch((e) => e)
    expect(pathErr).toBeInstanceOf(GitError)
  })

  test('detached worktree has null branch', async () => {
    const dir = repoWithCommit()
    const wtPath = join(freshDir('wts'), 'det')
    await addWorktree(dir, wtPath, 'tmp')
    git(wtPath, 'checkout', '-q', '--detach')
    const info = (await listWorktrees(dir)).find((w) => w.path === wtPath)!
    expect(info.branch).toBeNull()
    expect(info.head).toBe(git(wtPath, 'rev-parse', 'HEAD'))
  })

  test('listWorktrees works when called from a linked worktree and keeps main first', async () => {
    const dir = repoWithCommit()
    const wtPath = join(freshDir('wts'), 'linked')
    await addWorktree(dir, wtPath, 'linked')
    const list = await listWorktrees(wtPath)
    expect(list[0]).toMatchObject({ path: dir, isMain: true })
  })

  test('skips worktrees whose directory is gone', async () => {
    const dir = repoWithCommit()
    const wtPath = join(freshDir('wts'), 'gone')
    await addWorktree(dir, wtPath, 'gone')
    rmSync(wtPath, { recursive: true, force: true })
    const list = await listWorktrees(dir)
    expect(list.map((w) => w.path)).toEqual([dir])
  })

  test('removeWorktree needs force for a dirty worktree', async () => {
    const dir = repoWithCommit()
    const wtPath = join(freshDir('wts'), 'dirty')
    await addWorktree(dir, wtPath, 'dirty')
    write(wtPath, 'untracked.txt', 'x')
    expect(removeWorktree(dir, wtPath, false)).rejects.toBeInstanceOf(GitError)
    await removeWorktree(dir, wtPath, true)
    expect(await listWorktrees(dir)).toHaveLength(1)
  })
})

describe('diff', () => {
  test('unstaged: original is the index, modified is the working tree', async () => {
    const dir = repoWithCommit()
    write(dir, 'a.txt', 'staged\n')
    git(dir, 'add', 'a.txt')
    write(dir, 'a.txt', 'worktree\n')
    expect(await diff(dir, 'a.txt', false)).toEqual({
      path: 'a.txt',
      staged: false,
      original: 'staged\n',
      modified: 'worktree\n',
      binary: false
    })
  })

  test('staged: original is HEAD, modified is the index', async () => {
    const dir = repoWithCommit()
    write(dir, 'a.txt', 'staged\n')
    git(dir, 'add', 'a.txt')
    write(dir, 'a.txt', 'worktree\n')
    expect(await diff(dir, 'a.txt', true)).toEqual({
      path: 'a.txt',
      staged: true,
      original: 'one\n',
      modified: 'staged\n',
      binary: false
    })
  })

  test('untracked file has empty original', async () => {
    const dir = repoWithCommit()
    write(dir, 'sub/new file.txt', 'fresh\n')
    const d = await diff(dir, 'sub/new file.txt', false)
    expect(d.original).toBe('')
    expect(d.modified).toBe('fresh\n')
    expect(d.binary).toBe(false)
  })

  test('deleted file has empty modified', async () => {
    const dir = repoWithCommit()
    rmSync(join(dir, 'a.txt'))
    expect(await diff(dir, 'a.txt', false)).toMatchObject({ original: 'one\n', modified: '' })
    git(dir, 'rm', '-q', '--cached', 'a.txt')
    expect(await diff(dir, 'a.txt', true)).toMatchObject({ original: 'one\n', modified: '' })
  })

  test('newly added staged file has empty original', async () => {
    const dir = repoWithCommit()
    write(dir, 'n.txt', 'n\n')
    git(dir, 'add', 'n.txt')
    expect(await diff(dir, 'n.txt', true)).toMatchObject({ original: '', modified: 'n\n' })
  })

  test('staged diff in a repo without commits', async () => {
    const dir = initRepo()
    write(dir, 'n.txt', 'n\n')
    git(dir, 'add', 'n.txt')
    expect(await diff(dir, 'n.txt', true)).toMatchObject({
      original: '',
      modified: 'n\n',
      binary: false
    })
  })

  test('NUL bytes mark a file binary', async () => {
    const dir = repoWithCommit()
    write(dir, 'bin.dat', new Uint8Array([1, 2, 0, 3]))
    const d = await diff(dir, 'bin.dat', false)
    expect(d).toEqual({ path: 'bin.dat', staged: false, original: '', modified: '', binary: true })
    git(dir, 'add', 'bin.dat')
    expect(await diff(dir, 'bin.dat', true)).toMatchObject({
      original: '',
      modified: '',
      binary: true
    })
  })

  test('files over 2 MB are binary', async () => {
    const dir = repoWithCommit()
    write(dir, 'big.txt', 'x'.repeat(2 * 1024 * 1024 + 1))
    expect(await diff(dir, 'big.txt', false)).toMatchObject({
      original: '',
      modified: '',
      binary: true
    })
  })
})

describe('stage, unstage and commit', () => {
  test('stage adds new, modified and deleted files', async () => {
    const dir = repoWithCommit()
    write(dir, 'new.txt', 'n')
    write(dir, 'a.txt', 'changed')
    write(dir, 'gone.txt', 'g')
    git(dir, 'add', 'gone.txt')
    git(dir, 'commit', '-q', '-m', 'gone')
    rmSync(join(dir, 'gone.txt'))

    await stage(dir, ['new.txt', 'a.txt', 'gone.txt'])
    const byPath = Object.fromEntries((await status(dir)).files.map((f) => [f.path, f]))
    expect(byPath['new.txt']!.index).toBe('A')
    expect(byPath['a.txt']!.index).toBe('M')
    expect(byPath['gone.txt']!.index).toBe('D')
  })

  test('stage treats paths literally', async () => {
    const dir = repoWithCommit()
    write(dir, 'x1.txt', '1')
    write(dir, '*.txt', 'star')
    await stage(dir, ['*.txt'])
    const byPath = Object.fromEntries((await status(dir)).files.map((f) => [f.path, f]))
    expect(byPath['*.txt']!.index).toBe('A')
    expect(byPath['x1.txt']!.untracked).toBe(true)
  })

  test('unstage restores the index to HEAD', async () => {
    const dir = repoWithCommit()
    write(dir, 'a.txt', 'changed')
    write(dir, 'new.txt', 'n')
    await stage(dir, ['a.txt', 'new.txt'])
    await unstage(dir, ['a.txt', 'new.txt'])
    const byPath = Object.fromEntries((await status(dir)).files.map((f) => [f.path, f]))
    expect(byPath['a.txt']).toMatchObject({ index: ' ', worktree: 'M' })
    expect(byPath['new.txt']).toMatchObject({ untracked: true })
  })

  test('unstage in a repo without commits', async () => {
    const dir = initRepo()
    write(dir, 'a.txt', 'a')
    write(dir, 'd/b.txt', 'b')
    await stage(dir, ['a.txt', 'd/b.txt'])
    await unstage(dir, ['a.txt', 'd'])
    const files = (await status(dir)).files
    expect(files.every((f) => f.untracked)).toBe(true)
    expect(files.map((f) => f.path).sort()).toEqual(['a.txt', 'd/b.txt'])
    expect(readFileSafe(join(dir, 'a.txt'))).toBe('a')
  })

  test('commit returns the new sha and leaves the tree clean', async () => {
    const dir = repoWithCommit()
    write(dir, 'a.txt', 'second\n')
    await stage(dir, ['a.txt'])
    const sha = await commit(dir, 'second commit')
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(sha).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('second commit')
    expect((await status(dir)).files).toEqual([])
  })

  test('first commit in a repo without commits', async () => {
    const dir = initRepo()
    write(dir, 'a.txt', 'a')
    await stage(dir, ['a.txt'])
    const sha = await commit(dir, 'root')
    expect(sha).toBe(git(dir, 'rev-parse', 'HEAD'))
  })

  test('commit with nothing staged throws GitError', async () => {
    const dir = repoWithCommit()
    expect(commit(dir, 'empty')).rejects.toBeInstanceOf(GitError)
  })
})

function readFileSafe(path: string): string {
  return readFileSync(path, 'utf8')
}
