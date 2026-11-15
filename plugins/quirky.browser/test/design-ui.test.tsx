import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import type { DesignPayload, DesignSelection, DesignTarget, DesignTargets } from '../src/design-contract'
import { DesignWindow, setLiveDesignPageKeys } from '../src/design-window/DesignWindow'
import { dispatchDesignControl } from '../src/ui-control'

const RUNTIME_GLOBALS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket'] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)
GlobalRegistrator.register()
for (const [name, value] of nativeGlobals) {
  if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
}
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const mountedViews = new Set<() => void>()
afterEach(async () => {
  await act(async () => {
    for (const unmount of [...mountedViews]) unmount()
  })
})
afterAll(() => {
  setLiveDesignPageKeys([])
  GlobalRegistrator.unregister()
})
beforeEach(() => { document.body.innerHTML = ''; setLiveDesignPageKeys([]) })

const payload = (url: string): DesignPayload => ({
  page: { sanitizedUrl: url, title: 'Fixture', viewportWidth: 800, viewportHeight: 600, scrollX: 0, scrollY: 0, devicePixelRatio: 1, capturedAt: '2026-10-27T00:00:00.000Z' },
  target: {
    tagName: 'button', selector: '#save', elementPath: 'button#save', fullPath: 'html > body > button#save', cssClasses: '', nearbyElements: [],
    selectedText: null, isFixed: false, reactComponents: null, sourceFile: null, textSnippet: 'Save', htmlSnippet: '<button id="save">Save</button>', attributes: { id: 'save' },
    accessibility: { role: 'button', accessibleName: 'Save', ariaLabel: '', ariaLabelledBy: '' },
    rectViewport: { x: 20, y: 30, width: 80, height: 24 }, rectPage: { x: 20, y: 30, width: 80, height: 24 }, computedStyles: { display: 'inline-block' }
  },
  nearbyText: [], ancestorPath: ['html', 'body'], screenshot: null
})

type SendFixture = { target: DesignTarget; respond: () => Promise<unknown> }
type ContextOptions = {
  send?: SendFixture
  targets?: DesignTargets | (() => Promise<DesignTargets>)
  clipboardWriteText?: (text: string) => Promise<void>
}
type MountOptions = ContextOptions & { focused?: boolean; mode?: 'native' | 'watch' }


const explicitSendTarget: DesignTarget = {
  session: 'fixture-session', agent: 'fixture-agent', label: 'Explicit fixture target', title: 'Fixture session',
  status: 'running', state: 'running', lastActivityAt: 0, sendable: true
}

function fakeContext(selection: DesignSelection | ((index: number) => DesignSelection), selectionCount = 1, options: ContextOptions = {}) {
  let nextOp = 0
  let selectionIndex = 0
  const delivered = new Set<string>()
  const writes: string[] = []
  const messages: { text: string; kind: 'info' | 'error' }[] = []
  const commandCalls: { id: string; args: unknown }[] = []
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let commandFailure: Error | null = null
  const onMessage = (text: string, kind: 'info' | 'error') => { messages.push({ text, kind }) }
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === 'quirky.browser/designArm') return { opId: `op-${++nextOp}` }
      if (method === 'quirky.browser/designRead') {
        const opId = typeof params.opId === 'string' ? params.opId : ''
        if (!delivered.has(opId) && selectionIndex < selectionCount) {
          delivered.add(opId)
          const next = typeof selection === 'function' ? selection(selectionIndex) : selection
          selectionIndex++
          return { opId, status: 'armed', selection: next }
        }
        return { opId: params.opId, status: 'armed' }
      }
      if (method === 'quirky.browser/designHover') return { payload: null }
      if (method === 'quirky.browser/designCancel') return { cancelled: true }
      if (method === 'quirky.browser/designFormat') return { text: 'formatted' }
      if (method === 'quirky.browser/designCapture') return {
        screenshot: { mimeType: 'image/png', dataUrl: 'data:image/png;base64,AAAA', width: 10, height: 10 }
      }
      if (method === 'quirky.browser/designTargets') {
        if (typeof options.targets === 'function') return options.targets()
        return options.targets ?? { sessions: options.send ? [options.send.target] : [], agents: [] }
      }
      if (method === 'quirky.browser/designSend') {
        if (!options.send) throw new Error(`Unexpected browser call ${method}`)
        return options.send.respond()
      }
      throw new Error(`Unexpected browser call ${method}`)
    },
    executeCommand: async (id: string, args: unknown) => {
      commandCalls.push({ id, args })
      if (commandFailure) throw commandFailure
      await Promise.resolve()
      dispatchDesignControl(context as unknown as UiPluginContext, args)
    }
  }
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => {
    if (options.clipboardWriteText) return options.clipboardWriteText(text)
    writes.push(text)
  } } })
  return {
    context: context as unknown as UiPluginContext, writes, messages, onMessage, commandCalls, calls,
    dispatch: (args: unknown) => dispatchDesignControl(context as unknown as UiPluginContext, args),
    failCommands: (error: Error) => { commandFailure = error }
  }
}

