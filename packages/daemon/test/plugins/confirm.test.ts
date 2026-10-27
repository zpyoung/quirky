import { afterEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { RpcErrorCode, type MethodHandler, type PluginCaller } from '@quirky/protocol'
import { DaemonError } from '../../src/errors'
import type { Handlers } from '../../src/methods'
import type { KernelDescriber } from '../../src/plugins/confirm'
import { Dispatcher, type DispatchHost } from '../../src/plugins/dispatch'
import { Store } from '../../src/store'
import type { ClientConn } from '../../src/types'
import { makeTempDir, removeTempDirs } from './fixtures'

afterEach(removeTempDirs)

type StubMethod = { data?: Record<string, unknown>; run: MethodHandler }
type AskStatus = 'pending' | 'answered' | 'declined'
type AskRecord = { spec: any; session?: unknown; worktree?: unknown; status: AskStatus; value?: unknown }

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

const NAMED = { type: 'object', properties: { target: { type: 'string' }, name: { type: 'string' } } }

/** A fake `quirky.ask` plus a fixture plugin with destructive methods, one of them with a `describe` method. */
function setup(options: { asks?: boolean; kernelDescribers?: Record<string, KernelDescriber> } = {}) {
  const asks = new Map<string, AskRecord>()
  const ran: { method: string; params: Record<string, unknown> }[] = []
  const gone = new Set<string>()
  const methods: Record<string, StubMethod> = {
    'acme.tools/wipe': {
      data: { params: NAMED, destructive: true, confirm: 'Wipe {target}?' },
      run: (params) => {
        ran.push({ method: 'wipe', params })
        return { wiped: params.target }
      }
    },
    'acme.tools/rm': {
      data: { params: NAMED, destructive: true, confirm: 'Remove {name}?', describe: 'describeRm' },
      run: (params) => {
        ran.push({ method: 'rm', params })
        return { removed: params.name }
      }
    },
    'acme.tools/describeRm': {
      data: { params: NAMED, readOnly: true },
      run: (params, caller) => {
        if (gone.has(params.name as string)) throw new DaemonError(RpcErrorCode.NotFound, `no such target: ${params.name}`)
        if (params.name === 'quiet') return null
        if (params.name === 'odd') return 42
        const where = 'worktreeId' in caller ? caller.worktreeId : undefined
        return params.name === 'current' ? `Remove worktree ${where ?? 'none'}?` : `Remove worktree ${params.name}?`
      }
    },
    'acme.tools/plain': {
      data: { params: NAMED },
      run: (params) => ({ plain: params })
    }
  }
  if (options.asks !== false) {
    methods['quirky.ask/create'] = {
      data: { params: { type: 'object', additionalProperties: true } },
      run: (params) => {
        const askId = `ask_${asks.size + 1}`
        asks.set(askId, { spec: params.spec, session: params.session, worktree: params.worktree, status: 'pending' })
        return { askId }
      }
    }
    methods['quirky.ask/wait'] = {
      data: { params: { type: 'object', additionalProperties: true }, readOnly: true },
      run: (params) => {
        const ask = asks.get(params.askId as string)
        if (!ask) throw new DaemonError(RpcErrorCode.NotFound, `no such ask: ${params.askId}`)
        return {
          status: ask.status,
          askId: params.askId,
          answers: ask.status === 'answered' ? { confirm: { value: ask.value, source: 'input' } } : {},
          skipped: []
        }
      }
    }
  }
  const handlers = {
    'plugin.uninstall': (params: { id: string }) => {
      ran.push({ method: 'plugin.uninstall', params })
      return { ok: true }
    }
  } as unknown as Handlers
  const store = new Store(join(makeTempDir(), 'q.db'))
  const dispatcher = new Dispatcher(handlers, stubHost(methods), () => {}, { store, kernelDescribers: options.kernelDescribers })
  const answer = (askId: string, value: boolean) => {
    const ask = asks.get(askId)!
    ask.status = 'answered'
    ask.value = value
  }
  const decline = (askId: string) => {
    asks.get(askId)!.status = 'declined'
  }
  return { dispatcher, asks, ran, gone, answer, decline, store }
}

async function failure(promise: Promise<unknown>): Promise<DaemonError> {
  const error = await promise.then(
    () => undefined,
    (caught) => caught
  )
  expect(error).toBeInstanceOf(DaemonError)
  return error as DaemonError
}

async function askFor(t: ReturnType<typeof setup>, method: string, params: Record<string, unknown>, from: ClientConn) {
  const error = await failure(t.dispatcher.dispatch(method, params, { conn: from }))
  expect(error.code).toBe(RpcErrorCode.ConfirmationRequired)
  return error.data as { askId: string; action: string }
}

describe('destructive methods', () => {
  test('SC-48: a plugin method declaring destructive asks with its filled confirm text', async () => {
    const t = setup()
    const data = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, conn(1))
    expect(data.action).toBe('Wipe cache?')
    expect(t.asks.get(data.askId)!.spec).toEqual({
      title: 'Confirm',
      questions: [{ id: 'confirm', type: 'confirm', question: 'Wipe cache?' }]
    })
    expect(t.ran).toEqual([])
  })

  test('SC-48: the ask carries the caller session and worktree when present', async () => {
    const t = setup()
    const data = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, conn(1, { sessionId: 's1', worktreeId: 'w1' }))
    expect(t.asks.get(data.askId)).toMatchObject({ session: 's1', worktree: 'w1' })
    const bare = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, conn(2))
    expect(t.asks.get(bare.askId)!.session).toBeUndefined()
    expect(t.asks.get(bare.askId)!.worktree).toBeUndefined()
  })

  test('SC-44: yes runs it at once, creates no ask and hides yes from the handler', async () => {
    const t = setup()
    expect(await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', yes: true }, { conn: conn(1) })).toEqual({
      wiped: 'cache'
    })
    expect(t.asks.size).toBe(0)
    expect(t.ran[0]!.params).toEqual({ target: 'cache' })
  })

  test('SC-43: the two-step flow runs once the ask is answered yes', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    t.answer(askId, true)
    const result = await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from })
    expect(result).toEqual({ wiped: 'cache' })
    expect(t.ran).toEqual([{ method: 'wipe', params: { target: 'cache' } }])
  })

  test('SC-45: a confirmation cannot be used twice', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    t.answer(askId, true)
    await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from })
    const error = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('confirmation already used')
    expect(t.ran).toHaveLength(1)
  })

  test('SC-45: replaying a used confirmation after its target is gone says it was used, not that the target is missing', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/rm', { name: 'feature-x' }, from)
    t.answer(askId, true)
    await t.dispatcher.dispatch('acme.tools/rm', { name: 'feature-x', confirmation: askId }, { conn: from })
    t.gone.add('feature-x')
    const error = await failure(t.dispatcher.dispatch('acme.tools/rm', { name: 'feature-x', confirmation: askId }, { conn: from }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('confirmation already used')
  })

  test('SC-45: a confirmation cannot move to other params and stays usable for its own', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    t.answer(askId, true)
    const error = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'logs', confirmation: askId }, { conn: from }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('confirmation is for another call')
    expect(t.ran).toEqual([])
    expect(await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from })).toEqual({
      wiped: 'cache'
    })
  })

  test('SC-45: a confirmation for another method or an unknown ask is refused', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    t.answer(askId, true)
    const other = await failure(t.dispatcher.dispatch('acme.tools/rm', { name: 'cache', confirmation: askId }, { conn: from }))
    expect(other.message).toBe('confirmation is for another call')
    const unknown = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: 'ask_nope' }, { conn: from }))
    expect(unknown.message).toBe('confirmation is for another call')
  })

  test('SC-45: a confirmation made from one worktree does not authorize the call from another', async () => {
    const t = setup()
    const inFixLogin = conn(1, { worktreeId: 'fix-login', cwd: '/w/fix-login' })
    const inMain = conn(2, { worktreeId: 'main', cwd: '/w/main' })
    const { askId, action } = await askFor(t, 'acme.tools/rm', { name: 'current' }, inFixLogin)
    expect(action).toBe('Remove worktree fix-login?')
    t.answer(askId, true)
    const error = await failure(t.dispatcher.dispatch('acme.tools/rm', { name: 'current', confirmation: askId }, { conn: inMain }))
    expect(error.message).toBe('confirmation is for another call')
    expect(t.ran).toEqual([])
    expect(await t.dispatcher.dispatch('acme.tools/rm', { name: 'current', confirmation: askId }, { conn: inFixLogin })).toEqual({
      removed: 'current'
    })
  })

  test('SC-45: a confirmation is bound to the caller cwd and session even when the action text matches', async () => {
    const t = setup()
    const first = conn(1, { cwd: '/w/a', sessionId: 's1' })
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, first)
    t.answer(askId, true)
    for (const other of [conn(2, { cwd: '/w/b', sessionId: 's1' }), conn(3, { cwd: '/w/a', sessionId: 's2' }), conn(4)]) {
      const error = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: other }))
      expect(error.message).toBe('confirmation is for another call')
    }
  })

  test('the action text comes from the describe method with the same caller and params', async () => {
    const t = setup()
    const data = await askFor(t, 'acme.tools/rm', { name: 'feature-x' }, conn(1))
    expect(data.action).toBe('Remove worktree feature-x?')
    expect(t.asks.get(data.askId)!.spec.questions[0].question).toBe('Remove worktree feature-x?')
  })

  test('SC-14: a describe method returning null runs the call with no ask', async () => {
    const t = setup()
    expect(await t.dispatcher.dispatch('acme.tools/rm', { name: 'quiet' }, { conn: conn(1) })).toEqual({ removed: 'quiet' })
    expect(t.asks.size).toBe(0)
    expect(t.ran).toEqual([{ method: 'rm', params: { name: 'quiet' } }])
  })

  test('SC-14: a null describe still checks an explicit confirmation is unused and consumes none', async () => {
    const t = setup()
    const from = conn(1)
    const stale = await failure(t.dispatcher.dispatch('acme.tools/rm', { name: 'quiet', confirmation: 'ask_missing' }, { conn: from }))
    expect(stale.code).toBe(RpcErrorCode.Conflict)
    expect(stale.message).toBe('confirmation is for another call')

    const { askId } = await askFor(t, 'acme.tools/rm', { name: 'feature-x' }, from)
    t.answer(askId, true)
    expect(await t.dispatcher.dispatch('acme.tools/rm', { name: 'quiet', confirmation: askId }, { conn: from })).toEqual({ removed: 'quiet' })
    expect(t.store.getConfirmation(askId)!.used).toBe(false)
  })

  test('SC-14: a describe method returning a string still asks', async () => {
    const t = setup()
    const data = await askFor(t, 'acme.tools/rm', { name: 'feature-x' }, conn(1))
    expect(data.action).toBe('Remove worktree feature-x?')
    expect(t.ran).toEqual([])
  })

  test('a describe method returning a non-string, non-null value is Internal', async () => {
    const t = setup()
    const error = await failure(t.dispatcher.dispatch('acme.tools/rm', { name: 'odd' }, { conn: conn(1) }))
    expect(error.code).toBe(RpcErrorCode.Internal)
    expect(t.ran).toEqual([])
  })

  test('a confirmation that is still unanswered or declined is refused with its reason', async () => {
    const t = setup()
    const from = conn(1)
    const { askId } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    const pending = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from }))
    expect(pending.code).toBe(RpcErrorCode.Conflict)
    expect(pending.message).toBe('confirmation not answered yet')

    t.decline(askId)
    const declined = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: askId }, { conn: from }))
    expect(declined.code).toBe(RpcErrorCode.Conflict)
    expect(declined.message).toBe('declined')

    const { askId: second } = await askFor(t, 'acme.tools/wipe', { target: 'cache' }, from)
    t.answer(second, false)
    const no = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', confirmation: second }, { conn: from }))
    expect(no.message).toBe('declined')
    expect(t.ran).toEqual([])
  })

  test('SC-46: with quirky.ask off, a destructive call says to pass yes', async () => {
    const t = setup({ asks: false })
    const error = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache' }, { conn: conn(1) }))
    expect(error.code).toBe(RpcErrorCode.Conflict)
    expect(error.message).toBe('this action needs confirmation and asks are off; pass --yes')
    expect(await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', yes: true }, { conn: conn(1) })).toEqual({
      wiped: 'cache'
    })
  })

  test('a kernel destructive method asks with its schema confirm text', async () => {
    const t = setup()
    const from = conn(1)
    const { askId, action } = await askFor(t, 'plugin.uninstall', { id: 'acme.tools' }, from)
    expect(action).toBe('Uninstall plugin acme.tools?')
    t.answer(askId, true)
    expect(await t.dispatcher.dispatch('plugin.uninstall', { id: 'acme.tools', confirmation: askId }, { conn: from })).toEqual({ ok: true })
    expect(t.ran).toEqual([{ method: 'plugin.uninstall', params: { id: 'acme.tools' } }])
  })

  test('a kernel describer supplies the action text and the confirmation is bound to it', async () => {
    let listing = 'acme.tools 1.0.0 (Acme)'
    const t = setup({
      kernelDescribers: { 'plugin.uninstall': async (params) => `Uninstall plugin ${params.id}?\n\n${listing}` }
    })
    const from = conn(1)
    const { askId, action } = await askFor(t, 'plugin.uninstall', { id: 'acme.tools' }, from)
    expect(action).toBe('Uninstall plugin acme.tools?\n\nacme.tools 1.0.0 (Acme)')
    expect(t.asks.get(askId)!.spec.questions[0].question).toBe(action)
    t.answer(askId, true)

    listing = 'acme.tools 1.1.0 (Acme)'
    const changed = await failure(t.dispatcher.dispatch('plugin.uninstall', { id: 'acme.tools', confirmation: askId }, { conn: from }))
    expect(changed.message).toBe('confirmation is for another call')

    listing = 'acme.tools 1.0.0 (Acme)'
    expect(await t.dispatcher.dispatch('plugin.uninstall', { id: 'acme.tools', confirmation: askId }, { conn: from })).toEqual({ ok: true })
  })

  test('kernel-internal calls are never confirmed', async () => {
    const t = setup()
    expect(await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache' }, { kernel: true })).toEqual({ wiped: 'cache' })
    expect(t.asks.size).toBe(0)
  })

  test('a non-destructive method keeps yes and confirmation so its schema rejects them', async () => {
    const t = setup()
    const error = await failure(t.dispatcher.dispatch('acme.tools/plain', { target: 'a', yes: true }, { conn: conn(1) }))
    expect(error.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a malformed yes or confirmation is InvalidParams', async () => {
    const t = setup()
    const yes = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'a', yes: 'sure' }, { conn: conn(1) }))
    expect(yes.code).toBe(RpcErrorCode.InvalidParams)
    const confirmation = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'a', confirmation: 3 }, { conn: conn(1) }))
    expect(confirmation.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a ConfirmationRequired outcome is recorded under its request ID', async () => {
    const t = setup()
    const options = { requestId: 'r-1' }
    const first = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache' }, { conn: conn(1) }, options))
    const second = await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache' }, { conn: conn(1) }, options))
    expect(second.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(second.data).toEqual(first.data)
    expect(t.asks.size).toBe(1)
  })

  test('yes does not change the request digest, so a confirmed call needs a fresh ID', async () => {
    const t = setup()
    await failure(t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache' }, { conn: conn(1) }, { requestId: 'r-1' }))
    const replay = await failure(
      t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', yes: true }, { conn: conn(1) }, { requestId: 'r-1' })
    )
    expect(replay.code).toBe(RpcErrorCode.ConfirmationRequired)
    expect(await t.dispatcher.dispatch('acme.tools/wipe', { target: 'cache', yes: true }, { conn: conn(1) }, { requestId: 'r-2' })).toEqual({
      wiped: 'cache'
    })
  })
})

