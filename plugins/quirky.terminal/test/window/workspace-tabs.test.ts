import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { CONTROL_ICON_MARKUP } from '../../../../packages/ui/src/design-system/icons/generated-controls'
import { TOOL_ICON_MARKUP } from '../../../../packages/ui/src/design-system/icons/generated-tools'
import type { TabIcon, ViewTab } from '../../src/layout/types'
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
  session,
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

const MORE_WIDTH = 64

function installTabLayout(view: MountedWorkspace, width: number, initialWidths: Record<string, number>) {
  const viewport = view.q<HTMLElement>('.qt-tabs')!
  const navigation = viewport.parentElement as HTMLElement
  let available = width
  let widths = initialWidths
  const moreWidth = () => (navigation.querySelector('.qt-tab-more') ? MORE_WIDTH : 0)
  const tabWidth = (item: HTMLElement) => widths[item.dataset.tab!] ?? 100
  const tabItems = () => view.qa<HTMLElement>('.qt-tabs > [data-tab]')
  Object.defineProperty(navigation, 'clientWidth', { configurable: true, get: () => available })
  Object.defineProperty(navigation, 'getBoundingClientRect', { configurable: true, value: () => tabRect(0, available) })
  Object.defineProperty(viewport, 'clientWidth', { configurable: true, get: () => Math.max(0, available - moreWidth()) })
  Object.defineProperty(viewport, 'scrollWidth', { configurable: true, get: () => tabItems().reduce((total, item) => total + tabWidth(item), 0) + (Number.parseFloat(viewport.style.getPropertyValue('--qt-tab-scroll-slack')) || 0) })
  Object.defineProperty(viewport, 'getBoundingClientRect', { configurable: true, value: () => tabRect(0, viewport.clientWidth) })
  const refresh = () => {
    for (const item of tabItems()) {
      Object.defineProperty(item, 'getBoundingClientRect', {
        configurable: true,
        value: () => {
          const items = tabItems()
          const index = items.indexOf(item)
          const left = items.slice(0, index).reduce((total, previous) => total + tabWidth(previous), 0) - viewport.scrollLeft
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

  test('widening until every tab fits removes the more button, even though it took width from the viewport', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).not.toBeNull()
      layout.setWidth(320)
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).toBeNull()
    } finally {
      resize.restore()
    }
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

  test('selecting the last tab can snap its leading edge to the viewport', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const tab = this as HTMLElement
      const viewport = tab.closest<HTMLElement>('.qt-tabs')
      if (!viewport) return
      const left = tab.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      viewport.scrollLeft = Math.min(Math.max(0, left), maxScroll)
    })
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      const last = view.q<HTMLElement>('[data-tab="tab-3"]')!

      await click(last)
      await fire(layout.viewport, new Event('scroll'))

      expect(last.getBoundingClientRect().left).toBe(layout.viewport.getBoundingClientRect().left)
      expect(getComputedStyle(last).visibility).not.toBe('hidden')
      expect(getComputedStyle(view.q('[data-tab="tab-1"]')!).visibility).toBe('hidden')
    } finally {
      scroll.mockRestore()
      resize.restore()
    }
  })

  test('selecting the last tab keeps its preceding tab visible when both fit', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const tab = this as HTMLElement
      const viewport = tab.closest<HTMLElement>('.qt-tabs')
      if (!viewport) return
      const left = tab.getBoundingClientRect().left - viewport.getBoundingClientRect().left + viewport.scrollLeft
      const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth)
      viewport.scrollLeft = Math.min(Math.max(0, left), maxScroll)
    })
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 280, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      const previous = view.q<HTMLElement>('[data-tab="tab-2"]')!
      const last = view.q<HTMLElement>('[data-tab="tab-3"]')!

      await click(last)
      await fire(layout.viewport, new Event('scroll'))

      const viewportRect = layout.viewport.getBoundingClientRect()
      expect(previous.getBoundingClientRect().left).toBe(viewportRect.left)
      expect(last.getBoundingClientRect().right).toBeLessThanOrEqual(viewportRect.right)
      expect(getComputedStyle(previous).visibility).not.toBe('hidden')
      expect(getComputedStyle(last).visibility).not.toBe('hidden')
      expect(getComputedStyle(view.q('[data-tab="tab-1"]')!).visibility).toBe('hidden')
    } finally {
      scroll.mockRestore()
      resize.restore()
    }
  })

  test('the scroll buttons are gone and the strip stays wheel-scrollable', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(4)))))
      installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100, 'tab-4': 100 })
      await flushResize(resize)
      expect(view.q('[aria-label="Scroll tabs left"]')).toBeNull()
      expect(view.q('[aria-label="Scroll tabs right"]')).toBeNull()
      expect(view.q('.qt-tab-scroll')).toBeNull()
    } finally {
      resize.restore()
    }
  })

  test('"N more" appears only while tabs are hidden and counts them', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 400, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).toBeNull()

      layout.setWidth(200)
      await flushResize(resize)
      const more = view.q('.qt-tab-more')!
      expect(more.textContent).toBe('2 more')
      expect(more.nextElementSibling).toBeNull()
      expect(more.parentElement!.nextElementSibling!.getAttribute('data-plus')).toBe('grp-1')

      layout.setWidth(400)
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).toBeNull()

      layout.setWidth(200)
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).not.toBeNull()
      layout.setTabWidths({ 'tab-1': 50, 'tab-2': 50, 'tab-3': 50 })
      await flushResize(resize)
      expect(view.q('.qt-tab-more')).toBeNull()
    } finally {
      resize.restore()
    }
  })

  test('"N more" counts tabs clipped on both sides after the strip scrolls', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(4)))))
      const layout = installTabLayout(view, 200, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100, 'tab-4': 100 })
      await flushResize(resize)
      expect(view.q('.qt-tab-more')!.textContent).toBe('3 more')
      layout.viewport.scrollLeft = 244
      await fire(layout.viewport, new Event('scroll'))
      expect(view.q('.qt-tab-more')!.textContent).toBe('4 more')
      layout.viewport.scrollLeft = 100
      await fire(layout.viewport, new Event('scroll'))
      expect(view.q('.qt-tab-more')!.textContent).toBe('3 more')
    } finally {
      resize.restore()
    }
  })

  test('offers a clipped leading icon through the more menu when most of its tab remains visible', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const tab = this as HTMLElement
      const viewport = tab.closest<HTMLElement>('.qt-tabs')
      if (!viewport) return
      const tabRect = tab.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      if (tabRect.left < viewportRect.left) viewport.scrollLeft += tabRect.left - viewportRect.left
      else if (tabRect.right > viewportRect.right) viewport.scrollLeft += tabRect.right - viewportRect.right
    })
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(2), { activeTab: 'tab-1' }))))
      const layout = installTabLayout(view, 250, { 'tab-1': 140, 'tab-2': 140 })
      await flushResize(resize)
      const first = view.q<HTMLElement>('[data-tab="tab-1"]')!
      const second = view.q<HTMLElement>('[data-tab="tab-2"]')!
      const originalVisibility = getComputedStyle(first).visibility
      layout.viewport.scrollLeft = 30
      await fire(layout.viewport, new Event('scroll'))

      const firstRect = first.getBoundingClientRect()
      const viewportRect = layout.viewport.getBoundingClientRect()
      expect(firstRect.left).toBeLessThan(viewportRect.left)
      expect(firstRect.right - viewportRect.left).toBeGreaterThan(firstRect.width / 2)
      expect(view.q('.qt-tab-more')).not.toBeNull()
      expect(getComputedStyle(first).visibility).toBe('hidden')

      await click(view.q('.qt-tab-more'))
      const rows = [...document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')]
      expect(rows).toHaveLength(2)
      expect(rows[0]!.textContent).toContain('Terminal 1')
      expect(rows[1]!.textContent).toContain('Terminal 2')
      await click(rows[1]!)
      expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-2' }])
      expect(second.querySelector('[role="tab"]')!.getAttribute('aria-selected')).toBe('true')

      await flushResize(resize)
      expect(second.getBoundingClientRect().left).toBeGreaterThanOrEqual(layout.viewport.getBoundingClientRect().left)
      expect(second.getBoundingClientRect().right).toBeLessThanOrEqual(layout.viewport.getBoundingClientRect().right)
      expect(getComputedStyle(second).visibility).toBe(originalVisibility)
    } finally {
      scroll.mockRestore()
      resize.restore()
    }
  })

  test('hides a close-only left fragment and restores it when scrolled into view', async () => {
    const resize = observeResize()
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(3)))))
      const layout = installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100 })
      await flushResize(resize)
      const first = view.q<HTMLElement>('[data-tab="tab-1"]')!
      const close = view.q<HTMLButtonElement>('[data-tab="tab-1"] .qt-tab-close')!
      const originalVisibility = getComputedStyle(first).visibility
      const originalCloseVisibility = getComputedStyle(close).visibility
      const scrollWidth = layout.viewport.scrollWidth

      layout.viewport.scrollLeft = 80
      await fire(layout.viewport, new Event('scroll'))

      expect(first.getBoundingClientRect().right - layout.viewport.getBoundingClientRect().left).toBe(20)
      expect(first.getBoundingClientRect().width).toBe(100)
      expect(layout.viewport.scrollWidth).toBe(scrollWidth)
      expect(getComputedStyle(first).visibility).toBe('hidden')
      expect(getComputedStyle(close).visibility).toBe('hidden')

      layout.viewport.scrollLeft = 0
      await fire(layout.viewport, new Event('scroll'))

      expect(getComputedStyle(first).visibility).toBe(originalVisibility)
      expect(getComputedStyle(close).visibility).toBe(originalCloseVisibility)
    } finally {
      resize.restore()
    }
  })

  test('the popup lists exactly the hidden tabs, and picking one activates it and scrolls it into view', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (this: Element) {
      const tab = this as HTMLElement
      const viewport = tab.closest<HTMLElement>('.qt-tabs')
      if (!viewport) return
      const tabRect = tab.getBoundingClientRect()
      const viewportRect = viewport.getBoundingClientRect()
      if (tabRect.right > viewportRect.right) viewport.scrollLeft += tabRect.right - viewportRect.right
    })
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(4)))))
      const layout = installTabLayout(view, 200, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100, 'tab-4': 100 })
      await flushResize(resize)
      await click(view.q('.qt-tab-more'))
      const rows = [...document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')]
      expect(rows.map((row) => row.textContent)).toEqual(['Terminal 2', 'Terminal 3', 'Terminal 4'])
      expect(rows.every((row) => row.querySelector('svg.ui-tool-icon') !== null)).toBe(true)

      await click(rows[2]!)
      expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-4' }])
      await flushResize(resize)
      expect(layout.visible('tab-4')).toBe(true)
      expect(view.q('.qt-tab-more')!.textContent).toBe('3 more')
      expect(document.querySelector('.ui-popup')).toBeNull()
    } finally {
      scroll.mockRestore()
      resize.restore()
    }
  })

  test('picking an already-selected hidden tab still scrolls it into view', async () => {
    const resize = observeResize()
    const scroll = spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function () {})
    try {
      const view = await mount(fakeDaemon(makeWorkspace(group('grp-1', terminalTabs(4), { activeTab: 'tab-4' }))))
      installTabLayout(view, 220, { 'tab-1': 100, 'tab-2': 100, 'tab-3': 100, 'tab-4': 100 })
      await flushResize(resize)
      scroll.mockClear()
      await click(view.q('.qt-tab-more'))
      const row = [...document.querySelectorAll<HTMLElement>('.ui-popup [role="menuitem"]')].find((candidate) => candidate.textContent?.includes('Terminal 4'))!
      await click(row)
      expect(scroll.mock.contexts.some((target) => (target as HTMLElement).dataset?.tab === 'tab-4')).toBe(true)
    } finally {
      scroll.mockRestore()
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

function viewTab(id: string, title: string, icon?: TabIcon): ViewTab {
  return { kind: 'view', id, viewId: 'view:test/page', key: id, title, color: 'none', pinned: false, preview: false, createdAt: '2026-10-26T00:00:00.000Z', ...(icon ? { icon } : {}) }
}

const markupOf = (markup: string) => {
  const probe = document.createElement('div')
  probe.innerHTML = `<svg>${markup}</svg>`
  return probe.firstElementChild!.innerHTML
}

describe('tab icons', () => {
  const tabIcons = (view: MountedWorkspace, id: string) => [...view.q(`[data-tab="${id}"]`)!.children].filter((child) => child.localName === 'svg')

  async function mountMixed(sessions = [session('s-1')]) {
    const tabs = [
      tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' }),
      viewTab('view-tool', 'Diff', { kind: 'tool', name: 'git-diff', hue: 'azure' }),
      viewTab('view-file', 'App.tsx', { kind: 'file', path: 'src/App.tsx' }),
      viewTab('view-control', 'Browser', { kind: 'control', name: 'globe' }),
      viewTab('view-bare', 'Plain')
    ]
    return mount(fakeDaemon(makeWorkspace(group('grp-1', tabs)), { sessions }))
  }

  test('a view tab draws the icon for its kind', async () => {
    const view = await mountMixed()
    const tool = tabIcons(view, 'view-tool')
    expect(tool).toHaveLength(1)
    expect(tool[0]!.getAttribute('class')).toContain('ui-tool-icon')
    expect(tool[0]!.innerHTML).toBe(markupOf(TOOL_ICON_MARKUP['git-diff']))
    expect((tool[0] as unknown as HTMLElement).style.color).toBe('var(--ui-hue-azure)')

    const file = tabIcons(view, 'view-file')
    expect(file).toHaveLength(1)
    expect(file[0]!.getAttribute('class')).toContain('ui-file-icon')
    expect(file[0]!.getAttribute('data-icon')).toBeTruthy()

    const control = tabIcons(view, 'view-control')
    expect(control).toHaveLength(1)
    expect(control[0]!.getAttribute('class')).toContain('ui-control-icon')
    expect(control[0]!.innerHTML).toBe(markupOf(CONTROL_ICON_MARKUP.globe))
  })

  test('a view tab with no icon draws none and still renders its title', async () => {
    const view = await mountMixed()
    expect(tabIcons(view, 'view-bare')).toHaveLength(0)
    expect(view.q('[data-tab="view-bare"] .qt-tab-title')!.textContent).toBe('Plain')
  })

  test('a terminal tab draws the terminal icon and keeps its status glyph', async () => {
    const view = await mountMixed()
    const icons = tabIcons(view, 'tab-1')
    expect(icons[0]!.innerHTML).toBe(markupOf(TOOL_ICON_MARKUP['terminal-window']))
    expect((icons[0] as unknown as HTMLElement).style.color).toBe('var(--ui-hue-cyan)')
    expect(view.q('[data-tab="tab-1"] .qt-dot, [data-tab="tab-1"] .glyph')).not.toBeNull()
  })

  test('a terminal tab whose lead session runs an agent draws the robot and keeps its status glyph', async () => {
    const view = await mountMixed([session('s-1', { agent: 'claude' })])
    const icons = tabIcons(view, 'tab-1')
    expect(icons[0]!.innerHTML).toBe(markupOf(TOOL_ICON_MARKUP.robot))
    expect((icons[0] as unknown as HTMLElement).style.color).toBe('var(--ui-hue-lilac)')
    expect(view.q('[data-tab="tab-1"] .qt-dot, [data-tab="tab-1"] .glyph')).not.toBeNull()
  })
})

describe('tab strip stylesheet', () => {
  const css = readFileSync(new URL('../../../../packages/ui/src/design-system/terminal-workspace.css', import.meta.url), 'utf8')
  const rule = (selector: string) => {
    const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1]!.split(',').map((part) => part.trim()).includes(selector))
    if (found.length === 0) throw new Error(`no rule for ${selector}`)
    return found.map((match) => match[2]).join(' ')
  }


  test('the selected tab draws its accent underline in every group', () => {
    expect(rule('.qt-tab.qt-selected')).toMatch(/box-shadow:[^;]*var\(--ui-accent\)/)
    expect(css).not.toMatch(/\.qt-tab\.qt-focused/)
  })

  test('a drop indicator stays visible on a selected tab', () => {
    expect(rule('.qt-tab.qt-selected.qt-drop-before')).toMatch(/inset calc\(var\(--ui-border-width\) \* 2\) 0 0 var\(--ui-accent\)/)
  })

  test('close is transparent until the tab is selected, hovered or has focus inside', () => {
    expect(rule('.qt-tab .qt-tab-close')).toMatch(/opacity:\s*0/)
    const reveal = [...css.matchAll(/([^{}]+)\{[^{}]*opacity:\s*1[^{}]*\}/g)].map((match) => match[1]!)
    const selectors = reveal.flatMap((entry) => entry.split(',').map((part) => part.trim()))
    expect(selectors).toEqual(expect.arrayContaining(['.qt-tab.qt-selected .qt-tab-close', '.qt-tab:hover .qt-tab-close', '.qt-tab:focus-within .qt-tab-close']))
    expect(rule('.qt-tab .qt-tab-close')).not.toMatch(/display:\s*none/)
  })

  test('the strip and the surfaces on cards use the card color, not the frame color', () => {
    expect(rule('.qt-strip')).toMatch(/background:\s*var\(--ui-surface\)/)
    expect(css).not.toMatch(/background:\s*var\(--ui-rail\)/)
  })

  test('the tab scroller hides its scrollbar and keeps wheel scrolling', () => {
    expect(rule('.qt-tabs')).toMatch(/overflow-x:\s*auto/)
    expect(rule('.qt-tabs')).toMatch(/scrollbar-width:\s*none/)
  })
})