async function settleUntil(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 80 && !predicate(); i++) {
    const delay = Promise.withResolvers<void>()
    await act(async () => {
      setTimeout(delay.resolve, 5)
      await delay.promise
    })
  }
  expect(predicate()).toBe(true)
}

function mount(selection: DesignSelection | ((index: number) => DesignSelection), url = 'https://example.test/a', selectionCount = 1, options: MountOptions = {}) {
  const fake = fakeContext(selection, selectionCount, options)
  setLiveDesignPageKeys(['page-1'])
  const host = document.createElement('div')
  Object.defineProperty(host, 'getBoundingClientRect', { value: () => new DOMRect(0, 0, 800, 600) })
  const rootElement = document.createElement('div')
  document.body.append(host, rootElement)
  const root: Root = createRoot(rootElement)
  let mounted = true
  const unmount = () => {
    if (!mounted) return
    mounted = false
    mountedViews.delete(unmount)
    root.unmount()
  }
  mountedViews.add(unmount)
  const pane = { id: 'pane-1', mode: options.mode ?? 'watch', page: 'page-1', url, title: 'Fixture', loading: false, error: null, worktreeId: 'worktree-1' }
  const render = (nextPane = pane) => act(() => root.render(<DesignWindow
    context={fake.context}
    pane={nextPane}
    nativeHandle={null}
    pageHost={host}
    watchReady
    focused={options.focused}
    onMessage={fake.onMessage}
  />))
  render()
  return { ...fake, host, render, pane, rootElement, unmount }
}


const button = (root: ParentNode, name: string) => {
  const found = [...root.querySelectorAll('button')].find((entry) => entry.textContent?.trim() === name || entry.getAttribute('aria-label') === name)
  if (!found) throw new Error(`Button ${name} was not found`)
  return found
}

function explicitTargetButton(root: ParentNode): HTMLButtonElement {
  const found = root.querySelector<HTMLButtonElement>('[aria-label="Running agents"] button')
  if (!found) throw new Error('Explicit send target was not found')
  return found
}

const DESIGN_CONTROL = 'command:quirky.browser/designControl'
type RecordedCommand = { id: string; args: unknown }
type DesignUi = { commandCalls: RecordedCommand[]; host: HTMLElement; rootElement: HTMLElement }
const designCalls = (ui: Pick<DesignUi, 'commandCalls'>) => ui.commandCalls.filter((call) => call.id === DESIGN_CONTROL)
const C = (args: Record<string, unknown>) => ({ id: DESIGN_CONTROL, args: { pane: 'pane-1', ...args } })

async function enterFeedback(ui: Pick<DesignUi, 'host'>, comment: string): Promise<void> {
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement | null
  if (!textarea) throw new Error('Feedback textarea was not rendered')
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, comment)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
}

async function addAnnotation(ui: DesignUi, comment = 'First note'): Promise<void> {
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await enterFeedback(ui, comment)
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes(comment) === true)
}

test('a refused annotation send retains the note and releases it for another send', async () => {
  const url = 'https://example.test/refused'
  const comment = 'Keep this note after a refused send'
  const selection: DesignSelection = { kind: 'selected', payload: payload(url) }
  const ui = mount(selection, url, 1, {
    send: { target: explicitSendTarget, respond: async () => { throw new Error('fixture refusal') } }
  })

  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, comment)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes(comment) === true)

  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Running agents"] button') !== null)
  await act(async () => { explicitTargetButton(ui.host).click() })
  await settleUntil(() => button(ui.host, 'Send').disabled === false)

  expect(ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent).toContain(comment)
  expect(button(ui.host, 'Send').disabled).toBe(false)
  await act(async () => ui.unmount())
})

