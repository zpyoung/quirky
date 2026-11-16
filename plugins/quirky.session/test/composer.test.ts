import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act, createElement } from 'react'
import type { Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type AgentCapabilities, type QueuedMessage } from '@quirky/protocol'
import { fakeContext, session, settle, type FakeContext } from './ui-fake'

type Props = { capabilities?: AgentCapabilities | null; working?: boolean; agent?: string; status?: 'running' | 'exited' }
type Handler = (params: Record<string, any>) => unknown

const OK = { ok: true } as const
const CLAUDE: AgentCapabilities = {
  agent: 'claude',
  steer: OK,
  planMode: OK,
  permissionModes: { ok: true, modes: ['default', 'acceptEdits'] },
  images: OK,
  effort: OK,
  approveForSession: OK,
  resume: OK
}
const PI: AgentCapabilities = {
  agent: 'pi',
  steer: { ok: false, reason: 'pi steers only between tool calls' },
  planMode: { ok: false, reason: 'pi has no plan mode' },
  permissionModes: { ok: false, reason: 'pi has no permission modes' },
  images: OK,
  effort: { ok: false, reason: 'pi takes no effort setting' },
  approveForSession: { ok: false, reason: 'pi has no session approvals' },
  resume: OK
}
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
    {
      id: 'opus',
      label: 'Opus',
      description: null,
      options: [{ id: 'effort', label: 'Effort', type: 'select', choices: [{ value: 'low', label: 'Low' }, { value: 'high', label: 'High' }] }]
    },
    { id: 'sonnet', label: 'Sonnet', description: null, options: [] }
  ]
}

const queued = (id: string, text: string): QueuedMessage => ({ id, text, at: '2026-11-16T10:00:00.000Z' })

let createRoot: typeof import('react-dom/client').createRoot
let Composer: typeof import('../src/window/chat/Composer').Composer
let fake: FakeContext
let root: Root | null = null
let host: HTMLElement | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  ;({ createRoot } = await import('react-dom/client'))
  ;({ Composer } = await import('../src/window/chat/Composer'))
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

async function mount(handlers: Record<string, Handler> = {}, props: Props = {}) {
  fake = fakeContext({
    'quirky.structured/send': () => ({ ok: true }),
    'quirky.structured/stop': () => ({ ok: true }),
    'quirky.structured/queue': () => [],
    'quirky.agents/options': () => OPTIONS,
    ...handlers
  })
  const chat = session({ id: 's1', kind: 'structured', agent: props.agent ?? 'claude', status: props.status ?? 'running' })
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  const capabilities = props.capabilities === undefined ? CLAUDE : props.capabilities
  await act(async () => {
    root!.render(createElement(Composer, { context: fake.context, session: chat, capabilities, working: props.working ?? false }))
  })
  await settle()
  return host
}

const box = () => host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')!
const byLabel = (label: string) => host!.querySelector<HTMLElement>(`[aria-label="${label}"]`)
const buttonNamed = (name: string) => [...host!.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === name || button.getAttribute('aria-label') === name)

async function type(value: string) {
  const area = box()
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(area, value)
    area.selectionStart = area.selectionEnd = value.length
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const press = (key: string, init: KeyboardEventInit = {}) =>
  act(async () => void box().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })))
const click = (element: Element | null | undefined) => act(async () => void element!.dispatchEvent(new MouseEvent('click', { bubbles: true })))

describe('the composer', () => {
  test('Enter sends now when the agent is idle and clears the box', async () => {
    await mount()
    await type('hello')
    await press('Enter')
    await settle()
    expect(fake.callsTo('quirky.structured/send')).toEqual([{ method: 'quirky.structured/send', params: { session: 's1', text: 'hello', when: 'now' } }])
    expect(box().value).toBe('')
  })

  test('Enter queues for idle while the agent is working', async () => {
    await mount({}, { working: true })
    await type('next')
    await press('Enter')
    await settle()
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 's1', text: 'next', when: 'idle' })
  })

  test('Shift+Enter leaves the message unsent', async () => {
    await mount()
    await type('line')
    await press('Enter', { shiftKey: true })
    expect(fake.callsTo('quirky.structured/send')).toHaveLength(0)
    expect(box().value).toBe('line')
  })

  test('a failed send toasts and restores the text', async () => {
    await mount({
      'quirky.structured/send': () => {
        throw new RpcError(RpcErrorCode.Conflict, 'busy')
      }
    })
    await type('keep me')
    await press('Enter')
    await settle()
    expect(fake.toasts).toEqual([{ title: 'Could not send', body: 'busy' }])
    expect(box().value).toBe('keep me')
  })

  test('shows elapsed time and Stop while working, and Stop stops the session', async () => {
    await mount({}, { working: true })
    expect(host!.querySelector('[aria-label="Elapsed time"]')!.textContent).toMatch(/^\d+s$/)
    await click(buttonNamed('Stop'))
    expect(fake.callsTo('quirky.structured/stop')[0]!.params).toEqual({ session: 's1' })
  })

  test('shows no Stop while idle', async () => {
    await mount()
    expect(buttonNamed('Stop')).toBeUndefined()
  })

  test('an ended session shows a session ended bar instead of the input', async () => {
    await mount({}, { status: 'exited' })
    expect(host!.textContent).toContain('session ended')
    expect(box()).toBeNull()
  })
})

