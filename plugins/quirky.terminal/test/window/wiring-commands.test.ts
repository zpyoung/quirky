import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { act } from 'react'
import type { UiMenuItemEntry, UiModel } from '@quirky/protocol'
import type { FloatingState, QuickCommand, Workspace } from '../../src/layout/types'
import {
  conceptualWorkspace,
  fakeContext,
  fakeDaemon,
  group,
  installWindowCommands,
  loadWorkspace,
  makeWorkspace,
  pane,
  settle,
  startRecording,
  stopRecording,
  tab,
  terminals,
  unloadWorkspace,
  type FakeContext
} from './workspace-support'

const VIEW = 'view:quirky.session/worktree'
const NO_WORKSPACE = { ok: false, reason: 'no terminal workspace is open' }

let ui: typeof import('../../src/ui')
let registry: typeof import('../../src/window/workspace/registry')
let clipboardText = ''
let copied: string[] = []
let open: Wired[] = []

type Wired = Awaited<ReturnType<typeof wire>>

beforeAll(async () => {
  await loadWorkspace()
  ui = await import('../../src/ui')
  registry = await import('../../src/window/workspace/registry')
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
  for (const wired of open.splice(0)) await wired.unmount()
  registry.setFloatingFocus(false)
  stopRecording()
  document.body.innerHTML = ''
})

const GLOBAL_HELLO: QuickCommand = { id: 'hello', label: 'Hello', kind: 'terminal', agent: null, command: 'echo hi', appendEnter: true, scope: 'global', repo: null }
const REPO_TEST: QuickCommand = { id: 'test', label: 'Test', kind: 'terminal', agent: null, command: 'bun test', appendEnter: false, scope: 'repo', repo: 'repo-1' }

/** Activates the plugin on a fake context over a fake daemon and mounts the worktree view it provides. */
async function wire(options: {
  mount?: boolean
  settings?: Record<string, unknown>
  floating?: Partial<FloatingState>
  commands?: QuickCommand[]
  wake?: () => unknown
  workspace?: Workspace
  agents?: unknown
  menuItems?: UiMenuItemEntry[]
} = {}) {
  const daemon = fakeDaemon(options.workspace ?? conceptualWorkspace(), { agents: options.agents })
  let floating: FloatingState = { enabled: true, open: false, maximized: false, bounds: null, button: null, ...options.floating }
  const fake: FakeContext = fakeContext(
    {
      ...daemon.handlers,
      'quirky.terminal/quickCommands': () => ({ commands: options.commands ?? [GLOBAL_HELLO, REPO_TEST] }),
      'quirky.terminal/runQuickCommand': () => ({}),
      'quirky.terminal/paneOf': (params) => ({ workspace: 'wt-main', tab: 'tab-1', pane: params.pane }),
      'quirky.terminal/focusContext': (params) => ({ workspace: params.workspace ?? null }),
      'quirky.terminal/openSession': () => ({ workspace: daemon.current, pane: 'pane-1' }),
      'quirky.terminal/groupInfo': ({ group }) => ({ workspace: 'wt-main', group }),
      'quirky.session/get': ({ session: id }) => {
        const current = daemon.sessions.find((entry) => entry.id === id)
        if (!current) throw new Error(`session ${String(id)} not found`)
        return current
      },
      'ui.contributions': () => ({ menuItems: options.menuItems ?? [], keybindings: [] }),
      'quirky.worktree/resolve': () => ({ repoId: 'repo-1' }),
      'quirky.worktree/wake': options.wake ?? (() => ({})),
      'quirky.terminal/floating': () => floating,
      'quirky.terminal/setFloating': (params) => {
        floating = { ...floating, ...params }
        return floating
      }
    },
    options.settings
  )
  installWindowCommands(fake)
  ui.activate(fake.context)
  const executed: { id: string; args: unknown }[] = []
  fake.context.executeCommand = async (id, args) => {
    executed.push({ id, args })
    const handler = fake.provided.get(id)
    if (!handler) throw new Error(`command ${id} is not provided`)
    await handler(args)
  }
  const reports: any[] = []
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmountView: (() => void) | void = undefined
  if (options.mount !== false) {
    fake.layout.worktree = 'wt-main'
    fake.layout.view = { id: VIEW, input: { worktree: 'wt-main' } }
    await act(async () => {
      unmountView = fake.provided.get(VIEW)!(element, { input: { worktree: 'wt-main' }, report: (state: unknown) => void reports.push(state) }) as () => void
    })
    await settle()
    await settle()
  }
  return {
    fake,
    executed,
    daemon,
    element,
    reports,
    last: () => reports.at(-1),
    floating: () => floating,
    /** Runs a command the way the window does and returns what its handler returned. */
    run: async (id: string, args?: unknown, prefix = 'quirky.terminal') => {
      const handler = fake.provided.get(`command:${prefix}/${id}`)
      if (!handler) throw new Error(`command ${prefix}/${id} is not provided`)
      let result: unknown
      await act(async () => void (result = await handler(args)))
      await settle()
      return result
    },
    calls: (method: string) => fake.callsTo(`quirky.terminal/${method}`).map((call) => call.params),
    unmount: async () => {
      await act(async () => void (unmountView as (() => void) | undefined)?.())
      await settle()
    }
  }
}

async function track(options?: Parameters<typeof wire>[0]): Promise<Wired> {
  const wired = await wire(options)
  open.push(wired)
  return wired
}


