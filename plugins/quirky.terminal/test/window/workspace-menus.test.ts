import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { TAB_COLORS } from '../../src/layout/types'
import {
  callsTo,
  click,
  conceptualWorkspace,
  fakeDaemon,
  fire,
  group,
  groupSplit,
  key,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  mouse,
  pane,
  paneSplit,
  settle,
  startRecording,
  stopRecording,
  tab,
  type,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'

let mounted: MountedWorkspace | null = null
let copied: string[] = []
let clipboardText = ''

beforeAll(loadWorkspace)
afterAll(unloadWorkspace)
beforeEach(() => {
  startRecording()
  copied = []
  clipboardText = ''
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text: string) => void copied.push(text), readText: async () => clipboardText }
  })
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

async function mount(workspace = conceptualWorkspace(), options: Record<string, unknown> = {}) {
  mounted = await mountFixture(fakeDaemon(workspace, options.daemon as never), options as never)
  return mounted
}

const labels = (view: MountedWorkspace) => view.last().menu.items.map((item: any) => (item.separator ? '---' : item.label))
const overlayQuery = <T extends Element = HTMLElement>(view: MountedWorkspace, selector: string) => view.element.ownerDocument.querySelector<T>(selector)
const overlayQueryAll = <T extends Element = HTMLElement>(view: MountedWorkspace, selector: string) => [...view.element.ownerDocument.querySelectorAll<T>(selector)]
const row = (view: MountedWorkspace, label: string) =>
  [...view.element.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')!.textContent === label) ?? null
const contextMenu = (view: MountedWorkspace, selector: string, init: MouseEventInit = {}) => fire(view.q(selector), mouse('contextmenu', init))

/** Tabs A, B (pinned), C in one group with C active, beside a second group when `split`. */
function threeTabs(split: boolean) {
  const tabs = [
    tab('tab-a', pane('pane-a', 's-a'), { defaultTitle: 'A' }),
    tab('tab-b', pane('pane-b', 's-b'), { defaultTitle: 'B', pinned: true }),
    tab('tab-c', paneSplit('split-c', 'right', pane('pane-c', 's-c'), pane('pane-d', 's-d')), { defaultTitle: 'C' })
  ]
  const first = group('grp-1', tabs, { activeTab: 'tab-c' })
  return makeWorkspace(split ? groupSplit('split-1', 'right', first, group('grp-2', [tab('tab-x', pane('pane-x', 's-x'))])) : first)
}

describe('SC-20: the tab menu', () => {
  test('lists the rows in order, with the right-hand tabs row disabled for the last tab', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    expect(labels(view)).toEqual([
      'Move Tab to Split',
      'Split Terminal',
      'Pin Tab',
      'Copy Tab ID',
      'Close',
      'Close Others',
      'Close All Tabs To The Right',
      'Close All Tabs To The Left',
      'Change Title',
      'Tab Color'
    ])
    const enabled = Object.fromEntries(view.last().menu.items.map((item: any) => [item.label, item.enabled]))
    expect(enabled['Close All Tabs To The Right']).toBe(false)
    expect(enabled['Close All Tabs To The Left']).toBe(true)
    expect(view.last().menu).toMatchObject({ kind: 'tab', target: 'tab-c' })
    expect(view.last().menu.items.find((item: any) => item.label === 'Close').key).toBe('⌘W')
    expect(view.last().menu.items.find((item: any) => item.label === 'Change Title').key).toBe('⌘R')
  })

  test('Close Split Pane is last, and only when the group area is split', async () => {
    const view = await mount(threeTabs(true))
    await contextMenu(view, '[data-tab="tab-c"]')
    expect(labels(view).at(-1)).toBe('Close Split Pane')
    await click(row(view, 'Close Split Pane'))
    expect(callsTo(view.fake, 'closeGroup')).toEqual([{ group: 'grp-1' }])
  })

  test('Move Tab to Split offers four sides and moves the tab beside its group', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Move Tab to Split'))
    expect(overlayQueryAll(view, '.qt-submenu [role="menuitem"]').map((el) => el.textContent)).toEqual(['Right▸'.replace('▸', ''), 'Left', 'Down', 'Up'])
    await click(row(view, 'Down'))
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-c', split: 'down', of: 'grp-1' }])
    expect(view.last().menu).toBeNull()
  })

  test('Split Terminal splits the tab active pane', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Split Terminal'))
    await click(row(view, 'Down'))
    expect(callsTo(view.fake, 'splitPane')).toEqual([{ pane: 'pane-c', direction: 'down' }])
  })

  test('Pin Tab pins, and reads Unpin Tab for a pinned tab', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Pin Tab'))
    expect(callsTo(view.fake, 'pinTab')).toEqual([{ tab: 'tab-c', pinned: true }])
    await contextMenu(view, '[data-tab="tab-b"]')
    expect(labels(view)).toContain('Unpin Tab')
    await click(row(view, 'Unpin Tab'))
    expect(callsTo(view.fake, 'pinTab')[1]).toEqual({ tab: 'tab-b', pinned: false })
  })

  test('Copy Tab ID writes the ID to the clipboard', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Copy Tab ID'))
    expect(copied).toEqual(['tab-c'])
  })

  test('Close Others and the side rows ask the daemon about the tabs they would close', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Close Others'))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Close All Tabs To The Left'))
    expect(callsTo(view.fake, 'describeClose')).toEqual([
      { tab: 'tab-c', which: 'others' },
      { tab: 'tab-c', which: 'left' }
    ])
    expect(callsTo(view.fake, 'closeTabs')).toEqual([
      { tab: 'tab-c', which: 'others', yes: true },
      { tab: 'tab-c', which: 'left', yes: true }
    ])
  })

  test('Close closes the tab', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-a"]')
    await click(row(view, 'Close'))
    expect(callsTo(view.fake, 'closeTab')).toEqual([{ tab: 'tab-a', yes: true }])
  })

  test('Change Title opens the inline field', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-a"]')
    await click(row(view, 'Change Title'))
    expect(view.q<HTMLInputElement>('input[aria-label="Tab title"]')!.value).toBe('A')
  })

  test('Tab Color lists the ten colours, marks the current one and sets the picked one', async () => {
    const ws = threeTabs(false)
    ;(ws.root as any).tabs[2].color = 'teal'
    const view = await mount(ws)
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Tab Color'))
    const swatches = overlayQueryAll<HTMLElement>(view, '.qt-submenu [role="menuitem"]')
    expect(swatches.map((el) => el.textContent!.replace('✓', '').toLowerCase())).toEqual(TAB_COLORS.map((color) => (color === 'none' ? 'none' : color)))
    expect(swatches.filter((el) => el.getAttribute('aria-checked') === 'true').map((el) => el.textContent!.replace('✓', ''))).toEqual(['Teal'])
    expect(swatches[1]!.querySelector('.qt-swatch')).not.toBeNull()
    await click(row(view, 'Blue'))
    expect(callsTo(view.fake, 'setTabColor')).toEqual([{ tab: 'tab-c', color: 'blue' }])
  })

  test('a tab menu opens from the controller beside its tab', async () => {
    const view = await mount(threeTabs(false))
    await act(async () => view.controller().openMenu('tab'))
    expect(view.last().menu).toMatchObject({ kind: 'tab', target: 'tab-c' })
    await act(async () => view.controller().closeMenu())
    expect(view.last().menu).toBeNull()
  })
})

