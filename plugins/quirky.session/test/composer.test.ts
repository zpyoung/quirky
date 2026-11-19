import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView } from '@codemirror/view'
import { RpcError, RpcErrorCode, type AgentCapabilities, type PermissionModeName, type QueuedMessage, type VisualLevel } from '@quirky/protocol'
import { fakeContext, session, settle, type FakeContext } from './ui-fake'

type Props = {
  capabilities?: AgentCapabilities | null
  working?: boolean
  agent?: string
  status?: 'starting' | 'running' | 'exited'
  settings?: Record<string, unknown>
  reportedMode?: PermissionModeName
  autoAvailable?: boolean
  previousMode?: PermissionModeName
  reportedLevel?: VisualLevel
  /** The model and effort the session launched with; claude defaults to Opus · Low, other agents to none. */
  launched?: { model?: string; effort?: string } | null
}
type Handler = (params: Record<string, any>) => unknown

const OK = { ok: true } as const
const CLAUDE: AgentCapabilities = {
  agent: 'claude',
  steer: OK,
  model: OK,
  planMode: OK,
  permissionModes: { ok: true, modes: ['default', 'acceptEdits', 'plan', 'auto'] },
  images: OK,
  effort: OK,
  approveForSession: OK,
  resume: OK
}
const CLAUDE_ALL_MODES: AgentCapabilities['permissionModes'] = {
  ok: true,
  modes: ['default', 'acceptEdits', 'auto', 'bypassPermissions'],
  labels: { acceptEdits: 'Accept edits', bypassPermissions: 'Bypass permissions' },
  dangerous: ['bypassPermissions']
}
const PI: AgentCapabilities = {
  agent: 'pi',
  steer: { ok: false, reason: 'pi steers only between tool calls' },
  model: { ok: false, reason: 'Set when the chat starts' },
  planMode: { ok: false, reason: 'pi has no plan mode' },
  permissionModes: { ok: false, reason: 'pi has no permission modes' },
  images: OK,
  effort: { ok: false, reason: 'pi takes no effort setting' },
  approveForSession: { ok: false, reason: 'pi has no session approvals' },
  resume: { ok: false, reason: 'pi cannot resume a conversation' }
}
const effort = (...values: string[]) => ({ id: 'effort', label: 'Effort', type: 'select', choices: values.map((value) => ({ value, label: value[0]!.toUpperCase() + value.slice(1) })) })
const OPTIONS = {
  agent: 'claude',
  label: 'Claude',
  supported: true,
  discoverable: false,
  unlisted: 'refuse',
  unlistedOptions: [],
  structured: true,
  extraArgs: { supported: false, allowed: null, placeholder: null, message: null },
  models: [
    { id: 'opus', label: 'Opus', description: null, options: [effort('low', 'medium', 'high')] },
    { id: 'sonnet', label: 'Sonnet', description: null, options: [effort('low', 'medium', 'high')] }
  ]
}

const queued = (id: string, text: string, images?: string[]): QueuedMessage => ({ id, text, at: '2026-11-16T10:00:00.000Z', ...(images ? { images } : {}) })
const EMPTY_DRAFT = { text: '', images: [], pastes: [], picks: { model: null, effort: null, mode: null } }
const SEARCH = {
  results: [{ path: 'README.md', name: 'README.md', score: 1 }, { path: 'hello.txt', name: 'hello.txt', score: 0.5 }],
  truncated: false,
  history: []
}
const COMMANDS = {
  commands: [
    { name: 'review', kind: 'command', description: 'Review the diff' },
    { name: 'compact', kind: 'command' },
    { name: 'brainstorming', kind: 'skill', description: 'Turn an idea into a design' }
  ]
}

let createRoot: typeof import('react-dom/client').createRoot
let Composer: typeof import('../src/window/chat/Composer').Composer
let chatHandler: typeof import('../src/window/chat/controls').chatHandler
let rememberVisualLabel: typeof import('../src/window/chat/editor/types').rememberVisualLabel
let CMView: typeof import('@codemirror/view').EditorView
let fake: FakeContext
let root: Root | null = null
let host: HTMLElement | null = null
let current: Props = {}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Composer } = await import('../src/window/chat/Composer'))
  ;({ chatHandler } = await import('../src/window/chat/controls'))
  ;({ rememberVisualLabel } = await import('../src/window/chat/editor/types'))
  ;({ EditorView: CMView } = await import('@codemirror/view'))
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (root) await act(async () => root!.unmount())
  root = null
  host = null
  document.body.innerHTML = ''
})

const render = (props: Props) =>
  act(async () => {
    const agent = props.agent ?? 'claude'
    const launched = props.launched === undefined ? (agent === 'claude' ? { model: 'opus', effort: 'low' } : null) : props.launched
    const options = Object.fromEntries(Object.entries(launched ?? {}).map(([id, value]) => [id, { value, source: 'explicit' as const }]))
    const launchSettings = launched === null ? null : { agent, options, summary: '' }
    const chat = session({ id: 's1', kind: 'structured', agent, status: props.status ?? 'running', launchSettings })
    const capabilities = props.capabilities === undefined ? CLAUDE : props.capabilities
    root!.render(
      createElement(Composer, {
        context: fake.context,
        session: chat,
        capabilities,
        working: props.working ?? false,
        reportedMode: props.reportedMode,
        autoAvailable: props.autoAvailable,
        previousMode: props.previousMode,
        reportedLevel: props.reportedLevel
      })
    )
  })

async function mount(handlers: Record<string, Handler> = {}, props: Props = {}) {
  fake = fakeContext(
    {
      'quirky.structured/send': () => ({ ok: true }),
      'quirky.structured/interrupt': () => ({ ok: true }),
      'quirky.structured/queue': () => [],
      'quirky.structured/commands': () => ({ commands: [] }),
      'quirky.agents/options': () => OPTIONS,
      'quirky.session/draft': () => null,
      'quirky.session/saveDraft': () => ({ ok: true }),
      'quirky.session/clearDraft': () => ({ ok: true }),
      'desktop.capabilities': () => ({ filePicker: true }),
      ...handlers
    },
    props.settings
  )
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  current = props
  await render(props)
  await settle()
  return host
}

const view = (): EditorView => CMView.findFromDOM(host!)!
const doc = () => view().state.doc.toString()
const typeText = async (value: string) => {
  await act(async () => view().dispatch({ changes: { from: 0, to: view().state.doc.length, insert: value }, selection: { anchor: value.length } }))
}
const press = (init: KeyboardEventInit & { key: string }) =>
  act(async () => void view().contentDOM.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })))
const click = (element: Element | null | undefined) => act(async () => void element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))
const byLabel = (label: string) => host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const buttonNamed = (name: string, scope: ParentNode = host!) =>
  [...scope.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name)
const settingsChip = () => host!.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')!
const popover = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Turn settings"]')
const summaryRow = (name: string) => popover()!.querySelector<HTMLElement>(`[data-settings-row="${name}"]`)!
const menuItems = () => [...popover()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')]
const labelOf = (item: Element) => item.querySelector('.qt-menu-label')!.childNodes[0]!.textContent
const menuItem = (label: string) => menuItems().find((item) => labelOf(item) === label)!
const keyOn = (element: Element, key: string) => act(async () => void element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })))
const typeSearch = (input: HTMLInputElement, value: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
const options = () => [...host!.querySelectorAll('[role="option"]')]
const sent = () => fake.callsTo('quirky.structured/send').map((call) => call.params)
const placeholder = () => host!.querySelector('.cm-placeholder')?.textContent ?? ''
const image = (name: string, path?: string) => Object.assign(new File(['x'], name, { type: 'image/png' }), path ? { path } : {})
const transfer = async (type: 'paste' | 'drop', files: File[]) => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, type === 'paste' ? 'clipboardData' : 'dataTransfer', { value: { files, items: [], types: ['Files'], getData: () => '' } })
  await act(async () => void view().contentDOM.dispatchEvent(event))
  await settle()
  return event
}

