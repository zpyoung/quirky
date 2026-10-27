import { afterEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type QuirkyEvent, type Repo, type Worktree, type WorktreeCreateResult } from '@quirky/protocol'
import { GitError } from '@quirky/git'
import { makeTempDir } from '../../../packages/daemon/test/plugins/fixtures'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { expandHome } from '../paths'
import { fakeAsks } from '../../quirky.repo/test/fakes/quirky.ask/main'
import { startPluginHarness, type PluginHarness } from '../../quirky.repo/test/harness'
import { addFakeRepo, fakeRegistrations } from './fixtures/fake-git'

isolateGitConfig()
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
  fakeRegistrations(t.git!)
  const alpha = addFakeRepo(t.git!, 'alpha')
  const root = realpathSync(makeTempDir('qw-'))
  await call(t.client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  const watcher = await t.h.connectWithEvents('cli')
  const repo = (await call(t.client, 'quirky.repo/add', { path: alpha })) as Repo
  return { t, client: t.client, events: watcher.events, root, repo, alpha }
}

/** Creates a worktree and returns its record (the create result's `worktree`). */
const createWt = async (client: QuirkyClient, params: Record<string, unknown>) =>
  ((await call(client, 'quirky.worktree/create', params)) as WorktreeCreateResult).worktree

const list = async (client: QuirkyClient, repo?: string) =>
  (await call(client, 'quirky.worktree/list', repo ? { repo } : {})) as Worktree[]

describe('quirky.worktree list', () => {
  test('gives stable ids and marks the main worktree', async () => {
    const { client, repo, alpha } = await start()
    const [main] = await list(client, repo.id)
    const expectedId = `wt_${createHash('sha1').update(alpha).digest('hex').slice(0, 12)}`
    expect(main).toMatchObject({ id: expectedId, repoId: repo.id, isMain: true, name: 'main', branch: 'main' })
    expect(await list(client)).toHaveLength(1)
  })

  test('the repo param is a selector', async () => {
    const { client, repo, alpha } = await start()
    expect(await list(client, 'name:alpha')).toHaveLength(1)
    expect(await list(client, `path:${alpha}`)).toHaveLength(1)
    expect((await failure(call(client, 'quirky.worktree/list', { repo: 'name:nope' }))).code).toBe(RpcErrorCode.NotFound)
    expect(repo.id).toBeTruthy()
  })

  test('a repo that git cannot list is skipped in the full list and an Internal error for its own', async () => {
    const { t, client, repo, alpha } = await start()
    t.git!.worktreesByRepo.delete(alpha)
    expect(await list(client)).toEqual([])
    expect((await failure(call(client, 'quirky.worktree/list', { repo: repo.id }))).code).toBe(RpcErrorCode.Internal)
  })
})

