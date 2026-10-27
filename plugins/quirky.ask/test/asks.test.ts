import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type Ask, type AskEnvelope, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { writePlugin } from '../../../packages/daemon/test/plugins/fixtures'
import {
  askOnlyPluginsDir,
  cleanupAll,
  connectAs,
  deploy,
  errorOf,
  migratedStore,
  openWindow,
  PANEL,
  spec,
  startAsk,
  stopKeepingHome,
  testCli
} from './support'
import { commands } from '../cli'
import { AskService, type AskServiceHooks } from '../asks'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  h = await startAsk()
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(cleanupAll)

const errors = {
  invalidParams: (m: string) => new Error(m),
  notFound: (m: string) => new Error(m),
  conflict: (m: string) => new Error(m)
}
const noHooks: AskServiceHooks = { created: () => {}, surfaced: () => {}, updated: () => {}, resolved: () => {} }

const call = (method: string, params: Record<string, unknown> = {}) => client.callAny(`quirky.ask/${method}`, params) as Promise<any>

describe('asks', () => {
  test('create stores a pending ask, emits created and notify', async () => {
    const { askId } = await call('create', { spec })
    expect(askId).toMatch(/^ask_/)
    const [ask] = await call('list', { pendingOnly: true })
    expect(ask).toMatchObject({
      id: askId,
      spec,
      sessionId: null,
      worktreeId: null,
      queued: false,
      partial: {},
      expiresAt: null,
      envelope: { status: 'pending', askId, answers: {}, skipped: [], summary: '' }
    })
    expect(ask.seq).toBe(1)
    const created = await waitFor(() => events.find((e) => e.type === 'quirky.ask/created'))
    expect(created).toMatchObject({ data: { ask: { id: askId }, seq: 1 } })
    expect(events.find((e) => e.type === 'notify')).toMatchObject({ title: 'Deploy?', body: 'Which environment?' })
  })

  test('a spec without a title notifies as Question', async () => {
    await call('create', { spec: { questions: [{ id: 'a', type: 'text', question: 'Name?' }] } })
    expect(await waitFor(() => events.find((e) => e.type === 'notify'))).toMatchObject({ title: 'Question', body: 'Name?' })
  })

  test('session and worktree default from the caller and params override them', async () => {
    const asker = await connectAs(h, { sessionId: 'sess_7', worktreeId: 'wt_7' })
    const first = await asker.callAny('quirky.ask/create', { spec })
    const second = await asker.callAny('quirky.ask/create', { spec, session: 'sess_8', worktree: 'wt_8' })
    const asks = (await call('list')) as { id: string; sessionId: string | null; worktreeId: string | null }[]
    const byId = new Map(asks.map((ask) => [ask.id, ask]))
    expect(byId.get((first as any).askId)).toMatchObject({ sessionId: 'sess_7', worktreeId: 'wt_7' })
    expect(byId.get((second as any).askId)).toMatchObject({ sessionId: 'sess_8', worktreeId: 'wt_8' })
    const notify = events.filter((e) => e.type === 'notify')
    await waitFor(() => events.filter((e) => e.type === 'notify').length === 2)
    expect(notify[0]).toMatchObject({ sessionId: 'sess_7', worktreeId: 'wt_7' })
  })

  test('answer resolves a waiting long-poll immediately', async () => {
    const { askId } = await call('create', { spec })
    const started = Date.now()
    const waiting = call('wait', { askId, timeoutMs: 10000 })
    await Bun.sleep(30)
    const envelope = await call('answer', {
      askId,
      answers: {
        env: { value: 'prod', source: 'option' },
        why: { value: 'ship it', source: 'input' }
      }
    })
    expect(envelope.status).toBe('answered')
    expect(await waiting).toEqual(envelope)
    expect(Date.now() - started).toBeLessThan(2000)
    await waitFor(() => events.find((e) => e.type === 'quirky.ask/resolved' && (e as any).data.askId === askId))
    expect(await call('list', { pendingOnly: true })).toEqual([])
    expect(await call('wait', { askId })).toEqual(envelope)
  })

  test('skipped questions give status partial', async () => {
    const { askId } = await call('create', { spec })
    const envelope = await call('answer', { askId, answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] })
    expect(envelope).toEqual({
      status: 'partial',
      askId,
      answers: { env: { value: 'dev', label: 'Dev', source: 'option' } },
      skipped: ['why'],
      summary: 'Which environment?: Dev'
    })
  })

  test('cancel declines, wakes waiters and is idempotent; answering afterwards conflicts', async () => {
    const { askId } = await call('create', { spec })
    const waiting = call('wait', { askId, timeoutMs: 10000 })
    const cancelled = await call('cancel', { askId })
    expect(cancelled.status).toBe('declined')
    expect((await waiting).status).toBe('declined')
    expect(await call('cancel', { askId })).toEqual(cancelled)
    expect((await errorOf(call('answer', { askId, answers: {} })))?.code).toBe(RpcErrorCode.Conflict)
  })

  test('wait returns pending when the timeout passes, and at once for timeoutMs 0', async () => {
    const { askId } = await call('create', { spec })
    const started = Date.now()
    expect(await call('wait', { askId, timeoutMs: 80 })).toMatchObject({ status: 'pending', askId })
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
    const immediate = Date.now()
    expect(await call('wait', { askId, timeoutMs: 0 })).toMatchObject({ status: 'pending', askId })
    expect(Date.now() - immediate).toBeLessThan(60)
  })

  test('disabling the plugin during a wait settles the waiter and leaves no timer touching the closed store', async () => {
    const { askId } = await call('create', { spec })
    const waiting = errorOf(call('wait', { askId, timeoutMs: 150 }))
    await Bun.sleep(30)
    await client.call('plugin.disable', { id: 'quirky.ask' })
    expect(await waiting).not.toBeNull()
    // outlast the original timeout: a surviving timer would throw "store is closed" uncaught
    await Bun.sleep(250)
  })

  test('shutdown rejects pending waiters and stops their timers', async () => {
    let closed = false
    const inner = migratedStore()
    const store = {
      ...inner,
      run: inner.run,
      transaction: inner.transaction,
      get: (sql: string, ...params: never[]) => {
        if (closed) throw new Error('store is closed')
        return inner.get(sql, ...params)
      },
      all: (sql: string, ...params: never[]) => {
        if (closed) throw new Error('store is closed')
        return inner.all(sql, ...params)
      }
    }
    const service = new AskService(store as never, errors, noHooks)
    const ask = service.create(spec, null, null, { checkCredentialText: true })
    const waiting = errorOf(service.wait(ask.id, 50))
    service.shutdown()
    closed = true
    expect(await waiting).toMatchObject({ message: expect.stringContaining('shut down') })
    await Bun.sleep(100)
    expect(await errorOf(service.wait(ask.id, 50))).not.toBeNull()
  })

  test('validates input and unknown ids', async () => {
    expect((await errorOf(call('create', {})))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await errorOf(call('create', { spec: { questions: [] } })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await errorOf(call('create', { spec: { questions: [{ id: 'a', type: 'select', question: 'q' }] } })))?.code).toBe(
      RpcErrorCode.InvalidParams
    )
    expect((await errorOf(call('cancel', { askId: 'ask_nope' })))?.code).toBe(RpcErrorCode.NotFound)
    const { askId } = await call('create', { spec })
    expect((await errorOf(call('answer', { askId, answers: 'x' })))?.code).toBe(RpcErrorCode.InvalidParams)
  })

  test('a confirmation-style spec with a title is accepted', async () => {
    const { askId } = await call('create', { spec: { title: 'Confirm', questions: [{ id: 'confirm', type: 'confirm', question: 'Remove it?' }] } })
    expect(askId).toMatch(/^ask_/)
  })
})

