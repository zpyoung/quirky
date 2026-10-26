import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  RpcErrorCode,
  type EffectiveHooks,
  type ProjectGroup,
  type ProjectSettings,
  type QuirkyClient,
  type QuirkyEvent,
  type Repo,
  type RepoDetails
} from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import * as realGit from '@quirky/git'
import { GitError } from '@quirky/git'
import type { GitApi } from '@quirky/git'
import { useTestGit } from '@quirky/git/testing'
import { homedir } from 'node:os'
import { cloneRepo } from '../src/projects'
import type { Env } from '../src/env'
import { call, commitFiles, failure, git, isolateGitConfig, makeRepo } from './git-fixtures'
import { startPluginHarness, type PluginHarness } from './harness'

const { scratch } = isolateGitConfig()

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

/** A daemon on real git whose worktrees folder is `<scratch>/ws`. */
async function start() {
  t = await startPluginHarness({ realGit: true })
  const watcher = await t.h.connectWithEvents('cli')
  const home = scratch()
  const root = join(home, 'ws')
  await call(watcher.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  return { t, client: watcher.client, events: watcher.events, home, root }
}

const add = (client: QuirkyClient, path: string, folder?: boolean) =>
  call(client, 'quirky.repo/add', { path, ...(folder ? { folder } : {}) }) as Promise<Repo>
const list = (client: QuirkyClient) => call(client, 'quirky.repo/list') as Promise<Repo[]>
const groups = (client: QuirkyClient) => call(client, 'quirky.repo/groupList') as Promise<ProjectGroup[]>
const show = (client: QuirkyClient, repo: string) => call(client, 'quirky.repo/show', { repo }) as Promise<RepoDetails>

describe('SC-1: adding a git repo', () => {
  test('lists the project with kind git, and adding it again returns the existing one', async () => {
    const { client, home } = await start()
    const api = makeRepo(join(home, 'api'))
    const repo = await add(client, api)
    expect(repo).toMatchObject({ name: 'api', path: api, kind: 'git', displayName: null, groupId: null })
    expect((await add(client, join(api, '.git/..'))).id).toBe(repo.id)
    expect(await list(client)).toEqual([repo])
  })

  test('list is ordered by when each repo was added', async () => {
    const { client, home } = await start()
    const first = await add(client, makeRepo(join(home, 'zeta')))
    await Bun.sleep(3)
    const second = await add(client, makeRepo(join(home, 'alpha')))
    expect((await list(client)).map((r) => r.id)).toEqual([first.id, second.id])
  })
})

describe('SC-2: adding a plain folder', () => {
  test('without folder it is refused with the not-a-repository reason and the --folder hint', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'notes.txt'), 'hi\n')
    const err = await failure(add(client, notes))
    expect(err.code).toBe(RpcErrorCode.InvalidParams)
    expect(err.message).toBe(`not a git repository: ${notes}; pass --folder to add it as a folder project`)
    expect(err.data).toEqual({ reason: 'not-a-repository', path: notes })
    expect(await list(client)).toEqual([])
  })

  test('with folder it adds a folder project at the real path and leaves the folder alone', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    writeFileSync(join(notes, 'notes.txt'), 'hi\n')
    const repo = await add(client, notes, true)
    expect(repo).toMatchObject({ name: 'notes', path: realpathSync(notes), kind: 'folder' })
    expect((await add(client, notes, true)).id).toBe(repo.id)
    expect(existsSync(join(notes, '.git'))).toBe(false)
    expect((await list(client))[0]!.kind).toBe('folder')
  })

  test('a folder project has no shared hooks and show works', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    const repo = await add(client, notes, true)
    const details = await show(client, repo.id)
    expect(details.hooks).toMatchObject({ file: null, setup: null, archive: null })
  })

  test('a missing directory is a no-such-directory error even with folder', async () => {
    const { client, home } = await start()
    const err = await failure(add(client, join(home, 'missing'), true))
    expect(err.code).toBe(RpcErrorCode.InvalidParams)
    expect(err.message).toBe(`no such directory: ${join(home, 'missing')}`)
  })
})