describe('window commands route to the focused workspace', () => {
  test('SC-60: the terminal actions act on the focused pane and answer with JSON', async () => {
    const wired = await track()
    expect(await wired.run('split-right')).toEqual({ ok: true })
    await wired.run('split-down')
    await wired.run('clear')
    await wired.run('reset-terminal')
    await wired.run('toggle-expand-pane')
    await wired.run('equalize')
    expect(wired.calls('splitPane')).toEqual([
      { pane: 'pane-3', direction: 'right' },
      { pane: 'pane-3', direction: 'down' }
    ])
    expect(wired.calls('clearPane')).toEqual([{ pane: 'pane-3' }])
    expect(wired.calls('resetPane')).toEqual([{ pane: 'pane-3' }])
    expect(wired.calls('expandPane')).toEqual([{ pane: 'pane-3', expanded: true }])
    expect(wired.calls('equalize')).toEqual([{ tab: 'tab-2' }])
  })

  test('pane focus, tab switching and reopen reach the daemon', async () => {
    const wired = await track()
    await wired.run('focus-next-pane')
    await wired.run('focus-previous-pane')
    await wired.run('next-tab')
    await wired.run('previous-tab')
    await wired.run('reopen-tab')
    expect(wired.calls('focusPane')).toEqual([
      { tab: 'tab-2', offset: 1 },
      { tab: 'tab-2', offset: -1 }
    ])
    expect(wired.calls('activateTab')).toEqual([
      { workspace: 'wt-main', offset: 1, order: 'position' },
      { workspace: 'wt-main', offset: -1, order: 'position' }
    ])
    expect(wired.calls('reopenTab')).toEqual([{ workspace: 'wt-main' }])
  })

  test('close-pane closes the focused pane and takes an explicit one', async () => {
    const wired = await track()
    await wired.run('close-pane')
    await wired.run('close-pane', { pane: 'pane-2' })
    expect(wired.calls('closePane').map((params) => params.pane)).toEqual(['pane-3', 'pane-2'])
  })

  test('focus-pane from another panel opens the terminal view and focuses, flashes and scrolls the exact pane', async () => {
    const wired = await track()
    const panel = document.createElement('button')
    document.body.appendChild(panel)
    await act(async () => void panel.focus())

    expect(await wired.run('focus-pane', { pane: 'pane-1', workspace: 'wt-main' })).toEqual({ ok: true })
    expect(wired.fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: 'wt-main' } })
    expect(wired.calls('focusPane')).toEqual([{ pane: 'pane-1' }])
    const pane = wired.element.querySelector<HTMLElement>('[data-pane="pane-1"]')!
    expect(pane.querySelector('[data-focus-flash]')).not.toBeNull()
    const term = terminals.find((entry) => pane.contains(entry.element ?? null))
    if (!term) throw new Error('focused pane has no terminal')
    await act(async () => {
      term.write(Array.from({ length: 120 }, (_, line) => `line ${line}\r\n`).join(''))
    })
    const written = Promise.withResolvers<void>()
    term.write('', written.resolve)
    await written.promise
    const bottom = term.buffer.active.baseY
    expect(bottom).toBeGreaterThan(0)
    term.scrollToLine(0)
    expect(term.buffer.active.viewportY).toBe(0)

    await wired.run('focus-pane', { pane: 'pane-1', workspace: 'wt-main' })
    const textarea = term.textarea
    if (!textarea) throw new Error('focused pane terminal has no textarea')
    expect(document.activeElement).toBe(textarea)
    expect(term.buffer.active.viewportY).toBe(term.buffer.active.baseY)
  })

  test('open-session focuses through the result-preserving local command bridge', async () => {
    const wired = await track()
    const executions: { command: string; args: unknown }[] = []
    wired.fake.context.executeCommand = async (command, args) => {
      executions.push({ command, args })
      const handler = wired.fake.provided.get(command)
      if (!handler) throw new Error(`command ${command} is not provided`)
      await handler(args)
    }

    expect(await wired.run('open-session', { session: 's-1', workspace: 'wt-main' })).toEqual({ ok: true })
    expect(wired.calls('openSession')).toEqual([{ session: 's-1', workspace: 'wt-main' }])
    expect(wired.fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      { connId: 41, id: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-1', workspace: 'wt-main' } }
    ])
    expect(executions).toEqual([])
    expect(wired.calls('focusPane')).toEqual([{ pane: 'pane-1' }])
  })

  test('open-session returns focus refusal and toasts bridge transport failures', async () => {
    const refused = await track()
    refused.fake.provided.set('command:quirky.terminal/focus-pane', async () => ({ ok: false, reason: 'not a terminal' }))

    expect(await refused.run('open-session', { session: 's-1' })).toEqual({ ok: false, reason: 'not a terminal' })
    expect(refused.fake.callsTo('ui.window.command.run').map((call) => call.params)).toEqual([
      { connId: 41, id: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-1', workspace: 'wt-main' } }
    ])

    const offline = await track()
    offline.fake.provided.set('command:quirky.terminal/focus-pane', async () => {
      throw new Error('offline')
    })
    expect(await offline.run('open-session', { session: 's-1' })).toEqual({ ok: false, reason: 'offline' })
    expect(offline.fake.toasts).toEqual([{ title: 'Could not open session', body: 'offline' }])
  })

  test('the inline fields and the switcher open: rename-tab, set-pane-title, recent-tab', async () => {
    const wired = await track()
    await wired.run('rename-tab')
    expect(wired.element.querySelector('input[aria-label="Tab title"]')).not.toBeNull()
    await wired.run('set-pane-title')
    expect(wired.element.querySelector('input[aria-label="Pane title"]')).not.toBeNull()
    await wired.run('clear-pane-title')
    expect(wired.calls('setPaneTitle')).toEqual([{ pane: 'pane-3', title: '' }])
    await wired.run('recent-tab')
    expect(wired.last().dialog).toEqual({ kind: 'switch-tabs', title: 'Switch tabs', generation: expect.any(String) })
  })

  test('zoom changes one pane, the focused one unless a pane is named', async () => {
    const wired = await track()
    const size = (id: string) => wired.last().panes.find((entry: any) => entry.pane === id).fontSize
    await wired.run('zoom-in')
    await wired.run('zoom-in', { pane: 'pane-2' })
    await wired.run('zoom-in', { pane: 'pane-2' })
    expect([size('pane-3'), size('pane-2')]).toEqual([15, 16])
    await wired.run('zoom-out', { pane: 'pane-2' })
    await wired.run('zoom-reset')
    expect([size('pane-3'), size('pane-2')]).toEqual([14, 15])
  })

  test('search opens the find box with the query and options, then steps and closes', async () => {
    const wired = await track()
    const search = () => wired.last().panes.find((entry: any) => entry.pane === 'pane-3').search
    expect(await wired.run('search', { query: '19', regex: true })).toEqual({ ok: true })
    expect(search()).toMatchObject({ query: '19', regex: true, caseSensitive: false })
    await wired.run('search', { query: 'abc', caseSensitive: true })
    expect(search()).toMatchObject({ query: 'abc', caseSensitive: true })
    await wired.run('search-next')
    await wired.run('search-previous')
    await wired.run('search-close')
    expect(search()).toBeNull()
  })

  test('search with an empty query clears the query; omitting it keeps the search', async () => {
    const wired = await track()
    const search = () => wired.last().panes.find((entry: any) => entry.pane === 'pane-3').search
    await wired.run('search', { query: 'abc' })
    expect(search()).toMatchObject({ query: 'abc' })
    await wired.run('search', { regex: true })
    expect(search()).toMatchObject({ query: 'abc', regex: true })
    await wired.run('search', { query: '' })
    expect(search()).toMatchObject({ query: '' })
  })

  test('watchQuickCommands keeps the newest refresh when an older one answers last', async () => {
    const { watchQuickCommands } = await import('../../src/window/commands')
    const pending: ((value: unknown) => void)[] = []
    const fake = fakeContext({
      'quirky.terminal/quickCommands': () => new Promise((resolve) => pending.push(resolve)),
      'quirky.worktree/resolve': () => ({ repoId: null })
    })
    const source = watchQuickCommands(fake.context, 'wt')
    await fake.emit({ type: 'quirky.terminal/quickCommands' } as never)
    pending[1]!({ commands: [{ ...GLOBAL_HELLO, id: 'new' }] })
    await settle()
    pending[0]!({ commands: [{ ...GLOBAL_HELLO, id: 'deleted' }] })
    await settle()
    expect(source.commands().map((entry) => entry.id)).toEqual(['new'])
    source.dispose()
  })

  test('copy returns the selected text, select-all selects, paste writes through the chunked path', async () => {
    const wired = await track()
    const term = terminals.find((entry) => wired.element.querySelector('[data-pane="pane-3"]')!.contains(entry.element ?? null))!
    await act(async () => void term.write('hello'))
    await new Promise<void>((resolve) => term.write('', resolve))
    expect(await wired.run('copy')).toEqual({ text: '' })
    await wired.run('select-all')
    const copy = (await wired.run('copy')) as { text: string }
    expect(copy.text.trim()).toBe('hello')
    expect(copied.at(-1)?.trim()).toBe('hello')

    await wired.run('paste', { text: 'abc' })
    await wired.run('paste', { text: 'def', pane: 'pane-2' })
    clipboardText = 'from clipboard'
    await wired.run('paste')
    expect(wired.fake.callsTo('quirky.terminal/write').map((call) => call.params)).toEqual([
      { session: 's-3', data: 'abc', expectedIncarnation: 'fixture-s-3' },
      { session: 's-2', data: 'def', expectedIncarnation: 'fixture-s-2' },
      { session: 's-3', data: 'from clipboard' }
    ])
  })

  test('open-menu and close-menu show the menu in the report', async () => {
    const wired = await track()
    expect(await wired.run('open-menu', { kind: 'pane' })).toEqual({ ok: true })
    expect(wired.last().menu).toMatchObject({ kind: 'pane', target: 'pane-3' })
    expect(wired.last().menu.items.map((item: any) => item.label)).toContain('Split Terminal Right')
    await wired.run('close-menu')
    expect(wired.last().menu).toBeNull()
    await wired.run('open-menu', { kind: 'tab', target: 'tab-1' })
    expect(wired.last().menu).toMatchObject({ kind: 'tab', target: 'tab-1' })
    expect(await wired.run('open-menu', { kind: 'nope' })).toMatchObject({ ok: false })
  })

  test('an explicit pane or tab is found even when it is not focused, and an unknown one is refused', async () => {
    const wired = await track()
    expect(await wired.run('clear', { pane: 'pane-2' })).toEqual({ ok: true })
    expect(wired.calls('clearPane')).toEqual([{ pane: 'pane-2' }])
    expect(await wired.run('clear', { pane: 'pane-99' })).toEqual({ ok: false, reason: 'no mounted terminal workspace holds pane-99' })
    expect(wired.calls('clearPane')).toHaveLength(1)
  })

  test('a command with no workspace mounted answers instead of throwing', async () => {
    const wired = await track({ mount: false })
    for (const id of ['copy', 'select-all', 'paste', 'search', 'split-right', 'close-pane', 'next-tab', 'open-menu', 'toggle-quick-commands', 'zoom-in']) {
      expect(await wired.run(id, id === 'open-menu' ? { kind: 'pane' } : undefined)).toEqual(NO_WORKSPACE)
    }
    expect(wired.fake.calls.filter((call) => call.method.startsWith('quirky.terminal/') && call.method !== 'quirky.terminal/floating')).toEqual([])
  })
})