describe('restart', () => {
  test('SC-30: the ask is still pending and answerable, and a CLI wait reconnects and keeps waiting', async () => {
    const asker = await connectAs(h, { sessionId: 'sess_1' })
    const { askId } = (await asker.callAny('quirky.ask/create', { spec })) as { askId: string }

    let current: Promise<Harness> = Promise.resolve(h)
    const connect = async () => connectAs(await current)
    const cli = testCli(connect, await connect(), { sleep: () => Bun.sleep(20) })
    const waiting = commands.wait({ positionals: [], flags: { id: askId } }, cli.ctx)

    await Bun.sleep(50)
    const home = h.home
    let release!: (value: Harness) => void
    current = new Promise((resolve) => (release = resolve))
    await stopKeepingHome(h)
    h = await startAsk(home)
    release(h)

    const next = await connectAs(h)
    expect(await next.callAny('quirky.ask/wait', { askId, timeoutMs: 10 })).toMatchObject({ status: 'pending' })
    expect(((await next.callAny('quirky.ask/list', { pendingOnly: true })) as { id: string }[]).map((ask) => ask.id)).toEqual([askId])
    const envelope = await next.callAny('quirky.ask/answer', { askId, answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] })
    await waiting
    expect(cli.reconnects).toBeGreaterThanOrEqual(1)
    expect(cli.lines).toEqual([envelope])
  })
})