test('editing an annotation while sending retains the edited revision after a pasted result', async () => {
  const url = 'https://example.test/edited-during-send'
  const originalComment = 'Original note being sent'
  const editedComment = 'Edited note retained after send'
  const selection: DesignSelection = { kind: 'selected', payload: payload(url) }
  const deferredSend = Promise.withResolvers<unknown>()
  const ui = mount(selection, url, 1, {
    send: { target: explicitSendTarget, respond: () => deferredSend.promise }
  })

  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  let textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, originalComment)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes(originalComment) === true)

  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Running agents"] button') !== null)
  await act(async () => { explicitTargetButton(ui.host).click() })
  expect(button(ui.host, 'Send').disabled).toBe(true)

  await act(async () => { button(ui.host, 'Edit').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, editedComment)
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(ui.host, 'Save').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes(editedComment) === true)
  expect(button(ui.host, 'Send').disabled).toBe(true)

  await act(async () => { deferredSend.resolve({ delivery: 'pasted' }) })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes(editedComment) === true && button(ui.host, 'Send').disabled === false)
  expect(ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent).toContain(editedComment)
  expect(ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent).not.toContain(originalComment)
  expect(button(ui.host, 'Send').disabled).toBe(false)
  await act(async () => ui.unmount())
})

test('right-click selection offers actions without changing the clipboard', async () => {
  const selection: DesignSelection = { kind: 'context-selected', payload: payload('https://example.test/a') }
  const ui = mount(selection)
  await act(async () => { button(ui.rootElement, 'Grab').click() })
  await settleUntil(() => [...ui.host.querySelectorAll('button')].some((entry) => entry.textContent?.trim() === 'Copy'))
  expect(ui.writes).toEqual([])
  expect(ui.messages).toEqual([])
  await act(async () => ui.unmount())
})

test('an annotation keeps the selected page URL when the browser navigates', async () => {
  const selection: DesignSelection = { kind: 'selected', payload: payload('https://example.test/original') }
  const ui = mount(selection, 'https://example.test/original')
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this note on its original page')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.textContent?.includes('Keep this note on its original page') === true)
  ui.render({ ...ui.pane, url: 'https://example.test/next' })
  expect(ui.host.textContent).toContain('https://example.test/original')
  await act(async () => ui.unmount())
})