const quickMenu = () => document.body.querySelector<HTMLElement>('.qc-menu')
const quickRow = (id: string) => quickMenu()?.querySelector<HTMLElement>(`[role="menuitem"][data-command="${id}"]`) ?? null

describe('the quick commands', () => {
  test('SC-51: toggle-quick-commands opens the strip menu (search, actions, + Command), lists it in the report, then closes it', async () => {
    const wired = await track()
    await wired.run('toggle-quick-commands')
    expect(quickMenu()).not.toBeNull()
    expect(quickMenu()!.querySelector<HTMLInputElement>('input[type="search"]')!.placeholder).toBe('Search quick commands...')
    expect(quickRow('test')!.querySelector('[aria-label="Edit Test"]')).not.toBeNull()
    expect(quickRow('hello')!.querySelector('[aria-label="Copy Hello"]')).not.toBeNull()
    expect(quickRow('hello')!.querySelector('[aria-label="Delete Hello"]')).not.toBeNull()
    expect([...quickMenu()!.querySelectorAll('.qc-menu-footer button')].map((el) => el.textContent)).toEqual(['+ Command'])
    expect(wired.last().menu).toEqual({
      kind: 'quick-commands',
      target: 'grp-1',
      items: [
        { label: 'Test', key: null, enabled: true, separator: false },
        { label: 'Hello', key: null, enabled: true, separator: false },
        { label: '+ Command', key: null, enabled: true, separator: false }
      ]
    })
    expect(wired.element.ownerDocument.querySelector('.qt-menu')).toBeNull()
    await wired.run('toggle-quick-commands')
    expect(quickMenu()).toBeNull()
    expect(wired.last().menu).toBeNull()
  })

  test('opening the menu with the chevron shows in the report, and open-menu and close-menu drive the same menu', async () => {
    const wired = await track()
    const chevron = wired.element.querySelector<HTMLElement>('button[aria-label="More quick commands"]')!
    await act(async () => chevron.click())
    await settle()
    expect(wired.executed).toEqual([{
      id: 'command:quirky.terminal/open-menu',
      args: { kind: 'quick-commands', target: 'grp-1' }
    }])
    expect(quickMenu()).not.toBeNull()
    expect(wired.last().menu).toMatchObject({ kind: 'quick-commands', target: 'grp-1' })
    await wired.run('close-menu')
    expect(quickMenu()).toBeNull()
    expect(wired.last().menu).toBeNull()
    expect(await wired.run('open-menu', { kind: 'quick-commands', target: 'grp-1' })).toEqual({ ok: true })
    expect(quickMenu()).not.toBeNull()
    expect(await wired.run('open-menu', { kind: 'pane' })).toEqual({ ok: true })
    expect(quickMenu()).toBeNull()
    expect(wired.last().menu).toMatchObject({ kind: 'pane' })
  })

  test('opening the quick-commands menu on a group that is not there is refused', async () => {
    const wired = await track()
    expect(await wired.run('open-menu', { kind: 'quick-commands', target: 'grp-99' })).toMatchObject({ ok: false })
    expect(quickMenu()).toBeNull()
    expect(wired.last().menu).toBeNull()
  })

  test('a row of that menu runs the command in the active group and closes the menu', async () => {
    const wired = await track()
    await wired.run('toggle-quick-commands')
    await act(async () => quickRow('hello')!.click())
    await settle()
    expect(wired.calls('runQuickCommand')).toEqual([{ id: 'hello', workspace: 'wt-main', group: 'grp-1' }])
    expect(quickMenu()).toBeNull()
    expect(wired.last().menu).toBeNull()
  })

  test('manage-quick-commands opens the panel', async () => {
    const wired = await track()
    const toggles: unknown[][] = []
    wired.fake.context.togglePanel = (...args: unknown[]) => void toggles.push(args)
    expect(await wired.run('manage-quick-commands')).toEqual({ ok: true })
    expect(toggles).toEqual([['panel:quirky.terminal/quick-commands', true]])
  })

  test('the tab strip has the quick-command button for the worktree, and the pane menu lists the commands', async () => {
    const wired = await track()
    expect(wired.element.querySelectorAll('.qc-strip').length).toBeGreaterThan(0)
    expect(wired.fake.callsTo('quirky.worktree/resolve').map((call) => call.params)).toEqual([{ selector: 'id:wt-main' }])
    await wired.run('open-menu', { kind: 'pane' })
    const rows = wired.element.ownerDocument.querySelectorAll('[role="menuitem"]')
    const quick = [...rows].find((el) => el.textContent?.startsWith('Quick Commands'))! as HTMLElement
    await act(async () => quick.click())
    await settle()
    const labels = [...wired.element.ownerDocument.querySelectorAll('.qt-submenu [role="menuitem"]')].map((el) => el.querySelector('.qt-menu-label')!.textContent)
    expect(labels).toEqual(['Test', 'Hello', 'Add Quick Command…'])
  })

  test('the Quick Commands panel mounts', async () => {
    const wired = await track({ mount: false })
    const element = document.createElement('div')
    document.body.appendChild(element)
    let unmount: (() => void) | void = undefined
    await act(async () => {
      unmount = wired.fake.provided.get('panel:quirky.terminal/quick-commands')!(element, { report: () => {} }) as () => void
    })
    await settle()
    expect(element.querySelector('.qc-panel')).not.toBeNull()
    await act(async () => void (unmount as () => void)())
  })
})