const askEvents = (events: QuirkyEvent[]) =>
  events
    .filter((event) => event.type.startsWith('quirky.ask/'))
    .map((event) => [event.type.slice('quirky.ask/'.length), (event as any).data.seq as number])
const eventsOf = (events: QuirkyEvent[], name: string) => events.filter((event) => event.type === `quirky.ask/${name}`) as any[]
const asksOf = async (c: QuirkyClient, pendingOnly = false) => (await c.callAny('quirky.ask/list', { pendingOnly })) as Ask[]

describe('questions and answers', () => {
  test('SC-1: number and date questions register and come back typed', async () => {
    const { askId } = await call('create', { spec: deploy })
    await call('answer', {
      askId,
      answers: {
        env: { value: 'prod', source: 'option' },
        replicas: { value: 3, source: 'input' },
        ship: { value: '2026-11-02', source: 'input' },
        go: { value: true, source: 'input' }
      }
    })
    expect(await call('wait', { askId })).toEqual({
      status: 'answered',
      askId,
      answers: {
        env: { value: 'prod', label: 'Prod', source: 'option' },
        replicas: { value: 3, source: 'input' },
        ship: { value: '2026-11-02', source: 'input' },
        go: { value: true, source: 'input' }
      },
      skipped: [],
      summary: 'Which environment?: Prod\nHow many replicas?: 3\nShip: 2026-11-02\nGo ahead?: Yes'
    })
    expect((await call('list')) as Ask[]).toMatchObject([{ id: askId, spec: deploy }])
  })

  test('SC-4: an ask a plugin registers skips the credential text check but not the masked check', async () => {
    const builtin = askOnlyPluginsDir()
    writePlugin(
      builtin,
      {
        id: 'quirky.fake',
        name: 'Fake',
        version: '1.0.0',
        main: 'main.ts',
        dependencies: ['quirky.ask'],
        contributes: { method: [{ id: 'register', params: { type: 'object', additionalProperties: true } }] }
      },
      {
        'main.ts':
          "export function activate(context: any) { context.provide('method:quirky.fake/register', (params: any) => context.call('quirky.ask/create', params)) }\n"
      }
    )
    const harness = await startAsk(undefined, builtin)
    const caller = await connectAs(harness)
    const text = 'Install plugin acme.tokens (method acme.tokens/rotateToken)?'
    const confirm = { questions: [{ id: 'install', type: 'confirm', question: text }] }

    const { askId } = (await caller.callAny('quirky.fake/register', { spec: confirm })) as { askId: string }
    const [ask] = await asksOf(caller, true)
    expect(ask).toMatchObject({ id: askId, envelope: { status: 'pending' } })

    const masked = await errorOf(caller.callAny('quirky.fake/register', { spec: { questions: [{ ...confirm.questions[0], sensitive: true }] } }))
    expect(masked).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: expect.stringContaining('questions[0]: masked/sensitive input is not permitted; collect credentials out of band')
    })

    const direct = await errorOf(caller.callAny('quirky.ask/create', { spec: confirm }))
    expect(direct).toMatchObject({
      code: RpcErrorCode.InvalidParams,
      message: expect.stringContaining('questions[0].question: credential-shaped question text is not permitted')
    })
    expect(await asksOf(caller)).toHaveLength(1)
  })

  test('SC-5: the daemon refuses an answer that breaks the spec, and the ask stays pending', async () => {
    const window = await openWindow(h)
    const { askId } = await call('create', { spec: deploy })
    const input = (value: unknown) => ({ value, source: 'input' })
    const refused: [Record<string, unknown>, unknown[] | undefined, string][] = [
      [{ env: { value: 'staging', source: 'option' } }, undefined, 'env'],
      [{ env: { value: 'prod', source: 'option' }, replicas: input(0) }, undefined, 'replicas'],
      [{ env: { value: 'prod', source: 'option' }, replicas: input(2.5) }, undefined, 'replicas'],
      [{ env: { value: 'prod', source: 'option' }, ship: input('2026-02-30') }, undefined, 'ship'],
      [{}, ['env'], 'env'],
      [{ env: { value: 'prod', source: 'option' }, go: input(true) }, ['go'], 'go'],
      [{ env: { value: 'prod', source: 'option' }, color: input('red') }, undefined, 'color']
    ]
    for (const [answers, skipped, name] of refused) {
      const error = await errorOf(call('answer', { askId, answers, ...(skipped ? { skipped } : {}) }))
      expect(error).toMatchObject({ code: RpcErrorCode.InvalidParams, message: expect.stringContaining(name) })
      expect(await call('wait', { askId, timeoutMs: 0 })).toMatchObject({ status: 'pending' })
    }
    expect(eventsOf(window.events, 'resolved')).toEqual([])

    const envelope = await call('answer', { askId, answers: { env: { value: 'prod', source: 'option' }, go: input(false) } })
    expect(envelope).toMatchObject({ status: 'partial', skipped: ['replicas', 'ship'] })
  })

  test('SC-7: default never fills a blank answer on submit', async () => {
    const { askId } = await call('create', { spec: deploy })
    const envelope = await call('answer', {
      askId,
      answers: { env: { value: 'prod', source: 'option' }, replicas: { value: 2, source: 'input' } },
      skipped: ['ship', 'go']
    })
    expect(envelope.status).toBe('partial')
    expect(envelope.skipped).toContain('go')
    expect(Object.values(envelope.answers).map((answer: any) => answer.source)).not.toContain('default')
  })
})

