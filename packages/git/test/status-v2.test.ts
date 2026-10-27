import { describe, expect, test } from 'bun:test'
import { appendFileSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatusEntry } from '@quirky/protocol'
import { git, isolateGitConfig, makeRepo } from '../../../plugins/quirky.repo/test/git-fixtures'
import {
  STATUS_ENTRY_LIMIT,
  detectOperation,
  gitDirOf,
  operationHead,
  statusV2
} from '../src/status'

const { scratch } = isolateGitConfig()

/** Runs git and returns its exit code; a stopped merge, rebase or cherry-pick is the point of the caller. */
function tryGit(cwd: string, ...args: string[]): number {
  return Bun.spawnSync(['git', ...args], { cwd, env: process.env }).exitCode
}

function entry(entries: GitStatusEntry[], path: string, area: GitStatusEntry['area']): GitStatusEntry | undefined {
  return entries.find((e) => e.path === path && e.area === area)
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\n`).join('')

describe('statusV2 records', () => {
  test('lists staged, unstaged, renamed and untracked rows with counts', async () => {
    const dir = makeRepo(scratch(), { 'README.md': 'a\nb\n', 'math.ts': 'x\n', 'old.ts': lines(10) })
    writeFileSync(join(dir, 'README.md'), 'a\nc\nd\n')
    git(dir, 'add', 'README.md')
    writeFileSync(join(dir, 'math.ts'), 'x\n1\n2\n3\n4\n5\n')
    git(dir, 'mv', 'old.ts', 'new.ts')
    writeFileSync(join(dir, 'notes.txt'), 'one\ntwo\nthree\n')

    const s = await statusV2(dir)
    expect(s.branch).toBe('main')
    expect(s.operation).toBe('none')
    expect(s.capped).toBe(false)
    expect(s.busy).toBeNull()
    expect(s.detached).toBe(false)
    expect(s.unborn).toBe(false)
    expect(s.head).toBe(git(dir, 'rev-parse', 'HEAD'))
    expect(s.entries).toEqual([
      { path: 'math.ts', area: 'unstaged', status: 'modified', added: 5, removed: 0 },
      { path: 'new.ts', oldPath: 'old.ts', area: 'staged', status: 'renamed', added: 0, removed: 0 },
      { path: 'notes.txt', area: 'untracked', status: 'untracked', added: 3, removed: 0 },
      { path: 'README.md', area: 'staged', status: 'modified', added: 2, removed: 1 }
    ])
    expect(s.files).toEqual([
      { path: 'README.md', index: 'M', worktree: ' ', untracked: false },
      { path: 'math.ts', index: ' ', worktree: 'M', untracked: false },
      { path: 'new.ts', index: 'R', worktree: ' ', untracked: false, origPath: 'old.ts' },
      { path: 'notes.txt', index: '?', worktree: '?', untracked: true }
    ])
  })

  test('files reproduce the porcelain v1 letters for the same working tree', async () => {
    const { status } = await import('../src/index')
    const dir = makeRepo(scratch(), { a: 'a\n', b: 'b\n', c: 'c\n', d: lines(8) })
    writeFileSync(join(dir, 'a'), 'a2\n')
    git(dir, 'add', 'a')
    writeFileSync(join(dir, 'a'), 'a3\n')
    rmSync(join(dir, 'b'))
    git(dir, 'rm', '-q', 'c')
    git(dir, 'mv', 'd', 'd2')
    writeFileSync(join(dir, 'd2'), `${lines(8)}more\n`)
    writeFileSync(join(dir, 'new'), 'n\n')
    git(dir, 'add', 'new')
    writeFileSync(join(dir, 'u'), 'u\n')

    const v1 = (await status(dir)).files
    const v2 = (await statusV2(dir)).files
    const byPath = (a: { path: string }, b: { path: string }) => a.path.localeCompare(b.path)
    expect([...v2].sort(byPath)).toEqual([...v1].sort(byPath))
  })

  test('a path both staged and changed gets two entries and one file', async () => {
    const dir = makeRepo(scratch(), { 'math.ts': 'one\ntwo\nthree\n' })
    writeFileSync(join(dir, 'math.ts'), 'ONE\ntwo\nthree\n')
    git(dir, 'add', 'math.ts')
    writeFileSync(join(dir, 'math.ts'), 'ONE\ntwo\nTHREE\nfour\n')

    const s = await statusV2(dir)
    expect(s.entries).toEqual([
      { path: 'math.ts', area: 'staged', status: 'modified', added: 1, removed: 1 },
      { path: 'math.ts', area: 'unstaged', status: 'modified', added: 2, removed: 1 }
    ])
    expect(s.files).toEqual([{ path: 'math.ts', index: 'M', worktree: 'M', untracked: false }])
  })

  test('added, deleted and a type change map to statuses', async () => {
    const dir = makeRepo(scratch(), { gone: 'g\n', staged_gone: 's\n', link: 'file\n' })
    git(dir, 'rm', '-q', 'staged_gone')
    rmSync(join(dir, 'gone'))
    writeFileSync(join(dir, 'added'), 'x\ny\n')
    git(dir, 'add', 'added')
    rmSync(join(dir, 'link'))
    symlinkSync('gone', join(dir, 'link'))

    const s = await statusV2(dir)
    expect(entry(s.entries, 'added', 'staged')).toMatchObject({ status: 'added', added: 2, removed: 0 })
    expect(entry(s.entries, 'gone', 'unstaged')).toMatchObject({ status: 'deleted', added: 0, removed: 1 })
    expect(entry(s.entries, 'staged_gone', 'staged')).toMatchObject({ status: 'deleted', added: 0, removed: 1 })
    expect(entry(s.entries, 'link', 'unstaged')?.status).toBe('modified')
    expect(s.files.find((f) => f.path === 'link')).toMatchObject({ index: ' ', worktree: 'T' })
  })

  test('binary tracked files are flagged without counts', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 3]))
    git(dir, 'add', 'bin.dat')
    git(dir, 'commit', '-q', '-m', 'bin')
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 9, 9, 9, 9]))
    const e = entry((await statusV2(dir)).entries, 'bin.dat', 'unstaged')!
    expect(e.binary).toBe(true)
    expect(e.added).toBeUndefined()
    expect(e.removed).toBeUndefined()
  })

  test('paths with spaces and non-ascii characters are returned verbatim', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'a bé.txt'), 'x\n')
    const s = await statusV2(dir)
    expect(s.entries.map((e) => e.path)).toEqual(['a bé.txt'])
    expect(s.files[0]!.path).toBe('a bé.txt')
  })

  test('a clean repository has no entries', async () => {
    const s = await statusV2(makeRepo(scratch()))
    expect(s.entries).toEqual([])
    expect(s.files).toEqual([])
    expect(s.capped).toBe(false)
  })

  test('entries sort numerically by path', async () => {
    const dir = makeRepo(scratch())
    for (const name of ['f10', 'f2', 'f1']) writeFileSync(join(dir, name), 'x\n')
    expect((await statusV2(dir)).entries.map((e) => e.path)).toEqual(['f1', 'f2', 'f10'])
  })

  test('exports the entry limit', () => {
    expect(STATUS_ENTRY_LIMIT).toBe(1000)
  })
})

describe('statusV2 conflicts', () => {
  /** A merge of `theirs` into `main` that stops with every conflict kind git can produce. */
  function mergeWithEveryKind(): string {
    const dir = makeRepo(scratch(), {
      'x.txt': 'base\n',
      'ud.txt': 'base\n',
      'du.txt': 'base\n',
      'd.txt': lines(30)
    })
    git(dir, 'checkout', '-q', '-b', 'theirs')
    writeFileSync(join(dir, 'x.txt'), 'theirs\n')
    writeFileSync(join(dir, 'y.txt'), 'theirs y\n')
    rmSync(join(dir, 'ud.txt'))
    writeFileSync(join(dir, 'du.txt'), 'theirs change\n')
    git(dir, 'mv', 'd.txt', 'd2.txt')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'theirs')
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'x.txt'), 'ours\n')
    writeFileSync(join(dir, 'y.txt'), 'ours y\n')
    writeFileSync(join(dir, 'ud.txt'), 'ours change\n')
    rmSync(join(dir, 'du.txt'))
    git(dir, 'mv', 'd.txt', 'd1.txt')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-q', '-m', 'ours')
    expect(tryGit(dir, 'merge', 'theirs')).toBe(1)
    return dir
  }

  test('every kind is a conflicts-area entry with its kind, listed first', async () => {
    const dir = mergeWithEveryKind()
    writeFileSync(join(dir, 'zz-untracked.txt'), 'u\n')
    writeFileSync(join(dir, 'a.txt'), 'changed\n')

    const s = await statusV2(dir)
    const kinds = Object.fromEntries(s.entries.filter((e) => e.area === 'conflicts').map((e) => [e.path, e]))
    expect(kinds['x.txt']).toEqual({ path: 'x.txt', area: 'conflicts', status: 'modified', conflict: { kind: 'both_modified', state: 'unresolved' } })
    expect(kinds['y.txt']).toMatchObject({ status: 'added', conflict: { kind: 'both_added', state: 'unresolved' } })
    expect(kinds['ud.txt']).toMatchObject({ status: 'deleted', conflict: { kind: 'deleted_by_them' } })
    expect(kinds['du.txt']).toMatchObject({ status: 'deleted', conflict: { kind: 'deleted_by_us' } })
    expect(kinds['d.txt']).toMatchObject({ status: 'deleted', conflict: { kind: 'both_deleted' } })
    expect(kinds['d1.txt']).toMatchObject({ status: 'added', conflict: { kind: 'added_by_us' } })
    expect(kinds['d2.txt']).toMatchObject({ status: 'added', conflict: { kind: 'added_by_them' } })

    const areas = s.entries.map((e) => e.area)
    const firstOther = areas.findIndex((a) => a !== 'conflicts')
    expect(areas.slice(0, firstOther).every((a) => a === 'conflicts')).toBe(true)
    expect(areas.slice(firstOther).includes('conflicts')).toBe(false)
    expect(s.operation).toBe('merge')
  })

  test('files carry the two unmerged letters', async () => {
    const dir = mergeWithEveryKind()
    const letters = Object.fromEntries((await statusV2(dir)).files.map((f) => [f.path, f.index + f.worktree]))
    expect(letters['x.txt']).toBe('UU')
    expect(letters['y.txt']).toBe('AA')
    expect(letters['ud.txt']).toBe('UD')
    expect(letters['du.txt']).toBe('DU')
    expect(letters['d.txt']).toBe('DD')
    expect(letters['d1.txt']).toBe('AU')
    expect(letters['d2.txt']).toBe('UA')
  })
})

describe('statusV2 HEAD states', () => {
  test('detached HEAD has no branch', async () => {
    const dir = makeRepo(scratch())
    const sha = git(dir, 'rev-parse', 'HEAD')
    git(dir, 'checkout', '-q', '--detach')
    const s = await statusV2(dir)
    expect(s).toMatchObject({ detached: true, branch: null, head: sha, unborn: false, upstream: null })
  })

  test('unborn HEAD keeps the initial branch name and counts staged files', async () => {
    const dir = scratch()
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'trunk')
    writeFileSync(join(dir, 'f.txt'), 'a\nb\n')
    git(dir, 'add', 'f.txt')
    writeFileSync(join(dir, 'g.txt'), 'g\n')
    const s = await statusV2(dir)
    expect(s).toMatchObject({ unborn: true, head: null, branch: 'trunk', detached: false })
    expect(entry(s.entries, 'f.txt', 'staged')).toMatchObject({ status: 'added', added: 2 })
    expect(entry(s.entries, 'g.txt', 'untracked')).toMatchObject({ added: 1 })
    expect(s.upstreamStatus.hasUpstream).toBe(false)
  })

  test('a tracked upstream fills the v1 fields and upstreamStatus', async () => {
    const origin = scratch()
    mkdirSync(origin, { recursive: true })
    git(origin, 'init', '-q', '--bare', '-b', 'main')
    const dir = makeRepo(scratch())
    git(dir, 'remote', 'add', 'origin', origin)
    git(dir, 'push', '-q', '-u', 'origin', 'main')
    writeFileSync(join(dir, 'b.txt'), 'b\n')
    git(dir, 'add', 'b.txt')
    git(dir, 'commit', '-q', '-m', 'second')

    const s = await statusV2(dir)
    expect(s).toMatchObject({ upstream: 'origin/main', ahead: 1, behind: 0 })
    expect(s.upstreamStatus).toEqual({
      hasUpstream: true,
      name: 'origin/main',
      sha: git(dir, 'rev-parse', 'origin/main'),
      ahead: 1,
      behind: 0,
      behindPatchEquivalent: null
    })
  })
})

describe('operations', () => {
  function conflictingBranch(): string {
    const dir = makeRepo(scratch(), { 'x.txt': 'base\n' })
    git(dir, 'checkout', '-q', '-b', 'topic')
    writeFileSync(join(dir, 'x.txt'), 'topic\n')
    git(dir, 'commit', '-q', '-am', 'topic')
    git(dir, 'checkout', '-q', 'main')
    writeFileSync(join(dir, 'x.txt'), 'main\n')
    git(dir, 'commit', '-q', '-am', 'main')
    return dir
  }

  test('no operation', async () => {
    const dir = makeRepo(scratch())
    expect(await detectOperation(dir)).toBe('none')
    expect(await operationHead(dir)).toBeNull()
  })

  test('merge', async () => {
    const dir = conflictingBranch()
    const topic = git(dir, 'rev-parse', 'topic')
    expect(tryGit(dir, 'merge', 'topic')).toBe(1)
    expect(await detectOperation(dir)).toBe('merge')
    expect(await operationHead(dir)).toBe(topic)
    expect((await statusV2(dir)).operation).toBe('merge')
    git(dir, 'merge', '--abort')
    expect(await detectOperation(dir)).toBe('none')
    expect(await operationHead(dir)).toBeNull()
  })

  test('rebase', async () => {
    const dir = conflictingBranch()
    git(dir, 'checkout', '-q', 'topic')
    const origHead = git(dir, 'rev-parse', 'topic')
    expect(tryGit(dir, 'rebase', 'main')).toBe(1)
    expect(await detectOperation(dir)).toBe('rebase')
    expect(await operationHead(dir)).toBe(origHead)
    expect((await statusV2(dir)).operation).toBe('rebase')
    git(dir, 'rebase', '--abort')
    expect(await detectOperation(dir)).toBe('none')
  })

  test('cherry-pick', async () => {
    const dir = conflictingBranch()
    const topic = git(dir, 'rev-parse', 'topic')
    expect(tryGit(dir, 'cherry-pick', 'topic')).toBe(1)
    expect(await detectOperation(dir)).toBe('cherry-pick')
    expect(await operationHead(dir)).toBe(topic)
    git(dir, 'cherry-pick', '--abort')
    expect(await detectOperation(dir)).toBe('none')
  })

  test('a cherry-pick with no conflicts left is still a cherry-pick', async () => {
    const dir = conflictingBranch()
    expect(tryGit(dir, 'cherry-pick', 'topic')).toBe(1)
    writeFileSync(join(dir, 'x.txt'), 'resolved\n')
    git(dir, 'add', 'x.txt')
    expect(await detectOperation(dir)).toBe('cherry-pick')
    expect((await statusV2(dir)).entries.some((e) => e.area === 'conflicts')).toBe(false)
  })

  test('a linked worktree reads its own git directory', async () => {
    const dir = conflictingBranch()
    const linked = `${scratch()}-linked`
    git(dir, 'worktree', 'add', '-q', '-b', 'linked', linked, 'main~1')
    git(linked, 'config', 'user.name', 'Test')
    git(linked, 'config', 'user.email', 'test@example.com')
    writeFileSync(join(linked, 'x.txt'), 'linked\n')
    git(linked, 'commit', '-q', '-am', 'linked')
    expect(tryGit(linked, 'merge', 'topic')).toBe(1)

    expect(await gitDirOf(linked)).toContain('/worktrees/')
    expect(await gitDirOf(dir)).toBe(join(dir, '.git'))
    expect(await detectOperation(linked)).toBe('merge')
    expect(await detectOperation(dir)).toBe('none')
    expect((await statusV2(linked)).operation).toBe('merge')
  })
})

describe('statusV2 cap', () => {
  test('stops at the limit, kills git and skips counts', async () => {
    const dir = makeRepo(scratch())
    for (let i = 0; i < 40; i++) writeFileSync(join(dir, `u${String(i).padStart(2, '0')}.txt`), 'x\n')
    const s = await statusV2(dir, { limit: 5 })
    expect(s.capped).toBe(true)
    expect(s.entries).toHaveLength(5)
    expect(s.entries.every((e) => e.added === undefined && e.removed === undefined)).toBe(true)
    expect(s.upstreamStatus.behindPatchEquivalent).toBeNull()
  })

  test('exactly the limit is not capped', async () => {
    const dir = makeRepo(scratch())
    for (let i = 0; i < 5; i++) writeFileSync(join(dir, `u${i}.txt`), 'x\n')
    const s = await statusV2(dir, { limit: 5 })
    expect(s.capped).toBe(false)
    expect(s.entries).toHaveLength(5)
    expect(s.entries[0]!.added).toBe(1)
  })

  test('a path staged and unstaged counts as two toward the limit', async () => {
    const dir = makeRepo(scratch(), { a: '1\n', b: '1\n', c: '1\n' })
    for (const f of ['a', 'b', 'c']) {
      writeFileSync(join(dir, f), '2\n')
      git(dir, 'add', f)
      writeFileSync(join(dir, f), '3\n')
    }
    const s = await statusV2(dir, { limit: 4 })
    expect(s.capped).toBe(true)
    expect(s.entries).toHaveLength(4)
  })

  test('a large untracked set returns promptly', async () => {
    const dir = makeRepo(scratch())
    mkdirSync(join(dir, 'many'))
    for (let i = 0; i < 1500; i++) writeFileSync(join(dir, 'many', `f${i}`), 'x')
    const started = Date.now()
    const s = await statusV2(dir)
    expect(s.capped).toBe(true)
    expect(s.entries).toHaveLength(STATUS_ENTRY_LIMIT)
    expect(Date.now() - started).toBeLessThan(10_000)
  })
})

describe('untracked line counts', () => {
  test('counts newlines, plus one for a missing trailing newline', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'three.txt'), 'a\nb\nc\n')
    writeFileSync(join(dir, 'nonl.txt'), 'a\nb')
    writeFileSync(join(dir, 'empty.txt'), '')
    writeFileSync(join(dir, 'nul.bin'), Buffer.concat([Buffer.from('ab\n'), Buffer.from([0]), Buffer.from('c\n')]))
    writeFileSync(join(dir, 'big.txt'), 'x\n'.repeat(1024 * 1024 + 1))
    symlinkSync('three.txt', join(dir, 'link'))
    const { entries } = await statusV2(dir)
    const added = Object.fromEntries(entries.map((e) => [e.path, e.added]))
    expect(added['three.txt']).toBe(3)
    expect(added['nonl.txt']).toBe(2)
    expect(added['empty.txt']).toBe(0)
    expect(added['link']).toBe(1)
    expect(added['nul.bin']).toBeUndefined()
    expect(added['big.txt']).toBeUndefined()
    expect(entry(entries, 'link', 'untracked')?.removed).toBe(0)
  })

  test('a NUL after the first 8 KiB does not make a file binary', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'late.txt'), Buffer.concat([Buffer.from('a\n'.repeat(5000)), Buffer.from([0]), Buffer.from('b\n')]))
    expect(entry((await statusV2(dir)).entries, 'late.txt', 'untracked')?.added).toBe(5001)
  })
})

describe('shared symlinks', () => {
  test('drops an untracked symlink listed as shared, keeps real files and other symlinks', async () => {
    const dir = makeRepo(scratch())
    const target = scratch()
    mkdirSync(target, { recursive: true })
    symlinkSync(target, join(dir, 'node_modules'))
    symlinkSync(target, join(dir, 'other_link'))
    mkdirSync(join(dir, 'real_dir'))
    writeFileSync(join(dir, 'real_dir', 'f.txt'), 'x\n')
    writeFileSync(join(dir, 'scratch.txt'), 'x\n')

    const s = await statusV2(dir, { sharedSymlinks: ['node_modules', 'real_dir'] })
    expect(s.entries.map((e) => e.path)).toEqual(['other_link', 'real_dir/f.txt', 'scratch.txt'])
    expect(s.files.map((f) => f.path)).toEqual(['other_link', 'real_dir/f.txt', 'scratch.txt'])

    const all = await statusV2(dir)
    expect(all.entries.map((e) => e.path)).toContain('node_modules')
  })

  test('a shared path that is a real file is kept', async () => {
    const dir = makeRepo(scratch())
    writeFileSync(join(dir, 'node_modules'), 'x\n')
    const s = await statusV2(dir, { sharedSymlinks: ['node_modules'] })
    expect(s.entries.map((e) => e.path)).toEqual(['node_modules'])
  })
})

describe('submodules', () => {
  function withSubmodule(): { dir: string; sub: string } {
    const upstream = makeRepo(scratch(), { 'x.c': 'int x;\n' })
    const dir = makeRepo(scratch())
    git(dir, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', upstream, 'vendor/lib')
    git(join(dir, 'vendor/lib'), 'config', 'user.name', 'Test')
    git(join(dir, 'vendor/lib'), 'config', 'user.email', 'test@example.com')
    git(dir, 'commit', '-q', '-m', 'add submodule')
    return { dir, sub: join(dir, 'vendor/lib') }
  }

  test('tracked changes inside the submodule', async () => {
    const { dir, sub } = withSubmodule()
    writeFileSync(join(sub, 'x.c'), 'int y;\n')
    const e = entry((await statusV2(dir)).entries, 'vendor/lib', 'unstaged')!
    expect(e.status).toBe('modified')
    expect(e.submodule).toEqual({ commitChanged: false, trackedChanges: true, untrackedChanges: false })
  })

  test('untracked files inside the submodule', async () => {
    const { dir, sub } = withSubmodule()
    writeFileSync(join(sub, 'new.c'), 'x\n')
    const e = entry((await statusV2(dir)).entries, 'vendor/lib', 'unstaged')!
    expect(e.submodule).toEqual({ commitChanged: false, trackedChanges: false, untrackedChanges: true })
  })

  test('a moved submodule commit', async () => {
    const { dir, sub } = withSubmodule()
    appendFileSync(join(sub, 'x.c'), 'int z;\n')
    git(sub, 'commit', '-q', '-am', 'move')
    const e = entry((await statusV2(dir)).entries, 'vendor/lib', 'unstaged')!
    expect(e.submodule).toEqual({ commitChanged: true, trackedChanges: false, untrackedChanges: false })
  })

  test('ordinary entries carry no submodule flags', async () => {
    const { dir } = withSubmodule()
    writeFileSync(join(dir, 'a.txt'), 'changed\n')
    expect(entry((await statusV2(dir)).entries, 'a.txt', 'unstaged')?.submodule).toBeUndefined()
  })
})

describe('gitDirOf', () => {
  test('is the absolute git directory and is stable across calls', async () => {
    const dir = makeRepo(scratch())
    expect(await gitDirOf(dir)).toBe(join(dir, '.git'))
    expect(await gitDirOf(dir)).toBe(join(dir, '.git'))
  })
})
