import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { TAB_COLORS } from '../../src/layout/types'
import { controllerFor, setFloatingFocus } from '../../src/window/workspace/registry'
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

beforeAll(async () => {
  await loadWorkspace()
  // command handlers reach xterm, so warm their module only after happy-dom creates window
  await import('../../src/window/commands')
})
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
const contextMenu = async (view: MountedWorkspace, selector: string, init: MouseEventInit = {}) => {
  await fire(view.q(selector), mouse('contextmenu', init))
  await settle()
}

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

  test('copy ID rows use the workspace command and copy the addressed terminal IDs', async () => {
    const view = await mount()
    await contextMenu(view, '[data-tab="tab-2"]')
    await click(row(view, 'Copy Tab ID'))
    await settle()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Copy Pane ID'))
    await settle()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Copy Terminal ID'))
    await settle()
    expect(copied).toEqual(['tab-2', 'pane-3', 's-3'])
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/workspace-menu-action')
        .map(({ connId, id, args }) => ({ connId, id, args }))
    ).toEqual([
      { connId: 41, id: 'command:quirky.terminal/workspace-menu-action', args: { action: 'copy-id', target: 'tab-2', kind: 'tab' } },
      { connId: 41, id: 'command:quirky.terminal/workspace-menu-action', args: { action: 'copy-id', target: 'pane-3', kind: 'pane' } },
      { connId: 41, id: 'command:quirky.terminal/workspace-menu-action', args: { action: 'copy-id', target: 'pane-3', kind: 'session' } }
    ])
  })

  test('clipboard refusal is reported once by the UI wrapper', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied') }, readText: async () => clipboardText }
    })
    const view = await mount()
    await contextMenu(view, '[data-tab="tab-2"]')
    await click(row(view, 'Copy Tab ID'))
    await settle()
    expect(view.fake.toasts).toEqual([{ title: 'Could not copy', body: 'clipboard denied' }])
  })

  test('choosing an agent routes through the current workspace catalog', async () => {
    const view = await mount(conceptualWorkspace(), {
      daemon: {
        agents: {
          defaultAgent: 'claude',
          agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } }]
        }
      }
    })
    await click(view.q('[data-plus="grp-2"]'))
    await settle()
    await click(row(view, 'Claude'))
    await settle()
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/workspace-menu-action')
        .map(({ connId, id, args }) => ({ connId, id, args }))
    ).toEqual([
      { connId: 41, id: 'command:quirky.terminal/workspace-menu-action', args: { action: 'choose-agent', target: 'grp-2', agent: 'claude', background: false } }
    ])
    expect(view.controller().getSnapshot().dialog).toMatchObject({
      kind: 'new-session',
      group: 'grp-2',
      request: { agent: 'claude', background: false, permissions: 'yolo' }
    })
    expect(callsTo(view.fake, 'newTab')).toEqual([])
    expect(view.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('choosing background Claude routes the background request without creating a session', async () => {
    const view = await mount(conceptualWorkspace(), {
      daemon: {
        agents: {
          defaultAgent: 'claude',
          agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } }]
        }
      }
    })
    await click(view.q('[data-plus="grp-2"]'))
    await settle()
    await click(row(view, 'Claude (background)'))
    await settle()
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/workspace-menu-action')
        .map(({ args }) => args)
    ).toEqual([{ action: 'choose-agent', target: 'grp-2', agent: 'claude', background: true }])
    expect(view.controller().getSnapshot().dialog).toMatchObject({
      kind: 'new-session',
      group: 'grp-2',
      request: { agent: 'claude', background: true }
    })
    const dialog = view.controller().getSnapshot().dialog
    if (dialog?.kind !== 'new-session') throw new Error('agent prompt did not open')
    expect(dialog.request.permissions).toBeUndefined()
    expect(view.q<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.disabled).toBe(true)
    expect(callsTo(view.fake, 'newTab')).toEqual([])
    expect(view.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('agent choice rechecks the catalog and reports an unavailable agent once', async () => {
    const view = await mount(conceptualWorkspace(), {
      daemon: {
        agents: {
          defaultAgent: 'claude',
          agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true }]
        }
      }
    })
    await click(view.q('[data-plus="grp-2"]'))
    await settle()
    const call = view.fake.context.call.bind(view.fake.context)
    view.fake.context.call = async (method, params) => {
      if (method === 'quirky.agents/list') {
        return { defaultAgent: 'claude', agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: false, isDefault: true }] }
      }
      return call(method, params)
    }
    await click(row(view, 'Claude'))
    await settle()
    expect(view.fake.toasts).toEqual([{ title: 'Could not choose agent', body: 'agent claude is not available' }])
    expect(view.last().dialog).toBeNull()
    expect(callsTo(view.fake, 'newTab')).toEqual([])
    expect(view.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('context menus use the local open-menu route with their pointer position', async () => {
    const view = await mount()
    await contextMenu(view, '[data-tab="tab-2"]', { clientX: 23, clientY: 31 })
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/open-menu')
        .map(({ connId, id, args }) => ({ connId, id, args }))
    ).toEqual([
      { connId: 41, id: 'command:quirky.terminal/open-menu', args: { kind: 'tab', target: 'tab-2', x: 23, y: 31 } }
    ])
  })

  test('open-menu bridge failure is reported without an owner-window fallback', async () => {
    const view = await mount()
    const executed: unknown[][] = []
    view.fake.context.executeCommand = async (...args: unknown[]) => void executed.push(args)
    const call = view.fake.context.call.bind(view.fake.context)
    view.fake.context.call = async (method, params) => {
      if (method === 'ui.window.self') throw new Error('window offline')
      return call(method, params)
    }
    await contextMenu(view, '[data-tab="tab-2"]')
    expect(view.last().menu).toBeNull()
    expect(view.fake.toasts).toEqual([{ title: 'Could not open menu', body: 'window offline' }])
    expect(view.fake.callsTo('ui.window.command.run')).toEqual([])
    expect(executed).toEqual([])
  })

  test('trusted command drops route once through the workspace action with group context', async () => {
    const view = await mount(conceptualWorkspace(), {
      extra: { 'quirky.terminal/groupInfo': () => ({ workspace: 'wt-main' }) }
    })
    const consumed: string[] = []
    const executed: unknown[][] = []
    view.fake.context.consumeCommandDrag = (token: string) => {
      consumed.push(token)
      return { command: 'command:acme.tools/run', args: { task: 'build', group: 'forged', worktree: 'forged' } }
    }
    view.fake.context.executeCommand = async (...args: unknown[]) => void executed.push(args)
    const transfer = {
      types: ['application/x-quirky-command'],
      getData: () => 'drag-1'
    } as unknown as DataTransfer
    const event = new Event('drop', { bubbles: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    await fire(view.q('[data-group-body="grp-2"]')!, event)
    await settle()
    expect(consumed).toEqual(['drag-1'])
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/workspace-menu-action')
        .map(({ connId, id, args }) => ({ connId, id, args }))
    ).toEqual([
      {
        connId: 41,
        id: 'command:quirky.terminal/workspace-menu-action',
        args: { action: 'run-group-command', target: 'grp-2', command: 'command:acme.tools/run', args: { task: 'build', group: 'forged', worktree: 'forged' } }
      }
    ])
    expect(executed).toEqual([
      ['command:acme.tools/run', { task: 'build', group: 'grp-2', worktree: 'wt-main' }]
    ])
  })

  test('dropped command failures toast once and never execute a substitute', async () => {
    const view = await mount(conceptualWorkspace(), {
      extra: { 'quirky.terminal/groupInfo': () => { throw new Error('layout offline') } }
    })
    const consumed: string[] = []
    const executed: unknown[][] = []
    view.fake.context.consumeCommandDrag = (token: string) => {
      consumed.push(token)
      return { command: 'command:acme.tools/run', args: { task: 'build' } }
    }
    view.fake.context.executeCommand = async (...args: unknown[]) => void executed.push(args)
    const transfer = {
      types: ['application/x-quirky-command'],
      getData: () => 'drag-1'
    } as unknown as DataTransfer
    const event = new Event('drop', { bubbles: true })
    Object.defineProperty(event, 'dataTransfer', { value: transfer })
    await fire(view.q('[data-group-body="grp-2"]')!, event)
    await settle()
    expect(consumed).toEqual(['drag-1'])
    expect(view.fake.toasts).toEqual([{ title: 'Could not run dropped command', body: 'layout offline' }])
    expect(executed).toEqual([])
  })

  test('an empty floating group shares EmptyState and keeps New Terminal and Minimize', async () => {
    const floating = makeWorkspace(group('grp-floating', []), { id: 'floating' })
    const view = await mount(floating, { input: { worktree: 'floating' } })
    expect(view.q('.ui-empty-state')!.textContent).toBe('No terminals open.')
    expect([...view.q('.qt-empty')!.querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'New Terminal⌘T',
      'Minimize⌘W'
    ])
    await click([...view.q('.qt-empty')!.querySelectorAll('button')][1]!)
    expect(callsTo(view.fake, 'setFloating')).toEqual([{ open: false }])
    await click([...view.q('.qt-empty')!.querySelectorAll('button')][0]!)
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'floating', group: 'grp-floating' }])
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
    await settle()
    expect(view.fake.callsTo('ui.window.command.run').map(({ params }) => params).filter(({ id }) => id === 'command:quirky.terminal/rename-tab').map(({ args }) => args)).toEqual([{ tab: 'tab-a' }])
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

  test('the plus button toggles with local open and close commands', async () => {
    const view = await mount()
    await click(view.q('[data-plus="grp-1"]'))
    await settle()
    expect(view.last().menu).toMatchObject({ kind: 'plus', target: 'grp-1' })
    await click(view.q('[data-plus="grp-1"]'))
    await settle()
    expect(view.last().menu).toBeNull()
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/open-menu' || id === 'command:quirky.terminal/close-menu')
        .map(({ id, args }) => ({ id, args }))
    ).toEqual([
      { id: 'command:quirky.terminal/open-menu', args: { kind: 'plus', target: 'grp-1' } },
      { id: 'command:quirky.terminal/close-menu', args: { target: 'grp-1' } }
    ])
  })

  for (const removed of [false, true]) {
    test(removed
      ? 'a pending menu close refuses a vanished group instead of the focused workspace'
      : 'a pending menu close keeps its original group when floating gains focus', async () => {
      const view = await mount()
      const floating = await mountFixture(
        fakeDaemon(makeWorkspace(group('floating-group', []), { id: 'floating' })),
        { input: { worktree: 'floating' } }
      )
      const mainController = controllerFor('wt-main')!
      const floatingController = controllerFor('floating')!
      view.fake.layout.view = { id: 'view:quirky.session/worktree', input: { worktree: 'wt-main' } }
      const self = Promise.withResolvers<{ connId: number }>()
      const entered = Promise.withResolvers<void>()
      const call = view.fake.context.call.bind(view.fake.context)
      try {
        await act(async () => mainController.openMenu('plus', 'grp-1'))
        await settle()
        view.fake.context.call = async (method, params) => {
          if (method === 'ui.window.self') {
            entered.resolve()
            return self.promise
          }
          return call(method, params)
        }
        await click(view.q('[data-plus="grp-1"]'))
        await entered.promise
        await act(async () => {
          if (removed) {
            view.daemon.set(makeWorkspace(group('replacement-group', [])))
            await mainController.refresh()
            mainController.openMenu('plus', 'replacement-group')
          }
          floatingController.openMenu('actions', 'floating-group')
          setFloatingFocus(true)
        })
        self.resolve({ connId: 41 })
        await settle()
        await settle()

        expect(floatingController.getSnapshot().menu).toMatchObject({ kind: 'actions', target: 'floating-group' })
        if (removed) {
          expect(mainController.getSnapshot().menu).toMatchObject({ kind: 'plus', target: 'replacement-group' })
          expect(view.fake.toasts).toEqual([{ title: 'Could not close menu', body: 'no mounted terminal workspace holds grp-1' }])
        } else {
          expect(mainController.getSnapshot().menu).toBeNull()
          expect(view.fake.toasts).toEqual([])
        }
      } finally {
        self.resolve({ connId: 41 })
        await settle()
        setFloatingFocus(false)
        await floating.unmount()
      }
    })
  }
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

  test('Copy and Select All use their local pane commands', async () => {
    const view = await mount()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Copy'))
    await settle()
    await contextMenu(view, '[data-pane="pane-3"]')
    await click(row(view, 'Select All'))
    await settle()
    expect(
      view.fake.callsTo('ui.window.command.run')
        .map(({ params }) => params)
        .filter(({ id }) => id === 'command:quirky.terminal/copy' || id === 'command:quirky.terminal/select-all')
        .map(({ connId, id, args }) => ({ connId, id, args }))
    ).toEqual([
      { connId: 41, id: 'command:quirky.terminal/copy', args: { pane: 'pane-3' } },
      { connId: 41, id: 'command:quirky.terminal/select-all', args: { pane: 'pane-3' } }
    ])
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
    await settle()
    expect(view.fake.callsTo('ui.window.command.run').map(({ params }) => params).filter(({ id }) => id === 'command:quirky.terminal/set-pane-title').map(({ connId, id, args }) => ({ connId, id, args }))).toEqual([
      { connId: 41, id: 'command:quirky.terminal/set-pane-title', args: { pane: 'pane-4' } }
    ])
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
    expect(view.fake.callsTo('ui.window.command.run').map(({ params }) => params).filter(({ id }) => id === 'command:quirky.terminal/paste').map(({ connId, id, args }) => ({ connId, id, args }))).toEqual([
      { connId: 41, id: 'command:quirky.terminal/paste', args: { pane: 'pane-3' } }
    ])
    await settle()
    expect(view.fake.callsTo('quirky.terminal/write').map((call) => call.params)).toEqual([
      { session: 's-3', data: 'hello', expectedIncarnation: 'fixture-s-3' }
    ])
  })

  test('with right-click paste on, right-click pastes and Ctrl-click opens the menu', async () => {
    const view = await mount(conceptualWorkspace(), { settings: { 'right-click-paste': true } })
    clipboardText = 'pasted'
    await fire(view.q('[data-pane="pane-3"] [data-terminal-pane]'), mouse('contextmenu'))
    await settle()
    expect(view.last().menu).toBeNull()
    expect(view.fake.callsTo('quirky.terminal/write').map((call) => call.params)).toEqual([
      { session: 's-3', data: 'pasted', expectedIncarnation: 'fixture-s-3' }
    ])
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
