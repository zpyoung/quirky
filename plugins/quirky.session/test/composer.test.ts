import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { EditorView } from '@codemirror/view'
import { RpcError, RpcErrorCode, type AgentCapabilities, type PermissionModeName, type QueuedMessage } from '@quirky/protocol'
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
}
type Handler = (params: Record<string, any>) => unknown

const OK = { ok: true } as const
const CLAUDE: AgentCapabilities = {
  agent: 'claude',
  steer: OK,
  model: OK,
  planMode: OK,
  permissionModes: { ok: true, modes: ['default', 'acceptEdits', 'auto', 'plan'] },
  images: OK,
  effort: OK,
  approveForSession: OK,
  resume: OK
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
    const chat = session({ id: 's1', kind: 'structured', agent: props.agent ?? 'claude', status: props.status ?? 'running' })
    const capabilities = props.capabilities === undefined ? CLAUDE : props.capabilities
    root!.render(
      createElement(Composer, {
        context: fake.context,
        session: chat,
        capabilities,
        working: props.working ?? false,
        reportedMode: props.reportedMode,
        autoAvailable: props.autoAvailable,
        previousMode: props.previousMode
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
const row = (name: string) => [...popover()!.querySelectorAll<HTMLButtonElement>('.ui-list-row__main')].find((button) => button.textContent?.trim() === name)!
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
    expect(byLabel('Attachments')!.textContent).toContain('a.png')
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

  test('/plan from Plan returns to the mode before it, or Ask when there was none', async () => {
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

  test('/plan from Plan falls back to Ask when the previous mode is no longer on offer', async () => {
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
  test('popover: model list, effort segments and one Mode list with Plan as a row; the chip reads model and effort', async () => {
    await mount({}, { capabilities: { ...CLAUDE, planMode: OK } })
    expect(settingsChip().textContent).toContain('Opus · Low')
    await click(settingsChip())
    const pane = popover()!
    expect([...pane.querySelectorAll('.ui-list-row__main')].map((entry) => entry.textContent?.trim())).toEqual(['Opus', 'Sonnet', 'Ask', 'Accept edits', 'Auto', 'Plan'])
    expect([...pane.querySelectorAll('[role="radio"]')].map((entry) => entry.textContent)).toEqual(['Low', 'Medium', 'High'])
    expect(pane.querySelector('[role="switch"]')).toBeNull()
    expect(pane.textContent).toContain('Shift+Tab in the composer cycles these')
  })

  test('Auto is disabled with a reason when Claude does not offer it, and the hint says approval uses Accept edits', async () => {
    await mount({}, { autoAvailable: false })
    await click(settingsChip())
    const auto = row('Auto') as HTMLButtonElement
    expect(auto.disabled).toBe(true)
    expect(auto.title).toBe("Auto mode isn't available for this model")
    expect((row('Plan') as HTMLButtonElement).disabled).toBe(false)
    expect(popover()!.textContent).toContain('Approving a plan uses Accept edits instead of Auto')
  })

  test('Auto is on offer when Claude says so, and in a chat that has no session state yet', async () => {
    await mount({}, { autoAvailable: true })
    await click(settingsChip())
    expect((row('Auto') as HTMLButtonElement).disabled).toBe(false)
    await act(async () => root!.unmount())
    document.body.innerHTML = ''
    await mount({})
    await click(settingsChip())
    expect((row('Auto') as HTMLButtonElement).disabled).toBe(false)
  })

  test('picking a Mode row applies it at once through configure', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { autoAvailable: true })
    await click(settingsChip())
    await click(row('Plan'))
    await click(row('Auto'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([
      { session: 's1', permissionMode: 'plan' },
      { session: 's1', permissionMode: 'auto' }
    ])
  })

  test('choosing a model and an effort applies each at once, updates the chip and Esc closes the popover', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    await click(settingsChip())
    await click(row('Sonnet'))
    await click([...popover()!.querySelectorAll<HTMLElement>('[role="radio"]')].find((entry) => entry.textContent === 'Medium'))
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params)).toEqual([
      { session: 's1', model: 'sonnet' },
      { session: 's1', effort: 'medium' }
    ])
    expect(settingsChip().textContent).toContain('Sonnet · Medium')
    await act(async () => void document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })))
    expect(popover()).toBeNull()
  })

  test('a rejected change reverts the chip and shows an inline error', async () => {
    await mount({ 'quirky.structured/configure': () => { throw new Error('not now') } })
    await click(settingsChip())
    await click(row('Sonnet'))
    await settle()
    expect(settingsChip().textContent).toContain('Opus · Low')
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('Could not change the setting: not now')
  })

  test('one badge shows a mode other than Ask, with an X that returns to Ask', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) })
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(buttonNamed('Return permissions to Ask')).toBeUndefined()
    await click(settingsChip())
    await click(row('Plan'))
    await settle()
    expect(byLabel('Turn off Plan mode')!.textContent).toContain('Plan')
    await click(row('Accept edits'))
    await settle()
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(buttonNamed('Return permissions to Ask')!.textContent).toContain('Accept edits')
    await click(buttonNamed('Return permissions to Ask'))
    await settle()
    expect(buttonNamed('Return permissions to Ask')).toBeUndefined()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params).at(-1)).toEqual({ session: 's1', permissionMode: 'default' })
  })

  test('the Plan badge X leaves Plan for Ask', async () => {
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
    expect(buttonNamed('Return permissions to Ask')!.textContent).toContain('Accept edits')
    await render({ reportedMode: 'default' })
    await settle()
    expect(buttonNamed('Return permissions to Ask')).toBeUndefined()
    expect(fake.callsTo('quirky.structured/configure')).toEqual([])
  })

  test('a rejected mode change reverts to the mode before it', async () => {
    await mount({ 'quirky.structured/configure': () => { throw new Error('auto mode is not available') } }, { reportedMode: 'default' })
    await click(settingsChip())
    await click(row('Plan'))
    await settle()
    expect(byLabel('Turn off Plan mode')).toBeNull()
    expect(host!.querySelector('[role="alert"]')!.textContent).toContain('auto mode is not available')
  })

  test('unsupported controls stay visible, disabled, with the reason on hover; the chip shows the model alone without effort', async () => {
    await mount({ 'quirky.agents/options': () => ({ ...OPTIONS, agent: 'pi', models: [{ id: 'm', label: 'Pi model', description: null, options: [] }] }) }, { capabilities: { ...PI, model: OK }, agent: 'pi' })
    expect(settingsChip().textContent).toBe('Pi model')
    await click(settingsChip())
    const pane = popover()!
    const rows = ['Ask', 'Accept edits', 'Auto', 'Plan'].map((name) => row(name) as HTMLButtonElement)
    expect(rows.every((entry) => entry.disabled)).toBe(true)
    expect(rows.map((entry) => entry.title)).toEqual(['pi has no permission modes', 'pi has no permission modes', 'pi has no permission modes', 'pi has no plan mode'])
    const effortButton = pane.querySelector<HTMLButtonElement>('[role="radio"]')!
    expect(effortButton.disabled).toBe(true)
    expect(effortButton.title).toBe('pi takes no effort setting')
  })

  test('Shift+Tab moves to the next mode in list order and wraps, one configure per step', async () => {
    await mount({ 'quirky.structured/configure': () => ({ ok: true }) }, { reportedMode: 'default', autoAvailable: true })
    for (let step = 0; step < 4; step++) await press({ key: 'Tab', shiftKey: true })
    await settle()
    expect(fake.callsTo('quirky.structured/configure').map((call) => call.params.permissionMode)).toEqual(['acceptEdits', 'auto', 'plan', 'default'])
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

  test('the model list gets a search field once it passes 8 entries', async () => {
    const many = Array.from({ length: 9 }, (_, index) => ({ id: `m${index}`, label: `Model ${index}`, description: null, options: [] }))
    await mount({ 'quirky.agents/options': () => ({ ...OPTIONS, models: many }) })
    await click(settingsChip())
    const search = popover()!.querySelector<HTMLInputElement>('input')!
    expect(search).not.toBeNull()
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!.call(search, 'Model 7')
      search.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect([...popover()!.querySelectorAll('.ui-list-row__main')].map((entry) => entry.textContent?.trim())).toEqual(['Model 7', 'Ask', 'Accept edits', 'Auto', 'Plan'])
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
    expect(byLabel('Attachments')!.textContent).toContain('clip.png')
  })

  test('a dropped image with a path attaches, and the same image dropped twice appears once', async () => {
    await mount()
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    await transfer('drop', [image('shot.png', '/tmp/shot.png')])
    expect(byLabel('Attachments')!.querySelectorAll('.ui-scope-chip')).toHaveLength(1)
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
    expect(buttonNamed('Return permissions to Ask')!.textContent).toContain('Accept edits')
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
