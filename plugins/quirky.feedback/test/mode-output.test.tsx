import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { UiPluginContext } from '@quirky/protocol'
import type { Capture, Comment } from '../src/contract'
import { buildIssueDrafts, builtinRepository } from '../src/issue'

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

type Call = { method: string; params: Record<string, unknown> | undefined }

function fakeContext(seed: Comment[], plugins: unknown) {
  const comments = [...seed]
  const calls: Call[] = []
  const toasts: { title: string; body: string }[] = []
  const handlers = new Map<string, (params?: Record<string, unknown>) => unknown>()
  const context = {
    pluginId: 'quirky.feedback',
    log: () => {},
    onLayout: () => () => {},
    toast: (title: string, body: string) => { toasts.push({ title, body }) },
    confirm: async () => true,
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      const handler = handlers.get(method)
      if (handler) return handler(params)
      switch (method) {
        case 'quirky.feedback/list': return { comments: [...comments], recovered: false }
        case 'quirky.feedback/add': {
          const comment = { id: `n${calls.length}`, createdAt: 1, intent: params!.intent, comment: params!.comment, capture: params!.capture } as Comment
          comments.push(comment)
          return comment
        }
        case 'plugin.list': if (plugins instanceof Error) throw plugins; return plugins
        case 'quirky.terminal/openExternal': return { ok: true }
        default: throw new Error(`unexpected ${method}`)
      }
    }
  } as unknown as UiPluginContext
  return { context, calls, toasts, handlers }
}

let teardown: (() => void) | null = null
let annotated: string[] = []

async function start(seed: Comment[] = [], plugins: unknown = []) {
  const fake = fakeContext(seed, plugins)
  await act(async () => { teardown = mountFeedbackMode(fake.context, { annotate: async (pane) => { annotated.push(pane) } }) })
  await flush()
  // copy and file issue live in the panel, which starts closed
  await click(document.querySelector('[data-feedback-toggle]')!)
  return fake
}

const container = () => document.querySelector<HTMLElement>('[data-quirky-feedback]:not([data-feedback-banner])')!
const host = () => container().firstElementChild as HTMLElement
const root = () => container().lastElementChild as HTMLElement
const button = (label: string) => [...root().querySelectorAll<HTMLButtonElement>('button')].find((entry) => entry.textContent === label)!
const notice = () => root().querySelector('[data-feedback-notice]')?.textContent ?? ''
const opened = (calls: Call[]) => calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => String(call.params!.target))

async function click(element: Element) {
  await act(async () => { (element as HTMLElement).click() })
  await flush()
}

function rect(element: Element, box: { x: number; y: number; width: number; height: number }) {
  element.getBoundingClientRect = () => ({ ...box, left: box.x, top: box.y, right: box.x + box.width, bottom: box.y + box.height, toJSON: () => box }) as DOMRect
}

const clipboard = { writes: [] as string[], settle: null as null | { resolve(): void; reject(error: Error): void } }

beforeEach(() => {
  annotated = []
  clipboard.writes = []
  clipboard.settle = null
  document.body.innerHTML = '<div id="app" class="app"><header class="window-bar" aria-label="Window bar"></header><div data-feedback-banner-slot></div><div class="shell-workspace"></div></div>'
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: (text: string) => {
        clipboard.writes.push(text)
        return new Promise<void>((resolve, reject) => { clipboard.settle = { resolve, reject } })
      }
    }
  })
})

afterEach(async () => {
  await act(async () => { teardown?.() })
  teardown = null
  document.body.innerHTML = ''
  delete (document as { elementsFromPoint?: unknown }).elementsFromPoint
})

