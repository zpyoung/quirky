import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { CommandHandler, MountFunction, QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { DockState, PickerItem, SendResult } from '../src/types'

const COMPOSER_VIEW = 'view:quirky.terminal-dock/composer'
const SETTINGS_VIEW = 'view:quirky.terminal-dock/settings'
const PLUGIN_METHOD = 'quirky.terminal-dock/'
const SETTLE_MS = 5

type Call = { method: string; params: Record<string, unknown> }
type Handler = (params: Record<string, unknown>) => unknown

type FakeOptions = {
  state?: DockState
  history?: string[]
  pickers?: Partial<Record<'slash' | 'file', PickerItem[]>>
  sendOutcome?: 'observed-cleared' | 'unobservable' | 'may-not-have-sent' | 'refused' | 'cancelled'
  settings?: Record<string, boolean>
  deferSend?: boolean
  uiSlots?: unknown[]
}

type Fake = {
  context: UiPluginContext
  calls: Call[]
  provided: Map<string, unknown>
  opened: { id: string; input?: unknown }[]
  toasts: { title: string; body: string }[]
  sent: { id?: string; text: string; params: Record<string, unknown> }[]
  readonly state: DockState
  callsTo(method: string): Call[]
  announce(change: Partial<DockState>): void
  completeSend(recoveredDraft: string, outcome: SendResult['outcome']): void
  resolveSend(outcome: SendResult['outcome'], accepted: boolean): void
  announceAgentStatus(row: { sessionId: string; state?: string } | null): void
}

const baseState = (overrides: Partial<DockState> = {}): DockState => ({
  pane: 'pane-a',
  session: 'session-a',
  tab: 'tab-a',
  revision: 1,
  enabled: true,
  supported: true,
  agent: 'claude',
  docked: true,
  userUndocked: false,
  gutterRows: 5,
  mounted: true,
  passthrough: false,
  draft: '',
  attachments: [],
  disabledReason: null,
  activeSend: null,
  queuedSends: [],
  question: null,
  options: {
    model: 'sonnet',
    effort: 'medium',
    permission: 'default',
    choices: { model: ['sonnet', 'opus'], effort: ['low', 'medium', 'high'], permission: ['default', 'acceptEdits'] },
    context: { used: 25, limit: 100 },
    notice: null
  },
  notice: null,
  ...overrides
})

function fakeContext(options: FakeOptions = {}): Fake {
  const calls: Call[] = []
  const provided = new Map<string, unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void>()
  const opened: { id: string; input?: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const settings = { enabled: true, autoOpen: true, ...options.settings }
  const history = options.history ?? ['previous prompt', 'older prompt']
  let current = options.state ?? baseState()
  let historyCursor = -1
  let historyReturn = ''
  let fileOrdinal = 0
  const sent: { id?: string; text: string; params: Record<string, unknown> }[] = []
  let completeDeferredSend: ((recoveredDraft: string, outcome: SendResult['outcome']) => void) | null = null
  let resolveDeferredSend: ((outcome: SendResult['outcome'], accepted: boolean) => void) | null = null
  let deferredSendId: string | null = null
  let deferredSendText: string | null = null

  const publish = () => {
    const event = { type: 'quirky.terminal-dock/changed', data: { pane: current.pane, state: current } } as QuirkyEvent
    for (const listener of listeners) listener(event)
  }
  const commit = (change: Partial<DockState>): DockState => {
    current = { ...current, ...change, revision: current.revision + 1 }
    publish()
    return current
  }
  const handlers: Record<string, Handler> = {
    [`${PLUGIN_METHOD}get`]: () => current,
    [`${PLUGIN_METHOD}set`]: (params) => {
      if (('draft' in params || 'attachments' in params) && params.revision !== current.revision) {
        throw Object.assign(new Error('draft revision conflict'), { code: 'CONFLICT', state: current })
      }
      const { revision: _revision, ...change } = params
      return commit(change as Partial<DockState>)
    },
    [`${PLUGIN_METHOD}pick`]: (params) => ({ items: options.pickers?.[params.kind as 'slash' | 'file'] ?? [], truncated: false }),
    [`${PLUGIN_METHOD}send`]: (params) => {
      const text = typeof params.text === 'string' ? params.text : current.draft
      const id = typeof params.id === 'string' ? params.id : 'send-a'
      sent.push({ id, text, params })
      if (options.deferSend) {
        deferredSendId = id
        deferredSendText = text
        commit({ draft: '', attachments: [], activeSend: { id, phase: 'submitting' } })
        const { promise, resolve } = Promise.withResolvers<unknown>()
        const finish = (outcome: SendResult['outcome'], accepted = true) => resolve({ id, outcome, accepted })
        resolveDeferredSend = (outcome, accepted) => finish(outcome, accepted)
        completeDeferredSend = (recoveredDraft, outcome) => {
          commit({ draft: recoveredDraft, activeSend: null })
          finish(outcome)
        }
        return promise
      }
      commit({ draft: '', attachments: [], activeSend: null })
      return { id, outcome: options.sendOutcome ?? 'observed-cleared', accepted: true }
    },
    // Queued cancellation recovers synchronously; the send response is released separately.
    [`${PLUGIN_METHOD}cancel`]: () => {
      const wasQueued = deferredSendId !== null && current.queuedSends.some((send) => send.id === deferredSendId)
      const recoveredDraft = wasQueued && deferredSendText !== null
        ? current.draft === '' ? deferredSendText : `${deferredSendText}\n\n${current.draft}`
        : current.draft
      return commit({ draft: recoveredDraft, activeSend: null, queuedSends: [] })
    },
    [`${PLUGIN_METHOD}history`]: (params) => {
      if (params.direction === 'previous') {
        if (historyCursor < 0) historyReturn = current.draft
        historyCursor = Math.min(history.length - 1, historyCursor + 1)
      } else if (params.direction === 'next') {
        historyCursor -= 1
      }
      const draft = historyCursor < 0 ? historyReturn : history[historyCursor] ?? ''
      const state = commit({ draft })
      return { entries: history, state }
    },
    [`${PLUGIN_METHOD}attach`]: (params) => {
      const name = String(params.name ?? 'attachment')
      const attachment = { id: `attachment-${++fileOrdinal}`, name, path: `/quirky/uploads/${fileOrdinal}`, mime: String(params.mime ?? 'application/octet-stream'), image: String(params.mime ?? '').startsWith('image/') }
      return commit({ attachments: [...current.attachments, attachment] })
    },
    [`${PLUGIN_METHOD}removeAttachment`]: (params) => commit({ attachments: current.attachments.filter((attachment) => attachment.id !== params.attachment) }),
    [`${PLUGIN_METHOD}interaction`]: (params) => {
      if (!current.question || params.request !== current.question.id) return current
      if (params.action === 'collapse') return commit({ question: { ...current.question, collapsed: true } })
      if (params.action === 'expand') return commit({ question: { ...current.question, collapsed: false, dismissed: false } })
      if (params.action === 'dismiss') return commit({ question: { ...current.question, dismissed: true } })
      if (params.action === 'answer') return commit({ question: null })
      return current
    },
    [`${PLUGIN_METHOD}options`]: (params) => {
      if (!params.kind || !params.value) return current
      const kind = params.kind as 'model' | 'effort' | 'permission'
      return commit({ options: { ...current.options, [kind]: params.value as string, notice: 'Sent to the agent — not confirmed' } })
    },
    'ui.state': () => ({
      windows: [],
      layout: { view: null, panel: null, sidebar: true, focus: null },
      slots: options.uiSlots ?? [{ id: 'view:quirky.terminal/workspace', kind: 'view', plugin: 'quirky.terminal', title: 'Terminal', shown: true, report: { focusedPane: current.pane, focused: true, focusSequence: 1, panes: [] } }]
    }),
    'setting.set': (params) => {
      const name = String(params.id).replace('setting:quirky.terminal-dock/', '')
      settings[name as 'enabled' | 'autoOpen'] = params.value as boolean
      return {}
    }
  }
  const context = {
    pluginId: 'quirky.terminal-dock',
    log() {},
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Record<string, unknown> = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new Error(`unknown method: ${method}`)
      return handler(params)
    },
    subscribe(listener: (event: QuirkyEvent) => void) { listeners.add(listener); return () => listeners.delete(listener) },
    getSetting(name: string) {
      const key = name.replace(/^setting:quirky\.terminal-dock\//, '') as 'enabled' | 'autoOpen'
      if (!(key in settings)) throw new Error(`unknown setting: ${name}`)
      return settings[key]
    },
    async executeCommand() {},
    openView(id: string, input?: unknown) { opened.push({ id, input }) },
    closeView() {},
    togglePanel() {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    async confirm() { return true },
    toast(title: string, body: string) { toasts.push({ title, body }) },
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  } as unknown as UiPluginContext

  return {
    context,
    calls,
    provided,
    opened,
    toasts,
    sent,
    get state() { return current },
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    announce(change: Partial<DockState>) { commit(change) },
    announceAgentStatus(row: { sessionId: string; state?: string } | null) {
      const event = { type: 'quirky.agent-status/changed', data: { sessionId: current.session, row } } as QuirkyEvent
      for (const listener of listeners) listener(event)
    },
    completeSend(recoveredDraft, outcome) {
      if (completeDeferredSend === null) throw new Error('no deferred send is active')
      const complete = completeDeferredSend
      completeDeferredSend = null
      resolveDeferredSend = null
      deferredSendId = null
      deferredSendText = null
      complete(recoveredDraft, outcome)
    },
    resolveSend(outcome, accepted) {
      if (resolveDeferredSend === null) throw new Error('no deferred send is active')
      const resolve = resolveDeferredSend
      completeDeferredSend = null
      resolveDeferredSend = null
      deferredSendId = null
      deferredSendText = null
      resolve(outcome, accepted)
    }
  }
}

let activate: (context: UiPluginContext) => void
let mounted: (() => void) | void
let element: HTMLElement | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Import after registering happy-dom so React DOM binds to the active document.
  ;({ activate } = await import('../src/ui'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (mounted) await act(async () => void (mounted as () => void)())
  mounted = undefined
  element?.remove()
  element = null
  document.body.innerHTML = ''
})

async function settle(): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, SETTLE_MS)
  await act(async () => await promise)
}

async function openComposer(fake: Fake, input: { pane?: string; session?: string } = {}) {
  activate(fake.context)
  element = document.createElement('div')
  document.body.appendChild(element)
  await act(async () => {
    const mount = fake.provided.get(COMPOSER_VIEW) as MountFunction
    mounted = mount(element!, { input: { pane: input.pane ?? 'pane-a', session: input.session ?? 'session-a' } })
  })
  await settle()
  const root = element
  const editor = () => root!.querySelector('textarea[aria-label="Message to agent"]') as HTMLTextAreaElement
  const byLabel = (name: string) => root!.querySelector(`[aria-label="${name}"]`) as HTMLElement | null
  const button = (name: string) => [...root!.querySelectorAll('button')].find((node) => node.textContent?.trim() === name) as HTMLButtonElement | undefined
  const click = async (target: HTMLElement) => act(async () => void target.click())
  const type = async (value: string) => act(async () => {
    const field = editor()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(field, value)
    field.setSelectionRange(value.length, value.length)
    field.dispatchEvent(new Event('input', { bubbles: true }))
  })
  const key = async (keyValue: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: keyValue, bubbles: true, cancelable: true, ...init })
    await act(async () => void editor().dispatchEvent(event))
    return event
  }
  return { root: root!, editor, byLabel, button, click, type, key, text: () => root!.textContent ?? '' }
}

