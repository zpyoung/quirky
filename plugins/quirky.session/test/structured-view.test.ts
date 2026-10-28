import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { RpcError, RpcErrorCode, type Session } from '@quirky/protocol'
import { fakeContext, session, settle, type FakeContext } from './ui-fake'

const VIEW = 'view:quirky.session/structured'
const message = (seq: number, role: string, body: string) => ({ sessionId: 'bg', seq, role, text: body, at: 0 })
const bg = session({ id: 'bg', kind: 'structured', agent: 'claude', title: 'Claude (background)' })

let activateModule: (context: FakeContext['context']) => void
let fake: FakeContext
let element: HTMLElement | null = null
let unmount: (() => void) | void = undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // there is no WebGL in happy-dom; ui.tsx pulls in the terminal pane that would load it
  mock.module('@xterm/addon-webgl', () => ({
    WebglAddon: class {
      activate() {
        throw new Error('WebGL2 not supported')
      }
      onContextLoss() {}
      dispose() {}
    }
  }))
  const { activate } = await import('../src/ui')
  activateModule = activate
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})
afterEach(async () => {
  if (unmount) await act(async () => void (unmount as () => void)())
  unmount = undefined
  element = null
  document.body.innerHTML = ''
})

/** Serves `get` from `current`, so a test can change the session between reads. */
function start(current: { session: Session | null }, extra: Record<string, (params: Record<string, any>) => unknown> = {}) {
  fake = fakeContext({
    'quirky.session/get': (params) => {
      if (!current.session || current.session.id !== params.session) throw new RpcError(RpcErrorCode.NotFound, `no such session: ${params.session}`)
      return current.session
    },
    'quirky.structured/messages': () => [message(1, 'user', 'hi'), message(2, 'assistant', 'hello')],
    ...extra
  })
  activateModule(fake.context)
}

async function mount(input: unknown) {
  element = document.createElement('div')
  document.body.appendChild(element)
  await act(async () => {
    unmount = fake.provided.get(VIEW)!(element, { input, report: () => {} })
  })
  await settle()
  return element
}

const rows = (root: Element) => [...root.querySelectorAll('article[aria-label$="message"]')].map((row) => row.textContent)

describe('the structured session view', () => {
  test('SC-69: shows the transcript and input of the session named in the input, and switching away unmounts it', async () => {
    start({ session: bg })
    const view = await mount({ session: 'bg' })
    expect(fake.callsTo('quirky.session/get')[0]!.params).toEqual({ session: 'bg' })
    expect(fake.callsTo('quirky.structured/messages')[0]!.params).toEqual({ session: 'bg' })
    expect(rows(view)).toEqual(['userhi', 'assistanthello'])
    expect(view.querySelector('textarea')).not.toBeNull()
    expect(fake.callsTo('quirky.terminal/attach')).toEqual([])

    await act(async () => void (unmount as () => void)())
    unmount = undefined
    expect(view.textContent).toBe('')
    const reads = fake.callsTo('quirky.session/get').length
    await fake.emit({ type: 'quirky.session/changed', data: { session: bg } })
    expect(fake.callsTo('quirky.session/get')).toHaveLength(reads)
  })

  test('takes a follow-up through the same input the session view has', async () => {
    start({ session: bg }, { 'quirky.structured/send': () => ({ ok: true }) })
    const view = await mount({ session: 'bg' })
    const textarea = view.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, ' next ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'bg', text: 'next' })
  })

  test('re-reads the session when it changes, and ignores other sessions', async () => {
    const current = { session: bg as Session | null }
    start(current)
    const view = await mount({ session: 'bg' })
    expect(view.querySelector('textarea')).not.toBeNull()
    expect(view.textContent).not.toContain('session ended')

    await fake.emit({ type: 'quirky.session/changed', data: { session: session({ id: 'other', kind: 'structured' }) } })
    expect(fake.callsTo('quirky.session/get')).toHaveLength(1)

    current.session = { ...bg, status: 'exited', exitCode: 0 }
    await fake.emit({ type: 'quirky.session/changed', data: { session: current.session } })
    await settle()
    expect(fake.callsTo('quirky.session/get')).toHaveLength(2)
    expect(view.textContent).toContain('session ended')
    expect(view.querySelector('textarea')).toBeNull()
  })

  test('an unknown session says so, and a session that is closed while shown turns into the same message', async () => {
    const current = { session: null as Session | null }
    start(current)
    const missing = await mount({ session: 'nope' })
    expect(missing.querySelector('p')?.textContent).toBe('Session not found')
    expect(fake.callsTo('quirky.structured/messages')).toEqual([])

    await act(async () => void (unmount as () => void)())
    current.session = bg
    start(current)
    const view = await mount({ session: 'bg' })
    expect(view.querySelector('textarea')).not.toBeNull()
    current.session = null
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 'bg' } })
    await settle()
    expect(view.querySelector('p')?.textContent).toBe('Session not found')
    expect(view.querySelector('textarea')).toBeNull()
  })

  test('an input without a session names none and reads nothing', async () => {
    start({ session: bg })
    const view = await mount({})
    expect(view.querySelector('p')?.textContent).toBe('Session not found')
    expect(fake.callsTo('quirky.session/get')).toEqual([])
  })

  test('the worktree view and the commands are still provided', () => {
    start({ session: bg })
    expect(fake.provided.has('view:quirky.session/worktree')).toBe(true)
    expect(fake.provided.has('command:quirky.session/new-shell')).toBe(true)
    expect(fake.provided.has('command:quirky.session/select-tab-9')).toBe(true)
  })
})
