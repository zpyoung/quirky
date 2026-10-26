import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { QuirkyClient, RpcErrorCode, type QuirkyEvent } from '@quirky/protocol'
import { rpcUrl } from '@quirky/protocol/node'
import { startDaemon } from '../../src/daemon'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
const cleanups: (() => Promise<void> | void)[] = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  await h?.cleanup()
  h = null
  delete (globalThis as Record<string, unknown>).__runtimeStore
  delete (globalThis as Record<string, unknown>).__runtimeContext
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>

/** Starts a daemon with no built-in plugins and the given plugins installed under its home. */
async function boot(
  plugins: { manifest: Manifest; behavior?: ModuleBehavior }[] | ((marker: string) => { manifest: Manifest; behavior?: ModuleBehavior }[])
) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of typeof plugins === 'function' ? plugins(marker) : plugins) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const client = await harness.connect()
  return { harness, client, home, marker, lines: () => readMarker(marker) }
}

const call = (client: QuirkyClient, method: string, params: Record<string, unknown> = {}) => client.callAny(method, params)

async function rejection(promise: Promise<unknown>): Promise<{ code: number; message: string }> {
  try {
    await promise
  } catch (error) {
    return error as { code: number; message: string }
  }
  throw new Error('expected the call to reject')
}

const methods = (...names: string[]) => ({ method: names.map((id) => ({ id })) })

describe('plugin methods over RPC', () => {
  test('a plugin method answers and its lazy plugin activates on first use', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: methods('echo') },
        behavior: { activate: "context.provide('method:acme.x/echo', (params, caller) => ({ params, caller }))" }
      }
    ])
    expect(s.lines()).toEqual([])
    const result = await call(s.client, 'acme.x/echo', { a: 1 })
    expect(result).toEqual({ params: { a: 1 }, caller: { role: 'cli' } })
    expect(s.lines()).toEqual(['import acme.x', 'activate acme.x'])
  })

  test('an unknown plugin method is MethodNotFound and activates nothing', async () => {
    const s = await boot([{ manifest: { id: 'acme.x', contributes: methods('echo') } }])
    const error = await rejection(call(s.client, 'acme.x/nope'))
    expect(error).toMatchObject({ code: RpcErrorCode.MethodNotFound, message: 'unknown method: acme.x/nope' })
    expect(s.lines()).toEqual([])
  })

  test("context.error('not-found', ...) reaches the client as NotFound", async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: methods('lookup', 'bad', 'busy', 'plain') },
        behavior: {
          activate: `
            context.provide('method:acme.x/lookup', () => { throw context.error('not-found', 'no such thing') })
            context.provide('method:acme.x/bad', () => { throw context.error('invalid-params', 'nope') })
            context.provide('method:acme.x/busy', () => { throw context.error('conflict', 'busy') })
            context.provide('method:acme.x/plain', () => { throw context.error('other', 'boom') })`
        }
      }
    ])
    expect(await rejection(call(s.client, 'acme.x/lookup'))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no such thing'
    })
    expect((await rejection(call(s.client, 'acme.x/bad'))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await rejection(call(s.client, 'acme.x/busy'))).code).toBe(RpcErrorCode.Conflict)
    expect(await rejection(call(s.client, 'acme.x/plain'))).toMatchObject({
      code: RpcErrorCode.Internal,
      message: 'acme.x: boom'
    })
  })

  test('context.call reaches kernel methods and rejects params that are not an object', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: methods('repos', 'badparams', 'hello') },
        behavior: {
          activate: `
            context.provide('method:acme.x/repos', () => context.call('repo.list', {}))
            context.provide('method:acme.x/badparams', () => context.call('repo.list', 5))
            context.provide('method:acme.x/hello', () => context.call('client.hello', {}))`
        }
      }
    ])
    s.harness.git.addRepo('/fake/alpha')
    await s.client.call('repo.add', { path: '/fake/alpha' })
    const repos = (await call(s.client, 'acme.x/repos')) as { path: string }[]
    expect(repos.map((repo) => repo.path)).toEqual(['/fake/alpha'])
    expect(await rejection(call(s.client, 'acme.x/badparams'))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'params must be an object'
    })
    expect(await rejection(call(s.client, 'acme.x/hello'))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'client.hello needs a client connection'
    })
  })
})