test('annotations survive a hosted pane unmount and remount for the same live page', async () => {
  const url = 'https://example.test/retained'
  const selection: DesignSelection = { kind: 'selected', payload: payload(url) }
  const first = mount(selection, url)
  await act(async () => { button(first.rootElement, 'Annotate').click() })
  await settleUntil(() => first.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = first.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  await act(async () => {
    textarea.focus()
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Keep this note while the hosted pane remounts')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
    textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
  })
  await act(async () => { button(first.host, 'Add').click() })
  await settleUntil(() => first.host.textContent?.includes('Keep this note while the hosted pane remounts') === true)
  await act(async () => first.unmount())

  const remounted = mount(selection, url)
  expect(remounted.host.textContent).toContain('Keep this note while the hosted pane remounts')
  expect(remounted.host.textContent).toContain(url)
  await act(async () => remounted.unmount())
})

test('the annotation tray keeps the newest 20 notes and drops the oldest', async () => {
  const url = 'https://example.test/page'
  const ui = mount((index) => {
    const selected = payload(url)
    return { kind: 'selected', payload: { ...selected, target: { ...selected.target, textSnippet: `Element ${index + 1}` } } }
  }, url, 21)
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  for (let index = 0; index < 21; index++) {
    await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
    const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
    await act(async () => {
      textarea.focus()
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, `Note ${index + 1}`)
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
      textarea.dispatchEvent(new Event('keyup', { bubbles: true }))
    })
    await act(async () => { button(ui.host, 'Add').click() })
  }
  await settleUntil(() => ui.host.querySelectorAll('[aria-label="Browser annotations"] article').length === 20)
  const comments = [...ui.host.querySelectorAll('[aria-label="Browser annotations"] article p')].map((entry) => entry.textContent)
  expect(comments).toHaveLength(20)
  expect(comments[0]).toContain('Note 2')
  expect(comments).not.toContain('Change: Note 1')
  expect(comments[19]).toContain('Note 21')
  await act(async () => ui.unmount())
})
test('the design toolbar routes Annotate, Grab and Draw actions', async () => {
  const selection: DesignSelection = { kind: 'selected', payload: payload('https://example.test/a') }
  const annotate = mount(selection)
  await act(async () => { button(annotate.rootElement, 'Annotate').click() })
  await settleUntil(() => annotate.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  expect(designCalls(annotate)).toEqual([C({ action: 'toggle-annotate' })])
  await act(async () => annotate.unmount())

  const grab = mount(selection, 'https://example.test/a', 0)
  await act(async () => { button(grab.rootElement, 'Grab').click() })
  await settleUntil(() => button(grab.rootElement, 'Grab').getAttribute('aria-pressed') === 'true')
  expect(designCalls(grab)).toEqual([C({ action: 'toggle-grab' })])
  await act(async () => grab.unmount())

  const draw = mount(selection)
  await act(async () => { button(draw.rootElement, 'Draw').click() })
  await settleUntil(() => document.body.querySelector('[role="dialog"][aria-modal="true"] strong')?.textContent === 'Draw on screenshot')
  expect(designCalls(draw)).toEqual([C({ action: 'draw' })])
  expect(draw.calls.filter((call) => call.method === 'quirky.browser/designCapture').map((call) => call.params)).toEqual([{ pane: 'pane-1' }])
  await act(async () => draw.unmount())
})

test('Native Draw is refused through the routed controller without capturing', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, { mode: 'native' })
  let result: unknown
  await act(async () => { result = ui.dispatch({ action: 'draw', pane: 'pane-1' }) })
  expect(result).toEqual({ pane: 'pane-1', action: 'draw', delivered: 1 })
  expect(ui.messages).toEqual([{
    text: 'Draw is unavailable in Native: the pinned public SDK has no supported page snapshot capability.',
    kind: 'error'
  }])
  expect(ui.calls.filter((call) => call.method === 'quirky.browser/designCapture')).toEqual([])
})

test('annotation intent and Add route through designControl', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await act(async () => { button(ui.host, 'Question').click() })
  expect(button(ui.host, 'Question').getAttribute('aria-pressed')).toBe('true')
  await enterFeedback(ui, 'Is this intentional?')
  await act(async () => { button(ui.host, 'Add').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent?.includes('Is this intentional?') === true)
  expect(ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent).toBe('Question: Is this intentional?')
  expect(designCalls(ui)).toEqual([
    C({ action: 'toggle-annotate' }),
    C({ action: 'set-intent', intent: 'question' }),
    C({ action: 'save-annotation' })
  ])
})

test('focused Escape closes a feedback draft without dispatching another design command', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, { focused: true })
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await enterFeedback(ui, 'Discard this draft')
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { textarea.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(ui.host.querySelector('[role="dialog"][aria-label="Add browser annotation"]')).toBeNull()
  expect(designCalls(ui)).toEqual([C({ action: 'toggle-annotate' })])
})

test('focused Escape cancels an armed picker without dispatching a design command', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 0, { focused: true })
  await act(async () => { button(ui.rootElement, 'Grab').click() })
  await settleUntil(() => button(ui.rootElement, 'Grab').getAttribute('aria-pressed') === 'true')
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { document.body.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  expect(ui.calls.filter((call) => call.method === 'quirky.browser/designCancel').map((call) => call.params)).toEqual([
    { pane: 'pane-1', opId: 'op-1' }
  ])
  expect(designCalls(ui)).toEqual([C({ action: 'toggle-grab' })])
  expect(button(ui.rootElement, 'Grab').getAttribute('aria-pressed')).toBe('false')
})

