import { describe, expect, test } from 'bun:test'
import type { PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import { SessionInfoService } from '../src/service'

type Handler = (params: Record<string, unknown>) => unknown

const STRUCTURED = {
  id: 'chat-1', kind: 'structured', agent: 'claude', worktreeId: 'wt-main', cwd: '/repo', title: 'Fix the header',
  status: 'running', createdAt: 1_000, lastActivityAt: 2_000, providerSession: { id: 'prov-1' }
}
const TERMINAL = { ...STRUCTURED, id: 'term-1', kind: 'terminal', providerSession: { id: 'prov-2', transcriptPath: null } }

function harness(handlers: Record<string, Handler>) {
  const emitted: { name: string; data: unknown }[] = []
  const listeners: ((event: QuirkyEvent) => void)[] = []
  const calls: string[] = []
  const context = {
    call: async (method: string, params: Record<string, unknown>) => {
      calls.push(method)
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected call ${method}`)
      return handler(params)
    },
    subscribe: (listener: (event: QuirkyEvent) => void) => { listeners.push(listener); return () => {} },
    emit: (name: string, data: unknown) => { emitted.push({ name, data }) },
    error: (_code: string, message: string) => new Error(message)
  } as unknown as PluginContext
  const store = { version: 1, run: () => ({ changes: 0, lastInsertRowid: 0 }), get: () => null, all: () => [] } as unknown as PluginStore
  const service = new SessionInfoService(context, store)
  service.start()
  return { service, emitted, calls, fire: (event: QuirkyEvent) => listeners.forEach((listener) => listener(event)) }
}

const sessionGet: Handler = ({ session }) => session === 'chat-1' ? STRUCTURED : TERMINAL

describe('Session info for native chats', () => {
  test('maps the conversation usage totals and the chat identity', async () => {
    const h = harness({
      'quirky.session/get': sessionGet,
      'quirky.structured/usage': () => ({ own: null, conversation: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, total: 100 }, cache: null })
    })
    const state = await h.service.get({ session: 'chat-1' })
    expect(state.session).toBe('chat-1')
    expect(state.info?.identity).toMatchObject({ agent: 'claude', sessionId: 'chat-1', providerSessionId: 'prov-1', pane: null, worktreeId: 'wt-main', cwd: '/repo' })
    expect(state.info?.usage).toMatchObject({ status: 'ready', freshness: 'fresh', totalTokens: 100, input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
    expect(typeof state.info?.usage?.updatedAt).toBe('number')
    expect(state.info?.liveActivity).toBeUndefined()
    expect(state.info?.context).toBeUndefined()
    expect(state.info?.filesTouched).toBeUndefined()
    expect(state.info?.hooksAndMcp).toBeUndefined()
    expect(h.calls).not.toContain('quirky.agent-status/get')
  })

  test('reports waiting usage while the conversation has no totals', async () => {
    const h = harness({ 'quirky.session/get': sessionGet, 'quirky.structured/usage': () => ({ own: null, conversation: null, cache: null }) })
    expect((await h.service.get({ session: 'chat-1' })).info?.usage).toEqual({ status: 'waiting' })
  })

  test('returns the projection with a usage error when the usage call fails', async () => {
    const h = harness({
      'quirky.session/get': sessionGet,
      'quirky.structured/usage': () => { throw new Error('method not found') }
    })
    const state = await h.service.get({ session: 'chat-1' })
    expect(state.info?.identity.sessionId).toBe('chat-1')
    expect(state.info?.usage?.error).toContain('method not found')
    expect(state.info?.usage?.totalTokens).toBeUndefined()
  })

  test('re-emits changed when structured usage changes', () => {
    const h = harness({})
    h.fire({ type: 'quirky.structured/usageChanged', data: { sessionId: 'chat-1' } } as QuirkyEvent)
    expect(h.emitted).toEqual([{ name: 'changed', data: { sessionId: 'chat-1' } }])
  })

  test('keeps terminal sessions on the terminal projection', async () => {
    const h = harness({
      'quirky.session/get': sessionGet,
      'quirky.agent-status/get': () => ({ state: 'working', evidenceAt: 3_000 })
    })
    const state = await h.service.get({ session: 'term-1' })
    expect(state.info?.liveActivity?.state).toBe('working')
    expect(h.calls).not.toContain('quirky.structured/usage')
  })
})