describe('adding a folder when git cannot answer', () => {
  test('a git that fails to run is an error, not a folder project', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    useTestGit({
      ...realGit,
      resolveRepoRoot: async () => {
        throw new GitError('failed to run git: spawn git ENOENT', '', -1)
      }
    } as unknown as GitApi)
    for (const folder of [true, false]) await expect(add(client, notes, folder)).rejects.toThrow()
    expect(await list(client)).toEqual([])
  })

  test('only git saying the path is not a repository makes it a folder project', async () => {
    const { client, home } = await start()
    const notes = join(home, 'notes')
    mkdirSync(notes, { recursive: true })
    useTestGit({
      ...realGit,
      resolveRepoRoot: async () => {
        throw new GitError('git rev-parse failed', 'fatal: not a git repository (or any of the parent directories): .git', 128)
      }
    } as unknown as GitApi)
    expect(await add(client, notes, true)).toMatchObject({ kind: 'folder', path: realpathSync(notes) })
  })
})

describe('the worktrees folder setting when cloning', () => {
  test('a setting lookup that fails for another reason aborts the clone before anything is created', async () => {
    const calls: string[] = []
    const env = {
      context: {
        call: async (method: string) => {
          calls.push(method)
          throw Object.assign(new Error('settings store unavailable'), { code: RpcErrorCode.Internal })
        }
      },
      fail: (_kind: string, message: string) => new Error(message)
    } as unknown as Env
    await expect(cloneRepo(env, { url: '/nonexistent/origin.git' })).rejects.toThrow('settings store unavailable')
    expect(calls).toEqual(['setting.get'])
  })

  test('a setting that does not exist falls back to ~/quirky/workspaces', async () => {
    const env = {
      context: { call: async () => { throw Object.assign(new Error('no setting'), { code: RpcErrorCode.NotFound }) } },
      fail: (_kind: string, message: string) => new Error(message)
    } as unknown as Env
    const cloned: string[] = []
    useTestGit({
      ...realGit,
      cloneRepo: async (_url: string, dest: string) => {
        cloned.push(dest)
        throw new GitError('stub', 'stub', 1)
      }
    } as unknown as GitApi)
    try {
      const name = `fallback-${crypto.randomUUID()}`
      await expect(cloneRepo(env, { url: '/nonexistent/origin.git', name })).rejects.toThrow('could not clone')
      expect(cloned).toEqual([join(homedir(), 'quirky', 'workspaces', name)])
    } finally {
      useTestGit(null)
    }
  })
})

describe('SC-4: clone', () => {
  async function bareOrigin(home: string): Promise<string> {
    const source = makeRepo(join(home, 'src'))
    const bare = join(home, 'origin.git')
    git(home, 'clone', '-q', '--bare', source, bare)
    return bare
  }

  test('clones into the worktrees folder as <name minus .git> and adds the project; a second clone is refused', async () => {
    const { client, home, root, events } = await start()
    const bare = await bareOrigin(home)
    const repo = (await call(client, 'quirky.repo/clone', { url: bare })) as Repo
    expect(repo).toMatchObject({ name: 'origin', path: join(root, 'origin'), kind: 'git' })
    expect(existsSync(join(root, 'origin', 'a.txt'))).toBe(true)
    await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.repo/changed'))

    const again = await failure(call(client, 'quirky.repo/clone', { url: bare }))
    expect(again.code).toBe(RpcErrorCode.Conflict)
    expect(again.data).toEqual({ reason: 'destination-exists', path: join(root, 'origin') })
    expect(await list(client)).toHaveLength(1)
  })

  test('location and name override the destination', async () => {
    const { client, home } = await start()
    const bare = await bareOrigin(home)
    const elsewhere = join(home, 'elsewhere')
    const repo = (await call(client, 'quirky.repo/clone', { url: bare, location: elsewhere, name: 'renamed' })) as Repo
    expect(repo).toMatchObject({ name: 'renamed', path: join(elsewhere, 'renamed') })
  })

  test('a failed clone adds nothing and says why', async () => {
    const { client, home } = await start()
    const err = await failure(call(client, 'quirky.repo/clone', { url: join(home, 'nothing.git'), location: join(home, 'x') }))
    expect(err.code).toBe(RpcErrorCode.InvalidParams)
    expect(await list(client)).toEqual([])
  })

  test('a clone name that is a path is refused before git runs', async () => {
    const { client } = await start()
    const err = await failure(call(client, 'quirky.repo/clone', { url: '/nonexistent/repo.git', name: '../escape' }))
    expect(err.data.reason).toBe('invalid-name')
  })
})