test('focused Mod+Enter saves the draft through one design command', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, { focused: true })
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await enterFeedback(ui, 'Note')
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  const event = new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { textarea.dispatchEvent(event) })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent === 'Change: Note')
  expect(event.defaultPrevented).toBe(true)
  expect(ui.host.querySelector('[aria-label="Browser annotations"] article p')?.textContent).toBe('Change: Note')
  expect(designCalls(ui)).toEqual([C({ action: 'toggle-annotate' }), C({ action: 'save-annotation' })])
})

test('unfocused textarea Escape and Cancel both route close-annotation', async () => {
  const ui = mount(() => ({ kind: 'selected', payload: payload('https://example.test/a') }), 'https://example.test/a', 2)
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  const textarea = ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  await act(async () => { textarea.dispatchEvent(event) })
  expect(event.defaultPrevented).toBe(true)
  await settleUntil(() => ui.host.querySelector('[role="dialog"][aria-label="Add browser annotation"]') === null)

  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await act(async () => { button(ui.host, 'Cancel').click() })
  await settleUntil(() => ui.host.querySelector('[role="dialog"][aria-label="Add browser annotation"]') === null)
  expect(designCalls(ui)).toEqual([
    C({ action: 'toggle-annotate' }), C({ action: 'close-annotation' }),
    C({ action: 'toggle-annotate' }), C({ action: 'close-annotation' })
  ])
})

test('annotation pins and tray actions route using displayed annotation numbers', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await addAnnotation(ui, 'First note')

  const documentClicks: string[] = []
  const observeClick = () => { documentClicks.push('document') }
  document.addEventListener('click', observeClick)
  const pin = ui.host.querySelector<HTMLButtonElement>('[aria-label="Edit annotation 1: First note"]')
  if (!pin) throw new Error('Annotation pin was not rendered')
  try {
    await act(async () => { pin.click() })
    await settleUntil(() => ui.host.querySelector('[role="dialog"][aria-label="Edit browser annotation"]') !== null)
    expect(documentClicks).toEqual([])
  } finally {
    document.removeEventListener('click', observeClick)
  }
  expect(designCalls(ui)).toContainEqual(C({ action: 'edit-annotation', annotation: 1 }))
  await act(async () => { button(ui.host, 'Cancel').click() })

  await act(async () => { button(ui.host, 'Copy').click() })
  await settleUntil(() => ui.writes.includes('formatted'))
  expect(ui.writes).toEqual(['formatted'])
  expect(designCalls(ui)).toContainEqual(C({ action: 'copy-annotation', annotation: 1 }))
  await act(async () => { button(ui.host, '1 annotation').click() })
  expect(button(ui.host, '1 annotation').getAttribute('aria-expanded')).toBe('false')
  expect(designCalls(ui)).toContainEqual(C({ action: 'toggle-annotations' }))
  await act(async () => { button(ui.host, 'Copy All').click() })
  expect(designCalls(ui)).toContainEqual(C({ action: 'copy-annotations' }))
  await act(async () => { button(ui.host, '1 annotation').click() })
  expect(button(ui.host, '1 annotation').getAttribute('aria-expanded')).toBe('true')
  await act(async () => { button(ui.host, 'Delete').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"]') === null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'delete-annotation', annotation: 1 }))
})

test('Clear routes clear-annotations and removes the tray', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await addAnnotation(ui, 'Clear this note')
  await act(async () => { button(ui.host, 'Clear').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"]') === null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'clear-annotations' }))
})

test('Send and Close route their target-menu actions', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, {
    send: { target: explicitSendTarget, respond: async () => ({ delivery: 'pasted' }) }
  })
  await addAnnotation(ui)
  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Running agents"] button') !== null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'open-targets' }))
  await act(async () => { button(ui.host, 'Close').click() })
  expect(ui.host.querySelector('[aria-label="Send notes to"]')).toBeNull()
  expect(designCalls(ui)).toContainEqual(C({ action: 'close-targets' }))
})