describe('screens: idle', () => {
  test('empty: the placeholder names the agent and hints / and @, and Send is disabled', async () => {
    await mount()
    expect(placeholder()).toBe('Message Claude… (/ for commands, @ for files)')
    expect(buttonNamed('Send')!.disabled).toBe(true)
    expect(buttonNamed('Stop')).toBeUndefined()
    expect(host!.querySelector('textarea')).toBeNull()
  })

  test('draft: an image chip, a long-paste chip, an @ pill and the typed text come back from the stored draft', async () => {
    await mount({
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'Look at @README.md now', images: ['/tmp/error-dialog.png'], pastes: [{ id: 'p1', text: 'a\nb\nc' }] })
    })
    expect(doc()).toBe('Look at @README.md now')
    expect(host!.querySelector('.cm-composer-pill-file')!.textContent).toBe('README.md')
    const chips = byLabel('Attachments')!.textContent
    expect(chips).toContain('error-dialog.png')
    expect(chips).toContain('Pasted text · 3 lines')
    expect(buttonNamed('Send')!.disabled).toBe(false)
  })

  test('failed: the text and chips come back, an inline error offers Retry, and editing clears it (SC-18)', async () => {
    let fail = true
    await mount({
      'quirky.structured/send': () => {
        if (fail) throw new RpcError(RpcErrorCode.Conflict, 'agent is not responding')
        return { ok: true }
      }
    })
    await typeText('keep me')
    await press({ key: 'Enter' })
    await settle()
    expect(doc()).toBe('keep me')
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not send: agent is not responding')
    expect(fake.toasts).toEqual([])
    fail = false
    await click(buttonNamed('Retry'))
    await settle()
    expect(sent()).toHaveLength(2)
    expect(doc()).toBe('')
    expect(host!.querySelector('[role="alert"]')).toBeNull()
  })

  test('failed: editing the restored text clears the error', async () => {
    await mount({ 'quirky.structured/send': () => { throw new Error('nope') } })
    await typeText('x')
    await press({ key: 'Enter' })
    await settle()
    expect(host!.querySelector('[role="alert"]')).not.toBeNull()
    await typeText('xy')
    expect(host!.querySelector('[role="alert"]')).toBeNull()
  })

  test('a failed send restores the images and the paste chips too', async () => {
    await mount({ 'quirky.structured/send': () => { throw new Error('nope') } })
    await transfer('paste', [image('a.png', '/tmp/a.png')])
    await act(async () => void view().contentDOM.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [], items: [], getData: () => 'z'.repeat(2100) } })))
    await typeText('go')
    await press({ key: 'Enter' })
    await settle()
    expect(byLabel('Attachments')!.querySelector('img')!.alt).toBe('a.png')
    expect(byLabel('Attachments')!.textContent).toContain('Pasted text')
  })
})

describe('sending (SC-1, SC-3)', () => {
  test('Enter sends now, clears the editor and the draft; Shift+Enter inserts a newline', async () => {
    await mount()
    await typeText('hello')
    await press({ key: 'Enter', shiftKey: true })
    expect(doc()).toBe('hello\n')
    expect(sent()).toHaveLength(0)
    await typeText('hello')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: 'hello', when: 'now' }])
    expect(doc()).toBe('')
    expect(fake.callsTo('quirky.session/clearDraft')[0]!.params).toEqual({ session: 's1' })
  })

  test('sends the text exactly as typed, indentation and trailing newline included', async () => {
    await mount()
    await typeText('    indented\n')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: '    indented\n', when: 'now' }])
  })

  test('Send does nothing while the editor is empty or only whitespace', async () => {
    await mount()
    await press({ key: 'Enter' })
    await typeText('   ')
    await press({ key: 'Enter' })
    expect(sent()).toHaveLength(0)
  })

  test('the Send button sends, and long-paste chip text follows the typed text after a blank line', async () => {
    await mount()
    await act(async () => void view().contentDOM.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [], items: [], getData: () => 'p'.repeat(2001) } })))
    await typeText('see log')
    await click(buttonNamed('Send'))
    await settle()
    expect(sent()[0]!.text).toBe(`see log\n\n${'p'.repeat(2001)}`)
    expect(byLabel('Attachments')).toBeNull()
  })

  test('whitespace-only typed text is sent unmodified ahead of a paste chip', async () => {
    await mount()
    await act(async () => void view().contentDOM.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [], items: [], getData: () => 'p'.repeat(2001) } })))
    await typeText('  ')
    await click(buttonNamed('Send'))
    await settle()
    expect(sent()[0]!.text).toBe(`  \n\n${'p'.repeat(2001)}`)
  })

  test('with Send with Cmd+Enter on, Enter adds a line and Cmd+Enter sends', async () => {
    await mount({}, { settings: { 'send-with-cmd-enter': true } })
    await typeText('hi')
    await press({ key: 'Enter' })
    expect(doc()).toBe('hi\n')
    expect(sent()).toHaveLength(0)
    await press({ key: 'Enter', metaKey: true })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: 'hi\n', when: 'now' }])
  })
})

describe('screens: working (SC-11, SC-12)', () => {
  test('running: accent border, queue placeholder, pulsing dot with elapsed time and a round Stop that interrupts only', async () => {
    await mount({}, { working: true })
    expect(placeholder()).toBe('Queue a follow-up… (Enter queues · Cmd+Enter steers)')
    expect(host!.querySelector('[role="timer"]')!.textContent).toMatch(/^Working \d+s$/)
    expect(host!.querySelector('.ui-status-dot--working')).not.toBeNull()
    const card = host!.querySelector<HTMLElement>('.cm-editor')!.closest<HTMLElement>('[style*="border"]')!
    expect(card.getAttribute('style')).toContain('var(--ui-accent)')
    const stop = buttonNamed('Stop')!
    expect(stop.disabled).toBe(false)
    expect(buttonNamed('Send')).toBeUndefined()
    await click(stop)
    expect(fake.callsTo('quirky.structured/interrupt')[0]!.params).toEqual({ session: 's1' })
    expect(fake.callsTo('quirky.structured/stop')).toEqual([])
  })

  test('Esc in the editor stops the turn, and a Send arrow joins Stop once text is typed', async () => {
    await mount({}, { working: true })
    await typeText('x')
    expect(buttonNamed('Send')!.disabled).toBe(false)
    expect(buttonNamed('Stop')).toBeDefined()
    await press({ key: 'Escape' })
    expect(fake.callsTo('quirky.structured/interrupt')).toHaveLength(1)
  })

  test('Enter while working queues for idle', async () => {
    await mount({}, { working: true })
    await typeText('Then give it a title.')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: 'Then give it a title.', when: 'idle' }])
  })

  test('Cmd+Enter steers new text: send when idle, then steer, then a pending row until the message arrives', async () => {
    await mount({ 'quirky.structured/send': () => ({ ok: true, queuedId: 'q9' }), 'quirky.structured/steer': () => ({ ok: true }) }, { working: true })
    await typeText('Keep it under 1000 words.')
    await press({ key: 'Enter', metaKey: true })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: 'Keep it under 1000 words.', when: 'idle' }])
    expect(fake.callsTo('quirky.structured/steer')[0]!.params).toEqual({ session: 's1', id: 'q9' })
    const pending = host!.querySelector('[data-steered]')!
    expect(pending.textContent).toContain('Keep it under 1000 words.')
    expect(pending.textContent).toContain('Steering · waiting for next tool call')
    expect(pending.textContent).not.toContain('Cancel')
    await fake.emit({ type: 'quirky.structured/message', data: { message: { sessionId: 's1', seq: 5, role: 'user', text: 'Keep it under 1000 words.', at: 1 } } } as never)
    expect(host!.querySelector('[data-steered]')).toBeNull()
  })

  test('Cmd+Enter while idle just sends', async () => {
    await mount({ 'quirky.structured/steer': () => ({ ok: true }) })
    await typeText('now')
    await press({ key: 'Enter', metaKey: true })
    await settle()
    expect(sent()).toEqual([{ session: 's1', text: 'now', when: 'now' }])
    expect(fake.callsTo('quirky.structured/steer')).toHaveLength(0)
  })

  test('a user message that arrives before the steer call resolves still clears the pending row', async () => {
    let finish: (value: unknown) => void = () => {}
    await mount(
      { 'quirky.structured/send': () => ({ ok: true, queuedId: 'q9' }), 'quirky.structured/steer': () => new Promise((resolve) => (finish = resolve)) },
      { working: true }
    )
    await typeText('Keep it short.')
    await press({ key: 'Enter', metaKey: true })
    await settle()
    await fake.emit({ type: 'quirky.structured/message', data: { message: { sessionId: 's1', seq: 5, role: 'user', text: 'Keep it short.', at: 1 } } } as never)
    await act(async () => finish({ ok: true }))
    await settle()
    expect(host!.querySelector('[data-steered]')).toBeNull()
  })

  test('a failed steer leaves no pending row', async () => {
    await mount(
      { 'quirky.structured/send': () => ({ ok: true, queuedId: 'q9' }), 'quirky.structured/steer': () => { throw new Error('nope') } },
      { working: true }
    )
    await typeText('Keep it short.')
    await press({ key: 'Enter', metaKey: true })
    await settle()
    expect(host!.querySelector('[data-steered]')).toBeNull()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not steer')
  })

  test('Cmd+Enter is refused with the reason when the agent cannot steer, and nothing is sent', async () => {
    await mount({}, { working: true, capabilities: PI })
    await typeText('steer me')
    await press({ key: 'Enter', metaKey: true })
    await settle()
    expect(sent()).toHaveLength(0)
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('pi steers only between tool calls')
    expect(doc()).toBe('steer me')
  })

  test('queued: rows with drag handles sit on the card, with Stop and Send both visible', async () => {
    await mount({ 'quirky.structured/queue': () => [queued('q1', 'Then give it a title.')] }, { working: true })
    await typeText('And list three titles')
    const list = byLabel('Queued messages')!
    expect(list.textContent).toContain('Then give it a title.')
    expect(list.querySelector('[title="Drag to reorder"]')).not.toBeNull()
    expect(buttonNamed('Steer now', list)).toBeDefined()
    expect(buttonNamed('Stop')).toBeDefined()
    expect(buttonNamed('Send')).toBeDefined()
  })
})

