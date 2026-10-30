import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { Capture, Comment } from '../src/contract'

type Mount = typeof import('../src/mode').mountFeedbackMode

let mountFeedbackMode: Mount

beforeAll(async () => {
  GlobalRegistrator.register()
  ;({ mountFeedbackMode } = await import('../src/mode'))
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true)
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

const ACTIVE = 'setting:quirky.feedback/active'
const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)) })

type Calls = { method: string; params: Record<string, unknown> | undefined }[]

function fakeContext(seed: Comment[] = []) {
  const comments = [...seed]
  const calls: Calls = []
  const toasts: { title: string; body: string }[] = []
  const layoutListeners = new Set<() => void>()
  const confirm = { pending: null as null | ((value: boolean) => void), result: true, count: 0 }
  let next = 1
  const context = {
    pluginId: 'quirky.feedback',
    log: () => {},
    getLayout: () => ({}),
    onLayout: (listener: () => void) => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener) } },
    toast: (title: string, body: string) => { toasts.push({ title, body }) },
    confirm: () => {
      confirm.count++
      return new Promise<boolean>((resolve) => { confirm.pending = resolve })
    },
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      switch (method) {
        case 'quirky.feedback/list': return { comments: [...comments], recovered: false }
        case 'quirky.feedback/add': {
          const comment = { id: `c${next++}`, createdAt: 1, intent: params!.intent, comment: params!.comment, capture: params!.capture } as Comment
          comments.push(comment)
          return comment
        }
        case 'plugin.list': return []
        case 'setting.set': return { ok: true }
        default: throw new Error(`unexpected ${method}`)
      }
    }
  } as unknown as UiPluginContext
  return { context, calls, toasts, comments, confirm, layoutListeners }
}

let teardown: (() => void) | null = null
let annotated: string[] = []

async function start(seed: Comment[] = []) {
  const fake = fakeContext(seed)
  const previous = document.activeElement
  await act(async () => {
    teardown = mountFeedbackMode(fake.context, { annotate: async (pane) => { annotated.push(pane) } })
  })
  await flush()
  return { ...fake, previous }
}

const container = () => document.querySelector<HTMLElement>('[data-quirky-feedback]')
const host = () => container()!.firstElementChild as HTMLElement
const reactRoot = () => container()!.lastElementChild as HTMLElement

function mouse(target: EventTarget, type: string, init: MouseEventInit = {}) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, button: 0, clientX: 5, clientY: 5, ...init })
  target.dispatchEvent(event)
  return event
}

function key(type: 'keydown' | 'keyup', name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent(type, { key: name, bubbles: true, cancelable: true, ...init })
  document.activeElement?.dispatchEvent(event) ?? window.dispatchEvent(event)
  return event
}

const pressEsc = () => act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })

function rect(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box }) as DOMRect
}

function stack(...elements: Element[]) {
  document.elementsFromPoint = () => [host(), container()!, ...elements, document.body, document.documentElement]
}

let app: HTMLElement

beforeEach(() => {
  annotated = []
  document.body.innerHTML = `<div id="app">
    <button id="menu" class="menu-trigger">Menu</button>
    <div role="menu" id="popup"><div id="item" role="menuitem">Item one</div></div>
    <section data-terminal-pane="t1" id="term"><div class="terminal-pane-screen"><span id="termtext">SECRET OUTPUT secret-token</span></div></section>
    <div class="qbp" data-browser-pane="p1" id="watch"><span class="qbp-mode" data-mode="watch"></span><div id="watched">page text</div></div>
  </div>`
  app = document.getElementById('app')!
  app.querySelectorAll('*').forEach((element) => rect(element, { x: 10, y: 10, width: 100, height: 20 }))
})

afterEach(async () => {
  await act(async () => { teardown?.() })
  teardown = null
  document.body.innerHTML = ''
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
})