test('sending to a session routes its id and preserves the exact send identity', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, {
    send: { target: explicitSendTarget, respond: async () => ({ delivery: 'pasted' }) },
    targets: { sessions: [explicitSendTarget], agents: [{ id: 'agent-1', label: 'Agent One' }] }
  })
  await addAnnotation(ui)
  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Running agents"] button') !== null)
  await act(async () => { explicitTargetButton(ui.host).click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"]') === null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'send-annotations', session: 'fixture-session' }))
  const send = ui.calls.find((call) => call.method === 'quirky.browser/designSend')
  expect(send?.params && Object.keys(send.params).sort()).toEqual(['annotations', 'pane', 'session'])
  expect(send?.params.pane).toBe('pane-1')
  expect(send?.params.session).toBe('fixture-session')
  const annotations = send?.params.annotations as Record<string, unknown>[]
  expect(annotations).toHaveLength(1)
  expect(Object.keys(annotations[0]!)).toEqual(['id', 'revision', 'browserPageId', 'payload', 'intent', 'comment'])
  expect(annotations[0]).toMatchObject({ revision: 1, browserPageId: 'page-1', intent: 'change', comment: 'First note' })
})

test('sending to an agent routes its id and preserves the exact send identity', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, {
    send: { target: explicitSendTarget, respond: async () => ({ delivery: 'pasted' }) },
    targets: { sessions: [explicitSendTarget], agents: [{ id: 'agent-1', label: 'Agent One' }] }
  })
  await addAnnotation(ui)
  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => [...ui.host.querySelectorAll('button')].some((candidate) => candidate.textContent?.trim() === 'Agent One'))
  await act(async () => { button(ui.host, 'Agent One').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Browser annotations"]') === null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'send-annotations', agent: 'agent-1' }))
  const send = ui.calls.find((call) => call.method === 'quirky.browser/designSend')
  expect(send?.params && Object.keys(send.params).sort()).toEqual(['agent', 'annotations', 'pane'])
  expect(send?.params.pane).toBe('pane-1')
  expect(send?.params.agent).toBe('agent-1')
  const annotations = send?.params.annotations as Record<string, unknown>[]
  expect(annotations).toHaveLength(1)
  expect(Object.keys(annotations[0]!)).toEqual(['id', 'revision', 'browserPageId', 'payload', 'intent', 'comment'])
  expect(annotations[0]).toMatchObject({ revision: 1, browserPageId: 'page-1', intent: 'change', comment: 'First note' })
})

test('selection Copy, Select another and Cancel route their menu actions', async () => {
  const selection: DesignSelection = { kind: 'context-selected', payload: payload('https://example.test/a') }
  const ui = mount(selection, 'https://example.test/a', 3)
  await act(async () => { button(ui.rootElement, 'Grab').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') !== null)
  await act(async () => { button(ui.host, 'Copy').click() })
  await settleUntil(() => ui.calls.filter((call) => call.method === 'quirky.browser/designArm').length === 2)
  await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') !== null)
  await settleUntil(() => ui.writes.includes('formatted'))
  expect(ui.writes).toContain('formatted')
  expect(designCalls(ui)).toContainEqual(C({ action: 'copy-selection' }))
  await act(async () => { button(ui.host, 'Select another element').click() })
  await settleUntil(() => ui.calls.filter((call) => call.method === 'quirky.browser/designArm').length === 3)
  await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') !== null)
  await act(async () => { button(ui.host, 'Cancel').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') === null)
  expect(designCalls(ui)).toContainEqual(C({ action: 'select-another' }))
  expect(designCalls(ui)).toContainEqual(C({ action: 'cancel-selection' }))
})

test('Copy Screenshot routes the selection action and captures its exact crop', async () => {
  const previousClipboardItem = Reflect.get(globalThis, 'ClipboardItem')
  class TestClipboardItem {
    readonly types: string[]
    constructor(data: Record<string, Blob>) { this.types = Object.keys(data) }
  }
  Reflect.set(globalThis, 'ClipboardItem', TestClipboardItem)
  const writes: TestClipboardItem[][] = []
  const ui = mount({ kind: 'context-selected', payload: payload('https://example.test/a') })
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
    write: async (items: TestClipboardItem[]) => { writes.push(items) }
  } })
  try {
    await act(async () => { button(ui.rootElement, 'Grab').click() })
    await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') !== null)
    await act(async () => { button(ui.host, 'Copy Screenshot').click() })
    await settleUntil(() => ui.messages.some((message) => message.text === 'Screenshotted'))
    expect(designCalls(ui)).toContainEqual(C({ action: 'copy-selection-screenshot' }))
    expect(ui.calls.filter((call) => call.method === 'quirky.browser/designCapture').map((call) => call.params)).toEqual([
      { pane: 'pane-1', rect: { x: 20, y: 30, width: 80, height: 24 } }
    ])
    expect(writes).toHaveLength(1)
    expect(writes[0]![0]!.types).toEqual(['image/png'])
    expect(ui.messages).toEqual([{ text: 'Screenshotted', kind: 'info' }])
    expect(ui.host.querySelector('[aria-label="Selected element actions"]')).toBeNull()
  } finally {
    Reflect.set(globalThis, 'ClipboardItem', previousClipboardItem)
  }
})

test('a text clipboard refusal is rendered as InlineError inside the selection menu', async () => {
  const ui = mount({ kind: 'context-selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, {
    clipboardWriteText: async () => { throw new Error('Denied') }
  })
  await act(async () => { button(ui.rootElement, 'Grab').click() })
  await settleUntil(() => ui.host.querySelector('[aria-label="Selected element actions"]') !== null)
  await act(async () => { button(ui.host, 'Copy').click() })
  await settleUntil(() => ui.host.querySelector('[role="menu"] .ui-inline-error') !== null)
  expect(ui.host.querySelector('[role="menu"] .ui-inline-error')?.textContent).toContain('Clipboard write failed: Denied')
})

test('loading design targets are announced with NoticeLine', async () => {
  const pending = Promise.withResolvers<DesignTargets>()
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') }, 'https://example.test/a', 1, {
    targets: () => pending.promise
  })
  await addAnnotation(ui)
  await act(async () => { button(ui.host, 'Send').click() })
  const status = ui.host.querySelector('[role="status"]')
  expect(status?.querySelector('.ui-notice-line')?.textContent).toBe('Loading targets…')
})

