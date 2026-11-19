import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { Ask, AskEnvelope, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { act } from 'react'

const CARD = 'view:quirky.ask/card'

type Mount = (element: HTMLElement, props: { input?: unknown }) => (() => void) | void
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

const pending = (id: string): AskEnvelope => ({ status: 'pending', askId: id, answers: {}, skipped: [], summary: '' })

const baseAsk = (id: string, questions: Ask['spec']['questions'], title?: string): Ask => ({
  id,
  spec: { ...(title ? { title } : {}), questions },
  sessionId: null,
  worktreeId: null,
  createdAt: 1,
  envelope: pending(id),
  seq: 0,
  queued: false,
  partial: {},
  expiresAt: null
})

const ordinaryAsk = (id = 'ask_q'): Ask =>
  baseAsk(
    id,
    [{ id: 'env', type: 'select', question: 'Which environment?', options: [{ value: 'prod', label: 'Prod' }, { value: 'dev', label: 'Dev' }] }],
    'Deploy target'
  )

const COMMAND = 'bun run build --filter desktop'

const approvalAsk = (id = 'ask_a'): Ask =>
  baseAsk(
    id,
    [
      {
        id: 'decision',
        type: 'select',
        question: COMMAND,
        required: true,
        options: [
          { value: 'allow', label: 'Allow once' },
          { value: 'always', label: 'Allow for this session' },
          { value: 'deny', label: 'Deny' }
        ]
      },
      { id: 'reason', type: 'text', question: 'Reason, if you deny', required: false }
    ],
    'Run a command?'
  )

const resolvedAsk = (ask: Ask, envelope: AskEnvelope): Ask => ({ ...ask, envelope })

function fakeContext(initial: Ask[]) {
  let asks = [...initial]
  const calls: { method: string; params?: Record<string, unknown> }[] = []
  const toasts: { title: string; body: string }[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()

  const context = {
    pluginId: 'quirky.ask',
    log() {},
    provide: (id: string, implementation: unknown) => void provided.set(id, implementation),
    async call(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params })
      if (method === 'quirky.ask/list') {
        const askId = params?.askId
        return asks.filter((ask) => askId === undefined || ask.id === askId)
      }
      if (method === 'quirky.ask/updatePartial') return { ok: true }
      if (method === 'quirky.ask/answer') {
        const envelope: AskEnvelope = { status: 'answered', askId: String(params?.askId), answers: (params?.answers ?? {}) as AskEnvelope['answers'], skipped: [], summary: 'answered' }
        asks = asks.map((ask) => (ask.id === params?.askId ? resolvedAsk(ask, envelope) : ask))
        return envelope
      }
      throw new Error(`unexpected ${method}`)
    },
    subscribe(listener: (event: QuirkyEvent) => void | Promise<void>) {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    },
    onConnection: () => () => {},
    toast: (title: string, body: string) => void toasts.push({ title, body }),
    setPanelBadge() {}
  } as unknown as UiPluginContext

  return {
    context,
    calls,
    toasts,
    provided,
    add(ask: Ask) {
      asks = [...asks, ask]
    },
    resolve(askId: string, envelope: AskEnvelope) {
      asks = asks.map((ask) => (ask.id === askId ? resolvedAsk(ask, envelope) : ask))
    },
    emit: async (event: QuirkyEvent) => {
      await act(async () => {
        for (const listener of [...listeners]) await listener(event)
      })
    }
  }
}

type Fake = ReturnType<typeof fakeContext>

const settled = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

const mounts: (() => void)[] = []
afterEach(async () => {
  await act(async () => {
    for (const cleanup of mounts.splice(0)) cleanup()
  })
  await ui.deactivate?.()
  document.body.innerHTML = ''
})

async function mountCard(fake: Fake, input: unknown) {
  await act(async () => {
    await ui.activate(fake.context)
  })
  const element = document.createElement('div')
  document.body.appendChild(element)
  const provided = fake.provided.get(CARD) as Mount
  await act(async () => {
    const cleanup = provided(element, { input })
    if (cleanup) mounts.push(cleanup)
  })
  await settled()
  return element
}

const click = (element: Element) =>
  act(async () => {
    ;(element as HTMLElement).click()
  })

const buttonIn = (root: ParentNode, text: string) =>
  [...root.querySelectorAll('button')].find((candidate) => candidate.textContent === text) as HTMLButtonElement | undefined

const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) =>
  act(async () => {
    const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(field, value)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })

const reasonField = (root: ParentNode) => root.querySelector('[data-approval-reason] input, [data-approval-reason] textarea') as HTMLInputElement | null