describe('quirky.worktree create', () => {
  test('sanitises the name and builds the path under the worktrees root', async () => {
    const { t, client, events, root, repo, alpha } = await start()
    // D10: a name is rewritten into a safe folder and branch name instead of being rejected; only an empty result is refused
    const sanitised: [string, string][] = [['-bad', 'bad'], ['a..b', 'a.b'], ['has space', 'has-space'], ['semi;colon', 'semi-colon']]
    for (const [name, expected] of sanitised) {
      expect((await createWt(client, { repo: repo.id, name })).path).toBe(join(root, 'alpha', expected))
    }
    expect((await failure(call(client, 'quirky.worktree/create', { repo: repo.id, name: '...' }))).code).toBe(RpcErrorCode.InvalidParams)

    const worktree = await createWt(client, { repo: repo.id, name: 'feat/login', base: 'develop' })
    expect(worktree).toMatchObject({
      path: join(root, 'alpha', 'feat-login'),
      // D10, D11: the name is sanitised for the folder and the branch; the fake git has no user, so no prefix
      branch: 'feat-login',
      isMain: false,
      repoId: repo.id,
      // D8: a non-primary worktree is named for its folder, not its branch
      name: 'feat-login',
      createdBy: 'api',
      baseRef: 'develop'
    })
    expect(t.git!.calls.find((c) => c.fn === 'addWorktree' && c.args[2] === 'feat-login')?.args).toEqual([
      alpha,
      join(root, 'alpha', 'feat-login'),
      'feat-login',
      'c'.repeat(40)
    ])
    const changed = await waitFor(() => events.find((e) => e.type === 'quirky.worktree/changed'))
    expect(changed).toMatchObject({ data: { repoId: repo.id } })
    expect(await list(client, repo.id)).toHaveLength(6)
  })

  test('a second repo with the same name gets its own directory under the root', async () => {
    const { t, client, root } = await start()
    const otherDir = addFakeRepo(t.git!, 'alpha')
    const other = (await call(client, 'quirky.repo/add', { path: otherDir })) as Repo
    const worktree = await createWt(client, { repo: other.id, name: 'feature' })
    const suffix = other.id.replace(/^repo_/, '').slice(0, 6)
    expect(worktree.path).toBe(join(root, `alpha-${suffix}`, 'feature'))
  })

  test('a repo with a unique name keeps the plain directory', async () => {
    const { client, root, repo } = await start()
    const worktree = await createWt(client, { repo: repo.id, name: 'feature' })
    expect(worktree.path).toBe(join(root, 'alpha', 'feature'))
  })
})

