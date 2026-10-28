import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { UiMenuItemEntry } from '@quirky/protocol'
import type * as UiModule from '../../src/ui'
import { dropText } from '../../src/window/pane/drop'
import { shellEscapePaths } from '../../src/shell-escape'
import { shellEscapePaths as reexported } from '../../src/open-external'
import {
  callsTo,
  click,
  fakeContext,
  fakeDaemon,
  group,
  key,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  pane,
  settle,
  startRecording,
  stopRecording,
  tab,
  type,
  unloadWorkspace,
  type MountedWorkspace
} from './workspace-support'

let ui: typeof UiModule
const pluginViews: { unmount(): Promise<void> }[] = []
const WORKTREE_VIEW = 'view:quirky.session/worktree'

const TAB_CONTRIBUTION: UiMenuItemEntry = {
  id: 'menu-item:acme.browser/new-tab',
  plugin: 'acme.browser',
  menu: 'quirky.terminal/tab',
  title: 'New Browser Tab',
  command: 'command:acme.browser/newTab'
}
let mounted: MountedWorkspace | null = null

const AGENTS = {
  defaultAgent: 'claude',
  agents: [
    { id: 'goose', label: 'Goose', installed: false, enabled: true, isDefault: false },
    { id: 'codex', label: 'Codex', installed: true, enabled: true, isDefault: false },
    { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true },
    { id: 'amp', label: 'Amp', installed: true, enabled: false, isDefault: false }
  ]
}

beforeAll(async () => {
  await loadWorkspace()
  // The UI imports terminal modules that need the browser fixture initialized first.
  ui = await import('../../src/ui')
})

afterAll(unloadWorkspace)
beforeEach(startRecording)
afterEach(async () => {
  for (const view of pluginViews.splice(0)) await view.unmount()
  await mounted?.unmount()
  mounted = null
  stopRecording()
  document.body.innerHTML = ''
})

/** "Terminal 1" active beside "Build", with Claude and Codex installed. */
async function mount() {
  const ws = makeWorkspace(
    group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' }), tab('tab-2', pane('pane-2', 's-2'), { defaultTitle: 'Build' })], { activeTab: 'tab-1' })
  )
  mounted = await mountFixture(fakeDaemon(ws, { agents: AGENTS }))
  return mounted
}

async function mountWithMenuItems(menuItems: UiMenuItemEntry[]) {
  const ws = makeWorkspace(
    group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' }), tab('tab-2', pane('pane-2', 's-2'), { defaultTitle: 'Build' })], { activeTab: 'tab-1' })
  )
  const daemon = fakeDaemon(ws, { agents: AGENTS })
  const fake = fakeContext({
    ...daemon.handlers,
    'quirky.terminal/quickCommands': () => ({ commands: [] }),
    'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
    'ui.contributions': () => ({ menuItems })
  })
  const reports: unknown[] = []
  const executed: { id: string; args: unknown }[] = []
  fake.context.executeCommand = async (id, args) => {
    executed.push({ id, args })
  }
  ui.activate(fake.context)
  fake.layout.view = { id: WORKTREE_VIEW, input: { worktree: 'wt-main' } }

  const element = document.createElement('div')
  document.body.appendChild(element)
  const reports: unknown[] = []
  let cleanup: (() => void) | void
  await act(async () => {
    cleanup = fake.provided.get(WORKTREE_VIEW)!(element, {
      input: { worktree: 'wt-main' },
      report: (state: unknown) => void reports.push(state)
    }) as () => void
  })
  await settle()
  await settle()

  const view = {
    fake,
    executed,
    element,
    last: () => reports.at(-1),
    unmount: async () => {
      await act(async () => void (cleanup as (() => void) | undefined)?.())
      await settle()
      element.remove()
    }
  }
  pluginViews.push(view)
  return view
}

