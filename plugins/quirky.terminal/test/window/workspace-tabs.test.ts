import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  fire,
  group,
  key,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  mouse,
  pane,
  setRect,
  startRecording,
  stopRecording,
  tab,
  type,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'

let mounted: MountedWorkspace | null = null

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(daemon = fakeDaemon(conceptualWorkspace()), options = {}) {
  mounted = await mountFixture(daemon, options)
  return mounted
}


type ResizeHarness = { notify(): Promise<void>; restore(): void }

function observeResize(): ResizeHarness {
  const original = globalThis.ResizeObserver
  const observers: { callback: ResizeObserverCallback; active: boolean }[] = []
  globalThis.ResizeObserver = class {
    private readonly entry: { callback: ResizeObserverCallback; active: boolean }
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, active: true }
      observers.push(this.entry)
    }
    observe() {}
    unobserve() {}
    disconnect() {
      this.entry.active = false
    }
  } as unknown as typeof ResizeObserver
  return {
    async notify() {
      await act(async () => {
        for (const observer of observers) if (observer.active) observer.callback([], {} as ResizeObserver)
      })
    },
    restore() {
      globalThis.ResizeObserver = original
    }
  }
}

function tabRect(left: number, width: number): DOMRect {
  return { x: left, y: 0, left, top: 0, right: left + width, bottom: 32, width, height: 32, toJSON: () => ({}) } as DOMRect
}

function installTabLayout(view: MountedWorkspace, width: number, initialWidths: Record<string, number>) {
  const viewport = view.q<HTMLElement>('.qt-tabs')!
  const navigation = viewport.parentElement as HTMLElement
  let available = width
  let widths = initialWidths
  const controls = () => navigation.querySelectorAll('[aria-label="Scroll tabs left"], [aria-label="Scroll tabs right"]').length
  const tabWidth = (item: HTMLElement) => widths[item.dataset.tab!] ?? 100
  const tabItems = () => view.qa<HTMLElement>('.qt-tabs > [data-tab]')
  Object.defineProperty(navigation, 'clientWidth', { configurable: true, get: () => available })
  Object.defineProperty(navigation, 'getBoundingClientRect', { configurable: true, value: () => tabRect(0, available) })
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => Math.max(0, available - controls() * 32) })
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => tabItems().reduce((total, item) => total + tabWidth(item), 0) })
  Object.defineProperty(viewport, 'getBoundingClientRect', {
    configurable: true,
    value: () => tabRect(controls() > 0 && navigation.querySelector('[aria-label="Scroll tabs left"]') ? 32 : 0, viewport.clientWidth)
  })
  const refresh = () => {
    for (const item of tabItems()) {
      Object.defineProperty(item, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const items = tabItems()
          const index = items.indexOf(item)
          const left = (viewport.getBoundingClientRect().left ?? 0) + items.slice(0, index).reduce((total, previous) => total + tabWidth(previous), 0) - viewport.scrollLeft
          return tabRect(left, tabWidth(item))
        }
      })
    }
  }
  refresh()
  return {
    viewport,
    refresh,
    setWidth(next: number) {
      available = next
    },
    setTabWidths(next: Record<string, number>) {
      widths = next
      refresh()
    },
    visible(id: string) {
      const item = view.q<HTMLElement>(`[data-tab="${id}"]`)!
      const itemRect = item.getBoundingClientRect()
      const viewRect = viewport.getBoundingClientRect()
      return itemRect.right > viewRect.left && itemRect.left < viewRect.right
    }
  }
}

function terminalTabs(count: number) {
  return Array.from({ length: count }, (_, index) =>
    tab(`tab-${index + 1}`, pane(`pane-${index + 1}`, `s-${index + 1}`), { defaultTitle: `Terminal ${index + 1}` })
  )
}

async function flushResize(resize: ResizeHarness) {
  await resize.notify()
  await resize.notify()
}
const drag = (type: string, init: MouseEventInit = {}) => mouse(type, init)


