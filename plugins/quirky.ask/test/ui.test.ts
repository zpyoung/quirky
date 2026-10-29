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
  envelope: { status: 'pending', askId: id, answers: {}, skipped: [], summary: '' },
  seq: 0,
  queued: false,
  partial: {},
  expiresAt: null
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
  let listGate: Promise<void> | null = null
  let listFailure: string | null = null

  const context = {
    pluginId: 'quirky.ask',
    log() {},
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (failWith && method !== 'quirky.ask/list' && method !== 'quirky.ask/updatePartial') throw new Error(failWith)
      if (method === 'quirky.ask/list') {
        if (listFailure) throw new Error(listFailure)
        const snapshot = asks
        if (listGate) await listGate
        return snapshot
      }
      if (method === 'quirky.ask/updatePartial') return { ok: true }
      if (method === 'quirky.ask/answer' || method === 'quirky.ask/cancel') {
        asks = asks.filter((ask) => ask.id !== params?.askId)
        return {
          status: method === 'quirky.ask/cancel' ? 'declined' : 'answered',
          askId: params?.askId,
          answers: {},
          skipped: [],
          summary: method === 'quirky.ask/answer' ? 'Go?: Yes' : ''
        }
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
    holdLists() {
      let release!: () => void
      listGate = new Promise<void>((resolve) => void (release = resolve))
      return () => {
        listGate = null
        release()
      }
    },
    failLists: (message: string | null) => void (listFailure = message),
    failAnswers: (message: string | null) => void (failWith = message),
    add(ask: Ask) {
      asks = [...asks, ask]
    },
    replace(next: Ask[]) {
      asks = [...next]
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

let nextSeq = 1000
const created = (ask: Ask, seq = nextSeq++): QuirkyEvent => ({ type: 'quirky.ask/created', data: { ask, seq } })
const surfaced = (ask: Ask, seq = nextSeq++): QuirkyEvent => ({ type: 'quirky.ask/surfaced', data: { ask, seq } })
const resolved = (
  askId: string,
  envelope: Ask['envelope'] = { status: 'answered', askId, answers: {}, skipped: [], summary: '' },
  seq = nextSeq++
): QuirkyEvent => ({ type: 'quirky.ask/resolved', data: { askId, envelope, seq } })
const declined = (askId: string): Ask['envelope'] => ({
  status: 'declined',
  askId,
  answers: {},
  skipped: [],
  summary: ''
})
const wait = (ms: number) =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
  })

const click = (element: Element) =>
  act(async () => {
    ;(element as HTMLElement).click()
  })

const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === text) as HTMLButtonElement

const fieldsetOf = (root: ParentNode, questionId: string) => root.querySelector(`fieldset[data-question="${questionId}"]`) as HTMLFieldSetElement

/** Sets a field's value the way a user's typing does, so React sees the change. */
const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })

const withOwnAnswer = (root: ParentNode) => root.querySelector('input[placeholder="Add your own answer"]') as HTMLInputElement

