import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  INITIAL_DECK_FOCUS,
  VisualDeckTabs,
  deckFocusReducer,
  fitDeckTabs,
  orderDeckEntries,
  type DeckClosedEntry,
  type DeckEntry,
  type DeckFocus,
  type VisualDeckTabsProps,
} from './index'

let root: Root | null = null
let container: HTMLDivElement

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root?.unmount())
  root = null
  document.body.innerHTML = ''
})

const entry = (id: string, created: number, extra: Partial<DeckEntry> = {}): DeckEntry => ({ id, label: id, title: `${id} title`, created, ...extra })
const ids = (entries: readonly DeckEntry[]) => entries.map((item) => item.id)

describe('orderDeckEntries', () => {
  test('puts the plan first, live by creation, then done by creation', () => {
    const ordered = orderDeckEntries([
      entry('mock', 2, { done: true }),
      entry('sdd', 4),
      entry('plan', 9, { pinned: true }),
      entry('brainstorm', 1),
      entry('logic', 3),
      entry('old-done', 0, { done: true }),
    ])
    expect(ids(ordered)).toEqual(['plan', 'brainstorm', 'logic', 'sdd', 'old-done', 'mock'])
  })

  test('keeps the pinned entry first even when it is marked done', () => {
    expect(ids(orderDeckEntries([entry('a', 1), entry('plan', 5, { pinned: true, done: true })]))).toEqual(['plan', 'a'])
  })

  test('is stable for equal keys and does not mutate its input', () => {
    const input = [entry('b', 1), entry('a', 1), entry('c', 1)]
    expect(ids(orderDeckEntries(input))).toEqual(['b', 'a', 'c'])
    expect(ids(input)).toEqual(['b', 'a', 'c'])
  })
})

describe('fitDeckTabs', () => {
  const six = ['plan', 'a', 'b', 'c', 'd', 'e'].map((id, index) => entry(id, index))

  test('shows everything and ignores the button width when all tabs fit', () => {
    expect(fitDeckTabs(six, [10, 10, 10, 10, 10, 10], 60, 40, null)).toEqual({ visible: ['plan', 'a', 'b', 'c', 'd', 'e'], hidden: [] })
  })

  test('hides the tail and reserves room for the overflow button', () => {
    expect(fitDeckTabs(six, [10, 10, 10, 10, 10, 10], 59, 10, null)).toEqual({ visible: ['plan', 'a', 'b', 'c'], hidden: ['d', 'e'] })
  })

  test('counts the button width only when something is hidden', () => {
    expect(fitDeckTabs(six, [10, 10, 10, 10, 10, 10], 50, 20, null)).toEqual({ visible: ['plan', 'a', 'b'], hidden: ['c', 'd', 'e'] })
  })

  test('gives an overflowing focused tab the last visible slot', () => {
    const result = fitDeckTabs(six, [10, 10, 10, 10, 10, 10], 50, 20, 'e')
    expect(result).toEqual({ visible: ['plan', 'a', 'e'], hidden: ['b', 'c', 'd'] })
  })

  test('leaves a focused tab that already fits where it is', () => {
    expect(fitDeckTabs(six, [10, 10, 10, 10, 10, 10], 50, 20, 'a')).toEqual({ visible: ['plan', 'a', 'b'], hidden: ['c', 'd', 'e'] })
  })

  test('drops more than one earlier tab when the focused tab is wide', () => {
    const result = fitDeckTabs(six, [10, 10, 10, 10, 10, 40], 60, 10, 'e')
    expect(result).toEqual({ visible: ['plan', 'e'], hidden: ['a', 'b', 'c', 'd'] })
  })

  test('still shows the focused tab when nothing else fits', () => {
    expect(fitDeckTabs(six, [10, 10, 10, 10, 10, 90], 60, 10, 'e')).toEqual({ visible: ['e'], hidden: ['plan', 'a', 'b', 'c', 'd'] })
  })

  test('returns nothing for an empty row', () => {
    expect(fitDeckTabs([], [], 100, 10, null)).toEqual({ visible: [], hidden: [] })
  })
})