describe('SC-11: clicking a tab activates it', () => {
  test('a click on an inactive tab activates it by ID', async () => {
    const view = await mount()
    await click(view.q('[data-tab="tab-1"]'))
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-1' }])
  })

  test('a click on the focused group active tab sends nothing', async () => {
    const view = await mount()
    await click(view.q('[data-tab="tab-2"]'))
    expect(callsTo(view.fake, 'activateTab')).toEqual([])
  })

  test('the daemon answer replaces what is drawn, and only its panes are mounted', async () => {
    const daemon = fakeDaemon(conceptualWorkspace(), {
      transforms: { activateTab: (ws) => ({ ...ws, root: { ...(ws.root as any), first: { ...(ws.root as any).first, activeTab: 'tab-1' } } }) }
    })
    const view = await mount(daemon)
    await click(view.q('[data-tab="tab-1"]'))
    expect(view.q('[data-tab="tab-1"] [role="tab"]')!.getAttribute('aria-selected')).toBe('true')
    expect(view.q('[data-pane="pane-1"]')).not.toBeNull()
    expect(view.q('[data-pane="pane-3"]')).toBeNull()
  })

  test('selecting a hidden tab scrolls it into view', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const tab = this as HTMLElement
      const viewport = tab.closest<HTMLElement>('.qt-tabs')
      if (!viewport) return
      const tabRect = tab.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      if (tabRect.left < viewportRect.left) viewport.scrollLeft = Math.max(0, viewport.scrollLeft + tabRect.left - viewportRect.left)
      else if (tabRect.right > viewportRect.right) viewport.scrollLeft = Math.min(maxScroll, viewport.scrollLeft + tabRect.right - viewportRect.right)
    })
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3), { activeTab: 'tab-3' }))))
      const layout = installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      expect(layout.visible('tab-3')).toBe(true)
      await click(view.q('[data-tab="tab-1"]'))
      expect(layout.visible('tab-1')).toBe(true)
      await click(view.q('[data-tab="tab-3"]'))
      expect(layout.visible('tab-3')).toBe(true)
      expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-1' }, { tab: 'tab-3' }])
    } finally {
      scroll.mockRestore()
      resize.restore()
    }
  })

  test('scroll controls reveal hidden tabs without activating them and disable at boundaries', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(4)))))
      const layout = installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100, 'tab-4': 100 })
      await flushResize(resize)
      const left = view.q<HTMLButtonElement>('[aria-label="Scroll tabs left"]')!
      const right = view.q<HTMLButtonElement>('[aria-label="Scroll tabs right"]')!
      expect(left.disabled).toBe(true)
      expect(right.disabled).toBe(false)

      await click(right)
      expect(layout.visible('tab-3')).toBe(true)
      expect(left.disabled).toBe(false)
      await click(right)
      expect(layout.visible('tab-4')).toBe(true)
      expect(right.disabled).toBe(true)
      await click(left)
      expect(layout.visible('tab-2')).toBe(true)
      expect(left.disabled).toBe(false)
      await click(left)
      expect(left.disabled).toBe(true)
      expect(callsTo(view.fake, 'activateTab')).toEqual([])
      expect(view.q('[data-tab="tab-1"] [role="tab"]')!.getAttribute('aria-selected')).toBe('true')
    } finally {
      resize.restore()
    }
  })

  test('scroll controls disappear when resized tabs fit or tabs are removed', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 180, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      expect(view.q('[aria-label="Scroll tabs right"]')).not.toBeNull()

      layout.setWidth(400)
      await flushResize(resize)
      expect(view.q('[aria-label="Scroll tabs left"]')).toBeNull()
      expect(view.q('[aria-label="Scroll tabs right"]')).toBeNull()

      layout.setWidth(180)
      await flushResize(resize)
      expect(view.q('[aria-label="Scroll tabs right"]')).not.toBeNull()
      layout.setTabWidths({ 'tab-1': 50, 'tab-2': 50, 'tab-3': 50 })
      await flushResize(resize)
      expect(view.q('[aria-label="Scroll tabs left"]')).toBeNull()
      expect(view.q('[aria-label="Scroll tabs right"]')).toBeNull()

      layout.setWidth(220)
      layout.setTabWidths({ 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      await click(view.q('[data-tab="tab-3"] [aria-label="Close Terminal 3"]'))
      layout.refresh()
      await flushResize(resize)
      expect(view.qa('[data-tab]')).toHaveLength(2)
      expect(view.q('[aria-label="Scroll tabs left"]')).toBeNull()
      expect(view.q('[aria-label="Scroll tabs right"]')).toBeNull()
    } finally {
      resize.restore()
    }
  })
})

