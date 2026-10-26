import { afterEach, describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RpcError, RpcErrorCode, type QuirkyClient, type QuirkyEvent, type Repo } from '@quirky/protocol'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { startPluginHarness, type PluginHarness } from './harness'

let t: PluginHarness | undefined
afterEach(async () => {
  await t?.cleanup()
  t = undefined
})

async function start(options: Parameters<typeof startPluginHarness>[0] = {}) {
  t = await startPluginHarness(options)
  t.git?.addRepo('/fake/alpha')
  const watcher = await t.h.connectWithEvents('cli')
  return { t, client: watcher.client, events: watcher.events }
}

async function failure(promise: Promise<unknown>): Promise<{ code: number; message: string; data: unknown }> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: rpc.data }
  }
  throw new Error('expected the call to fail')
}

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

describe('quirky.repo methods', () => {
  test('add resolves the toplevel, returns the existing repo on a second add and emits changed', async () => {
    const { client, events } = await start()
    const repo = (await call(client, 'quirky.repo/add', { path: '/fake/alpha/src/deep' })) as Repo
    expect(repo).toMatchObject({ name: 'alpha', path: '/fake/alpha' })
    expect(repo.id).toMatch(/^repo_[0-9a-f]+$/)
    const again = (await call(client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    expect(again.id).toBe(repo.id)
    expect(await call(client, 'quirky.repo/list')).toHaveLength(1)
    const changed = await waitFor(() => events.find((e: QuirkyEvent) => e.type === 'quirky.repo/changed'))
    expect(changed).toMatchObject({ type: 'quirky.repo/changed' })
    expect(events.filter((e) => e.type === 'quirky.repo/changed')).toHaveLength(1)
  })

  test('add rejects a path outside any repo', async () => {
    const { client } = await start()
    expect((await failure(call(client, 'quirky.repo/add', { path: '/nowhere' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a leading ~ is expanded before git sees the path', async () => {
    const { t, client } = await start()
    t.git!.addRepo(join(homedir(), 'proj'))
    const repo = (await call(client, 'quirky.repo/add', { path: '~/proj' })) as Repo
    expect(repo.path).toBe(join(homedir(), 'proj'))
  })

  test('remove forgets the repo and emits changed; removing it again is NotFound', async () => {
    const { client, events } = await start()
    const repo = (await call(client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    events.length = 0
    expect(await call(client, 'quirky.repo/remove', { repo: repo.id })).toEqual({ ok: true })
    expect(await call(client, 'quirky.repo/list')).toEqual([])
    await waitFor(() => events.find((e) => e.type === 'quirky.repo/changed'))
    expect((await failure(call(client, 'quirky.repo/remove', { repo: repo.id }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('SC-17: list and resolve are declared read-only, add and remove are not', async () => {
    const { client } = await start()
    const catalog = (await call(client, 'api.describe')) as { methods: { name: string; readOnly?: boolean }[] }
    const byName = new Map(catalog.methods.map((m) => [m.name, m]))
    expect(byName.get('quirky.repo/list')?.readOnly).toBe(true)
    expect(byName.get('quirky.repo/resolve')?.readOnly).toBe(true)
    expect(byName.get('quirky.repo/add')?.readOnly).toBeUndefined()
    expect(byName.get('quirky.repo/remove')?.readOnly).toBeUndefined()
  })
})

describe('SC-10: repo selectors', () => {
  async function twoRepos() {
    const started = await start()
    started.t.git!.addRepo('/fake/one/app')
    started.t.git!.addRepo('/fake/two/app')
    const one = (await call(started.client, 'quirky.repo/add', { path: '/fake/one/app' })) as Repo
    const two = (await call(started.client, 'quirky.repo/add', { path: '/fake/two/app' })) as Repo
    const alpha = (await call(started.client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    return { ...started, one, two, alpha }
  }

  test('every form resolves to the repo', async () => {
    const { client, alpha } = await twoRepos()
    const resolve = async (selector: string) => ((await call(client, 'quirky.repo/resolve', { selector })) as Repo).id
    expect(await resolve(`id:${alpha.id}`)).toBe(alpha.id)
    expect(await resolve(alpha.id)).toBe(alpha.id)
    expect(await resolve('name:alpha')).toBe(alpha.id)
    expect(await resolve('alpha')).toBe(alpha.id)
    expect(await resolve('path:/fake/alpha')).toBe(alpha.id)
    expect(await resolve('path:/fake/alpha/src/deep')).toBe(alpha.id)
  })

  test('no match is NotFound naming the selector and the forms', async () => {
    const { client } = await twoRepos()
    expect(await failure(call(client, 'quirky.repo/resolve', { selector: 'name:nope' }))).toEqual({
      code: RpcErrorCode.NotFound,
      message: 'no repo matches name:nope; use id:, name: or path:',
      data: undefined
    })
    expect((await failure(call(client, 'quirky.repo/resolve', { selector: 'path:/elsewhere' }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('several matches are a Conflict listing id selectors', async () => {
    const { client, one, two } = await twoRepos()
    const result = await failure(call(client, 'quirky.repo/resolve', { selector: 'app' }))
    expect(result.code).toBe(RpcErrorCode.Conflict)
    const matches = (result.data as { matches: string[] }).matches
    expect([...matches].sort()).toEqual([`id:${one.id}`, `id:${two.id}`].sort())
    expect(result.message).toBe(`app matches 2 repos: ${matches.join(', ')}`)
  })

  test('an empty selector is InvalidParams', async () => {
    const { client } = await twoRepos()
    expect((await failure(call(client, 'quirky.repo/resolve', { selector: '' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call(client, 'quirky.repo/resolve', { selector: 'name:' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await failure(call(client, 'quirky.repo/resolve', { selector: 'path:relative/dir' }))).code).toBe(RpcErrorCode.InvalidParams)
  })

  test('remove takes a selector', async () => {
    const { client, one, two } = await twoRepos()
    await call(client, 'quirky.repo/remove', { repo: `path:/fake/two/app` })
    expect((await call(client, 'quirky.repo/list') as Repo[]).map((r) => r.id)).toContain(one.id)
    expect((await call(client, 'quirky.repo/list') as Repo[]).map((r) => r.id)).not.toContain(two.id)
  })
})

describe('remove closes the repo sessions', () => {
  async function seeded() {
    const started = await start()
    started.t.git!.addRepo('/fake/beta')
    const alpha = (await call(started.client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    const beta = (await call(started.client, 'quirky.repo/add', { path: '/fake/beta' })) as Repo
    const worktrees = async (repo: Repo) => (await call(started.client, 'quirky.worktree/list', { repo: repo.id })) as { id: string }[]
    const [alphaMain] = await worktrees(alpha)
    const [betaMain] = await worktrees(beta)
    const extra = (await call(started.client, 'quirky.worktree/create', { repo: alpha.id, name: 'extra' })) as { id: string }
    const closing = [
      await call(started.client, 'quirky.session/create', { worktree: alphaMain!.id, agent: 'shell' }),
      await call(started.client, 'quirky.session/create', { worktree: extra.id, agent: 'shell' })
    ] as { id: string }[]
    const staying = (await call(started.client, 'quirky.session/create', { worktree: betaMain!.id, agent: 'shell' })) as { id: string }
    return { ...started, alpha, beta, closing, staying }
  }

  test('only the sessions of the removed repo are closed', async () => {
    const { t, client, alpha, closing, staying } = await seeded()
    await call(client, 'quirky.repo/remove', { repo: alpha.id })
    expect(t.sessions.sessions.map((s) => s.id)).toEqual([staying.id])
    expect([...t.sessions.closed].sort()).toEqual(closing.map((s) => s.id).sort())
    expect(await call(client, 'quirky.repo/list')).toHaveLength(1)
  })

  test('sessions still close when git can no longer list the repo worktrees', async () => {
    const { t, client, alpha, closing, staying } = await seeded()
    t.git!.worktreesByRepo.delete('/fake/alpha')
    await call(client, 'quirky.repo/remove', { repo: alpha.id })
    expect(t.sessions.sessions.map((s) => s.id)).toEqual([staying.id])
    expect([...t.sessions.closed].sort()).toEqual(closing.map((s) => s.id).sort())
  })

  test('a same-named repo keeps its sessions', async () => {
    const { t, client } = await start()
    t.git!.addRepo('/fake/one/app')
    t.git!.addRepo('/fake/two/app')
    const one = (await call(client, 'quirky.repo/add', { path: '/fake/one/app' })) as Repo
    const two = (await call(client, 'quirky.repo/add', { path: '/fake/two/app' })) as Repo
    const mainOf = async (repo: Repo) => ((await call(client, 'quirky.worktree/list', { repo: repo.id })) as { id: string }[])[0]!
    const featureOf = async (repo: Repo) => (await call(client, 'quirky.worktree/create', { repo: repo.id, name: 'feature' })) as { id: string }
    const closing = [
      await call(client, 'quirky.session/create', { worktree: (await mainOf(one)).id, agent: 'shell' }),
      await call(client, 'quirky.session/create', { worktree: (await featureOf(one)).id, agent: 'shell' })
    ] as { id: string }[]
    const staying = [
      await call(client, 'quirky.session/create', { worktree: (await mainOf(two)).id, agent: 'shell' }),
      await call(client, 'quirky.session/create', { worktree: (await featureOf(two)).id, agent: 'shell' })
    ] as { id: string }[]

    await call(client, 'quirky.repo/remove', { repo: one.id })
    expect(t.sessions.sessions.map((s) => s.id).sort()).toEqual(staying.map((s) => s.id).sort())
    expect([...t.sessions.closed].sort()).toEqual(closing.map((s) => s.id).sort())
  })

  test('a session in an externally created worktree closes with its repo after the directory is gone', async () => {
    const { t, client } = await start()
    const alpha = (await call(client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    t.git!.worktreesByRepo.get('/fake/alpha')!.push({ path: '/fake/elsewhere/hand-made', branch: 'hand-made', head: 'c'.repeat(40), isMain: false })
    const listed = (await call(client, 'quirky.worktree/list', { repo: alpha.id })) as { id: string; name: string }[]
    const external = listed.find((w) => w.name === 'hand-made')!
    const session = (await call(client, 'quirky.session/create', { worktree: external.id, agent: 'shell' })) as { id: string }
    t.git!.worktreesByRepo.delete('/fake/alpha')

    await call(client, 'quirky.repo/remove', { repo: alpha.id })
    expect(t.sessions.closed).toEqual([session.id])
  })

  test('a failed close keeps the repo so removal can be retried', async () => {
    const { t, client, alpha, closing } = await seeded()
    t.sessions.closeError = 'pty host unavailable'
    await failure(call(client, 'quirky.repo/remove', { repo: alpha.id }))
    expect(await call(client, 'quirky.repo/list')).toHaveLength(2)
    expect(t.sessions.sessions).toHaveLength(closing.length + 1)

    t.sessions.closeError = null
    await call(client, 'quirky.repo/remove', { repo: alpha.id })
    expect(await call(client, 'quirky.repo/list')).toHaveLength(1)
    expect(t.sessions.sessions).toHaveLength(1)
  })

  test('without quirky.session the repo is removed with nothing to close', async () => {
    const { client } = await start({ fakeSession: false })
    const repo = (await call(client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    await call(client, 'quirky.repo/remove', { repo: repo.id })
    expect(await call(client, 'quirky.repo/list')).toEqual([])
  })

  test('without quirky.worktree the repo is removed with nothing to close', async () => {
    const { client } = await start({ plugins: ['quirky.repo'] })
    const repo = (await call(client, 'quirky.repo/add', { path: '/fake/alpha' })) as Repo
    await call(client, 'quirky.repo/remove', { repo: repo.id })
    expect(await call(client, 'quirky.repo/list')).toEqual([])
  })
})