describe('the ask card view', () => {
  test('is provided by the ask plugin', async () => {
    const fake = fakeContext([])
    await act(async () => {
      await ui.activate(fake.context)
    })
    expect(fake.provided.has(CARD)).toBe(true)
  })

  test('fetches the ask by id and renders the ordinary ask card', async () => {
    const fake = fakeContext([ordinaryAsk('ask_q'), approvalAsk('ask_other')])
    const element = await mountCard(fake, { askId: 'ask_q' })

    expect(fake.calls.find((call) => call.method === 'quirky.ask/list' && call.params?.askId)?.params).toMatchObject({ askId: 'ask_q' })
    const card = element.querySelector('[data-ask-card="ask_q"]')!
    expect(card.querySelector('h2')?.textContent).toBe('Deploy target')
    expect(card.querySelector('fieldset[data-question="env"]')?.textContent).toContain('Which environment?')
    expect(element.querySelector('[data-approval-card]')).toBeNull()
    expect(element.querySelectorAll('[data-ask-card]').length).toBe(1)
  })

  test('renders the approval variant with the command and three buttons', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })

    const card = element.querySelector('[data-approval-card="ask_a"]')!
    expect(card.textContent).toContain(COMMAND)
    expect([...card.querySelectorAll('[data-approval-actions] button')].map((button) => button.textContent)).toEqual([
      'Allow once',
      'Allow for this session',
      'Deny'
    ])
    expect(element.querySelector('[data-ask-card]')).toBeNull()
    expect(buttonIn(element, 'Allow for this session')!.disabled).toBe(false)
  })

  test('shows the reason field only after Deny', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })

    expect(reasonField(element)).toBeNull()
    await click(buttonIn(element, 'Deny')!)
    expect(reasonField(element)).not.toBeNull()
    expect(buttonIn(element, 'Confirm deny')).toBeDefined()
    expect(fake.calls.some((call) => call.method === 'quirky.ask/answer')).toBe(false)
  })

  test('disables Allow for this session with the capability reason as its hover text', async () => {
    const fake = fakeContext([approvalAsk()])
    const reason = 'Codex has no session-wide approval'
    const element = await mountCard(fake, { askId: 'ask_a', sessionApproveDisabled: reason })

    const button = buttonIn(element, 'Allow for this session')!
    expect(button.disabled).toBe(true)
    expect(button.title).toBe(reason)
    expect(buttonIn(element, 'Allow once')!.disabled).toBe(false)
  })

  test('Allow once answers with the allow decision', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })

    await click(buttonIn(element, 'Allow once')!)
    await settled()
    const call = fake.calls.find((entry) => entry.method === 'quirky.ask/answer')!
    expect(call.params).toEqual({
      askId: 'ask_a',
      answers: { decision: { value: 'allow', label: 'Allow once', source: 'option' } },
      skipped: ['reason']
    })
    expect(element.querySelector('[data-approval-record]')?.textContent).toBe(`Allowed once: ${COMMAND}`)
  })

  test('confirming Deny answers with the decision and the typed reason', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })

    await click(buttonIn(element, 'Deny')!)
    await type(reasonField(element)!, 'not on this branch')
    await click(buttonIn(element, 'Confirm deny')!)
    await settled()

    const call = fake.calls.find((entry) => entry.method === 'quirky.ask/answer')!
    expect(call.params).toEqual({
      askId: 'ask_a',
      answers: {
        decision: { value: 'deny', label: 'Deny', source: 'option' },
        reason: { value: 'not on this branch', source: 'input' }
      },
      skipped: []
    })
  })

  test('an answered ask renders a one-line record instead of the card', async () => {
    const answered = resolvedAsk(approvalAsk(), {
      status: 'answered',
      askId: 'ask_a',
      answers: {
        decision: { value: 'deny', label: 'Deny', source: 'option' },
        reason: { value: 'too risky', source: 'input' }
      },
      skipped: [],
      summary: `${COMMAND}: Deny`
    })
    const element = await mountCard(fakeContext([answered]), { askId: 'ask_a' })

    expect(element.querySelector('[data-approval-card]')).toBeNull()
    expect(element.querySelector('button')).toBeNull()
    expect(element.querySelector('[data-approval-record]')?.textContent).toBe('Denied: too risky')
  })

  test('records Allowed for this session and expired approvals', async () => {
    const always = resolvedAsk(approvalAsk('ask_s'), {
      status: 'answered',
      askId: 'ask_s',
      answers: { decision: { value: 'always', label: 'Allow for this session', source: 'option' } },
      skipped: ['reason'],
      summary: ''
    })
    const expired = resolvedAsk(approvalAsk('ask_e'), { status: 'timed_out', askId: 'ask_e', answers: {}, skipped: [], summary: '' })
    const fake = fakeContext([always, expired])

    const first = await mountCard(fake, { askId: 'ask_s' })
    expect(first.querySelector('[data-approval-record]')?.textContent).toBe(`Allowed for this session: ${COMMAND}`)
    const second = await mountCard(fake, { askId: 'ask_e' })
    expect(second.querySelector('[data-approval-record]')?.textContent).toBe(`Expired: ${COMMAND}`)
  })

  test('an approval record stays on one clipped line and expands to the whole command when it is cut off', async () => {
    const always = resolvedAsk(approvalAsk('ask_s'), {
      status: 'answered',
      askId: 'ask_s',
      answers: { decision: { value: 'always', label: 'Allow for this session', source: 'option' } },
      skipped: ['reason'],
      summary: ''
    })
    const fake = fakeContext([always])
    // happy-dom has no layout, so make the record measure wider than its box while it mounts
    const proto = HTMLElement.prototype
    const own = { scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'), clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth') }
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 500 })
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 100 })
    let element: HTMLElement
    try {
      element = await mountCard(fake, { askId: 'ask_s' })
    } finally {
      for (const key of ['scrollWidth', 'clientWidth'] as const) {
        const descriptor = own[key]
        if (descriptor) Object.defineProperty(proto, key, descriptor)
        else delete (proto as unknown as Record<string, unknown>)[key]
      }
    }
    const record = element.querySelector('[data-approval-record]')!
    const text = record.querySelector<HTMLElement>('span[title]')!
    expect(text.style.whiteSpace).toBe('nowrap')
    expect(text.style.textOverflow).toBe('ellipsis')
    const toggle = record.querySelector('button')!
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    await act(async () => toggle.click())
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(record.textContent).toBe(`Allowed for this session: ${COMMAND}`)
    expect(record.querySelector<HTMLElement>('span')!.style.whiteSpace).toBe('pre-wrap')
  })

  test('an approval record that fits has nothing to expand', async () => {
    const expired = resolvedAsk(approvalAsk('ask_e'), { status: 'timed_out', askId: 'ask_e', answers: {}, skipped: [], summary: '' })
    const element = await mountCard(fakeContext([expired]), { askId: 'ask_e' })
    expect(element.querySelector('[data-approval-record] button')).toBeNull()
  })

  test('an answered ordinary ask renders a record with its summary', async () => {
    const answered = resolvedAsk(ordinaryAsk(), {
      status: 'answered',
      askId: 'ask_q',
      answers: { env: { value: 'prod', label: 'Prod', source: 'option' } },
      skipped: [],
      summary: 'Which environment?: Prod'
    })
    const element = await mountCard(fakeContext([answered]), { askId: 'ask_q' })

    expect(element.querySelector('[data-ask-card]')).toBeNull()
    expect(element.querySelector('[data-ask-record]')?.textContent).toBe('Answered: Which environment?: Prod')
  })

  test('refreshes when the ask is created after the card mounted', async () => {
    const fake = fakeContext([])
    const element = await mountCard(fake, { askId: 'ask_a' })
    expect(element.querySelector('[data-approval-card]')).toBeNull()

    const ask = approvalAsk()
    fake.add(ask)
    await fake.emit({ type: 'quirky.ask/created', data: { ask, seq: 5 } })
    await settled()
    expect(element.querySelector('[data-approval-card="ask_a"]')).not.toBeNull()
  })

  test('refreshes into the record when another surface resolves the ask', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })
    expect(element.querySelector('[data-approval-card]')).not.toBeNull()

    const envelope: AskEnvelope = {
      status: 'answered',
      askId: 'ask_a',
      answers: { decision: { value: 'allow', label: 'Allow once', source: 'option' } },
      skipped: ['reason'],
      summary: ''
    }
    fake.resolve('ask_a', envelope)
    await fake.emit({ type: 'quirky.ask/resolved', data: { askId: 'ask_a', envelope, seq: 9 } })
    await settled()
    expect(element.querySelector('[data-approval-record]')?.textContent).toBe(`Allowed once: ${COMMAND}`)
  })

  test('a slower earlier load never restores the actions after a newer load resolved the ask', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })
    expect(element.querySelector('[data-approval-card]')).not.toBeNull()

    const pendingSnapshot = [approvalAsk()]
    const envelope: AskEnvelope = { status: 'answered', askId: 'ask_a', answers: { decision: { value: 'allow', label: 'Allow once', source: 'option' } }, skipped: ['reason'], summary: '' }
    const resolvedSnapshot = [resolvedAsk(approvalAsk(), envelope)]
    const releases: ((asks: Ask[]) => void)[] = []
    const call = fake.context.call.bind(fake.context)
    ;(fake.context as { call: unknown }).call = (method: string, params?: Record<string, unknown>) =>
      method === 'quirky.ask/list' && params?.askId === 'ask_a' ? new Promise<Ask[]>((resolve) => releases.push(resolve)) : call(method, params)

    await fake.emit({ type: 'quirky.ask/created', data: { ask: approvalAsk(), seq: 5 } })
    await fake.emit({ type: 'quirky.ask/resolved', data: { askId: 'ask_a', envelope, seq: 9 } })
    expect(releases).toHaveLength(2)

    await act(async () => releases[1]!(resolvedSnapshot))
    expect(element.querySelector('[data-approval-record]')?.textContent).toBe(`Allowed once: ${COMMAND}`)

    await act(async () => releases[0]!(pendingSnapshot))
    expect(element.querySelector('[data-approval-card]')).toBeNull()
    expect(element.querySelector('[data-approval-record]')?.textContent).toBe(`Allowed once: ${COMMAND}`)
  })

  test('a load that returns pending after the ask resolved locally leaves the record in place', async () => {
    const fake = fakeContext([approvalAsk()])
    const element = await mountCard(fake, { askId: 'ask_a' })
    const releases: ((asks: Ask[]) => void)[] = []
    const call = fake.context.call.bind(fake.context)
    ;(fake.context as { call: unknown }).call = (method: string, params?: Record<string, unknown>) =>
      method === 'quirky.ask/list' && params?.askId === 'ask_a' ? new Promise<Ask[]>((resolve) => releases.push(resolve)) : call(method, params)

    await fake.emit({ type: 'quirky.ask/created', data: { ask: approvalAsk(), seq: 5 } })
    await click(buttonIn(element, 'Allow once')!)
    expect(element.querySelector('[data-approval-record]')).not.toBeNull()

    await act(async () => {
      for (const release of releases) release([approvalAsk()])
    })
    expect(element.querySelector('[data-approval-card]')).toBeNull()
    expect(element.querySelector('[data-approval-record]')).not.toBeNull()
  })

  test('a missing ask id renders nothing to act on', async () => {
    const element = await mountCard(fakeContext([approvalAsk()]), {})
    expect(element.querySelector('button')).toBeNull()
  })

  test('shows a loading line until the ask has been read', async () => {
    const fake = fakeContext([approvalAsk()])
    const call = fake.context.call.bind(fake.context)
    let release: (asks: Ask[]) => void = () => {}
    ;(fake.context as { call: unknown }).call = (method: string, params?: Record<string, unknown>) =>
      method === 'quirky.ask/list' && params?.askId === 'ask_a' ? new Promise<Ask[]>((resolve) => { release = resolve }) : call(method, params)
    const element = await mountCard(fake, { askId: 'ask_a' })
    expect(element.querySelector('.ui-notice-line')?.textContent).toBe('Loading question…')
    expect(element.querySelector('[data-approval-card]')).toBeNull()

    await act(async () => release([approvalAsk()]))
    expect(element.querySelector('.ui-notice-line')).toBeNull()
    expect(element.querySelector('[data-approval-card]')).not.toBeNull()
  })

  test('says so when the daemon no longer has the ask', async () => {
    const element = await mountCard(fakeContext([]), { askId: 'ask_gone' })
    expect(element.querySelector('.ui-empty-state')?.textContent).toBe('This question is no longer available.')
    expect(element.querySelector('button')).toBeNull()
  })

  test('a failed read shows the error and Retry reads the ask again', async () => {
    const fake = fakeContext([approvalAsk()])
    const call = fake.context.call.bind(fake.context)
    let failing = true
    ;(fake.context as { call: unknown }).call = async (method: string, params?: Record<string, unknown>) => {
      if (method === 'quirky.ask/list' && params?.askId === 'ask_a' && failing) throw new Error('daemon unreachable')
      return call(method, params)
    }
    const element = await mountCard(fake, { askId: 'ask_a' })
    expect(element.querySelector('[role="alert"]')?.textContent).toContain('daemon unreachable')

    failing = false
    await click(buttonIn(element, 'Retry')!)
    await settled()
    expect(element.querySelector('[role="alert"]')).toBeNull()
    expect(element.querySelector('[data-approval-card]')).not.toBeNull()
  })
})
