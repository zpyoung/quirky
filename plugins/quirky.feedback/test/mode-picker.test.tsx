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

const container = () => document.querySelector<HTMLElement>('[data-quirky-feedback]:not([data-feedback-banner])')
const bannerSlot = () => document.querySelector<HTMLElement>('[data-feedback-banner-slot]')!
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
function measureCard(width: number, height: number) {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches('[data-feedback-card]')) {
      return { x: 0, y: 0, width, height, left: 0, top: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect
    }
    return original.call(this)
  }
  return () => { Element.prototype.getBoundingClientRect = original }
}
function measureCardBy(size: (element: HTMLElement) => { width: number; height: number }) {
  const original = Element.prototype.getBoundingClientRect
  Element.prototype.getBoundingClientRect = function (this: Element) {
    if (this.matches('[data-feedback-card]')) {
      const { width, height } = size(this as HTMLElement)
      return { x: 0, y: 0, width, height, left: 0, top: 0, right: width, bottom: height, toJSON: () => ({}) } as DOMRect
    }
    return original.call(this)
  }
  return () => { Element.prototype.getBoundingClientRect = original }
}

function mockViewport(width: number, height: number) {
  const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth')
  const originalHeight = Object.getOwnPropertyDescriptor(window, 'innerHeight')
  const set = (nextWidth: number, nextHeight: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: nextWidth })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: nextHeight })
  }
  set(width, height)
  return {
    set,
    restore() {
      if (originalWidth === undefined) Reflect.deleteProperty(window, 'innerWidth')
      else Object.defineProperty(window, 'innerWidth', originalWidth)
      if (originalHeight === undefined) Reflect.deleteProperty(window, 'innerHeight')
      else Object.defineProperty(window, 'innerHeight', originalHeight)
    }
  }
}

let restoreViewport: (() => void) | null = null


function stack(...elements: Element[]) {
  document.elementsFromPoint = () => [host(), container()!, ...elements, document.body, document.documentElement]
}

let app: HTMLElement
let restoreCardMeasurement: (() => void) | null = null
let shadowRoot: ShadowRoot | null = null
let attachShadow: Element['attachShadow']
const label = () => shadowRoot!.querySelector<HTMLElement>('.label')!
const highlight = () => shadowRoot!.querySelector<HTMLElement>('.highlight')!

beforeEach(() => {
  annotated = []
  shadowRoot = null
  attachShadow = Element.prototype.attachShadow
  const original = attachShadow
  // the overlay's shadow root is closed; tests read it through an open one
  Element.prototype.attachShadow = function (this: Element, init: ShadowRootInit) {
    shadowRoot = original.call(this, { ...init, mode: 'open' })
    return shadowRoot
  }
  document.body.innerHTML = `<div id="app" class="app">
    <header class="window-bar" aria-label="Window bar"></header>
    <div data-feedback-banner-slot></div>
    <div class="shell-workspace">
      <h2 id="worktrees">Worktrees</h2>
      <button id="menu" class="menu-trigger" aria-label="Open Worktrees">Menu<span id="gear">icon</span></button>
      <div role="menu" id="popup"><div id="item" role="menuitem"><span id="itemtext">Item one</span></div></div>
      <div id="plain"><span id="plainspan">plain</span></div>
      <button id="secret" aria-label="client_secret=never-share-this"></button>

      <section data-terminal-pane="t1" id="term"><div class="terminal-pane-screen"><button id="termbutton"><span id="termtext">SECRET OUTPUT secret-token</span></button></div></section>
      <div class="qbp" data-browser-pane="p1" id="watch"><span class="qbp-mode" data-mode="watch"></span><div id="watched">page text</div></div>
      <div class="qbp" data-browser-pane="native-pane" id="native"><div class="qbp-native-host" id="native-host"></div></div>
    </div>
  </div>`
  app = document.getElementById('app')!
  app.querySelectorAll('*').forEach((element) => rect(element, { x: 10, y: 10, width: 100, height: 20 }))
})

afterEach(async () => {
  Element.prototype.attachShadow = attachShadow
  await act(async () => { teardown?.() })
  teardown = null
  restoreCardMeasurement?.()
  restoreCardMeasurement = null
  restoreViewport?.()
  restoreViewport = null
  document.body.innerHTML = ''
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
})