describe('the overridden session commands', () => {
  test('SC-58: new-shell opens a tab in the focused workspace', async () => {
    const wired = await track()
    expect(await wired.run('new-shell', undefined, 'quirky.session')).toEqual({ ok: true })
    expect(wired.fake.callsTo('quirky.worktree/wake').map((call) => call.params)).toEqual([{ worktree: 'wt-main' }])
    expect(wired.calls('newTab')).toEqual([{ workspace: 'wt-main' }])
  })

  test('new-shell uses the selected layout worktree when no workspace is mounted', async () => {
    const wired = await track({ mount: false })
    wired.fake.layout.worktree = 'wt-other'
    wired.fake.layout.view = { id: VIEW, input: { worktree: 'wt-view' } }
    expect(await wired.run('new-shell', undefined, 'quirky.session')).toEqual({ ok: true })
    expect(wired.fake.callsTo('quirky.worktree/wake').map((call) => call.params)).toEqual([{ worktree: 'wt-other' }])
    expect(wired.calls('newTab')).toEqual([{ workspace: 'wt-other' }])
  })

  test('new-shell does not add a tab when waking the focused worktree fails', async () => {
    const wakeError = new Error('worktree wake failed')
    const wired = await track({ wake: () => { throw wakeError } })
    const beforeWorkspace = structuredClone(wired.daemon.current)
    const beforeTabs = wired.last().tabs

    await expect(wired.run('new-shell', undefined, 'quirky.session')).rejects.toThrow('worktree wake failed')

    expect(wired.fake.callsTo('quirky.worktree/wake').map((call) => call.params)).toEqual([{ worktree: 'wt-main' }])
    expect(wired.calls('newTab')).toEqual([])
    expect(wired.daemon.current).toEqual(beforeWorkspace)
    expect(wired.last().tabs).toEqual(beforeTabs)
  })

  test('new-shell with nothing to open in says so', async () => {
    const wired = await track({ mount: false })
    expect(await wired.run('new-shell', undefined, 'quirky.session')).toEqual(NO_WORKSPACE)
    expect(wired.fake.callsTo('quirky.worktree/wake')).toEqual([])
    expect(wired.calls('newTab')).toEqual([])
  })

  test('close-session closes the focused pane of a split tab', async () => {
    const wired = await track()
    await wired.run('close-session', undefined, 'quirky.session')
    expect(wired.calls('closePane').map((params) => params.pane)).toEqual(['pane-3'])
  })

  test('select-tab and select-tab-N pick a tab of the active group by position and skip one that is not there', async () => {
    const wired = await track()
    await wired.run('select-tab', { index: 1 }, 'quirky.session')
    await wired.run('select-tab-1', undefined, 'quirky.session')
    await wired.run('select-tab-2', undefined, 'quirky.session')
    await wired.run('select-tab-9', undefined, 'quirky.session')
    await wired.run('select-tab', { index: 'x' }, 'quirky.session')
    expect(wired.calls('activateTab')).toEqual([
      { workspace: 'wt-main', index: 1 },
      { workspace: 'wt-main', index: 1 },
      { workspace: 'wt-main', index: 2 }
    ])
  })
})