test('empty design target groups show both EmptyState messages', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await addAnnotation(ui)
  await act(async () => { button(ui.host, 'Send').click() })
  await settleUntil(() => ui.host.querySelectorAll('.ui-empty-state').length === 2)
  expect(ui.host.querySelector('.ui-empty-state')?.textContent).toContain('No running agents in this worktree.')
  expect([...ui.host.querySelectorAll('.ui-empty-state')].map((state) => state.textContent)).toContain('No new-agent targets are available.')
})

test('a rejected designControl command reports the failure and leaves the dialog closed', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  ui.failCommands(new Error('No command: command:quirky.browser/designControl'))
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.messages.length > 0)
  expect(ui.messages).toEqual([{ text: 'No command: command:quirky.browser/designControl', kind: 'error' }])
  expect(ui.host.querySelector('[role="dialog"][aria-label="Add browser annotation"]')).toBeNull()
})

test('an unknown annotation number is reported without opening an editor', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await addAnnotation(ui)
  ui.messages.length = 0
  expect(ui.dispatch({ action: 'edit-annotation', pane: 'pane-1', annotation: 5 })).toEqual({
    pane: 'pane-1', action: 'edit-annotation', delivered: 1
  })
  expect(ui.messages).toEqual([{ text: 'Annotation 5 is not on this page.', kind: 'error' }])
  expect(ui.host.querySelector('[role="dialog"][aria-label="Edit browser annotation"]')).toBeNull()
})

test('a protected feedback draft survives a remote toggle-grab action', async () => {
  const ui = mount({ kind: 'selected', payload: payload('https://example.test/a') })
  await act(async () => { button(ui.rootElement, 'Annotate').click() })
  await settleUntil(() => ui.host.querySelector('textarea[aria-label="Feedback"]') !== null)
  await enterFeedback(ui, 'Keep me')
  const armCount = ui.calls.filter((call) => call.method === 'quirky.browser/designArm').length
  expect(ui.dispatch({ action: 'toggle-grab', pane: 'pane-1' })).toEqual({
    pane: 'pane-1', action: 'toggle-grab', delivered: 1
  })
  expect(ui.calls.filter((call) => call.method === 'quirky.browser/designArm')).toHaveLength(armCount)
  expect((ui.host.querySelector('textarea[aria-label="Feedback"]') as HTMLTextAreaElement).value).toBe('Keep me')
})
