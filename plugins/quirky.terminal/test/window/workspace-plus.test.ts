import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { UiMenuItemEntry } from '@quirky/protocol'
import type * as UiModule from '../../src/ui'
import type { ViewReport } from '../../src/window/workspace/controller'
import { dropText } from '../../src/window/pane/drop'
import { shellEscapePaths } from '../../src/shell-escape'
import { shellEscapePaths as reexported } from '../../src/open-external'
import {
  callsTo,
  click,
  fakeContext,
  fakeDaemon,
  group,
  groupSplit,
  key,
  loadWorkspace,
  makeWorkspace,
  mountFixture,
  pane,
  settle,
  session,
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
    { id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } },
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
  const executed: { id: string; args: unknown }[] = []
  fake.context.executeCommand = async (id, args) => {
    executed.push({ id, args })
  }
  ui.activate(fake.context)
  fake.layout.worktree = 'wt-main'
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
  [...view.element.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')?.textContent === label) ?? null

const contributionRows = (view: { element: HTMLElement }) =>
  [...view.element.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.querySelector('.qt-menu-label')?.textContent ?? '')

const open = (view: MountedWorkspace) => click(view.q('[data-plus="grp-1"]'))
const rows = (view: MountedWorkspace) => view.last().menu.items.map((item: any) => item.label)
const row = (view: MountedWorkspace, label: string) =>
  [...view.element.ownerDocument.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.querySelector('.qt-menu-label')!.textContent === label)!
const search = (view: MountedWorkspace) => view.element.ownerDocument.querySelector<HTMLInputElement>('input[aria-label="Search open tabs and agents…"]')!

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

  test('keeps search text literal so one Enter opens the highlighted background agent', async () => {
    const view = await mount()
    await open(view)
    const input = search(view)
    expect(input.getAttribute('autocorrect')).toBe('off')
    expect(input.getAttribute('autocapitalize')).toBe('off')
    expect(input.getAttribute('spellcheck')).toBe('false')

    await type(input, 'backgr')
    expect(input.value).toBe('backgr')
    expect(rows(view)).toEqual(['Claude (background)'])
    await key(input, 'Enter')
    expect(view.last().menu).toBeNull()
    expect(view.last().dialog).toEqual({ kind: 'new-session', title: 'New Claude (background) session' })
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

  test('distinguishes an open tab from an agent with the same name and keeps their actions separate', async () => {
    const ws = makeWorkspace(
      group('grp-1', [
        tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' }),
        tab('tab-2', pane('pane-2', 's-2'), { defaultTitle: 'Claude' })
      ], { activeTab: 'tab-1' })
    )
    mounted = await mountFixture(fakeDaemon(ws, { agents: AGENTS }))
    const view = mounted
    await open(view)
    await type(search(view), 'Claude')

    const matches = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')]
      .filter((el) => el.querySelector('.qt-menu-label')?.textContent === 'Claude')
    expect(matches).toHaveLength(2)
    expect(matches[0]!.textContent!.toLowerCase()).not.toContain('open tab')
    expect(matches[1]!.textContent!.toLowerCase()).toContain('open tab')

    await click(matches[1]!)
    expect(callsTo(view.fake, 'activateTab')).toEqual([{ tab: 'tab-2' }])
    expect(view.last().dialog).toBeNull()

    await open(view)
    await type(search(view), 'Claude')
    await click(row(view, 'Claude'))
    expect(view.last().dialog).toEqual({ kind: 'new-session', title: 'New Claude session' })
    expect(callsTo(view.fake, 'newTab')).toEqual([])
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

  test("the dialog says which permission mode the agent will start in", async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Claude'))
    expect(view.q('[role="dialog"]')!.textContent).toContain('Permissions: Bypass')
    await click([...view.element.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((el) => el.textContent === 'Cancel')!)
    await open(view)
    await click(row(view, 'Codex'))
    expect(view.q('[role="dialog"]')!.textContent).not.toContain('Permissions:')
  })

  test('the Claude background dialog explains that tool approvals appear in Quirky, regardless of Agent settings', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Claude (background)'))

    const dialog = view.q('[role="dialog"]')!
    const notice = dialog.textContent!.toLowerCase()
    expect(notice).toContain('approval')
    expect(notice).toContain('quirky')
    expect(notice).not.toContain('bypass')
    expect(notice).not.toContain('agent settings')

    await click([...dialog.querySelectorAll<HTMLElement>('button')].find((el) => el.textContent === 'Cancel')!)
    expect(callsTo(view.fake, 'quirky.structured/create')).toEqual([])
    expect(callsTo(view.fake, 'newTab')).toEqual([])
  })

  test('an empty prompt sends none', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Claude'))
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(callsTo(view.fake, 'newTab')).toEqual([{ workspace: 'wt-main', group: 'grp-1', agent: 'claude' }])
  })

  test('Claude (background) adopts its returned session as the selected transcript tab in the menu group', async () => {
    const structured = session('s-structured', { kind: 'structured', agent: 'claude', title: 'Claude (background)' })
    const ws = makeWorkspace(
      groupSplit(
        'split-1',
        'right',
        group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' })]),
        group('grp-2', [tab('tab-2', pane('pane-2', 's-2'), { defaultTitle: 'Build' })])
      ),
      { activeGroup: 'grp-1' }
    )
    const daemon = fakeDaemon(ws, { sessions: [session('s-1'), session('s-2')], agents: AGENTS })
    const view = (mounted = await mountFixture(daemon, {
      extra: {
        'quirky.structured/create': () => {
          daemon.sessions.push(structured)
          return structured
        },
        'quirky.terminal/adoptSession': (params) => {
          const groupId = params.group as string
          const root = daemon.workspace.root
          if (root.kind !== 'split' || root.first.kind !== 'group' || root.second.kind !== 'group') throw new Error('expected two groups')
          const target = groupId === root.second.id ? root.second : root.first
          const added = tab('tab-3', pane('pane-3', params.session as string), { defaultTitle: structured.title })
          const updated = group(target.id, [...target.tabs, added], { activeTab: added.id, recent: [added.id, ...target.recent] })
          const nextRoot = groupId === root.second.id ? { ...root, second: updated } : { ...root, first: updated }
          return { workspace: daemon.set({ ...daemon.workspace, root: nextRoot, activeGroup: groupId }) }
        }
      }
    }))
    await click(view.q('[data-plus="grp-2"]'))
    await click(row(view, 'Claude (background)'))
    expect(view.q<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!.disabled).toBe(true)
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'go')
    await click(view.q('[role="dialog"] button[type="submit"]'))

    expect(view.fake.callsTo('quirky.structured/create').map((call) => call.params)).toEqual([{ worktree: 'wt-main', agent: 'claude', prompt: 'go' }])
    expect(callsTo(view.fake, 'adoptSession')).toEqual([{ group: 'grp-2', session: 's-structured' }])
    expect(callsTo(view.fake, 'newTab')).toEqual([])
    expect(view.last().dialog).toBeNull()
    expect(view.last().layout.activeGroup).toBe('grp-2')
    const targetGroup = view.last().layout.root.second
    expect(targetGroup.activeTab).toBe('tab-3')
    expect(view.q('[data-tab="tab-3"] [role="tab"]')?.getAttribute('aria-selected')).toBe('true')
    expect(view.q('[data-tab="tab-3"] .qt-tab-title')?.textContent).toBe('Claude (background)')
    expect(view.last().tabs).toContainEqual({
      session: 's-structured',
      title: 'Claude (background)',
      agent: 'claude',
      status: 'running',
      tab: 'tab-3',
      group: 'grp-2',
      pane: 'pane-3'
    })
    expect(view.q('[data-session="s-structured"] .xterm')).toBeNull()
    expect(view.fake.mountedViews.map((entry) => [entry.viewId, entry.input])).toContainEqual([
      'view:quirky.session/structured',
      { session: 's-structured' }
    ])
  })

  test('a session status received during adoption stays current over the create response', async () => {
    const created = session('s-structured', { kind: 'structured', agent: 'claude', title: 'Claude (background)', status: 'running' })
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' })]))
    const daemon = fakeDaemon(ws, { agents: AGENTS })
    const { promise: adoptionStarted, resolve: announceAdoption } = Promise.withResolvers<void>()
    const { promise: adoption, resolve: resolveAdoption } = Promise.withResolvers<{ workspace: typeof ws }>()
    const view = (mounted = await mountFixture(daemon, {
      extra: {
        'quirky.structured/create': () => {
          daemon.sessions.push(created)
          return created
        },
        'quirky.terminal/adoptSession': () => {
          const root = daemon.workspace.root
          if (root.kind !== 'group') throw new Error('expected one group')
          const added = tab('tab-3', pane('pane-3', created.id), { defaultTitle: created.title })
          const workspace = daemon.set({
            ...daemon.workspace,
            root: group(root.id, [...root.tabs, added], { activeTab: added.id }),
            activeGroup: root.id
          })
          announceAdoption()
          return adoption
        }
      }
    }))
    await open(view)
    await click(row(view, 'Claude (background)'))
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'go')
    await click(view.q('[role="dialog"] button[type="submit"]'))
    await adoptionStarted
    expect(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')?.readOnly).toBe(true)

    const completed = { ...created, status: 'done' as const }
    daemon.sessions.splice(daemon.sessions.findIndex((entry) => entry.id === created.id), 1, completed)
    await view.fake.emit({ type: 'quirky.session/changed', data: { session: completed } })
    resolveAdoption({ workspace: daemon.workspace })
    await settle()
    await settle()

    const report = view.last() as ViewReport
    expect(report.tabs.find((entry) => entry.session === created.id)).toMatchObject({
      agent: 'claude',
      status: 'done',
      group: 'grp-1',
      tab: 'tab-3'
    })
    expect(view.q('[data-tab="tab-3"] [role="tab"]')?.getAttribute('aria-selected')).toBe('true')
  })


  test('retrying a failed adoption opens the started session without creating another', async () => {
    const started = session('s-started', { kind: 'structured', agent: 'claude', title: 'Claude (background)' })
    const duplicate = session('s-duplicate', { kind: 'structured', agent: 'claude', title: 'Claude (background)' })
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' })]))
    const daemon = fakeDaemon(ws, { agents: AGENTS })
    let createCount = 0
    let adoptionCount = 0
    const view = (mounted = await mountFixture(daemon, {
      extra: {
        'quirky.structured/create': () => {
          const created = [started, duplicate][createCount++]
          if (!created) throw new Error('unexpected third session creation')
          daemon.sessions.push(created)
          return created
        },
        'quirky.terminal/adoptSession': (params) => {
          if (adoptionCount++ === 0) throw new Error('temporary adoption failure')
          const root = daemon.workspace.root
          if (root.kind !== 'group') throw new Error('expected one group')
          const sessionId = params.session as string
          const adopted = daemon.sessions.find((entry) => entry.id === sessionId)
          if (!adopted) throw new Error(`unknown session ${sessionId}`)
          const added = tab('tab-3', pane('pane-3', sessionId), { defaultTitle: adopted.title })
          return {
            workspace: daemon.set({
              ...daemon.workspace,
              root: group(root.id, [...root.tabs, added], { activeTab: added.id }),
              activeGroup: root.id
            })
          }
        }
      }
    }))
    await open(view)
    await click(row(view, 'Claude (background)'))
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'go')
    await click(view.q('[role="dialog"] button[type="submit"]'))

    const promptField = view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!
    const retryButton = view.q<HTMLButtonElement>('[role="dialog"] button[type="submit"]')!
    const retrySurface = { readOnly: promptField.readOnly, label: retryButton.textContent?.trim() }
    const failure = view.q('[role="dialog"] [role="alert"]')?.textContent ?? ''
    await click(retryButton)

    expect(view.fake.callsTo('quirky.structured/create')).toHaveLength(1)
    expect(retrySurface.readOnly).toBe(true)
    expect(retrySurface.label).toBe('Open session')
    expect(failure).toContain('already started')
    expect(callsTo(view.fake, 'adoptSession')).toEqual([
      { group: 'grp-1', session: 's-started' },
      { group: 'grp-1', session: 's-started' }
    ])
    expect(view.last().dialog).toBeNull()
    const report = view.last() as ViewReport
    expect(report.tabs.find((entry) => entry.session === started.id)).toMatchObject({
      title: 'Claude (background)',
      agent: 'claude',
      group: 'grp-1',
      tab: 'tab-3'
    })
    expect(view.q('[data-tab="tab-3"] [role="tab"]')?.getAttribute('aria-selected')).toBe('true')
  })
  test('Cancel drops the dialog without starting anything', async () => {
    const view = await mount()
    await open(view)
    await click(row(view, 'Codex'))
    await click([...view.element.querySelectorAll<HTMLElement>('[role="dialog"] button')].find((el) => el.textContent === 'Cancel')!)
    expect(view.last().dialog).toBeNull()
    expect(callsTo(view.fake, 'newTab')).toEqual([])
  })

  test('a failed agent start keeps the dialog open with the error and the typed prompt', async () => {
    const view = await mount()
    view.daemon.fail('newTab', -32603, 'quirky.agents/plan failed')
    await open(view)
    await click(row(view, 'Claude'))
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'fix it')
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(view.q('[role="dialog"] [role="alert"]')?.textContent).toContain('quirky.agents/plan failed')
    expect(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!.value).toBe('fix it')
  })

  test('a failed background start keeps the dialog open with the error', async () => {
    const ws = makeWorkspace(group('grp-1', [tab('tab-1', pane('pane-1', 's-1'), { defaultTitle: 'Terminal 1' })], { activeTab: 'tab-1' }))
    const view = (mounted = await mountFixture(fakeDaemon(ws, { agents: AGENTS }), {
      extra: {
        'quirky.structured/create': () => {
          throw new Error('quirky.agents/plan failed')
        }
      }
    }))
    await open(view)
    await click(row(view, 'Claude (background)'))
    await type(view.q<HTMLTextAreaElement>('[role="dialog"] textarea')!, 'go')
    await click(view.q('[role="dialog"] button[type="submit"]'))
    expect(view.q('[role="dialog"] [role="alert"]')?.textContent).toContain('quirky.agents/plan failed')
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
