import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import { MAX_COMMENTS, type Capture, type Comment } from '../src/contract'

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

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const flush = (ms = 0) => act(async () => { await tick(ms) })

type Calls = { method: string; params: Record<string, unknown> | undefined }[]

function sample(id: string, extra: Partial<Capture> = {}, text = `comment ${id}`): Comment {
  return {
    id, createdAt: 1, intent: 'change', comment: text,
    capture: {
      kind: 'element', owner: 'quirky', elementPath: 'div', selector: '#item', role: null, accessibleName: null,
      visibleText: null, nearbyText: null, attributes: null, rect: { x: 0, y: 0, width: 1, height: 1 }, computedStyles: {},
      component: null, source: null, sourceCaller: null, build: { version: '1', commit: 'x', channel: 'dev' }, ...extra
    }
  }
}

function fakeContext(seed: Comment[] = [], plugins: unknown = []) {
  const comments = [...seed]
  const calls: Calls = []
  const toasts: { title: string; body: string }[] = []
  const layoutListeners = new Set<() => void>()
  const failures = new Map<string, Error>()
  const confirm = { pending: null as null | ((value: boolean) => void), count: 0, options: null as unknown }
  let next = 1
  const context = {
    pluginId: 'quirky.feedback',
    log: () => {},
    onLayout: (listener: () => void) => { layoutListeners.add(listener); return () => { layoutListeners.delete(listener) } },
    toast: (title: string, body: string) => { toasts.push({ title, body }) },
    confirm: (options: unknown) => {
      confirm.count++
      confirm.options = options
      return new Promise<boolean>((resolve) => { confirm.pending = resolve })
    },
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      const failure = failures.get(method)
      if (failure) throw failure
      switch (method) {
        case 'quirky.feedback/list': return { comments: [...comments], recovered: recovered.value }
        case 'quirky.feedback/add': {
          if (comments.length >= MAX_COMMENTS) throw new Error('feedback_full: the tray is full')
          const comment = { id: `c${next++}`, createdAt: 1, intent: params!.intent, comment: params!.comment, capture: params!.capture } as Comment
          comments.push(comment)
          return comment
        }
        case 'quirky.feedback/update': {
          const found = comments.find((entry) => entry.id === params!.id)!
          Object.assign(found, { comment: params!.comment, intent: params!.intent })
          return found
        }
        case 'quirky.feedback/remove': comments.splice(comments.findIndex((entry) => entry.id === params!.id), 1); return { removed: true }
        case 'quirky.feedback/clear': { const n = comments.length; comments.length = 0; return { cleared: n } }
        case 'plugin.list': if (plugins instanceof Error) throw plugins; return plugins
        case 'setting.set': return { ok: true }
        default: throw new Error(`unexpected ${method}`)
      }
    }
  } as unknown as UiPluginContext
  return { context, calls, toasts, comments, confirm, layoutListeners, failures }
}

const recovered = { value: false }
let teardown: (() => void) | null = null

async function start(seed: Comment[] = [], plugins: unknown = []) {
  const fake = fakeContext(seed, plugins)
  await act(async () => { teardown = mountFeedbackMode(fake.context, { annotate: async () => {} }) })
  await flush()
  return fake
}

const container = () => document.querySelector<HTMLElement>('[data-quirky-feedback]')!
const host = () => container().firstElementChild as HTMLElement
const root = () => container().lastElementChild as HTMLElement
const card = () => root().querySelector<HTMLElement>('[data-feedback-card]')
const rows = () => [...root().querySelectorAll<HTMLElement>('[data-feedback-row]')]
const dots = () => [...root().querySelectorAll<HTMLElement>('[data-feedback-dot]')]
const button = (label: string, within: ParentNode = root()) => [...within.querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label || entry.getAttribute('aria-label') === label)!

function rect(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box }) as DOMRect
}

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click() })
  await flush()
}

async function pick(element: Element) {
  document.elementsFromPoint = () => [host(), element]
  await act(async () => { host().dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, clientX: 3, clientY: 3 })) })
}

async function type(text: string) {
  const area = card()!.querySelector<HTMLTextAreaElement>('textarea')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, text)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const submit = () => click(card()!.querySelector('[data-feedback-submit]')!)

let item: HTMLElement

beforeEach(() => {
  recovered.value = false
  document.body.innerHTML = '<div id="app"><div id="item">Item</div><div id="other">Other</div><div id="flat">Flat</div></div>'
  item = document.getElementById('item')!
  rect(item, { x: 40, y: 30, width: 100, height: 20 })
  rect(document.getElementById('other')!, { x: 40, y: 80, width: 100, height: 20 })
  rect(document.getElementById('flat')!, { x: 0, y: 0, width: 0, height: 0 })
})