describe('plugin events', () => {
  test('a declared event emitted from a method reaches subscribed clients', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: { method: [{ id: 'fire' }], event: [{ id: 'ping' }] } },
        behavior: { activate: "context.provide('method:acme.x/fire', () => context.emit('ping', { n: 1 }))" }
      }
    ])
    const { events } = await s.harness.connectWithEvents()
    expect(await call(s.client, 'acme.x/fire')).toBe(true)
    const event = await waitFor(() => events.find((candidate: QuirkyEvent) => candidate.type === 'acme.x/ping'))
    expect(event).toEqual({ type: 'acme.x/ping', data: { n: 1 } })
  })

  test('a startup plugin listener sees repo.changed after repo.add replies', async () => {
    const s = await boot((marker) => [
      {
        manifest: { id: 'acme.watch', activation: 'startup' },
        behavior: {
          activate: `
            context.subscribe((event) => {
              if (event.type === 'repo.changed') appendFileSync(${JSON.stringify(marker)}, 'saw repo.changed\\n')
            })`
        }
      }
    ])
    s.harness.git.addRepo('/fake/alpha')
    await s.client.call('repo.add', { path: '/fake/alpha' })
    await waitFor(() => s.lines().includes('saw repo.changed'))
  })
})

describe('plugin store', () => {
  const storePlugin = {
    manifest: { id: 'acme.x', contributes: methods('add', 'same', 'reopen') },
    behavior: {
      activate: `
        const store = context.openStore(['CREATE TABLE t (n INTEGER)'])
        globalThis.__runtimeStore = store
        context.provide('method:acme.x/add', () => {
          store.run('INSERT INTO t (n) VALUES (1)')
          return store.get('SELECT count(*) AS c FROM t')
        })
        context.provide('method:acme.x/same', () => context.openStore(['CREATE TABLE t (n INTEGER)']) === store)
        context.provide('method:acme.x/reopen', () => context.openStore([]))`
    }
  }

  test('openStore works from a method and its data survives a daemon restart', async () => {
    const s = await boot([storePlugin])
    expect(await call(s.client, 'acme.x/add')).toEqual({ c: 1 })
    expect(await call(s.client, 'acme.x/same')).toBe(true)
    expect(await rejection(call(s.client, 'acme.x/reopen'))).toMatchObject({
      message: 'acme.x: acme.x already opened its store with 1 migrations'
    })

    await s.harness.daemon.stop()
    const second = await startDaemon({
      home: s.home,
      port: 0,
      git: s.harness.git,
      shell: '/bin/zsh',
      notifier: () => {},
      uiDir: '/none',
      builtinPluginsDir: null
    })
    cleanups.push(() => second.stop())
    const next = await QuirkyClient.connect(rpcUrl(second.runtime), { role: 'cli' })
    cleanups.push(() => next.close())
    expect(await call(next, 'acme.x/add')).toEqual({ c: 2 })
  })

  test('disabling a plugin closes its store', async () => {
    const s = await boot([storePlugin])
    await call(s.client, 'acme.x/add')
    const store = (globalThis as Record<string, any>).__runtimeStore
    expect(store.version).toBe(1)
    await s.client.call('plugin.disable', { id: 'acme.x' })
    expect(() => store.version).toThrow('acme.x is no longer active')
  })

  test('a saved store is writable inside deactivate and throws once the disable completes', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: methods('rows') },
        behavior: {
          activate: `
            const store = context.openStore(['CREATE TABLE t (n INTEGER)'])
            globalThis.__runtimeStore = store
            globalThis.__runtimeContext = context
            context.provide('method:acme.x/rows', () => store.all('SELECT n FROM t'))`,
          deactivate: `globalThis.__runtimeStore.run('INSERT INTO t (n) VALUES (42)')`
        }
      }
    ])
    expect(await call(s.client, 'acme.x/rows')).toEqual([])
    const globals = globalThis as Record<string, any>
    const { __runtimeStore: store, __runtimeContext: context } = globals

    await s.client.call('plugin.disable', { id: 'acme.x' })
    expect(s.lines()).toContain('deactivate acme.x')
    expect(() => store.version).toThrow('acme.x is no longer active')
    expect(() => store.run('INSERT INTO t (n) VALUES (1)')).toThrow('acme.x is no longer active')
    expect(() => context.emit('ping', {})).toThrow('acme.x is no longer active')
    expect(() => context.openStore([])).toThrow('acme.x is no longer active')
    expect(s.lines().filter((line) => line.startsWith('deactivate'))).toEqual(['deactivate acme.x'])

    await s.client.call('plugin.enable', { id: 'acme.x' })
    expect(await call(s.client, 'acme.x/rows')).toEqual([{ n: 42 }])
  })
})