async function openSettings(fake: Fake) {
  activate(fake.context)
  element = document.createElement('div')
  document.body.appendChild(element)
  await act(async () => {
    const mount = fake.provided.get(SETTINGS_VIEW) as MountFunction
    mounted = mount(element!, { input: undefined })
  })
  await settle()
  return element
}

describe('terminal dock composer behavior', () => {
  test('preserves multiline and IME input, ignores empty Enter, and sends each nonempty draft once', async () => {
    const fake = fakeContext()
    const view = await openComposer(fake)
    const emptyEnter = await view.key('Enter')
    expect(emptyEnter.defaultPrevented).toBe(true)
    expect(fake.sent).toHaveLength(0)
    await view.type('Review **this**')

    const shifted = await view.key('Enter', { shiftKey: true })
    expect(shifted.defaultPrevented).toBe(false)
    expect(fake.sent).toHaveLength(0)
    await view.type('Review **this**\nplease')

    await act(async () => void view.editor().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })))
    const composingEnter = await view.key('Enter', { isComposing: true })
    expect(composingEnter.defaultPrevented).toBe(false)
    expect(fake.sent).toHaveLength(0)
    await act(async () => void view.editor().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })))

    const submit = await view.key('Enter')
    expect(submit.defaultPrevented).toBe(true)
    await settle()
    expect(fake.callsTo(`${PLUGIN_METHOD}set`).some((call) => call.params.draft === 'Review **this**\nplease')).toBe(true)
    expect(fake.sent).toHaveLength(1)
    expect(fake.sent[0]!.text).toBe('Review **this**\nplease')
    expect(view.editor().value).toBe('')
    expect(fake.state.draft).toBe('')
    await view.type('command enter')
    const commandSubmit = await view.key('Enter', { metaKey: true })
    expect(commandSubmit.defaultPrevented).toBe(true)
    await settle()
    expect(fake.sent.map((send) => send.text)).toEqual(['Review **this**\nplease', 'command enter'])
    expect(fake.sent[0]!.id).not.toBe(fake.sent[1]!.id)
  })

  test('filters slash skills and @ files, supports keyboard selection, and Escape closes the picker first', async () => {
    const fake = fakeContext({ pickers: {
      slash: [
        { id: 'skill:review', label: 'review', insert: '/review ', kind: 'skill', detail: 'Workspace skill' },
        { id: 'command:compact', label: 'compact', insert: '/compact ', kind: 'command' }
      ],
      file: [{ id: 'src/model.ts', label: 'src/model.ts', insert: '@src/model.ts ', kind: 'file' }]
    } })
    const view = await openComposer(fake)
    await view.type('/rev')
    await settle()
    expect(view.text()).toContain('review')
    await view.key('ArrowDown')
    await view.key('Enter')
    expect(view.editor().value).toBe('/compact ')
    expect(fake.callsTo(`${PLUGIN_METHOD}pick`).some((call) => call.params.kind === 'slash')).toBe(true)

    await view.type('Check @src/mo')
    await settle()
    expect(view.text()).toContain('src/model.ts')
    await view.key('ArrowDown')
    await view.key('Enter')
    expect(view.editor().value).toBe('Check @src/model.ts ')
    expect(fake.callsTo(`${PLUGIN_METHOD}pick`).some((call) => call.params.kind === 'file')).toBe(true)

    await view.type('/rev')
    await settle()
    const escape = await view.key('Escape')
    expect(escape.defaultPrevented).toBe(true)
    expect(view.text()).not.toContain('review')
    expect(fake.callsTo(`${PLUGIN_METHOD}cancel`)).toHaveLength(0)
  })

  test('history browsing walks backward and restores the original draft at the newest edge', async () => {
    const fake = fakeContext({ history: ['second prompt', 'first prompt'] })
    const view = await openComposer(fake)

    await view.key('ArrowUp')
    await settle()
    expect(view.editor().value).toBe('second prompt')
    await view.key('ArrowUp')
    await settle()
    expect(view.editor().value).toBe('first prompt')
    await view.key('ArrowDown')
    await settle()
    expect(view.editor().value).toBe('second prompt')
    await view.key('ArrowDown')
    await settle()
    expect(view.editor().value).toBe('')
    expect(fake.callsTo(`${PLUGIN_METHOD}history`).map((call) => call.params.direction)).toEqual(['previous', 'previous', 'next', 'next'])
  })

  test('does not replace or send a conflicted newer daemon draft over local unsynchronized typing', async () => {
    const fake = fakeContext()
    const view = await openComposer(fake)
    await view.type('local unsynced text')
    await act(async () => fake.announce({ revision: fake.state.revision + 1, draft: 'newer remote draft' }))

    const send = view.button('Send')!
    expect(send.disabled).toBe(true)
    expect(view.editor().value).toBe('local unsynced text')
    expect(view.text()).toContain('conflict')
    await view.key('Enter')
    await settle()
    expect(fake.sent).toHaveLength(0)
    expect(fake.state.draft).toBe('newer remote draft')
  })

  test('uploads a dropped file through the daemon, keeps the draft, and removes only its own chip', async () => {
    const fake = fakeContext({ state: baseState({ draft: 'Explain this' }) })
    const view = await openComposer(fake)
    const file = new File(['image bytes'], 'diagram.png', { type: 'image/png' })
    const drop = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(drop, 'dataTransfer', { value: { files: [file] } })
    await act(async () => void view.root.querySelector('.qtd-composer')!.dispatchEvent(drop))
    await settle()

    const upload = fake.callsTo(`${PLUGIN_METHOD}attach`)[0]
    expect(upload?.params).toMatchObject({ name: 'diagram.png', mime: 'image/png' })
    expect(typeof upload?.params.base64).toBe('string')
    expect(fake.state.draft).toBe('Explain this')
    expect(view.text()).toContain('diagram.png')

    const remove = view.byLabel('Remove diagram.png')!
    await view.click(remove)
    await settle()
    expect(fake.state.attachments).toHaveLength(0)
    expect(fake.state.draft).toBe('Explain this')
    const pasted = new File(['clipboard bytes'], 'clipboard.png', { type: 'image/png' })
    const paste = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(paste, 'clipboardData', { value: { files: [pasted] } })
    await act(async () => void view.editor().dispatchEvent(paste))
    await settle()
    expect(paste.defaultPrevented).toBe(true)
    expect(fake.callsTo(`${PLUGIN_METHOD}attach`).at(-1)?.params.name).toBe('clipboard.png')

    const selected = new File(['selected bytes'], 'notes.txt', { type: 'text/plain' })
    const input = view.byLabel('Attach files') as HTMLInputElement
    Object.defineProperty(input, 'files', { configurable: true, value: [selected] })
    await act(async () => void input.dispatchEvent(new Event('change', { bubbles: true })))
    await settle()
    expect(fake.callsTo(`${PLUGIN_METHOD}attach`).at(-1)?.params.name).toBe('notes.txt')
    expect(fake.state.attachments).toHaveLength(2)
    expect(fake.state.draft).toBe('Explain this')
  })

  test('renders actual question choices, preserves the draft, and releases send only after answering', async () => {
    const question = {
      id: 'request-1',
      kind: 'question' as const,
      title: 'Choose an approach',
      questions: [{ prompt: 'Which option?', choices: [{ label: 'A', value: 'a' }, { label: 'B', value: 'b' }], multiple: false }],
      collapsed: false,
      dismissed: false
    }
    const fake = fakeContext({ state: baseState({ draft: 'next prompt', question }) })
    const view = await openComposer(fake)
    expect(view.text()).toContain('Choose an approach')
    expect(view.button('Send')!.disabled).toBe(true)

    await view.click(view.button('Collapse question')!)
    await settle()
    expect(view.text()).not.toContain('Which option?')
    await view.click(view.button('Expand question')!)
    await settle()
    expect(view.text()).toContain('Which option?')

    const option = view.byLabel('B') as HTMLInputElement
    await view.click(option)
    await view.click(view.button('Submit answer')!)
    await settle()
    const answer = fake.callsTo(`${PLUGIN_METHOD}interaction`).find((call) => call.params.action === 'answer')
    expect(answer?.params.answers).toEqual([['b']])
    expect(fake.state.question).toBeNull()
    expect(fake.state.draft).toBe('next prompt')
    expect(view.button('Send')!.disabled).toBe(false)
  })

  test('a dismissed unresolved request stays hidden but continues to disable prompt sending', async () => {
    const question = {
      id: 'permission-1', kind: 'permission' as const, title: 'Allow file access?',
      questions: [{ prompt: 'Read src/private.ts?', choices: [{ label: 'Allow', value: 'allow' }, { label: 'Deny', value: 'deny' }], multiple: false }],
      collapsed: false, dismissed: false
    }
    const fake = fakeContext({ state: baseState({ question }) })
    const view = await openComposer(fake)
    await view.click(view.byLabel('Dismiss question')!)
    await settle()
    expect(view.text()).not.toContain('Read src/private.ts?')
    expect(view.button('Send')!.disabled).toBe(true)
    expect(fake.state.question?.dismissed).toBe(true)
  })

  test('keeps a reported model selected when it is absent from the advertised choices', async () => {
    const options = baseState().options
    const fake = fakeContext({ state: baseState({
      options: { ...options, model: 'fable', choices: { ...options.choices, model: ['opus', 'sonnet'] } }
    }) })
    const view = await openComposer(fake)
    const model = view.byLabel('Model') as HTMLSelectElement

    expect(model.value).toBe('fable')
    expect(model.options[model.selectedIndex]?.textContent).toBe('fable (current)')
  })

  test('uses session option actions and reports real or unknown context without global writes', async () => {
    const fake = fakeContext()
    const view = await openComposer(fake)
    expect(view.text()).toContain('25%')
    const model = view.byLabel('Model') as HTMLSelectElement
    await act(async () => {
      model.value = 'opus'
      model.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await settle()
    expect(fake.callsTo(`${PLUGIN_METHOD}options`).at(-1)?.params).toMatchObject({ kind: 'model', value: 'opus' })
    expect(fake.callsTo('setting.set')).toHaveLength(0)
    expect(view.text()).toContain('Sent to the agent — not confirmed')

    await act(async () => fake.announce({ options: { ...fake.state.options, context: null, model: null } }))
    await settle()
    expect(view.text()).toContain('Context usage unknown')
  })

  test('shows the exact uncertainty warning and keeps sending disabled while the daemon reports a foreign driver', async () => {
    const fake = fakeContext({ sendOutcome: 'may-not-have-sent' })
    const view = await openComposer(fake)
    await view.type('check delivery')
    await view.key('Enter')
    await settle()
    expect(view.text()).toContain('Send may not have completed. Check the terminal before retrying.')

    await act(async () => fake.announce({ draft: 'wait', disabledReason: 'Mobile device is composing' }))
    await settle()
    expect(view.text()).toContain('Mobile device is composing')
    expect(view.button('Send')!.disabled).toBe(true)
  })

  test('restores an uncertain prompt in front of newer unsynchronized typing', async () => {
    const fake = fakeContext({ state: baseState({ draft: 'first' }), deferSend: true })
    const view = await openComposer(fake)
    await view.key('Enter')
    await settle()
    expect(fake.sent[0]?.text).toBe('first')

    await view.type('second')
    await act(async () => fake.completeSend('first', 'may-not-have-sent'))
    await settle()
    expect(view.editor().value).toBe('first\n\nsecond')
    expect(view.text()).toContain('Send may not have completed. Check the terminal before retrying.')
    expect(view.text()).not.toContain('Draft conflict')
    expect(fake.state.draft).toBe('first')
  })
  test('pane-scoped focus command targets its registered editor and settings expose the experimental auto-open control', async () => {
    const fake = fakeContext({ settings: { enabled: false, autoOpen: true } })
    const view = await openComposer(fake)
    const focus = fake.provided.get('command:quirky.terminal-dock/focus') as CommandHandler
    await act(async () => { await focus({ pane: 'pane-a' }) })
    expect(document.activeElement).toBe(view.editor())

    if (mounted) await act(async () => void (mounted as () => void)())
    mounted = undefined
    element?.remove()
    element = null
    const settingsView = await openSettings(fake)
    expect(settingsView!.textContent).toContain('Experimental')
    const enabled = settingsView!.querySelector('input[aria-label="Terminal dock (Experimental)"]') as HTMLInputElement
    const autoOpen = settingsView!.querySelector('input[aria-label="Open automatically for recognized agents (Experimental)"]') as HTMLInputElement
    expect(enabled.checked).toBe(false)
    expect(autoOpen.closest('label')?.textContent).toContain('Experimental')
    expect(autoOpen.checked).toBe(true)
    expect(autoOpen.disabled).toBe(true)
    await view.click(enabled)
    await settle()
    expect(autoOpen.disabled).toBe(false)
    expect(fake.callsTo('setting.set').at(-1)?.params).toMatchObject({ id: 'setting:quirky.terminal-dock/enabled', value: true })
  })
  test('routes window commands through the active terminal report and canonical daemon methods', async () => {
    const fake = fakeContext()
    const view = await openComposer(fake)
    const invoke = async (name: string, args?: unknown) => {
      const handler = fake.provided.get(`command:quirky.terminal-dock/${name}`) as CommandHandler
      let result: unknown = undefined
      await act(async () => { result = await handler(args) })
      return result
    }

    await invoke('toggle')
    expect(fake.callsTo('ui.state').length).toBeGreaterThan(0)
    expect(fake.state.docked).toBe(false)
    await invoke('passthrough')
    expect(fake.state.passthrough).toBe(true)
    expect(view.text()).toContain('Passthrough active — terminal has keyboard focus')
    await invoke('resize', { pane: 'pane-a', gutterRows: 20 })
    expect(fake.state.gutterRows).toBe(15)
    await invoke('draft', { pane: 'pane-a', text: 'from command' })
    expect(view.editor().value).toBe('from command')
    await invoke('send', { pane: 'pane-a' })
    expect(fake.sent.map((send) => send.text)).toEqual(['from command'])
    await invoke('passthrough')
    await view.type('unsaved history draft')
    await invoke('history', { pane: 'pane-a', direction: 'previous' })
    const historyIndex = fake.calls.findIndex((call) => call.method === `${PLUGIN_METHOD}history`)
    const draftIndex = fake.calls.findIndex((call) => call.method === `${PLUGIN_METHOD}set` && call.params.draft === 'unsaved history draft')
    expect(draftIndex).toBeGreaterThanOrEqual(0)
    expect(historyIndex).toBeGreaterThan(draftIndex)
    expect(fake.state.draft).toBe('previous prompt')
    await invoke('options', { pane: 'pane-a' })
    expect(fake.callsTo(`${PLUGIN_METHOD}options`).length).toBeGreaterThan(0)
    await invoke('cancel', { pane: 'pane-a', interrupt: true })
    expect(fake.callsTo(`${PLUGIN_METHOD}cancel`).at(-1)?.params).toMatchObject({ interrupt: true })
    await invoke('settings')
    expect(fake.opened.at(-1)?.id).toBe(SETTINGS_VIEW)
  })

  test('canonical set command forwards the whole mutation and absolute passthrough values', async () => {
    const fake = fakeContext()
    activate(fake.context)
    const set = fake.provided.get('command:quirky.terminal-dock/set') as CommandHandler
    const mutation = {
      pane: 'pane-a',
      revision: 1,
      docked: true,
      gutterRows: 9,
      passthrough: true,
      draft: 'preserve the composite update',
      attachments: []
    }
    let result: unknown
    await act(async () => { result = await set(mutation) })
    expect(fake.callsTo(`${PLUGIN_METHOD}set`).at(-1)?.params).toEqual(mutation)
    expect(result).toMatchObject({ docked: true, gutterRows: 9, passthrough: true, draft: 'preserve the composite update' })

    for (const passthrough of [true, true, false, false]) {
      await act(async () => { await set({ pane: 'pane-a', passthrough }) })
      expect(fake.callsTo(`${PLUGIN_METHOD}set`).at(-1)?.params).toEqual({ pane: 'pane-a', passthrough })
      expect(fake.state.passthrough).toBe(passthrough)
    }
  })

  test('routes main and floating panes by focus ownership and preserves focus order when the palette owns focus', async () => {
    const toggleWithoutPane = async (fake: Fake) => {
      activate(fake.context)
      const toggle = fake.provided.get('command:quirky.terminal-dock/toggle') as CommandHandler
      let result: unknown = undefined
      await act(async () => { result = await toggle() })
      return result
    }
    const floatingState = baseState({ pane: 'floating-pane' })
    const mainAndFloating = [
      { id: 'view:quirky.terminal/workspace', kind: 'view', plugin: 'quirky.terminal', title: 'Terminal', shown: true, report: { focusedPane: 'main-pane', focused: true, focusSequence: 3 } },
      { id: 'overlay:quirky.terminal/floating', kind: 'overlay', plugin: 'quirky.terminal', title: 'Floating', shown: true, report: { shown: true, focusedPane: 'floating-pane', focused: false, focusSequence: 4 } }
    ]
    const mainFocused = fakeContext({ state: baseState({ pane: 'main-pane' }), uiSlots: mainAndFloating })
    await toggleWithoutPane(mainFocused)
    expect(mainFocused.callsTo(`${PLUGIN_METHOD}set`).at(-1)?.params.pane).toBe('main-pane')

    const paletteOwnsFocus = fakeContext({ state: baseState({ pane: 'floating-pane' }), uiSlots: [
      { id: 'view:quirky.terminal/workspace', kind: 'view', plugin: 'quirky.terminal', title: 'Terminal', shown: true, report: { focusedPane: 'main-pane', focused: false, focusSequence: 9 } },
      { id: 'overlay:quirky.terminal/floating', kind: 'overlay', plugin: 'quirky.terminal', title: 'Floating', shown: true, report: { shown: true, focusedPane: 'floating-pane', focused: false, focusSequence: 10 } }
    ] })
    await toggleWithoutPane(paletteOwnsFocus)
    expect(paletteOwnsFocus.callsTo(`${PLUGIN_METHOD}set`).at(-1)?.params.pane).toBe('floating-pane')
    const soleCandidate = fakeContext({ state: baseState({ pane: 'only-pane' }), uiSlots: [
      { id: 'view:quirky.terminal/workspace', kind: 'view', plugin: 'quirky.terminal', title: 'Terminal', shown: true, report: { focusedPane: 'only-pane', focused: false, focusSequence: 0 } }
    ] })
    await toggleWithoutPane(soleCandidate)
    expect(soleCandidate.callsTo(`${PLUGIN_METHOD}set`).at(-1)?.params.pane).toBe('only-pane')

    const ambiguous = fakeContext({ state: floatingState, uiSlots: [
      { id: 'view:quirky.terminal/workspace', kind: 'view', plugin: 'quirky.terminal', title: 'Terminal', shown: true, report: { focusedPane: 'main-pane', focused: false, focusSequence: 0 } },
      { id: 'overlay:quirky.terminal/floating', kind: 'overlay', plugin: 'quirky.terminal', title: 'Floating', shown: true, report: { shown: true, focusedPane: 'floating-pane', focused: false, focusSequence: 0 } }
    ] })
    expect(await toggleWithoutPane(ambiguous)).toMatchObject({ ok: false })
    expect(ambiguous.callsTo(`${PLUGIN_METHOD}set`)).toHaveLength(0)
  })
  test('Stop cancels the active pane operation and passthrough status remains explicit', async () => {
    const fake = fakeContext({ state: baseState({ passthrough: true, activeSend: { id: 'send-a', phase: 'submitting' } }) })
    const view = await openComposer(fake)
    expect(view.text()).toContain('Passthrough active — terminal has keyboard focus')
    expect(view.button('Stop')!.disabled).toBe(false)
    await view.click(view.button('Stop')!)
    await settle()
    expect(fake.callsTo(`${PLUGIN_METHOD}cancel`).at(-1)?.params).toMatchObject({ pane: 'pane-a', interrupt: true })
    expect(fake.state.activeSend).toBeNull()
    await act(async () => fake.announceAgentStatus({ sessionId: 'session-a', state: 'working' }))
    await settle()
    expect(view.button('Stop')!.disabled).toBe(false)
    await view.click(view.button('Stop')!)
    await settle()
    expect(fake.callsTo(`${PLUGIN_METHOD}cancel`)).toHaveLength(2)
    await act(async () => fake.announceAgentStatus(null))
    await settle()
    expect(view.button('Send')).toBeDefined()
  })

  test('preserves a cancelled prompt and newer draft when Stop races a queued send', async () => {
    const fake = fakeContext({ state: baseState({ draft: 'first' }), deferSend: true })
    const view = await openComposer(fake)
    await view.key('Enter')
    await settle()
    expect(fake.sent[0]?.text).toBe('first')

    const sendId = fake.sent[0]!.id!
    await act(async () => fake.announce({ activeSend: null, queuedSends: [{ id: sendId, phase: 'queued' }] }))
    await view.type('second')
    await view.click(view.button('Stop')!)
    await settle()

    fake.resolveSend('cancelled', false)
    await settle()
    expect(view.editor().value).toBe('first\n\nsecond')
    expect(view.text()).not.toContain('Send may not have completed.')
    expect(fake.sent).toHaveLength(1)
  })

  test('preserves a cancelled prompt and newer draft when Escape races a queued send', async () => {
    const fake = fakeContext({ state: baseState({ draft: 'first' }), deferSend: true })
    const view = await openComposer(fake)
    await view.key('Enter')
    await settle()
    expect(fake.sent[0]?.text).toBe('first')

    const sendId = fake.sent[0]!.id!
    await act(async () => fake.announce({ activeSend: null, queuedSends: [{ id: sendId, phase: 'queued' }] }))
    await view.type('second')
    const escape = await view.key('Escape')
    expect(escape.defaultPrevented).toBe(true)
    await settle()

    fake.resolveSend('cancelled', false)
    await settle()
    expect(view.editor().value).toBe('first\n\nsecond')
    expect(view.text()).not.toContain('Send may not have completed.')
    expect(fake.sent).toHaveLength(1)
  })
})