afterEach(async () => {
  await act(async () => { teardown?.() })
  teardown = null
  document.body.innerHTML = ''
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
  delete process.env.QUIRKY_BUILD_CHANNEL
})

describe('adding', () => {
  test('SC-3: a click opens a card and adding it grows the tray and numbers the element', async () => {
    const fake = await start()
    expect(rows()).toHaveLength(0)
    await pick(item)
    expect(card()).not.toBeNull()
    expect(button('Add').disabled).toBe(true)
    await click(button('Question'))
    await type('  why is this here?  ')
    expect(button('Add').disabled).toBe(false)
    await submit()
    const add = fake.calls.find((call) => call.method === 'quirky.feedback/add')!
    expect(add.params).toMatchObject({ intent: 'question', comment: 'why is this here?' })
    expect(add.params!.capture).toMatchObject({ kind: 'element', selector: expect.stringContaining('#item') })
    expect(card()).toBeNull()
    expect(rows()).toHaveLength(1)
    expect(root().querySelector('[data-feedback-tray]')!.textContent).toContain('1 comment')
    expect(dots().map((dot) => dot.textContent)).toEqual(['1'])
  })

  test('Add is disabled for text over the limit', async () => {
    await start()
    await pick(item)
    await type('x'.repeat(2001))
    expect(button('Add').disabled).toBe(true)
    await type('x'.repeat(2000))
    expect(button('Add').disabled).toBe(false)
  })

  test('Cancel closes the card without saving', async () => {
    const fake = await start()
    await pick(item)
    await type('draft')
    await click(button('Cancel'))
    expect(card()).toBeNull()
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/add')).toBe(false)
  })

  test('a failed add keeps the card and shows a toast', async () => {
    const fake = await start()
    fake.failures.set('quirky.feedback/add', new Error('disk full'))
    await pick(item)
    await type('hello')
    await submit()
    expect(card()).not.toBeNull()
    expect(card()!.querySelector('textarea')!.value).toBe('hello')
    expect(rows()).toHaveLength(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.body).toContain('disk full')
  })

  test('feedback_full from add shows the limit message and keeps the card', async () => {
    const fake = await start()
    fake.failures.set('quirky.feedback/add', new Error('feedback_full: the tray is full'))
    await pick(item)
    await type('hello')
    await submit()
    expect(card()).not.toBeNull()
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.body).toContain(String(MAX_COMMENTS))
  })

  test('SC-12: a full tray refuses a new selection without a card', async () => {
    const seed = Array.from({ length: MAX_COMMENTS }, (_, index) => sample(`c${index}`))
    const fake = await start(seed)
    await pick(item)
    expect(card()).toBeNull()
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.body).toContain(String(MAX_COMMENTS))
    expect(rows()).toHaveLength(MAX_COMMENTS)
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/add')).toBe(false)
  })
})

describe('source lookup', () => {
  const fiber = () => Reflect.set(item, '__reactFiber$test', { type: function Widget() {}, return: null })

  test('a dev build records the component', async () => {
    process.env.QUIRKY_BUILD_CHANNEL = 'dev'
    fiber()
    const fake = await start()
    await pick(item)
    await type('x')
    await submit()
    expect((fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture).component).toBe('Widget')
  })

  test('other builds never read the component', async () => {
    process.env.QUIRKY_BUILD_CHANNEL = 'release'
    fiber()
    const fake = await start()
    await pick(item)
    await type('x')
    await submit()
    expect((fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture).component).toBeNull()
  })

  test('an element with no source still adds a comment', async () => {
    process.env.QUIRKY_BUILD_CHANNEL = 'dev'
    const fake = await start()
    await pick(item)
    await type('x')
    await submit()
    expect(rows()).toHaveLength(1)
    expect(fake.toasts).toHaveLength(0)
  })
})

