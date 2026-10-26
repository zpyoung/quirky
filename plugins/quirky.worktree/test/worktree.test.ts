import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type QuirkyEvent, type Repo, type Worktree } from '@quirky/protocol'
import { GitError } from '@quirky/git'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { fakeAsks } from '../../quirky.repo/test/fakes/quirky.ask/main'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string; data: unknown }> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: rpc.data }
  }
  throw new Error('expected the call to fail')
}

async function start(options: Parameters<typeof startPluginHarness>[0] = {}) {
  t = await startPluginHarness(options)
  t.git?.addRepo('/fake/alpha')
  const root = realpathSync(makeTempDir('qw-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const watcher = await t.h.connectWithEvents('cli')
  const repo = (await call(t.client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
  return { t, client: t.client, events: watcher.events, root, repo }
}

const list = async (client: QuirkyClient, repo?: string) =>
  (await call(client, 'quirky.worktree/list', repo ? { repo } : {})) as Worktree[]

describe('quirky.worktree list', () => {
  test('gives stable ids and marks the main worktree', async () => {
    const { client, repo } = await start()
    const [main] = await list(client, repo.id)
    const expectedId = `wt_${createHash('sha1').update('/fake/alpha').digest('hex').slice(0, 12)}`
    expect(main).toMatchObject({ id: expectedId, repoId: repo.id, isMain: true, name: 'main', branch: 'main' })
    expect(await list(client)).toHaveLength(1)
  })

  test('the repo param is a selector', async () => {
    const { client, repo } = await start()
    expect(await list(client, 'name:alpha')).toHaveLength(1)
    expect(await list(client, 'path:/fake/alpha')).toHaveLength(1)
    expect((await failure(call(client, 'quirky.worktree/list', { repo: 'name:nope' }))).code).toBe(RpcErrorCode.NotFound)
    expect(repo.id).toBeTruthy()
  })

  test('a repo that git cannot list is skipped in the full list and an Internal error for its own', async () => {
    const { t, client, repo } = await start()
    t.git!.worktreesByRepo.delete('/fake/alpha')
    expect(await list(client)).toEqual([])
    expect((await failure(call(client, 'quirky.worktree/list', { repo: repo.id }))).code).toBe(RpcErrorCode.Internal)
  })
})

describe('quirky.worktree create', () => {
  test('validates the name and builds the path under the worktrees root', async () => {
    const { t, client, events, root, repo } = await start()
    for (const name of ['-bad', 'a..b', 'has space', '', 'semi;colon']) {
      expect((await failure(call(client, 'quirky.worktree/create', { repo: repo.id, name }))).code).toBe(RpcErrorCode.InvalidParams)
    }
    const worktree = (await call(client, 'quirky.worktree/create', {
      repo: repo.id,
      name: 'feat/login',
      baseRef: 'develop'
    })) as Worktree
    expect(worktree).toMatchObject({
      path: join(root, 'alpha', 'feat-login'),
      branch: 'feat/login',
      isMain: false,
      repoId: repo.id
    })
    expect(t.git!.calls.find((c) => c.fn === 'addWorktree')?.args).toEqual([
      '/fake/alpha',
      join(root, 'alpha', 'feat-login'),
      'feat/login',
      'develop'
    ])
    const changed = await waitFor(() => events.find((e) => e.type === 'quirky.worktree/changed'))
    expect(changed).toMatchObject({ data: { repoId: repo.id } })
    expect(await list(client, repo.id)).toHaveLength(2)
  })

  test('a second repo with the same name gets its own directory under the root', async () => {
    const { t, client, root } = await start()
    t.git!.addRepo('/fake/one/alpha')
    const other = (await call(client, 'quirky.repo/add', { path: '/fake/one/alpha' })) as Repo
    const worktree = (await call(client, 'quirky.worktree/create', { repo: other.id, name: 'feature' })) as Worktree
    const suffix = other.id.replace(/^repo_/, '').slice(0, 6)
    expect(worktree.path).toBe(join(root, `alpha-${suffix}`, 'feature'))
  })

  test('a repo with a unique name keeps the plain directory', async () => {
    const { client, root, repo } = await start()
    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature' })) as Worktree
    expect(worktree.path).toBe(join(root, 'alpha', 'feature'))
  })
})

describe('SC-25: the worktrees root setting', () => {
  test('is declared with its title and default, and a leading ~ is expanded when read', async () => {
    const { t, client, repo } = await start()
    const info = (await call(client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as Record<string, unknown>
    await call(client, 'setting.reset', { id: 'setting:quirky.worktree/worktreesRoot' })
    const reset = (await call(client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as Record<string, unknown>
    expect(reset).toMatchObject({ type: 'string', title: 'Worktrees folder', default: '~/quirky/workspaces', value: '~/quirky/workspaces' })
    expect(info.id).toBe('setting:quirky.worktree/worktreesRoot')

    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'home' })) as Worktree
    expect(worktree.path).toBe(join(realpathSync(homedir()), 'quirky', 'workspaces', 'alpha', 'home'))
    expect(t.git!.calls.some((c) => c.fn === 'addWorktree')).toBe(true)

    await call(client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: '~/wt' })
    const second = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'again' })) as Worktree
    expect(second.path).toBe(join(realpathSync(homedir()), 'wt', 'alpha', 'again'))
  })
})

describe('quirky.worktree remove', () => {
  test('refuses the main worktree and closes sessions on a forced removal', async () => {
    const { t, client, repo } = await start()
    const [main] = await list(client, repo.id)
    expect((await failure(call(client, 'quirky.worktree/remove', { worktree: main!.id, yes: true }))).code).toBe(RpcErrorCode.Conflict)

    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'tmp' })) as Worktree
    const session = (await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    expect(await call(client, 'quirky.worktree/remove', { worktree: worktree.id, force: true, yes: true })).toEqual({ ok: true })
    expect(t.sessions.sessions).toEqual([])
    expect(t.sessions.closed).toEqual([session.id])
    expect(t.git!.calls.find((c) => c.fn === 'removeWorktree')?.args).toEqual(['/fake/alpha', worktree.path, true])
    expect(await list(client, repo.id)).toHaveLength(1)
  })

  test('leaves sessions alone when git refuses a non-forced removal', async () => {
    const { t, client, repo } = await start()
    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'dirty' })) as Worktree
    await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })
    t.git!.removeWorktree = async () => {
      throw new GitError('git worktree failed', "fatal: 'x' contains modified or untracked files, use --force to delete it", 128)
    }
    const result = await failure(call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true }))
    expect(result.code).toBe(RpcErrorCode.Conflict)
    expect(result.message).toContain('could not remove dirty')
    expect(t.sessions.sessions).toHaveLength(1)
    expect(t.sessions.closed).toEqual([])
  })

  test('a clean removal closes the sessions afterwards and emits changed', async () => {
    const { t, client, events, repo } = await start()
    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'clean' })) as Worktree
    await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })
    events.length = 0
    await call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true })
    expect(t.sessions.sessions).toEqual([])
    await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.worktree/changed'))
  })

  test('works without quirky.session', async () => {
    const { client, repo } = await start({ fakeSession: false })
    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'solo' })) as Worktree
    await call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true })
    expect(await list(client, repo.id)).toHaveLength(1)
  })
})

