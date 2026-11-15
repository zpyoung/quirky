import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { UiMenuItemEntry } from '@quirky/protocol'
import {
  click,
  conceptualWorkspace,
  fakeContext,
  fakeDaemon,
  fire,
  installWindowCommands,
  loadWorkspace,
  mouse,
  session,
  settle,
  startRecording,
  stopRecording,
  type,
  unloadWorkspace
} from './workspace-support'

const VIEW = 'view:quirky.session/worktree'

let ui: typeof import('../../src/ui')
let open: { unmount(): Promise<void> }[] = []

beforeAll(async () => {
  await loadWorkspace()
  ui = await import('../../src/ui')
})
afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  for (const view of open.splice(0)) await view.unmount()
  stopRecording()
  document.body.innerHTML = ''
})

const HANDOFF: UiMenuItemEntry = {
  id: 'menu-item:quirky.handoff/handoff',
  plugin: 'quirky.handoff',
  menu: 'quirky.terminal/pane',
  title: 'Hand Off to Another Agent',
  command: 'command:quirky.handoff/open',
  when: { agent: 'any' },
  after: 'quick-commands'
}
const FORK_AGENT: UiMenuItemEntry = {
  id: 'menu-item:quirky.terminal/fork-agent-session',
  plugin: 'quirky.terminal',
  menu: 'quirky.terminal/pane',
  title: 'Fork Agent Session',
  command: 'command:quirky.terminal/fork-agent-session',
  when: { agent: 'any' },
  after: 'quick-commands'
}
const TAB_ACME: UiMenuItemEntry = {
  id: 'menu-item:acme.tools/new',
  plugin: 'acme.tools',
  menu: 'quirky.terminal/tab',
  title: 'Acme New',
  command: 'command:acme.tools/new',
  after: 'quick-commands'
}
const TAB_BETA: UiMenuItemEntry = {
  id: 'menu-item:beta.tools/new',
  plugin: 'beta.tools',
  menu: 'quirky.terminal/tab',
  title: 'Beta New',
  command: 'command:beta.tools/new',
  after: 'quick-commands'
}
type TestReport = { menu: { items: { label: string; separator: boolean }[] } | null }

/** Activates the plugin on a fake daemon whose pane-3 session runs claude and mounts the worktree view. */
async function mount(menuItems: UiMenuItemEntry[], agentKind: 'terminal' | 'structured' = 'terminal') {
  const sessions = ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) =>
    session(id, id === 's-3' ? { agent: 'claude', kind: agentKind } : {})
  )
  const daemon = fakeDaemon(conceptualWorkspace(), { sessions })
  const fake = fakeContext({
    ...daemon.handlers,
    'quirky.terminal/quickCommands': () => ({ commands: [] }),
    'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
    'quirky.session/get': ({ session: id }) => {
      const current = daemon.sessions.find((entry) => entry.id === id)
      if (!current) throw new Error(`session ${String(id)} not found`)
      return current
    },
    'ui.contributions': () => ({ menuItems, keybindings: [] })
  })
  const executed: { id: string; args: unknown }[] = []
  fake.context.executeCommand = async (id, args) => void executed.push({ id, args })
  installWindowCommands(fake)
  ui.activate(fake.context)
  fake.layout.worktree = 'wt-main'
  fake.layout.view = { id: VIEW, input: { worktree: 'wt-main' } }
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: TestReport[] = []
  let unmountView: (() => void) | void = undefined
  await act(async () => {
    unmountView = fake.provided.get(VIEW)!(element, { input: { worktree: 'wt-main' }, report: (state: unknown) => void reports.push(state as TestReport) }) as () => void
  })
  await settle()
  await settle()
  const view = {
    fake,
    daemon,
    executed,
    element,
    last: () => reports.at(-1)!,
    unmount: async () => {
      await act(async () => void (unmountView as (() => void) | undefined)?.())
      await settle()
    }
  }
  open.push(view)
  return view
}

type Mounted = Awaited<ReturnType<typeof mount>>