describe('jobs', () => {
  test('job.list lists a declared job and job.run runs it', async () => {
    const s = await boot((marker) => [
      {
        manifest: { id: 'acme.x', contributes: { job: [{ id: 'tick', interval: '1h' }] } },
        behavior: {
          activate: `context.provide('job:acme.x/tick', () => { appendFileSync(${JSON.stringify(marker)}, 'tick\\n') })`
        }
      }
    ])
    const jobs = await s.client.call('job.list', {})
    expect(jobs).toMatchObject([{ id: 'job:acme.x/tick', plugin: 'acme.x', intervalMs: 3_600_000, state: 'idle', lastRun: null }])
    expect(await s.client.call('job.run', { id: 'job:acme.x/tick' })).toMatchObject({ status: 'ok' })
    expect(s.lines()).toContain('tick')
    const [job] = await s.client.call('job.list', {})
    expect(job!.lastRun).toMatchObject({ status: 'ok' })
    expect((await rejection(call(s.client, 'job.run', { id: 'job:acme.x/none' }))).code).toBe(RpcErrorCode.NotFound)
  })
})

describe('launch hooks', () => {
  test('a hook env and args reach the PTY create request for a claude session', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.x', contributes: { 'launch-hook': [{ id: 'extra', agents: ['claude'] }] } },
        behavior: {
          activate: `context.provide('launch-hook:acme.x/extra', (launch) => ({
            env: { ACME_FLAG: '1', ACME_SESSION: launch.sessionId },
            args: ['--acme', 'x y']
          }))`
        }
      }
    ])
    s.harness.git.addRepo('/fake/alpha')
    const repo = await s.client.call('repo.add', { path: '/fake/alpha' })
    const [worktree] = await s.client.call('worktree.list', { repoId: repo.id })
    const session = await s.client.call('session.create', { worktreeId: worktree!.id, agent: 'claude', prompt: 'go' })
    const request = s.harness.pty.requests.find((r) => r.type === 'create' && r.sessionId === session.id)
    if (!request || request.type !== 'create') throw new Error('no create request')
    expect(request.env.ACME_FLAG).toBe('1')
    expect(request.env.ACME_SESSION).toBe(session.id)
    expect(request.argv[3]).toContain(`'--acme' 'x y' 'go'`)

    const shell = await s.client.call('session.create', { worktreeId: worktree!.id, agent: 'shell' })
    const shellRequest = s.harness.pty.requests.find((r) => r.type === 'create' && r.sessionId === shell.id)
    if (!shellRequest || shellRequest.type !== 'create') throw new Error('no create request')
    expect(shellRequest.env.ACME_FLAG).toBeUndefined()
  })
})