describe('the floating commands', () => {
  test('toggle-floating opens and closes the panel, keeping its maximized state', async () => {
    const wired = await track({ mount: false, floating: { maximized: true } })
    await wired.run('toggle-floating')
    await wired.run('toggle-floating')
    expect(wired.calls('setFloating')).toEqual([{ open: true }, { open: false }])
    expect(wired.floating().maximized).toBe(true)
  })

  test('SC-56: maximize-floating opens it maximized and minimize-floating hides it', async () => {
    const wired = await track({ mount: false })
    expect(await wired.run('maximize-floating')).toMatchObject({ open: true, maximized: true })
    expect(await wired.run('minimize-floating')).toMatchObject({ open: false, maximized: true })
    expect(wired.calls('setFloating')).toEqual([{ open: true, maximized: true }, { open: false }])
  })

  test('SC-59: with the workspace turned off they do nothing', async () => {
    const wired = await track({ mount: false, floating: { enabled: false } })
    for (const id of ['toggle-floating', 'maximize-floating', 'minimize-floating']) {
      expect(await wired.run(id)).toMatchObject({ ok: false })
    }
    expect(wired.calls('setFloating')).toEqual([])
  })
})

describe('the shortcut policy', () => {
  test('SC-61: terminalKeysFirst starts from the setting and follows it', async () => {
    const wired = await track({ mount: false })
    expect(wired.fake.contextValue('terminalKeysFirst')).toBe(false)
    await wired.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/shortcut-policy', value: 'terminal-first' })
    expect(wired.fake.contextValue('terminalKeysFirst')).toBe(true)
    await wired.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/shortcut-policy', value: 'app-first' })
    expect(wired.fake.contextValue('terminalKeysFirst')).toBe(false)
    await wired.fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/font-size', value: 18 })
    await wired.fake.emit({ type: 'setting.changed', id: 'setting:quirky.other/shortcut-policy', value: 'terminal-first' })
    expect(wired.fake.contextValue('terminalKeysFirst')).toBe(false)
  })

  test('SC-61: a window that starts under Terminal first has the key set at once', async () => {
    const wired = await track({ mount: false, settings: { 'shortcut-policy': 'terminal-first' } })
    expect(wired.fake.contextValue('terminalKeysFirst')).toBe(true)
  })
})

