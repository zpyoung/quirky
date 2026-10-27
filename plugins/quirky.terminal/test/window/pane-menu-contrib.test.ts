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
  [...view.element.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')?.textContent === label) ?? null

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