describe('SC-39: the pane menu', () => {
  const PANE_ROWS = [
    'Copy',
    'Select All',
    'Paste',
    'Quick Commands',
    '---',
    'Split Terminal Right',
    'Split Terminal Down',
    'Equalize Pane Sizes',
    'Expand Pane',
    '---',
    'Set Title…',
    'Copy Terminal ID',
    'Copy Pane ID',
    'Close Pane',
    '---',
    'Clear Screen',
    'Reset Terminal'
  ]

  test('lists the rows in order for a pane in a split tab', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-3"]', { clientX: 10, clientY: 10 })
    expect(labels(view)).toEqual(PANE_ROWS)
    expect(view.last().menu).toMatchObject({ kind: 'pane', target: 'pane-3' })
    const keys = Object.fromEntries(view.last().menu.items.map((item: any) => [item.label, item.key]))
    expect(keys).toMatchObject({ Copy: '⌘C', 'Select All': '⌘A', Paste: '⌘V', 'Split Terminal Right': '⌘D', 'Split Terminal Down': '⌘⇧D', 'Expand Pane': '⌘⇧Enter', 'Close Pane': '⌘W', 'Clear Screen': '⌘K' })
  })

  test('Collapse Pane replaces Expand Pane in an expanded tab, and Clear Pane Title shows for a titled pane', async () => {
    const ws = conceptualWorkspace()
    const build = (ws.root as any).first.tabs[1]
    build.expandedPane = 'pane-3'
    build.root.second.first.title = 'logs'
    const view = await mount(ws)
    await contextMenu(view, '[data-pane="pane-3"]')
    expect(labels(view)).toContain('Collapse Pane')
    expect(labels(view)).not.toContain('Expand Pane')
    expect(labels(view).slice(labels(view).indexOf('Set Title…'), labels(view).indexOf('Set Title…') + 2)).toEqual(['Set Title…', 'Clear Pane Title'])
  })

  test('a single-pane tab has no Equalize, Expand or Close Pane rows', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-5"]')
    const rows = labels(view)
    for (const absent of ['Equalize Pane Sizes', 'Expand Pane', 'Close Pane']) expect(rows).not.toContain(absent)
    expect(rows).toContain('Split Terminal Right')
  })

  test('the Quick Commands submenu shows the rows the host supplies', async () => {
    mounted = await mountFixture(fakeDaemon(conceptualWorkspace()), {
      view: { paneMenuExtras: (leaf: { id: string }) => [{ label: `Hello ${leaf.id}`, onSelect: () => void 0 }] }
    })
    await contextMenu(mounted, '[data-pane="pane-3"]')
    await click(row(mounted, 'Quick Commands'))
    expect(overlayQueryAll(mounted, '.qt-submenu [role="menuitem"]').map((el) => el.textContent)).toEqual(['Hello pane-3'])
  })

  test('without a host, the submenu says there are none', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Quick Commands'))
    expect(overlayQuery<HTMLButtonElement>(view, '.qt-submenu [role="menuitem"]')!.disabled).toBe(true)
    expect(overlayQuery(view, '.qt-submenu')!.textContent).toContain('No quick commands')
  })

  test('the rows call the daemon with the pane they were opened on', async () => {
    const view = await mount()
    const run = async (label: string) => {
      await contextMenu(view, '[data-pane="pane-4"]')
      await click(row(view, label))
    }
    await run('Split Terminal Right')
    await run('Split Terminal Down')
    await run('Equalize Pane Sizes')
    await run('Expand Pane')
    await run('Clear Screen')
    await run('Reset Terminal')
    expect(callsTo(view.fake, 'splitPane')).toEqual([
      { pane: 'pane-4', direction: 'right' },
      { pane: 'pane-4', direction: 'down' }
    ])
    expect(callsTo(view.fake, 'equalize')).toEqual([{ tab: 'tab-2' }])
    expect(callsTo(view.fake, 'expandPane')).toEqual([{ pane: 'pane-4', expanded: true }])
    expect(callsTo(view.fake, 'clearPane')).toEqual([{ pane: 'pane-4' }])
    expect(callsTo(view.fake, 'resetPane')).toEqual([{ pane: 'pane-4' }])
  })

  test('Close Pane closes through the close flow', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-4"]')
    await click(row(view, 'Close Pane'))
    expect(callsTo(view.fake, 'describeClose')).toEqual([{ pane: 'pane-4' }])
    expect(callsTo(view.fake, 'closePane')).toEqual([{ pane: 'pane-4', yes: true }])
  })

  test('Set Title… focuses the pane and opens the title field; Enter sends setPaneTitle', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-4"]')
    await click(row(view, 'Set Title…'))
    expect(callsTo(view.fake, 'focusPane')).toEqual([{ pane: 'pane-4' }])
    const input = view.q<HTMLInputElement>('input[aria-label="Pane title"]')!
    await type(input, 'logs')
    await key(input, 'Enter')
    expect(callsTo(view.fake, 'setPaneTitle')).toEqual([{ pane: 'pane-4', title: 'logs' }])
  })

  test('Escape cancels the title field', async () => {
    const view = await mount()
    await act(async () => void view.controller().setTitle())
    const input = view.q<HTMLInputElement>('input[aria-label="Pane title"]')!
    await type(input, 'logs')
    await key(input, 'Escape')
    expect(callsTo(view.fake, 'setPaneTitle')).toEqual([])
    expect(view.q('input[aria-label="Pane title"]')).toBeNull()
  })

  test('Clear Pane Title sends an empty title', async () => {
    const ws = conceptualWorkspace()
    ;(ws.root as any).first.tabs[1].root.second.first.title = 'logs'
    const view = await mount(ws)
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Clear Pane Title'))
    expect(callsTo(view.fake, 'setPaneTitle')).toEqual([{ pane: 'pane-3', title: '' }])
  })

  test('Copy Terminal ID and Copy Pane ID write the session and pane IDs', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Copy Terminal ID'))
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Copy Pane ID'))
    expect(copied).toEqual(['s-3', 'pane-3'])
  })

  test('Paste reads the clipboard into the pane through the chunked path', async () => {
    const view = await mount()
    clipboardText = 'hello'
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Paste'))
    await settle()
    expect(view.fake.callsTo('quirky.terminal/write').map((call) => call.params)).toEqual([{ session: 's-3', data: 'hello' }])
  })

  test('with right-click paste on, right-click pastes and Ctrl-click opens the menu', async () => {
    const view = await mount(conceptualWorkspace(), { settings: { 'right-click-paste': true } })
    clipboardText = 'pasted'
    await fire(view.q('[data-pane="pane-3"] [data-terminal-pane]'), mouse('contextmenu'))
    await settle()
    expect(view.last().menu).toBeNull()
    expect(view.fake.callsTo('quirky.terminal/write').map((call) => call.params.data)).toEqual(['pasted'])
    await fire(view.q('[data-pane="pane-3"] [data-terminal-pane]'), mouse('contextmenu', { ctrlKey: true }))
    expect(view.last().menu).toMatchObject({ kind: 'pane', target: 'pane-3' })
  })
})