describe('SC-5: create', () => {
  test('initialises a repository in the worktrees folder and adds it', async () => {
    const { client, root } = await start()
    const repo = (await call(client, 'quirky.repo/create', { name: 'scratch' })) as Repo
    expect(repo).toMatchObject({ name: 'scratch', path: join(root, 'scratch'), kind: 'git' })
    expect(git(repo.path, 'rev-parse', '--show-toplevel')).toBe(repo.path)
    expect(Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { cwd: repo.path, env: process.env }).exitCode).not.toBe(0)
  })

  test('a non-empty destination is refused; an empty one is reused', async () => {
    const { client, root } = await start()
    mkdirSync(join(root, 'full'), { recursive: true })
    writeFileSync(join(root, 'full', 'f.txt'), 'x')
    const err = await failure(call(client, 'quirky.repo/create', { name: 'full' }))
    expect(err.code).toBe(RpcErrorCode.Conflict)
    expect(err.data).toEqual({ reason: 'destination-exists', path: join(root, 'full') })
    mkdirSync(join(root, 'empty'), { recursive: true })
    expect(((await call(client, 'quirky.repo/create', { name: 'empty' })) as Repo).path).toBe(join(root, 'empty'))
  })

  test('a name that is a path is refused', async () => {
    const { client } = await start()
    for (const name of ['', '.', '..', 'a/b']) {
      expect((await failure(call(client, 'quirky.repo/create', { name }))).data.reason).toBe('invalid-name')
    }
  })
})

describe('SC-6 and SC-7: scan and import', () => {
  function apps(home: string): string {
    const root = join(home, 'apps')
    makeRepo(join(root, 'web'))
    makeRepo(join(root, 'cli'))
    makeRepo(join(root, 'a', 'b', 'c', 'deep'))
    makeRepo(join(root, 'node_modules', 'pkg'))
    mkdirSync(join(root, 'web', 'vendored', '.git'), { recursive: true })
    return realpathSync(root)
  }

  test('SC-6: scan lists web and cli within depth 3, and deep at depth 4', async () => {
    const { client, home } = await start()
    const root = apps(home)
    const result = (await call(client, 'quirky.repo/scan', { path: root })) as { repos: { path: string; name: string }[]; truncated: boolean }
    expect(result).toEqual({
      repos: [
        { path: join(root, 'cli'), name: 'cli' },
        { path: join(root, 'web'), name: 'web' }
      ],
      truncated: false
    })
    const deeper = (await call(client, 'quirky.repo/scan', { path: root, maxDepth: 4 })) as typeof result
    expect(deeper.repos.map((r) => r.name)).toEqual(['deep', 'cli', 'web'])
    expect(deeper.repos.map((r) => r.path)).toContain(join(root, 'a', 'b', 'c', 'deep'))
    expect(await list(client)).toEqual([])
  })

  test('scan is read-only and validates its limits', async () => {
    const { client, home } = await start()
    const catalog = (await call(client, 'api.describe')) as { methods: { name: string; readOnly?: boolean }[] }
    expect(catalog.methods.find((m) => m.name === 'quirky.repo/scan')?.readOnly).toBe(true)
    const root = apps(home)
    expect((await failure(call(client, 'quirky.repo/scan', { path: root, maxDepth: 9 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call(client, 'quirky.repo/scan', { path: root, maxRepos: 0 }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call(client, 'quirky.repo/scan', { path: join(home, 'missing') }))).message).toBe(`no such directory: ${join(home, 'missing')}`)
  })

  test('SC-7: import adds the new repo, reports the known one, and groups both under the scanned folder', async () => {
    const { client, home } = await start()
    const root = apps(home)
    const cli = await add(client, join(root, 'cli'))
    const result = (await call(client, 'quirky.repo/import', { path: root, group: 'apps' })) as {
      results: { path: string; status: string; repoId?: string; error?: string }[]
      imported: number
      alreadyKnown: number
      failed: number
      groupId?: string
    }
    expect(result).toMatchObject({ imported: 1, alreadyKnown: 1, failed: 0 })
    expect(result.results.map((r) => [r.path, r.status])).toEqual([
      [join(root, 'cli'), 'already-known'],
      [join(root, 'web'), 'imported']
    ])
    expect(result.results[0]!.repoId).toBe(cli.id)
    const all = await groups(client)
    expect(all).toHaveLength(1)
    expect(all[0]).toMatchObject({ id: result.groupId, name: 'apps', parentPath: root, createdFrom: 'folder-scan', collapsed: false })
    expect([...all[0]!.repoIds].sort()).toEqual((await list(client)).map((r) => r.id).sort())
    expect((await list(client)).every((r) => r.groupId === result.groupId)).toBe(true)
  })

  test('import without a group adds the repos ungrouped, and importing again changes nothing', async () => {
    const { client, home } = await start()
    const root = apps(home)
    await call(client, 'quirky.repo/import', { path: root })
    expect(await groups(client)).toEqual([])
    const again = (await call(client, 'quirky.repo/import', { path: root })) as { imported: number; alreadyKnown: number; groupId?: string }
    expect(again).toMatchObject({ imported: 0, alreadyKnown: 2 })
    expect(again.groupId).toBeUndefined()
    expect(await list(client)).toHaveLength(2)
  })

  test('import into an existing group by name reuses it', async () => {
    const { client, home } = await start()
    const root = apps(home)
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'apps' })) as ProjectGroup
    const result = (await call(client, 'quirky.repo/import', { path: root, group: 'apps' })) as { groupId: string }
    expect(result.groupId).toBe(group.id)
    expect(await groups(client)).toHaveLength(1)
  })
})