describe('copy', () => {
  test('SC-9: confirms only after the clipboard write resolves, and keeps the comments', async () => {
    const fake = await start([sample('a'), sample('b', { owner: 'quirky.terminal' })])
    await click(button('Copy'))
    expect(clipboard.writes).toHaveLength(1)
    expect(clipboard.writes[0]).toContain('## Quirky UI Feedback')
    expect(clipboard.writes[0]).toContain('comment a')
    expect(clipboard.writes[0]).toContain('comment b')
    expect(fake.toasts).toHaveLength(0)
    await act(async () => { clipboard.settle!.resolve() })
    await flush()
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.title).toBe('Copied')
    expect(root().querySelectorAll('[data-feedback-row]')).toHaveLength(2)
  })

  test('a rejected write does not confirm', async () => {
    const fake = await start([sample('a')])
    await click(button('Copy'))
    await act(async () => { clipboard.settle!.reject(new Error('denied')) })
    await flush()
    expect(fake.toasts.map((toast) => toast.title)).toEqual(['Could not copy the comments'])
    expect(fake.toasts[0]!.body).toContain('denied')
    expect(root().querySelectorAll('[data-feedback-row]')).toHaveLength(1)
  })

  test('is disabled with no comments', async () => {
    await start()
    expect(button('Copy').disabled).toBe(true)
    expect(button('File issue').disabled).toBe(true)
  })

  test('nothing is sent anywhere without an explicit action', async () => {
    const fake = await start([sample('a')])
    expect(clipboard.writes).toHaveLength(0)
    expect(opened(fake.calls)).toHaveLength(0)
  })
})

describe('file issue', () => {
  const acme = { id: 'acme.thing', name: 'Acme', repository: 'https://github.com/acme/thing' }

  test('SC-10: opens one draft per repository and keeps the comments', async () => {
    const fake = await start(
      [sample('a'), sample('b', { owner: 'quirky.terminal' }), sample('c', { owner: 'acme.thing' })],
      [{ id: 'quirky.terminal', name: 'Terminal' }, acme]
    )
    await click(button('File issue'))
    const urls = opened(fake.calls)
    expect(urls).toHaveLength(2)
    expect(urls[0]!.startsWith('https://github.com/zpyoung/quirky/issues/new?')).toBe(true)
    expect(urls[1]!.startsWith('https://github.com/acme/thing/issues/new?')).toBe(true)
    expect(notice()).toContain('Opened 2 issue drafts')
    expect(root().querySelectorAll('[data-feedback-row]')).toHaveLength(3)
  })

  test('comments without a repository are sent to Copy', async () => {
    const fake = await start([sample('a'), sample('b', { owner: 'third.party' })], [{ id: 'third.party', name: 'Third' }])
    await click(button('File issue'))
    expect(opened(fake.calls)).toHaveLength(1)
    expect(notice()).toContain('1 comment')
    expect(notice()).toContain('Use Copy')
  })

  test('only unrouted comments opens nothing', async () => {
    const fake = await start([sample('b', { owner: 'third.party' })], [])
    await click(button('File issue'))
    expect(opened(fake.calls)).toHaveLength(0)
    expect(notice()).toContain('Use Copy')
    expect(notice()).not.toContain('Opened')
  })

  test('SC-11: says how many comments did not fit', async () => {
    const seed = Array.from({ length: 12 }, (_, index) => sample(`c${index}`, {}, 'long '.repeat(300)))
    const expected = buildIssueDrafts(seed, builtinRepository).drafts[0]!.remaining
    expect(expected).toBeGreaterThan(0)
    const fake = await start(seed)
    await click(button('File issue'))
    expect(opened(fake.calls)).toHaveLength(1)
    expect(notice()).toContain(`${expected} comments didn't fit. Delete the filed ones, then choose File issue again, or use Copy.`)
  })

  test('a draft that fails to open does not stop the others', async () => {
    const fake = await start([sample('a'), sample('c', { owner: 'acme.thing' })], [acme])
    let attempts = 0
    fake.handlers.set('quirky.terminal/openExternal', () => {
      attempts++
      if (attempts === 1) throw new Error('no browser')
      return { ok: true }
    })
    await click(button('File issue'))
    expect(attempts).toBe(2)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.body).toContain('no browser')
    expect(notice()).toContain('Opened 1 issue draft.')
  })

  test('an ok:false result shows a toast and the other drafts still open', async () => {
    const fake = await start([sample('a'), sample('c', { owner: 'acme.thing' })], [acme])
    let attempts = 0
    fake.handlers.set('quirky.terminal/openExternal', () => ({ ok: ++attempts !== 1 }))
    await click(button('File issue'))
    expect(attempts).toBe(2)
    expect(fake.toasts).toHaveLength(1)
  })

  test('opens nothing when the plugin list cannot be read', async () => {
    const fake = await start([sample('a')], [])
    fake.handlers.set('plugin.list', () => { throw new Error('daemon away') })
    await click(button('File issue'))
    expect(opened(fake.calls)).toHaveLength(0)
    expect(fake.toasts).toHaveLength(1)
    expect(fake.toasts[0]!.body).toContain('daemon away')
  })
})