describe('deadlines', () => {
  test('SC-8: at the deadline defaults win, then drafts, then the question is skipped', async () => {
    const window = await openWindow(h)
    const { askId } = await call('create', {
      timeoutMs: 300,
      spec: {
        questions: [
          { id: 'color', type: 'select', question: 'Color?', options: [{ value: 'blue', label: 'Blue' }], default: 'blue' },
          { id: 'note', type: 'text', question: 'Note?' },
          { id: 'size', type: 'number', question: 'Size?' },
          { id: 'agree', type: 'confirm', question: 'Agree?', default: true }
        ]
      }
    })
    await call('updatePartial', { askId, partial: { note: { draft: 'typed draft before the timeout' }, size: { draft: 'abc' } } })
    const envelope = await call('wait', { askId, timeoutMs: 5000 })
    expect(envelope).toEqual({
      status: 'timed_out',
      askId,
      answers: {
        color: { value: 'blue', label: 'Blue', source: 'default' },
        note: { value: 'typed draft before the timeout', source: 'input' },
        agree: { value: true, source: 'default' }
      },
      skipped: ['size'],
      summary: 'Color?: Blue\nNote?: typed draft before the timeout\nAgree?: Yes'
    })
    expect(((await call('list')) as Ask[])[0]?.envelope).toEqual(envelope)
    expect(eventsOf(window.events, 'resolved')).toHaveLength(1)
  })

  test('SC-9: a deadline survives a daemon restart', async () => {
    const first = await call('create', { spec: deploy, timeoutMs: 1000 })
    const second = await call('create', { spec: deploy, timeoutMs: 4000 })
    const createdAt = Date.now()
    const home = h.home
    await stopKeepingHome(h)
    await Bun.sleep(2000)

    h = await startAsk(home)
    const next = await connectAs(h)
    expect(await next.callAny('quirky.ask/wait', { askId: first.askId, timeoutMs: 0 })).toMatchObject({ status: 'timed_out' })
    expect(await next.callAny('quirky.ask/wait', { askId: second.askId, timeoutMs: 0 })).toMatchObject({ status: 'pending' })
    const late = (await next.callAny('quirky.ask/wait', { askId: second.askId, timeoutMs: 10000 })) as AskEnvelope
    expect(late.status).toBe('timed_out')
    expect(Date.now() - createdAt).toBeLessThan(4000 + 1500)
  }, 20000)

  test('SC-9: a client that only subscribes after a restart receives the resolved event for an overdue ask', async () => {
    const { askId } = await call('create', { spec: deploy, timeoutMs: 300 })
    const home = h.home
    await stopKeepingHome(h)
    await Bun.sleep(400)

    h = await startAsk(home)
    const window = await openWindow(h)
    const resolved = await waitFor(() => eventsOf(window.events, 'resolved')[0], 3500)
    expect(resolved.data).toMatchObject({ askId, envelope: { status: 'timed_out' } })
  }, 20000)

  test('SC-11: an absurd timeout is clamped, not treated as none', async () => {
    const { askId } = await call('create', { spec: deploy, timeoutMs: 9007199254740991 })
    expect(await asksOf(client)).toMatchObject([{ id: askId, expiresAt: 8640000000000000, envelope: { status: 'pending' } }])
    const envelope = await call('answer', { askId, answers: { env: { value: 'dev', source: 'option' } } })
    expect(envelope.status).toBe('partial')
  })

  test('SC-10: expire times a pending ask out with its defaults, and returns a finished ask unchanged', async () => {
    const { askId } = await call('create', { spec: deploy })
    const waiting = call('wait', { askId, timeoutMs: 10000 })
    const expired = await call('expire', { askId })
    expect(expired).toMatchObject({
      status: 'timed_out',
      answers: { env: { value: 'dev', label: 'Dev', source: 'default' }, go: { value: true, source: 'default' } },
      skipped: ['replicas', 'ship']
    })
    expect(await waiting).toEqual(expired)
    expect(await call('expire', { askId })).toEqual(expired)

    const { askId: other } = await call('create', { spec: deploy })
    const done = await call('answer', { askId: other, answers: { env: { value: 'dev', source: 'option' } } })
    expect(await call('expire', { askId: other })).toEqual(done)
    expect((await errorOf(call('expire', { askId: 'ask_nope' })))?.code).toBe(RpcErrorCode.NotFound)
  })
})