describe('SC-12: closing a tab', () => {
  test('middle-click closes an idle tab without asking', async () => {
    const view = await mount()
    await fire(view.q('[data-tab="tab-1"]'), mouse('auxclick', { button: 1 }))
    expect(callsTo(view.fake, 'describeClose')).toEqual([{ tab: 'tab-1' }])
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
    expect(view.last().dialog).toBeNull()
  })

  test('the close button does the same', async () => {
    const view = await mount()
    await click(view.q('[aria-label="Close Terminal 1"]'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-1', yes: true }])
  })
})

describe('SC-9: renaming a tab', () => {
  async function open(view: MountedWorkspace, tabId = 'tab-1') {
    await fire(view.q(`[data-tab="${tabId}"]`), mouse('dblclick'))
    return view.q<HTMLInputElement>('input[aria-label="Tab title"]')!
  }

  test('double-click opens a field with the current title; Enter sends renameTab', async () => {
    const view = await mount()
    const input = await open(view)
    expect(input.value).toBe('Terminal 1')
    await type(input, 'Build')
    await key(input, 'Enter')
    expect(callsTo(view.fake, 'renameTab')).toEqual([{ tab: 'tab-1', title: 'Build' }])
    expect(view.q('input[aria-label="Tab title"]')).toBeNull()
  })

  test('Escape leaves the title alone', async () => {
    const view = await mount()
    const input = await open(view)
    await type(input, 'Build')
    await key(input, 'Escape')
    expect(callsTo(view.fake, 'renameTab')).toEqual([])
    expect(view.q('[data-tab="tab-1"] .qt-tab-title')!.textContent).toBe('Terminal 1')
  })

  test('an Enter that confirms an IME candidate does not commit', async () => {
    const view = await mount()
    const input = await open(view)
    await type(input, 'ビルド')
    await key(input, 'Enter', { isComposing: true })
    expect(callsTo(view.fake, 'renameTab')).toEqual([])
    expect(view.q('input[aria-label="Tab title"]')).not.toBeNull()
    await key(input, 'Enter', { keyCode: 229 })
    expect(callsTo(view.fake, 'renameTab')).toEqual([])
  })

  test('an empty value clears the custom title', async () => {
    const view = await mount()
    const input = await open(view, 'tab-2')
    await type(input, '')
    await key(input, 'Enter')
    expect(callsTo(view.fake, 'renameTab')).toEqual([{ tab: 'tab-2', title: '' }])
  })

  test('confirming an unchanged title sends nothing', async () => {
    const view = await mount()
    const input = await open(view)
    await key(input, 'Enter')
    expect(callsTo(view.fake, 'renameTab')).toEqual([])
  })

  test('the controller opens the same field for the active tab', async () => {
    const view = await mount()
    await act(async () => view.controller().renameTab())
    expect(view.q<HTMLInputElement>('input[aria-label="Tab title"]')!.value).toBe('Build')
  })
})

describe('SC-18: reordering and moving tabs by dragging', () => {
  test('dropping a tab on the first half of another tab inserts it before', async () => {
    const view = await mount()
    const target = view.q('[data-tab="tab-1"]')!
    setRect(target, { left: 0, top: 0, width: 100, height: 30 })
    await fire(view.q('[data-tab="tab-2"]'), drag('dragstart'))
    await fire(target, drag('dragover', { clientX: 10, clientY: 10 }))
    await fire(target, drag('drop', { clientX: 10, clientY: 10 }))
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-2', group: 'grp-1', index: 0 }])
  })

  test('the second half inserts after, in the order without the dragged tab', async () => {
    const view = await mount()
    const target = view.q('[data-tab="tab-1"]')!
    setRect(target, { left: 0, top: 0, width: 100, height: 30 })
    await fire(view.q('[data-tab="tab-2"]'), drag('dragstart'))
    await fire(target, drag('drop', { clientX: 90, clientY: 10 }))
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-2', group: 'grp-1', index: 1 }])
  })

  test('dropping on another group strip moves the tab to its end', async () => {
    const view = await mount()
    await fire(view.q('[data-tab="tab-1"]'), drag('dragstart'))
    await fire(view.q('[data-group="grp-2"] .qt-strip'), drag('drop'))
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-1', group: 'grp-2', index: 1 }])
  })

  test('a drop with no drag in flight does nothing', async () => {
    const view = await mount()
    await fire(view.q('[data-group="grp-2"] .qt-strip'), drag('drop'))
    expect(callsTo(view.fake, 'moveTab')).toEqual([])
  })
})

describe('SC-46: dropping a tab on a group body', () => {
  const single = () => makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1')), tab('tab-2', pane('pane-2', 's-2'))]))

  async function dropAt(view: MountedWorkspace, x: number, y: number, bodyOf = 'grp-1') {
    const body = view.q(`[data-group-body="${bodyOf}"]`)!
    setRect(body, { left: 0, top: 0, width: 900, height: 600 })
    await fire(view.q('[data-tab="tab-2"]'), drag('dragstart'))
    await fire(body, drag('dragover', { clientX: x, clientY: y }))
    const preview = view.q('[data-zone]')?.getAttribute('data-zone') ?? null
    await fire(body, drag('drop', { clientX: x, clientY: y }))
    return preview
  }

  test('the centre merges into the group', async () => {
    const view = await mount(fakeDaemon(single()))
    expect(await dropAt(view, 450, 300)).toBe('center')
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-2', group: 'grp-1' }])
  })

  test('outside the centre the left and right thirds open a group on that side', async () => {
    const view = await mount(fakeDaemon(single()))
    expect(await dropAt(view, 40, 300)).toBe('left')
    expect(await dropAt(view, 860, 300)).toBe('right')
    expect(callsTo(view.fake, 'moveTab')).toEqual([
      { tab: 'tab-2', split: 'left', of: 'grp-1' },
      { tab: 'tab-2', split: 'right', of: 'grp-1' }
    ])
  })

  test('the middle third opens a group above or below', async () => {
    const view = await mount(fakeDaemon(single()))
    expect(await dropAt(view, 450, 20)).toBe('up')
    expect(await dropAt(view, 450, 580)).toBe('down')
    expect(callsTo(view.fake, 'moveTab').map((call) => call.split)).toEqual(['up', 'down'])
  })

  async function dropInSplit(x: number, y: number) {
    const view = await mount()
    const body = view.q('[data-group-body="grp-1"]')!
    setRect(body, { left: 0, top: 0, width: 900, height: 600 })
    await fire(view.q('[data-tab="tab-1"]'), drag('dragstart'))
    await fire(body, drag('drop', { clientX: x, clientY: y }))
    return callsTo(view.fake, 'moveTab')
  }

  test('inside a split workspace the outer 20% of the width opens a split instead of merging', async () => {
    expect(await dropInSplit(150, 300)).toEqual([{ tab: 'tab-1', split: 'left', of: 'grp-1' }])
  })

  test('inside a split workspace the outer 20% of the height opens one above or below', async () => {
    expect(await dropInSplit(450, 100)).toEqual([{ tab: 'tab-1', split: 'up', of: 'grp-1' }])
  })

  test('the preview covers the half of the body the drop would open', async () => {
    const view = await mount(fakeDaemon(single()))
    const body = view.q('[data-group-body="grp-1"]')!
    setRect(body, { left: 0, top: 0, width: 900, height: 600 })
    await fire(view.q('[data-tab="tab-2"]'), drag('dragstart'))
    await fire(body, drag('dragover', { clientX: 40, clientY: 300 }))
    const zone = view.q<HTMLElement>('[data-zone]')!
    expect([zone.style.left, zone.style.width, zone.style.height]).toEqual(['0px', '50%', '100%'])
    await fire(view.q('[data-tab="tab-2"]'), drag('dragend'))
    expect(view.q('[data-zone]')).toBeNull()
  })
})

describe('SC-45 and SC-48: tab groups', () => {
  test('each group has its own strip, plus button and pane-actions button', async () => {
    const view = await mount()
    expect(view.qa('.qt-strip')).toHaveLength(2)
    expect(view.qa('[aria-label="New tab"]')).toHaveLength(2)
    expect(view.qa('[aria-label="Pane actions"]')).toHaveLength(2)
  })

  test('the strip slot renders what the host supplies for each group', async () => {
    const daemon = fakeDaemon(conceptualWorkspace())
    mounted = await mountFixture(daemon, { view: { stripExtras: (grp: { id: string }) => `extra-${grp.id}` } })
    expect(mounted.qa('.qt-strip').map((strip) => strip.textContent)).toEqual([expect.stringContaining('extra-grp-1'), expect.stringContaining('extra-grp-2')])
  })

  test('Close Split Pane in the actions menu closes the group', async () => {
    const view = await mount()
    await click(view.q('[data-actions="grp-2"]'))
    const items = view.last().menu.items
    expect(view.last().menu).toMatchObject({ kind: 'actions', target: 'grp-2' })
    expect(items.map((item: any) => item.label)).toEqual(['Close Split Pane'])
    await click([...view.element.ownerDocument.querySelectorAll('[role="menuitem"]')].find((el) => el.textContent === 'Close Split Pane')!)
    expect(callsTo(view.fake, 'closeGroup')).toEqual([{ group: 'grp-2' }])
  })

  test('the actions button is disabled when the area is not split', async () => {
    const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'))]))))
    expect(view.q<HTMLButtonElement>('[data-actions="grp-1"]')!.disabled).toBe(true)
  })
})
