import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient } from '@quirky/protocol'
import { makeTempHome, startHarness, type Harness } from '../helpers'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>
type Fixture = { manifest: Manifest; behavior?: ModuleBehavior }

/** Starts a daemon with no built-in plugins over the given installed plugins and connects a CLI client. */
async function boot(plugins: Fixture[] | ((marker: string) => Fixture[])) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of typeof plugins === 'function' ? plugins(marker) : plugins) {
    writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  }
  const harness = await startHarness({ home, builtinPluginsDir: null })
  h = harness
  const client = await harness.connect()
  return {
    harness,
    client,
    marker,
    lines: () => readMarker(marker),
    state: async (id: string) => (await client.call('plugin.list', {})).find((plugin) => plugin.id === id)!
  }
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

const refreshImpl = (marker: string) =>
  `context.provide('method:acme.tools/refresh', (params, caller) => {
    appendFileSync(${JSON.stringify(marker)}, 'caller ' + JSON.stringify(caller) + '\\n')
    return { refreshed: params.count }
  })`

describe('calling plugin methods', () => {
  test('SC-1: a client calls a plugin method, and a lazy plugin activates for it', async () => {
    const s = await boot((marker) => [
      { manifest: { id: 'acme.tools', contributes: methods('refresh') }, behavior: { activate: refreshImpl(marker) } }
    ])
    expect((await s.state('acme.tools')).state).toBe('inactive')
    expect(s.lines()).toEqual([])

    expect(await call(s.client, 'acme.tools/refresh', { count: 2 })).toEqual({ refreshed: 2 })

    expect((await s.state('acme.tools')).state).toBe('active')
    expect(s.lines()).toEqual(['import acme.tools', 'activate acme.tools', 'caller {"role":"cli"}'])
  })

  test('SC-2: an unknown or disabled plugin method is not found, and loads nothing', async () => {
    const s = await boot((marker) => [
      { manifest: { id: 'acme.tools', contributes: methods('refresh') }, behavior: { activate: refreshImpl(marker) } }
    ])
    await s.client.call('plugin.disable', { id: 'method:acme.tools/refresh' })

    expect(await rejection(call(s.client, 'acme.tools/refresh', { count: 2 }))).toMatchObject({
      code: RpcErrorCode.MethodNotFound,
      message: 'unknown method: acme.tools/refresh'
    })
    expect(await rejection(call(s.client, 'acme.tools/nope'))).toMatchObject({
      code: RpcErrorCode.MethodNotFound,
      message: 'unknown method: acme.tools/nope'
    })
    expect(s.lines()).toEqual([])
    expect((await s.state('acme.tools')).state).toBe('inactive')
  })

  test('SC-3: an overridden method runs the override', async () => {
    const s = await boot((marker) => [
      { manifest: { id: 'acme.tools', contributes: methods('refresh') }, behavior: { activate: refreshImpl(marker) } },
      {
        manifest: { id: 'acme.better', overrides: [{ id: 'method:acme.tools/refresh' }] },
        behavior: {
          activate: "context.provide('method:acme.tools/refresh', (params) => ({ refreshed: params.count, by: 'acme.better' }))"
        }
      }
    ])

    expect(await call(s.client, 'acme.tools/refresh', { count: 2 })).toEqual({ refreshed: 2, by: 'acme.better' })

    expect(s.lines()).toEqual(['import acme.better', 'activate acme.better'])
    expect((await s.state('acme.tools')).state).toBe('inactive')
    expect((await s.state('acme.better')).state).toBe('active')
  })

  test('SC-4: plugin errors reach the client with the right code', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.tools', contributes: methods('fail', 'ping') },
        behavior: {
          activate: `
            context.provide('method:acme.tools/fail', (params) => {
              if (params.kind === 'not-found') throw context.error('not-found', 'no widget w1')
              if (params.kind === 'invalid-params') throw context.error('invalid-params', 'count must be positive')
              if (params.kind === 'conflict') throw context.error('conflict', 'busy')
              throw new Error('boom')
            })
            context.provide('method:acme.tools/ping', () => 'pong')`
        }
      }
    ])

    expect(await rejection(call(s.client, 'acme.tools/fail', { kind: 'not-found' }))).toMatchObject({
      code: RpcErrorCode.NotFound,
      message: 'no widget w1'
    })
    expect(await rejection(call(s.client, 'acme.tools/fail', { kind: 'invalid-params' }))).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: 'count must be positive'
    })
    expect(await rejection(call(s.client, 'acme.tools/fail', { kind: 'conflict' }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'busy'
    })
    expect(await rejection(call(s.client, 'acme.tools/fail', { kind: 'plain' }))).toMatchObject({
      code: RpcErrorCode.Internal,
      message: 'acme.tools: boom'
    })
    expect(await call(s.client, 'acme.tools/ping')).toBe('pong')
    expect((await s.state('acme.tools')).state).toBe('active')
  })

  test('SC-5: a method whose plugin can\'t activate reports why', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.broken', contributes: methods('go') },
        behavior: { activate: "throw new Error('bad config')" }
      }
    ])

    expect(await rejection(call(s.client, 'acme.broken/go'))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'acme.broken failed to activate: bad config'
    })
    expect((await s.state('acme.broken')).state).toBe('failed')
  })

  test('SC-6: a plugin calls other methods through its context', async () => {
    const s = await boot((marker) => [
      { manifest: { id: 'acme.tools', contributes: methods('refresh') }, behavior: { activate: refreshImpl(marker) } },
      {
        manifest: { id: 'acme.caller', contributes: methods('relay', 'connection') },
        behavior: {
          activate: `
            context.provide('method:acme.caller/relay', async () => ({
              refreshed: await context.call('acme.tools/refresh', { count: 3 }),
              repos: await context.call('repo.list', {})
            }))
            context.provide('method:acme.caller/connection', async () => {
              const outcomes = {}
              for (const name of ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach']) {
                try {
                  await context.call(name, {})
                  outcomes[name] = 'resolved'
                } catch (error) {
                  outcomes[name] = { code: error.code, message: error.message }
                }
              }
              return outcomes
            })`
        }
      }
    ])
    s.harness.git.addRepo('/fake/alpha')
    const repo = await s.client.call('repo.add', { path: '/fake/alpha' })
    expect((await s.state('acme.tools')).state).toBe('inactive')

    const result = (await call(s.client, 'acme.caller/relay')) as { refreshed: unknown; repos: { id: string }[] }
    expect(result.refreshed).toEqual({ refreshed: 3 })
    expect(result.repos.map((entry) => entry.id)).toEqual([repo.id])
    expect((await s.state('acme.tools')).state).toBe('active')
    expect(s.lines()).toContain('caller {"role":"plugin","pluginId":"acme.caller"}')

    const outcomes = await call(s.client, 'acme.caller/connection')
    expect(outcomes).toEqual(
      Object.fromEntries(
        ['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach'].map((name) => [
          name,
          { code: RpcErrorCode.InvalidParams, message: `${name} needs a client connection` }
        ])
      )
    )
  })

  test('SC-7: a method must be provided as a function', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.tools',
          contributes: { method: [{ id: 'refresh' }] }
        },
        behavior: { activate: "context.provide('method:acme.tools/refresh', 'nope')" }
      },
      {
        manifest: { id: 'acme.jobs', contributes: { job: [{ id: 'tick', interval: '1h' }] } },
        behavior: { activate: "context.provide('job:acme.jobs/tick', 'nope')" }
      },
      {
        manifest: { id: 'acme.hooks', contributes: { 'launch-hook': [{ id: 'extra', agents: ['claude'] }] } },
        behavior: { activate: "context.provide('launch-hook:acme.hooks/extra', 'nope')" }
      }
    ])

    const failures: Record<string, string> = {
      'acme.tools': 'method:acme.tools/refresh',
      'acme.jobs': 'job:acme.jobs/tick',
      'acme.hooks': 'launch-hook:acme.hooks/extra'
    }
    for (const [pluginId, contributionId] of Object.entries(failures)) {
      const error = await rejection(call(s.client, 'plugin.activate', { pluginId }))
      expect(error.code).toBe(RpcErrorCode.Conflict)
      const info = await s.state(pluginId)
      expect(info.state).toBe('failed')
      expect(info.diagnostics.map((diagnostic) => diagnostic.message).join('\n')).toContain(
        `${contributionId} must be provided as a function`
      )
    }

    expect(await rejection(call(s.client, 'acme.tools/refresh', { count: 1 }))).toMatchObject({
      code: RpcErrorCode.Conflict
    })
  })
})