describe('public workspace menu commands', () => {
  test('hidden command schemas are strict and expose the declared actions', async () => {
    type PropertySchema = { type: string; enum?: string[]; additionalProperties?: boolean }
    type ArgumentSchema = {
      type: string
      required?: string[]
      additionalProperties?: boolean
      properties: Record<string, PropertySchema>
    }
    type CommandSchema = { id: string; title: string; palette?: boolean; args?: ArgumentSchema }
    const manifest = JSON.parse(await Bun.file(new URL('../../quirky-plugin.json', import.meta.url)).text()) as {
      contributes: { command: CommandSchema[] }
    }
    const menu = manifest.contributes.command.find((entry) => entry.id === 'run-menu-item')!
    const workspace = manifest.contributes.command.find((entry) => entry.id === 'workspace-menu-action')!
    expect(menu).toMatchObject({
      title: 'Run Terminal Menu Item',
      palette: false,
      args: { type: 'object', required: ['item'], additionalProperties: false }
    })
    expect(menu.args?.properties).toEqual({
      item: { type: 'string' },
      session: { type: 'string' },
      worktree: { type: 'string' },
      workspace: { type: 'string' },
      group: { type: 'string' }
    })
    expect(workspace).toMatchObject({
      title: 'Terminal Workspace Menu Action',
      palette: false,
      args: { type: 'object', required: ['action', 'target'], additionalProperties: false }
    })
    expect(workspace.args?.properties).toMatchObject({
      action: { type: 'string', enum: ['copy-id', 'choose-agent', 'hidden-tabs', 'run-group-command'] },
      target: { type: 'string' },
      kind: { type: 'string', enum: ['tab', 'pane', 'session'] },
      agent: { type: 'string' },
      background: { type: 'boolean' },
      open: { type: 'boolean' },
      command: { type: 'string' },
      args: { type: 'object', additionalProperties: true }
    })

    const openMenu = manifest.contributes.command.find((entry) => entry.id === 'open-menu')!
    expect(openMenu.args?.properties.kind.enum).toEqual(['tab', 'pane', 'plus', 'actions', 'quick-commands'])
    expect(openMenu.args?.properties.x).toMatchObject({ type: 'number' })
    expect(openMenu.args?.properties.y).toMatchObject({ type: 'number' })
  })

  test('open-menu forwards context coordinates and keeps anchor defaults for ordinary opens', async () => {
    const wired = await track()
    const controller = registry.controllerFor('wt-main')!
    expect(await wired.run('open-menu', { kind: 'actions', target: 'grp-1', x: 37, y: 81 })).toEqual({ ok: true })
    expect(controller.getSnapshot().menu).toMatchObject({ kind: 'actions', target: 'grp-1', x: 37, y: 81 })

    expect(await wired.run('open-menu', { kind: 'tab', target: 'tab-1' })).toEqual({ ok: true })
    expect(controller.getSnapshot().menu).toMatchObject({ kind: 'tab', target: 'tab-1' })
  })

  test('copy-id returns the copied tab, pane and session IDs', async () => {
    const wired = await track()
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'tab-2', kind: 'tab' })).toEqual({
      ok: true,
      text: 'tab-2'
    })
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'pane-3', kind: 'pane' })).toEqual({
      ok: true,
      text: 'pane-3'
    })
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'pane-3', kind: 'session' })).toEqual({
      ok: true,
      text: 's-3'
    })
    expect(copied).toEqual(['tab-2', 'pane-3', 's-3'])
  })

  test('copy-id reports missing, stale, wrong-kind and clipboard failures', async () => {
    const wired = await track()
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', kind: 'tab' })).toEqual({
      ok: false,
      reason: 'target is required'
    })
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'gone', kind: 'tab' })).toEqual({
      ok: false,
      reason: 'no mounted terminal workspace holds gone'
    })
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'pane-3', kind: 'tab' })).toEqual({
      ok: false,
      reason: 'target pane-3 is not a tab target'
    })
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('clipboard denied') }, readText: async () => '' }
    })
    expect(await wired.run('workspace-menu-action', { action: 'copy-id', target: 'tab-2', kind: 'tab' })).toEqual({
      ok: false,
      reason: 'clipboard denied'
    })
  })

  test('choose-agent uses the current enabled request for a foreground prompt', async () => {
    const agents = {
      defaultAgent: 'claude',
      agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } }]
    }
    const wired = await track({ agents })
    expect(await wired.run('workspace-menu-action', { action: 'choose-agent', target: 'grp-2', agent: 'claude' })).toEqual({ ok: true })
    expect(registry.controllerFor('wt-main')!.getSnapshot().dialog).toMatchObject({
      kind: 'new-session',
      group: 'grp-2',
      request: { agent: 'claude', background: false, label: 'Claude', permissions: 'yolo' }
    })
    expect(wired.calls('newTab')).toEqual([])
    expect(wired.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('choose-agent opens the background Claude prompt through the command', async () => {
    const agents = {
      defaultAgent: 'claude',
      agents: [{ id: 'claude', label: 'Claude', installed: true, enabled: true, isDefault: true, permissions: { mode: 'yolo' } }]
    }
    const wired = await track({ agents })
    expect(await wired.run('workspace-menu-action', {
      action: 'choose-agent',
      target: 'grp-2',
      agent: 'claude',
      background: true
    })).toEqual({ ok: true })
    expect(registry.controllerFor('wt-main')!.getSnapshot().dialog).toMatchObject({
      kind: 'new-session',
      group: 'grp-2',
      request: { agent: 'claude', background: true, label: 'Claude (background)' }
    })
    expect(wired.calls('newTab')).toEqual([])
    expect(wired.fake.callsTo('quirky.structured/create')).toEqual([])
  })

  test('choose-agent refuses unavailable agents and non-group targets', async () => {
    const wired = await track({ agents: { defaultAgent: 'claude', agents: [] } })
    expect(await wired.run('workspace-menu-action', { action: 'choose-agent', target: 'grp-2', agent: 'claude' })).toEqual({
      ok: false,
      reason: 'agent claude is not available'
    })
    expect(registry.controllerFor('wt-main')!.getSnapshot().dialog).toBeNull()
    expect(await wired.run('workspace-menu-action', { action: 'choose-agent', target: 'pane-3', agent: 'claude' })).toEqual({
      ok: false,
      reason: 'target pane-3 is not a group target'
    })
  })

  test('hidden-tabs accepts requests without measured overflow and validates open', async () => {
    const wired = await track()
    const controller = registry.controllerFor('wt-main')!
    expect(await wired.run('workspace-menu-action', { action: 'hidden-tabs', target: 'grp-1', open: true })).toEqual({ ok: true })
    await settle()
    expect(controller.getSnapshot().overflowGroup).toBeNull()
    expect(document.body.querySelector('[role="menu"][aria-label="Hidden tabs"]')).toBeNull()
    expect(await wired.run('workspace-menu-action', { action: 'hidden-tabs', target: 'grp-1', open: false })).toEqual({ ok: true })
    expect(await wired.run('workspace-menu-action', { action: 'hidden-tabs', target: 'grp-1' })).toEqual({
      ok: false,
      reason: 'open must be a boolean'
    })
    expect(await wired.run('workspace-menu-action', { action: 'hidden-tabs', target: 'pane-3', open: true })).toEqual({
      ok: false,
      reason: 'target pane-3 is not a group target'
    })
  })

  test('run-group-command overwrites caller group context and validates before external dispatch', async () => {
    const wired = await track()
    const received: unknown[] = []
    wired.fake.provided.set('command:acme.tools/run', async (args) => { received.push(args) })
    const args = { task: 'build', group: 'forged', worktree: 'forged' }
    expect(await wired.run('workspace-menu-action', {
      action: 'run-group-command',
      target: 'grp-2',
      command: 'command:acme.tools/run',
      args
    })).toEqual({ ok: true })
    expect(wired.fake.callsTo('quirky.terminal/groupInfo').map((call) => call.params)).toEqual([{ group: 'grp-2' }])
    expect(wired.executed).toEqual([{
      id: 'command:acme.tools/run',
      args: { task: 'build', group: 'grp-2', worktree: 'wt-main' }
    }])
    expect(received).toEqual([{ task: 'build', group: 'grp-2', worktree: 'wt-main' }])

    const call = wired.fake.context.call.bind(wired.fake.context)
    wired.fake.context.call = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'quirky.terminal/groupInfo') return { workspace: 'wt-other' }
      return call(method, params)
    }) as typeof wired.fake.context.call
    expect(await wired.run('workspace-menu-action', {
      action: 'run-group-command',
      target: 'grp-2',
      command: 'command:acme.tools/run',
      args: { task: 'build' }
    })).toEqual({
      ok: false,
      reason: 'The target group is no longer available in this worktree.'
    })
    expect(wired.executed).toHaveLength(1)
  })

  test('workspace menu actions reject malformed or action-inapplicable arguments', async () => {
    const wired = await track()
    const malformed: [unknown, string][] = [
      [null, 'invalid workspace menu arguments'],
      [{ action: 'other', target: 'grp-1' }, 'action must be one of copy-id, choose-agent, hidden-tabs, run-group-command'],
      [{ action: 'copy-id', target: 'tab-2' }, 'kind must be one of tab, pane, session'],
      [{ action: 'copy-id', target: 'tab-2', kind: 'other' }, 'kind must be one of tab, pane, session'],
      [{ action: 'copy-id', target: 'tab-2', kind: 'tab', text: 'forged' }, 'invalid workspace menu arguments'],
      [{ action: 'choose-agent', target: 'grp-2', agent: 'claude', label: 'Forged', permissions: 'ignore' }, 'invalid workspace menu arguments'],
      [{ action: 'choose-agent', target: 'grp-2', agent: 'claude', background: 'yes' }, 'invalid workspace menu arguments'],
      [{ action: 'hidden-tabs', target: 'grp-1', open: 'yes' }, 'open must be a boolean'],
      [{ action: 'run-group-command', target: 'grp-2' }, 'command is required'],
      [{ action: 'run-group-command', target: 'grp-2', command: 'command:acme.tools/run', args: [] }, 'invalid workspace menu arguments'],
      [{ action: 'run-group-command', target: 'grp-2', command: 'command:acme.tools/run', token: 'forged' }, 'invalid workspace menu arguments']
    ]
    for (const [args, reason] of malformed) {
      expect(await wired.run('workspace-menu-action', args)).toEqual({ ok: false, reason })
    }
  })

  test('all nine literal session shortcut handlers preserve their numeric positions', async () => {
    const workspace = makeWorkspace(group('grp-1', Array.from({ length: 9 }, (_, index) =>
      tab(`tab-${index + 1}`, pane(`pane-${index + 1}`, `s-${index + 1}`))
    )))
    const wired = await track({ workspace })
    for (let index = 1; index <= 9; index += 1) {
      await wired.run(`select-tab-${index}`, undefined, 'quirky.session')
    }
    expect(wired.calls('activateTab')).toEqual(
      Array.from({ length: 9 }, (_, index) => ({ workspace: 'wt-main', index: index + 1 }))
    )
    await wired.run('select-tab', { index: 0 }, 'quirky.session')
    await wired.run('select-tab', { index: 'not-a-number' }, 'quirky.session')
    expect(wired.calls('activateTab')).toHaveLength(9)
  })
})