const deployAsk = (id = 'ask_d', overrides: Partial<Ask> = {}): Ask => ({
  ...selectAsk(id, 'Deploy?', 1),
  spec: {
    title: 'Deploy?',
    questions: [
      { id: 'env', type: 'select', question: 'Which environment?', required: true, options: [{ value: 'prod', label: 'Prod' }, { value: 'dev', label: 'Dev' }] },
      { id: 'replicas', type: 'number', question: 'How many replicas?', integer: true, min: 1, max: 10 },
      { id: 'ship', type: 'date', header: 'Ship', question: 'Ship date?' },
      { id: 'go', type: 'confirm', question: 'Go?' },
      { id: 'email', type: 'text', question: 'Who to notify?', format: 'email' }
    ]
  },
  ...overrides
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

  test('a local removal does not discard an in-flight refresh that carries a new ask', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'First', 1)])
    await activated(fake)
    const { element } = await mount(fake)

    fake.add(selectAsk('ask_2', 'Second', 2))
    const release = fake.holdLists()
    await fake.emit(created(selectAsk('ask_2', 'Second', 2)))

    await act(async () => {
      ;([...element.querySelectorAll('button')].find((b) => b.textContent === 'Dismiss') as HTMLButtonElement).click()
    })
    await settled()
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(0)

    await act(async () => {
      release()
    })
    await settled()

    expect([...element.querySelectorAll('[data-ask-card] h2')].map((node) => node.textContent)).toEqual(['Second'])
    expect(fake.badges.at(-1)).toBe(1)
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
    expect([...element.querySelectorAll('[data-ask-card] h2')].map((node) => node.textContent)).toEqual(['First', 'Second'])
  })

  test('SC-29: reports the pending asks, and Ask 2 stays after Ask 1 is answered', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'Ask 1', 1), selectAsk('ask_2', 'Ask 2', 2)])
    await activated(fake)
    const { element, reports } = await mount(fake)

    expect(reports.at(-1)).toEqual({
      pending: [
        { askId: 'ask_1', title: 'Ask 1', questions: 1 },
        { askId: 'ask_2', title: 'Ask 2', questions: 1 }
      ],
      queued: 0
    })

    const first = element.querySelector('[data-ask-card]')!
    await click(buttonIn(first, 'Prod'))
    await click(buttonIn(first, 'Submit'))
    await settled()

    const answer = fake.calls.find((call) => call.method === 'quirky.ask/answer')!
    expect(answer.params).toEqual({
      askId: 'ask_1',
      answers: { env: { value: 'prod', label: 'Prod', source: 'option' } },
      skipped: []
    })
    await fake.emit(resolved('ask_1'))

    expect(reports.at(-1)).toEqual({ pending: [{ askId: 'ask_2', title: 'Ask 2', questions: 1 }], queued: 0 })
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(1)
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
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(0)
    expect(reports.at(-1)).toEqual({ pending: [], queued: 0 })
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
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(1)
  })

  test('SC-43: a multi-line question keeps its line breaks', async () => {
    const listing = 'Remove worktree?\n- feature/a (2 sessions)\n- feature/b'
    const ask: Ask = {
      id: 'ask_9',
      spec: { questions: [{ id: 'go', type: 'confirm', question: listing }] },
      sessionId: null,
      worktreeId: null,
      createdAt: 1,
      envelope: { status: 'pending', askId: 'ask_9', answers: {}, skipped: [], summary: '' },
      seq: 0,
      queued: false,
      partial: {},
      expiresAt: null
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    const text = element.querySelector('legend [data-question-text]') as HTMLElement
    expect(text.textContent).toBe(listing)
  })

  test('SC-6: free text on a select is a note beside a pick, or the answer itself', async () => {
    const ask: Ask = {
      ...selectAsk('ask_f', 'Stack', 1),
      spec: {
        questions: [
          { id: 'framework', type: 'select', question: 'Framework?', options: [{ value: 'react', label: 'React' }, { value: 'vue', label: 'Vue' }] },
          {
            id: 'features',
            type: 'multiselect',
            question: 'Features?',
            options: [{ value: 'auth', label: 'Auth' }, { value: 'search', label: 'Search' }, { value: 'billing', label: 'Billing' }]
          }
        ]
      }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)
    const framework = fieldsetOf(element, 'framework')
    const features = fieldsetOf(element, 'features')

    await click(buttonIn(framework, 'Vue'))
    await type(withOwnAnswer(framework), 'small bundle size')
    await click(buttonIn(features, 'Search'))
    await click(buttonIn(features, 'Auth'))
    await type(withOwnAnswer(features), 'Exports')
    await click(buttonIn(element, 'Submit'))
    await settled()

    expect(fake.calls.find((call) => call.method === 'quirky.ask/answer')?.params).toEqual({
      askId: 'ask_f',
      answers: {
        framework: { value: 'vue', label: 'Vue', note: 'small bundle size', source: 'option' },
        features: { values: ['auth', 'search'], labels: ['Auth', 'Search'], other: 'Exports', source: 'options' }
      },
      skipped: []
    })
  })

  test('SC-6: with nothing picked, the typed text is the select answer', async () => {
    const ask: Ask = {
      ...selectAsk('ask_g', 'Stack', 1),
      spec: { questions: [{ id: 'framework', type: 'select', question: 'Framework?', options: [{ value: 'react', label: 'React' }] }] }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    await type(withOwnAnswer(element), 'Svelte')
    await click(buttonIn(element, 'Submit'))
    await settled()

    expect(fake.calls.find((call) => call.method === 'quirky.ask/answer')?.params).toEqual({
      askId: 'ask_g',
      answers: { framework: { value: 'Svelte', source: 'other' } },
      skipped: []
    })
  })

  test('SC-13: a saved draft comes back in the card, and typing saves once, 500 ms after the last change', async () => {
    const ask = deployAsk('ask_d', { partial: { replicas: { draft: '3' }, env: { selected: ['dev'], note: 'eu only' } } })
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    const replicas = fieldsetOf(element, 'replicas').querySelector('input') as HTMLInputElement
    expect(replicas.value).toBe('3')
    expect(buttonIn(fieldsetOf(element, 'env'), 'Dev').getAttribute('aria-pressed')).toBe('true')
    expect(withOwnAnswer(fieldsetOf(element, 'env')).value).toBe('eu only')
    expect(fake.calls.filter((call) => call.method === 'quirky.ask/updatePartial')).toHaveLength(0)

    await type(replicas, '4')
    await wait(200)
    await type(replicas, '45')
    await wait(200)
    await type(replicas, '5')
    await wait(300)
    expect(fake.calls.filter((call) => call.method === 'quirky.ask/updatePartial')).toHaveLength(0)

    await wait(300)
    const saves = fake.calls.filter((call) => call.method === 'quirky.ask/updatePartial')
    expect(saves).toHaveLength(1)
    expect(saves[0]!.params).toEqual({ askId: 'ask_d', partial: { env: { selected: ['dev'], note: 'eu only' }, replicas: { draft: '5' } } })
  }, 10000)

  test('a multiselect draft keeps its free text as other, and a pending save is dropped when the card goes', async () => {
    const ask: Ask = {
      ...selectAsk('ask_m', 'Stack', 1),
      spec: { questions: [{ id: 'features', type: 'multiselect', question: 'Features?', options: [{ value: 'auth', label: 'Auth' }] }] }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    await click(buttonIn(element, 'Auth'))
    await type(withOwnAnswer(element), 'Exports')
    await wait(650)
    expect(fake.calls.find((call) => call.method === 'quirky.ask/updatePartial')?.params).toEqual({
      askId: 'ask_m',
      partial: { features: { selected: ['auth'], other: 'Exports' } }
    })

    const before = fake.calls.length
    await type(withOwnAnswer(element), 'Exports and more')
    await act(async () => {
      for (const cleanup of mounts.splice(0)) cleanup()
    })
    await wait(650)
    expect(fake.calls.slice(before).filter((call) => call.method === 'quirky.ask/updatePartial')).toHaveLength(0)
  }, 10000)

  test('SC-14: a queued ask shows no card, and the badge and report count it apart', async () => {
    const head = selectAsk('ask_a', 'A', 1)
    const waiting: Ask = { ...selectAsk('ask_b', 'B', 2), queued: true, seq: 2 }
    const fake = fakeContext([head, waiting])
    await activated(fake)
    const { element, reports } = await mount(fake)

    expect([...element.querySelectorAll('[data-ask-card] h2')].map((node) => node.textContent)).toEqual(['A'])
    expect(fake.badges.at(-1)).toBe(1)
    expect(reports.at(-1)).toEqual({ pending: [{ askId: 'ask_a', title: 'A', questions: 1 }], queued: 1 })
  })

  test('SC-15: a surfaced event with a higher seq shows the card of the promoted ask', async () => {
    const head = { ...selectAsk('ask_a', 'A', 1), seq: 1 }
    const waiting: Ask = { ...selectAsk('ask_b', 'B', 2), queued: true, seq: 2 }
    const fake = fakeContext([head, waiting])
    await activated(fake)
    const { element, reports } = await mount(fake)

    const promoted: Ask = { ...waiting, queued: false, seq: 4 }
    fake.drop('ask_a')
    fake.drop('ask_b')
    fake.add(promoted)
    await fake.emit(resolved('ask_a', declined('ask_a'), 3))
    await fake.emit(surfaced(promoted, 4))

    expect([...element.querySelectorAll('[data-ask-card] h2')].map((node) => node.textContent)).toEqual(['B'])
    expect(fake.badges.at(-1)).toBe(1)
    expect(reports.at(-1)).toEqual({ pending: [{ askId: 'ask_b', title: 'B', questions: 1 }], queued: 0 })
  })

  test('SC-16: an event at or below the watermark triggers nothing; a higher one refetches', async () => {
    const fake = fakeContext([{ ...selectAsk('ask_a', 'A', 1), seq: 7 }])
    await activated(fake)
    const lists = () => fake.calls.filter((call) => call.method === 'quirky.ask/list').length
    const before = lists()

    const late = { ...selectAsk('ask_b', 'B', 2), seq: 5 }
    fake.add(late)
    await fake.emit(surfaced(late, 5))
    await fake.emit(created(late, 7))
    expect(lists()).toBe(before)
    expect(fake.badges.at(-1)).toBe(1)

    await fake.emit(surfaced(late, 8))
    expect(lists()).toBe(before + 1)
    expect(fake.badges.at(-1)).toBe(2)
  })

  test('SC-16: a failed refetch leaves the watermark, so the same event retries', async () => {
    const fake = fakeContext([{ ...selectAsk('ask_a', 'A', 1), seq: 1 }])
    await activated(fake)
    const lists = () => fake.calls.filter((call) => call.method === 'quirky.ask/list').length
    const before = lists()

    const next = { ...selectAsk('ask_b', 'B', 2), seq: 2 }
    fake.add(next)
    fake.failLists('temporary RPC failure')
    await fake.emit(created(next, 2))
    expect(lists()).toBe(before + 1)
    expect(fake.badges.at(-1)).toBe(1)

    fake.failLists(null)
    await fake.emit(created(next, 2))
    expect(lists()).toBe(before + 2)
    expect(fake.badges.at(-1)).toBe(2)

    await fake.emit(created(next, 2))
    expect(lists()).toBe(before + 2)
  })

  test('SC-16: an older refetch still applies when the newer one failed', async () => {
    const fake = fakeContext([{ ...selectAsk('ask_a', 'A', 1), seq: 1 }])
    await activated(fake)

    const release = fake.holdLists()
    const next = { ...selectAsk('ask_b', 'B', 2), seq: 2 }
    fake.add(next)
    await fake.emit(created(next, 2))
    fake.failLists('temporary RPC failure')
    await fake.emit(resolved('ask_x', declined('ask_x'), 3))
    fake.failLists(null)
    release()
    await settled()
    expect(fake.badges.at(-1)).toBe(2)

    const lists = () => fake.calls.filter((call) => call.method === 'quirky.ask/list' && call.params?.pendingOnly === true).length
    const before = lists()
    await fake.emit(resolved('ask_x', declined('ask_x'), 3))
    expect(lists()).toBe(before + 1)
  })

  test('SC-21: the card shows each type with its controls', async () => {
    const ask = deployAsk()
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    const env = fieldsetOf(element, 'env')
    expect([...env.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Prod', 'Dev'])
    expect(withOwnAnswer(env)).not.toBeNull()

    const replicas = fieldsetOf(element, 'replicas')
    const number = replicas.querySelector('input') as HTMLInputElement
    expect([number.type, number.getAttribute('step'), number.getAttribute('min'), number.getAttribute('max')]).toEqual(['number', '1', '1', '10'])
    const email = fieldsetOf(element, 'email')
    const emailQuestion = ask.spec.questions.find((question) => question.id === 'email')!
    const text = email.querySelector('input') as HTMLInputElement
    const textLabel = [...email.querySelectorAll('label')].find((label) => label.control === text)
    expect(text.type).toBe('text')
    expect(textLabel?.textContent).toBe(emailQuestion.question)

    const ship = fieldsetOf(element, 'ship')
    const shipQuestion = ask.spec.questions.find((question) => question.id === 'ship')!
    const shipLegend = ship.querySelector('legend')
    const date = ship.querySelector('input[type="date"]') as HTMLInputElement
    const dateLabel = [...ship.querySelectorAll('label')].find((label) => label.control === date)
    expect(shipLegend?.textContent).toBe(shipQuestion.header)
    expect(date.type).toBe('date')
    expect(dateLabel?.textContent).toBe(shipQuestion.question)

    expect([...fieldsetOf(element, 'go').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Yes', 'No'])

    await click(buttonIn(env, 'Prod'))
    expect(buttonIn(env, 'Prod').getAttribute('aria-pressed')).toBe('true')
    await click(buttonIn(env, 'Dev'))
    expect(buttonIn(env, 'Prod').getAttribute('aria-pressed')).toBe('false')
    await click(buttonIn(env, 'Dev'))
    expect(buttonIn(env, 'Dev').getAttribute('aria-pressed')).toBe('false')
  })

  test('number questions without integer step by any', async () => {
    const ask: Ask = { ...selectAsk('ask_n', 'N', 1), spec: { questions: [{ id: 'ratio', type: 'number', question: 'Ratio?' }] } }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    const number = element.querySelector('input') as HTMLInputElement
    expect(number.getAttribute('step')).toBe('any')
    expect(number.hasAttribute('min')).toBe(false)
    expect(number.hasAttribute('max')).toBe(false)
  })

  test('a multiline text question is a textarea', async () => {
    const ask: Ask = { ...selectAsk('ask_t', 'T', 1), spec: { questions: [{ id: 'why', type: 'text', question: 'Why?', multiline: true }] } }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)
    await type(element.querySelector('textarea') as HTMLTextAreaElement, 'because')
    await click(buttonIn(element, 'Submit'))
    await settled()

    expect(fake.calls.find((call) => call.method === 'quirky.ask/answer')?.params?.answers).toEqual({ why: { value: 'because', source: 'input' } })
  })

  test('SC-22: submit checks every question, shows the messages and sends nothing until they are fixed', async () => {
    const fake = fakeContext([deployAsk()])
    await activated(fake)
    const { element } = await mount(fake)
    const answers = () => fake.calls.filter((call) => call.method === 'quirky.ask/answer')

    await type(fieldsetOf(element, 'replicas').querySelector('input') as HTMLInputElement, '12')
    await type(fieldsetOf(element, 'email').querySelector('input') as HTMLInputElement, 'not-an-email')
    await click(buttonIn(element, 'Submit'))

    expect(answers()).toHaveLength(0)
    expect(fieldsetOf(element, 'env').textContent).toContain('This question is required.')
    expect(fieldsetOf(element, 'replicas').textContent).toContain('Enter a number of at most 10.')
    expect(fieldsetOf(element, 'email').textContent).toContain('Enter a valid email address.')

    const replicas = fieldsetOf(element, 'replicas').querySelector('input') as HTMLInputElement
    await type(replicas, '2.5')
    await click(buttonIn(element, 'Submit'))
    expect(fieldsetOf(element, 'replicas').textContent).toContain('Enter a whole number.')

    await type(replicas, '0')
    await click(buttonIn(element, 'Submit'))
    expect(fieldsetOf(element, 'replicas').textContent).toContain('Enter a number of at least 1.')
    expect(answers()).toHaveLength(0)

    await type(replicas, '2')
    await type(fieldsetOf(element, 'email').querySelector('input') as HTMLInputElement, 'a@b.co')
    await click(buttonIn(fieldsetOf(element, 'env'), 'Prod'))
    await click(buttonIn(element, 'Submit'))
    await settled()

    expect(answers()).toHaveLength(1)
    expect(answers()[0]!.params).toEqual({
      askId: 'ask_d',
      answers: {
        env: { value: 'prod', label: 'Prod', source: 'option' },
        replicas: { value: 2, source: 'input' },
        email: { value: 'a@b.co', source: 'input' }
      },
      skipped: ['ship', 'go']
    })
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(0)
  })
  test('Q2: an API answer immediately shows its terminal summary', async () => {
    const ask: Ask = {
      ...selectAsk('ask_api', 'Confirm?', 1),
      spec: { questions: [{ id: 'go', type: 'confirm', question: 'Go?' }] }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)

    await click(buttonIn(fieldsetOf(element, 'go'), 'Yes'))
    await click(buttonIn(element, 'Submit'))
    await settled()

    expect(fake.calls.find((call) => call.method === 'quirky.ask/answer')?.params).toMatchObject({
      askId: 'ask_api',
      answers: { go: { value: true, source: 'input' } }
    })
    const result = element.querySelector('[data-ask-result]')!
    expect(result.textContent).toContain('Go?: Yes')
    expect(result.getAttribute('role')).toBe('status')
    expect(result.getAttribute('aria-live')).toBe('polite')
    expect(fake.badges.at(-1)).toBeNull()
  })


  test('SC-23: option previews render rich Markdown inside a hostile-content-free sandbox', async () => {
    const content = [
      '## Rich preview',
      '',
      'Use **bold** and `code`.',
      '',
      '<script>globalThis.pwned = true</script>',
      '<img src="https://attacker.invalid/pixel.png" onerror="globalThis.pwned = true">',
      '<a href="javascript:globalThis.pwned = true">hostile link</a>',
      '<iframe src="https://attacker.invalid/frame"></iframe>',
      '<form action="https://attacker.invalid/post"><button>submit</button></form>',
      '<img srcset="https://attacker.invalid/one.png 1x, https://attacker.invalid/two.png 2x" alt="responsive">',
      '<video poster="https://attacker.invalid/poster"><source src="https://attacker.invalid/movie"></video>',
      '<button formaction="https://attacker.invalid/submit">submit outside a form</button>',
      '<div style="background-image: url(https://attacker.invalid/css)">styled</div>',
      '<style>body { background: url(https://attacker.invalid/stylesheet); }</style>',
      '<link rel="stylesheet" href="https://attacker.invalid/style.css">',
      '<base href="https://attacker.invalid/">',
      '<meta http-equiv="refresh" content="0;url=https://attacker.invalid/redirect">'
    ].join('\n')
    const ask: Ask = {
      ...selectAsk('ask_p', 'P', 1),
      spec: {
        questions: [
          {
            id: 'framework',
            type: 'select',
            question: 'Framework?',
            options: [{ value: 'react', label: 'React', preview: { format: 'markdown', content } }, { value: 'vue', label: 'Vue' }]
          }
        ]
      }
    }
    const fake = fakeContext([ask])
    await activated(fake)
    const { element } = await mount(fake)
    expect(element.textContent).not.toContain('Rich preview')

    await click(buttonIn(element, 'Show preview'))

    const frame = element.querySelector('iframe[title="Question preview"]') as HTMLIFrameElement
    expect(frame).not.toBeNull()
    expect(frame.getAttribute('sandbox')).toBe('')
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer')
    expect(buttonIn(element, 'Hide preview')).toBeDefined()

    const preview = new DOMParser().parseFromString(frame.getAttribute('srcdoc')!, 'text/html')
    expect(preview.querySelector('h2')?.textContent).toBe('Rich preview')
    expect(preview.querySelector('strong')?.textContent).toBe('bold')
    expect(preview.querySelector('code')?.textContent).toBe('code')
    expect(preview.body.querySelector('script, img, iframe, object, embed, form, button, video, source, link, style, base')).toBeNull()
    expect([...preview.querySelectorAll('*')].some((node) => [...node.attributes].some((attribute) => /^on/i.test(attribute.name)))).toBe(false)
    expect(preview.querySelector('a')?.textContent).toBe('hostile link')
    expect([...preview.querySelectorAll('*')].some((node) => [...node.attributes].some((attribute) => /^(?:href|src|srcset|action|formaction|target|download)$/i.test(attribute.name)))).toBe(false)
    expect(preview.documentElement.innerHTML).not.toContain('https://attacker.invalid')
    const cspMeta = preview.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy"]')
    const csp = cspMeta?.content ?? ''
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("img-src 'none'")
    expect(csp).toContain("media-src 'none'")
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("navigate-to 'none'")

    const fieldset = fieldsetOf(element, 'framework')
    await click(buttonIn(fieldset, 'React'))
    await type(withOwnAnswer(fieldset), 'a custom framework')
    expect(buttonIn(fieldset, 'React').getAttribute('aria-pressed')).toBe('true')
    expect(withOwnAnswer(fieldset).value).toBe('a custom framework')

    await click(buttonIn(element, 'Hide preview'))
    expect(element.querySelector('iframe[title="Question preview"]')).toBeNull()
  })
  test('a mounted option preview follows the root theme while keeping links inert and the frame sandboxed', async () => {
    const originalTheme = document.documentElement.getAttribute('data-theme')
    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark')
    })

    try {
      const ask: Ask = {
        ...selectAsk('ask_theme', 'Preview theme', 1),
        spec: {
          questions: [{
            id: 'framework',
            type: 'select',
            question: 'Framework?',
            options: [{ value: 'example', label: 'Example', preview: { format: 'markdown', content: '[inert link](https://example.invalid)' } }]
          }]
        }
      }
      const fake = fakeContext([ask])
      await activated(fake)
      const { element } = await mount(fake)
      await click(buttonIn(element, 'Show preview'))

      const frame = element.querySelector('iframe[title="Question preview"]') as HTMLIFrameElement
      const preview = () => new DOMParser().parseFromString(frame.getAttribute('srcdoc')!, 'text/html')
      expect(frame.getAttribute('sandbox')).toBe('')
      expect(preview().documentElement.getAttribute('data-theme')).toBe('dark')
      expect(preview().querySelector('a')?.textContent).toBe('inert link')
      expect(preview().querySelector('a')?.hasAttribute('href')).toBe(false)

      await act(async () => {
        document.documentElement.setAttribute('data-theme', 'light')
        await Promise.resolve()
      })

      expect(preview().documentElement.getAttribute('data-theme')).toBe('light')
      expect(preview().querySelector('a')?.textContent).toBe('inert link')
      expect(preview().querySelector('a')?.hasAttribute('href')).toBe(false)
      expect(frame.getAttribute('sandbox')).toBe('')
    } finally {
      await act(async () => {
        if (originalTheme === null) document.documentElement.removeAttribute('data-theme')
        else document.documentElement.setAttribute('data-theme', originalTheme)
        await Promise.resolve()
      })
    }
  })

  test('SC-24: a resolved event removes the card and clears the badge', async () => {
    const fake = fakeContext([selectAsk('ask_1', 'Short', 1)])
    await activated(fake)
    const { element } = await mount(fake)
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(1)

    fake.drop('ask_1')
    await fake.emit(resolved('ask_1'))

    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(0)
    expect(fake.badges.at(-1)).toBeNull()
    expect(element.querySelector('[data-ask-result]')?.textContent).toContain('Answered')
  })
  test('Q2: the terminal envelope flashes beside the promoted head without counting as pending', async () => {
    const first = { ...selectAsk('ask_1', 'Deploy?', 1), sessionId: 'sess_1' }
    const queued = { ...selectAsk('ask_2', 'Next?', 2), sessionId: 'sess_1', queued: true }
    const fake = fakeContext([first, queued])
    await activated(fake)
    const { element, reports } = await mount(fake)

    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(1)
    expect(fake.badges.at(-1)).toBe(1)

    fake.replace([{ ...queued, queued: false }])
    await fake.emit(resolved('ask_1', {
      status: 'answered',
      askId: 'ask_1',
      answers: { go: { value: true, source: 'input' } },
      skipped: [],
      summary: 'Deploy?: Yes'
    }))
    await settled()

    expect(element.querySelector('[data-ask-result]')?.textContent).toContain('Deploy?: Yes')
    expect(element.querySelectorAll('[data-ask-card]')).toHaveLength(1)
    expect(element.textContent).toContain('Next?')
    expect(fake.badges.at(-1)).toBe(1)
    expect(reports.at(-1)).toMatchObject({ pending: [{ askId: 'ask_2' }], queued: 0 })
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
