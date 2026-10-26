import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { waitFor, type Harness } from '../../../packages/daemon/test/helpers'
import { cleanupAll, connectAs, errorOf, spec, startAsk, stopKeepingHome, testCli } from './support'
import { commands } from '../cli'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  h = await startAsk()
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(cleanupAll)

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
      envelope: { status: 'pending', askId, answers: {}, skipped: [] }
    })
    const created = await waitFor(() => events.find((e) => e.type === 'quirky.ask/created'))
    expect(created).toMatchObject({ data: { ask: { id: askId } } })
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
        env: { value: 'prod', label: 'Prod', source: 'option' },
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
      answers: { env: { value: 'dev', source: 'option' } },
      skipped: ['why']
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

describe('pending asks', () => {
  test('SC-29: answering Ask 1 leaves Ask 2 pending and listed, and answering Ask 2 wakes its waiter', async () => {
    const window = await connectAs(h, { role: 'ui', name: 'window' })
    await window.call('events.subscribe', {})
    const asker = await connectAs(h, { sessionId: 'sess_1', worktreeId: 'wt_1' })
    const reports: string[][] = []
    const reportPending = async () => {
      const pending = ((await call('list', { pendingOnly: true })) as { id: string }[]).map((ask) => ask.id)
      reports.push(pending)
      await window.call('ui.report', { slot: 'panel:quirky.ask/questions', state: { pending } })
    }
    window.onEvent((event) => {
      if (event.type === 'quirky.ask/created' || event.type === 'quirky.ask/resolved') void reportPending().catch(() => {})
    })

    const one = ((await asker.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    const two = ((await asker.callAny('quirky.ask/create', { spec })) as { askId: string }).askId
    const waitingOnTwo = call('wait', { askId: two, timeoutMs: 10000 })
    await waitFor(() => reports.some((pending) => pending.length === 2))

    await call('answer', { askId: one, answers: { env: { value: 'dev', source: 'option' } }, skipped: ['why'] })

    expect(((await call('list', { pendingOnly: true })) as { id: string }[]).map((ask) => ask.id)).toEqual([two])
    const resolved = events.filter((e) => e.type === 'quirky.ask/resolved')
    expect(resolved.map((e) => (e as any).data.askId)).toEqual([one])
    await waitFor(() => reports.at(-1)?.length === 1)
    const state = (await client.call('ui.state', {})) as { slots: { id: string; report?: unknown }[] }
    expect(state.slots.find((slot) => slot.id === 'panel:quirky.ask/questions')?.report).toEqual({ pending: [two] })

    const envelope = await call('answer', { askId: two, answers: { env: { value: 'prod', source: 'option' }, why: { value: 'go', source: 'input' } } })
    expect(await waitingOnTwo).toEqual(envelope)
    expect(envelope.status).toBe('answered')
    expect(await call('list', { pendingOnly: true })).toEqual([])
    await waitFor(() => reports.at(-1)?.length === 0)
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
