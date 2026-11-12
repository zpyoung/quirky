import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { QuirkyEvent } from '@quirky/protocol'
import { makeTempHome, startHarness, waitFor, type Harness } from '../helpers'
import { makeTempDir, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
  removeTempDirs()
})

type Manifest = { id: string } & Record<string, unknown>
type Fixture = { manifest: Manifest; behavior?: ModuleBehavior }

/** Starts a daemon with no built-in plugins over the given installed plugins, capturing its log. */
async function boot(plugins: Fixture[]) {
  const home = makeTempHome()
  const marker = join(makeTempDir(), 'marker.log')
  for (const { manifest, behavior } of plugins) writeModulePlugin(join(home, 'plugins'), marker, manifest, behavior)
  const logs: string[] = []
  const harness = await startHarness({ home, builtinPluginsDir: null, log: (message) => void logs.push(message) })
  h = harness
  const client = await harness.connect()
  return { harness, client, logs }
}

const call = (client: { callAny(method: string, params: Record<string, unknown>): Promise<unknown> }, method: string, params: Record<string, unknown> = {}) =>
  client.callAny(method, params)

const declares = (...names: string[]) => ({ event: names.map((id) => ({ id })) })

describe('plugin events', () => {
  test('SC-8: a plugin event reaches subscribed clients', async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.tools', contributes: { method: [{ id: 'fire', params: { type: 'object', additionalProperties: true } }], ...declares('refreshed') } },
        behavior: {
          activate: "context.provide('method:acme.tools/fire', (params) => context.emit('refreshed', { count: params.count }))"
        }
      }
    ])
    const { events } = await s.harness.connectWithEvents()

    expect(await call(s.client, 'acme.tools/fire', { count: 2 })).toBe(true)

    const event = await waitFor(() => events.find((candidate: QuirkyEvent) => candidate.type === 'acme.tools/refreshed'))
    expect(event).toEqual({ type: 'acme.tools/refreshed', data: { count: 2 } })
  })

  test("SC-9: only a plugin's own events in effect are emitted", async () => {
    const s = await boot([
      {
        manifest: { id: 'acme.tools', contributes: { method: [{ id: 'emit', params: { type: 'object', additionalProperties: true } }], ...declares('refreshed', 'sentinel') } },
        behavior: {
          activate: `
            context.provide('method:acme.tools/emit', (params) => {
              try {
                return { result: context.emit(params.event, params.data) }
              } catch (error) {
                return { error: error.message }
              }
            })`
        }
      },
      {
        manifest: { id: 'acme.better', contributes: { method: [{ id: 'emit', params: { type: 'object', additionalProperties: true } }] }, overrides: [{ id: 'event:acme.tools/refreshed' }] },
        behavior: {
          activate: `
            context.provide('method:acme.better/emit', (params) => {
              try {
                return { result: context.emit(params.event, params.data) }
              } catch (error) {
                return { error: error.message }
              }
            })`
        }
      }
    ])
    const { events } = await s.harness.connectWithEvents()
    const types = () => events.map((event: QuirkyEvent) => event.type).filter((type) => type !== 'plugin.changed')
    const settle = async () => {
      await call(s.client, 'acme.tools/emit', { event: 'sentinel', data: null })
      await waitFor(() => types().filter((type) => type === 'acme.tools/sentinel').length)
      events.length = 0
    }

    await s.client.call('plugin.disable', { id: 'event:acme.tools/refreshed' })

    expect(await call(s.client, 'acme.tools/emit', { event: 'other', data: 1 })).toEqual({
      error: 'acme.tools does not declare event:acme.tools/other'
    })
    expect(await call(s.client, 'acme.tools/emit', { event: 'refreshed', data: { count: 2 } })).toEqual({ result: false })
    await settle()
    expect(types()).toEqual([])

    await s.client.call('plugin.enable', { id: 'event:acme.tools/refreshed' })

    expect(await call(s.client, 'acme.tools/emit', { event: 'refreshed', data: { count: 3 } })).toEqual({ result: false })
    expect(
      await call(s.client, 'acme.better/emit', { event: 'event:acme.tools/refreshed', data: { count: 4 } })
    ).toEqual({ result: true })
    const event = await waitFor(() => events.find((candidate: QuirkyEvent) => candidate.type === 'acme.tools/refreshed'))
    expect(event).toEqual({ type: 'acme.tools/refreshed', data: { count: 4 } })
    expect(types()).toEqual(['acme.tools/refreshed'])

    const undeclared = 'event:acme.tools/other'
    expect(await call(s.client, 'acme.better/emit', { event: undeclared, data: 1 })).toEqual({
      error: `acme.better does not declare ${undeclared}`
    })
    expect(await call(s.client, 'acme.tools/emit', { event: 'event:acme.better/x', data: 1 })).toEqual({
      error: 'acme.tools does not declare event:acme.better/x'
    })
    expect(await call(s.client, 'acme.tools/emit', { event: 'command:acme.tools/refresh', data: 1 })).toEqual({
      error: 'command:acme.tools/refresh is not an event'
    })
    await settle()
  })

  test('SC-10: plugin listeners see kernel and plugin events, and their failures are contained', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.tools',
          activation: 'startup',
          contributes: { method: [{ id: 'fire' }], ...declares('refreshed') }
        },
        behavior: { activate: "context.provide('method:acme.tools/fire', () => context.emit('refreshed', { count: 2 }))" }
      },
      {
        manifest: {
          id: 'acme.watch',
          activation: 'startup',
          dependencies: ['acme.tools'],
          contributes: { method: [{ id: 'seen' }], ...declares('heard') }
        },
        behavior: {
          activate: `
            const seen = []
            // plugin.changed is activation noise from the other startup plugins; heard is this listener's own ping
            context.subscribe((event) => {
              if (event.type !== 'plugin.changed' && event.type !== 'acme.watch/heard') seen.push(event.type)
              if (event.type === 'ui.state.changed') context.emit('heard', null)
            })
            context.provide('method:acme.watch/seen', () => seen)`
        }
      },
      {
        manifest: { id: 'acme.flaky', activation: 'startup' },
        behavior: { activate: "context.subscribe(() => { throw new Error('flaky listener') })" }
      }
    ])
    const { client: observer, events } = await s.harness.connectWithEvents()
    const order: string[] = []
    observer.onEvent((event) => {
      if (event.type === 'acme.watch/heard') order.push('listener ran')
    })

    await observer.call('ui.sidebar.set', { visible: false })
    order.push('reply')
    await call(s.client, 'acme.tools/fire')

    await waitFor(() => order.includes('listener ran'))
    const seen = await waitFor(async () => {
      const value = (await call(s.client, 'acme.watch/seen')) as string[]
      return value.includes('acme.tools/refreshed') ? value : undefined
    })
    expect(seen).toEqual(['ui.state.changed', 'acme.tools/refreshed'])
    expect(order).toEqual(['reply', 'listener ran'])
    expect(events.some((event) => event.type === 'ui.state.changed')).toBe(true)
    await waitFor(() => s.logs.some((line) => line.includes('acme.flaky: listener failed: flaky listener')))
    expect(s.logs.some((line) => line.includes('acme.watch: listener failed'))).toBe(false)
  })

  test('SC-27: coalesces a burst for clients and plugin listeners', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.tools',
          activation: 'startup',
          contributes: { method: [{ id: 'burst' }], event: [{ id: 'changed', coalesce: [] }] }
        },
        behavior: {
          activate: `
            context.provide('method:acme.tools/burst', () => {
              for (let n = 1; n <= 50; n++) context.emit('changed', { n })
              return true
            })`
        }
      },
      {
        manifest: {
          id: 'acme.watch',
          activation: 'startup',
          dependencies: ['acme.tools'],
          contributes: { method: [{ id: 'seen' }] }
        },
        behavior: {
          activate: `
            const seen = []
            context.subscribe((event) => {
              if (event.type === 'acme.tools/changed') seen.push(event)
            })
            context.provide('method:acme.watch/seen', () => seen)`
        }
      }
    ])
    const { events } = await s.harness.connectWithEvents()
    const expected: QuirkyEvent[] = [
      { type: 'acme.tools/changed', data: { n: 1 } },
      { type: 'acme.tools/changed', data: { n: 50 } }
    ]

    expect(await call(s.client, 'acme.tools/burst')).toBe(true)
    await Bun.sleep(700)

    expect(events.filter((event) => event.type === 'acme.tools/changed')).toEqual(expected)
    expect(await call(s.client, 'acme.watch/seen')).toEqual(expected)
  })

  test('SC-28: includes the worktree tag in the client event envelope', async () => {
    const s = await boot([
      {
        manifest: {
          id: 'acme.tools',
          contributes: { method: [{ id: 'fire' }], event: [{ id: 'tree', worktree: 'worktreeId' }] }
        },
        behavior: {
          activate: "context.provide('method:acme.tools/fire', () => context.emit('tree', { worktreeId: 'wt_1' }))"
        }
      }
    ])
    const { events } = await s.harness.connectWithEvents()

    expect(await call(s.client, 'acme.tools/fire')).toBe(true)

    const event = await waitFor(() => events.find((candidate: QuirkyEvent) => candidate.type === 'acme.tools/tree'))
    expect(event).toEqual({
      type: 'acme.tools/tree',
      data: { worktreeId: 'wt_1' },
      worktreeId: 'wt_1'
    })
  })

})