const openPaneMenu = async (view: Mounted, pane: string) => {
  await fire(view.element.querySelector(`[data-pane="${pane}"]`), mouse('contextmenu'))
}
const labels = (view: Mounted): string[] => view.last().menu!.items.map((item) => (item.separator ? '---' : item.label))
const row = (view: Mounted, label: string) =>
  [...view.element.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')?.textContent === label) ?? null

describe('SC-1: agent panes offer the handoff, shell panes do not', () => {
  test('an agent pane shows the contributed row directly below Quick Commands', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-3')
    const rows = labels(view)
    const quick = rows.indexOf('Quick Commands')
    expect(rows[quick + 1]).toBe('Hand Off to Another Agent')
    expect(rows[quick + 2]).toBe('---')
  })

  test('a shell pane does not', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-4')
    expect(labels(view)).not.toContain('Hand Off to Another Agent')
  })

  test('choosing the row dispatches its contribution ID locally and runs the current item with the pane session', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-3')
    view.fake.calls.splice(0)
    await click(row(view, 'Hand Off to Another Agent'))
    expect(view.fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      { connId: 41, id: 'command:quirky.terminal/run-menu-item', args: { item: HANDOFF.id, session: 's-3' } }
    ])
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(1)
    expect(view.fake.callsTo('quirky.session/get').map((call) => call.params)).toEqual([{ session: 's-3' }])
    expect(view.executed).toEqual([{ id: 'command:quirky.handoff/open', args: { session: 's-3' } }])
  })
  test('an item without a condition shows on a shell pane too', async () => {
    const { when: _when, ...always } = HANDOFF
    const view = await mount([always])
    await openPaneMenu(view, 'pane-4')
    expect(labels(view)).toContain('Hand Off to Another Agent')
  })

  test('items for another menu are not listed', async () => {
    const view = await mount([{ ...HANDOFF, menu: 'quirky.terminal/tab' as never }])
    await openPaneMenu(view, 'pane-3')
    expect(labels(view)).not.toContain('Hand Off to Another Agent')
  })

  test('with no contributions the menu keeps its rows and order', async () => {
    const view = await mount([])
    await openPaneMenu(view, 'pane-3')
    expect(labels(view).slice(0, 7)).toEqual(['Copy', 'Select All', 'Paste', 'Quick Commands', '---', 'Split Terminal Right', 'Split Terminal Down'])
  })

  test('a plugin change brings in items declared after the window started', async () => {
    const items: UiMenuItemEntry[] = []
    const view = await mount(items)
    items.push(HANDOFF)
    await view.fake.emit({ type: 'plugin.changed' })
    await settle()
    await openPaneMenu(view, 'pane-3')
    expect(labels(view)).toContain('Hand Off to Another Agent')
  })
})

