import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { RpcErrorCode, type MethodHandler, type PluginContext, type PluginSessionAuthority } from '@quirky/protocol'
import { DaemonError } from '../../src/errors'
import { Dispatcher } from '../../src/plugins/dispatch'
import { PluginHost } from '../../src/plugins/host'
import { RunningHandlers, DEFAULT_MAX_RUNNING_HANDLERS } from '../../src/plugins/running'
import { UnansweredHandlers } from '../../src/plugins/unanswered'
import type { ClientConn } from '../../src/types'
import { makeTempDir, removeTempDirs, writeModulePlugin } from './fixtures'

const METHOD = 'acme.tools/read'
const CONTRIBUTION = `method:${METHOD}`
const cleanups: (() => Promise<void>)[] = []
type Gate = { promise: Promise<unknown>; resolve(value: unknown): void; reject(error: unknown): void }

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
  removeTempDirs()
})

type Handler = (params: Record<string, unknown>, caller: Parameters<MethodHandler>[1], context: PluginContext) => unknown

function setup(options: {
  maxRunning?: number
  defaultLimit?: boolean
  resolveSessionAuthority?: (conn: ClientConn) => Promise<PluginSessionAuthority | null>
} = {}) {
  const root = makeTempDir('qd-running-')
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const logs: string[] = []
  const events: string[] = []
  const disabled = new Set<string>()
  const handlers: Record<string, Handler> = {}
  const gates: Gate[] = []
  const invocations = new Map<string, number>()
  const state = { handlers, invocations }
  const globals = globalThis as unknown as Record<string, unknown>
  globals[root] = state
  let dispatcher!: Dispatcher
  const unavailable = () => { throw new Error('unused test context service') }
  const host = new PluginHost({
    builtinDir: null,
    installedDir,
    store: {
      listDisabledIds: () => [...disabled],
      setDisabledId: (id, value) => { if (value) disabled.add(id); else disabled.delete(id) }
    },
    emit: (event) => { events.push(event.type) },
    log: (message) => logs.push(message),
    extension: {
      create: (plugin) => ({
        dataDir: root, home: root, pty: {} as never, launch: {} as never,
        createFileResource: unavailable, notify: unavailable, emit: unavailable,
        subscribe: unavailable, openStore: unavailable, getSetting: unavailable, error: unavailable,
        call: (method, params = {}) => dispatcher.dispatch(method, params, { pluginId: plugin.id }),
        forward: (method, params, caller) => dispatcher.forward(plugin.id, method, params, caller)
      }),
      revoke() {}
    }
  })
  const warningOptions = {
    warn(pluginId: string, message: string) {
      if (!host.list().find((plugin) => plugin.id === pluginId)?.diagnostics.some((item) => item.message === message)) {
        host.addWarning(pluginId, message)
      }
    },
    unwarn: (pluginId: string, message: string) => host.removeWarning(pluginId, message)
  }
  const running = new RunningHandlers({ ...warningOptions, log: (message) => logs.push(message) })
  const unanswered = new UnansweredHandlers(warningOptions)
  dispatcher = new Dispatcher({ 'status.get': async () => { await nextTurn(); return 'kernel' } } as never, host, (message) => logs.push(message), {
    running, unanswered,
    ...(options.defaultLimit ? {} : { maxRunning: options.maxRunning ?? 3 }),
    resolveSessionAuthority: options.resolveSessionAuthority
  })
  const conn: ClientConn = {
    id: 7, role: 'cli', name: 'tester', subscribed: true, closed: false, transport: 'websocket',
    streams: new Map(), streamClosers: new Map(), nextStreamId: 1, sendText() {}, sendBinary() {}
  }
  const source = { conn }
  const gate = () => {
    const deferred = Promise.withResolvers<unknown>()
    gates.push(deferred)
    return deferred
  }
  const plugin = (methods: Record<string, unknown>[], implementations: Record<string, Handler>, activate = '') => {
    Object.assign(handlers, implementations)
    writeModulePlugin(installedDir, join(root, 'marker'), {
      id: 'acme.tools', contributes: { method: methods.map((method) => ({ params: { type: 'object', additionalProperties: true }, ...method })) }
    }, { activate: `${activate}
      const state = globalThis[${JSON.stringify(root)}]
      for (const [name, handler] of Object.entries(state.handlers)) {
        context.provide('method:acme.tools/' + name, (params, caller) => {
          state.invocations.set('method:acme.tools/' + name, (state.invocations.get('method:acme.tools/' + name) ?? 0) + 1)
          return handler(params, caller, context)
        })
      }` })
    host.load()
  }
  const call = (name = METHOD, requestId?: string) => dispatcher.dispatch(name, {}, source, requestId === undefined ? {} : { requestId })
  const error = async (promise: Promise<unknown>) => {
    const result = await promise.then(() => null, (caught: unknown) => caught)
    expect(result).toBeInstanceOf(DaemonError)
    return result as DaemonError
  }
  const warning = (limit = options.maxRunning ?? 3) => `method:${METHOD} has reached its limit of ${limit} running handlers; calls over the limit are refused`
  const warnings = () => host.list().find((plugin) => plugin.id === 'acme.tools')?.diagnostics.map((item) => item.message) ?? []
  cleanups.push(async () => {
    gates.forEach((deferred) => deferred.resolve('cleanup'))
    await nextTurn()
    delete globals[root]
  })
  return { host, dispatcher, running, unanswered, invocations, logs, events, plugin, gate, call, error, source, warning, warnings }
}