describe('SC-9: removing a project', () => {
  test('forgets it and its settings, takes it out of its group, and leaves the folder', async () => {
    const { client, home, events } = await start()
    const dir = makeRepo(join(home, 'api'))
    const repo = await add(client, dir)
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'g' })) as ProjectGroup
    await call(client, 'quirky.repo/groupAdd', { group: group.id, repo: repo.id })
    await call(client, 'quirky.repo/set', { repo: repo.id, displayName: 'API', setupScript: 'make' })
    events.length = 0

    expect(await call(client, 'quirky.repo/remove', { repo: repo.id })).toEqual({ ok: true })
    expect(await list(client)).toEqual([])
    expect((await groups(client))[0]).toMatchObject({ id: group.id, repoIds: [] })
    expect(existsSync(dir)).toBe(true)
    const changed = await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.repo/changed'))
    expect(changed).toBeDefined()

    const back = await add(client, dir)
    const details = await show(client, back.id)
    expect(back.id).not.toBe(repo.id)
    expect(details.repo).toMatchObject({ displayName: null, groupId: null })
    expect(details.settings.setupScript).toBe('')
  })
})

describe('SC-10: groups', () => {
  test('create, fill, rename, collapse, empty and delete', async () => {
    const { client, home } = await start()
    const api = await add(client, makeRepo(join(home, 'api')))
    const web = await add(client, makeRepo(join(home, 'web')))

    const backend = (await call(client, 'quirky.repo/groupCreate', { name: 'backend' })) as ProjectGroup
    expect(backend).toMatchObject({ name: 'backend', parentPath: null, collapsed: false, createdFrom: 'manual', repoIds: [] })

    await call(client, 'quirky.repo/groupAdd', { group: 'backend', repo: 'api' })
    const filled = (await call(client, 'quirky.repo/groupAdd', { group: 'backend', repo: 'web' })) as ProjectGroup
    expect(filled.repoIds).toEqual([api.id, web.id])
    expect((await list(client)).map((r) => r.groupId)).toEqual([backend.id, backend.id])

    const renamed = (await call(client, 'quirky.repo/groupRename', { group: 'backend', name: 'services' })) as ProjectGroup
    expect(renamed).toMatchObject({ id: backend.id, name: 'services' })

    expect(((await call(client, 'quirky.repo/groupCollapse', { group: 'services' })) as ProjectGroup).collapsed).toBe(true)
    expect(((await groups(client))[0] as ProjectGroup).collapsed).toBe(true)
    expect(((await call(client, 'quirky.repo/groupCollapse', { group: 'services', collapsed: false })) as ProjectGroup).collapsed).toBe(false)
    await call(client, 'quirky.repo/groupCollapse', { group: 'services' })

    const trimmed = (await call(client, 'quirky.repo/groupRemove', { group: 'services', repo: 'web' })) as ProjectGroup
    expect(trimmed.repoIds).toEqual([api.id])

    expect(await call(client, 'quirky.repo/groupDelete', { group: 'services' })).toEqual({ ok: true })
    expect(await groups(client)).toEqual([])
    const left = await list(client)
    expect(left.map((r) => r.id)).toEqual([api.id, web.id])
    expect(left.every((r) => r.groupId === null)).toBe(true)
  })

  test('a project is in at most one group: adding it elsewhere moves it', async () => {
    const { client, home } = await start()
    const api = await add(client, makeRepo(join(home, 'api')))
    const one = (await call(client, 'quirky.repo/groupCreate', { name: 'one' })) as ProjectGroup
    const two = (await call(client, 'quirky.repo/groupCreate', { name: 'two', parentPath: '/some/where' })) as ProjectGroup
    expect(two.parentPath).toBe('/some/where')
    await call(client, 'quirky.repo/groupAdd', { group: one.id, repo: api.id })
    await call(client, 'quirky.repo/groupAdd', { group: two.id, repo: api.id })
    const all = await groups(client)
    expect(all.map((g) => [g.name, g.repoIds])).toEqual([
      ['one', []],
      ['two', [api.id]]
    ])
    expect(all.map((g) => g.order)).toEqual([...all.map((g) => g.order)].sort((a, b) => a - b))
  })

  test('group selectors are an ID or an exact name; unknown is not-found and duplicates conflict', async () => {
    const { client } = await start()
    const a = (await call(client, 'quirky.repo/groupCreate', { name: 'dup' })) as ProjectGroup
    await call(client, 'quirky.repo/groupCreate', { name: 'dup' })
    expect((await failure(call(client, 'quirky.repo/groupRename', { group: 'nope', name: 'x' }))).code).toBe(RpcErrorCode.NotFound)
    const ambiguous = await failure(call(client, 'quirky.repo/groupRename', { group: 'dup', name: 'x' }))
    expect(ambiguous.code).toBe(RpcErrorCode.Conflict)
    expect(await call(client, 'quirky.repo/groupRename', { group: a.id, name: 'solo' })).toMatchObject({ name: 'solo' })
  })

  test('a blank name is refused and every mutation emits changed with the ids', async () => {
    const { client, home, events } = await start()
    expect((await failure(call(client, 'quirky.repo/groupCreate', { name: '  ' }))).code).toBe(RpcErrorCode.InvalidParams)
    const api = await add(client, makeRepo(join(home, 'api')))
    events.length = 0
    const group = (await call(client, 'quirky.repo/groupCreate', { name: 'g' })) as ProjectGroup
    await call(client, 'quirky.repo/groupAdd', { group: group.id, repo: api.id })
    await waitFor(() => events.filter((e: QuirkyEvent) => e.type === 'quirky.repo/changed').length >= 2)
    const data = events.filter((e: QuirkyEvent) => e.type === 'quirky.repo/changed').map((e) => (e as { data?: unknown }).data)
    expect(data).toEqual([{ groupId: group.id }, { repoId: api.id, groupId: group.id }])
  })
})

