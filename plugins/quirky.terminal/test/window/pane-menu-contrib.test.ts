import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { UiMenuItemEntry } from '@quirky/protocol'
import {
  click,
  conceptualWorkspace,
  fakeContext,
  fakeDaemon,
  fire,
  loadWorkspace,
  mouse,
  session,
  settle,
  startRecording,
  stopRecording,
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

/** Activates the plugin over a fake daemon whose pane-3 session runs claude and mounts the worktree view. */
async function mount(menuItems: UiMenuItemEntry[]) {
  const sessions = ['s-1', 's-2', 's-3', 's-4', 's-5'].map((id) => session(id, id === 's-3' ? { agent: 'claude' } : {}))
  const daemon = fakeDaemon(conceptualWorkspace(), { sessions })
  const fake = fakeContext({
    ...daemon.handlers,
    'quirky.terminal/quickCommands': () => ({ commands: [] }),
    'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
    'ui.contributions': () => ({ menuItems })
  })
  const executed: { id: string; args: unknown }[] = []
  fake.context.executeCommand = async (id, args) => void executed.push({ id, args })
  ui.activate(fake.context)
  fake.layout.worktree = 'wt-main'
  fake.layout.view = { id: VIEW, input: { worktree: 'wt-main' } }
  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: any[] = []
  let unmountView: (() => void) | void = undefined
  await act(async () => {
    unmountView = fake.provided.get(VIEW)!(element, { input: { worktree: 'wt-main' }, report: (state: unknown) => void reports.push(state) }) as () => void
  })
  await settle()
  await settle()
  const view = {
    fake,
    executed,
    element,
    last: () => reports.at(-1),
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
const labels = (view: Mounted): string[] => view.last().menu.items.map((item: any) => (item.separator ? '---' : item.label))
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

  test('choosing the row runs the command with the pane session', async () => {
    const view = await mount([HANDOFF])
    await openPaneMenu(view, 'pane-3')
    await click(row(view, 'Hand Off to Another Agent'))
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
    ui.activate(fake.context)
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
    expect(executed).toEqual([{ id: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-forked', workspace: 'wt-main' } }])
  })

  test('shell and stale pane IDs refuse without resuming or opening a replacement session', async () => {
    const shell = session('s-shell')
    const wrong = session('s-other', { agent: 'claude', providerSession: { id: 'other-provider', transcriptPath: null } })
    const fake = fakeContext({ 'quirky.session/get': ({ session: id }) => (id === 's-shell' ? shell : wrong) })
    const executed: { id: string; args: unknown }[] = []
    fake.context.executeCommand = async (id, args) => void executed.push({ id, args })
    ui.activate(fake.context)
    const command = fake.provided.get('command:quirky.terminal/fork-agent-session')!

    await expect(command({ session: 's-shell' })).rejects.toThrow('shell')
    await expect(command({ session: 'stale-session-id' })).rejects.toThrow('exact')
    expect(fake.calls.filter((call) => call.method === 'quirky.session/resume')).toEqual([])
    expect(executed).toEqual([])
  })
})
