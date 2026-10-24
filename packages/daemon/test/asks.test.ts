import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { RpcErrorCode, type AskSpec, type QuirkyClient, type QuirkyEvent, type RpcError } from '@quirky/protocol'
import { startHarness, waitFor, type Harness } from './helpers'

let h: Harness
let client: QuirkyClient
let events: QuirkyEvent[]

beforeEach(async () => {
  h = await startHarness()
  ;({ client, events } = await h.connectWithEvents('cli'))
})
afterEach(() => h.cleanup())

const spec: AskSpec = {
  title: 'Deploy?',
  questions: [
    { id: 'env', type: 'select', question: 'Which environment?', options: [{ value: 'prod', label: 'Prod' }, { value: 'dev', label: 'Dev' }] },
    { id: 'why', type: 'text', question: 'Why?' }
  ]
}

async function errorCode(promise: Promise<unknown>) {
  try {
    await promise
    return null
  } catch (error) {
    return (error as RpcError).code
  }
}

describe('asks', () => {
  test('create stores a pending ask, emits ask.created and notify', async () => {
    const { askId } = await client.call('ask.create', { spec })
    expect(askId).toMatch(/^ask_/)
    const [ask] = await client.call('ask.list', { pendingOnly: true })
    expect(ask).toMatchObject({
      id: askId,
      spec,
      sessionId: null,
      worktreeId: null,
      envelope: { status: 'pending', askId, answers: {}, skipped: [] }
    })
    await waitFor(() => events.find((e) => e.type === 'ask.created'))
    expect(events.find((e) => e.type === 'notify')).toMatchObject({ title: 'Deploy?', body: 'Which environment?' })
  })

  test('answer resolves a waiting long-poll immediately', async () => {
    const { askId } = await client.call('ask.create', { spec })
    const started = Date.now()
    const waiting = client.call('ask.wait', { askId, timeoutMs: 10000 })
    await Bun.sleep(30)
    const envelope = await client.call('ask.answer', {
      askId,
      answers: {
        env: { value: 'prod', label: 'Prod', source: 'option' },
        why: { value: 'ship it', source: 'input' }
      }
    })
    expect(envelope.status).toBe('answered')
    expect(await waiting).toEqual(envelope)
    expect(Date.now() - started).toBeLessThan(2000)
    await waitFor(() => events.find((e) => e.type === 'ask.resolved' && e.askId === askId))
    expect(await client.call('ask.list', { pendingOnly: true })).toEqual([])
    expect(await client.call('ask.wait', { askId })).toEqual(envelope)
  })

  test('skipped questions give status partial', async () => {
    const { askId } = await client.call('ask.create', { spec })
    const envelope = await client.call('ask.answer', {
      askId,
      answers: { env: { value: 'dev', source: 'option' } },
      skipped: ['why']
    })
    expect(envelope).toEqual({
      status: 'partial',
      askId,
      answers: { env: { value: 'dev', source: 'option' } },
      skipped: ['why']
    })
  })

  test('cancel declines, wakes waiters and is idempotent; answering afterwards conflicts', async () => {
    const { askId } = await client.call('ask.create', { spec })
    const waiting = client.call('ask.wait', { askId, timeoutMs: 10000 })
    const cancelled = await client.call('ask.cancel', { askId })
    expect(cancelled.status).toBe('declined')
    expect((await waiting).status).toBe('declined')
    expect(await client.call('ask.cancel', { askId })).toEqual(cancelled)
    expect(await errorCode(client.call('ask.answer', { askId, answers: {} }))).toBe(RpcErrorCode.Conflict)
  })

  test('wait returns pending when the timeout passes', async () => {
    const { askId } = await client.call('ask.create', { spec })
    const started = Date.now()
    const envelope = await client.call('ask.wait', { askId, timeoutMs: 80 })
    expect(envelope).toMatchObject({ status: 'pending', askId })
    expect(Date.now() - started).toBeGreaterThanOrEqual(70)
  })

  test('validates input and unknown ids', async () => {
    expect(await errorCode((client as any).call('ask.create', {}))).toBe(RpcErrorCode.InvalidParams)
    expect(await errorCode((client as any).call('ask.create', { spec: { questions: [] } }))).toBe(RpcErrorCode.InvalidParams)
    expect(
      await errorCode((client as any).call('ask.create', { spec: { questions: [{ id: 'a', type: 'select', question: 'q' }] } }))
    ).toBe(RpcErrorCode.InvalidParams)
    expect(await errorCode(client.call('ask.cancel', { askId: 'ask_nope' }))).toBe(RpcErrorCode.NotFound)
    const { askId } = await client.call('ask.create', { spec })
    expect(await errorCode((client as any).call('ask.answer', { askId, answers: 'x' }))).toBe(RpcErrorCode.InvalidParams)
  })

  test('a pending ask survives a daemon restart', async () => {
    const { askId } = await client.call('ask.create', { spec })
    const home = h.home
    client.close()
    await h.daemon.stop()
    const { startDaemon } = await import('../src/daemon')
    const again = await startDaemon({ home, port: 0, uiDir: `${home}/none`, notifier: () => {} })
    try {
      const { QuirkyClient } = await import('@quirky/protocol')
      const { rpcUrl } = await import('@quirky/protocol/node')
      const next = await QuirkyClient.connect(rpcUrl(again.runtime), { role: 'cli' })
      expect((await next.call('ask.wait', { askId, timeoutMs: 10 })).status).toBe('pending')
      await next.call('ask.cancel', { askId })
      next.close()
    } finally {
      await again.stop()
    }
    h.daemon = again
  })
})