describe('rows', () => {
  test('show number, intent, comment, owner and stale label', async () => {
    const seed = [
      sample('a', {}, 'first'),
      { ...sample('b', { owner: 'quirky.terminal', selector: '#missing' }, 'second'), intent: 'question' as const },
      sample('c', { owner: 'acme.thing', selector: '#item' }, 'third')
    ]
    await start(seed, [{ id: 'quirky.terminal', name: 'Terminal' }])
    const [first, second, third] = rows()
    expect(first!.textContent).toContain('1.')
    expect(first!.textContent).toContain('Change')
    expect(first!.textContent).toContain('first')
    expect(first!.textContent).toContain('Quirky')
    expect(first!.querySelector('[data-feedback-stale]')).toBeNull()
    expect(second!.textContent).toContain('Question')
    expect(second!.textContent).toContain('Terminal')
    expect(second!.textContent).toContain('No longer on screen')
    expect(third!.textContent).toContain('acme.thing')
  })

  test('owner falls back to the plugin id when the list is unavailable', async () => {
    await start([sample('a', { owner: 'quirky.terminal' })], new Error('offline'))
    expect(rows()[0]!.textContent).toContain('quirky.terminal')
  })

  test('SC-13: editing saves text and intent without recapturing', async () => {
    const fake = await start([sample('a', {}, 'first')])
    await click(button('Edit comment 1'))
    expect(card()!.querySelector('textarea')!.value).toBe('first')
    await click(button('Question'))
    await type('better')
    await click(button('Save'))
    const update = fake.calls.find((call) => call.method === 'quirky.feedback/update')!
    expect(update.params).toEqual({ id: 'a', comment: 'better', intent: 'question' })
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/add')).toBe(false)
    expect(card()).toBeNull()
    expect(rows()[0]!.textContent).toContain('better')
  })

  test('a failed edit keeps the card and the row as they were', async () => {
    const fake = await start([sample('a', {}, 'first')])
    fake.failures.set('quirky.feedback/update', new Error('nope'))
    await click(button('Edit comment 1'))
    await type('better')
    await click(button('Save'))
    expect(card()).not.toBeNull()
    expect(rows()[0]!.textContent).toContain('first')
    expect(fake.toasts).toHaveLength(1)
  })

  test('delete removes the row without a confirmation', async () => {
    const fake = await start([sample('a'), sample('b')])
    await click(button('Delete comment 1'))
    expect(fake.confirm.count).toBe(0)
    expect(fake.calls.find((call) => call.method === 'quirky.feedback/remove')!.params).toEqual({ id: 'a' })
    expect(rows().map((row) => row.getAttribute('data-feedback-row'))).toEqual(['b'])
  })

  test('a failed delete keeps the row and shows a toast', async () => {
    const fake = await start([sample('a')])
    fake.failures.set('quirky.feedback/remove', new Error('nope'))
    await click(button('Delete comment 1'))
    expect(rows()).toHaveLength(1)
    expect(fake.toasts).toHaveLength(1)
  })

  test('Esc after an untouched edit closes the card without a warning', async () => {
    await start([sample('a')])
    await click(button('Edit comment 1'))
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })) })
    expect(card()).toBeNull()
  })
})

describe('clear', () => {
  test('confirming clears every comment', async () => {
    const fake = await start([sample('a'), sample('b')])
    await click(button('Clear'))
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/clear')).toBe(false)
    await act(async () => { fake.confirm.pending!(true) })
    await flush()
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/clear')).toBe(true)
    expect(rows()).toHaveLength(0)
  })

  test('declining keeps the comments and never calls clear', async () => {
    const fake = await start([sample('a'), sample('b')])
    await click(button('Clear'))
    await act(async () => { fake.confirm.pending!(false) })
    await flush()
    expect(fake.calls.some((call) => call.method === 'quirky.feedback/clear')).toBe(false)
    expect(rows()).toHaveLength(2)
    expect(container().style.zIndex).toBe('2147483647')
  })

  test('a failed clear keeps the comments and shows a toast', async () => {
    const fake = await start([sample('a')])
    fake.failures.set('quirky.feedback/clear', new Error('nope'))
    await click(button('Clear'))
    await act(async () => { fake.confirm.pending!(true) })
    await flush()
    expect(rows()).toHaveLength(1)
    expect(fake.toasts).toHaveLength(1)
  })

  test('is disabled with no comments', async () => {
    await start()
    expect(button('Clear').disabled).toBe(true)
  })
})