describe('container structure', () => {
  test('one fixed container holds the selection host then the react root', async () => {
    await start()
    expect(document.querySelectorAll('[data-quirky-feedback]')).toHaveLength(1)
    const box = container()!
    expect(box.parentElement).toBe(document.body)
    expect(box.style.position).toBe('fixed')
    expect(box.style.zIndex).toBe('2147483647')
    expect(box.style.pointerEvents).toBe('none')
    expect(box.children).toHaveLength(2)
    expect(host().style.getPropertyValue('pointer-events')).toBe('auto')
    expect(reactRoot().style.pointerEvents).toBe('none')
    expect(reactRoot().style.zIndex).toBe('2147483647')
    expect(host().hasAttribute('data-quirky-native-mask')).toBe(false)
  })

  test('mode text and native masks', async () => {
    await start()
    const banner = reactRoot().querySelector('[data-feedback-banner]')!
    expect(banner.querySelector('span')!.textContent).toBe('Feedback mode on · Option uses the app · Esc exits')
    expect(banner.hasAttribute('data-quirky-native-mask')).toBe(true)
    expect(reactRoot().querySelector('[data-feedback-tray]')!.hasAttribute('data-quirky-native-mask')).toBe(true)
  })

  test('teardown removes everything and is safe to repeat', async () => {
    await start()
    await act(async () => { teardown!() })
    expect(container()).toBeNull()
    await act(async () => { teardown!() })
    teardown = null
  })

  test('teardown removes every window listener the mode added', async () => {
    const added: [string, unknown, unknown][] = []
    const removed: [string, unknown, unknown][] = []
    const add = spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: unknown, options: unknown) => { added.push([type, listener, options]) }) as never)
    const remove = spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: unknown, options: unknown) => { removed.push([type, listener, options]) }) as never)
    const fake = await start()
    const mine = added.filter(([type]) => type !== 'error' && type !== 'unhandledrejection')
    expect(mine.length).toBeGreaterThan(0)
    await act(async () => { teardown!() })
    teardown = null
    add.mockRestore()
    remove.mockRestore()
    for (const [type, listener] of mine) expect(removed.some(([t, l]) => t === type && l === listener)).toBe(true)
    expect(fake.layoutListeners.size).toBe(0)
  })

  test('a pending animation frame is cancelled on teardown', async () => {
    const fake = await start()
    const cancel = spyOn(window, 'cancelAnimationFrame')
    for (const listener of [...fake.layoutListeners]) listener()
    await act(async () => { teardown!() })
    teardown = null
    expect(cancel).toHaveBeenCalledTimes(1)
    cancel.mockRestore()
  })

  test('layout subscriptions are released', async () => {
    const fake = await start()
    expect(fake.layoutListeners.size).toBe(1)
    await act(async () => { teardown!() })
    teardown = null
    expect(fake.layoutListeners.size).toBe(0)
  })
})

describe('picker events', () => {
  test('a click on the host never reaches app listeners', async () => {
    await start()
    const seen: string[] = []
    const record = (event: Event) => { seen.push(`${event.type}`) }
    const types = ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'auxclick', 'contextmenu']
    for (const type of types) {
      document.addEventListener(type, record)
      window.addEventListener(type, record, true)
      window.addEventListener(type, record)
      app.addEventListener(type, record)
    }
    stack(document.getElementById('menu')!)
    await act(async () => {
      for (const type of types) expect(mouse(host(), type).defaultPrevented).toBe(true)
    })
    expect(seen).toEqual([])
    for (const type of types) {
      document.removeEventListener(type, record)
      window.removeEventListener(type, record, true)
      window.removeEventListener(type, record)
    }
  })

  test('events on the app itself are left alone', async () => {
    await start()
    let clicks = 0
    document.getElementById('menu')!.addEventListener('click', () => { clicks++ })
    mouse(document.getElementById('menu')!, 'click')
    expect(clicks).toBe(1)
  })

  test('a click selects the first element below the overlay through elementsFromPoint', async () => {
    await start()
    stack(document.getElementById('item')!, document.getElementById('menu')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card]')!.textContent).toContain('div')
  })

  test('only the primary button selects', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click', { button: 2 }) })
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
  })

  test('hover highlights without capturing', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
  })

  test('a terminal click selects the whole pane and stores no terminal text', async () => {
    const fake = await start()
    stack(document.getElementById('termtext')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card]')!.textContent).toContain('Terminal pane')
    await type('too slow')
    await submit()
    const add = fake.calls.find((call) => call.method === 'quirky.feedback/add')!
    const capture = add.params!.capture as Capture
    expect(capture.kind).toBe('terminal-pane')
    expect(capture.visibleText).toBeNull()
    expect(capture.nearbyText).toBeNull()
    expect(capture.attributes).toBeNull()
    expect(JSON.stringify(capture)).not.toContain('SECRET OUTPUT')
  })

  test('a watch pane resolves to the whole pane', async () => {
    const fake = await start()
    stack(document.getElementById('watched')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card]')!.textContent).toContain('Browser pane')
    await type('hm')
    await submit()
    const capture = fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture
    expect(capture.kind).toBe('browser-pane')
    expect(capture.selector).toBe('.qbp[data-browser-pane="p1"]')
  })
})