describe('the queued list', () => {
  const withQueue = (items: QueuedMessage[], extra: Record<string, Handler> = {}) => ({ 'quirky.structured/queue': () => items, ...extra })

  test('lists the queue and follows queueChanged', async () => {
    await mount(withQueue([queued('q1', 'first')]), { working: true })
    const list = byLabel('Queued messages')!
    expect(list.textContent).toContain('first')
    await fake.emit({ type: 'quirky.structured/queueChanged', data: { sessionId: 's1', queue: [queued('q1', 'first'), queued('q2', 'second')] } } as never)
    expect(byLabel('Queued messages')!.textContent).toContain('second')
    await fake.emit({ type: 'quirky.structured/queueChanged', data: { sessionId: 'other', queue: [] } } as never)
    expect(byLabel('Queued messages')!.textContent).toContain('second')
    await fake.emit({ type: 'quirky.structured/queueChanged', data: { sessionId: 's1', queue: [] } } as never)
    expect(byLabel('Queued messages')).toBeNull()
  })

  test('edits a queued message', async () => {
    await mount(withQueue([queued('q1', 'first')], { 'quirky.structured/editQueued': () => ({ ok: true }) }), { working: true })
    await click(buttonNamed('Edit queued message'))
    const field = host!.querySelector<HTMLTextAreaElement>('textarea[aria-label="Edit queued message text"]')!
    expect(field.value).toBe('first')
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(field, 'changed')
      field.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(buttonNamed('Save'))
    expect(fake.callsTo('quirky.structured/editQueued')[0]!.params).toEqual({ session: 's1', id: 'q1', text: 'changed' })
  })

  test('deletes a queued message', async () => {
    await mount(withQueue([queued('q1', 'first')], { 'quirky.structured/dequeue': () => ({ ok: true }) }), { working: true })
    await click(buttonNamed('Delete queued message'))
    expect(fake.callsTo('quirky.structured/dequeue')[0]!.params).toEqual({ session: 's1', id: 'q1' })
  })

  test('Steer now sends the message straight away', async () => {
    await mount(withQueue([queued('q1', 'first')], { 'quirky.structured/steer': () => ({ ok: true }) }), { working: true })
    await click(buttonNamed('Steer now'))
    expect(fake.callsTo('quirky.structured/steer')[0]!.params).toEqual({ session: 's1', id: 'q1' })
  })

  test('Steer now is disabled with the capability reason when steering is unsupported', async () => {
    await mount(withQueue([queued('q1', 'first')], { 'quirky.structured/steer': () => ({ ok: true }) }), { working: true, capabilities: PI })
    const steer = buttonNamed('Steer now')!
    expect(steer.disabled).toBe(true)
    expect(steer.title).toBe('pi steers only between tool calls')
    await click(steer)
    expect(fake.callsTo('quirky.structured/steer')).toHaveLength(0)
  })

  test('a failed queue action toasts', async () => {
    await mount(
      withQueue([queued('q1', 'first')], {
        'quirky.structured/dequeue': () => {
          throw new RpcError(RpcErrorCode.NotFound, 'gone')
        }
      }),
      { working: true }
    )
    await click(buttonNamed('Delete queued message'))
    expect(fake.toasts).toEqual([{ title: 'Could not update the queue', body: 'gone' }])
  })
})

