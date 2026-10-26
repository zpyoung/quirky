import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type MethodHandler } from '@quirky/protocol'
import { DaemonError } from '../../src/errors'
import type { Handlers } from '../../src/methods'
import { Dispatcher, type DispatchHost } from '../../src/plugins/dispatch'
import { RequestLog, requestDigest } from '../../src/plugins/requests'
import { Store } from '../../src/store'
import type { ClientConn } from '../../src/types'
import { makeTempDir, removeTempDirs } from './fixtures'

afterEach(removeTempDirs)

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const OPEN = { type: 'object', additionalProperties: true, properties: { name: { type: 'string' } } }

type StubMethod = { data?: Record<string, unknown>; run: MethodHandler }

function stubHost(methods: Record<string, StubMethod>): DispatchHost {
  const contributions = Object.entries(methods).map(([name, method]) => ({
    id: `method:${name}`,
    kind: 'method',
    name: name.slice(name.indexOf('/') + 1),
    plugin: name.slice(0, name.indexOf('/')),
    override: false,
    status: 'active',
    data: method.data ?? {}
  }))
  return {
    contributions: (filter?: { kind?: string }) => (filter?.kind === 'method' ? contributions : []),
    resolveImplementation: async (id: string) => methods[id.slice('method:'.length)]!.run
  } as unknown as DispatchHost
}

function conn(id: number, overrides: Partial<ClientConn> = {}): ClientConn {
  return {
    id,
    role: 'cli',
    name: `c${id}`,
    subscribed: false,
    closed: false,
    transport: 'websocket',
    streams: new Map(),
    streamClosers: new Map(),
    nextStreamId: 1,
    sendText() {},
    sendBinary() {},
    ...overrides
  }
}

function setup() {
  const dir = makeTempDir()
  const dbPath = join(dir, 'q.db')
  const runs = { create: 0, list: 0, enable: 0, jobList: 0 }
  const gate: { release: () => void } = { release: () => {} }
  const clock = { now: 1_000_000 }
  const host = stubHost({
    'acme.tools/create': {
      data: { params: OPEN },
      run: (params) => ({ made: params.name, n: ++runs.create })
    },
    'acme.tools/fail': {
      data: { params: OPEN },
      run: () => {
        throw new DaemonError(RpcErrorCode.NotFound, 'no such thing', { hint: 'x' })
      }
    },
    'acme.tools/boom': {
      data: { params: OPEN },
      run: () => {
        throw new Error('exploded')
      }
    },
    'acme.tools/list': {
      data: { params: OPEN, readOnly: true },
      run: () => ({ n: ++runs.list })
    },
    'acme.tools/slow': {
      data: { params: OPEN },
      run: async (params) => {
        runs.create++
        await new Promise<void>((resolve) => (gate.release = resolve))
        return { slow: params.name }
      }
    }
  })
  const handlers = {
    'plugin.enable': (params: { id: string }) => ({ id: 'r1', target: params.id, n: ++runs.enable }),
    'job.list': () => ({ n: ++runs.jobList }),
    'events.subscribe': () => ({ ok: true })
  } as unknown as Handlers
  const open = () => {
    const store = new Store(dbPath)
    const dispatcher = new Dispatcher(handlers, host, () => {}, { store, now: () => clock.now })
    return { store, dispatcher }
  }
  return { ...open(), open, runs, gate, clock }
}

async function failure(promise: Promise<unknown>): Promise<DaemonError> {
  const error = await promise.then(
    () => undefined,
    (caught) => caught
  )
  expect(error).toBeInstanceOf(DaemonError)
  return error as DaemonError
}