describe('browser pane chip', () => {
  const pane = (mode: string, id = 'p1', native = true) => {
    document.body.insertAdjacentHTML('beforeend', `<div class="qbp" data-browser-pane="${id}"><span class="qbp-mode" data-mode="${mode}"></span>${native ? '<div class="qbp-native-host"></div>' : '<div class="qbp-page">page</div>'}</div>`)
    const element = document.querySelector(`[data-browser-pane="${id}"]`)!
    for (const target of element.querySelectorAll('*')) rect(target, { x: 50, y: 60, width: 400, height: 300 })
    rect(element, { x: 50, y: 60, width: 400, height: 300 })
    return element
  }
  const chips = () => [...root().querySelectorAll<HTMLElement>('[data-feedback-chip]')]

  test('SC-7: a Native pane gets a chip carrying its pane id and a native mask', async () => {
    pane('native')
    await start()
    expect(chips().map((chip) => chip.getAttribute('data-feedback-chip'))).toEqual(['p1'])
    expect(chips()[0]!.hasAttribute('data-quirky-native-mask')).toBe(true)
    expect(chips()[0]!.textContent).toContain('Comment on this pane')
    expect(chips()[0]!.textContent).toContain('Annotate this page')
  })

  test('a Watch pane gets no chip', async () => {
    pane('watch', 'w1', false)
    await start()
    expect(chips()).toHaveLength(0)
  })

  test('no pane means no chip', async () => {
    await start()
    expect(chips()).toHaveLength(0)
  })

  test('a hidden Native pane gets no chip', async () => {
    const element = pane('native')
    rect(element.querySelector('.qbp-native-host')!, { x: 0, y: 0, width: 0, height: 0 })
    await start()
    expect(chips()).toHaveLength(0)
  })

  test('Comment on this pane opens a card for the whole pane', async () => {
    pane('native')
    const fake = await start()
    await click(button('Comment on this pane'))
    const card = root().querySelector('[data-feedback-card]')!
    expect(card.textContent).toContain('Browser pane')
    const area = card.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(area, 'blurry')
      area.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await click(card.querySelector('[data-feedback-submit]')!)
    const capture = fake.calls.find((call) => call.method === 'quirky.feedback/add')!.params!.capture as Capture
    expect(capture.kind).toBe('browser-pane')
    expect(capture.selector).toBe('.qbp[data-browser-pane="p1"]')
    expect(capture.visibleText).toBeNull()
    expect(capture.nearbyText).toBeNull()
  })

  test('Annotate this page asks the stub to annotate that pane', async () => {
    pane('native')
    await start()
    await click(button('Annotate this page'))
    expect(annotated).toEqual(['p1'])
  })

  test('the selection host stays unmasked beside the chip', async () => {
    pane('native')
    await start()
    expect(host().hasAttribute('data-quirky-native-mask')).toBe(false)
  })
})