describe('deckFocusReducer', () => {
  const state = (focusedId: string | null, mode: DeckFocus['mode'], dots: string[] = []): DeckFocus => ({ focusedId, mode, dots: new Set(dots) })

  test('starts following with nothing focused', () => {
    expect(INITIAL_DECK_FOCUS.focusedId).toBeNull()
    expect(INITIAL_DECK_FOCUS.mode).toBe('following')
    expect(INITIAL_DECK_FOCUS.dots.size).toBe(0)
  })

  test('drawn while following focuses it and clears its dot', () => {
    const next = deckFocusReducer(state('a', 'following', ['b']), { type: 'drawn', id: 'b' })
    expect(next.focusedId).toBe('b')
    expect(next.mode).toBe('following')
    expect(next.dots.has('b')).toBe(false)
  })

  test('drawn while steered adds a dot and leaves focus', () => {
    const next = deckFocusReducer(state('a', 'steered'), { type: 'drawn', id: 'b' })
    expect(next.focusedId).toBe('a')
    expect(next.mode).toBe('steered')
    expect([...next.dots]).toEqual(['b'])
  })

  test('drawn while steered never puts a dot on the focused tab', () => {
    expect(deckFocusReducer(state('a', 'steered'), { type: 'drawn', id: 'a' }).dots.size).toBe(0)
  })

  test('picked steers, focuses and clears the dot', () => {
    const next = deckFocusReducer(state('a', 'following', ['b', 'c']), { type: 'picked', id: 'b' })
    expect(next.focusedId).toBe('b')
    expect(next.mode).toBe('steered')
    expect([...next.dots]).toEqual(['c'])
  })

  test('stepped steers without moving focus or dots', () => {
    const next = deckFocusReducer(state('a', 'following', ['b']), { type: 'stepped', id: 'a' })
    expect(next.focusedId).toBe('a')
    expect(next.mode).toBe('steered')
    expect([...next.dots]).toEqual(['b'])
  })

  test('asked focuses, clears the dot and keeps the mode', () => {
    const steered = deckFocusReducer(state('a', 'steered', ['b']), { type: 'asked', id: 'b' })
    expect(steered).toMatchObject({ focusedId: 'b', mode: 'steered' })
    expect(steered.dots.size).toBe(0)
    expect(deckFocusReducer(state('a', 'following'), { type: 'asked', id: 'b' }).mode).toBe('following')
  })

  test('sent resumes following and keeps focus and dots', () => {
    const next = deckFocusReducer(state('a', 'steered', ['b']), { type: 'sent' })
    expect(next.focusedId).toBe('a')
    expect(next.mode).toBe('following')
    expect([...next.dots]).toEqual(['b'])
  })

  test('removed drops the dot and keeps focus when another tab was removed', () => {
    const next = deckFocusReducer(state('a', 'steered', ['b']), { type: 'removed', id: 'b', next: 'plan' })
    expect(next.focusedId).toBe('a')
    expect(next.mode).toBe('steered')
    expect(next.dots.size).toBe(0)
  })

  test('removed moves focus to next when the focused tab was removed', () => {
    const next = deckFocusReducer(state('a', 'following'), { type: 'removed', id: 'a', next: 'plan' })
    expect(next).toMatchObject({ focusedId: 'plan', mode: 'following' })
    expect(deckFocusReducer(state('a', 'following'), { type: 'removed', id: 'a', next: null }).focusedId).toBeNull()
  })

  test('does not mutate the previous state', () => {
    const before = state('a', 'steered')
    deckFocusReducer(before, { type: 'drawn', id: 'b' })
    expect(before.dots.size).toBe(0)
  })
})