describe('request IDs', () => {
  test('SC-11: a retried call returns the first outcome without running again', async () => {
    const t = setup()
    const first = await t.dispatcher.dispatch('acme.tools/create', { name: 'feature-x' }, { conn: conn(1) }, { requestId: 'r-1' })
    const second = await t.dispatcher.dispatch('acme.tools/create', { name: 'feature-x' }, { conn: conn(2) }, { requestId: 'r-1' })
    expect(second).toEqual(first)
    expect(first).toEqual({ made: 'feature-x', n: 1 })
    expect(t.runs.create).toBe(1)
  })

  test('SC-11: key order in params does not change the digest', async () => {
    const t = setup()
    await t.dispatcher.dispatch('acme.tools/create', { name: 'x', extra: { b: 1, a: 2 } }, { conn: conn(1) }, { requestId: 'r-k' })
    await t.dispatcher.dispatch('acme.tools/create', { extra: { a: 2, b: 1 }, name: 'x' }, { conn: conn(1) }, { requestId: 'r-k' })
    expect(t.runs.create).toBe(1)
  })

  test('SC-11: a failed call replays its error, code, message and data', async () => {
    const t = setup()
    const first = await failure(t.dispatcher.dispatch('acme.tools/fail', { name: 'a' }, { conn: conn(1) }, { requestId: 'r-e' }))
    const second = await failure(t.dispatcher.dispatch('acme.tools/fail', { name: 'a' }, { conn: conn(1) }, { requestId: 'r-e' }))
    expect(second.code).toBe(RpcErrorCode.NotFound)
    expect(second.message).toBe(first.message)
    expect(second.data).toEqual({ hint: 'x' })
  })

  test('SC-11: an unexpected plugin failure is recorded as Internal and replayed', async () => {
    const t = setup()
    const first = await failure(t.dispatcher.dispatch('acme.tools/boom', {}, { conn: conn(1) }, { requestId: 'r-b' }))
    const second = await failure(t.dispatcher.dispatch('acme.tools/boom', {}, { conn: conn(1) }, { requestId: 'r-b' }))
    expect(first.code).toBe(RpcErrorCode.Internal)
    expect(second.code).toBe(RpcErrorCode.Internal)
    expect(second.message).toBe(first.message)
  })

  test('SC-12: a reused request ID with different params is refused and runs nothing', async () => {
    const t = setup()
    await t.dispatcher.dispatch('acme.tools/create', { name: 'feature-x' }, { conn: conn(1) }, { requestId: 'r-1' })
    const error = await failure(
      t.dispatcher.dispatch('acme.tools/create', { name: 'feature-y' }, { conn: conn(1) }, { requestId: 'r-1' })
    )
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('request ID reused with different params')
    expect(t.runs.create).toBe(1)
  })

  test('SC-12: the method name is part of the digest', async () => {
    const t = setup()
    await t.dispatcher.dispatch('acme.tools/create', {}, { conn: conn(1) }, { requestId: 'r-1' })
    const error = await failure(t.dispatcher.dispatch('acme.tools/fail', {}, { conn: conn(1) }, { requestId: 'r-1' }))
    expect(error.message).toBe('request ID reused with different params')
  })

  test('SC-13: a retry while the first call runs waits for it', async () => {
    const t = setup()
    const first = t.dispatcher.dispatch('acme.tools/slow', { name: 'z' }, { conn: conn(1) }, { requestId: 'r-s' })
    await Bun.sleep(10)
    const second = t.dispatcher.dispatch('acme.tools/slow', { name: 'z' }, { conn: conn(2) }, { requestId: 'r-s' })
    await Bun.sleep(10)
    t.gate.release()
    expect(await first).toEqual({ slow: 'z' })
    expect(await second).toEqual({ slow: 'z' })
    expect(t.runs.create).toBe(1)
  })

  test('SC-13: a running call with the same ID and other params is a Conflict', async () => {
    const t = setup()
    const first = t.dispatcher.dispatch('acme.tools/slow', { name: 'z' }, { conn: conn(1) }, { requestId: 'r-s' })
    await Bun.sleep(10)
    const error = await failure(t.dispatcher.dispatch('acme.tools/slow', { name: 'other' }, { conn: conn(2) }, { requestId: 'r-s' }))
    expect(error.message).toBe('request ID reused with different params')
    t.gate.release()
    await first
  })

  test('SC-14: read-only calls are never recorded', async () => {
    const t = setup()
    await t.dispatcher.dispatch('acme.tools/list', {}, { conn: conn(1) }, { requestId: 'r-2' })
    await t.dispatcher.dispatch('acme.tools/list', {}, { conn: conn(1) }, { requestId: 'r-2' })
    await t.dispatcher.dispatch('job.list', {}, { conn: conn(1) }, { requestId: 'r-2k' })
    await t.dispatcher.dispatch('job.list', {}, { conn: conn(1) }, { requestId: 'r-2k' })
    expect(t.runs.list).toBe(2)
    expect(t.runs.jobList).toBe(2)
    expect(t.store.getRequest('r-2')).toBeNull()
  })

  test('SC-14: connection methods are never recorded', async () => {
    const t = setup()
    await t.dispatcher.dispatch('events.subscribe', {}, { conn: conn(1) }, { requestId: 'r-c' })
    expect(t.store.getRequest('r-c')).toBeNull()
  })

  test('SC-14: records survive a restart and expire after 24 hours', async () => {
    const t = setup()
    const first = await t.dispatcher.dispatch('plugin.enable', { id: 'acme.web' }, { conn: conn(1) }, { requestId: 'r-3' })
    t.store.close()
    const restarted = t.open()
    expect(await restarted.dispatcher.dispatch('plugin.enable', { id: 'acme.web' }, { conn: conn(1) }, { requestId: 'r-3' })).toEqual(first)
    expect(t.runs.enable).toBe(1)

    t.clock.now += DAY + 1
    const again = await restarted.dispatcher.dispatch('plugin.enable', { id: 'acme.web' }, { conn: conn(1) }, { requestId: 'r-3' })
    expect(again).toEqual({ id: 'r1', target: 'acme.web', n: 2 })
  })

  test('calls without a request ID, or from a plugin, are not recorded', async () => {
    const t = setup()
    await t.dispatcher.dispatch('acme.tools/create', {}, { conn: conn(1) })
    await t.dispatcher.dispatch('acme.tools/create', {}, { pluginId: 'acme.other' }, { requestId: 'r-p' })
    await t.dispatcher.dispatch('acme.tools/create', {}, { kernel: true }, { requestId: 'r-k' })
    expect(t.runs.create).toBe(3)
    expect(t.store.getRequest('r-p')).toBeNull()
    expect(t.store.getRequest('r-k')).toBeNull()
  })

  test('a call that fails params validation is not recorded', async () => {
    const t = setup()
    const error = await failure(t.dispatcher.dispatch('acme.tools/create', { name: 5 }, { conn: conn(1) }, { requestId: 'r-v' }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
    expect(t.store.getRequest('r-v')).toBeNull()
  })
})

describe('RequestLog pruning', () => {
  const outcome = { result: 1 }

  test('rows older than 24 hours are deleted on construction', () => {
    const store = new Store(join(makeTempDir(), 'q.db'))
    store.putRequest({ requestId: 'old', digest: 'd', outcome, createdAt: 0 })
    store.putRequest({ requestId: 'new', digest: 'd', outcome, createdAt: DAY })
    const lines: string[] = []
    new RequestLog(store, { now: () => DAY + 1, log: (line) => lines.push(line) })
    expect(store.getRequest('old')).toBeNull()
    expect(store.getRequest('new')).not.toBeNull()
    expect(lines.join('\n')).toContain('1')
  })

  test('a write prunes at most once an hour', async () => {
    const store = new Store(join(makeTempDir(), 'q.db'))
    let now = 10 * DAY
    const log = new RequestLog(store, { now: () => now })
    store.putRequest({ requestId: 'stale-1', digest: 'd', outcome, createdAt: now - DAY - 1 })
    now += 1000
    await log.run('a', 'd', async () => 1)
    expect(store.getRequest('stale-1')).not.toBeNull()

    now += HOUR
    await log.run('b', 'd', async () => 1)
    expect(store.getRequest('stale-1')).toBeNull()
    expect(store.getRequest('b')).not.toBeNull()
  })
})

describe('requestDigest', () => {
  test('is stable under key order and differs by method and params', () => {
    expect(requestDigest('m', { a: 1, b: { c: 2, d: 3 } })).toBe(requestDigest('m', { b: { d: 3, c: 2 }, a: 1 }))
    expect(requestDigest('m', { a: 1 })).not.toBe(requestDigest('n', { a: 1 }))
    expect(requestDigest('m', { a: 1 })).not.toBe(requestDigest('m', { a: 2 }))
    expect(requestDigest('m', { a: 1 })).toMatch(/^[0-9a-f]{64}$/)
  })
})
