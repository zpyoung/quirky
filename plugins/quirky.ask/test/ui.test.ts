import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Ask, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { act } from 'react'

const PANEL = 'panel:quirky.ask/questions'

type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
type Module = { activate(context: UiPluginContext): void | Promise<void>; deactivate?(): void | Promise<void> }

let ui: Module

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ui = (await import('../src/ui')) as Module
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const selectAsk = (id: string, title: string | undefined, createdAt: number): Ask => ({
  id,
  spec: {
    ...(title ? { title } : {}),
    questions: [
      { id: 'env', type: 'select', question: 'Which environment?', options: [{ value: 'prod', label: 'Prod' }, { value: 'dev', label: 'Dev' }] }
    ]
  },
  sessionId: null,
  worktreeId: null,
  createdAt,
  envelope: { status: 'pending', askId: id, answers: {}, skipped: [] }
})

type Fake = ReturnType<typeof fakeContext>

function fakeContext(initial: Ask[]) {
  let asks = [...initial]
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const badges: (number | null)[] = []
  const toasts: { title: string; body: string }[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const connection = new Set<(status: 'connected' | 'reconnecting') => void>()
  let failWith: string | null = null

  const context = {
    pluginId: 'quirky.ask',
    log() {},
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (failWith && method !== 'quirky.ask/list') throw new Error(failWith)
      if (method === 'quirky.ask/list') return asks
      if (method === 'quirky.ask/answer' || method === 'quirky.ask/cancel') {
        asks = asks.filter((ask) => ask.id !== params?.askId)
        return { status: 'answered', askId: params?.askId, answers: {}, skipped: [] }
      }
      throw new Error(`unexpected ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection(listener: (status: 'connected' | 'reconnecting') => void) {
      connection.add(listener)
      return () => void connection.delete(listener)
    },
    toast: (title: string, body: string) => void toasts.push({ title, body }),
    setPanelBadge: (_panel: string, count: number | null) => void badges.push(count)
  } as unknown as UiPluginContext

  return {
    context,
    calls,
    badges,
    toasts,
    provided,
    listeners,
    connection,
    failAnswers: (message: string | null) => void (failWith = message),
    add(ask: Ask) {
      asks = [...asks, ask]
    },
    drop(askId: string) {
      asks = asks.filter((ask) => ask.id !== askId)
    },
    emit: async (event: QuirkyEvent) => {
      await act(async () => {
        for (const listener of [...listeners]) await listener(event)
      })
    }
  }
}

const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

const mounts: (() => void)[] = []
afterEach(async () => {
  await act(async () => {
    for (const cleanup of mounts.splice(0)) cleanup()
  })
  await ui.deactivate?.()
  document.body.innerHTML = ''
})

async function activated(fake: Fake) {
  await act(async () => {
    await ui.activate(fake.context)
  })
  await settled()
}

async function mount(fake: Fake) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: unknown[] = []
  const provided = fake.provided.get(PANEL) as Mount
  await act(async () => {
    const cleanup = provided(element, { report: (state) => void reports.push(state) })
    if (cleanup) mounts.push(cleanup)
  })
  await settled()
  return { element, reports }
}

const created = (ask: Ask): QuirkyEvent => ({ type: 'quirky.ask/created', data: { ask } })
const resolved = (askId: string): QuirkyEvent => ({
  type: 'quirky.ask/resolved',
  data: { askId, envelope: { status: 'answered', askId, answers: {}, skipped: [] } }
})

describe('the Questions panel module', () => {
  test('provides the panel and keeps the badge without the panel mounted', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'First', 1), selectAsk('ask_2', 'Second', 2)])
    await activated(fake)

    expect([...fake.provided.keys()]).toEqual([PANEL])
    expect(fake.badges.at(-1)).toBe(2)

    fake.add(selectAsk('ask_3', 'Third', 3))
    await fake.emit(created(selectAsk('ask_3', 'Third', 3)))
    expect(fake.badges.at(-1)).toBe(3)

    fake.drop('ask_1')
    await fake.emit(resolved('ask_1'))
    expect(fake.badges.at(-1)).toBe(2)
  })

  test('clears the badge when nothing is pending', async () => {
    const fake = fakeContext([])
    await activated(fake)
    expect(fake.badges.at(-1)).toBeNull()
  })

  test('lists pending asks only, in creation order, one card each', async () => {
    const fake = fakeContext([selectAsk('ask_2', 'Second', 2), selectAsk('ask_1', 'First', 1)])
    await activated(fake)
    const { element } = await mount(fake)

    expect(fake.calls.find((call) => call.method === 'quirky.ask/list')?.params).toEqual({ pendingOnly: true })
    expect([...element.querySelectorAll('.ask-card h3')].map((node) => node.textContent)).toEqual(['First', 'Second'])
  })

  test('SC-29: reports the pending asks, and Ask 2 stays after Ask 1 is answered', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'Ask 1', 1), selectAsk('ask_2', 'Ask 2', 2)])
    await activated(fake)
    const { element, reports } = await mount(fake)

    expect(reports.at(-1)).toEqual({
      pending: [
        { askId: 'ask_1', title: 'Ask 1', questions: 1 },
        { askId: 'ask_2', title: 'Ask 2', questions: 1 }
      ]
    })

    const first = element.querySelector('.ask-card')!
    await act(async () => {
      ;(first.querySelector('input[type=radio]') as HTMLInputElement).click()
    })
    await act(async () => {
      ;([...first.querySelectorAll('button')].find((b) => b.textContent === 'Submit') as HTMLButtonElement).click()
    })
    await settled()

    const answer = fake.calls.find((call) => call.method === 'quirky.ask/answer')!
    expect(answer.params).toEqual({
      askId: 'ask_1',
      answers: { env: { value: 'prod', label: 'Prod', source: 'option' } },
      skipped: []
    })
    await fake.emit(resolved('ask_1'))

    expect(reports.at(-1)).toEqual({ pending: [{ askId: 'ask_2', title: 'Ask 2', questions: 1 }] })
    expect(element.querySelectorAll('.ask-card')).toHaveLength(1)
    expect(fake.badges.at(-1)).toBe(1)
  })

  test('dismiss cancels the ask', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'Ask 1', 1)])
    await activated(fake)
    const { element, reports } = await mount(fake)

    await act(async () => {
      ;([...element.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss') as HTMLButtonElement).click()
    })
    await settled()

    expect(fake.calls.some((call) => call.method === 'quirky.ask/cancel' && call.params?.askId === 'ask_1')).toBe(true)
    expect(element.querySelectorAll('.ask-card')).toHaveLength(0)
    expect(reports.at(-1)).toEqual({ pending: [] })
    expect(fake.badges.at(-1)).toBeNull()
  })

  test('a failed answer toasts and keeps the card', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'Ask 1', 1)])
    await activated(fake)
    const { element } = await mount(fake)
    fake.failAnswers('already resolved')

    await act(async () => {
      ;([...element.querySelectorAll('button')].find((b) => b.textContent === 'Submit') as HTMLButtonElement).click()
    })
    await settled()

    expect(fake.toasts).toEqual([{ title: 'Could not answer', body: 'already resolved' }])
    expect(element.querySelectorAll('.ask-card')).toHaveLength(1)
  })

  test('SC-43: a multi-line question keeps its line breaks', async () => {
    const listing = 'Remove worktree?\n- feature/a (2 sessions)\n- feature/b'
    const ask: Ask = {
      id: 'ask_9',
      spec: { questions: [{ id: 'go', type: 'confirm', question: listing }] },
      sessionId: null,
      worktreeId: null,
      createdAt: 1,
      envelope: { status: 'pending', askId: 'ask_9', answers: {}, skipped: [] }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    const legend = element.querySelector('legend') as HTMLElement
    expect(legend.textContent).toBe(listing)
    expect(legend.style.whiteSpace).toBe('pre-wrap')
  })

  test('refreshes on reconnect and stops listening on deactivate', async () => {
    const fake = fakeContext([])
    await activated(fake)
    expect(fake.listeners.size).toBe(1)

    fake.add(selectAsk('ask_1', 'Late', 1))
    await act(async () => {
      for (const listener of fake.connection) listener('connected')
    })
    await settled()
    expect(fake.badges.at(-1)).toBe(1)

    await ui.deactivate?.()
    expect(fake.listeners.size).toBe(0)
    expect(fake.connection.size).toBe(0)
  })
})