describe('tray', () => {
  test('collapses to a bar and expands again, staying in the mode', async () => {
    await start([sample('a'), sample('b')])
    await click(button('Hide'))
    expect(rows()).toHaveLength(0)
    const tray = root().querySelector('[data-feedback-tray]')!
    expect(tray.textContent).toContain('2 comments')
    expect(tray.hasAttribute('data-quirky-native-mask')).toBe(true)
    expect(root().querySelector('[data-feedback-banner]')).not.toBeNull()
    await click(button('Show'))
    expect(rows()).toHaveLength(2)
  })

  test('collapse is not remembered across mode starts', async () => {
    await start([sample('a')])
    await click(button('Hide'))
    await act(async () => { teardown!() })
    await start([sample('a')])
    expect(rows()).toHaveLength(1)
  })

  test('shows a line when the comments file was set aside', async () => {
    recovered.value = true
    await start()
    expect(root().querySelector('[data-feedback-recovered]')!.textContent).toContain('set aside')
  })

  test('a failed list shows a toast and an empty tray', async () => {
    const fake = fakeContext()
    fake.failures.set('quirky.feedback/list', new Error('unreadable'))
    await act(async () => { teardown = mountFeedbackMode(fake.context, { annotate: async () => {} }) })
    await flush()
    expect(fake.toasts).toHaveLength(1)
    expect(rows()).toHaveLength(0)
  })

  test('Exit turns the mode off and a failure shows a toast', async () => {
    const fake = await start()
    await click(button('Exit'))
    expect(fake.calls.at(-1)).toEqual({ method: 'setting.set', params: { id: 'setting:quirky.feedback/active', value: false } })
    fake.failures.set('setting.set', new Error('denied'))
    await click(button('Exit'))
    expect(fake.toasts).toHaveLength(1)
  })

  test('SC-8: comments come back on a later start and missing elements are marked', async () => {
    const seed = [sample('a'), sample('b', { selector: '#gone' })]
    await start(seed)
    expect(rows()).toHaveLength(2)
    await act(async () => { teardown!() })
    await start(seed)
    expect(rows()).toHaveLength(2)
    expect(dots().map((dot) => dot.getAttribute('data-feedback-dot'))).toEqual(['a'])
    expect(rows()[1]!.querySelector('[data-feedback-stale]')).not.toBeNull()
  })
})

describe('dots', () => {
  test('are found by selector; every kind of miss is stale and hidden', async () => {
    const seed = [
      sample('found'),
      sample('missing', { selector: '#missing' }),
      sample('invalid', { selector: '[[not a selector' }),
      sample('empty', { selector: '' }),
      sample('flat', { selector: '#flat' })
    ]
    await start(seed)
    expect(dots().map((dot) => dot.getAttribute('data-feedback-dot'))).toEqual(['found'])
    expect(rows().map((row) => row.querySelector('[data-feedback-stale]') !== null)).toEqual([false, true, true, true, true])
  })

  test('are numbered by tray position, ignore the pointer and carry no native mask', async () => {
    await start([sample('x', { selector: '#missing' }), sample('y')])
    const [dot] = dots()
    expect(dot!.textContent).toBe('2')
    expect(dot!.getAttribute('aria-hidden')).toBe('true')
    expect(dot!.style.pointerEvents).toBe('none')
    expect(dot!.hasAttribute('data-quirky-native-mask')).toBe(false)
  })

  test('move with the element on layout changes, at most once per frame', async () => {
    const fake = await start([sample('a')])
    const left = () => dots()[0]!.style.left
    const before = left()
    rect(item, { x: 200, y: 30, width: 100, height: 20 })
    await act(async () => {
      for (const listener of [...fake.layoutListeners]) { listener(); listener(); listener() }
      window.dispatchEvent(new Event('resize'))
      await tick(40)
    })
    expect(left()).not.toBe(before)
    expect(left()).toContain('200')
  })

  test('are re-queried when the window scrolls', async () => {
    await start([sample('a')])
    rect(item, { x: 300, y: 30, width: 100, height: 20 })
    await act(async () => {
      document.getElementById('app')!.dispatchEvent(new Event('scroll'))
      await tick(40)
    })
    expect(dots()[0]!.style.left).toContain('300')
  })

  test('disappear when the element goes away', async () => {
    const fake = await start([sample('a')])
    item.remove()
    await act(async () => {
      for (const listener of [...fake.layoutListeners]) listener()
      await tick(40)
    })
    expect(dots()).toHaveLength(0)
    expect(rows()[0]!.querySelector('[data-feedback-stale]')).not.toBeNull()
  })
})

describe('panels', () => {
  test('the banner, card and tray are masked and the selection host is not', async () => {
    await start([sample('a')])
    await pick(item)
    for (const selector of ['[data-feedback-banner]', '[data-feedback-card]', '[data-feedback-tray]']) {
      expect(root().querySelector(selector)!.hasAttribute('data-quirky-native-mask')).toBe(true)
    }
    expect(host().hasAttribute('data-quirky-native-mask')).toBe(false)
    expect(container().hasAttribute('data-quirky-native-mask')).toBe(false)
  })
})
