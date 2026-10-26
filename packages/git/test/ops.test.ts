import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  BranchCheckedOutError,
  addExistingBranchWorktree,
  addNewBranchWorktree,
  branchHead,
  checkRefFormatBranch,
  cloneRepo,
  createTrackingBranch,
  deleteBranchSafe,
  deleteRefIfAt,
  detectDefaultBase,
  dirtyEntries,
  fetchRemote,
  getConfig,
  gitPath,
  gitUsername,
  hasCommits,
  hasPopulatedSubmodules,
  ignoredUntracked,
  initRepo,
  isIgnored,
  listRegistrations,
  listRemotes,
  listWorktrees,
  localBranchExists,
  matchingExcludeFrom,
  mergedByTree,
  prune,
  refExists,
  remoteBranchExists,
  remoteUrls,
  resetGhFailureCache,
  resolveBaseRef,
  resolveCommit,
  setLocalConfig,
  showFile,
  upstreamOf
} from '../src/index'
import * as gitApiModule from '../src/api'

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-git-ops-test-')))
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

function makeRepo(name = 'repo', branch = 'main'): string {
  const dir = freshDir(name)
  git(dir, 'init', '-q', '-b', branch)
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

function commitFile(repo: string, file: string, content: string, message = `edit ${file}`): string {
  mkdirSync(join(repo, file, '..'), { recursive: true })
  writeFileSync(join(repo, file), content)
  git(repo, 'add', '--', file)
  git(repo, 'commit', '-q', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function repoWithCommit(name = 'repo', branch = 'main'): string {
  const repo = makeRepo(name, branch)
  commitFile(repo, 'a.txt', 'a\n', 'init')
  return repo
}

/** A repo with a bare `origin` it has pushed `main` to, with `refs/remotes/origin/*` populated. */
function repoWithOrigin(): { repo: string; origin: string } {
  const repo = repoWithCommit('work')
  const origin = freshDir('origin.git')
  git(origin, 'init', '-q', '--bare', '-b', 'main')
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main')
  git(repo, 'fetch', '-q', 'origin')
  return { repo, origin }
}

describe('GitApi surface', () => {
  test('exposes the new primitives and locked on listWorktrees', async () => {
    expect(typeof gitApiModule.gitApi().listRegistrations).toBe('function')
    const repo = repoWithCommit()
    const wts = await listWorktrees(repo)
    expect(wts[0]!.locked).toBeNull()
  })
})

describe('listRegistrations / listWorktrees', () => {
  test('main first, with locked reasons, prunable and missing folders included', async () => {
    const repo = repoWithCommit()
    const a = join(freshDir('wts'), 'a')
    const b = join(freshDir('wts'), 'b')
    const c = join(freshDir('wts'), 'c')
    git(repo, 'worktree', 'add', '-q', '-b', 'a', a)
    git(repo, 'worktree', 'add', '-q', '-b', 'b', b)
    git(repo, 'worktree', 'add', '-q', '-b', 'c', c)
    git(repo, 'worktree', 'lock', '--reason', 'on usb', a)
    git(repo, 'worktree', 'lock', b)
    rmSync(c, { recursive: true })

    const regs = await listRegistrations(repo)
    expect(regs.map((r) => r.path)).toEqual([repo, a, b, c])
    expect(regs[0]).toMatchObject({ isMain: true, branch: 'main', locked: null, prunable: false, exists: true })
    expect(regs[1]).toMatchObject({ isMain: false, branch: 'a', locked: 'on usb', exists: true })
    expect(regs[2]!.locked).toBe('')
    expect(regs[3]).toMatchObject({ branch: 'c', prunable: true, exists: false })
    expect(regs[1]!.head).toMatch(/^[0-9a-f]{40}$/)

    const listed = await listWorktrees(repo)
    expect(listed.map((w) => w.path)).toEqual([repo, a, b])
    expect(listed.map((w) => w.locked)).toEqual([null, 'on usb', ''])
  })

  test('skips bare entries', async () => {
    const { origin } = repoWithOrigin()
    const wt = join(freshDir('wts'), 'w')
    git(origin, 'worktree', 'add', '-q', wt, 'main')
    const regs = await listRegistrations(origin)
    expect(regs.map((r) => r.path)).toEqual([wt])
  })

  test('prune drops registrations whose folder is gone', async () => {
    const repo = repoWithCommit()
    const a = join(freshDir('wts'), 'a')
    git(repo, 'worktree', 'add', '-q', '-b', 'a', a)
    rmSync(a, { recursive: true })
    expect(await listRegistrations(repo)).toHaveLength(2)
    await prune(repo)
    expect(await listRegistrations(repo)).toHaveLength(1)
  })
})

describe('refs and commits', () => {
  test('hasCommits', async () => {
    expect(await hasCommits(makeRepo())).toBe(false)
    expect(await hasCommits(repoWithCommit())).toBe(true)
  })

  test('refExists / resolveCommit / branchHead / localBranchExists', async () => {
    const repo = repoWithCommit()
    const sha = git(repo, 'rev-parse', 'HEAD')
    expect(await refExists(repo, 'refs/heads/main')).toBe(true)
    expect(await refExists(repo, 'refs/heads/nope')).toBe(false)
    expect(await resolveCommit(repo, 'main')).toBe(sha)
    expect(await resolveCommit(repo, sha.slice(0, 8))).toBe(sha)
    expect(await resolveCommit(repo, 'nope')).toBeNull()
    expect(await branchHead(repo, 'main')).toBe(sha)
    expect(await branchHead(repo, 'nope')).toBeNull()
    expect(await localBranchExists(repo, 'main')).toBe(true)
    expect(await localBranchExists(repo, 'nope')).toBe(false)
  })

  test('remoteBranchExists matches any remote', async () => {
    const { repo } = repoWithOrigin()
    expect(await remoteBranchExists(repo, 'main')).toBe(true)
    expect(await remoteBranchExists(repo, 'other')).toBe(false)
  })

  test('resolveBaseRef', async () => {
    const { repo } = repoWithOrigin()
    const sha = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'branch', 'feature/x')
    expect(await resolveBaseRef(repo, 'origin/main')).toBe('refs/remotes/origin/main')
    expect(await resolveBaseRef(repo, 'feature/x')).toBe('refs/heads/feature/x')
    expect(await resolveBaseRef(repo, 'main')).toBe('refs/heads/main')
    expect(await resolveBaseRef(repo, sha)).toBe(sha)
    expect(await resolveBaseRef(repo, 'origin/nope')).toBeNull()
    expect(await resolveBaseRef(repo, 'nope')).toBeNull()
  })

  test('upstreamOf', async () => {
    const { repo } = repoWithOrigin()
    expect(await upstreamOf(repo, 'main')).toBeNull()
    git(repo, 'branch', '--set-upstream-to=origin/main', 'main')
    expect(await upstreamOf(repo, 'main')).toBe('origin/main')
    expect(await upstreamOf(repo, 'nope')).toBeNull()
  })

  test('deleteRefIfAt only deletes when the ref is at the expected head', async () => {
    const repo = repoWithCommit()
    const first = git(repo, 'rev-parse', 'HEAD')
    git(repo, 'branch', 'topic')
    commitFile(repo, 'b.txt', 'b\n')
    expect(await deleteRefIfAt(repo, 'topic', 'f'.repeat(40))).toBe(false)
    expect(await localBranchExists(repo, 'topic')).toBe(true)
    expect(await deleteRefIfAt(repo, 'topic', first)).toBe(true)
    expect(await localBranchExists(repo, 'topic')).toBe(false)
    expect(await deleteRefIfAt(repo, 'topic', first)).toBe(false)
  })
})

describe('detectDefaultBase', () => {
  test('origin/HEAD target wins, including a non-main name', async () => {
    const { repo } = repoWithOrigin()
    git(repo, 'push', '-q', 'origin', 'main:develop')
    git(repo, 'fetch', '-q', 'origin')
    git(repo, 'remote', 'set-head', 'origin', 'develop')
    expect(await detectDefaultBase(repo)).toBe('origin/develop')
  })

  test('falls back through origin/main, origin/master, main, master', async () => {
    const { repo } = repoWithOrigin()
    expect(await detectDefaultBase(repo)).toBe('origin/main')
    expect(await detectDefaultBase(repoWithCommit('r1', 'main'))).toBe('main')
    expect(await detectDefaultBase(repoWithCommit('r2', 'master'))).toBe('master')
    expect(await detectDefaultBase(repoWithCommit('r3', 'trunk'))).toBeNull()
  })
})

describe('remotes', () => {
  test('listRemotes and remoteUrls', async () => {
    const { repo, origin } = repoWithOrigin()
    expect(await listRemotes(repo)).toEqual(['origin'])
    expect(await remoteUrls(repo)).toEqual([origin])
    expect(await listRemotes(repoWithCommit())).toEqual([])
    expect(await remoteUrls(repoWithCommit())).toEqual([])
  })

  test('fetchRemote returns true on success and false (never throws) on failure', async () => {
    const { repo, origin } = repoWithOrigin()
    expect(await fetchRemote(repo, 'origin')).toBe(true)
    expect(await fetchRemote(repo, 'origin', 'main')).toBe(true)
    git(repo, 'remote', 'add', 'dead', join(scratch, 'does-not-exist.git'))
    expect(await fetchRemote(repo, 'dead')).toBe(false)
    expect(await fetchRemote(repo, 'nosuchremote')).toBe(false)
    expect(existsSync(origin)).toBe(true)
  })
})

describe('checkRefFormatBranch', () => {
  test('validates branch names', async () => {
    expect(await checkRefFormatBranch('feature/x')).toBe(true)
    expect(await checkRefFormatBranch('bad name')).toBe(false)
    expect(await checkRefFormatBranch('a..b')).toBe(false)
    expect(await checkRefFormatBranch('-x')).toBe(false)
    expect(await checkRefFormatBranch('')).toBe(false)
  })
})

describe('worktree add', () => {
  test('addNewBranchWorktree creates the branch with no upstream and makes parents', async () => {
    const { repo } = repoWithOrigin()
    const path = join(freshDir('wts'), 'deep', 'nested', 'w')
    await addNewBranchWorktree(repo, path, 'topic', 'refs/remotes/origin/main')
    expect(existsSync(join(path, 'a.txt'))).toBe(true)
    expect(await localBranchExists(repo, 'topic')).toBe(true)
    expect(await upstreamOf(repo, 'topic')).toBeNull()
  })

  test('addExistingBranchWorktree checks out the branch, and refuses one checked out elsewhere', async () => {
    const repo = repoWithCommit()
    git(repo, 'branch', 'topic')
    const path = join(freshDir('wts'), 'w')
    await addExistingBranchWorktree(repo, path, 'topic')
    expect((await listWorktrees(repo)).find((w) => w.path === path)?.branch).toBe('topic')
    const other = join(freshDir('wts'), 'w2')
    await expect(addExistingBranchWorktree(repo, other, 'topic')).rejects.toBeInstanceOf(BranchCheckedOutError)
    await expect(addExistingBranchWorktree(repo, other, 'main')).rejects.toBeInstanceOf(BranchCheckedOutError)
  })

  test('createTrackingBranch sets the upstream', async () => {
    const { repo } = repoWithOrigin()
    git(repo, 'push', '-q', 'origin', 'main:feat')
    git(repo, 'fetch', '-q', 'origin')
    await createTrackingBranch(repo, 'feat', 'origin/feat')
    expect(await upstreamOf(repo, 'feat')).toBe('origin/feat')
  })
})

describe('config', () => {
  test('getConfig / setLocalConfig', async () => {
    const repo = repoWithCommit()
    expect(await getConfig(repo, 'quirky.thing')).toBeNull()
    await setLocalConfig(repo, 'quirky.thing', 'one')
    await setLocalConfig(repo, 'quirky.thing', 'two')
    expect(await getConfig(repo, 'quirky.thing')).toBe('two')
    expect(git(repo, 'config', '--local', '--get-all', 'quirky.thing')).toBe('two')
  })
})

describe('dirtyEntries / submodules', () => {
  test('lists modified, untracked and renamed paths (new name)', async () => {
    const repo = repoWithCommit()
    expect(await dirtyEntries(repo)).toEqual([])
    commitFile(repo, 'old.txt', 'x\n')
    writeFileSync(join(repo, 'a.txt'), 'changed\n')
    mkdirSync(join(repo, 'dir'))
    writeFileSync(join(repo, 'dir', 'u.txt'), 'u\n')
    git(repo, 'mv', 'old.txt', 'new.txt')
    const entries = (await dirtyEntries(repo)).sort()
    expect(entries).toEqual(['a.txt', 'dir/u.txt', 'new.txt'])
  })

  test('hasPopulatedSubmodules', async () => {
    const repo = repoWithCommit()
    expect(await hasPopulatedSubmodules(repo)).toBe(false)
    const sub = repoWithCommit('sub')
    git(repo, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', sub, 'vendor/sub')
    git(repo, 'commit', '-q', '-m', 'add sub')
    expect(await hasPopulatedSubmodules(repo)).toBe(true)
    const wt = join(freshDir('wts'), 'w')
    git(repo, 'worktree', 'add', '-q', '-b', 'w', wt)
    expect(await hasPopulatedSubmodules(wt)).toBe(false)
  })
})

describe('deleteBranchSafe / mergedByTree', () => {
  test('merged branch is deleted; unmerged and checked-out are classified', async () => {
    const repo = repoWithCommit()
    git(repo, 'branch', 'merged')
    expect(await deleteBranchSafe(repo, 'merged')).toEqual({ deleted: true })

    git(repo, 'checkout', '-q', '-b', 'unmerged')
    commitFile(repo, 'u.txt', 'u\n')
    git(repo, 'checkout', '-q', 'main')
    const notMerged = await deleteBranchSafe(repo, 'unmerged')
    expect(notMerged).toMatchObject({ deleted: false, reason: 'not-merged' })

    const wt = join(freshDir('wts'), 'w')
    git(repo, 'worktree', 'add', '-q', wt, 'unmerged')
    const held = await deleteBranchSafe(repo, 'unmerged')
    expect(held).toMatchObject({ deleted: false, reason: 'checked-out' })

    const missing = await deleteBranchSafe(repo, 'nope')
    expect(missing).toMatchObject({ deleted: false, reason: 'other' })
    if (!missing.deleted) expect(missing.message.length).toBeGreaterThan(0)
  })

  test('mergedByTree detects a squash merge, and rejects unmerged and conflicting branches', async () => {
    const repo = repoWithCommit()
    git(repo, 'checkout', '-q', '-b', 'feat')
    commitFile(repo, 'f.txt', 'f\n')
    commitFile(repo, 'g.txt', 'g\n')
    git(repo, 'checkout', '-q', 'main')
    expect(await mergedByTree(repo, 'feat', 'main')).toBe(false)

    git(repo, 'merge', '-q', '--squash', 'feat')
    git(repo, 'commit', '-q', '-m', 'squash')
    expect(git(repo, 'branch', '--merged', 'main')).not.toContain('feat')
    expect(await mergedByTree(repo, 'feat', 'main')).toBe(true)

    git(repo, 'checkout', '-q', '-b', 'conflict', 'HEAD~1')
    commitFile(repo, 'f.txt', 'different\n')
    git(repo, 'checkout', '-q', 'main')
    expect(await mergedByTree(repo, 'conflict', 'main')).toBe(false)
    expect(await mergedByTree(repo, 'nope', 'main')).toBe(false)
  })
})

describe('files', () => {
  test('showFile', async () => {
    const repo = repoWithCommit()
    commitFile(repo, 'dir/c.txt', 'hello\n')
    expect(await showFile(repo, 'HEAD', 'dir/c.txt')).toBe('hello\n')
    expect(await showFile(repo, 'HEAD', 'missing.txt')).toBeNull()
    expect(await showFile(repo, 'nope', 'dir/c.txt')).toBeNull()
  })

  test('ignoredUntracked expands directories; matchingExcludeFrom and isIgnored', async () => {
    const repo = repoWithCommit()
    commitFile(repo, '.gitignore', 'node_modules/\n.env\n')
    mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'pkg', 'i.js'), '1')
    writeFileSync(join(repo, '.env'), 'X=1')
    writeFileSync(join(repo, 'plain.txt'), 'p')
    expect((await ignoredUntracked(repo)).sort()).toEqual(['.env', 'node_modules/pkg/i.js'])

    const list = join(freshDir('lists'), 'include')
    writeFileSync(list, '.env\n')
    expect(await matchingExcludeFrom(repo, list)).toEqual(['.env'])

    expect(await isIgnored(repo, '.env')).toBe(true)
    expect(await isIgnored(repo, 'plain.txt')).toBe(false)
  })

  test('gitPath resolves against the worktree, for main and linked worktrees', async () => {
    const repo = repoWithCommit()
    expect(await gitPath(repo, 'info/exclude')).toBe(join(repo, '.git', 'info', 'exclude'))
    const wt = join(freshDir('wts'), 'w')
    git(repo, 'worktree', 'add', '-q', '-b', 'w', wt)
    const p = await gitPath(wt, 'HEAD')
    expect(p.startsWith(join(repo, '.git', 'worktrees'))).toBe(true)
    expect(p.endsWith('/HEAD')).toBe(true)
    // info/exclude is shared and lives in the common dir
    expect(await gitPath(wt, 'info/exclude')).toBe(join(repo, '.git', 'info', 'exclude'))
  })
})

describe('initRepo / cloneRepo', () => {
  test('initRepo makes the directory and a repo', async () => {
    const path = join(freshDir('x'), 'a', 'b')
    await initRepo(path)
    expect(existsSync(join(path, '.git'))).toBe(true)
    expect(await hasCommits(path)).toBe(false)
  })

  test('cloneRepo clones into a new directory under a missing parent', async () => {
    const { origin } = repoWithOrigin()
    const dest = join(freshDir('x'), 'p', 'clone')
    await cloneRepo(origin, dest)
    expect(await hasCommits(dest)).toBe(true)
    expect(await remoteUrls(dest)).toEqual([origin])
  })
})

describe('gitUsername', () => {
  const noGh = async (): Promise<string | null> => {
    throw new Error('gh must not be called')
  }

  test('github.user wins, then user.username, with results trimmed', async () => {
    const repo = repoWithCommit()
    git(repo, 'config', 'user.name', 'Some Person')
    git(repo, 'config', 'user.username', 'uname')
    expect(await gitUsername(repo, { gh: noGh })).toBe('uname')
    git(repo, 'config', 'github.user', ' ghuser ')
    expect(await gitUsername(repo, { gh: noGh })).toBe('ghuser')
  })

  test('gh is consulted only for a github.com remote, and a failure is cached', async () => {
    resetGhFailureCache()
    const repo = repoWithCommit()
    git(repo, 'config', 'user.name', 'Zed')
    let calls = 0
    const gh = async (args: string[]): Promise<string | null> => {
      calls++
      expect(args).toEqual(['api', 'user', '-q', '.login'])
      return ' octocat\n'
    }
    expect(await gitUsername(repo, { gh })).toBe('Zed')
    expect(calls).toBe(0)

    git(repo, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
    expect(await gitUsername(repo, { gh })).toBe('octocat')
    expect(calls).toBe(1)

    resetGhFailureCache()
    let failures = 0
    const failing = async (): Promise<string | null> => {
      failures++
      return null
    }
    expect(await gitUsername(repo, { gh: failing })).toBe('Zed')
    expect(await gitUsername(repo, { gh: failing })).toBe('Zed')
    expect(failures).toBe(1)
    resetGhFailureCache()
  })

  test('user.name is used only when it forms a valid branch prefix; else null', async () => {
    const repo = repoWithCommit()
    git(repo, 'config', 'user.name', 'Zed')
    expect(await gitUsername(repo, { gh: noGh })).toBe('Zed')
    git(repo, 'config', 'user.name', 'Zed Person')
    expect(await gitUsername(repo, { gh: noGh })).toBeNull()
    git(repo, 'config', '--unset', 'user.name')
    expect(await gitUsername(repo, { gh: noGh })).toBeNull()
  })
})