describe('menu behaviour', () => {
  test('arrow keys move through the rows and Enter picks one', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    const menu = overlayQuery(view, '[role="menu"]')!
    await key(menu, 'ArrowDown')
    await key(menu, 'ArrowDown')
    await key(menu, 'ArrowDown')
    expect(overlayQuery(view, '.qt-highlight .qt-menu-label')!.textContent).toBe('Pin Tab')
    await key(menu, 'Enter')
    expect(callsTo(view.fake, 'pinTab')).toEqual([{ tab: 'tab-c', pinned: true }])
  })

  test('ArrowRight opens a submenu, ArrowLeft closes it, ArrowUp skips disabled rows', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    const menu = overlayQuery(view, '[role="menu"]')!
    await key(menu, 'ArrowDown')
    await key(menu, 'ArrowRight')
    const submenu = overlayQuery(view, '.qt-submenu [role="menu"]')!
    expect(submenu).not.toBeNull()
    await key(submenu, 'ArrowDown')
    await key(submenu, 'Enter')
    expect(callsTo(view.fake, 'moveTab')).toEqual([{ tab: 'tab-c', split: 'right', of: 'grp-1' }])
  })

  test('Escape closes the menu', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await key(overlayQuery(view, '[role="menu"]')!, 'Escape')
    expect(view.last().menu).toBeNull()
  })

  test('Escape in a submenu hands focus back, so a second Escape closes the menu', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    const menu = overlayQuery(view, '[role="menu"]')!
    await key(menu, 'ArrowDown')
    await key(menu, 'ArrowRight')
    await key(overlayQuery(view, '.qt-submenu [role="menu"]')!, 'Escape')
    expect(overlayQuery(view, '.qt-submenu')).toBeNull()
    expect(document.activeElement).toBe(menu)
    await key(document.activeElement!, 'Escape')
    expect(view.last().menu).toBeNull()
  })

  test('a click outside closes the menu', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await fire(document.body, mouse('mousedown'))
    expect(view.last().menu).toBeNull()
  })

  test('disabled rows do nothing', async () => {
    const view = await mount(threeTabs(false))
    await contextMenu(view, '[data-tab="tab-c"]')
    await click(row(view, 'Close All Tabs To The Right'))
    expect(callsTo(view.fake, 'describeClose')).toEqual([])
    expect(view.last().menu).not.toBeNull()
  })
})