describe('the controller option', () => {
  test('paneMenuContributions rows follow the Quick Commands row and see the pane and its session', async () => {
    const { mountFixture } = await import('./workspace-support')
    const seen: unknown[] = []
    const daemon = fakeDaemon(conceptualWorkspace(), { sessions: [session('s-3', { agent: 'claude' })] })
    const mounted = await mountFixture(daemon, {
      view: {
        paneMenuContributions: (pane: { id: string }, found: { id: string } | undefined) => {
          seen.push([pane.id, found?.id])
          return [{ label: 'Extra', onSelect: () => void 0 }]
        }
      }
    })
    await fire(mounted.q('[data-pane="pane-3"]'), mouse('contextmenu'))
    const rows = mounted.last().menu.items.map((item: any) => (item.separator ? '---' : item.label))
    expect(rows.slice(3, 6)).toEqual(['Quick Commands', 'Extra', '---'])
    expect(seen).toContainEqual(['pane-3', 's-3'])
    await mounted.unmount()
  })
})
describe('pane Fork command', () => {
  test('the pane menu hides Fork on shells and passes the exact agent session ID', async () => {
    const view = await mount([FORK_AGENT])
    await openPaneMenu(view, 'pane-4')
    expect(labels(view)).not.toContain('Fork Agent Session')
    await openPaneMenu(view, 'pane-3')
    expect(labels(view)).toContain('Fork Agent Session')
    await click(row(view, 'Fork Agent Session'))
    expect(view.executed).toEqual([{ id: 'command:quirky.terminal/fork-agent-session', args: { session: 's-3' } }])
  })

  test('the scriptable command forks the provider session returned by exact source-session inspection', async () => {
    const source = session('s-3', {
      agent: 'claude',
      providerSession: { id: 'claude-provider-3', transcriptPath: '/tmp/claude-3.jsonl' }
    })
    const forked = session('s-forked', { agent: 'claude', providerSession: null, resumedFrom: 's-3' })
    const fake = fakeContext({
      'quirky.session/get': ({ session: id }) => (id === source.id ? source : session('wrong-session', { agent: 'claude' })),
      'quirky.session/resume': (params) => {
        expect(params).toEqual({ session: 's-3', fork: true })
        return forked
      },
      'quirky.terminal/openSession': () => ({ workspace: { id: 'wt-main' }, pane: 'pane-forked' })
    })
    const executed: { id: string; args: unknown }[] = []
    fake.context.executeCommand = async (id, args) => void executed.push({ id, args })
    installWindowCommands(fake)
    ui.activate(fake.context)
    fake.provided.set('command:quirky.terminal/focus-pane', async () => ({ ok: true }))
    const command = fake.provided.get('command:quirky.terminal/fork-agent-session')!

    await command({ session: source.id })

    expect(fake.calls.filter((call) => call.method === 'quirky.session/get')).toEqual([
      { method: 'quirky.session/get', params: { session: 's-3' } }
    ])
    expect(fake.calls.filter((call) => call.method === 'quirky.session/resume')).toEqual([
      { method: 'quirky.session/resume', params: { session: 's-3', fork: true } }
    ])
    expect(fake.calls.filter((call) => call.method === 'quirky.terminal/openSession')).toEqual([
      { method: 'quirky.terminal/openSession', params: { session: 's-forked', workspace: 'wt-main' } }
    ])
    expect(fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      { connId: 41, id: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-forked', workspace: 'wt-main' } }
    ])
    expect(executed).toEqual([])

    fake.provided.set('command:quirky.terminal/focus-pane', async () => ({ ok: false, reason: 'focus refused' }))
    await expect(command({ session: source.id })).rejects.toThrow('focus refused')
    expect(fake.calls.filter((call) => call.method === 'quirky.session/resume')).toHaveLength(2)
    expect(fake.calls.filter((call) => call.method === 'quirky.terminal/openSession')).toHaveLength(2)
    expect(fake.callsTo('ui.window.command.run')).toHaveLength(2)
  })

  test('shell, structured and stale pane IDs refuse without resuming or opening a replacement session', async () => {
    const shell = session('s-shell')
    const structured = session('s-structured', { kind: 'structured', agent: 'claude' })
    const wrong = session('s-other', { agent: 'claude', providerSession: { id: 'other-provider', transcriptPath: null } })
    const fake = fakeContext({
      'quirky.session/get': ({ session: id }) => (id === 's-shell' ? shell : id === 's-structured' ? structured : wrong)
    })
    const executed: { id: string; args: unknown }[] = []
    fake.context.executeCommand = async (id, args) => void executed.push({ id, args })
    installWindowCommands(fake)
    ui.activate(fake.context)
    const command = fake.provided.get('command:quirky.terminal/fork-agent-session')!

    await expect(command({ session: 's-shell' })).rejects.toThrow('shell')
    await expect(command({ session: 'stale-session-id' })).rejects.toThrow('exact')
    await expect(command({ session: 's-structured' })).rejects.toThrow('not a terminal agent session')
    expect(fake.calls.filter((call) => call.method === 'quirky.session/resume')).toEqual([])
    expect(executed).toEqual([])
  })
})
describe('public menu contribution commands', () => {
  test('tab rows keep IDs, placement, ordering and the exact destination through MENU', async () => {
    const view = await mount([TAB_BETA, TAB_ACME])
    await click(view.element.querySelector('[data-plus="grp-2"]'))
    const search = view.element.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Search open tabs and agents…"]')
    if (search === null) throw new Error('the plus menu search is missing')
    await type(search, 'New')
    view.fake.calls.splice(0)
    const rows = view.last().menu!.items.map((item) => item.label)
    expect(rows.indexOf('Acme New')).toBeLessThan(rows.indexOf('Beta New'))
    await click(row(view, 'Acme New'))

    expect(view.fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      {
        connId: 41,
        id: 'command:quirky.terminal/run-menu-item',
        args: { item: TAB_ACME.id, worktree: 'wt-main', workspace: 'wt-main', group: 'grp-2' }
      }
    ])
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(1)
    expect(view.executed).toEqual([
      { id: TAB_ACME.command, args: { worktree: 'wt-main', workspace: 'wt-main', group: 'grp-2' } }
    ])

    const handler = view.fake.provided.get('command:quirky.terminal/run-menu-item')!
    expect(await handler({ item: TAB_ACME.id, worktree: 'wt-main', workspace: 'wt-main', group: 'grp-2' })).toEqual({ ok: true })
    expect(view.fake.callsTo('ui.contributions')).toHaveLength(2)
    expect(view.executed).toHaveLength(2)
    expect(view.executed[1]).toEqual({ id: TAB_ACME.command, args: { worktree: 'wt-main', workspace: 'wt-main', group: 'grp-2' } })
  })

  test('a removed row refuses instead of running its rendered command and toasts its title', async () => {
    const items = [HANDOFF]
    const view = await mount(items)
    await openPaneMenu(view, 'pane-3')
    items.splice(0)

    await click(row(view, HANDOFF.title))

    expect(view.executed).toEqual([])
    expect(view.fake.toasts).toEqual([{ title: HANDOFF.title, body: `no menu item ${HANDOFF.id}` }])
  })

  test('a rendered contribution ID runs the current command, not its stale snapshot command', async () => {
    const items = [HANDOFF]
    const view = await mount(items)
    await openPaneMenu(view, 'pane-3')
    items[0] = { ...HANDOFF, command: 'command:acme.tools/new-target' }

    await click(row(view, HANDOFF.title))

    expect(view.executed).toEqual([{ id: 'command:acme.tools/new-target', args: { session: 's-3' } }])
  })

  test('agent-only rows refuse if their current session has become a shell', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-3')
    const current = view.daemon.sessions.find((entry) => entry.id === 's-3')!
    current.agent = 'shell'

    await click(row(view, HANDOFF.title))

    expect(view.executed).toEqual([])
    expect(view.fake.toasts).toEqual([
      { title: HANDOFF.title, body: `menu item ${HANDOFF.id} requires an agent session` }
    ])
  })

  test('direct MENU calls validate required context and reject caller-supplied commands', async () => {
    const view = await mount([HANDOFF, TAB_ACME])
    const handler = view.fake.provided.get('command:quirky.terminal/run-menu-item')!

    expect(await handler({})).toEqual({ ok: false, reason: 'item is required' })
    expect(await handler(null)).toEqual({ ok: false, reason: 'invalid run-menu-item arguments' })
    expect(await handler({ item: HANDOFF.id, command: 'command:forged/run', session: 's-3' })).toEqual({
      ok: false,
      reason: 'invalid run-menu-item arguments'
    })
    expect(await handler({ item: HANDOFF.id })).toEqual({
      ok: false,
      reason: 'session is required for pane menu items'
    })
    expect(await handler({ item: TAB_ACME.id, worktree: 'wt-main', workspace: 'wt-main' })).toEqual({
      ok: false,
      reason: 'worktree, workspace and group are required for tab menu items'
    })
    expect(await handler({ item: 'menu-item:missing/entry' })).toEqual({
      ok: false,
      reason: 'no menu item menu-item:missing/entry'
    })
    expect(view.executed).toEqual([])
  })

  test('direct MENU calls reject unsupported items and return read or dispatch failures', async () => {
    const unsupported = { ...TAB_ACME, id: 'menu-item:acme.tools/unsupported', menu: 'other/menu' } as unknown as UiMenuItemEntry
    const view = await mount([unsupported, HANDOFF])
    const handler = view.fake.provided.get('command:quirky.terminal/run-menu-item')!
    expect(await handler({ item: unsupported.id })).toEqual({
      ok: false,
      reason: `menu item ${unsupported.id} is not a terminal menu item`
    })

    const call = view.fake.context.call.bind(view.fake.context)
    view.fake.context.call = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'ui.contributions') throw new Error('registry offline')
      return call(method, params)
    }) as typeof view.fake.context.call
    expect(await handler({ item: HANDOFF.id, session: 's-3' })).toEqual({ ok: false, reason: 'registry offline' })

    view.fake.context.call = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'quirky.session/get') throw new Error('session offline')
      return call(method, params)
    }) as typeof view.fake.context.call
    expect(await handler({ item: HANDOFF.id, session: 's-3' })).toEqual({ ok: false, reason: 'session offline' })

    view.fake.context.call = call
    view.fake.context.executeCommand = async () => {
      throw new Error('provider offline')
    }
    expect(await handler({ item: HANDOFF.id, session: 's-3' })).toEqual({ ok: false, reason: 'provider offline' })
  })

  test('a rejected contribution dispatch is toasted once with the row title', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-3')
    view.fake.context.executeCommand = async (id, args) => {
      view.executed.push({ id, args })
      throw new Error('provider offline')
    }

    await click(row(view, HANDOFF.title))

    expect(view.fake.toasts).toEqual([{ title: HANDOFF.title, body: 'provider offline' }])
  })
})

describe('structured agent menu contributions', () => {
  test('agent-only rows remain available for structured sessions', async () => {
    const view = await mount([HANDOFF], 'structured')
    await openPaneMenu(view, 'pane-3')
    expect(labels(view)).toContain(HANDOFF.title)

    await click(row(view, HANDOFF.title))

    expect(view.executed).toEqual([{ id: HANDOFF.command, args: { session: 's-3' } }])
  })
})