describe('drafts', () => {
  test('SC-12: a draft is saved, filtered and returned with the ask', async () => {
    const window = await openWindow(h)
    const { askId } = await call('create', { spec: deploy })
    const result = await call('updatePartial', {
      askId,
      partial: { env: { selected: ['prod'], note: 'eu only' }, replicas: { draft: '3' }, color: { draft: 'x' } }
    })
    expect(result).toEqual({ ok: true })
    const [ask] = await asksOf(client)
    expect(ask?.partial).toEqual({ env: { selected: ['prod'], note: 'eu only' }, replicas: { draft: '3' } })
    const updated = await waitFor(() => eventsOf(window.events, 'updated')[0])
    expect(updated.data).toMatchObject({ askId, partial: ask?.partial, seq: ask?.seq })
    expect(ask?.seq).toBeGreaterThan(1)

    expect((await errorOf(call('updatePartial', { askId, partial: { env: { selected: 'prod' } } })))?.code).toBe(RpcErrorCode.InvalidParams)
    expect((await asksOf(client))[0]?.partial).toEqual(ask?.partial)

    await call('answer', { askId, answers: { env: { value: 'prod', source: 'option' } } })
    const before = (await asksOf(client))[0]
    expect(await call('updatePartial', { askId, partial: { replicas: { draft: '9' } } })).toEqual({ ok: false })
    expect((await asksOf(client))[0]).toEqual(before)
    expect((await errorOf(call('updatePartial', { askId: 'ask_nope', partial: {} })))?.code).toBe(RpcErrorCode.NotFound)
  })

  test('SC-13: a draft survives a daemon restart', async () => {
    const { askId } = await call('create', { spec: deploy })
    await call('updatePartial', { askId, partial: { replicas: { draft: '3' } } })
    const home = h.home
    await stopKeepingHome(h)
    h = await startAsk(home)
    const next = await connectAs(h)
    expect(await asksOf(next)).toMatchObject([{ id: askId, partial: { replicas: { draft: '3' } } }])
  })
})

