import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { DaemonError } from '../../src/errors'
import { Dispatcher, methodTimeoutMs } from '../../src/plugins/dispatch'
import { PluginHost } from '../../src/plugins/host'
import { UnansweredHandlers } from '../../src/plugins/unanswered'
import type { ClientConn } from '../../src/types'
import { makeTempDir, readMarker, removeTempDirs, writeModulePlugin } from './fixtures'

afterEach(removeTempDirs)

const ERRORS_MODULE = join(import.meta.dir, '../../src/errors.ts')
const METHOD = 'acme.tools/read'
const CONTRIBUTION = `method:${METHOD}`
const LOOSE = { type: 'object', additionalProperties: true }
const BOUND_WARNING = `${CONTRIBUTION} has 4 or more handlers that never finished; it will not run again until fewer than 4 remain or the daemon restarts`

type SetupOptions = {
  readTimeoutMs?: number
  statusHandler?: (params: unknown, conn: ClientConn) => unknown
}

function setup(options: SetupOptions = {}) {
  const root = makeTempDir()
  const installedDir = join(root, 'installed')
  mkdirSync(installedDir)
  const marker = join(root, 'marker.log')
  const disabled = new Set<string>()
  const logs: string[] = []
  let dispatcher!: Dispatcher
  const unavailable = () => { throw new Error('unused test context service') }
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
    log: (message) => logs.push(message),
    extension: {
      create: (plugin) => ({
        dataDir: root,
        home: root,
        pty: {} as never,
        launch: {} as never,
        createFileResource: unavailable,
        notify: unavailable,
        emit: unavailable,
        subscribe: unavailable,
        call: unavailable,
        openStore: unavailable,
        getSetting: unavailable,
        error: unavailable,
        forward: (method, params, caller) => dispatcher.forward(plugin.id, method, params, caller)
      }),
      revoke: (pluginId) => { logs.push(`revoke ${pluginId}`) }
    }
  })
  const unanswered = new UnansweredHandlers({
    warn: (pluginId, message) => {
      if (host.list().find((plugin) => plugin.id === pluginId)?.diagnostics.some((item) => item.message === message)) return
      host.addWarning(pluginId, message)
    },
    unwarn: (pluginId, message) => host.removeWarning(pluginId, message)
  })
  const handlers = {
    'status.get': options.statusHandler ?? (() => ({ fromKernel: true })),
    'job.list': () => undefined,
    'client.hello': () => ({ ok: true }),
    'events.subscribe': () => ({ ok: true }),
    'ui.report': () => ({ ok: true }),
    'ui.window.focused': () => ({ ok: true }),
    'ui.window.activity': () => ({ ok: true })
  }
  dispatcher = new Dispatcher(handlers as never, host, (message) => logs.push(message), {
    unanswered,
    readTimeoutMs: options.readTimeoutMs
  })
  const conn = (overrides: Partial<ClientConn> = {}): ClientConn => ({
    id: 7,
    role: 'cli',
    name: 'tester',
    subscribed: true,
    closed: false,
    transport: 'websocket',
    streams: new Map(),
    streamClosers: new Map(),
    nextStreamId: 1,
    sendText() {},
    sendBinary() {},
    ...overrides
  })
  const plugin = (methods: Record<string, unknown>[], activate: string) => {
    writeModulePlugin(installedDir, marker, {
      id: 'acme.tools',
      contributes: { method: methods }
    }, { activate })
    host.load()
  }
  const reject = async (promise: Promise<unknown>): Promise<DaemonError> => {
    const error = await promise.then(
      () => undefined,
      (caught) => caught
    )
    expect(error).toBeInstanceOf(DaemonError)
    return error as DaemonError
  }
  return {
    host,
    dispatcher,
    conn,
    plugin,
    reject,
    unanswered,
    logs,
    lines: () => readMarker(marker)
  }
}