describe('queued rows (SC-13, SC-14)', () => {
  const two = { 'quirky.structured/queue': () => [queued('q1', 'first'), queued('q2', 'second')] }

  test('lists the queue oldest first and follows queueChanged', async () => {
    await mount(two, { working: true })
    expect([...byLabel('Queued messages')!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([expect.stringContaining('first'), expect.stringContaining('second')])
    await fake.emit({ type: 'quirky.structured/queueChanged', data: { sessionId: 's1', queue: [] } } as never)
    expect(byLabel('Queued messages')).toBeNull()
  })

  test('dragging the second row above the first sends the full id order to reorderQueued', async () => {
    await mount({ ...two, 'quirky.structured/reorderQueued': () => ({ ok: true }) }, { working: true })
    const items = [...byLabel('Queued messages')!.querySelectorAll('li')]
    const drag = (type: string, target: Element) => act(async () => void target.dispatchEvent(Object.assign(new Event(type, { bubbles: true, cancelable: true }), { dataTransfer: { setData() {} } })))
    await drag('dragstart', items[1]!)
    await drag('dragover', items[0]!)
    await drag('drop', items[0]!)
    expect(fake.callsTo('quirky.structured/reorderQueued')[0]!.params).toEqual({ session: 's1', ids: ['q2', 'q1'] })
  })

  test('Edit moves the text into the editor and removes the row; the X deletes', async () => {
    await mount({ ...two, 'quirky.structured/dequeue': () => ({ ok: true }) }, { working: true })
    await click(buttonNamed('Edit queued message'))
    await settle()
    expect(fake.callsTo('quirky.structured/dequeue')[0]!.params).toEqual({ session: 's1', id: 'q1' })
    expect(doc()).toBe('first')
    await click(buttonNamed('Delete queued message'))
    expect(fake.callsTo('quirky.structured/dequeue')[1]!.params).toEqual({ session: 's1', id: 'q1' })
  })

  test('Up in an empty editor pulls the last queued message back', async () => {
    await mount({ ...two, 'quirky.structured/dequeue': () => ({ ok: true }) }, { working: true })
    await press({ key: 'ArrowUp' })
    await settle()
    expect(fake.callsTo('quirky.structured/dequeue')[0]!.params).toEqual({ session: 's1', id: 'q2' })
    expect(doc()).toBe('second')
  })

  test('Steer now steers a row, and shows it as pending', async () => {
    await mount({ ...two, 'quirky.structured/steer': () => ({ ok: true }) }, { working: true })
    await click(buttonNamed('Steer now'))
    expect(fake.callsTo('quirky.structured/steer')[0]!.params).toEqual({ session: 's1', id: 'q1' })
    expect(host!.querySelector('[data-steered]')!.textContent).toContain('first')
  })

  test('Steer now is disabled with the reason when the agent cannot steer', async () => {
    await mount(two, { working: true, capabilities: PI })
    const steer = buttonNamed('Steer now')!
    expect(steer.disabled).toBe(true)
    expect(steer.title).toBe('pi steers only between tool calls')
  })

  test('after Stop the rows offer Send next instead of Steer now, and it sends that message', async () => {
    await mount({ ...two, 'quirky.structured/sendQueued': () => ({ ok: true }) })
    expect(buttonNamed('Steer now')).toBeUndefined()
    await click(buttonNamed('Send next'))
    expect(fake.callsTo('quirky.structured/sendQueued')[0]!.params).toEqual({ session: 's1', id: 'q1' })
  })

  test('a failed queue action shows an inline error', async () => {
    await mount({ ...two, 'quirky.structured/dequeue': () => { throw new RpcError(RpcErrorCode.NotFound, 'gone') } }, { working: true })
    await click(buttonNamed('Delete queued message'))
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not update the queue: gone')
  })
})

describe('screens: suggestions (SC-5, SC-6)', () => {
  const files = { 'quirky.editor/quickOpen': (params: Record<string, any>) => ({ ...SEARCH, results: SEARCH.results.filter((entry) => entry.path.toLowerCase().includes(params.query.toLowerCase())) }) }

  test('mention: the file list opens above the card with the first row selected, and Enter inserts a pill instead of sending', async () => {
    await mount(files)
    await typeText('Look at @')
    await settle()
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('README.md'), expect.stringContaining('hello.txt')])
    expect(options()[0]!.getAttribute('aria-selected')).toBe('true')
    await typeText('Look at @REA')
    await settle()
    await press({ key: 'Enter' })
    expect(doc()).toBe('Look at @README.md ')
    expect(host!.querySelector('.cm-composer-pill-file')).not.toBeNull()
    expect(sent()).toHaveLength(0)
    expect(options()).toHaveLength(0)
  })

  test('Down moves the selection, Tab picks, Esc closes the list without stopping the turn', async () => {
    await mount(files, { working: true })
    await typeText('@')
    await settle()
    await press({ key: 'ArrowDown' })
    expect(options()[1]!.getAttribute('aria-selected')).toBe('true')
    await press({ key: 'Escape' })
    expect(options()).toHaveLength(0)
    expect(fake.callsTo('quirky.structured/interrupt')).toHaveLength(0)
    await typeText('plain')
    await typeText('@h')
    await settle()
    await press({ key: 'Tab' })
    expect(doc()).toBe('@hello.txt ')
  })

  test('with no matching file the list says so and Enter sends the text as typed', async () => {
    await mount(files)
    await typeText('@zzz')
    await settle()
    expect(host!.textContent).toContain('No matching files')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()[0]!.text).toBe('@zzz')
  })

  test('says file search is unavailable when the editor plugin is missing', async () => {
    await mount()
    await typeText('@a')
    await settle()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('File search unavailable')
  })

  test('slash: Quirky, agent commands and agent skills groups, each row marked acts now or sent', async () => {
    await mount({ 'quirky.structured/commands': () => COMMANDS })
    await typeText('/')
    await settle()
    const groups = [...host!.querySelectorAll('[role="group"]')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Quirky', 'Claude commands', 'Claude skills'])
    expect(groups[0]!.textContent).toContain('/model')
    for (const name of ['/model', '/effort', '/mode', '/plan', '/new', '/stop', '/resume']) expect(groups[0]!.textContent).toContain(name)
    expect(groups[0]!.textContent).toContain('acts now')
    expect(groups[1]!.textContent).toContain('/review')
    expect(groups[1]!.textContent).toContain('sent')
    expect(groups[2]!.textContent).toContain('/brainstorming')
  })

  test('an agent that reports no commands shows only the Quirky group; commandsChanged updates the list', async () => {
    await mount()
    await typeText('/')
    await settle()
    expect([...host!.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label'))).toEqual(['Quirky'])
    await fake.emit({ type: 'quirky.structured/commandsChanged', data: { sessionId: 's1', commands: COMMANDS.commands } } as never)
    expect(host!.querySelectorAll('[role="group"]')).toHaveLength(3)
  })

  test('no-match: "No commands match" and Enter sends the text as typed', async () => {
    await mount({ 'quirky.structured/commands': () => COMMANDS })
    await typeText('/deplo')
    await settle()
    expect(host!.textContent).toContain('No commands match')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()[0]!.text).toBe('/deplo')
  })

  test('picking an agent command inserts a command pill and sends nothing', async () => {
    await mount({ 'quirky.structured/commands': () => COMMANDS })
    await typeText('/rev')
    await settle()
    await click(options()[0])
    expect(doc()).toBe('/review ')
    expect(host!.querySelector('.cm-composer-pill-command')).not.toBeNull()
    expect(sent()).toHaveLength(0)
  })

  const ALL_KINDS = {
    commands: [
      { name: 'review', kind: 'command', description: 'Review the diff', argumentHint: '[pr]' },
      { name: 'brainstorming', kind: 'skill', description: 'Turn an idea into a design' },
      { name: 'quirk:tdd', kind: 'plugin', description: 'Test first' },
      { name: 'mcp__notion__page', kind: 'mcp', description: 'Make a Notion page' },
      { name: 'compact', kind: 'builtin', description: 'Free up context', startOnly: true },
      { name: 'model', kind: 'builtin', description: 'Set the model', startOnly: true }
    ]
  }

  test('slash: every kind gets its own group with descriptions and argument hints; an agent row named like a Quirky command is hidden', async () => {
    await mount({ 'quirky.structured/commands': () => ALL_KINDS })
    await typeText('/')
    await settle()
    const groups = [...host!.querySelectorAll('[role="group"]')]
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Quirky', 'Claude commands', 'Claude skills', 'Plugins', 'MCP prompts', 'Claude built-in'])
    expect(groups[1]!.textContent).toContain('/review [pr]')
    expect(groups[1]!.textContent).toContain('Review the diff')
    expect(groups[5]!.textContent).toContain('/compact')
    expect(groups[5]!.textContent).not.toContain('/model')
  })

  test('mid-message: / after a word opens the list without start-only entries, and a pick inserts a pill in place', async () => {
    await mount({ 'quirky.structured/commands': () => ALL_KINDS })
    await typeText('fix the login /')
    await settle()
    const labels = [...host!.querySelectorAll('[role="group"]')].map((group) => group.getAttribute('aria-label'))
    expect(labels).toEqual(['Quirky', 'Claude commands', 'Claude skills', 'Plugins', 'MCP prompts'])
    await typeText('fix the login /td')
    await settle()
    expect(options().map((option) => option.textContent)).toEqual([expect.stringContaining('/quirk:tdd')])
    await click(options()[0])
    expect(doc()).toBe('fix the login /quirk:tdd ')
    expect(host!.querySelector('.cm-composer-pill-command')!.textContent).toBe('/quirk:tdd')
    expect(sent()).toHaveLength(0)
  })

  test('picking /plan acts at once, removes the typed query and switches to Plan', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(doc()).toBe('')
    expect(fake.callsTo('quirky.structured/configure')[0]!.params).toEqual({ session: 's1', permissionMode: 'plan' })
    expect(byLabel('Turn off Plan mode')).not.toBeNull()
  })

  test('/plan from Plan returns to the mode before it, or Default when there was none', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'plan', previousMode: 'acceptEdits' })
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([{ session: 's1', permissionMode: 'acceptEdits' }])
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'plan' })
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([{ session: 's1', permissionMode: 'default' }])
  })

  test('/plan from Plan falls back to Default when the previous mode is no longer on offer', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'plan', previousMode: 'auto', autoAvailable: false })
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([{ session: 's1', permissionMode: 'default' }])
  })

  test('picking /model opens the settings popover; /stop interrupts; /new creates a chat with the same agent', async () => {
    await mount({ 'quirky.structured/create': () => session({ id: 'new', kind: 'structured', agent: 'claude' }) })
    await typeText('/model')
    await settle()
    await click(options()[0])
    expect(popover()).not.toBeNull()
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await typeText('/stop')
    await settle()
    await click(options()[0])
    expect(fake.callsTo('quirky.structured/interrupt')).toHaveLength(1)
    await typeText('/new')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toMatchObject({ agent: 'claude', worktree: 'wt-main', deferStart: true })
    expect(fake.opened.at(-1)!.input).toMatchObject({ session: 'new' })
  })
})