const contributionRow = (view: { element: HTMLElement }, label: string) =>
  [...view.element.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')?.textContent === label) ?? null

const contributionRows = (view: { element: HTMLElement }) =>
  [...view.element.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.querySelector('.qt-menu-label')?.textContent ?? '')

const open = (view: MountedWorkspace) => click(view.q('[data-plus="grp-1"]'))
const rows = (view: MountedWorkspace) => view.last().menu.items.map((item: any) => item.label)
const row = (view: MountedWorkspace, label: string) =>
  [...view.element.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')!.textContent === label)!
const search = (view: MountedWorkspace) => view.q<HTMLInputElement>('input[aria-label="Search open tabs and agents…"]')!

describe('public tab menu contributions', () => {
  test('shows a contributed row once in the + menu and runs it for that worktree and group', async () => {
    const view = await mountWithMenuItems([TAB_CONTRIBUTION])
    await click(view.element.querySelector('[data-plus="grp-1"]'))
    expect(contributionRows(view).filter((label) => label === 'New Browser Tab')).toHaveLength(1)
    await click(contributionRow(view, 'New Browser Tab'))
    expect(view.executed).toEqual([{
      id: 'command:acme.browser/newTab',
      args: { worktree: 'wt-main', workspace: 'wt-main', group: 'grp-1' }
    }])
  })

  test('plugin changes refresh an already open + menu', async () => {
    const menuItems = [TAB_CONTRIBUTION]
    const view = await mountWithMenuItems(menuItems)
    await click(view.element.querySelector('[data-plus="grp-1"]'))
    expect(contributionRows(view)).toContain('New Browser Tab')

    menuItems.splice(0, 1, { ...TAB_CONTRIBUTION, title: 'Open Browser' })
    await view.fake.emit({ type: 'plugin.changed' })
    await settle()

    expect(contributionRows(view)).toContain('Open Browser')
    expect(contributionRows(view)).not.toContain('New Browser Tab')
  })
})

describe('SC-22: the + menu', () => {
  test('shows the search box, New Terminal with its key, the agent rows and Agent settings', async () => {
    const view = await mount()
    await open(view)
    expect(search(view).placeholder).toBe('Search open tabs and agents…')
    expect(rows(view)).toEqual(['New Terminal', 'Claude', 'Codex', 'Claude (background)', 'Agent settings…'])
    expect(view.last().menu.items[0].key).toBe('⌘T')
    expect(view.last().menu).toMatchObject({ kind: 'plus', target: 'grp-1' })
  })

  test('the plus button toggles the menu', async () => {
    const view = await mount()
    await open(view)
    await open(view)
    expect(view.last().menu).toBeNull()
  })

  test('typing filters the rows and adds matching open tabs', async () => {
    const view = await mount()
    await open(view)
    await type(search(view), 'bu')
    expect(rows(view)).toEqual(['Build'])
    await type(search(view), 'term')
    expect(rows(view)).toEqual(['New Terminal', 'Terminal 1'])
  })

  test('Enter on the open tab activates it', async () => {
    const view = await mount()
    await open(view)
    await type(search(view), 'bu')
    await key(search(view), 'Enter')
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-2' }])
    expect(view.last().menu).toBeNull()
  })

  test('New Terminal opens a tab in that group', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'New Terminal'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main', group: 'grp-1' }])
  })

  test('an agent row asks for an optional prompt and starts the agent tab', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Codex'))
    expect(view.last().dialog).toEqual({ kind: 'new-session', title: 'New Codex session' })
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, ' review the diff ')
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main', group: 'grp-1', agent: 'codex', prompt: 'review the diff' }])
  })

  test('an empty prompt sends none', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Claude'))
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main', group: 'grp-1', agent: 'claude' }])
  })

  test('Claude (background) needs a prompt and starts a session without a terminal', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Claude (background)'))
    expect(view.q<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.disabled).toBe(true)
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'go')
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(view.fake.callsTo('quirky.structured/create').map((call) => call.params)).toEqual([{ worktree: 'wt-main', agent: 'claude', prompt: 'go' }])
  })

  test('Cancel drops the dialog without starting anything', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Codex'))
    await click([...view.element.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((el) => el.textContent === 'Cancel')!)
    expect(view.last().dialog).toBeNull()
    expect(callsTo(view.fake, 'newTab')).toEqual([])
  })

  test('Agent settings opens the agents view', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Agent settings…'))
    expect(view.fake.opened).toEqual([{ id: 'view:quirky.agents/settings', input: undefined }])
  })
})

describe('dropping files', () => {
  test('shellEscapePaths lives in a node-free module and is still exported from open-external', () => {
    expect(reexported).toBe(shellEscapePaths)
  })

  test('dropText types the escaped paths of a drop', () => {
    const data = { files: [{ path: '/tmp/w/api/a b.txt' }, { path: '/tmp/w/api/c.txt' }], getData: () => '' }
    expect(dropText(data)).toBe("'/tmp/w/api/a b.txt' /tmp/w/api/c.txt")
    expect(dropText({ files: [], getData: () => '' })).toBe('')
  })
})