describe('VisualDeckTabs', () => {
  const entries: DeckEntry[] = [
    entry('mock', 2, { done: true }),
    entry('sdd', 4),
    entry('plan', 0, { pinned: true, label: 'Plan v3' }),
    entry('logic', 3),
  ]
  const closed: DeckClosedEntry[] = [
    { id: 'old', label: 'Old one', title: 'Old one title', closedOrder: 1 },
    { id: 'newer', label: 'Newer one', title: 'Newer one title', closedOrder: 2 },
  ]

  type Calls = { pick: string[]; close: string[]; reopen: string[] }
  function props(overrides: Partial<VisualDeckTabsProps> = {}): { props: VisualDeckTabsProps; calls: Calls } {
    const calls: Calls = { pick: [], close: [], reopen: [] }
    return {
      calls,
      props: {
        label: 'Visuals',
        entries,
        closed: [],
        focusedId: 'logic',
        dots: new Set(),
        onPick: (id) => calls.pick.push(id),
        onClose: (id) => calls.close.push(id),
        onReopen: (id) => calls.reopen.push(id),
        ...overrides,
      },
    }
  }

  async function render(node: ReactNode) {
    await act(async () => root!.render(node))
  }
  const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')]
  const click = (element: Element) => act(async () => { element.dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
  const key = (element: Element, name: string) => act(async () => { element.dispatchEvent(new window.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true })) })
  const overflowTrigger = () => container.querySelector<HTMLButtonElement>('.ui-visual-deck__more .ui-menu__trigger')

  async function withLayout(widths: Record<string, number>, available: number, buttonWidth: number, run: () => Promise<void>) {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'getBoundingClientRect')
    Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: HTMLElement) {
        const measured = this.getAttribute('data-deck-measure')
        if (measured === '__more') return new DOMRect(0, 0, buttonWidth, 20)
        if (measured !== null) return new DOMRect(0, 0, widths[measured] ?? 0, 20)
        if (this.classList.contains('ui-visual-deck')) return new DOMRect(0, 0, available, 20)
        return new DOMRect(0, 0, 0, 0)
      },
    })
    try {
      await run()
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', original)
      else Reflect.deleteProperty(HTMLElement.prototype, 'getBoundingClientRect')
    }
  }

  test('renders a labelled tablist with the tabs in deck order', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    const list = container.querySelector('[role="tablist"]')
    expect(list?.getAttribute('aria-label')).toBe('Visuals')
    expect(tabs().map((tab) => tab.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Plan v3', 'logic', 'sdd', 'mock done'])
  })

  test('marks only the focused tab as selected and roves tabindex to it', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    expect(tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true', 'false', 'false'])
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([-1, 0, -1, -1])
  })

  test('falls back to the first tab for the tab stop when nothing is focused', async () => {
    await render(<VisualDeckTabs {...props({ focusedId: null }).props} />)
    expect(tabs().map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1])
  })

  test('shows the full title as the tooltip', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    expect(tabs()[2].getAttribute('title')).toBe('sdd title')
  })

  test('shows a dot only on tabs in dots', async () => {
    await render(<VisualDeckTabs {...props({ dots: new Set(['sdd']) }).props} />)
    expect(tabs().map((tab) => tab.querySelector('.ui-visual-deck__dot') !== null)).toEqual([false, false, true, false])
  })

  test('dims done tabs and gives them a done suffix', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    const done = tabs()[3]
    expect(done.classList.contains('ui-visual-deck__tab--done')).toBe(true)
    expect(done.querySelector('.ui-visual-deck__done')?.textContent).toBe('done')
    expect(tabs()[1].classList.contains('ui-visual-deck__tab--done')).toBe(false)
  })

  test('clicking a tab picks it', async () => {
    const { props: p, calls } = props()
    await render(<VisualDeckTabs {...p} />)
    await click(tabs()[2])
    expect(calls.pick).toEqual(['sdd'])
  })

  test('closing is its own labelled button that does not also pick', async () => {
    const { props: p, calls } = props()
    await render(<VisualDeckTabs {...p} />)
    const close = container.querySelector('button[aria-label="Close sdd title"]')!
    expect(close.closest('[role="tab"]')).toBeNull()
    await click(close)
    expect(calls.close).toEqual(['sdd'])
    expect(calls.pick).toEqual([])
  })

  test('the pinned tab has no close button', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    expect(container.querySelector('button[aria-label="Close plan title"]')).toBeNull()
    expect(container.querySelectorAll('.ui-visual-deck__close').length).toBe(3)
  })

  test('arrow keys move focus and pick, wrapping at the ends', async () => {
    const { props: p, calls } = props()
    await render(<VisualDeckTabs {...p} />)
    await key(tabs()[1], 'ArrowRight')
    await key(tabs()[3], 'ArrowRight')
    await key(tabs()[0], 'ArrowLeft')
    expect(calls.pick).toEqual(['sdd', 'plan', 'mock'])
  })

  test('Home and End jump to the first and last tab', async () => {
    const { props: p, calls } = props()
    await render(<VisualDeckTabs {...p} />)
    await key(tabs()[1], 'Home')
    await key(tabs()[1], 'End')
    expect(calls.pick).toEqual(['plan', 'mock'])
    expect(document.activeElement).toBe(tabs()[3])
  })

  test('renders no overflow button without hidden or closed entries', async () => {
    await render(<VisualDeckTabs {...props().props} />)
    expect(overflowTrigger()).toBeNull()
  })

  test('shows a plain caret when only closed entries exist', async () => {
    await render(<VisualDeckTabs {...props({ closed }).props} />)
    expect(overflowTrigger()?.textContent).toContain('▾')
    expect(overflowTrigger()?.textContent).not.toContain('+')
  })

  test('lists closed entries newest first under a Closed heading and reopens one', async () => {
    const { props: p, calls } = props({ closed })
    await render(<VisualDeckTabs {...p} />)
    await click(overflowTrigger()!)
    const menu = container.querySelector('[role="menu"]')!
    expect(menu.querySelector('.ui-menu__note')?.textContent).toBe('Closed')
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    expect(items.map((item) => item.textContent)).toEqual(['Newer one', 'Old one'])
    await click(items[1])
    expect(calls.reopen).toEqual(['old'])
    expect(calls.pick).toEqual([])
  })

  describe('with limited width', () => {
    const wide = [entry('plan', 0, { pinned: true }), entry('a', 1), entry('b', 2), entry('c', 3), entry('d', 4, { done: true })]
    const widths = { plan: 10, a: 10, b: 10, c: 10, d: 10 }

    test('hides the tail behind +N and lists hidden entries in order, done ones marked', async () => {
      await withLayout(widths, 40, 10, async () => {
        const { props: p, calls } = props({ entries: wide, focusedId: 'plan', closed })
        await render(<VisualDeckTabs {...p} />)
        expect(tabs().map((tab) => tab.getAttribute('data-deck-id'))).toEqual(['plan', 'a', 'b'])
        expect(overflowTrigger()?.textContent).toContain('+2')
        await click(overflowTrigger()!)
        const items = [...container.querySelectorAll('[role="menuitem"]')].map((item) => item.textContent)
        expect(items).toEqual(['c', 'd (done)', 'Newer one', 'Old one'])
        expect(container.querySelectorAll('[role="separator"]').length).toBe(1)
        await click(container.querySelectorAll('[role="menuitem"]')[1])
        expect(calls.pick).toEqual(['d'])
      })
    })

    test('keeps the focused tab visible in the last slot', async () => {
      await withLayout(widths, 40, 10, async () => {
        await render(<VisualDeckTabs {...props({ entries: wide, focusedId: 'd' }).props} />)
        expect(tabs().map((tab) => tab.getAttribute('data-deck-id'))).toEqual(['plan', 'a', 'd'])
        expect(overflowTrigger()?.textContent).toContain('+2')
      })
    })

    test('shows every tab when there is no layout', async () => {
      await render(<VisualDeckTabs {...props({ entries: wide, focusedId: 'plan' }).props} />)
      expect(tabs().length).toBe(5)
      expect(overflowTrigger()).toBeNull()
    })
  })
})