describe('SC-60: project settings through set and show', () => {
  test('every value round-trips and an empty string clears', async () => {
    const { client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    const set = (await call(client, 'quirky.repo/set', {
      repo: 'api',
      displayName: 'API',
      defaultBase: 'origin/develop',
      worktreeLocation: '../api-ws',
      setupPolicy: 'ask',
      agentStartup: 'wait-for-setup',
      commandSource: 'run-both',
      setupScript: 'make deps',
      archiveScript: 'make clean'
    })) as RepoDetails
    const expected: ProjectSettings = {
      defaultBase: 'origin/develop',
      worktreeLocation: '../api-ws',
      setupPolicy: 'ask',
      agentStartup: 'wait-for-setup',
      commandSource: 'run-both',
      setupScript: 'make deps',
      archiveScript: 'make clean'
    }
    expect(set.settings).toEqual(expected)
    const shown = await show(client, repo.id)
    expect(shown).toEqual(set)
    expect(shown.repo.displayName).toBe('API')
    expect(shown.hooks.setup).toMatchObject({ text: 'make deps', source: 'local', badge: 'local settings', shared: null })
    expect(shown.hooks.agentStartup).toBe('wait-for-setup')
    expect((await list(client))[0]!.displayName).toBe('API')

    const cleared = (await call(client, 'quirky.repo/set', { repo: repo.id, displayName: '', defaultBase: '', worktreeLocation: '', setupScript: '', archiveScript: '' })) as RepoDetails
    expect(cleared.settings).toEqual({ ...expected, defaultBase: null, worktreeLocation: null, setupScript: '', archiveScript: '' })
    expect(cleared.repo.displayName).toBeNull()
    expect(cleared.hooks.setup).toBeNull()
  })

  test('an empty string returns agentStartup and commandSource to inherited', async () => {
    const { client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    const set = (await call(client, 'quirky.repo/set', { repo: repo.id, agentStartup: 'wait-for-setup', commandSource: 'run-both' })) as RepoDetails
    expect(set.settings).toMatchObject({ agentStartup: 'wait-for-setup', commandSource: 'run-both' })
    const cleared = (await call(client, 'quirky.repo/set', { repo: repo.id, agentStartup: '', commandSource: '' })) as RepoDetails
    expect(cleared.settings).toMatchObject({ agentStartup: null, commandSource: null })
    expect(cleared.hooks.agentStartup).toBe('start-immediately')
    expect(((await show(client, repo.id)).settings)).toMatchObject({ agentStartup: null, commandSource: null })
  })

  test('a set with only some fields keeps the rest', async () => {
    const { client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    await call(client, 'quirky.repo/set', { repo: repo.id, defaultBase: 'main' })
    const next = (await call(client, 'quirky.repo/set', { repo: repo.id, setupPolicy: 'skip-by-default' })) as RepoDetails
    expect(next.settings).toMatchObject({ defaultBase: 'main', setupPolicy: 'skip-by-default' })
  })

  test('settings survive a restart', async () => {
    const { t, client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    await call(client, 'quirky.repo/set', { repo: repo.id, displayName: 'Persisted', commandSource: 'local-only' })
    const next = await t.restart()
    const after = (await call(next.client, 'quirky.repo/show', { repo: repo.id })) as RepoDetails
    expect(after.repo.displayName).toBe('Persisted')
    expect(after.settings.commandSource).toBe('local-only')
  })

  test('enums are validated by the schema, and show/hooks are read-only', async () => {
    const { client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    expect((await failure(call(client, 'quirky.repo/set', { repo: repo.id, setupPolicy: 'sometimes' }))).code).toBe(RpcErrorCode.InvalidParams)
    const catalog = (await call(client, 'api.describe')) as { methods: { name: string; readOnly?: boolean }[] }
    const byName = new Map(catalog.methods.map((m) => [m.name, m]))
    for (const name of ['show', 'hooks', 'scan', 'groupList']) expect(byName.get(`quirky.repo/${name}`)?.readOnly).toBe(true)
    for (const name of ['set', 'trustHooks', 'clone', 'create', 'import', 'groupCreate']) expect(byName.get(`quirky.repo/${name}`)?.readOnly).toBeUndefined()
  })
})

describe('SC-34 and SC-35: hooks from the repo', () => {
  const hooks = (client: QuirkyClient, repo: string, ref?: string) =>
    call(client, 'quirky.repo/hooks', { repo, ...(ref ? { ref } : {}) }) as Promise<EffectiveHooks>

  test('SC-34: orca.yaml is read until a quirky.yaml appears, and show reports warnings', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'orca.yaml': 'scripts:\n  setup: from-orca\nissueCommand: gh\ncolour: red\n' })
    const repo = await add(client, dir)
    const first = await show(client, repo.id)
    expect(first.hooks.file).toBe('orca.yaml')
    expect(first.hooks.setup).toMatchObject({ text: 'from-orca', source: 'shared', badge: 'orca.yaml' })
    expect(first.hooks.warnings).toEqual(['issueCommand is recognised but not supported yet', 'unrecognised key colour'])

    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: from-quirky\n' })
    const second = await show(client, repo.id)
    expect(second.hooks).toMatchObject({ file: 'quirky.yaml', warnings: [] })
    expect(second.hooks.setup?.text).toBe('from-quirky')
  })

  test('hooks reads the file at a ref, defaulting to HEAD, and uncommitted files do not count', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: one\n' })
    const repo = await add(client, dir)
    const first = git(dir, 'rev-parse', 'HEAD')
    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: two\n' })
    writeFileSync(join(dir, 'quirky.yaml'), 'scripts:\n  setup: dirty\n')
    expect((await hooks(client, repo.id)).setup?.text).toBe('two')
    expect((await hooks(client, repo.id, first)).setup?.text).toBe('one')
  })

  test('hooks refuses a ref that starts with a dash and one that names no commit', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: one\n' })
    const repo = await add(client, dir)
    const out = join(home, 'leaked')
    for (const ref of [`--output=${out}`, '-p']) {
      const err = await failure(hooks(client, repo.id, ref))
      expect(err.code).toBe(RpcErrorCode.InvalidParams)
      expect(err.data.reason).toBe('invalid-ref')
    }
    expect(existsSync(out)).toBe(false)
    const unknown = await failure(hooks(client, repo.id, 'no-such-ref'))
    expect(unknown.code).toBe(RpcErrorCode.InvalidParams)
    expect(unknown.message).toBe('unknown ref no-such-ref')
    expect((await hooks(client, repo.id, 'main')).setup?.text).toBe('one')
  })

  test('a repo with no commits has no hooks', async () => {
    const { client, home } = await start()
    const created = (await call(client, 'quirky.repo/create', { name: 'empty', location: home })) as Repo
    expect((await hooks(client, created.id)).file).toBeNull()
  })

  test('SC-35: unset policy follows the local script, then shared-only, then run-both', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: echo shared >> order.txt\n' })
    const repo = await add(client, dir)
    await call(client, 'quirky.repo/set', { repo: repo.id, setupScript: 'echo local >> order.txt' })
    expect((await hooks(client, repo.id)).setup?.text).toBe('echo local >> order.txt')
    await call(client, 'quirky.repo/set', { repo: repo.id, commandSource: 'shared-only' })
    expect((await hooks(client, repo.id)).setup?.text).toBe('echo shared >> order.txt')
    await call(client, 'quirky.repo/set', { repo: repo.id, commandSource: 'run-both' })
    expect((await hooks(client, repo.id)).setup?.text).toBe('echo shared >> order.txt\necho local >> order.txt')
  })

  test('SC-32 repo half: trustHooks stores the hash, and a changed script is untrusted again', async () => {
    const { client, home } = await start()
    const dir = makeRepo(join(home, 'api'), { 'quirky.yaml': 'scripts:\n  setup: touch ran.txt\n  archive: touch gone.txt\n' })
    const repo = await add(client, dir)
    const before = await hooks(client, repo.id)
    expect(before.setup?.shared).toMatchObject({ trusted: false, changed: false })

    const trusted = (await call(client, 'quirky.repo/trustHooks', { repo: repo.id, kind: 'setup' })) as RepoDetails
    expect(trusted.hooks.setup?.shared).toMatchObject({ trusted: true, changed: false })
    expect(trusted.hooks.archive?.shared).toMatchObject({ trusted: false })

    commitFiles(dir, { 'quirky.yaml': 'scripts:\n  setup: touch other.txt\n  archive: touch gone.txt\n' })
    expect((await hooks(client, repo.id)).setup?.shared).toMatchObject({ trusted: false, changed: true })

    const all = (await call(client, 'quirky.repo/trustHooks', { repo: repo.id })) as RepoDetails
    expect(all.hooks.setup?.shared).toMatchObject({ trusted: true, changed: false })
    expect(all.hooks.archive?.shared).toMatchObject({ trusted: true })
  })
})

describe('selectors and errors', () => {
  test('name: and bare names also match the display name', async () => {
    const { client, home } = await start()
    const repo = await add(client, makeRepo(join(home, 'api')))
    await call(client, 'quirky.repo/set', { repo: repo.id, displayName: 'Backend API' })
    for (const selector of ['name:Backend API', 'Backend API', 'name:api', 'api']) {
      expect(((await call(client, 'quirky.repo/resolve', { selector })) as Repo).id).toBe(repo.id)
    }
  })

  test('an unknown repo is not-found for every method that takes one', async () => {
    const { client } = await start()
    for (const [method, params] of [
      ['show', {}],
      ['set', {}],
      ['hooks', {}],
      ['trustHooks', {}],
      ['remove', {}]
    ] as const) {
      expect((await failure(call(client, `quirky.repo/${method}`, { repo: 'nope', ...params }))).code).toBe(RpcErrorCode.NotFound)
    }
  })
})