// The command module imports the browser-bound workspace, so these tests load it after beforeAll.
describe('menu data watcher errors', () => {
  test('quick-command read failures toast once and preserve the last successful snapshot', async () => {
    const { watchQuickCommands } = await import('../../src/window/commands')
    let reads = 0
    const fake = fakeContext({
      'quirky.terminal/quickCommands': () => {
        reads += 1
        if (reads === 1 || reads === 3) throw new Error('store locked')
        return { commands: [{ ...GLOBAL_HELLO, id: 'fresh' }] }
      },
      'quirky.worktree/resolve': () => ({ repoId: null })
    })
    const source = watchQuickCommands(fake.context, 'wt')
    await settle()
    await settle()
    expect(source.commands()).toEqual([])
    expect(fake.toasts).toEqual([{ title: 'Could not load quick commands', body: 'store locked' }])

    await fake.emit({ type: 'quirky.terminal/quickCommands' } as never)
    await settle()
    await settle()
    expect(source.commands().map((entry) => entry.id)).toEqual(['fresh'])

    await fake.emit({ type: 'quirky.terminal/quickCommands' } as never)
    await settle()
    await settle()
    expect(source.commands().map((entry) => entry.id)).toEqual(['fresh'])
    expect(fake.toasts).toEqual([
      { title: 'Could not load quick commands', body: 'store locked' },
      { title: 'Could not load quick commands', body: 'store locked' }
    ])
    source.dispose()
  })

  test('a failed contribution refresh toasts once and retains menu items and keybindings', async () => {
    const { watchMenuContributions } = await import('../../src/window/commands')
    const model = {
      menuItems: [{
        id: 'menu-item:acme.tools/first',
        plugin: 'acme.tools',
        menu: 'quirky.terminal/pane',
        title: 'First',
        command: 'command:acme.tools/first'
      }],
      keybindings: [{ command: 'command:acme.tools/first', key: 'mod+k', status: 'active' }]
    } as UiModel
    let reads = 0
    const fake = fakeContext({
      'ui.contributions': () => {
        reads += 1
        if (reads === 2) throw new Error('registry offline')
        return model
      }
    })
    const source = watchMenuContributions(fake.context)
    let notifications = 0
    source.subscribe(() => { notifications += 1 })
    await settle()
    await settle()
    const successfulNotifications = notifications
    expect(source.items()).toEqual(model.menuItems)
    expect(source.key?.('command:acme.tools/first')).toBe('⌘K')

    await fake.emit({ type: 'plugin.changed' })
    await settle()
    await settle()

    expect(source.items()).toEqual(model.menuItems)
    expect(source.key?.('command:acme.tools/first')).toBe('⌘K')
    expect(notifications).toBe(successfulNotifications)
    expect(fake.toasts).toEqual([{ title: 'Could not load menu contributions', body: 'registry offline' }])
    source.dispose()
  })

  test('disposed watchers ignore late failed reads without toasts or notifications', async () => {
    const { watchQuickCommands, watchMenuContributions } = await import('../../src/window/commands')
    const quickRead = Promise.withResolvers<unknown>()
    const quickFake = fakeContext({
      'quirky.terminal/quickCommands': () => quickRead.promise,
      'quirky.worktree/resolve': () => ({ repoId: null })
    })
    const quick = watchQuickCommands(quickFake.context, 'wt')
    let quickChanges = 0
    quick.subscribe(() => { quickChanges += 1 })
    quick.dispose()
    quickRead.reject(new Error('store locked'))
    await settle()
    expect(quickFake.toasts).toEqual([])
    expect(quickChanges).toBe(0)

    const registryRead = Promise.withResolvers<unknown>()
    const registryFake = fakeContext({ 'ui.contributions': () => registryRead.promise })
    const contributions = watchMenuContributions(registryFake.context)
    let registryChanges = 0
    contributions.subscribe(() => { registryChanges += 1 })
    contributions.dispose()
    registryRead.reject(new Error('registry offline'))
    await settle()
    expect(registryFake.toasts).toEqual([])
    expect(registryChanges).toBe(0)
  })
})