async function type(text: string) {
  const area = reactRoot().querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
    setter.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function submit() {
  await act(async () => { reactRoot().querySelector<HTMLButtonElement>('[data-feedback-submit]')!.click() })
  await flush()
}

describe('option key', () => {
  const passThrough = () => host().style.getPropertyValue('pointer-events') === 'none' && host().style.getPropertyPriority('pointer-events') === 'important'
  const restored = () => host().style.getPropertyValue('pointer-events') === 'auto' && host().style.getPropertyPriority('pointer-events') === 'important'

  test('holding Option passes pointer events through with important priority', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    expect(passThrough()).toBe(true)
    key('keyup', 'Alt', { altKey: false })
    expect(restored()).toBe(true)
  })

  test('a window blur releases Option', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    window.dispatchEvent(new Event('blur'))
    expect(restored()).toBe(true)
  })

  test('a pointer event with altKey corrects a missed keydown, and does not select', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'pointerdown', { altKey: true }) })
    expect(passThrough()).toBe(true)
    await act(async () => { mouse(host(), 'click', { altKey: true }) })
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
  })

  test('a pointer event without altKey corrects a missed keyup', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    mouse(document.getElementById('menu')!, 'pointermove', { altKey: false })
    expect(restored()).toBe(true)
  })

  test('releasing Option does not move focus', async () => {
    await start()
    const menu = document.getElementById('menu') as HTMLElement
    key('keydown', 'Alt', { altKey: true })
    menu.focus()
    key('keyup', 'Alt', { altKey: false })
    expect(document.activeElement).toBe(menu)
  })

  test('SC-4: the first click reaches the app, the second selects without activating', async () => {
    await start()
    const trigger = document.getElementById('menu')!
    const item = document.getElementById('item')!
    let triggered = 0
    let activated = 0
    let dismissed = 0
    trigger.addEventListener('click', () => { triggered++ })
    item.addEventListener('click', () => { activated++ })
    document.addEventListener('mousedown', () => { dismissed++ })
    window.addEventListener('click', () => { dismissed++ })
    key('keydown', 'Alt', { altKey: true })
    mouse(trigger, 'click', { altKey: true })
    key('keyup', 'Alt', { altKey: false })
    expect(triggered).toBe(1)
    stack(item)
    mouse(host(), 'mousedown')
    await act(async () => { mouse(host(), 'click') })
    expect(activated).toBe(0)
    expect(dismissed).toBe(1)
    expect(reactRoot().querySelector('[data-feedback-card]')).not.toBeNull()
  })
})

