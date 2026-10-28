import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type Repo, type Session, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { gitApi } from '@quirky/git'
import { useTestGit } from '@quirky/git/testing'
import { call, commitFiles, failure, git, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { testCliContext } from '../../quirky.repo/test/harness'
import { commands } from '../cli'
import { githubUser, makeOrigin, makeProject, repoSet, setSetting, startWorld, useGlobalGitConfig, type SessionMode, type World } from './fixtures/repos'

setDefaultTimeout(60_000)
const { scratch } = isolateGitConfig()
let w: World | undefined
beforeEach(() => useGlobalGitConfig(scratch, githubUser('zoe')))
afterEach(async () => {
  await w?.t.cleanup()
  w = undefined
})

/** A world plus a project `api` cloned from a fresh origin, so `origin/main` and `origin/HEAD` exist. */
async function startApi(sessions: SessionMode = 'fake', name = 'api') {
  w = await startWorld(sessions)
  const origin = makeOrigin(join(scratch(), `${name}-origin.git`))
  const dir = makeProject(join(scratch(), name), { origin })
  const repo = await w.add(dir)
  return { ...w, origin, dir, repo }
}

/** The open view of a `ui.state` result, null when none is open. */
const viewOf = (state: unknown) => (state as { layout: { view: { id: string; input?: unknown } | null } }).layout.view

const create = (params: Record<string, unknown>) => call(w!.client, 'quirky.worktree/create', params) as Promise<WorktreeCreateResult>
const list = async (repo: string) => (await call(w!.client, 'quirky.worktree/list', { repo })) as Worktree[]
const worktreeCount = (dir: string) => git(dir, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length

async function cli(positionals: string[], flags: Record<string, string | boolean> | undefined, options: { json: true; client?: World['client'] }): Promise<WorktreeCreateResult>
async function cli(positionals: string[], flags?: Record<string, string | boolean>, options?: { json?: false; client?: World['client'] }): Promise<string>
async function cli(positionals: string[], flags: Record<string, string | boolean> = {}, options: { json?: boolean; client?: World['client'] } = {}) {
  const { ctx, lines } = testCliContext(options.client ?? w!.client, { json: options.json ?? false })
  await commands.create!({ positionals, flags }, ctx)
  return options.json ? (JSON.parse(lines[0]!) as WorktreeCreateResult) : lines[0]!
}

describe('SC-14: a create with just a name uses the defaults (CLI)', () => {
  test('the worktree is on <user>/<name> cut from origin/main with no upstream, and the view is untouched', async () => {
    const { dir, root } = await startApi('real')
    const before = viewOf(await call(w!.client, 'ui.state'))
    const result = await cli(['api', 'fix-login'], {}, { json: true })
    const path = join(root, 'api', 'fix-login')
    expect(result.worktree).toMatchObject({
      path,
      branch: 'zoe/fix-login',
      name: 'fix-login',
      status: 'in-progress',
      createdBy: 'cli',
      baseRef: 'origin/main',
      parentId: null,
      isMain: false,
      keepBranch: false
    })
    expect(result).toMatchObject({ warnings: [], setup: { ran: 'none' } })
    expect(result.agentSessionId).toBeUndefined()
    expect(git(dir, 'config', '--get', 'branch.zoe/fix-login.base')).toBe('refs/remotes/origin/main')
    expect(git(dir, 'config', '--get', 'push.autoSetupRemote')).toBe('true')
    expect(Bun.spawnSync(['git', 'config', '--get', 'branch.zoe/fix-login.merge'], { cwd: dir }).exitCode).toBe(1)
    expect(git(path, 'rev-parse', 'HEAD')).toBe(git(dir, 'rev-parse', 'origin/main'))
    expect(viewOf(await call(w!.client, 'ui.state'))).toEqual(before)
    expect((await list('api')).map((worktree) => worktree.name)).toEqual(['main', 'fix-login'])
  })

  test('the text output is the record, with no extra lines when nothing needs saying', async () => {
    const { root } = await startApi()
    const text = await cli(['api', 'plain'])
    expect(text).toMatch(new RegExp(`^id: wt_[0-9a-f]{12}\\nname: plain\\nbranch: zoe/plain\\npath: ${join(root, 'api', 'plain')}$`))
  })

  test('an explicitly named branch that matches its remote base gets that upstream', async () => {
    const { dir, root } = await startApi()
    git(dir, 'checkout', '-q', '-b', 'scratch')
    git(dir, 'branch', '-D', 'main')
    const made = await create({ repo: 'api', name: 'tracked', branchName: 'main', base: 'origin/main' })
    expect(made.worktree).toMatchObject({ branch: 'main', path: join(root, 'api', 'tracked') })
    expect(git(dir, 'config', '--get', 'branch.main.remote')).toBe('origin')
    expect(git(dir, 'config', '--get', 'branch.main.merge')).toBe('refs/heads/main')
  })

  test('the project, parent, display name and comment are recorded', async () => {
    await startApi()
    const base = await create({ repo: 'api', name: 'base-wt' })
    const made = await create({ repo: 'api', name: 'child', parent: 'base-wt', displayName: ' Child one ', comment: 'a note' })
    expect(made.worktree).toMatchObject({ parentId: base.worktree.id, displayName: 'Child one', name: 'Child one', comment: 'a note' })
    const refused = await failure(create({ repo: 'api', name: 'both', parent: 'base-wt', noParent: true }))
    expect(refused.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('without a project and outside any worktree the create names how to pick one', async () => {
    await startApi()
    expect(await failure(create({ name: 'x' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'name a project with --repo' })
  })
})

describe('SC-5: a project with no commits refuses a worktree (CLI)', () => {
  test('repo create then a create fails with "<repo> has no commits yet" and makes nothing', async () => {
    w = await startWorld()
    const scratchRepo = (await call(w.client, 'quirky.repo/create', { name: 'scratch' })) as Repo
    const refused = await failure(cli(['scratch', 'first']))
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, message: 'scratch has no commits yet', data: { reason: 'no-commits', repo: scratchRepo.id } })
    expect(existsSync(join(w.root, 'scratch', 'first'))).toBe(false)
    expect(git(scratchRepo.path, 'worktree', 'list').split('\n')).toHaveLength(1)
  })
})

describe('SC-15: names are sanitised and cannot leave the worktrees folder (API)', () => {
  test('odd names become safe folders and branches; an empty result is refused', async () => {
    const { root } = await startApi()
    const names = ['Fix Login: ünïcode!', '../../etc', '🦀🦀']
    const made = []
    for (const name of names) made.push((await create({ repo: 'api', name })).worktree)
    expect(made.map((worktree) => worktree.path)).toEqual([join(root, 'api', 'Fix-Login-ünïcode'), join(root, 'api', 'etc'), join(root, 'api', 'workspace')])
    expect(made.map((worktree) => worktree.branch)).toEqual(['zoe/Fix-Login-ünïcode', 'zoe/etc', 'zoe/workspace'])

    const refused = await failure(create({ repo: 'api', name: '...' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Invalid worktree name', data: { reason: 'invalid-name' } })
    expect(readdirSync(join(root, 'api')).sort()).toEqual(['Fix-Login-ünïcode', 'etc', 'workspace'].sort())
  })
})

describe('SC-16: taken names get the next free suffix (API)', () => {
  test('a remote-only branch and an existing folder are skipped, and an explicit branch name is not suffixed', async () => {
    const { dir, root } = await startApi()
    git(dir, 'branch', 'zoe/fix-login')
    git(dir, 'push', '-q', 'origin', 'zoe/fix-login')
    git(dir, 'branch', '-D', 'zoe/fix-login')
    mkdirSync(join(root, 'api', 'fix-login-2'), { recursive: true })

    const first = await create({ repo: 'api', name: 'fix-login' })
    expect(first.worktree).toMatchObject({ path: join(root, 'api', 'fix-login-3'), branch: 'zoe/fix-login-3' })

    const refused = await failure(create({ repo: 'api', name: 'other', branchName: 'main' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Branch main already exists', data: { reason: 'branch-exists', branch: 'main' } })
    expect(existsSync(join(root, 'api', 'other'))).toBe(false)
    expect((await list('api')).map((worktree) => worktree.name)).toEqual(['main', 'fix-login-3'])
  })

  test('an existing branch at the base that nothing has checked out is reused and is not kept on delete', async () => {
    const { dir, root } = await startApi()
    git(dir, 'branch', 'prepared', 'origin/main')
    const made = await create({ repo: 'api', name: 'reuse', branchName: 'prepared' })
    expect(made.worktree).toMatchObject({ branch: 'prepared', path: join(root, 'api', 'reuse'), keepBranch: false, baseRef: 'origin/main' })

    git(dir, 'branch', 'moved', 'origin/main')
    const other = join(scratch(), 'other-checkout')
    git(dir, 'worktree', 'add', '-q', other, 'moved')
    const busy = await failure(create({ repo: 'api', name: 'busy', branchName: 'moved' }))
    expect(busy.data).toMatchObject({ reason: 'branch-exists' })
  })

  test('a branch name git rejects is refused before anything is made', async () => {
    const { dir, root } = await startApi()
    for (const branchName of ['bad name', '-dash', 'a..b']) {
      expect(await failure(create({ repo: 'api', name: 'x', branchName }))).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'invalid-name' } })
    }
    expect(existsSync(join(root, 'api'))).toBe(false)
    expect(worktreeCount(dir)).toBe(1)
  })

  test('a hundred taken candidates end in branch-exists', async () => {
    const { dir, root } = await startApi()
    await setSetting(w!.client, 'branchPrefix', 'none')
    git(dir, 'branch', 'busy')
    for (let n = 2; n <= 100; n++) git(dir, 'branch', `busy-${n}`)
    const refused = await failure(create({ repo: 'api', name: 'busy' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Branch "busy-100" already exists locally.', data: { reason: 'branch-exists' } })
    expect(existsSync(join(root, 'api'))).toBe(false)
  })
})

describe('SC-17: the branch prefix follows the setting (CLI)', () => {
  test('none, a custom prefix, a prefix git rejects, and no user to take one from', async () => {
    const { dir, root } = await startApi()
    await setSetting(w!.client, 'branchPrefix', 'none')
    expect((await create({ repo: 'api', name: 'a' })).worktree.branch).toBe('a')

    await setSetting(w!.client, 'branchPrefix', 'custom')
    await setSetting(w!.client, 'branchPrefixCustom', 'team/')
    expect((await create({ repo: 'api', name: 'b' })).worktree.branch).toBe('team/b')

    await setSetting(w!.client, 'branchPrefixCustom', 'bad prefix')
    const refused = await failure(cli(['api', 'c']))
    expect(refused).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'Branch prefix "bad prefix" contains characters git rejects — update it in Settings',
      data: { reason: 'invalid-prefix', prefix: 'bad prefix' }
    })
    expect(existsSync(join(root, 'api', 'c'))).toBe(false)

    await setSetting(w!.client, 'branchPrefix', 'git-username')
    useGlobalGitConfig(scratch, null)
    git(dir, 'config', '--unset', 'user.name')
    expect((await create({ repo: 'api', name: 'd' })).worktree.branch).toBe('d')
  })

  test('the username comes from github.user, then user.username, then a branch-safe user.name', async () => {
    const { dir } = await startApi()
    useGlobalGitConfig(scratch, '[user]\n\tusername = second\n')
    expect((await create({ repo: 'api', name: 'one' })).worktree.branch).toBe('second/one')
    useGlobalGitConfig(scratch, '[user]\n\tname = Zoe Young\n')
    git(dir, 'config', '--unset', 'user.name')
    expect((await create({ repo: 'api', name: 'two' })).worktree.branch).toBe('two')
    useGlobalGitConfig(scratch, '[user]\n\tname = zoe-y\n')
    expect((await create({ repo: 'api', name: 'three' })).worktree.branch).toBe('zoe-y/three')
  })

  test('nestWorkspaces off puts the folder directly under the worktrees root', async () => {
    const { root } = await startApi()
    await setSetting(w!.client, 'nestWorkspaces', false)
    expect((await create({ repo: 'api', name: 'flat' })).worktree.path).toBe(join(root, 'flat'))
  })
})

describe('SC-18: creating from an existing branch checks it out and keeps it (CLI)', () => {
  test('a local branch, a remote-only branch, and a branch checked out elsewhere', async () => {
    const { dir, root } = await startApi()
    git(dir, 'branch', 'feat/passing')
    git(dir, 'branch', 'feat/remote')
    git(dir, 'push', '-q', 'origin', 'feat/remote')
    git(dir, 'branch', '-D', 'feat/remote')

    const passing = await cli([], { repo: 'api', branch: 'feat/passing' }, { json: true })
    expect(passing.worktree).toMatchObject({ path: join(root, 'api', 'feat-passing'), branch: 'feat/passing', keepBranch: true, name: 'feat-passing', baseRef: null })

    const remote = await cli([], { repo: 'api', branch: 'feat/remote' }, { json: true })
    expect(remote.worktree).toMatchObject({ path: join(root, 'api', 'feat-remote'), branch: 'feat/remote', keepBranch: true })
    expect(git(dir, 'rev-parse', '--abbrev-ref', 'feat/remote@{upstream}')).toBe('origin/feat/remote')

    const before = worktreeCount(dir)
    const refused = await failure(cli([], { repo: 'api', branch: 'main' }))
    expect(refused.code).toBe(RpcErrorCode.Conflict)
    expect(refused.message).toContain(dir)
    expect(refused.data).toMatchObject({ reason: 'branch-checked-out', branch: 'main', path: dir })
    expect(worktreeCount(dir)).toBe(before)
  })

  test('a taken folder takes the next suffix, a typed name wins over the branch, and the origin/ form works', async () => {
    const { dir, root } = await startApi()
    git(dir, 'branch', 'feat/passing')
    git(dir, 'branch', 'other')
    mkdirSync(join(root, 'api', 'feat-passing'), { recursive: true })
    expect((await create({ repo: 'api', branch: 'feat/passing' })).worktree.path).toBe(join(root, 'api', 'feat-passing-2'))
    expect((await create({ repo: 'api', branch: 'other', name: 'mine' })).worktree).toMatchObject({ path: join(root, 'api', 'mine'), branch: 'other' })

    git(dir, 'branch', 'feat/over')
    git(dir, 'push', '-q', 'origin', 'feat/over')
    git(dir, 'branch', '-D', 'feat/over')
    expect((await create({ repo: 'api', branch: 'origin/feat/over' })).worktree).toMatchObject({ branch: 'feat/over', path: join(root, 'api', 'feat-over') })
  })

  test('a branch that exists nowhere is refused', async () => {
    await startApi()
    expect(await failure(create({ repo: 'api', branch: 'nope' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Branch "nope" was not found.' })
  })

  test('branch together with branchName is refused', async () => {
    await startApi()
    expect((await failure(create({ repo: 'api', branch: 'main', branchName: 'x' }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('SC-19: the base is requested, saved or detected, and its absence is an error before git runs (CLI)', () => {
  async function fourRepos() {
    w = await startWorld()
    const develop = makeOrigin(join(scratch(), 'a-origin.git'), { branch: 'develop' })
    const a = makeProject(join(scratch(), 'a'), { origin: develop })
    const b = makeProject(join(scratch(), 'b'))
    const c = makeProject(join(scratch(), 'c'))
    git(c, 'branch', '-m', 'main', 'trunk')
    const d = makeProject(join(scratch(), 'd'))
    git(d, 'branch', 'release')
    for (const dir of [a, b, c, d]) await w.add(dir)
    await repoSet(w.client, 'd', { defaultBase: 'release' })
    return { a, b, c, d }
  }

  test('each repo picks its own base, and none is refused with the exact sentence', async () => {
    const { c } = await fourRepos()
    expect((await cli(['a', 'x'], {}, { json: true })).worktree.baseRef).toBe('origin/develop')
    expect((await cli(['b', 'x'], {}, { json: true })).worktree.baseRef).toBe('main')
    expect((await cli(['d', 'x'], {}, { json: true })).worktree.baseRef).toBe('release')

    const refused = await failure(cli(['c', 'x']))
    expect(refused).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'Could not resolve a default base ref for this repo. Pass an explicit --base and try again.',
      data: { reason: 'no-base' }
    })
    expect(worktreeCount(c)).toBe(1)
    expect((await cli(['c', 'x'], { base: 'trunk' }, { json: true })).worktree.baseRef).toBe('trunk')
  })

  test('a saved base that does not resolve falls back to the detected one, and an unknown requested base is refused', async () => {
    const { b } = await fourRepos()
    await repoSet(w!.client, 'b', { defaultBase: 'gone' })
    expect((await create({ repo: 'b', name: 'y' })).worktree.baseRef).toBe('main')
    expect(await failure(create({ repo: 'b', name: 'z', base: 'nowhere' }))).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Base ref "nowhere" was not found.' })
    expect(worktreeCount(b)).toBe(2)
  })

  test('a commit-ish base works and is recorded as given', async () => {
    const { b } = await fourRepos()
    const sha = git(b, 'rev-parse', 'HEAD')
    const made = await create({ repo: 'b', name: 'pinned', base: sha })
    expect(made.worktree.baseRef).toBe(sha)
    expect(git(made.worktree.path, 'rev-parse', 'HEAD')).toBe(sha)
  })
})

describe('SC-20: a remote base that cannot be fetched falls back to the local branch with a notice (CLI; Orca defect)', () => {
  async function offlineApi() {
    const started = await startApi()
    git(started.dir, 'update-ref', '-d', 'refs/remotes/origin/main')
    git(started.dir, 'remote', 'set-url', 'origin', join(scratch(), 'missing.git'))
    return started
  }
  const notice = 'The remote-tracking ref origin/main was unavailable, so Quirky used local main instead. This workspace may not include the latest remote changes.'

  test('the CLI falls back and prints the notice; --no-fallback fails and creates nothing; the window path matches the CLI', async () => {
    const { dir, root } = await offlineApi()
    const text = await cli(['api', 'offline'], { base: 'origin/main' })
    expect(text.split('\n')).toContain(notice)
    const [, offline] = await list('api')
    expect(offline).toMatchObject({ name: 'offline', baseRef: 'main' })

    const refused = await failure(cli(['api', 'offline2'], { base: 'origin/main', 'no-fallback': true }))
    expect(refused).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'Could not refresh base ref "origin/main" from "origin". Check your network and try again.',
      data: { reason: 'base-unreachable', ref: 'origin/main', remote: 'origin' }
    })
    expect(existsSync(join(root, 'api', 'offline2'))).toBe(false)
    expect(worktreeCount(dir)).toBe(2)

    const window = await create({ repo: 'api', name: 'offline3', base: 'origin/main', createdBy: 'window' })
    expect(window.baseFallback).toEqual({ requestedRef: 'origin/main', localRef: 'main', message: notice })
    expect(window.worktree).toMatchObject({ baseRef: 'main', createdBy: 'window' })
  })

  test('a fetch that works but still lacks the base says so, and without a local branch there is no fallback', async () => {
    const { dir } = await startApi()
    const missing = await failure(create({ repo: 'api', name: 'x', base: 'origin/nope' }))
    expect(missing).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Base ref "origin/nope" was not found after fetching.', data: { reason: 'base-unreachable' } })
    git(dir, 'remote', 'set-url', 'origin', join(scratch(), 'missing.git'))
    const unreachable = await failure(create({ repo: 'api', name: 'y', base: 'origin/nope' }))
    expect(unreachable.message).toBe('Could not refresh base ref "origin/nope" from "origin". Check your network and try again.')
  })

  test('an existing remote-tracking base is used as is and refreshed in the background', async () => {
    const { dir, origin } = await startApi()
    const pusher = makeProject(join(scratch(), 'pusher'), { origin })
    commitFiles(pusher, { 'b.txt': 'two\n' })
    git(pusher, 'push', '-q', 'origin', 'main')
    const stale = git(dir, 'rev-parse', 'origin/main')
    const made = await create({ repo: 'api', name: 'stale', base: 'origin/main' })
    expect(made.baseFallback).toBeUndefined()
    expect(made.worktree.baseRef).toBe('origin/main')
    await waitFor(() => (git(dir, 'rev-parse', 'origin/main') !== stale ? true : undefined), 5000)
  })
})

describe('the commit the setup gate read is the commit the workspace is made from', () => {
  test('a remote base that moves after the hooks were read does not change the commit checked out', async () => {
    const { dir, origin } = await startApi()
    const pusher = makeProject(join(scratch(), 'pusher'), { origin })
    const gated = git(dir, 'rev-parse', 'origin/main')
    commitFiles(pusher, { 'b.txt': 'two\n' })
    git(pusher, 'push', '-q', 'origin', 'main')

    const real = gitApi()
    useTestGit({
      ...real,
      addNewBranchWorktree: async (...args: Parameters<typeof real.addNewBranchWorktree>) => {
        git(dir, 'fetch', '-q', 'origin')
        return real.addNewBranchWorktree(...args)
      }
    })
    try {
      const made = await create({ repo: 'api', name: 'pinned', base: 'origin/main' })
      expect(git(dir, 'rev-parse', 'origin/main')).not.toBe(gated)
      expect(git(made.worktree.path, 'rev-parse', 'HEAD')).toBe(gated)
    } finally {
      useTestGit(null)
    }
  })
})

describe('SC-21: a blank name gets a generated name that is never reused (CLI)', () => {
  test('names differ, a deleted worktree\'s name is not handed out again, and a typed name can be reused', async () => {
    const { dir } = await startApi()
    const first = await cli([], { repo: 'api' }, { json: true })
    const second = await cli([], { repo: 'api' }, { json: true })
    expect(first.worktree.name).not.toBe(second.worktree.name)
    await call(w!.client, 'quirky.worktree/remove', { worktree: first.worktree.id, yes: true })

    const later = new Set<string>()
    for (let n = 0; n < 30; n++) later.add((await create({ repo: 'api' })).worktree.name)
    expect(later.size).toBe(30)
    expect(later.has(first.worktree.name)).toBe(false)
    expect(later.has(second.worktree.name)).toBe(false)
    const rows = (await call(w!.client, 'quirky.worktree/list', { repo: 'api' })) as Worktree[]
    expect(rows.every((worktree) => worktree.isMain || /^[a-z]+$/.test(worktree.name))).toBe(true)

    const typed = await create({ repo: 'api', name: 'typed' })
    git(dir, 'worktree', 'remove', typed.worktree.path)
    git(dir, 'branch', '-d', 'zoe/typed')
    expect((await create({ repo: 'api', name: 'typed' })).worktree.name).toBe('typed')
  })

  test('suggestName offers the name the next blank create takes, and retires nothing', async () => {
    const { t, repo } = await startApi()
    const one = (await call(w!.client, 'quirky.worktree/suggestName', { repo: 'api' })) as { name: string }
    const again = (await call(w!.client, 'quirky.worktree/suggestName', { repo: repo.id })) as { name: string }
    expect(again.name).toBe(one.name)
    expect(retired(t.h.home)).toEqual([])

    const made = await create({ repo: 'api' })
    expect(made.worktree.name).toBe(one.name)
    expect(retired(t.h.home)).toEqual([one.name])
    const next = (await call(w!.client, 'quirky.worktree/suggestName', { repo: 'api' })) as { name: string }
    expect(next.name).not.toBe(one.name)
  })

  test('a generated name the collision walk suffixed is retired along with the one picked', async () => {
    const { t, root } = await startApi()
    const suggested = (await call(w!.client, 'quirky.worktree/suggestName', { repo: 'api' })) as { name: string }
    mkdirSync(join(root, 'api', suggested.name), { recursive: true })
    const made = await create({ repo: 'api' })
    expect(made.worktree.name).toBe(`${suggested.name}-2`)
    expect(retired(t.h.home)).toEqual([suggested.name, `${suggested.name}-2`].sort())
  })

  test('a failed create still retires the generated name it picked', async () => {
    const { t } = await startApi()
    await setSetting(w!.client, 'branchPrefix', 'custom')
    await setSetting(w!.client, 'branchPrefixCustom', 'bad prefix')
    const suggested = (await call(w!.client, 'quirky.worktree/suggestName', { repo: 'api' })) as { name: string }
    await failure(create({ repo: 'api' }))
    expect(retired(t.h.home)).toEqual([suggested.name])
  })
})

function retired(home: string): string[] {
  const { Database } = require('bun:sqlite') as typeof import('bun:sqlite')
  const db = new Database(join(home, 'plugin-data', 'quirky.worktree', 'store.db'), { readonly: true })
  try {
    return (db.query('SELECT name FROM retired_names ORDER BY name').all() as { name: string }[]).map((row) => row.name)
  } finally {
    db.close()
  }
}

describe('SC-22: two creates of one name at once both succeed (API)', () => {
  test('one gets the name and one the next suffix, and git lists both', async () => {
    const { dir, root } = await startApi()
    const [one, two] = await Promise.all([create({ repo: 'api', name: 'race' }), create({ repo: 'api', name: 'race' })])
    expect([one.worktree.name, two.worktree.name].sort()).toEqual(['race', 'race-2'])
    expect([one.worktree.path, two.worktree.path].sort()).toEqual([join(root, 'api', 'race'), join(root, 'api', 'race-2')])
    expect(git(dir, 'worktree', 'list')).toContain('race-2')
    expect(worktreeCount(dir)).toBe(3)
  })
})

describe('SC-23: inside a worktree, one positional is the name and the caller becomes the parent (CLI)', () => {
  test('the new worktrees are in the callers project, nested unless --no-parent', async () => {
    await startApi()
    const fixLogin = await create({ repo: 'api', name: 'fix-login' })
    const inside = await w!.t.connectAs({ worktreeId: fixLogin.worktree.id })

    const childA = await cli(['child-a'], {}, { json: true, client: inside })
    const childB = await cli(['child-b'], { 'no-parent': true }, { json: true, client: inside })
    const generated = await cli([], {}, { json: true, client: inside })
    for (const result of [childA, childB, generated]) expect(result.worktree.repoId).toBe(fixLogin.worktree.repoId)
    expect(childA.worktree.parentId).toBe(fixLogin.worktree.id)
    expect(generated.worktree.parentId).toBe(fixLogin.worktree.id)
    expect(childB.worktree.parentId).toBeNull()

    const shown = (await call(w!.client, 'quirky.worktree/show', { worktree: 'fix-login' })) as Worktree & { children: string[] }
    expect([...shown.children].sort()).toEqual([childA.worktree.id, generated.worktree.id].sort())
  })

  test('a cwd inside a worktree counts as the caller, a window create is never nested, and another project is not inferred', async () => {
    const { dir } = await startApi()
    const fixLogin = await create({ repo: 'api', name: 'fix-login' })
    const cwdClient = await w!.t.connectAs({ cwd: join(fixLogin.worktree.path) })
    expect((await cli(['from-cwd'], {}, { json: true, client: cwdClient })).worktree.parentId).toBe(fixLogin.worktree.id)
    expect((await call(cwdClient, 'quirky.worktree/create', { name: 'win', createdBy: 'window' }).then((r) => r as WorktreeCreateResult)).worktree.parentId).toBeNull()

    const other = await w!.add(makeProject(join(scratch(), 'other')))
    const inOther = await call(cwdClient, 'quirky.worktree/create', { repo: other.id, name: 'elsewhere' })
    expect((inOther as WorktreeCreateResult).worktree.parentId).toBeNull()
    expect(dir).toBeTruthy()
  })
})

describe('SC-24: a CLI create opens the new worktree only with --activate (CLI)', () => {
  test('the first create leaves the view alone; the second opens the new worktree\'s session view', async () => {
    await startApi('real')
    const view = async () => viewOf(await call(w!.client, 'ui.state'))
    await cli(['api', 'quiet'])
    expect(await view()).toBeFalsy()
    const loud = await cli(['api', 'loud'], { activate: true }, { json: true })
    expect(await view()).toEqual({ id: 'view:quirky.session/worktree', input: { worktree: loud.worktree.id } })
  })

  test('if the view cannot be opened the create still succeeds and says so', async () => {
    await startApi('none')
    const made = await create({ repo: 'api', name: 'noview', activate: true })
    expect(made.worktree.name).toBe('noview')
    expect(made.warnings).toHaveLength(1)
    expect(made.warnings[0]).toContain('could not open noview')
  })
})

describe('SC-27: the window and the CLI create the same worktree from the same input (API; Orca defect)', () => {
  test('two identical projects give the same folder, branch, base, fallback, status and Setup session', async () => {
    w = await startWorld('real')
    const projects: Repo[] = []
    for (const name of ['api1', 'api2']) {
      const origin = makeOrigin(join(scratch(), `${name}.git`))
      const dir = makeProject(join(scratch(), name), { origin })
      git(dir, 'update-ref', '-d', 'refs/remotes/origin/main')
      git(dir, 'remote', 'set-url', 'origin', join(scratch(), `${name}-gone.git`))
      projects.push(await w.add(dir))
      await repoSet(w.client, name, { setupPolicy: 'run-by-default', setupScript: 'true' })
    }
    const fromWindow = await create({ repo: 'api1', name: 'same', base: 'origin/main', createdBy: 'window' })
    const fromCli = await cli(['api2', 'same'], { base: 'origin/main' }, { json: true })

    const shape = (result: WorktreeCreateResult, root: string) => ({
      folder: result.worktree.path.slice(root.length),
      branch: result.worktree.branch,
      baseRef: result.worktree.baseRef,
      fallback: result.baseFallback,
      status: result.worktree.status,
      setup: result.setup.ran
    })
    expect(shape(fromWindow, join(w.root, 'api1'))).toEqual(shape(fromCli, join(w.root, 'api2')))
    expect(shape(fromCli, join(w.root, 'api2'))).toMatchObject({ folder: '/same', branch: 'zoe/same', baseRef: 'main', setup: 'terminal' })
    expect([fromWindow.worktree.createdBy, fromCli.worktree.createdBy]).toEqual(['window', 'cli'])
    const sessions = (await call(w.client, 'quirky.session/list')) as Session[]
    expect(sessions.map((session) => [session.worktreeId, session.title]).sort()).toEqual(
      [
        [fromWindow.worktree.id, 'Setup'],
        [fromCli.worktree.id, 'Setup']
      ].sort()
    )
  })
})

describe('SC-60: the next worktree is created under the project\'s worktree location', () => {
  test('a relative location is read against the repository, an absolute one is used as is', async () => {
    const { dir } = await startApi()
    await repoSet(w!.client, 'api', { worktreeLocation: '../api-ws' })
    const relative = (await create({ repo: 'api', name: 'next' })).worktree
    const expected = join(realpathSync(join(dir, '..')), 'api-ws')
    expect(relative.path).toBe(join(expected, 'api', 'next'))

    const absolute = join(scratch(), 'elsewhere')
    mkdirSync(absolute, { recursive: true })
    await repoSet(w!.client, 'api', { worktreeLocation: absolute })
    expect((await create({ repo: 'api', name: 'abs' })).worktree.path).toBe(join(realpathSync(absolute), 'api', 'abs'))

    await repoSet(w!.client, 'api', { worktreeLocation: '' })
    expect((await create({ repo: 'api', name: 'default' })).worktree.path).toBe(join(w!.root, 'api', 'default'))
  })
})

describe('SC-11: a group workspace is created from the CLI and a shell starts in the group folder', () => {
  test('--group makes a folder workspace on the parent folder; a group without one refuses', async () => {
    w = await startWorld('real')
    const appsDir = join(scratch(), 'apps')
    mkdirSync(appsDir, { recursive: true })
    const parentPath = realpathSync(appsDir)
    await call(w.client, 'quirky.repo/groupCreate', { name: 'apps', parentPath })
    await call(w.client, 'quirky.repo/groupCreate', { name: 'loose' })

    const made = await cli(['apps-root'], { group: 'apps' }, { json: true })
    expect(made.worktree).toMatchObject({ kind: 'folder', path: parentPath, name: 'apps-root', createdBy: 'cli' })
    expect(made.worktree.groupId).toBeTruthy()
    const session = (await call(w.client, 'quirky.session/create', { worktree: made.worktree.id, agent: 'shell' })) as Session
    const spawned = w.t.h.pty.requests.find((request) => request.type === 'create' && request.sessionId === session.id)
    expect(spawned).toMatchObject({ cwd: parentPath })
    expect(readdirSync(parentPath)).toEqual([])

    const refused = await failure(cli(['x'], { group: 'loose' }))
    expect(refused).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'group loose has no parent folder' })
  })
})

describe('SC-61: create parameter validation', () => {
  test('an unknown param or a bad setup value is refused by the schema', async () => {
    await startApi()
    expect((await failure(create({ repo: 'api', name: 'x', baseRef: 'main' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(create({ repo: 'api', name: 'x', setup: 'maybe' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(create({ repo: 'api', name: 'x', agent: 'shell' }))).code).toBe(RpcErrorCode.InvalidParams)
  })
})

describe('the result and the record', () => {
  test('a create in a folder project returns the result shape with the workspace', async () => {
    w = await startWorld()
    const notes = join(scratch(), 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'notes.txt'), 'hello\n')
    await call(w.client, 'quirky.repo/add', { path: realpathSync(notes), folder: true })
    const made = await create({ repo: 'notes', name: 'drafts', displayName: 'Drafts', comment: 'x' })
    expect(made).toMatchObject({ warnings: [], setup: { ran: 'none' }, worktree: { name: 'Drafts', kind: 'folder', comment: 'x', createdBy: 'api' } })
    expect(readdirSync(realpathSync(notes))).toEqual(['notes.txt'])
  })
})