describe('pane quick-command adapters', () => {
  test('disabled rows have no action and runnable callbacks execute for their pane', async () => {
    // The command module imports the browser-bound workspace, so load it after beforeAll.
    const { paneMenuQuickCommands } = await import('../../src/window/commands')
    const wired = await track()
    const emptySource = {
      commands: () => [],
      repo: () => null,
      menu: () => null,
      openMenu: () => {},
      closeMenu: () => {},
      subscribe: () => () => {},
      dispose: () => {}
    }
    const emptyRows = paneMenuQuickCommands(wired.fake.context, emptySource, 'pane-1')
    expect(emptyRows.find((entry) => entry.label === 'No quick commands')?.onSelect).toBeUndefined()

    const source = { ...emptySource, commands: () => [GLOBAL_HELLO] }
    const rows = paneMenuQuickCommands(wired.fake.context, source, 'pane-1')
    const hello = rows.find((entry) => entry.label === 'Hello')
    if (hello?.onSelect === undefined) throw new Error('the runnable quick command has no action')
    await act(async () => {
      await hello.onSelect?.()
    })
    expect(wired.calls('runQuickCommand')).toEqual([{ id: 'hello', pane: 'pane-1' }])
  })
})

describe('agent command catalog freshness', () => {
  test('choose-agent re-reads the current catalog and refuses a now-disabled agent', async () => {
    const enabled = {
      id: 'claude',
      label: 'Claude',
      installed: true,
      enabled: true,
      isDefault: true,
      permissions: { mode: 'yolo' }
    }
    const wired = await track({ agents: { defaultAgent: 'claude', agents: [enabled] } })
    const call = wired.fake.context.call.bind(wired.fake.context)
    let catalogReads = 0
    wired.fake.context.call = (async (method: string, params?: Record<string, unknown>) => {
      if (method === 'quirky.agents/list') {
        catalogReads += 1
        return { defaultAgent: 'claude', agents: [{ ...enabled, enabled: false }] }
      }
      return call(method, params)
    }) as typeof wired.fake.context.call

    expect(await wired.run('workspace-menu-action', { action: 'choose-agent', target: 'grp-2', agent: 'claude' })).toEqual({
      ok: false,
      reason: 'agent claude is not available'
    })
    expect(catalogReads).toBe(1)
    expect(registry.controllerFor('wt-main')!.getSnapshot().dialog).toBeNull()
    expect(wired.calls('newTab')).toEqual([])
    expect(wired.fake.callsTo('quirky.structured/create')).toEqual([])
  })
})