describe('screens: settings (SC-15, SC-16)', () => {
  test('summary: model, effort and permissions with their current values, Plan as a Permissions row; the chip reads model and effort', async () => {
    await mount({}, { capabilities: { ...CLAUDE, permissionModes: { ok: true, modes: ['default', 'acceptEdits', 'plan'] } } })
    expect(settingsChip().textContent).toContain('Opus · Low')
    await click(settingsChip())
    expect(summaryRow('model').textContent).toBe('ModelOpus')
    expect(summaryRow('effort').getAttribute('role')).toBe('slider')
    expect(summaryRow('effort').getAttribute('aria-valuetext')).toBe('Low')
    expect(summaryRow('mode').textContent).toBe('PermissionsDefault')
    expect(popover()!.querySelector('[role="switch"]')).toBeNull()
    expect(document.activeElement).toBe(summaryRow('model'))
    await click(summaryRow('mode'))
    expect(menuItems().map(labelOf)).toEqual(['Default', 'Accept edits', 'Plan'])
    expect(menuItem('Plan').textContent).toContain('Read only until you approve a plan')
  })

  test('Auto is disabled with a reason when Claude does not offer it, and on offer when it does or has not reported', async () => {
    await mount({}, { autoAvailable: false })
    await click(settingsChip())
    await click(summaryRow('mode'))
    const auto = menuItem('Auto')
    expect(auto.getAttribute('aria-disabled')).toBe('true')
    expect(auto.title).toBe("Auto mode isn't available for this model")
    expect(menuItem('Plan').getAttribute('aria-disabled')).toBeNull()
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    for (const autoAvailable of [true, undefined]) {
      await mount({}, { autoAvailable })
      await click(settingsChip())
      await click(summaryRow('mode'))
      expect(menuItem('Auto').getAttribute('aria-disabled')).toBeNull()
      await act(async () => root!.unmount())
      document.body.innerHTML = ''
    }
  })

  test('picking a Permissions row, Plan included, applies it at once through configure', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { autoAvailable: true })
    await click(settingsChip())
    await click(summaryRow('mode'))
    await click(menuItem('Plan'))
    await click(summaryRow('mode'))
    await click(menuItem('Auto'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([
      { session: 's1', permissionMode: 'plan' },
      { session: 's1', permissionMode: 'auto' }
    ])
  })

  test('a setting the session launched without reads Default instead of the first listed entry', async () => {
    await mount({}, { launched: null })
    expect(settingsChip().textContent).toBe('Default')
    await click(settingsChip())
    expect(summaryRow('model').textContent).toBe('ModelDefault')
    expect(summaryRow('effort').textContent).toContain('This model has no effort setting')
    await click(summaryRow('model'))
    expect(menuItems().some((item) => item.getAttribute('aria-checked') === 'true')).toBe(false)
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await render({ launched: { model: 'sonnet' } })
    expect(settingsChip().textContent).toBe('Sonnet · Default')
  })

  test('choosing a model applies it and returns to the summary; arrow keys step effort in place; Esc closes', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    await click(settingsChip())
    await click(summaryRow('model'))
    expect(menuItems().map(labelOf)).toEqual(['Opus', 'Sonnet'])
    expect(menuItem('Opus').getAttribute('aria-checked')).toBe('true')
    await click(menuItem('Sonnet'))
    expect(document.activeElement).toBe(summaryRow('model'))
    await keyOn(summaryRow('effort'), 'ArrowRight')
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([
      { session: 's1', model: 'sonnet' },
      { session: 's1', effort: 'medium' }
    ])
    expect(settingsChip().textContent).toContain('Sonnet · Medium')
    expect(summaryRow('effort').getAttribute('aria-valuetext')).toBe('Medium')
    await click(buttonNamed('Less effort', popover()!))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').at(-1)!.params).toEqual({ session: 's1', effort: 'low' })
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(popover()).toBeNull()
  })

  test('a rejected change reverts the chip and shows an inline error', async () => {
    await mount({ 'quirky.structured/configure': () => { throw new Error('not now') } })
    await click(settingsChip())
    await click(summaryRow('model'))
    await click(menuItem('Sonnet'))
    await settle()
    expect(settingsChip().textContent).toContain('Opus · Low')
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not change the setting: not now')
  })

  test('one badge shows a mode other than Default, with an X that returns to Default', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(buttonNamed('Return permissions to Default')).toBeUndefined()
    await click(settingsChip())
    await click(summaryRow('mode'))
    await click(menuItem('Plan'))
    await settle()
    expect(summaryRow('mode').textContent).toContain('Plan')
    expect(byLabel('Turn off Plan mode')!.textContent).toContain('Plan')
    expect(byLabel('Turn off Plan mode')!.querySelector('.ui-badge--accent')).not.toBeNull()
    await click(summaryRow('mode'))
    await click(menuItem('Accept edits'))
    await settle()
    expect(summaryRow('mode').textContent).toContain('Accept edits')
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(buttonNamed('Return permissions to Default')!.textContent).toContain('Accept edits')
    expect(buttonNamed('Return permissions to Default')!.querySelector('.ui-badge--needs-you')).not.toBeNull()
    await click(buttonNamed('Return permissions to Default'))
    await settle()
    expect(buttonNamed('Return permissions to Default')).toBeUndefined()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params).at(-1)).toEqual({ session: 's1', permissionMode: 'default' })
  })

  test('the Plan badge X leaves Plan for Default', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'plan' })
    await click(byLabel('Turn off Plan mode'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([{ session: 's1', permissionMode: 'default' }])
  })

  test('the picked mode follows the mode Claude reports, without calling configure', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'plan' })
    expect(byLabel('Turn off Plan mode')).not.toBeNull()
    await render({ reportedMode: 'acceptEdits' })
    await settle()
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(buttonNamed('Return permissions to Default')!.textContent).toContain('Accept edits')
    await render({ reportedMode: 'default' })
    await settle()
    expect(buttonNamed('Return permissions to Default')).toBeUndefined()
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
  })

  test('a rejected mode change reverts to the mode before it', async () => {
    await mount({ 'quirky.structured/configure': () => { throw new Error('auto mode is not available') } }, { reportedMode: 'default' })
    await click(settingsChip())
    await click(summaryRow('mode'))
    await click(menuItem('Plan'))
    await settle()
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('auto mode is not available')
  })

  test('permission modes use the agent labels and a description, and a mode that skips approvals is set apart', async () => {
    const modes = { ...CLAUDE_ALL_MODES, modes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'], labels: { ...CLAUDE_ALL_MODES.labels, dontAsk: "Don't ask" } }
    await mount({}, { capabilities: { ...CLAUDE, permissionModes: modes } })
    await click(settingsChip())
    await click(summaryRow('mode'))
    expect(menuItems().map(labelOf)).toEqual(['Default', 'Accept edits', 'Plan', 'Auto', "Don't ask", 'Bypass permissions'])
    expect(menuItem('Default').textContent).toContain('Ask before edits and commands')
    expect(menuItem('Bypass permissions').textContent).toContain('Run every tool without asking')
    expect(menuItems().filter((item) => item.classList.contains('qt-danger')).map(labelOf)).toEqual(['Bypass permissions'])
    expect(menuItem('Bypass permissions').closest('.qt-menu-row')!.querySelector('[role="separator"]')).not.toBeNull()
  })

  test('a dangerous mode with no description of its own still says it skips approvals', async () => {
    const modes = { ok: true as const, modes: ['always-ask', 'yolo'], labels: { 'always-ask': 'Always ask', yolo: 'Yolo' }, dangerous: ['yolo'] }
    await mount({}, { capabilities: { ...CLAUDE, permissionModes: modes } })
    await click(settingsChip())
    await click(summaryRow('mode'))
    expect(menuItem('Yolo').textContent).toContain('Acts without asking for approval')
    expect(menuItem('Always ask').querySelector('.ui-help-text')).toBeNull()
  })

  test('picking bypass permissions turns the summary value red and shows a failing-tone badge that says the agent acts without asking', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true, settings: { permissionMode: 'bypassPermissions' } }) }, { capabilities: { ...CLAUDE, permissionModes: CLAUDE_ALL_MODES } })
    await click(settingsChip())
    await click(summaryRow('mode'))
    await click(menuItem('Bypass permissions'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').at(-1)!.params).toEqual({ session: 's1', permissionMode: 'bypassPermissions' })
    expect(summaryRow('mode').querySelector<HTMLElement>('span:nth-of-type(2)')!.style.color).toBe('var(--ui-failing)')
    const badge = buttonNamed('Return permissions to Default')!
    expect(badge.textContent).toContain('Bypass permissions')
    expect(badge.dataset.dangerous).toBe('true')
    expect(badge.title).toContain('acts without asking for approval')
    expect(badge.querySelector('.ui-badge--failing')).not.toBeNull()
  })

  test('a non-dangerous mode badge keeps the needs-you tone', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { capabilities: { ...CLAUDE, permissionModes: CLAUDE_ALL_MODES } })
    await click(settingsChip())
    await click(summaryRow('mode'))
    await click(menuItem('Auto'))
    await settle()
    const badge = buttonNamed('Return permissions to Default')!
    expect(badge.dataset.dangerous).toBeUndefined()
    expect(badge.querySelector('.ui-badge--needs-you')).not.toBeNull()
  })

  test('Shift+Tab moves to the next mode in list order, skipping dangerous ones, and wraps, one configure per step', async () => {
    const modes = { ...CLAUDE_ALL_MODES, modes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] }
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { capabilities: { ...CLAUDE, permissionModes: modes }, reportedMode: 'default', autoAvailable: true })
    for (let step = 0; step < 5; step++) await press({ key: 'Tab', shiftKey: true })
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params.permissionMode)).toEqual(['acceptEdits', 'plan', 'auto', 'dontAsk', 'default'])
  })

  test('Shift+Tab from a dangerous mode moves on to the next safe one', async () => {
    const modes = { ...CLAUDE_ALL_MODES, modes: ['default', 'acceptEdits', 'plan', 'auto', 'dontAsk', 'bypassPermissions'] }
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { capabilities: { ...CLAUDE, permissionModes: modes }, reportedMode: 'bypassPermissions', autoAvailable: true })
    await press({ key: 'Tab', shiftKey: true })
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params.permissionMode)).toEqual(['default'])
  })

  test('Shift+Tab skips Auto while it is unavailable and never sends anything', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'acceptEdits', autoAvailable: false })
    await typeText('typing')
    await press({ key: 'Tab', shiftKey: true })
    await press({ key: 'Tab', shiftKey: true })
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params.permissionMode)).toEqual(['plan', 'default'])
    expect(sent()).toEqual([])
    expect(doc()).toBe('typing')
  })

  test('on an agent without plan mode, Shift+Tab and /plan do nothing and show the Plan reason', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { capabilities: PI, agent: 'pi' })
    await press({ key: 'Tab', shiftKey: true })
    await settle()
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('pi has no plan mode')
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
  })

  test('on an agent with its own modes and no plan, /plan does nothing and shows the Plan reason', async () => {
    const codex: AgentCapabilities = {
      ...CLAUDE,
      agent: 'codex',
      planMode: { ok: false, reason: 'Codex has no plan mode in Quirky' },
      permissionModes: {
        ok: true,
        modes: ['default', 'read-only', 'auto-review', 'full-access'],
        labels: { 'read-only': 'Read only', 'auto-review': 'Auto-review', 'full-access': 'Full access' },
        dangerous: ['full-access']
      }
    }
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { capabilities: codex, agent: 'codex' })
    await click(settingsChip())
    await click(summaryRow('mode'))
    expect(menuItems().map(labelOf)).toEqual(['Default', 'Read only', 'Auto-review', 'Full access'])
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    await typeText('/plan')
    await settle()
    await click(options()[0])
    await settle()
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Codex has no plan mode in Quirky')
  })

  test('a session that opened in another mode shows that mode, read from the runner', async () => {
    await mount({ 'quirky.structured/settings': () => ({ settings: { permissionMode: 'bypassPermissions' } }) }, { capabilities: { ...CLAUDE, permissionModes: CLAUDE_ALL_MODES } })
    expect(fake.callsTo('quirky.structured/settings')[0]!.params).toEqual({ session: 's1' })
    expect(buttonNamed('Return permissions to Default')!.textContent).toContain('Bypass permissions')
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
  })

  test('a reported mode the agent does not list is ignored', async () => {
    await mount({ 'quirky.structured/settings': () => ({ settings: { permissionMode: 'mystery' } }) })
    expect(buttonNamed('Return permissions to Default')).toBeUndefined()
  })

  test('unsupported settings stay visible, disabled, with the reason written under them; the chip shows the model alone', async () => {
    await mount({ 'quirky.agents/options': () => ({ ...OPTIONS, agent: 'pi', models: [{ id: 'm', label: 'Pi model', description: null, options: [] }] }) }, { capabilities: { ...PI, model: OK }, agent: 'pi', launched: { model: 'm' } })
    expect(settingsChip().textContent).toBe('Pi model')
    await click(settingsChip())
    expect(summaryRow('effort').getAttribute('aria-disabled')).toBe('true')
    expect(summaryRow('effort').textContent).toContain('pi takes no effort setting')
    const mode = summaryRow('mode') as HTMLButtonElement
    expect(mode.disabled).toBe(true)
    expect(mode.textContent).toContain('pi has no permission modes')
    expect(document.activeElement).toBe(summaryRow('model'))
  })

  test('arrow keys walk the summary, skip disabled rows, and Right opens a list; Esc steps back before it closes', async () => {
    await mount()
    await click(settingsChip())
    const order: (string | undefined)[] = []
    for (let step = 0; step < 3; step += 1) {
      order.push((document.activeElement as HTMLElement).dataset.settingsRow)
      await keyOn(document.activeElement!, 'ArrowDown')
    }
    expect(order).toEqual(['model', 'effort', 'mode'])
    expect(document.activeElement).toBe(summaryRow('model'))
    await keyOn(summaryRow('mode'), 'ArrowRight')
    expect(menuItems().map(labelOf)).toEqual(['Default', 'Accept edits', 'Plan', 'Auto'])
    await keyOn(document.activeElement!, 'Escape')
    expect(popover()).not.toBeNull()
    expect(document.activeElement).toBe(summaryRow('mode'))
    await keyOn(document.activeElement!, 'Escape')
    expect(popover()).toBeNull()
  })

  test('for pi the Permissions row also shows why there is no Plan', async () => {
    await mount({}, { capabilities: PI, agent: 'pi' })
    await click(settingsChip())
    expect(summaryRow('mode').textContent).toContain('pi has no permission modes')
    expect(summaryRow('mode').textContent).toContain('pi has no plan mode')
  })

  test('/mode opens the popover straight at the permission list', async () => {
    await mount()
    await typeText('/mode')
    await settle()
    await click(options().find((option) => option.textContent?.includes('Choose permission mode')))
    await settle()
    expect(popover()!.textContent).toContain('Permissions')
    expect(menuItems().map(labelOf)).toEqual(['Default', 'Accept edits', 'Plan', 'Auto'])
  })

  test('a long model list gets a focused search field, says when nothing matches, and typing on the summary starts a search', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}`, description: null, options: [] }))
    await mount({ 'quirky.agents/options': () => ({ ...OPTIONS, models: many }) }, { launched: null })
    await click(settingsChip())
    expect(popover()!.textContent).toContain('type to find a model')
    await click(summaryRow('model'))
    const search = popover()!.querySelector<HTMLInputElement>('input')!
    expect(document.activeElement).toBe(search)
    expect(search.placeholder).toBe('Search 9 models')
    await typeSearch(search, 'Model 7')
    expect(menuItems().map(labelOf)).toEqual(['Model 7'])
    await typeSearch(search, 'nothing')
    expect(menuItems()).toHaveLength(0)
    expect(popover()!.textContent).toContain('No models match')
    await keyOn(search, 'Escape')
    await keyOn(document.activeElement!, '7')
    const reopened = popover()!.querySelector<HTMLInputElement>('input')!
    expect(reopened.value).toBe('7')
    expect(menuItems().map(labelOf)).toEqual(['Model 7'])
  })

  test('fills the model list from the live session when the agents catalog is empty', async () => {
    await mount(
      {
        'quirky.agents/options': () => ({ ...OPTIONS, agent: 'pi', models: [] }),
        'quirky.structured/models': () => ({ models: [{ id: 'a/one', label: 'One (a)' }], current: 'a/one' })
      },
      { agent: 'pi', capabilities: { ...PI, model: OK } }
    )
    expect(fake.callsTo('quirky.structured/models')[0]!.params).toEqual({ session: 's1' })
    expect(settingsChip().textContent).toBe('One (a)')
  })
})

describe('attachments (SC-7, SC-8, SC-9)', () => {
  test('+ opens the native picker for images and adds a chip for each path, once', async () => {
    await mount({ 'desktop.file.pick': () => ({ cancelled: false, paths: ['/tmp/a.png', '/tmp/a.png', '/tmp/b.png'] }) })
    await click(buttonNamed('Attach images'))
    await settle()
    expect(fake.callsTo('desktop.file.pick')[0]!.params).toEqual({ multiple: true, imagesOnly: true })
    expect([...byLabel('Attachments')!.querySelectorAll('.ui-scope-chip__label')].map((entry) => entry.textContent)).toEqual(['a.png', 'b.png'])
    await typeText('look')
    await press({ key: 'Enter' })
    await settle()
    expect(sent()[0]!.images).toEqual(['/tmp/a.png', '/tmp/b.png'])
  })

  test('a cancelled picker adds nothing', async () => {
    await mount({ 'desktop.file.pick': () => ({ cancelled: true, paths: [] }) })
    await click(buttonNamed('Attach images'))
    await settle()
    expect(byLabel('Attachments')).toBeNull()
  })

  test('+ is disabled with a drop hint when the shell has no file picker, and with the capability reason when the agent takes no images', async () => {
    await mount({ 'desktop.capabilities': () => ({ filePicker: false }) })
    expect(buttonNamed('Attach images')!.disabled).toBe(true)
    expect(buttonNamed('Attach images')!.title).toBe('Drop or paste images here')
    await render({ capabilities: { ...CLAUDE, images: { ok: false, reason: 'claude takes no images here' } } })
    expect(buttonNamed('Attach images')!.title).toBe('claude takes no images here')
  })

  test('a pasted screenshot without a file path is saved through pasteImage and attached', async () => {
    await mount({ 'quirky.session/pasteImage': () => ({ path: '/data/pasted/s1/x.png' }) })
    await transfer('paste', [image('clip.png')])
    expect(fake.callsTo('quirky.session/pasteImage')[0]!.params).toEqual({ session: 's1', mime: 'image/png', data: btoa('x') })
    expect(byLabel('Attachments')!.querySelector('img')!.alt).toBe('clip.png')
  })

  test('a dropped image with a path attaches, and the same image dropped twice appears once', async () => {
    await mount()
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    expect(byLabel('Attachments')!.querySelectorAll('img')).toHaveLength(1)
  })

  test('a pasted image shows as a thumbnail named by its file, and its remove button drops it', async () => {
    await mount({ 'quirky.session/pasteImage': () => ({ path: '/data/pasted/s1/x.png' }) })
    await transfer('paste', [image('clip.png')])
    const thumbnail = byLabel('Attachments')!.querySelector('img')!
    expect(thumbnail.alt).toBe('clip.png')
    expect(thumbnail.getAttribute('src')).toStartWith('blob:')
    expect(byLabel('Attachments')!.querySelector('.ui-scope-chip')).toBeNull()
    await click(buttonNamed('Remove clip.png'))
    expect(byLabel('Attachments')).toBeNull()
  })

  test('an image alone enables Send and goes out with empty text', async () => {
    await mount({ 'quirky.session/pasteImage': () => ({ path: '/data/pasted/s1/x.png' }) })
    expect(buttonNamed('Send')!.disabled).toBe(true)
    await transfer('paste', [image('clip.png')])
    expect(buttonNamed('Send')!.disabled).toBe(false)
    await click(buttonNamed('Send'))
    await settle()
    expect(sent()[0]).toMatchObject({ session: 's1', text: '', images: ['/data/pasted/s1/x.png'] })
    expect(byLabel('Attachments')).toBeNull()
  })

  test('Enter sends an image with no text too', async () => {
    await mount()
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    await press({ key: 'Enter' })
    await settle()
    expect(sent()[0]).toMatchObject({ text: '', images: ['/tmp/shot.png'] })
  })

  test('a picker-added image keeps the name chip, with no thumbnail', async () => {
    await mount({ 'desktop.file.pick': () => ({ cancelled: false, paths: ['/tmp/a.png'] }) })
    await click(buttonNamed('Attach images'))
    await settle()
    expect(byLabel('Attachments')!.querySelector('.ui-scope-chip__label')!.textContent).toBe('a.png')
    expect(byLabel('Attachments')!.querySelector('img')).toBeNull()
  })

  test('an image is refused inline with the reason when the agent takes none', async () => {
    await mount({}, { capabilities: { ...CLAUDE, images: { ok: false, reason: 'no images for this agent' } } })
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    expect(byLabel('Attachments')).toBeNull()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('no images for this agent')
  })

  test('dropped non-image files become pills: relative inside the worktree, absolute outside', async () => {
    await mount()
    const inside = Object.assign(new File(['t'], 'app.ts', { type: 'text/plain' }), { path: '/tmp/work/main/src/app.ts' })
    const outside = Object.assign(new File(['t'], 'notes.txt', { type: 'text/plain' }), { path: '/Users/me/notes.txt' })
    await transfer('drop', [inside, outside])
    expect(doc()).toBe('@src/app.ts @/Users/me/notes.txt ')
    expect(byLabel('Attachments')).toBeNull()
  })

  test('a long paste becomes a removable chip instead of text', async () => {
    await mount()
    await act(async () => void view().contentDOM.dispatchEvent(Object.assign(new Event('paste', { bubbles: true, cancelable: true }), { clipboardData: { files: [], items: [], getData: () => `${'line\n'.repeat(411)}end` } })))
    expect(doc()).toBe('')
    expect(byLabel('Attachments')!.textContent).toContain('Pasted text · 412 lines')
    await click(byLabel('Remove pasted text'))
    expect(byLabel('Attachments')).toBeNull()
  })
})

describe('drafts (SC-10)', () => {
  test('loads the stored draft for the session, picks included', async () => {
    await mount(
      { 'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half written', images: ['/tmp/a.png'], picks: { model: 'sonnet', effort: null, mode: null } }), 'quirky.structured/configure': () => ({ ok: true }) },
    )
    expect(fake.callsTo('quirky.session/draft')[0]!.params).toEqual({ session: 's1' })
    expect(doc()).toBe('half written')
    expect(byLabel('Attachments')!.textContent).toContain('a.png')
    expect(settingsChip().textContent).toContain('Sonnet')
    expect(fake.callsTo('quirky.structured/configure')[0]!.params).toEqual({ session: 's1', model: 'sonnet' })
  })

  test('a stored draft with legacy plan picks restores as the Plan mode', async () => {
    await mount({
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half', picks: { model: null, effort: null, mode: 'acceptEdits', plan: true } }),
      'quirky.structured/configure': () => ({ ok: true })
    })
    expect(doc()).toBe('half')
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([{ session: 's1', permissionMode: 'plan' }])
    expect(byLabel('Turn off Plan mode')).not.toBeNull()
  })

  test('a stored mode never overrides the mode Claude already reports', async () => {
    await mount(
      {
        'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half', picks: { model: null, effort: null, mode: 'plan' } }),
        'quirky.structured/configure': () => ({ ok: true })
      },
      { reportedMode: 'acceptEdits' }
    )
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
    expect(buttonNamed('Return permissions to Default')!.textContent).toContain('Accept edits')
  })

  test('saves after a pause, and again when the composer unmounts', async () => {
    await mount()
    await typeText('typing')
    expect(fake.callsTo('quirky.session/saveDraft')).toHaveLength(0)
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    expect(fake.callsTo('quirky.session/saveDraft')[0]!.params).toEqual({ session: 's1', draft: { ...EMPTY_DRAFT, text: 'typing' } })
    await typeText('typing more')
    await act(async () => root!.unmount())
    root = null
    expect(fake.callsTo('quirky.session/saveDraft').at(-1)!.params.draft.text).toBe('typing more')
  })

  test('a draft that loads after the user has typed does not replace what they typed', async () => {
    let finish: (value: unknown) => void = () => {}
    await mount({ 'quirky.session/draft': () => new Promise((resolve) => (finish = resolve)) })
    await typeText('fresh')
    await act(async () => finish({ ...EMPTY_DRAFT, text: 'stale draft' }))
    await settle()
    expect(doc()).toBe('fresh')
  })

  test('a failed save is retried by the next save and by unmount', async () => {
    let fail = true
    await mount({
      'quirky.session/saveDraft': () => {
        if (fail) throw new Error('disk full')
        return { ok: true }
      }
    })
    await typeText('typing')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    expect(fake.callsTo('quirky.session/saveDraft')).toHaveLength(1)
    fail = false
    await act(async () => root!.unmount())
    root = null
    expect(fake.callsTo('quirky.session/saveDraft')).toHaveLength(2)
    expect(fake.callsTo('quirky.session/saveDraft').at(-1)!.params.draft.text).toBe('typing')
  })

  test('deleting the text while the first save is in flight persists the deletion', async () => {
    let finish: (value: unknown) => void = () => {}
    let first = true
    await mount({
      'quirky.session/saveDraft': () => {
        if (!first) return { ok: true }
        first = false
        return new Promise((resolve) => (finish = resolve))
      }
    })
    await typeText('typing')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    expect(fake.callsTo('quirky.session/saveDraft')).toHaveLength(1)
    await typeText('')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    await act(async () => finish({ ok: true }))
    await settle()
    expect(fake.callsTo('quirky.session/clearDraft').length).toBeGreaterThan(0)
  })

  test('a different session gets its own draft and the old one is saved first', async () => {
    await mount({ 'quirky.session/draft': (params) => (params.session === 's2' ? { ...EMPTY_DRAFT, text: 'second' } : null) })
    await typeText('first')
    await act(async () => {
      const other = session({ id: 's2', kind: 'structured', agent: 'claude', status: 'running' })
      root!.render(createElement(Composer, { context: fake.context, session: other, capabilities: CLAUDE, working: false }))
    })
    await settle()
    expect(fake.callsTo('quirky.session/saveDraft')[0]!.params).toEqual({ session: 's1', draft: { ...EMPTY_DRAFT, text: 'first' } })
    expect(doc()).toBe('second')
  })
})

describe('screens: ended (SC-17)', () => {
  test('a dashed Session ended card with Resume and New chat replaces the editor; leftover rows are read-only', async () => {
    await mount({ 'quirky.structured/queue': () => [queued('q1', 'Then say bye.')] }, { status: 'exited' })
    expect(host!.querySelector('.cm-editor')).toBeNull()
    const ended = host!.querySelector<HTMLElement>('[role="status"]')!
    expect(ended.textContent).toContain('Session ended')
    expect(ended.getAttribute('style')).toContain('dashed')
    expect(buttonNamed('Resume')).toBeDefined()
    expect(buttonNamed('New chat')).toBeDefined()
    const list = byLabel('Queued messages')!
    expect(list.textContent).toContain('Queued · runs on Resume')
    expect(buttonNamed('Steer now', list)).toBeUndefined()
    expect(buttonNamed('Edit queued message', list)).toBeUndefined()
    expect(list.querySelector('[title="Drag to reorder"]')).toBeNull()
    await click(buttonNamed('Delete queued message'))
    expect(fake.callsTo('quirky.structured/dequeue')[0]!.params).toEqual({ session: 's1', id: 'q1' })
  })

  test('Resume calls resume and opens the returned session; New chat starts a chat with the same agent', async () => {
    await mount(
      { 'quirky.structured/resume': () => session({ id: 'back', kind: 'structured', agent: 'claude' }), 'quirky.structured/create': () => session({ id: 'fresh', kind: 'structured', agent: 'claude' }) },
      { status: 'exited' }
    )
    await click(buttonNamed('Resume'))
    await settle()
    expect(fake.callsTo('quirky.structured/resume')[0]!.params).toEqual({ session: 's1' })
    expect(fake.opened.at(-1)!.input).toEqual({ worktree: 'wt-main', session: 'back' })
    await click(buttonNamed('New chat'))
    await settle()
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toMatchObject({ agent: 'claude', worktree: 'wt-main' })
    expect(fake.opened.at(-1)!.input).toEqual({ worktree: 'wt-main', session: 'fresh' })
  })

  test('Resume is absent when the agent cannot resume', async () => {
    await mount({}, { status: 'exited', capabilities: PI, agent: 'pi' })
    expect(buttonNamed('Resume')).toBeUndefined()
    expect(buttonNamed('New chat')).toBeDefined()
  })
})

describe('the visual level dial', () => {
  const DEFAULT_LEVEL = 'setting:quirky.structured/default-visual-level'
  const dial = () => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.startsWith('Visuals:'))!
  const levelMenu = () => document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Visual level"]')
  const levelItem = (label: string) => [...levelMenu()!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((item) => labelOf(item) === label)!
  const configured = () => fake.callsTo('quirky.structured/configure').map((call) => call.params)
  const saved = () => fake.callsTo('quirky.session/saveDraft').at(-1)?.params.draft

  test('a chat with no level of its own shows the default-visual-level setting, Visual-first when it is unreadable', async () => {
    await mount({}, { settings: { [DEFAULT_LEVEL]: 'balanced' } })
    expect(dial().textContent).toBe('Visuals: Balanced')
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mount()
    expect(dial().textContent).toBe('Visuals: Visual-first')
  })

  test('the level the chat journaled wins over the default setting', async () => {
    await mount({}, { settings: { [DEFAULT_LEVEL]: 'balanced' }, reportedLevel: 'off' })
    expect(dial().textContent).toBe('Visuals: Off')
  })

  test('the dial lists Off, Balanced and Visual-first with the current one checked', async () => {
    await mount()
    await click(dial())
    expect([...levelMenu()!.querySelectorAll('[role="menuitem"]')].map(labelOf)).toEqual(['Off', 'Balanced', 'Visual-first'])
    expect(levelItem('Visual-first').getAttribute('aria-checked')).toBe('true')
    expect(levelItem('Off').getAttribute('aria-checked')).not.toBe('true')
  })

  test('picking a level calls configure with only the level and the dial follows', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true, settings: { visualLevel: 'balanced' } }) })
    await click(dial())
    await click(levelItem('Balanced'))
    await settle()
    expect(configured()).toEqual([{ session: 's1', visualLevel: 'balanced' }])
    expect(dial().textContent).toBe('Visuals: Balanced')
  })

  test('picking the level already shown calls nothing', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    await click(dial())
    await click(levelItem('Visual-first'))
    await settle()
    expect(configured()).toEqual([])
  })

  test('a rejected change reverts the dial and shows an inline error', async () => {
    await mount({ 'quirky.structured/configure': () => { throw new Error('chat is closed') } })
    await click(dial())
    await click(levelItem('Off'))
    await settle()
    expect(dial().textContent).toBe('Visuals: Visual-first')
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not change the setting: chat is closed')
  })

  test('the pick is saved in the draft picks until the chat journals it', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true, settings: { visualLevel: 'off' } }) })
    await click(dial())
    await click(levelItem('Off'))
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    expect(saved().picks).toEqual({ model: null, effort: null, mode: null, visualLevel: 'off' })
    await render({ reportedLevel: 'off' })
    await typeText('x')
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 450))))
    expect(saved().picks).toEqual({ model: null, effort: null, mode: null })
  })

  test('a stored visualLevel is applied through configure and shown', async () => {
    await mount({
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half', picks: { model: null, effort: null, mode: null, visualLevel: 'off' } }),
      'quirky.structured/configure': () => ({ ok: true })
    })
    expect(dial().textContent).toBe('Visuals: Off')
    expect(configured()).toEqual([{ session: 's1', visualLevel: 'off' }])
  })

  test('a stored visualLevel that is the default calls nothing, and a draft without one loads as before', async () => {
    await mount({
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half', picks: { model: null, effort: null, mode: null, visualLevel: 'visual-first' } }),
      'quirky.structured/configure': () => ({ ok: true })
    })
    expect(configured()).toEqual([])
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mount({ 'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'old draft' }), 'quirky.structured/configure': () => ({ ok: true }) })
    expect(doc()).toBe('old draft')
    expect(dial().textContent).toBe('Visuals: Visual-first')
    expect(configured()).toEqual([])
  })

  test('a stored visualLevel never overrides the level the chat already journaled', async () => {
    await mount(
      {
        'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: 'half', picks: { model: null, effort: null, mode: null, visualLevel: 'off' } }),
        'quirky.structured/configure': () => ({ ok: true })
      },
      { reportedLevel: 'balanced' }
    )
    expect(configured()).toEqual([])
    expect(dial().textContent).toBe('Visuals: Balanced')
  })
})

describe('visual reference pills', () => {
  const ref = { viewId: 'view_0123456789ab', version: 2, element: 'dg:daemon' }
  const text = '@view:view_0123456789ab/v2/dg:daemon '
  const pills = () => [...host!.querySelectorAll('.cm-composer-pill-visual')].map((pill) => pill.textContent)

  test('a reference in a stored draft renders as a chip and goes out as the same text', async () => {
    rememberVisualLabel(ref, { title: 'Auth flow', label: 'Daemon' })
    await mount({ 'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: `${text}why this hop?` }) })
    expect(pills()).toEqual(['◈ Auth flow › Daemon'])
    expect(doc()).toBe(`${text}why this hop?`)
    await press({ key: 'Enter' })
    await settle()
    expect(sent()[0]!.text).toBe(`${text}why this hop?`)
  })

  test('chat-point puts a chip in front of the typed text and focuses the editor', async () => {
    await mount()
    await typeText('why this hop?')
    await act(async () => void chatHandler('s1', 'point')!(ref, { title: 'Auth flow', label: 'Daemon' }))
    expect(doc()).toBe(`${text}why this hop?`)
    expect(pills()).toEqual(['◈ Auth flow › Daemon'])
    expect(view().hasFocus || document.activeElement === view().contentDOM).toBe(true)
  })

  test('a second reference joins the first; the same one twice adds nothing', async () => {
    await mount()
    const other = { viewId: 'view_0123456789ab', version: 2, element: 'node:token' }
    await typeText('ask')
    await act(async () => void chatHandler('s1', 'point')!(ref, { title: 'Auth flow', label: 'Daemon' }))
    await act(async () => void chatHandler('s1', 'point')!(other, { title: 'Auth flow', label: 'Token' }))
    await act(async () => void chatHandler('s1', 'point')!(ref, { title: 'Auth flow', label: 'Daemon' }))
    expect(doc()).toBe(`${text}@view:view_0123456789ab/v2/node:token ask`)
    expect(pills()).toEqual(['◈ Auth flow › Daemon', '◈ Auth flow › Token'])
  })

  test('a chip nobody pointed at in this window reads its title from the view', async () => {
    const stray = { viewId: 'view_aaaaaaaaaaaa', version: 1, element: 'node:db' }
    await mount({
      'quirky.view/get': () => ({ title: 'Schema', spec: { title: 'Schema', root: { type: 'stack', children: [{ type: 'stat', id: 'db', props: { label: 'Postgres' } }] } } }),
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: '@view:view_aaaaaaaaaaaa/v1/node:db ok' })
    })
    await settle()
    expect(fake.callsTo('quirky.view/get')[0]!.params).toEqual({ viewId: stray.viewId, version: 1 })
    expect(pills()).toEqual(['◈ Schema › Postgres'])
  })

  test('with an empty cache a row, a matrix cell and a board card restore their own labels', async () => {
    const spec = {
      title: 'Plan',
      root: {
        type: 'stack',
        children: [
          { type: 'table', props: { columns: ['name', 'role'], rows: [['Alice', 'lead'], ['Bob', 'dev']] } },
          { type: 'matrix', props: { columns: ['Codex', 'Claude'], rows: [{ label: 'Patch', cells: ['yes', 'no'] }] } },
          { type: 'board', props: { columns: [{ title: 'Todo', cards: [{ id: 'a1', title: 'Write tests' }] }, { title: 'Done', cards: [{ id: 'b2', title: 'Ship it' }] }] } }
        ]
      }
    }
    await mount({
      'quirky.view/get': () => ({ title: 'Plan', spec }),
      'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: '@view:view_bbbbbbbbbbbb/v1/row:0 @view:view_bbbbbbbbbbbb/v1/cell:patch:claude @view:view_bbbbbbbbbbbb/v1/item:b2 ok' })
    })
    await settle()
    expect(pills()).toEqual(['◈ Plan › Alice', '◈ Plan › Patch › Claude', '◈ Plan › Ship it'])
  })

  test('the chat no longer answers after its composer is gone', async () => {
    await mount()
    expect(chatHandler('s1', 'point')).toBeDefined()
    await act(async () => root!.unmount())
    root = null
    expect(chatHandler('s1', 'point')).toBeUndefined()
  })

  test('removing the chip deletes the reference text', async () => {
    rememberVisualLabel(ref, { title: 'Auth flow', label: 'Daemon' })
    await mount({ 'quirky.session/draft': () => ({ ...EMPTY_DRAFT, text: `${text}hi` }) })
    await act(async () => view().dispatch({ changes: { from: 0, to: text.length, insert: '' } }))
    expect(pills()).toEqual([])
    expect(doc()).toBe('hi')
  })
})