describe('the composer controls', () => {
  const control = (name: string) => {
    const label = [...host!.querySelectorAll('label')].find((item) => item.textContent === name)
    return label ? (host!.querySelector<HTMLSelectElement>(`#${CSS.escape(label.getAttribute('for')!)}`) as HTMLSelectElement) : null
  }

  test('disables what pi cannot do and puts the reason on every disabled control', async () => {
    await mount({}, { capabilities: PI, agent: 'pi' })
    const mode = control('Permission mode')!
    expect(mode.disabled).toBe(true)
    expect(mode.title).toBe('pi has no permission modes')
    const plan = buttonNamed('Plan mode')!
    expect(plan.disabled).toBe(true)
    expect(plan.title).toBe('pi has no plan mode')
    const effort = control('Effort')!
    expect(effort.disabled).toBe(true)
    expect(effort.title).toBe('pi takes no effort setting')
    expect(buttonNamed('Attach images')!.disabled).toBe(false)
    expect(control('Model')!.disabled).toBe(false)
    for (const disabled of host!.querySelectorAll<HTMLElement>('select:disabled, button:disabled')) {
      if (disabled.getAttribute('aria-label') === 'Send') continue
      if (disabled.textContent?.trim() === 'Send') continue
      expect(disabled.title).not.toBe('')
    }
  })

  test('leaves every control live for claude', async () => {
    await mount()
    expect(control('Permission mode')!.disabled).toBe(false)
    expect([...control('Permission mode')!.options].map((option) => option.value)).toEqual(['default', 'acceptEdits'])
    expect(buttonNamed('Plan mode')!.disabled).toBe(false)
    expect(control('Effort')!.disabled).toBe(false)
    expect(control('Model')!.disabled).toBe(false)
    expect(buttonNamed('Attach images')!.disabled).toBe(false)
  })

  test('lists models and the effort choices of the chosen model from quirky.agents/options', async () => {
    await mount()
    expect(fake.callsTo('quirky.agents/options')[0]!.params).toEqual({ agent: 'claude' })
    expect([...control('Model')!.options].map((option) => option.textContent)).toEqual(['Opus', 'Sonnet'])
    expect([...control('Effort')!.options].map((option) => option.textContent)).toEqual(['Low', 'High'])
  })

  test('shows the agent as a fixed chip', async () => {
    await mount()
    expect(host!.querySelector('[aria-label="Agent"]')!.textContent).toContain('claude')
    expect(host!.querySelector('select[aria-label="Agent"]')).toBeNull()
  })

  test('toggles plan mode', async () => {
    await mount()
    const plan = buttonNamed('Plan mode')!
    expect(plan.getAttribute('aria-pressed')).toBe('false')
    await click(plan)
    expect(plan.getAttribute('aria-pressed')).toBe('true')
  })

  const dropOn = async (target: Element, files: File[], types: string[] = ['Files']) => {
    const event = new Event('drop', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'dataTransfer', { value: { files, types } })
    await act(async () => void target.dispatchEvent(event))
    return event
  }
  const image = (name: string) => new File(['x'], name, { type: 'image/png' })

  test('the attach button explains that images are dropped and opens no picker', async () => {
    await mount()
    expect(host!.querySelector('input[type="file"]')).toBeNull()
    const attach = buttonNamed('Attach images')!
    expect(attach.title).toBe('Drop images onto the composer')
    await click(attach)
    expect(fake.toasts).toEqual([{ title: 'Attach images', body: 'Drop images onto the composer' }])
  })

  test('attaches dropped images by the native drop paths, resolved together, and sends them', async () => {
    await mount()
    const asked: string[][] = []
    ;(fake.context as { nativeDropPaths: unknown }).nativeDropPaths = async (files: ArrayLike<{ name: string }>) => {
      asked.push(Array.from(files, (file) => file.name))
      return ['/home/me/shot.png', '/home/me/notes.txt']
    }
    const event = await dropOn(host!.firstElementChild!, [image('shot.png'), new File(['t'], 'notes.txt', { type: 'text/plain' })])
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(asked).toEqual([['shot.png', 'notes.txt']])
    expect(host!.querySelector('[aria-label="Attached images"]')!.textContent).toContain('shot.png')
    expect(fake.toasts).toEqual([{ title: 'Could not attach', body: 'notes.txt is not an image' }])
    await type('look')
    await press('Enter')
    await settle()
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 's1', text: 'look', images: ['/home/me/shot.png'], when: 'now' })
    expect(host!.textContent).not.toContain('shot.png')
  })

  test('a dropped image with no known path toasts instead of attaching', async () => {
    await mount()
    await dropOn(host!.firstElementChild!, [image('shot.png')])
    await settle()
    expect(host!.querySelector('[aria-label="Attached images"]')).toBeNull()
    expect(fake.toasts).toEqual([{ title: 'Could not attach', body: 'shot.png has no file path' }])
  })

  test('a dropped file that carries its own absolute path attaches without a native report', async () => {
    await mount()
    await dropOn(host!.firstElementChild!, [Object.assign(image('shot.png'), { path: '/tmp/shot.png' })])
    await settle()
    expect(host!.querySelector('[aria-label="Attached images"]')!.textContent).toContain('shot.png')
  })

  test('a drop that carries no files is left alone', async () => {
    await mount()
    const event = await dropOn(host!.firstElementChild!, [], ['text/plain'])
    expect(event.defaultPrevented).toBe(false)
  })

  test('dropping images is refused with the capability reason when the agent takes none', async () => {
    await mount({}, { capabilities: { ...PI, images: { ok: false, reason: 'pi takes no images' } } })
    await dropOn(host!.firstElementChild!, [Object.assign(image('shot.png'), { path: '/tmp/shot.png' })])
    await settle()
    expect(host!.querySelector('[aria-label="Attached images"]')).toBeNull()
    expect(fake.toasts).toEqual([{ title: 'Could not attach', body: 'pi takes no images' }])
  })

  test('pasted image files attach through the same path resolution', async () => {
    await mount()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [Object.assign(image('clip.png'), { path: '/tmp/clip.png' })] } })
    await act(async () => void box().dispatchEvent(event))
    await settle()
    expect(event.defaultPrevented).toBe(true)
    expect(host!.querySelector('[aria-label="Attached images"]')!.textContent).toContain('clip.png')
  })

  test('pasting text is left to the textarea', async () => {
    await mount()
    const event = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(event, 'clipboardData', { value: { files: [] } })
    await act(async () => void box().dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('@ mentions', () => {
  const search = (query: string) => ({
    results: [{ path: 'src/app.ts', name: 'app.ts', score: 1 }, { path: 'src/main.ts', name: 'main.ts', score: 0.5 }].filter((entry) => entry.path.includes(query)),
    truncated: false,
    history: []
  })

  test('typing @ lists files from the worktree and choosing one inserts @path', async () => {
    await mount({ 'quirky.editor/quickOpen': (params) => search(params.query) })
    await type('see @app')
    await settle()
    expect(fake.callsTo('quirky.editor/quickOpen').at(-1)!.params).toMatchObject({ worktree: 'wt-main', action: 'search', query: 'app' })
    const list = host!.querySelector('[role="listbox"]')!
    const options = [...list.querySelectorAll('[role="option"]')]
    expect(options.map((option) => option.textContent)).toEqual(['src/app.ts'])
    await click(options[0])
    expect(box().value).toBe('see @src/app.ts ')
    expect(host!.querySelector('[role="listbox"]')).toBeNull()
  })

  test('Enter picks the highlighted file instead of sending', async () => {
    await mount({ 'quirky.editor/quickOpen': (params) => search(params.query) })
    await type('@src')
    await settle()
    await press('ArrowDown')
    await press('Enter')
    expect(box().value).toBe('@src/main.ts ')
    expect(fake.callsTo('quirky.structured/send')).toHaveLength(0)
  })

  test('Shift+Enter with the list open leaves the keystroke to the textarea, so it inserts a newline', async () => {
    await mount({ 'quirky.editor/quickOpen': (params) => search(params.query) })
    await type('@src')
    await settle()
    const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true })
    await act(async () => void box().dispatchEvent(event))
    expect(event.defaultPrevented).toBe(false)
    expect(box().value).toBe('@src')
    expect(fake.callsTo('quirky.structured/send')).toHaveLength(0)
  })

  test('Tab picks the highlighted file', async () => {
    await mount({ 'quirky.editor/quickOpen': (params) => search(params.query) })
    await type('@src')
    await settle()
    await press('Tab')
    expect(box().value).toBe('@src/app.ts ')
  })

  test('says file search is unavailable when the editor plugin is missing', async () => {
    await mount()
    await type('@a')
    await settle()
    expect(host!.querySelector('[role="alert"]')?.textContent).toContain('File search unavailable')
  })

  test('says no files match with the shared empty state', async () => {
    await mount({ 'quirky.editor/quickOpen': () => ({ results: [] }) })
    await type('@zz')
    await settle()
    expect(host!.querySelector('.ui-empty-state')?.textContent).toBe('No matching files')
  })
})