describe('the queue', () => {
  test('SC-14: a second ask from the same session waits', async () => {
    const window = await openWindow(h)
    const s1 = await connectAs(h, { sessionId: 's1' })
    const a = ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    expect(((await client.call('ui.state', {})) as any).layout.panel).toBe(PANEL)
    await client.call('ui.panel.close', {})
    const b = ((await s1.callAny('quirky.ask/create', { spec: { ...spec, title: 'Second' } })) as { askId: string }).askId

    const asks = await asksOf(s1, true)
    expect(asks.map((ask) => [ask.id, ask.queued])).toEqual([[a, false], [b, true]])
    const createdB = await waitFor(() => eventsOf(window.events, 'created').find((event) => event.data.ask.id === b))
    expect(createdB.data.ask.queued).toBe(true)
    expect(h.notifications).toEqual([{ title: 'Deploy?', body: 'Which environment?' }])
    expect(((await client.call('ui.state', {})) as any).layout.panel).toBeNull()
    expect(eventsOf(window.events, 'surfaced')).toEqual([])
  })

  test('SC-15: when the first resolves, the second surfaces with a fresh seq', async () => {
    const window = await openWindow(h)
    const s1 = await connectAs(h, { sessionId: 's1' })
    const a = ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    const b = ((await s1.callAny('quirky.ask/create', { spec: { ...spec, title: 'Second' } })) as { askId: string }).askId
    const waitingOnB = call('wait', { askId: b, timeoutMs: 10000 })

    await call('answer', { askId: a, answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] })

    await waitFor(() => eventsOf(window.events, 'surfaced')[0])
    expect(askEvents(window.events)).toEqual([['created', 1], ['created', 2], ['resolved', 3], ['surfaced', 4]])
    expect(eventsOf(window.events, 'surfaced')[0].data).toMatchObject({ ask: { id: b, queued: false, seq: 4 }, seq: 4 })
    expect(await asksOf(client, true)).toMatchObject([{ id: b, queued: false, seq: 4 }])
    expect(h.notifications).toEqual([
      { title: 'Deploy?', body: 'Which environment?' },
      { title: 'Second', body: 'Which environment?' }
    ])

    const envelope = await call('answer', { askId: b, answers: { env: { value: 'prod', source: 'option' }, why: { value: 'go', source: 'input' } } })
    expect(await waitingOnB).toEqual(envelope)
    expect(envelope.status).toBe('answered')
  })

  test('SC-17: asks from different sessions, or with no session, never queue', async () => {
    const clients = [await connectAs(h, { sessionId: 's1' }), await connectAs(h, { sessionId: 's2' }), await connectAs(h), await connectAs(h)]
    for (const asker of clients) await asker.callAny('quirky.ask/create', { spec })
    const asks = await asksOf(client, true)
    expect(asks.map((ask) => ask.queued)).toEqual([false, false, false, false])
    expect(h.notifications).toHaveLength(4)
  })

  test('SC-18: timing out a queued ask leaves the head alone, and so does cancelling one', async () => {
    const window = await openWindow(h)
    const s1 = await connectAs(h, { sessionId: 's1' })
    const a = ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    const b = ((await s1.callAny('quirky.ask/create', { spec, timeoutMs: 400 })) as { askId: string }).askId
    const c = ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId

    expect(await call('wait', { askId: b, timeoutMs: 5000 })).toMatchObject({ status: 'timed_out' })
    expect(await call('cancel', { askId: c })).toMatchObject({ status: 'declined' })

    expect((await asksOf(client, true)).map((ask) => [ask.id, ask.queued])).toEqual([[a, false]])
    expect(eventsOf(window.events, 'surfaced')).toEqual([])
    expect(h.notifications).toHaveLength(1)
  })

  test('SC-18: asks that are both overdue at startup end timed out and the queued one is never surfaced or announced', async () => {
    const s1 = await connectAs(h, { sessionId: 's1' })
    const a = ((await s1.callAny('quirky.ask/create', { spec, timeoutMs: 300 })) as { askId: string }).askId
    const b = ((await s1.callAny('quirky.ask/create', { spec, timeoutMs: 300 })) as { askId: string }).askId
    const home = h.home
    await stopKeepingHome(h)
    await Bun.sleep(400)

    h = await startAsk(home)
    const window = await openWindow(h)
    const next = await connectAs(h)
    expect((await asksOf(next)).map((ask) => [ask.id, ask.envelope.status])).toEqual([
      [a, 'timed_out'],
      [b, 'timed_out']
    ])
    expect(eventsOf(window.events, 'resolved').map((event) => event.data.askId)).toEqual([a, b])
    expect(eventsOf(window.events, 'surfaced')).toEqual([])
    expect(h.notifications).toEqual([])
  })

  test('SC-18: cancelling an ask whose deadline has passed but whose timer has not fired returns timed_out', () => {
    const clock = fakeClock()
    const service = new AskService(migratedStore(), errors, noHooks, clock)
    const ask = service.create(spec, null, null, { timeoutMs: 100, checkCredentialText: true })
    clock.time += 200
    expect(service.cancel(ask.id)).toMatchObject({ status: 'timed_out', skipped: ['env', 'why'] })
    expect(service.get(ask.id).envelope.status).toBe('timed_out')
  })

  test('SC-18: promotion skips an overdue ask and times it out', () => {
    const clock = fakeClock()
    const surfaced: string[] = []
    const service = new AskService(migratedStore(), errors, { ...noHooks, surfaced: (ask) => surfaced.push(ask.id) }, clock)
    const a = service.create(spec, 's1', null, { checkCredentialText: true })
    const b = service.create(spec, 's1', null, { timeoutMs: 100, checkCredentialText: true })
    const c = service.create(spec, 's1', null, { checkCredentialText: true })
    clock.time += 200
    service.answer(a.id, { env: { value: 'dev', source: 'option' } }, ['why'])
    expect(service.get(b.id).envelope.status).toBe('timed_out')
    expect(surfaced).toEqual([c.id])
  })

  test('a deadline that passes while the ask is being created resolves it only after created', () => {
    const clock = fakeClock()
    const readings = [clock.time, clock.time + 5]
    clock.now = () => readings.shift() ?? clock.time + 5
    const order: [string, number][] = []
    const created: Ask[] = []
    const service = new AskService(
      migratedStore(),
      errors,
      {
        ...noHooks,
        created: (ask, seq) => {
          created.push(ask)
          order.push(['created', seq])
        },
        resolved: (_id, _envelope, seq) => order.push(['resolved', seq])
      },
      clock
    )
    const ask = service.create(spec, null, null, { timeoutMs: 1, checkCredentialText: true })
    expect(order).toEqual([['created', 1], ['resolved', 2]])
    expect(created[0]).toMatchObject({ seq: 1, envelope: { status: 'pending' } })
    expect(ask.envelope.status).toBe('timed_out')
  })

  test('SC-19: seq keeps rising across restarts and the queue order survives', async () => {
    const window1 = await openWindow(h)
    const s1 = await connectAs(h, { sessionId: 's1' })
    const [a, b, c] = [
      ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId,
      ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId,
      ((await s1.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    ]
    expect(askEvents(window1.events)).toEqual([['created', 1], ['created', 2], ['created', 3]])
    const home = h.home
    await stopKeepingHome(h)

    h = await startAsk(home)
    const window = await openWindow(h)
    const next = await connectAs(h)
    const answer = (askId: string) => next.callAny('quirky.ask/answer', { askId, answers: {}, skipped: ['env', 'why'] })
    await answer(a)
    await waitFor(() => eventsOf(window.events, 'surfaced')[0])
    expect(eventsOf(window.events, 'surfaced')[0].data).toMatchObject({ ask: { id: b }, seq: 5 })
    expect((await asksOf(next, true)).map((ask) => [ask.id, ask.queued])).toEqual([[b, false], [c, true]])

    await answer(b)
    await waitFor(() => eventsOf(window.events, 'surfaced')[1])
    expect(eventsOf(window.events, 'surfaced')[1].data).toMatchObject({ ask: { id: c }, seq: 7 })
  })
})

describe('the service clock', () => {
  test('a deadline beyond the longest timer delay re-arms in steps', () => {
    const clock = fakeClock()
    const service = new AskService(migratedStore(), errors, noHooks, clock)
    const ask = service.create(spec, null, null, { timeoutMs: 3_000_000_000, checkCredentialText: true })
    expect(clock.delays).toEqual([2147483647])
    clock.advance(2147483647)
    expect(service.get(ask.id).envelope.status).toBe('pending')
    expect(clock.delays.at(-1)).toBe(3_000_000_000 - 2147483647)
    clock.advance(3_000_000_000 - 2147483647)
    expect(service.get(ask.id).envelope.status).toBe('timed_out')
  })
})

type Timer = { at: number; run: () => void }

/** A manual clock; timers only run when `advance` passes them, and `now` can be moved without firing any. */
function fakeClock() {
  const timers = new Map<number, Timer>()
  let counter = 0
  const clock = {
    time: 1_000_000,
    now: () => clock.time,
    delays: [] as number[],
    setTimeout(run: () => void, ms: number) {
      clock.delays.push(ms)
      timers.set(++counter, { at: clock.time + ms, run })
      return counter
    },
    clearTimeout(handle: unknown) {
      timers.delete(handle as number)
    },
    advance(ms: number) {
      clock.time += ms
      for (const [id, timer] of [...timers].sort((x, y) => x[1].at - y[1].at)) {
        if (timer.at > clock.time) continue
        timers.delete(id)
        timer.run()
      }
    }
  }
  return clock
}