describe('container structure', () => {
  test('one fixed container holds the selection host then the react root', async () => {
    await start()
    expect(document.querySelectorAll('[data-quirky-feedback]:not([data-feedback-banner])')).toHaveLength(1)
    const box = container()!
    expect(box.parentElement).toBe(document.body)
    expect(box.style.position).toBe('fixed')
    expect(box.style.zIndex).toBe('2147483646')
    expect(Number(bannerSlot().style.zIndex)).toBeGreaterThan(Number(box.style.zIndex))
    expect(box.style.pointerEvents).toBe('none')
    expect(box.children).toHaveLength(2)
    expect(host().style.getPropertyValue('pointer-events')).toBe('auto')
    expect(reactRoot().style.pointerEvents).toBe('none')
    expect(host().hasAttribute('data-quirky-native-mask')).toBe(false)
  })

  test('mode text and native masks', async () => {
    await start()
    const banner = bannerSlot().querySelector('[data-feedback-banner]')
    expect(banner).not.toBeNull()
    expect(banner!.querySelector('span')!.textContent).toBe('Feedback mode on · Option uses the app · Esc exits')
    expect(banner!.hasAttribute('data-quirky-feedback')).toBe(true)
    expect(banner!.hasAttribute('data-quirky-native-mask')).toBe(true)
    expect(reactRoot().querySelector('[data-feedback-tray]')!.hasAttribute('data-quirky-native-mask')).toBe(true)
  })

  test('mounts the banner in the reserved slot and restores workspace on teardown', async () => {
    await start()
    const slot = bannerSlot()
    const workspace = slot.nextElementSibling
    const banner = slot.querySelector('[data-feedback-banner]')
    expect(banner).not.toBeNull()
    expect(workspace?.classList.contains('shell-workspace')).toBe(true)
    expect(banner?.parentElement).toBe(slot)
    expect(container()!.contains(banner)).toBe(false)

    await act(async () => { teardown!() })
    teardown = null

    expect(slot.childElementCount).toBe(0)
    expect(slot.nextElementSibling).toBe(workspace)
    expect(slot.style.zIndex).toBe('')
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
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Item one')
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
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Terminal pane')
    await type('too slow')
    await submit()
    const add = fake.calls.find((call) => call.method === 'quirky.feedback/add')!
    const capture = add.params!.capture as Capture
    expect(capture.kind).toBe('terminal-pane')
    expect(capture.accessibleName).toBeNull()
    expect(capture.visibleText).toBeNull()
    expect(capture.nearbyText).toBeNull()
    expect(capture.attributes).toBeNull()
    expect(JSON.stringify(capture)).not.toContain('SECRET OUTPUT')
  })

  test('a watch pane resolves to the whole pane', async () => {
    const fake = await start()
    stack(document.getElementById('watched')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Browser pane')
    await type('hm')
    await submit()
    const capture = fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture
    expect(capture.kind).toBe('browser-pane')
    expect(capture.selector).toBe('.qbp[data-browser-pane="p1"]')
    expect(capture.accessibleName).toBeNull()
  })

  test('a span inside a button resolves to the button', async () => {
    await start()
    stack(document.getElementById('gear')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Open Worktrees')
  })

  test('a heading names a new comment by its visible name', async () => {
    await start()
    stack(document.getElementById('worktrees')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Worktrees')
  })

  test('a long unbroken accessible name wraps within the comment card title', async () => {
    const name = 'name_with_underscores_'.repeat(9)
    const target = document.getElementById('menu')!
    target.setAttribute('aria-label', name)
    await start()
    stack(target)
    await act(async () => { mouse(host(), 'click') })
    const title = reactRoot().querySelector<HTMLElement>('[data-feedback-card] h2')!
    expect(title.textContent).toContain(name)
    expect(title.style.overflowWrap).toBe('anywhere')
  })

  test('a sensitive accessible name stays redacted in the card and saved capture', async () => {
    const fake = await start()
    stack(document.getElementById('secret')!)
    await act(async () => { mouse(host(), 'click') })
    const title = reactRoot().querySelector('[data-feedback-card] h2')!.textContent!
    expect(title).toContain('[redacted]')
    expect(title).not.toContain('never-share-this')
    await type('sensitive target')
    await submit()
    const capture = fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture
    expect(capture.accessibleName).toBe('[redacted]')
    expect(JSON.stringify(capture)).not.toContain('never-share-this')
  })

  test('a span inside a menu item resolves to the menu item', async () => {
    const fake = await start()
    stack(document.getElementById('itemtext')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Item one')
    await type('x')
    await submit()
    const capture = fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture
    expect(capture.selector).toContain('item')
  })

  test('a span inside a plain div stays the span', async () => {
    await start()
    stack(document.getElementById('plainspan')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('plain')
  })

  test('a terminal pane wins over a button inside it', async () => {
    await start()
    stack(document.getElementById('termtext')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Terminal pane')
  })

  test('the hover highlight outlines the control, not the inner span', async () => {
    await start()
    rect(document.getElementById('menu')!, { x: 50, y: 60, width: 80, height: 30 })
    rect(document.getElementById('gear')!, { x: 52, y: 62, width: 10, height: 10 })
    stack(document.getElementById('gear')!)
    await act(async () => { mouse(host(), 'pointermove') })
    const highlight = shadowRoot!.querySelector<HTMLElement>('.highlight')!
    expect(highlight.style.left).toBe('50px')
    expect(highlight.style.width).toBe('80px')
  })
})

describe('hover label', () => {
  const place = async (box: { x: number; y: number; width: number; height: number }, size = { width: 60, height: 20 }) => {
    await start()
    const target = document.getElementById('plainspan')!
    rect(target, box)
    rect(label(), { x: 0, y: 0, ...size })
    stack(target)
    await act(async () => { mouse(host(), 'pointermove') })
    return { left: parseFloat(label().style.left), top: parseFloat(label().style.top) }
  }

  test('sits directly above the target when there is room', async () => {
    expect(await place({ x: 100, y: 200, width: 80, height: 30 })).toEqual({ left: 100, top: 180 })
  })

  test('drops to the top edge of the target when there is no room above', async () => {
    expect(await place({ x: 100, y: 5, width: 80, height: 30 })).toEqual({ left: 100, top: 5 })
  })

  test('stays inside the window at the left and right edges', async () => {
    expect((await place({ x: -30, y: 200, width: 80, height: 30 })).left).toBe(0)
    await act(async () => { teardown!() })
    const right = await place({ x: window.innerWidth - 10, y: 200, width: 80, height: 30 })
    expect(right.left).toBe(window.innerWidth - 60)
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

describe('selected outline', () => {
  test('keeps the accepted target outlined while typing and rejecting a dirty replacement, then resumes hover on cancel', async () => {
    await start()
    const selected = document.getElementById('menu')!
    const other = document.getElementById('item')!
    rect(selected, { x: 70, y: 80, width: 120, height: 30 })
    rect(other, { x: 340, y: 280, width: 120, height: 30 })
    stack(selected)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(label().hidden).toBe(false)
    await act(async () => { mouse(host(), 'click') })
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('70px')
    expect(label().hidden).toBe(true)
    await type('draft')
    stack(other)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('70px')
    expect(label().hidden).toBe(true)
    await act(async () => { mouse(host(), 'click') })
    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    expect(card.querySelector('h2')!.textContent).toContain('Open Worktrees')
    expect(card.textContent).toContain('Esc again discards this comment.')
    expect(card.querySelector('textarea')!.value).toBe('draft')
    expect(highlight().style.left).toBe('70px')
    expect(highlight().hidden).toBe(false)
    expect(label().hidden).toBe(true)
    const cancel = [...card.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Cancel')!
    await act(async () => { cancel.click() })
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('340px')
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
    expect(label().hidden).toBe(false)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(highlight().style.left).toBe('340px')
  })

  test('resumes hover immediately after a selected comment is saved', async () => {
    await start()
    const selected = document.getElementById('menu')!
    const other = document.getElementById('item')!
    rect(selected, { x: 70, y: 80, width: 120, height: 30 })
    rect(other, { x: 340, y: 280, width: 120, height: 30 })
    stack(selected)
    await act(async () => { mouse(host(), 'click') })
    await type('saved')
    stack(other)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('70px')
    expect(label().hidden).toBe(true)
    await submit()
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('340px')
    expect(label().hidden).toBe(false)
  })

  test('clears the selected target when switching to a saved comment', async () => {
    await start([sample('c1')])
    const selected = document.getElementById('menu')!
    const other = document.getElementById('item')!
    rect(selected, { x: 70, y: 80, width: 120, height: 30 })
    rect(other, { x: 340, y: 280, width: 120, height: 30 })
    stack(selected)
    await act(async () => { mouse(host(), 'click') })
    stack(other)
    await act(async () => { mouse(host(), 'pointermove') })
    expect(highlight().style.left).toBe('70px')
    const edit = reactRoot().querySelector<HTMLButtonElement>('[data-feedback-row="c1"] button[aria-label="Edit comment 1"]')!
    await act(async () => { edit.click() })
    expect(reactRoot().querySelector('[data-feedback-card]')!.getAttribute('aria-label')).toBe('Edit comment')
    expect(highlight().hidden).toBe(false)
    expect(highlight().style.left).toBe('340px')
  })
  test('uses an accepted pane-chip selection for the selected outline', async () => {
    await start()
    const selected = document.getElementById('menu')!
    const pane = document.getElementById('native')!
    rect(selected, { x: 70, y: 80, width: 120, height: 30 })
    rect(pane, { x: 210, y: 120, width: 180, height: 120 })
    stack(selected)
    await act(async () => { mouse(host(), 'click') })
    expect(highlight().style.left).toBe('70px')
    const chip = reactRoot().querySelector<HTMLButtonElement>('[data-feedback-chip="native-pane"] button')!
    await act(async () => { chip.click() })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Browser pane')
    expect(highlight().style.left).toBe('210px')
    expect(highlight().hidden).toBe(false)
    expect(label().hidden).toBe(true)
  })

  test('retains the current outline when a dirty selection through a pane chip is rejected', async () => {
    await start()
    const selected = document.getElementById('menu')!
    const pane = document.getElementById('native')!
    rect(selected, { x: 70, y: 80, width: 120, height: 30 })
    rect(pane, { x: 210, y: 120, width: 180, height: 120 })
    stack(selected)
    await act(async () => { mouse(host(), 'click') })
    await type('draft')
    const chip = reactRoot().querySelector<HTMLButtonElement>('[data-feedback-chip="native-pane"] button')!
    await act(async () => { chip.click() })
    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    expect(card.querySelector('h2')!.textContent).toContain('Open Worktrees')
    expect(card.textContent).toContain('Esc again discards this comment.')
    expect(highlight().style.left).toBe('70px')
    expect(highlight().hidden).toBe(false)
  })

})

describe('new card placement', () => {
  test('anchors beside the selected target without crossing viewport edges', async () => {
    restoreCardMeasurement = measureCard(240, 180)
    await start()
    const target = document.getElementById('menu')!
    const targetBox = { x: window.innerWidth - 20, y: window.innerHeight - 20, width: 10, height: 10 }
    rect(target, targetBox)
    stack(target)
    await act(async () => { mouse(host(), 'click') })
    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    const left = parseFloat(card.style.left)
    const top = parseFloat(card.style.top)
    expect(Number.isFinite(left)).toBe(true)
    expect(Number.isFinite(top)).toBe(true)
    expect(left).toBeGreaterThanOrEqual(0)
    expect(top).toBeGreaterThanOrEqual(0)
    expect(left + 240).toBeLessThanOrEqual(window.innerWidth)
    expect(top + 180).toBeLessThanOrEqual(window.innerHeight)
    expect(left + 240).toBeGreaterThan(targetBox.x - 240)
    expect(top + 180).toBeGreaterThan(targetBox.y - 180)
  })

  test('keeps a new card below the banner with its actions in the viewport', async () => {
    const viewport = mockViewport(800, 500)
    restoreViewport = viewport.restore
    restoreCardMeasurement = measureCardBy((card) => {
      const maxHeight = Number.parseFloat(card.style.maxHeight)
      return { width: 240, height: Math.min(430, Number.isFinite(maxHeight) ? maxHeight : 430) }
    })
    await start()
    const banner = bannerSlot().querySelector<HTMLElement>('[data-feedback-banner]')!
    rect(banner, { x: 216, y: 52, width: 368, height: 38 })
    const target = document.getElementById('menu')!
    rect(target, { x: 500, y: 43, width: 90, height: 26 })
    stack(target)
    await act(async () => { mouse(host(), 'click') })

    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    const top = parseFloat(card.style.top)
    expect(top).toBeGreaterThanOrEqual(banner.getBoundingClientRect().bottom + 12)
    expect(top + card.getBoundingClientRect().height).toBeLessThanOrEqual(window.innerHeight)
  })

  test('keeps an edited card below the banner with actions in the viewport', async () => {
    const viewport = mockViewport(800, 500)
    restoreViewport = viewport.restore
    restoreCardMeasurement = measureCardBy((card) => {
      const maxHeight = Number.parseFloat(card.style.maxHeight)
      return { width: 240, height: Math.min(430, Number.isFinite(maxHeight) ? maxHeight : 430) }
    })
    await start([sample('saved')])
    const banner = bannerSlot().querySelector<HTMLElement>('[data-feedback-banner]')!
    rect(banner, { x: 216, y: 52, width: 368, height: 38 })
    const edit = reactRoot().querySelector<HTMLButtonElement>('[aria-label="Edit comment 1"]')!
    await act(async () => { edit.click() })
    await flush()

    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    const bannerBottom = banner.getBoundingClientRect().bottom
    const height = card.getBoundingClientRect().height
    const top = window.innerHeight - 12 - height
    expect(top).toBeGreaterThanOrEqual(bannerBottom + 12)
    expect(top + height).toBeLessThanOrEqual(window.innerHeight - 12)
    expect(card.querySelector('[data-feedback-submit]')).not.toBeNull()
  })
  test('repositions a new card when the viewport shrinks', async () => {
    const viewport = mockViewport(800, 500)
    restoreViewport = viewport.restore
    restoreCardMeasurement = measureCard(240, 180)
    await start()
    const target = document.getElementById('menu')!
    rect(target, { x: 400, y: 250, width: 10, height: 10 })
    stack(target)
    await act(async () => { mouse(host(), 'click') })
    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    expect(parseFloat(card.style.top)).toBe(272)
    await act(async () => {
      viewport.set(500, 300)
      window.dispatchEvent(new Event('resize'))
    })
    await flush()
    expect(parseFloat(card.style.left) + 240).toBeLessThanOrEqual(500)
    expect(parseFloat(card.style.top) + 180).toBeLessThanOrEqual(300)
    expect(parseFloat(card.style.left)).toBe(248)
    expect(parseFloat(card.style.top)).toBe(58)
  })

  test('repositions when a warning makes the card content grow', async () => {
    const viewport = mockViewport(800, 600)
    restoreViewport = viewport.restore
    restoreCardMeasurement = measureCardBy((card) => ({ width: 240, height: card.querySelector('[role="alert"]') === null ? 180 : 380 }))
    await start()
    const target = document.getElementById('menu')!
    rect(target, { x: 100, y: 450, width: 10, height: 10 })
    stack(target)
    await act(async () => { mouse(host(), 'click') })
    await type('draft')
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
    expect(card.textContent).toContain('Esc again discards this comment.')
    expect(parseFloat(card.style.top) + 380).toBeLessThanOrEqual(600)
    expect(parseFloat(card.style.top)).toBe(58)
  })

  test('keeps actions in the viewport when the textarea is resized without editing text', async () => {
    const viewport = mockViewport(800, 600)
    restoreViewport = viewport.restore
    let height = 180
    restoreCardMeasurement = measureCardBy(() => ({ width: 240, height }))
    const callbacks = new Set<ResizeObserverCallback>()
    const original = Object.getOwnPropertyDescriptor(window, 'ResizeObserver')
    Object.defineProperty(window, 'ResizeObserver', {
      configurable: true,
      value: class implements ResizeObserver {
        constructor(callback: ResizeObserverCallback) { callbacks.add(callback) }
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    })
    try {
      await start()
      const target = document.getElementById('menu')!
      rect(target, { x: 100, y: 450, width: 10, height: 10 })
      stack(target)
      await act(async () => { mouse(host(), 'click') })
      const card = reactRoot().querySelector<HTMLElement>('[data-feedback-card]')!
      height = 380
      await act(async () => {
        for (const callback of callbacks) callback([], {} as ResizeObserver)
      })
      expect(parseFloat(card.style.top) + height).toBeLessThanOrEqual(600)
    } finally {
      if (original === undefined) Reflect.deleteProperty(window, 'ResizeObserver')
      else Object.defineProperty(window, 'ResizeObserver', original)
    }
  })

})

describe('option key', () => {
  const passThrough = () => host().style.getPropertyValue('pointer-events') === 'none' && host().style.getPropertyPriority('pointer-events') === 'important'
  const restored = () => host().style.getPropertyValue('pointer-events') === 'auto' && host().style.getPropertyPriority('pointer-events') === 'important'

  const surface = () => shadowRoot!.querySelector<HTMLElement>('.surface')!
  const surfacePassThrough = () => surface().style.getPropertyValue('pointer-events') === 'none' && surface().style.getPropertyPriority('pointer-events') === 'important'
  const surfaceRestored = () => surface().style.getPropertyValue('pointer-events') === 'auto' && surface().style.getPropertyPriority('pointer-events') === 'important'

  test('holding Option passes pointer events through with important priority', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    expect(passThrough()).toBe(true)
    expect(surfacePassThrough()).toBe(true)
    key('keyup', 'Alt', { altKey: false })
    expect(restored()).toBe(true)
    expect(surfaceRestored()).toBe(true)
  })
  test('Option yields the picker while keeping the reserved banner mounted', async () => {
    await start()
    const banner = bannerSlot().querySelector('[data-feedback-banner]')!
    expect(banner).not.toBeNull()

    key('keydown', 'Alt', { altKey: true })
    expect(passThrough()).toBe(true)
    expect(surfacePassThrough()).toBe(true)
    expect(banner.isConnected).toBe(true)

    key('keyup', 'Alt', { altKey: false })
    expect(restored()).toBe(true)
    expect(surfaceRestored()).toBe(true)
    expect(banner.isConnected).toBe(true)
  })

  test('a window blur releases Option', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    window.dispatchEvent(new Event('blur'))
    expect(restored()).toBe(true)
    expect(surfaceRestored()).toBe(true)
  })

  test('a pointer event with altKey corrects a missed keydown, and does not select', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'pointerdown', { altKey: true }) })
    expect(passThrough()).toBe(true)
    expect(surfacePassThrough()).toBe(true)
    await act(async () => { mouse(host(), 'click', { altKey: true }) })
    expect(reactRoot().querySelector('[data-feedback-card]')).toBeNull()
  })

  test('a pointer event without altKey corrects a missed keyup', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    mouse(document.getElementById('menu')!, 'pointermove', { altKey: false })
    expect(restored()).toBe(true)
    expect(surfaceRestored()).toBe(true)
  })

  test('the press that corrects a missed keyup does not reach the app', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    let reached = 0
    const menu = document.getElementById('menu')!
    menu.addEventListener('pointerdown', () => { reached++ })
    const press = mouse(menu, 'pointerdown', { altKey: false })
    expect(reached).toBe(0)
    expect(press.defaultPrevented).toBe(true)
    expect(restored()).toBe(true)
  })

  test('the press that corrects a missed keyup still reaches the mode\'s own controls', async () => {
    await start()
    key('keydown', 'Alt', { altKey: true })
    const press = mouse(reactRoot().querySelector('button')!, 'pointerdown', { altKey: false })
    expect(press.defaultPrevented).toBe(false)
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

  test('focusin from the banner does not reach document handlers', async () => {
    await start()
    const seen: Event[] = []
    document.addEventListener('focusin', (event) => { seen.push(event) })
    const exit = bannerSlot().querySelector<HTMLButtonElement>('button')
    expect(exit).not.toBeNull()

    await act(async () => { exit!.focus() })

    expect(document.activeElement).toBe(exit)
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
    expect(card.querySelector('h2')!.textContent).toContain('Item one')
  })

  test('a selection click while the card is empty replaces the selection', async () => {
    await start()
    stack(document.getElementById('item')!)
    await act(async () => { mouse(host(), 'click') })
    stack(document.getElementById('menu')!)
    await act(async () => { mouse(host(), 'click') })
    expect(reactRoot().querySelector('[data-feedback-card] h2')!.textContent).toContain('Open Worktrees')
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
    const activeZIndex = container()!.style.zIndex
    const activeBannerZIndex = bannerSlot().style.zIndex
    await act(async () => { reactRoot().querySelector<HTMLButtonElement>('[data-feedback-clear]')!.click() })
    expect(host().style.getPropertyValue('display')).toBe('none')
    expect(container()!.style.zIndex).toBe('0')
    expect(bannerSlot().style.zIndex).toBe('0')
    const click = mouse(host(), 'click')
    expect(click.defaultPrevented).toBe(false)
    await act(async () => { fake.confirm.pending!(false) })
    await flush()
    expect(host().style.getPropertyValue('display')).not.toBe('none')
    expect(container()!.style.zIndex).toBe(activeZIndex)
    expect(bannerSlot().style.zIndex).toBe(activeBannerZIndex)
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