describe('caller identity', () => {
  function callerSetup() {
    const seen: PluginCaller[] = []
    const record: MethodHandler = (_params, caller) => {
      seen.push(caller)
      return null
    }
    const host = stubHost({
      'acme.tools/plain': { data: { params: { type: 'object' } }, run: record },
      'acme.tools/stream': { data: { params: { type: 'object' }, connection: true }, run: record }
    })
    const dispatcher = new Dispatcher({} as Handlers, host, () => {}, { store: new Store(join(makeTempDir(), 'q.db')) })
    return { seen, dispatcher }
  }

  test('a connection caller carries role, name, cwd, session and worktree', async () => {
    const t = callerSetup()
    await t.dispatcher.dispatch(
      'acme.tools/plain',
      {},
      { conn: conn(1, { role: 'ui', name: 'win', cwd: '/w', sessionId: 's', worktreeId: 'wt' }) }
    )
    expect(t.seen[0]).toEqual({ role: 'ui', name: 'win', cwd: '/w', sessionId: 's', worktreeId: 'wt' })
    await t.dispatcher.dispatch('acme.tools/plain', {}, { conn: conn(2, { name: undefined }) })
    expect(t.seen[1]).toEqual({ role: 'cli' })
    expect(Object.keys(t.seen[1]!)).toEqual(['role'])
  })

  test('a plugin caller is the plugin and a kernel call is plugin kernel', async () => {
    const t = callerSetup()
    await t.dispatcher.dispatch('acme.tools/plain', {}, { pluginId: 'acme.other' })
    await t.dispatcher.dispatch('acme.tools/plain', {}, { kernel: true })
    expect(t.seen).toEqual([
      { role: 'plugin', pluginId: 'acme.other' },
      { role: 'plugin', pluginId: 'kernel' }
    ])
  })

  test('a connection: true method gets the connection and refuses plugin and kernel callers', async () => {
    const t = callerSetup()
    await t.dispatcher.dispatch('acme.tools/stream', {}, { conn: conn(9, { transport: 'socket' }) })
    const caller = t.seen[0] as Exclude<PluginCaller, { role: 'plugin' }>
    expect(caller.connection).toMatchObject({ id: 9, transport: 'socket' })
    expect(typeof caller.connection!.openStream).toBe('function')

    for (const from of [{ pluginId: 'acme.other' }, { kernel: true as const }]) {
      const error = await failure(t.dispatcher.dispatch('acme.tools/stream', {}, from))
      expect(error.code).toBe(RpcErrorCode.InvalidParams)
      expect(error.message).toBe('acme.tools/stream needs a client connection')
    }
    await t.dispatcher.dispatch('acme.tools/plain', {}, { conn: conn(1) })
    expect((t.seen[1] as { connection?: unknown }).connection).toBeUndefined()
  })
})
