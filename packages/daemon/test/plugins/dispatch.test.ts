import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { DaemonError } from '../../src/errors'
import type { Handlers } from '../../src/methods'
import { Dispatcher } from '../../src/plugins/dispatch'
import { PluginHost } from '../../src/plugins/host'
import type { ClientConn } from '../../src/types'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin, type ModuleBehavior } from './fixtures'

afterEach(removeTempDirs)

const ERRORS_MODULE = join(import.meta.dir, '../../src/errors.ts')
const REFRESH = 'method:acme.tools/refresh'

function setup() {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const disabled = new Set<string>()
  const logs: string[] = []
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled].sort(),
      setDisabledId: (id, isDisabled) => {
        if (isDisabled) disabled.add(id)
        else disabled.delete(id)
      }
    },
    emit: () => {},
    log: (message) => logs.push(message)
  })
  const plugin = (manifest: { id: string } & Record<string, unknown>, behavior?: ModuleBehavior) =>
    writeModulePlugin(installedDir, marker, manifest, behavior)
  const kernelCalls: { method: string; params: unknown; conn: ClientConn }[] = []
  const handlers = {
    'status.get': (params: unknown, conn: ClientConn) => {
      kernelCalls.push({ method: 'status.get', params, conn })
      return { fromKernel: true }
    },
    'void.thing': () => undefined,
    'client.hello': () => ({ ok: true }),
    'events.subscribe': () => ({ ok: true }),
    'terminal.attach': () => ({ ok: true }),
    'terminal.detach': () => ({ ok: true })
  } as unknown as Handlers
  const dispatcher = new Dispatcher(handlers, host, (message) => logs.push(message))
  const conn = (overrides: Partial<ClientConn> = {}): ClientConn => ({
    id: 7,
    role: 'cli',
    name: 'tester',
    subscribed: true,
    closed: false,
    streams: new Map(),
    nextStreamId: 1,
    sendText() {},
    sendBinary() {},
    ...overrides
  })
  const refresh = (body: string, extra: Record<string, unknown> = {}) =>
    plugin({ id: 'acme.tools', contributes: { method: [{ id: 'refresh' }] }, ...extra }, {
      activate: `context.provide('${REFRESH}', ${body})`
    })
  const reject = async (promise: Promise<unknown>): Promise<DaemonError> => {
    const error = await promise.then(
      () => undefined,
      (caught) => caught
    )
    expect(error).toBeInstanceOf(DaemonError)
    return error as DaemonError
  }
  return { host, dispatcher, conn, plugin, refresh, reject, kernelCalls, logs, marker, lines: () => readMarker(marker) }
}