function busy(error: DaemonError, running = 3, method = METHOD) {
  expect(error.code).toBe(RpcErrorCode.Busy)
  expect(error.message).toBe(`${method} is busy: ${running} calls are already running`)
  expect(error.data).toEqual({ reason: 'busy', method, running, limit: running })
}

async function started(t: { running: RunningHandlers; invocations: Map<string, number> }, count: number, contribution = CONTRIBUTION, total = count) {
  const deadline = Date.now() + 500
  while ((t.invocations.get(contribution) ?? 0) < total && Date.now() < deadline) await nextTurn()
  expect(t.invocations.get(contribution)).toBe(total)
  expect(t.running.count(contribution)).toBe(count)
}

describe('Dispatcher running-handler admission', () => {
  test('R1 refuses a concurrent burst before activation and D1 logs once per refusal episode', async () => {
    const t = setup()
    let calls = 0
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true, timeout: '1s' }], { read: () => { calls++; return gate.promise } })
    const resolveImplementation = t.host.resolveImplementation.bind(t.host)
    let resolutions = 0
    t.host.resolveImplementation = async (id) => { resolutions++; return resolveImplementation(id) }
    const first = Array.from({ length: 3 }, () => t.call())
    const before = Date.now()
    const refused = await Promise.all([t.error(t.call()), t.error(t.call())])
    expect(Date.now() - before).toBeLessThan(100)
    refused.forEach((error) => busy(error))
    await started(t, 3)
    expect(calls).toBe(3)
    expect(resolutions).toBe(3)
    const limitLog = `method ${METHOD} in acme.tools has reached its limit of 3 running handlers; refusing calls over the limit`
    for (let index = 0; index < 20; index++) busy(await t.error(t.call()))
    expect(t.warnings().filter((message) => message === t.warning())).toHaveLength(1)
    expect(t.logs.filter((message) => message === limitLog)).toHaveLength(1)
    gate.resolve({ ok: true })
    await Promise.all(first)
    expect(t.running.count(CONTRIBUTION)).toBe(0)
  })

  test('R2 defaults to 1024 for plugin-sourced concurrent calls', async () => {
    expect(DEFAULT_MAX_RUNNING_HANDLERS).toBe(1024)
    const t = setup({ defaultLimit: true })
    let calls = 0
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true }], { read: () => { calls++; return gate.promise } })
    const outcomes = Array.from({ length: 1100 }, () => t.dispatcher.dispatch(METHOD, {}, { pluginId: 'acme.caller' }).then(
      (result) => result,
      (error) => error
    ))
    await started(t, 1024)
    expect(calls).toBe(1024)
    gate.resolve('ok')
    const results = await Promise.all(outcomes)
    expect(results.filter((result) => result === 'ok')).toHaveLength(1024)
    const refused = results.filter((result) => result instanceof DaemonError)
    expect(refused).toHaveLength(76)
    refused.forEach((error) => busy(error, 1024))
    expect(t.running.count(CONTRIBUTION)).toBe(0)
  })

  test('R3 returns slots on settlement and D2 stays silent without a refusal', async () => {
    const t = setup()
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true }], { read: () => gate.promise })
    const first = Array.from({ length: 3 }, () => t.call())
    await started(t, 3)
    expect(t.warnings()).toEqual([])
    expect(t.logs).toEqual([])
    busy(await t.error(t.call()))
    gate.resolve({ ok: true })
    expect(await Promise.all(first)).toEqual([{ ok: true }, { ok: true }, { ok: true }])
    expect(await t.call()).toEqual({ ok: true })
    expect(t.running.count(CONTRIBUTION)).toBe(0)
  })

  test('R4 retains timed-out slots and R6 releases late success and failure', async () => {
    const t = setup()
    let calls = 0
    const gates = [t.gate(), t.gate(), t.gate()]
    t.plugin([{ id: 'read', readOnly: true, timeout: '1s' }], { read: () => gates[calls++]!.promise })
    const first = await Promise.all(Array.from({ length: 3 }, () => t.error(t.call())))
    first.forEach((error) => expect(error.data).toMatchObject({ reason: 'timeout' }))
    expect(t.running.count(CONTRIBUTION)).toBe(3)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(3)
    busy(await t.error(t.call()))
    expect(calls).toBe(3)
    gates[0]!.resolve('late')
    gates[1]!.reject(new Error('late failure'))
    await nextTurn()
    expect(t.running.count(CONTRIBUTION)).toBe(1)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(1)
    gates[2]!.resolve('late')
    await nextTurn()
    expect(t.running.count(CONTRIBUTION)).toBe(0)
  })

  test('R5 gives stalled precedence over Busy', async () => {
    const t = setup({ maxRunning: 6 })
    let calls = 0
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true, timeout: '1s' }], { read: () => { calls++; return gate.promise } })
    await Promise.all(Array.from({ length: 6 }, () => t.error(t.call())))
    const error = await t.error(t.call())
    expect(error.code).toBe(RpcErrorCode.Timeout)
    expect(error.data).toEqual({ reason: 'stalled', method: METHOD, unanswered: 6 })
    expect(calls).toBe(6)
  })

  test('R7 releases admission after failed activation and permits the next attempt', async () => {
    const t = setup({ maxRunning: 1 })
    t.plugin([{ id: 'read', readOnly: true }], { read: () => 'ok' })
    const resolve = t.host.resolveImplementation.bind(t.host)
    let fail = true
    t.host.resolveImplementation = async (id) => { if (fail) throw new Error('activation failed'); return resolve(id) }
    await expect(t.call()).rejects.toThrow('activation failed')
    expect(t.running.count(CONTRIBUTION)).toBe(0)
    fail = false
    expect(await t.call()).toBe('ok')
  })

  test('R7 releases admission after failed session authority and synchronous handler throws', async () => {
    let failAuthority = true
    const t = setup({ maxRunning: 1, resolveSessionAuthority: async () => { if (failAuthority) throw new Error('authority failed'); return null } })
    let failHandler = true
    t.plugin([{ id: 'read', readOnly: true }], { read: () => { if (failHandler) throw new Error('boom'); return 'ok' } })
    await expect(t.call()).rejects.toThrow('authority failed')
    expect(t.running.count(CONTRIBUTION)).toBe(0)
    failAuthority = false
    expect((await t.error(t.call())).code).toBe(RpcErrorCode.Internal)
    expect(t.running.count(CONTRIBUTION)).toBe(0)
    failHandler = false
    expect(await t.call()).toBe('ok')
  })

  test('R8 shares all source counts and R9 isolates other methods and kernel handlers', async () => {
    const t = setup()
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true }, { id: 'other', readOnly: true }], { read: () => gate.promise, other: () => 'ok' })
    const sources = [t.source, { pluginId: 'acme.caller' }, { kernel: true as const }]
    const first = sources.map((source) => t.dispatcher.dispatch(METHOD, {}, source))
    for (const source of sources) busy(await t.error(t.dispatcher.dispatch(METHOD, {}, source)))
    expect(await t.call('acme.tools/other')).toBe('ok')
    expect(await Promise.all(Array.from({ length: 10 }, () => t.dispatcher.dispatch('status.get', {}, { kernel: true })))).toEqual(Array(10).fill('kernel'))
    gate.resolve('done')
    await Promise.all(first)
  })

  test('R9 releases a method without a deadline on completion and rejection', async () => {
    const t = setup({ maxRunning: 1 })
    let fail = true
    t.plugin([{ id: 'read' }], { read: () => { if (fail) return Promise.reject(new Error('failed')); return 'ok' } })
    expect((await t.error(t.call())).code).toBe(RpcErrorCode.Internal)
    expect(t.running.count(CONTRIBUTION)).toBe(0)
    fail = false
    expect(await t.call()).toBe('ok')
    expect(t.running.count(CONTRIBUTION)).toBe(0)
  })

  test('R10 refuses recursive admission without deadlocking', async () => {
    const t = setup()
    let calls = 0
    t.plugin([{ id: 'again', timeout: '5s' }], {
      again: async (_params, _caller, context) => {
        calls++
        try { return await context.call('acme.tools/again', {}) }
        catch (error) {
          if (!(error instanceof DaemonError)) throw error
          const data = error.data
          if (data && typeof data === 'object' && 'reason' in data) return data.reason
          throw error
        }
      }
    })
    expect(await t.call('acme.tools/again')).toBe('busy')
    expect(calls).toBe(3)
    expect(t.running.count('method:acme.tools/again')).toBe(0)
  })

  test('R11 and D5 preserve the bound across reload and restore its cleared warning', async () => {
    const t = setup()
    let calls = 0
    const gate = t.gate()
    t.plugin([{ id: 'read', readOnly: true }], { read: () => { calls++; return gate.promise } })
    const first = Array.from({ length: 3 }, () => t.call())
    await started(t, 3)
    busy(await t.error(t.call()))
    await t.host.setEnabled('acme.tools', false)
    await t.host.setEnabled('acme.tools', true)
    await t.host.resolveImplementation(CONTRIBUTION)
    expect(t.warnings()).not.toContain(t.warning())
    busy(await t.error(t.call()))
    expect(t.warnings()).toContain(t.warning())
    expect(calls).toBe(3)
    gate.resolve('done')
    await Promise.all(first)
  })

  test('D3 clears at half and D4 avoids plugin.changed storms while hovering at the limit', async () => {
    const t = setup({ maxRunning: 4 })
    const gates = Array.from({ length: 14 }, () => t.gate())
    let calls = 0
    t.plugin([{ id: 'read', readOnly: true }], { read: () => gates[calls++]!.promise })
    const pending = Array.from({ length: 4 }, () => t.call())
    await started(t, 4)
    const eventsBefore = t.events.length
    busy(await t.error(t.call()), 4)
    busy(await t.error(t.call()), 4)
    for (let index = 0; index < 10; index++) {
      gates[index]!.resolve('done')
      await pending[index]
      expect(t.warnings()).toContain(t.warning())
      pending.push(t.call())
      await started(t, 4, CONTRIBUTION, index + 5)
      busy(await t.error(t.call()), 4)
    }
    expect(t.events.slice(eventsBefore)).toEqual(['plugin.changed'])
    gates[10]!.resolve('done')
    gates[11]!.resolve('done')
    await Promise.all([pending[10], pending[11]])
    expect(t.running.count(CONTRIBUTION)).toBe(2)
    expect(t.warnings()).not.toContain(t.warning())
    expect(t.logs).toContain(`method ${METHOD} in acme.tools is under its limit again; 12 calls were refused`)
    gates.forEach((gate) => gate.resolve('done'))
    await Promise.all(pending)
  })

  test('Q1 retries a refused request ID after recovery and then replays its successful outcome', async () => {
    const t = setup({ maxRunning: 1 })
    const gate = t.gate()
    let calls = 0
    t.plugin([{ id: 'write', timeout: '5s' }], { write: () => { calls++; return gate.promise } })
    const first = t.call('acme.tools/write', 'r0')
    busy(await t.error(t.call('acme.tools/write', 'r1')), 1, 'acme.tools/write')
    gate.resolve('done')
    expect(await first).toBe('done')
    expect(await t.call('acme.tools/write', 'r1')).toBe('done')
    expect(await t.call('acme.tools/write', 'r1')).toBe('done')
    expect(calls).toBe(2)
  })

  test('Q2 retries a stalled request ID once a late handler settles', async () => {
    const t = setup({ maxRunning: 8 })
    const gates = Array.from({ length: 4 }, () => t.gate())
    let calls = 0
    t.plugin([{ id: 'stuck', timeout: '1s' }], { stuck: () => { const gate = gates[calls++]; return gate ? gate.promise : 'recovered' } })
    await Promise.all(Array.from({ length: 4 }, (_, index) => t.error(t.call('acme.tools/stuck', `first-${index}`))))
    expect((await t.error(t.call('acme.tools/stuck', 'r2'))).data).toMatchObject({ reason: 'stalled' })
    gates[0]!.resolve('late')
    await nextTurn()
    expect(await t.call('acme.tools/stuck', 'r2')).toBe('recovered')
    expect(calls).toBe(5)
  })
})