function method(id: string, data: Record<string, unknown> = {}) {
  return { id, params: LOOSE, ...data }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function timeout(error: DaemonError, methodName = METHOD, timeoutMs = 1_000) {
  expect(error.code).toBe(RpcErrorCode.Timeout)
  expect(error.message).toBe(`${methodName} did not answer within ${timeoutMs} ms`)
  expect(error.data).toEqual({ reason: 'timeout', method: methodName, timeoutMs })
}

function boundWarnings(t: ReturnType<typeof setup>): number {
  return t.host.list().find((plugin) => plugin.id === 'acme.tools')?.diagnostics.filter((item) => item.message === BOUND_WARNING).length ?? 0
}

describe('Dispatcher method deadlines', () => {
  test('M1 times out at the declared method deadline and records the unanswered handler', async () => {
    const t = setup()
    t.plugin([method('read', { readOnly: true, timeout: '1s' })], `context.provide('${CONTRIBUTION}', async () => new Promise(() => {}))`)

    const started = Date.now()
    const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))

    timeout(error)
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000)
    expect(Date.now() - started).toBeLessThan(1_500)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(1)
    expect(t.logs).toContain(`method ${METHOD} in acme.tools did not answer within 1000 ms (1 unanswered)`)
    expect(boundWarnings(t)).toBe(0)
  })

  test('M2 chooses declared and default read deadlines but leaves unbounded methods alone', async () => {
    expect(methodTimeoutMs({ readOnly: true }, 300_000)).toBe(300_000)
    expect(methodTimeoutMs({}, 300_000)).toBeNull()
    expect(methodTimeoutMs({ readOnly: false }, 300_000)).toBeNull()
    expect(methodTimeoutMs({ timeout: '75s' }, 300_000)).toBe(75_000)
    expect(methodTimeoutMs({ readOnly: true, timeout: '2s' }, 300_000)).toBe(2_000)

    const t = setup({ readTimeoutMs: 200 })
    t.plugin([method('read', { readOnly: true })], `context.provide('${CONTRIBUTION}', async () => new Promise(() => {}))`)
    const started = Date.now()
    const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
    timeout(error, METHOD, 200)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('M3 lets a mutating method without a declared timeout finish past the read timeout', async () => {
    const t = setup({ readTimeoutMs: 200 })
    t.plugin([method('read')], `context.provide('${CONTRIBUTION}', async () => { await new Promise((resolve) => setTimeout(resolve, 600)); return 'done' })`)

    expect(await t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })).toBe('done')
    expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
    expect(t.logs.some((line) => line.includes(`method ${METHOD} in acme.tools did not answer`))).toBe(false)
  })

  test('M4 returns an in-time result without logging or counting it', async () => {
    const t = setup({ readTimeoutMs: 200 })
    t.plugin([method('read', { readOnly: true })], `context.provide('${CONTRIBUTION}', async () => { await new Promise((resolve) => setTimeout(resolve, 100)); return { ok: true } })`)

    expect(await t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })).toEqual({ ok: true })
    expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
    expect(t.logs).toEqual([])
  })

  test('M5 releases a late successful handler and logs but drops its value', async () => {
    const t = setup()
    t.plugin([method('read', { timeout: '1s' })], `context.provide('${CONTRIBUTION}', async () => { await new Promise((resolve) => setTimeout(resolve, 1300)); return 'late value' })`)

    const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
    timeout(error)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(1)
    await sleep(350)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
    expect(t.logs.some((line) => new RegExp(`^method ${METHOD.replace('/', '\\/')} in acme\\.tools answered \\d+ ms after its deadline$`).test(line))).toBe(true)
  })

  test('M5 handles a late rejection, logs its message and prevents an unhandled rejection', async () => {
    const t = setup()
    t.plugin([method('read', { timeout: '1s' })], `context.provide('${CONTRIBUTION}', async () => { await new Promise((resolve) => setTimeout(resolve, 1300)); throw new Error('boom') })`)
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown) => unhandled.push(reason)
    process.on('unhandledRejection', onUnhandled)
    try {
      const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      timeout(error)
      expect(t.unanswered.count(CONTRIBUTION)).toBe(1)
      await sleep(350)
      expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
      expect(t.logs).toContain(`method ${METHOD} in acme.tools failed after its deadline: boom`)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  test('M6 refuses forwarding after the caller deadline', async () => {
    const t = setup()
    t.plugin(
      [method('read', { timeout: '1s' }), method('other')],
      `context.provide('${CONTRIBUTION}', async (_params, caller) => {
        await new Promise((resolve) => setTimeout(resolve, 1300))
        try { await context.forward('acme.tools/other', {}, caller); record('forwarded') }
        catch (error) { record('forward-error:' + error.message) }
      })
      context.provide('method:acme.tools/other', () => { record('other-ran') })`
    )

    timeout(await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })))
    await sleep(350)
    expect(t.lines()).toContain('forward-error:forwarding caller is no longer active')
    expect(t.lines()).not.toContain('other-ran')
  })

  test('refuses forwarding past a deadline even when synchronous work delays its timer', async () => {
    const t = setup({ readTimeoutMs: 20 })
    t.plugin(
      [method('read', { readOnly: true }), method('other')],
      `context.provide('${CONTRIBUTION}', async (_params, caller) => {
        const until = Date.now() + 60
        while (Date.now() < until) {}
        try { await context.forward('acme.tools/other', {}, caller) }
        catch (error) { record('forward-error:' + error.message) }
      })
      context.provide('method:acme.tools/other', () => record('other-ran'))`
    )
    timeout(await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })), METHOD, 20)
    expect(t.lines()).toContain('forward-error:forwarding caller is no longer active')
    expect(t.lines()).not.toContain('other-ran')
  })

  test('M7 refuses at four unanswered handlers before resolving the fifth implementation', async () => {
    const t = setup({ readTimeoutMs: 25 })
    t.plugin([method('read', { readOnly: true })], `context.provide('${CONTRIBUTION}', async () => { record('ran'); return new Promise(() => {}) })`)
    const resolveImplementation = t.host.resolveImplementation.bind(t.host)
    let resolutions = 0
    t.host.resolveImplementation = async (id) => {
      resolutions++
      return resolveImplementation(id)
    }

    const first = await Promise.all(Array.from({ length: 4 }, () => t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))))
    first.forEach((error) => timeout(error, METHOD, 25))
    expect(t.unanswered.count(CONTRIBUTION)).toBe(4)
    expect(t.lines().filter((line) => line === 'ran')).toHaveLength(4)
    expect(boundWarnings(t)).toBe(1)
    const resolutionCountAtBound = resolutions

    for (let index = 0; index < 20; index++) {
      const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      expect(error.code).toBe(RpcErrorCode.Timeout)
      expect(error.message).toBe(`${METHOD} is not answering: 4 calls are still running past their deadline`)
      expect(error.data).toEqual({ reason: 'stalled', method: METHOD, unanswered: 4 })
    }
    expect(resolutions).toBe(resolutionCountAtBound)
    expect(t.lines().filter((line) => line === 'ran')).toHaveLength(4)
    expect(boundWarnings(t)).toBe(1)
  })
  test('M15 counts every concurrently admitted timeout and refuses only at the actual count', async () => {
    const t = setup()
    const globalState = globalThis as typeof globalThis & { __dispatchDeadlineResolvers?: (() => void)[] }
    globalState.__dispatchDeadlineResolvers = []
    t.plugin(
      [method('read', { readOnly: true, timeout: '1s' })],
      `context.provide('${CONTRIBUTION}', async () => {
        record('ran')
        const resolvers = globalThis.__dispatchDeadlineResolvers ??= []
        if (resolvers.length >= 6) return 'recovered'
        return new Promise((resolve) => resolvers.push(resolve))
      })`
    )
    const resolveImplementation = t.host.resolveImplementation.bind(t.host)
    let resolutions = 0
    t.host.resolveImplementation = async (id) => {
      resolutions++
      return resolveImplementation(id)
    }

    try {
      const started = Array.from({ length: 6 }, () => t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })))
      const invocationDeadline = Date.now() + 500
      while (globalState.__dispatchDeadlineResolvers!.length < 6 && Date.now() < invocationDeadline) await sleep(5)
      expect(globalState.__dispatchDeadlineResolvers).toHaveLength(6)
      const timedOut = await Promise.all(started)
      timedOut.forEach((error) => timeout(error))
      expect(t.unanswered.count(CONTRIBUTION)).toBe(6)
      expect(boundWarnings(t)).toBe(1)
      expect(t.lines().filter((line) => line === 'ran')).toHaveLength(6)

      const resolutionsAtBound = resolutions
      let refusedAt = Date.now()
      let refused = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      expect(Date.now() - refusedAt).toBeLessThan(100)
      expect(refused.code).toBe(RpcErrorCode.Timeout)
      expect(refused.message).toBe(`${METHOD} is not answering: 6 calls are still running past their deadline`)
      expect(refused.data).toEqual({ reason: 'stalled', method: METHOD, unanswered: 6 })
      expect(resolutions).toBe(resolutionsAtBound)
      expect(t.lines().filter((line) => line === 'ran')).toHaveLength(6)

      globalState.__dispatchDeadlineResolvers![0]!()
      globalState.__dispatchDeadlineResolvers![1]!()
      await sleep(0)
      expect(t.unanswered.count(CONTRIBUTION)).toBe(4)
      expect(boundWarnings(t)).toBe(1)
      refusedAt = Date.now()
      refused = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      expect(Date.now() - refusedAt).toBeLessThan(100)
      expect(refused.data).toEqual({ reason: 'stalled', method: METHOD, unanswered: 4 })
      expect(resolutions).toBe(resolutionsAtBound)

      globalState.__dispatchDeadlineResolvers![2]!()
      await sleep(0)
      expect(t.unanswered.count(CONTRIBUTION)).toBe(3)
      expect(boundWarnings(t)).toBe(0)
      expect(await t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })).toBe('recovered')
      expect(t.lines().filter((line) => line === 'ran')).toHaveLength(7)
    } finally {
      delete globalState.__dispatchDeadlineResolvers
    }
  })


  test('M8 removes the bound warning when a handler settles and permits a new call', async () => {
    const t = setup({ readTimeoutMs: 25 })
    t.plugin([method('read', { readOnly: true })], `let calls = 0
      context.provide('${CONTRIBUTION}', async () => {
        const call = ++calls
        record('ran-' + call)
        if (call === 1) { await new Promise((resolve) => setTimeout(resolve, 100)); return 'recovered' }
        if (call === 5) return 'next call'
        return new Promise(() => {})
      })`)

    const first = await Promise.all(Array.from({ length: 4 }, () => t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))))
    first.forEach((error) => timeout(error, METHOD, 25))
    expect(t.unanswered.count(CONTRIBUTION)).toBe(4)
    expect(boundWarnings(t)).toBe(1)
    await sleep(120)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(3)
    expect(boundWarnings(t)).toBe(0)
    expect(await t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })).toBe('next call')
    expect(t.lines().filter((line) => line.startsWith('ran-'))).toHaveLength(5)
  })

  test('M9 keeps unanswered counts across a plugin disable and enable', async () => {
    const t = setup({ readTimeoutMs: 25 })
    t.plugin([method('read', { readOnly: true })], `context.provide('${CONTRIBUTION}', async () => { record('ran'); return new Promise(() => {}) })`)
    const first = await Promise.all(Array.from({ length: 4 }, () => t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))))
    first.forEach((error) => timeout(error, METHOD, 25))
    expect(t.unanswered.count(CONTRIBUTION)).toBe(4)

    await t.host.setEnabled('acme.tools', false)
    await t.host.setEnabled('acme.tools', true)
    const error = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
    expect(error.code).toBe(RpcErrorCode.Timeout)
    expect(error.message).toBe(`${METHOD} is not answering: 4 calls are still running past their deadline`)
    expect(error.data).toEqual({ reason: 'stalled', method: METHOD, unanswered: 4 })
    expect(t.lines().filter((line) => line === 'ran')).toHaveLength(4)
    expect(boundWarnings(t)).toBe(1)
  })

  test('M10 records a mutating method timeout for the request ID before and after late completion', async () => {
    const t = setup()
    t.plugin([method('read', { timeout: '1s' })], `context.provide('${CONTRIBUTION}', async () => {
      record('ran')
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return 'late'
    })`)
    const source = { conn: t.conn() }
    const started = await t.reject(t.dispatcher.dispatch(METHOD, {}, source, { requestId: 'r1' }))
    timeout(started)
    const beforeSettle = await t.reject(t.dispatcher.dispatch(METHOD, {}, source, { requestId: 'r1' }))
    expect(beforeSettle).toMatchObject({ code: started.code, message: started.message, data: started.data })
    await sleep(550)
    const afterSettle = await t.reject(t.dispatcher.dispatch(METHOD, {}, source, { requestId: 'r1' }))
    expect(afterSettle).toMatchObject({ code: started.code, message: started.message, data: started.data })
    expect(t.lines().filter((line) => line === 'ran')).toHaveLength(1)
  })

  test('M11 applies plugin deadlines to plugin and kernel-sourced calls', async () => {
    const t = setup({ readTimeoutMs: 25 })
    t.plugin([method('read', { readOnly: true })], `context.provide('${CONTRIBUTION}', async () => new Promise(() => {}))`)

    for (const source of [{ pluginId: 'acme.caller' }, { kernel: true }] as const) {
      timeout(await t.reject(t.dispatcher.dispatch(METHOD, {}, source)), METHOD, 25)
    }
    expect(t.unanswered.count(CONTRIBUTION)).toBe(2)
  })

  test('M12 leaves kernel methods outside plugin deadlines', async () => {
    const t = setup({ readTimeoutMs: 200, statusHandler: async () => { await sleep(600); return 'kernel result' } })

    expect(await t.dispatcher.dispatch('status.get', {}, { kernel: true })).toBe('kernel result')
  })

  test('M13 starts the method clock after slow plugin activation', async () => {
    const t = setup()
    t.plugin(
      [method('read', { readOnly: true, timeout: '1s' })],
      `await new Promise((resolve) => setTimeout(resolve, 700))
      context.provide('${CONTRIBUTION}', async () => { await new Promise((resolve) => setTimeout(resolve, 600)); return 'ok' })`
    )
    const started = Date.now()

    expect(await t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() })).toBe('ok')
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_250)
    expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
  })

  test('M14 preserves an in-time DaemonError and converts an in-time ordinary error to Internal', async () => {
    const t = setup({ readTimeoutMs: 200 })
    t.plugin(
      [method('read', { readOnly: true })],
      `context.provide('${CONTRIBUTION}', async () => {
        record('run')
        if (globalThis.__dispatchDeadlineError === 'daemon') {
          const { notFound } = await import(${JSON.stringify(ERRORS_MODULE)})
          throw notFound('gone')
        }
        throw new Error('boom')
      })`
    )

    ;(globalThis as typeof globalThis & { __dispatchDeadlineError?: string }).__dispatchDeadlineError = 'daemon'
    try {
      const daemonError = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      expect(daemonError.code).toBe(RpcErrorCode.NotFound)
      expect(daemonError.message).toBe('gone')
      expect(t.unanswered.count(CONTRIBUTION)).toBe(0)

      ;(globalThis as typeof globalThis & { __dispatchDeadlineError?: string }).__dispatchDeadlineError = 'ordinary'
      const ordinaryError = await t.reject(t.dispatcher.dispatch(METHOD, {}, { conn: t.conn() }))
      expect(ordinaryError.code).toBe(RpcErrorCode.Internal)
      expect(ordinaryError.message).toBe('acme.tools: boom')
      expect(t.unanswered.count(CONTRIBUTION)).toBe(0)
    } finally {
      delete (globalThis as typeof globalThis & { __dispatchDeadlineError?: string }).__dispatchDeadlineError
    }
  })
})