describe('focus', () => {
  test('moves to the surface on start and back on teardown', async () => {
    const outside = document.createElement('input')
    document.body.append(outside)
    outside.focus()
    expect(document.activeElement).toBe(outside)
    await start()
    expect(document.activeElement).not.toBe(outside)
    expect(container()!.contains(document.activeElement)).toBe(true)
    await act(async () => { teardown!() })
    teardown = null
    expect(document.activeElement).toBe(outside)
  })

  test('is not restored to an element that was removed', async () => {
    const outside = document.createElement('input')
    document.body.append(outside)
    outside.focus()
    await start()
    outside.remove()
    await act(async () => { teardown!() })
    teardown = null
    expect(document.activeElement).not.toBe(outside)
  })

  test('focusin from the card does not reach document', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    const seen: Event[] = []
    document.addEventListener('focusin', (event) => { seen.push(event) })
    const area = reactRoot().querySelector<HTMLTextAreaElement>('textarea')!
    await act(async () => { area.blur(); area.focus() })
    expect(document.activeElement).toBe(area)
    expect(seen).toHaveLength(0)
  })
})

describe('escape', () => {
  test('with no card the mode turns off', async () => {
    const fake = await start()
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    await act(async () => { window.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(true)
    expect(fake.calls.at(-1)).toEqual({ method: 'setting.set', params: { id: ACTIVE, value: false } })
  })

  test('with an empty card it closes the card and keeps the mode on', async () => {
    const fake = await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card]')).not.toBeNull()
    await pressEsc()
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
    expect(fake.calls.some((call) => call.method === 'setting.set')).toBe(false)
  })

  test('with text the first Esc warns and the second discards without saving', async () => {
    const fake = await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    await type('draft')
    await pressEsc()
    const card = reactRoot().querySelector('[data-feedback-card]')!
    expect(card.textContent).toContain('Esc again discards this comment.')
    expect(card.querySelector('textarea')!.value).toBe('draft')
    await pressEsc()
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/add' || call.method === 'setting.set')).toBe(false)
  })

  test('a selection click while the card holds text shows the warning and ignores the click', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    await type('draft')
    stack(document.getElementById('menu')!)
    await act(async () => { mouse(host(), 'click') })
    const card = reactRoot().querySelector('[data-feedback-card]')!
    expect(card.textContent).toContain('Esc again discards this comment.')
    expect(card.textContent).toContain('div')
  })

  test('a selection click while the card is empty replaces the selection', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    stack(document.getElementById('menu')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card]')!.textContent).toContain('button')
  })

  test('other keys are not consumed', async () => {
    await start()
    const event = new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })
    window.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  })

  test('is passed through while a confirm is pending', async () => {
    const fake = await start([sample('c1')])
    await act(async () => { reactRoot().querySelector<HTMLButtonElement>('[data-feedback-clear]')!.click() })
    expect(fake.confirm.count).toBe(1)
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    let reached = false
    document.addEventListener('keydown', () => { reached = true }, { once: true })
    await act(async () => { document.body.dispatchEvent(event) })
    expect(event.defaultPrevented).toBe(false)
    expect(reached).toBe(true)
    expect(fake.calls.some((call) => call.method === 'setting.set')).toBe(false)
    await act(async () => { fake.confirm.pending!(false) })
  })

  test('suspends the picker while a confirm is pending', async () => {
    const fake = await start([sample('c1')])
    await act(async () => { reactRoot().querySelector<HTMLButtonElement>('[data-feedback-clear]')!.click() })
    expect(host().style.getPropertyValue('display')).toBe('none')
    expect(container()!.style.zIndex).toBe('0')
    const click = mouse(host(), 'click')
    expect(click.defaultPrevented).toBe(false)
    await act(async () => { fake.confirm.pending!(false) })
    await flush()
    expect(host().style.getPropertyValue('display')).not.toBe('none')
    expect(container()!.style.zIndex).toBe('2147483647')
  })
})

function sample(id: string, extra: Partial<Capture> = {}): Comment {
  return {
    id, createdAt: 1, intent: 'change', comment: `comment ${id}`,
    capture: {
      kind: 'element', owner: 'quirky', elementPath: 'div', selector: '#item', role: null, accessibleName: null,
      visibleText: null, nearbyText: null, attributes: null, rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {},
      component: null, source: null, sourceCaller: null, build: { version: '1', commit: 'x', channel: 'dev' }, ...extra
    }
  }
}