describe('SC-25: the worktrees root setting', () => {
  test('is declared with its title and default, and a leading ~ is expanded when read', async () => {
    const { client } = await start()
    const info = (await call(client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as Record<string, unknown>
    await call(client, 'setting.reset', { id: 'setting:quirky.worktree/worktreesRoot' })
    const reset = (await call(client, 'setting.get', { id: 'setting:quirky.worktree/worktreesRoot' })) as Record<string, unknown>
    expect(reset).toMatchObject({ type: 'string', title: 'Worktrees folder', default: '~/quirky/workspaces', value: '~/quirky/workspaces' })
    expect(info.id).toBe('setting:quirky.worktree/worktreesRoot')
    // creating under the real home would leave folders behind, so the expansion is checked on its own
    expect(expandHome(reset.value as string)).toBe(join(homedir(), 'quirky', 'workspaces'))
    expect(expandHome('~/wt')).toBe(join(homedir(), 'wt'))
  })

  test('a worktree is created under whatever the setting names', async () => {
    const { t, client, repo } = await start()
    const elsewhere = realpathSync(makeTempDir('qw-'))
    await call(client, 'setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: elsewhere })
    const worktree = await createWt(client, { repo: repo.id, name: 'again' })
    expect(worktree.path).toBe(join(elsewhere, 'alpha', 'again'))
    expect(t.git!.calls.some((c) => c.fn === 'addWorktree')).toBe(true)
  })
})

describe('quirky.worktree remove', () => {
  test('refuses the main worktree and closes sessions on a forced removal', async () => {
    const { t, client, repo, alpha } = await start()
    const [main] = await list(client, repo.id)
    expect((await failure(call(client, 'quirky.worktree/remove', { worktree: main!.id, yes: true }))).code).toBe(RpcErrorCode.Conflict)

    const worktree = await createWt(client, { repo: repo.id, name: 'tmp' })
    const session = (await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    expect(await call(client, 'quirky.worktree/remove', { worktree: worktree.id, force: true, yes: true })).toEqual({ ok: true, removed: [worktree.id] })
    expect(t.sessions.sessions).toEqual([])
    expect(t.sessions.closed).toEqual([session.id])
    expect(t.git!.calls.find((c) => c.fn === 'removeWorktree')?.args).toEqual([alpha, worktree.path, true])
    expect(await list(client, repo.id)).toHaveLength(1)
  })

  test('a change found before anything is stopped leaves the sessions running', async () => {
    const { t, client, repo } = await start()
    const worktree = await createWt(client, { repo: repo.id, name: 'dirty' })
    await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })
    t.git!.dirtyEntries = async () => ['notes.txt']
    const result = await failure(call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true }))
    expect(result.code).toBe(RpcErrorCode.Conflict)
    expect(result.message).toBe('Worktree has uncommitted or untracked changes.')
    expect(t.sessions.sessions).toHaveLength(1)
    expect(t.sessions.closed).toEqual([])
    expect(t.git!.calls.some((c) => c.fn === 'removeWorktree')).toBe(false)
  })

  test('a refusal by git itself is a Conflict with its message, after the sessions were closed (D42 order)', async () => {
    const { t, client, repo } = await start()
    const worktree = await createWt(client, { repo: repo.id, name: 'dirty' })
    const session = (await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    t.git!.removeWorktree = async () => {
      throw new GitError('git worktree failed', "fatal: 'x' contains modified or untracked files, use --force to delete it", 128)
    }
    const result = await failure(call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true }))
    expect(result.code).toBe(RpcErrorCode.Conflict)
    expect(result.message).toContain('could not remove dirty')
    expect(result.message).toContain('use --force')
    expect(t.sessions.closed).toEqual([session.id])
  })

  test('a clean removal closes the sessions and emits changed', async () => {
    const { t, client, events, repo } = await start()
    const worktree = await createWt(client, { repo: repo.id, name: 'clean' })
    await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })
    events.length = 0
    await call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true })
    expect(t.sessions.sessions).toEqual([])
    await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.worktree/changed'))
  })

  test('with force, a session that fails to close is reported and the removal goes ahead', async () => {
    const { t, client, events, repo } = await start()
    const worktree = await createWt(client, { repo: repo.id, name: 'stuck' })
    const first = (await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    const second = (await call(client, 'quirky.session/create', { worktree: worktree.id, agent: 'shell' })) as { id: string }
    // the fake reads closeError twice per close (check, then throw), so serve the message for the first close only
    let reads = 0
    Object.defineProperty(t.sessions, 'closeError', { configurable: true, get: () => (reads++ < 2 ? 'pty is wedged' : null) })
    events.length = 0
    let result: { ok: boolean; sessionErrors?: string[] }
    try {
      result = (await call(client, 'quirky.worktree/remove', { worktree: worktree.id, force: true, yes: true })) as typeof result
    } finally {
      // the shared fake state is reset by plain assignment, which a getter-only property would reject
      Object.defineProperty(t.sessions, 'closeError', { value: null, writable: true, configurable: true, enumerable: true })
    }
    expect(result.ok).toBe(true)
    expect(result.sessionErrors).toHaveLength(1)
    expect(result.sessionErrors![0]).toContain(first.id)
    expect(result.sessionErrors![0]).toContain('pty is wedged')
    expect(t.sessions.closed).toEqual([second.id])
    expect(t.git!.calls.some((c) => c.fn === 'removeWorktree')).toBe(true)
    await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.worktree/changed'))
  })

  test('works without quirky.session', async () => {
    const { client, repo } = await start({ fakeSession: false })
    const worktree = await createWt(client, { repo: repo.id, name: 'solo' })
    await call(client, 'quirky.worktree/remove', { worktree: worktree.id, yes: true })
    expect(await list(client, repo.id)).toHaveLength(1)
  })
})

describe('describeRemove and the confirmation', () => {
  test('SC-43: the confirm question names the worktree and its path; force says what it discards', async () => {
    const { client, repo } = await start({ fakeAsk: true })
    const worktree = await createWt(client, { repo: repo.id, name: 'feature-x' })
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
    expect(await call(client, 'quirky.worktree/remove', { worktree: 'feature-x', confirmation: data.askId })).toEqual({ ok: true, removed: [worktree.id] })
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
    const created = await createWt(client, { repo: repo.id, name: 'feature' })
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