describe('describeRemove and the confirmation', () => {
  test('SC-43: the confirm question names the worktree and its path; force says what it discards', async () => {
    const { client, repo } = await start({ fakeAsk: true })
    const worktree = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })) as Worktree
    expect(await call(client, 'quirky.worktree/describeRemove', { worktree: 'name:feature-x' })).toBe(
      `Remove worktree feature-x (${worktree.path})?`
    )
    expect(await call(client, 'quirky.worktree/describeRemove', { worktree: 'feature-x', force: true })).toBe(
      `Remove worktree feature-x (${worktree.path}), discarding uncommitted changes?`
    )

    const asked = await failure(call(client, 'quirky.worktree/remove', { worktree: 'feature-x' }))
    expect(asked.code).toBe(RpcErrorCode.ConfirmationRequired)
    const data = asked.data as { askId: string; action: string }
    expect(data.action).toBe(`Remove worktree feature-x (${worktree.path})?`)
    expect(await list(client, repo.id)).toHaveLength(2)

    const ask = fakeAsks().get(data.askId)!
    ask.status = 'answered'
    ask.value = true
    expect(await call(client, 'quirky.worktree/remove', { worktree: 'feature-x', confirmation: data.askId })).toEqual({ ok: true })
    expect(await list(client, repo.id)).toHaveLength(1)
  })

  test('SC-45: a confirmation for one worktree does not remove another', async () => {
    const { client, repo } = await start({ fakeAsk: true })
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'fix-login' })
    const asked = await failure(call(client, 'quirky.worktree/remove', { worktree: 'feature-x' }))
    const askId = (asked.data as { askId: string }).askId
    fakeAsks().get(askId)!.status = 'answered'
    fakeAsks().get(askId)!.value = true

    const other = await failure(call(client, 'quirky.worktree/remove', { worktree: 'fix-login', confirmation: askId }))
    expect(other).toMatchObject({ code: RpcErrorCode.Conflict, message: 'confirmation is for another call' })

    t!.git!.removeWorktree = async () => {
      throw new GitError('git worktree failed', 'fatal: refused', 128)
    }
    await failure(call(client, 'quirky.worktree/remove', { worktree: 'feature-x', confirmation: askId }))
    const again = await failure(call(client, 'quirky.worktree/remove', { worktree: 'feature-x', confirmation: askId }))
    expect(again.message).toBe('confirmation already used')
  })

  test('SC-44: yes removes at once and opens no ask', async () => {
    const { client, repo } = await start({ fakeAsk: true })
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    await call(client, 'quirky.worktree/remove', { worktree: 'feature-x', yes: true })
    expect(fakeAsks().size).toBe(0)
    expect(await list(client, repo.id)).toHaveLength(1)
  })

  test('without quirky.ask a remove without yes says to pass --yes', async () => {
    const { client, repo } = await start()
    await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature-x' })
    const result = await failure(call(client, 'quirky.worktree/remove', { worktree: 'feature-x' }))
    expect(result).toMatchObject({ code: RpcErrorCode.Conflict, message: 'this action needs confirmation and asks are off; pass --yes' })
  })

  test('describeRemove for a missing worktree is NotFound', async () => {
    const { client } = await start()
    expect((await failure(call(client, 'quirky.worktree/describeRemove', { worktree: 'name:ghost' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('SC-17: remove is declared destructive, list, resolve and describeRemove read-only', async () => {
    const { client } = await start()
    const catalog = (await call(client, 'api.describe')) as {
      methods: { name: string; readOnly?: boolean; destructive?: boolean; confirm?: string }[]
    }
    const byName = new Map(catalog.methods.map((m) => [m.name, m]))
    expect(byName.get('quirky.worktree/remove')).toMatchObject({ destructive: true, confirm: 'Remove worktree {worktree}?' })
    for (const name of ['list', 'resolve', 'describeRemove']) expect(byName.get(`quirky.worktree/${name}`)?.readOnly).toBe(true)
    expect(byName.get('quirky.worktree/create')?.readOnly).toBeUndefined()
  })
})

describe('SC-17: quirky.worktree and quirky.repo as plugins', () => {
  test('the worktree plugin depends on the repo plugin, owns the wt alias and the section, and both list their commands', async () => {
    const { client } = await start()
    const plugins = (await call(client, 'plugin.list')) as { id: string; source: string; dependencies: string[]; cliAliases?: string[] }[]
    expect(plugins.find((p) => p.id === 'quirky.worktree')).toMatchObject({ source: 'builtin', dependencies: ['quirky.repo'], cliAliases: ['wt'] })
    expect(plugins.find((p) => p.id === 'quirky.repo')).toMatchObject({ source: 'builtin', dependencies: [] })

    const catalog = (await call(client, 'api.describe')) as { cli: { commands: { words: string; aliasWords: string[] }[] } }
    const words = catalog.cli.commands.map((c) => c.words)
    expect(words).toEqual(expect.arrayContaining(['repo add', 'repo list', 'repo rm', 'worktree list', 'worktree create', 'worktree rm']))
    expect(catalog.cli.commands.find((c) => c.words === 'worktree rm')?.aliasWords).toEqual(['wt rm'])

    const contributions = (await call(client, 'plugin.contributions', { kind: 'sidebar-section' })) as { id: string; data: Record<string, unknown> }[]
    expect(contributions.find((c) => c.id === 'sidebar-section:quirky.worktree/worktrees')?.data).toMatchObject({ title: 'Worktrees', order: 0 })
  })
})

describe('repo removal and worktree ownership', () => {
  const recordedFor = (home: string, repoId: string) => {
    const db = new Database(join(home, 'plugin-data', 'quirky.worktree', 'store.db'), { readonly: true })
    try {
      return (db.query('SELECT id FROM worktrees WHERE repo_id = ?').all(repoId) as { id: string }[]).map((row) => row.id)
    } finally {
      db.close()
    }
  }

  test('ownedIds lists the main worktree and the created ones; removing the repo forgets them', async () => {
    const { t, client, repo } = await start()
    const created = (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature' })) as Worktree
    const owned = (await call(client, 'quirky.worktree/ownedIds', { repo: repo.id })) as string[]
    expect(owned).toHaveLength(2)
    expect(owned).toContain(created.id)
    expect(recordedFor(t.h.home, repo.id).sort()).toEqual([...owned].sort())

    await call(client, 'quirky.repo/remove', { repo: repo.id })
    await waitForRows(() => recordedFor(t.h.home, repo.id).length === 0)
  })
})

async function waitForRows(check: () => boolean): Promise<void> {
  await waitFor(() => check() || undefined)
}