describe('Dispatcher', () => {
  test('a kernel method runs its handler with the caller connection', async () => {
    const t = setup()
    t.host.load()
    const conn = t.conn()
    expect(await t.dispatcher.dispatch('status.get', { a: 1 }, { conn })).toEqual({ fromKernel: true })
    expect(t.kernelCalls[0]?.params).toEqual({ a: 1 })
    expect(t.kernelCalls[0]?.conn).toBe(conn)
  })

  test('a kernel method called from a plugin gets a detached connection', async () => {
    const t = setup()
    t.host.load()
    expect(await t.dispatcher.dispatch('status.get', {}, { pluginId: 'acme.tools' })).toEqual({ fromKernel: true })
    const seen = t.kernelCalls[0]!.conn
    expect(seen).toMatchObject({ id: 0, role: null, subscribed: false, closed: true, nextStreamId: 1 })
    expect(seen.streams.size).toBe(0)
    expect(seen.name).toBeUndefined()
  })

  test('a kernel handler that returns undefined yields null', async () => {
    const t = setup()
    t.host.load()
    expect(await t.dispatcher.dispatch('void.thing', {}, { conn: t.conn() })).toBeNull()
  })

  test.each(['client.hello', 'events.subscribe', 'terminal.attach', 'terminal.detach'])(
    '%s is refused from a plugin',
    async (method) => {
      const t = setup()
      t.host.load()
      const error = await t.reject(t.dispatcher.dispatch(method, {}, { pluginId: 'acme.tools' }))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.message).toBe(`${method} needs a client connection`)
      expect(await t.dispatcher.dispatch(method, {}, { conn: t.conn() })).toEqual({ ok: true })
    }
  )

  test('a plugin method activates a lazy plugin and receives the params and a connection caller', async () => {
    const t = setup()
    t.refresh('(params, caller) => ({ params, caller })')
    t.host.load()
    expect(t.lines()).toEqual([])
    const result = await t.dispatcher.dispatch('acme.tools/refresh', { x: 1 }, { conn: t.conn() })
    expect(result).toEqual({ params: { x: 1 }, caller: { role: 'cli', name: 'tester' } })
    expect(t.lines()).toEqual(['import acme.tools', 'activate acme.tools'])
  })

  test('a connection without a name has no name in the caller', async () => {
    const t = setup()
    t.refresh('(params, caller) => caller')
    t.host.load()
    const caller = await t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn({ name: undefined, role: 'ui' }) })
    expect(caller).toEqual({ role: 'ui' })
    expect(Object.hasOwn(caller as object, 'name')).toBe(false)
  })

  test('a plugin caller is identified by its plugin ID', async () => {
    const t = setup()
    t.refresh('(params, caller) => caller')
    t.host.load()
    expect(await t.dispatcher.dispatch('acme.tools/refresh', {}, { pluginId: 'acme.other' })).toEqual({
      role: 'plugin',
      pluginId: 'acme.other'
    })
  })

  test('an async handler is awaited and undefined becomes null', async () => {
    const t = setup()
    t.refresh('async () => undefined')
    t.host.load()
    expect(await t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() })).toBeNull()
  })

  test('unknown names are MethodNotFound without importing anything', async () => {
    const t = setup()
    t.refresh('() => 1')
    t.host.load()
    for (const name of ['nope.thing', 'acme.tools/missing', 'acme.nobody/refresh', 'BAD NAME/x', 'method:acme.tools/refresh', 'toString', '__proto__']) {
      const error = await t.reject(t.dispatcher.dispatch(name, {}, { conn: t.conn() }))
      expect(error.code).toBe(RpcErrorCode.MethodNotFound)
      expect(error.message).toBe(`unknown method: ${name}`)
    }
    expect(t.lines()).toEqual([])
  })

  test('a disabled method is MethodNotFound without importing anything', async () => {
    const t = setup()
    t.refresh('() => 1')
    t.host.load()
    await t.host.setEnabled(REFRESH, false)
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.MethodNotFound)
    expect(error.message).toBe('unknown method: acme.tools/refresh')
    expect(t.lines()).toEqual([])
  })

  test('a name that is not a method contribution is MethodNotFound', async () => {
    const t = setup()
    t.plugin({ id: 'acme.tools', contributes: { command: [{ id: 'refresh' }] } })
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.MethodNotFound)
    expect(t.lines()).toEqual([])
  })

  test('an overridden method runs the override', async () => {
    const t = setup()
    t.refresh("() => 'base'")
    t.plugin(
      { id: 'acme.better', overrides: [{ id: REFRESH }] },
      { activate: `context.provide('${REFRESH}', () => 'override')` }
    )
    t.host.load()
    expect(await t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() })).toBe('override')
    expect(t.lines()).toEqual(['import acme.better', 'activate acme.better'])
  })

  test('a DaemonError thrown by the handler keeps its code and message', async () => {
    const t = setup()
    t.refresh(`async () => { const { notFound } = await import(${JSON.stringify(ERRORS_MODULE)}); throw notFound('gone') }`)
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.NotFound)
    expect(error.message).toBe('gone')
  })

  test('any other throw becomes Internal prefixed with the owning plugin', async () => {
    const t = setup()
    t.refresh("() => { throw new Error('boom') }")
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.Internal)
    expect(error.message).toBe('acme.tools: boom')
  })

  test('a non-Error throw is stringified', async () => {
    const t = setup()
    t.refresh("async () => { throw 'plain' }")
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.Internal)
    expect(error.message).toBe('acme.tools: plain')
  })

  test('the owner in an Internal error is the overriding plugin', async () => {
    const t = setup()
    t.refresh('() => 1')
    t.plugin(
      { id: 'acme.better', overrides: [{ id: REFRESH }] },
      { activate: `context.provide('${REFRESH}', () => { throw new Error('bad') })` }
    )
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.message).toBe('acme.better: bad')
  })

  test('an activation failure passes through as the host Conflict', async () => {
    const t = setup()
    t.plugin({ id: 'acme.tools', contributes: { method: [{ id: 'refresh' }] } }, { activate: "throw new Error('no start')" })
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('acme.tools failed to activate: no start')
  })

  test('a plugin that activates without providing the method is a Conflict', async () => {
    const t = setup()
    t.plugin({ id: 'acme.tools', contributes: { method: [{ id: 'refresh' }] } })
    t.host.load()
    const error = await t.reject(t.dispatcher.dispatch('acme.tools/refresh', {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe(`acme.tools did not provide ${REFRESH}`)
  })
})
