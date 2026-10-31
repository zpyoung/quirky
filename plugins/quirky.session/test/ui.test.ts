import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { bytesToBase64, GRAPHITE_TERMINAL_PALETTES, TERMINAL_ANSI_KEYS, RpcError, RpcErrorCode, type AgentDisplayState, type AgentStatusSummary, type QuirkyEvent, type TerminalAppearanceMode, type TerminalPalette } from '@quirky/protocol'
import type { ITheme } from '@xterm/xterm'
import { resetSessionMemory } from '../src/window/model'
import { sessionStatusPresentation } from '../src/window/StatusDot'
import manifest from '../quirky-plugin.json'
import {
  agentInfo,
  agentListing,
  attachResult,
  fakeContext,
  mountView,
  session,
  sessionHandlers,
  settle,
  WORKTREE,
  type FakeContext,
  type Mounted
} from './ui-fake'

const VIEW = 'view:quirky.session/worktree'
const shell1 = session({ id: 's1', title: 'Shell 1', createdAt: 1 })
const claude = session({ id: 's2', title: 'Claude 1', agent: 'claude', status: 'working', createdAt: 2 })

let fake: FakeContext
let mounted: Mounted | null = null

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // there is no WebGL in happy-dom; the pane falls back to xterm's DOM renderer
  mock.module('@xterm/addon-webgl', () => ({
    WebglAddon: class {
      activate() {
        throw new Error('WebGL2 not supported')
      }
      onContextLoss() {}
      dispose() {}
    }
  }))
  ;({ Terminal } = await import('@xterm/xterm'))
  const { activate } = await import('../src/ui')
  activateModule = activate
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

type XtermTerminal = InstanceType<typeof import('@xterm/xterm').Terminal>
let Terminal: typeof import('@xterm/xterm').Terminal
let activateModule: (context: FakeContext['context']) => void

function start(sessions = [shell1, claude], extra = {}, settings: Record<string, unknown> = {}) {
  fake = fakeContext(sessionHandlers(sessions, extra), settings)
  activateModule(fake.context)
}

beforeEach(() => {
  resetSessionMemory()
})
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  document.body.innerHTML = ''
  document.documentElement.removeAttribute('data-theme')
})

async function open(input: unknown) {
  mounted = await mountView(fake, input)
  return mounted
}
function expectGraphitePalette(theme: ITheme | undefined, appearance: TerminalAppearanceMode, base: Partial<TerminalPalette> = {}) {
  const expected = GRAPHITE_TERMINAL_PALETTES[appearance]
  for (const key of ['background', 'foreground', 'cursor', 'cursorAccent', 'selectionBackground', 'selectionForeground'] as const) {
    expect(theme?.[key]).toBe(base[key] ?? expected[key])
  }
  for (const key of TERMINAL_ANSI_KEYS) expect(theme?.[key]).toBe(expected[key])
}

describe('the plugin module', () => {
  test('provides every code-backed contribution the manifest declares', () => {
    start()
    const declared = [
      ...manifest.contributes.view.map((entry) => `view:quirky.session/${entry.id}`),
      ...manifest.contributes.command.map((entry) => `command:quirky.session/${entry.id}`)
    ]
    expect([...fake.provided.keys()].sort()).toEqual(declared.sort())
  })

  test('the manifest points at the built module and binds Cmd+T, Cmd+W and Cmd+1..9', () => {
    expect(manifest.ui).toBe('dist/ui.js')
    const keys = Object.fromEntries(manifest.contributes.keybinding.map((entry) => [entry.key, entry.command]))
    expect(keys['mod+t']).toBe('new-shell')
    expect(keys['mod+w']).toBe('close-session')
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(keys[`mod+${digit}`]).toBe(`select-tab-${digit}`)
    const commands = manifest.contributes.command.map((entry) => entry.id)
    for (const digit of [1, 2, 3, 4, 5, 6, 7, 8, 9]) expect(commands).toContain(`select-tab-${digit}`)
  })
})

describe('the worktree view', () => {
  test('shows the worktree name and path above the session tabs', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('main')
    expect(view.element.textContent).toContain('/tmp/work/main')
    expect(view.tabs()[0]!.textContent).toContain('Shell 1')
    expect(view.tabs()[1]!.textContent).toContain('Claude 1')
    expect(fake.callsTo('quirky.worktree/resolve')[0]!.params).toEqual({ selector: WORKTREE.id })
    expect(fake.callsTo('quirky.session/list')[0]!.params).toEqual({ worktree: WORKTREE.id })
  })

  test('SC-35: reports the tabs and the active session', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    expect(view.lastReport()).toEqual({
      worktree: WORKTREE.id,
      tabs: [
        { session: 's1', title: 'Shell 1', agent: 'shell', status: 'running' },
        { session: 's2', title: 'Claude 1', agent: 'claude', status: 'working' }
      ],
      active: 's2',
      visibleSessions: ['s2']
    })
  })

  test('a starting session reports as running', async () => {
    start([session({ id: 's1', status: 'starting' })])
    const view = await open({ worktree: WORKTREE.id })
    expect((view.lastReport() as { tabs: { status: string }[] }).tabs[0]!.status).toBe('running')
  })

  test('with no session in the input it shows the one last active in the worktree, else the first', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id })
    expect((first.lastReport() as { active: string }).active).toBe('s1')
    await first.unmount()
    mounted = null

    mounted = await mountView(fake, { worktree: WORKTREE.id, session: 's2' })
    await mounted.unmount()
    mounted = await mountView(fake, { worktree: WORKTREE.id })
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
  })

  test('D21: a fresh window mounted with the daemon\'s view input shows the tab selected earlier', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id })
    await first.click(first.tabs()[1]!)
    await first.unmount()
    mounted = null

    resetSessionMemory()
    const input = fake.layout.view!.input
    mounted = await mountView(fake, input)
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
  })

  test('D21: a view opened on the worktree alone publishes the tab it picked, so a fresh window shows the same one', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id, session: 's2' })
    await first.unmount()
    // the worktree alone, as `quirky ui open-view` or a sidebar click opens it; window memory picks s2
    mounted = await mountView(fake, { worktree: WORKTREE.id })
    await mounted.unmount()
    mounted = null

    resetSessionMemory()
    mounted = await mountView(fake, fake.layout.view!.input)
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
  })

  test('closing the active tab shown through the window memory publishes the replacement to the daemon layout', async () => {
    start()
    const first = await open({ worktree: WORKTREE.id, session: 's2' })
    await first.unmount()
    mounted = null
    mounted = await mountView(fake, { worktree: WORKTREE.id })
    expect((mounted.lastReport() as { active: string }).active).toBe('s2')
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's2' } }])
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's2' } })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } })
  })

  test('SC-37: clicking a tab opens the view on that session', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's1' })
    await view.click(view.tabs()[1]!)
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's2' } }])
  })

  test('unread sessions keep their reason visible without losing the active status cue', async () => {
    const labels = { agent: 'Unread agent completion', bell: 'Unread bell', notification: 'Unread notification' } as const
    start([
      session({ id: 's1', title: 'Shell 1', createdAt: 1, unread: 'bell' }),
      session({ id: 's2', title: 'Claude 1', agent: 'claude', createdAt: 2, unread: 'agent' }),
      session({ id: 's3', title: 'Claude 2', agent: 'claude', createdAt: 3, unread: 'notification' }),
      session({ id: 's4', title: 'Shell 2', createdAt: 4 })
    ])
    const view = await open({ worktree: WORKTREE.id, session: 's1' })
    expect(view.tabs()[0]!.textContent).toContain(labels.bell)
    expect(view.tabs()[1]!.textContent).toContain(labels.agent)
    expect(view.tabs()[2]!.textContent).toContain(labels.notification)
    const unread = view.element.querySelector('[role="status"] [role="img"]')!
    expect(unread.getAttribute('aria-label')).toBe(labels.bell)
    expect(unread.getAttribute('role')).toBe('img')

    await fake.emit({ type: 'quirky.session/changed', data: { session: session({ id: 's1', title: 'Shell 1', createdAt: 1, unread: null }) } })
    expect(view.tabs()[0]!.textContent).not.toContain(labels.bell)
    expect(view.element.querySelector('[role="status"] [role="img"]')!.getAttribute('aria-label')).toBe('running')
  })

  test('marks the active tab selected', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    expect(view.tabs().map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true'])
  })

  test('a worktree that does not resolve is reported as missing', async () => {
    start([], { 'quirky.worktree/resolve': () => Promise.reject(new RpcError(RpcErrorCode.NotFound, 'no such worktree')) })
    const view = await open({ worktree: 'nowhere' })
    expect(view.element.textContent).toContain('Worktree not found')
    expect(view.lastReport()).toEqual({ worktree: 'nowhere', tabs: [], active: null, visibleSessions: [] })
  })

  test('an input without a worktree asks for one and reports nothing open', async () => {
    start()
    const view = await open({})
    expect(view.element.textContent).toContain('Pick a worktree')
    expect(view.lastReport()).toEqual({ worktree: null, tabs: [], active: null, visibleSessions: [] })
  })

  test('an empty worktree offers a new shell', async () => {
    start([], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('No sessions in this worktree.')
    const newShell = [...view.element.querySelectorAll('button')].find((button) => button.textContent === 'New shell')!
    await view.click(newShell)
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })
})

describe('keeping tabs current', () => {
  test('a session created or changed in the worktree appears and updates', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    const third = session({ id: 's3', title: 'Shell 2', createdAt: 3 })
    await fake.emit({ type: 'quirky.session/changed', data: { session: third } })
    expect(view.tabs()).toHaveLength(3)
    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...third, status: 'exited', exitCode: 0 } } })
    expect((view.lastReport() as { tabs: { status: string }[] }).tabs[2]!.status).toBe('exited')
  })

  test('a session of another worktree is ignored', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    await fake.emit({ type: 'quirky.session/changed', data: { session: session({ id: 'x', worktreeId: 'other', createdAt: 9 }) } })
    expect(view.tabs()).toHaveLength(2)
  })

  test('a removed session leaves, and closing the active one opens its replacement', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's2' } })
    expect(view.tabs()).toHaveLength(1)
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } }])
  })

  test('closing a session that is not active does not move the view', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.emit({ type: 'quirky.session/removed', data: { sessionId: 's1' } })
    expect(fake.opened).toEqual([])
  })

  test('reloads the sessions after the connection comes back', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    const before = fake.callsTo('quirky.session/list').length
    await fake.setConnection('reconnecting')
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.session/list').length).toBe(before + 1)
    expect(view.tabs()).toHaveLength(2)
  })
})

describe('new sessions', () => {
  const newSessionTrigger = (view: Mounted) =>
    [...view.element.querySelectorAll<HTMLButtonElement>('button[aria-haspopup="menu"]')]
      .find((button) => button.textContent?.includes('New session'))!

  const openMenu = async (view: Mounted) => {
    await view.click(newSessionTrigger(view))
    await settle()
    return () => [...view.element.querySelectorAll('[role="menuitem"]')].map((entry) => entry.textContent)
  }

  const pickFromMenu = async (view: Mounted, label: string) => {
    await view.click(newSessionTrigger(view))
    await settle()
    const item = [...view.element.querySelectorAll('[role="menuitem"]')].find((entry) => entry.textContent === label)!
    await view.click(item)
  }

  test('Shell starts a terminal session in the worktree and opens it', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })

  test('Claude asks for an optional prompt and passes it on', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Claude')
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!
      setter.call(textarea, '  fix the bug  ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Start')!)
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'claude', prompt: 'fix the bug' })
  })

  for (const background of [false, true]) {
    test(`a refused ${background ? 'background' : 'foreground'} start preserves the prompt for retry`, async () => {
      const method = background ? 'quirky.structured/create' : 'quirky.session/create'
      const { promise: firstStart, reject: refuse } = Promise.withResolvers<unknown>()
      let attempts = 0
      start([shell1], { [method]: () => ++attempts === 1 ? firstStart : session({ id: 'retried', agent: 'claude' }) })
      const view = await open({ worktree: WORKTREE.id })
      const openedBefore = [...fake.opened]
      await pickFromMenu(view, background ? 'Claude (background)' : 'Claude')
      const textarea = document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')!
      const prompt = '  keep this draft\nand retry it  '
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, prompt)
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      const startButton = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Start')!
      await view.click(startButton)
      expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe(prompt)
      expect(startButton.disabled).toBe(true)
      await act(async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }))
      })
      expect(fake.callsTo(method)).toHaveLength(1)

      await act(async () => { refuse(new Error('agent is disabled')) })
      expect(document.querySelector<HTMLTextAreaElement>('[role="dialog"] textarea')?.value).toBe(prompt)
      expect(startButton.disabled).toBe(false)
      expect(fake.toasts).toEqual([{ title: 'Could not start session', body: 'agent is disabled' }])
      expect(fake.opened).toEqual(openedBefore)

      await view.click(startButton)
      expect(fake.callsTo(method).map((call) => call.params)).toEqual([
        { worktree: WORKTREE.id, agent: 'claude', prompt: prompt.trim() },
        { worktree: WORKTREE.id, agent: 'claude', prompt: prompt.trim() }
      ])
      expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'retried' } })
      expect(document.querySelector('[role="dialog"]')).toBeNull()
    })
  }

  test('Claude (background) starts a structured session', async () => {
    start([shell1], { 'quirky.structured/create': () => session({ id: 'bg', kind: 'structured', agent: 'claude' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Claude (background)')
    const start_ = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Start') as HTMLButtonElement
    expect(start_.disabled).toBe(true)
    const textarea = document.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'go')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await view.click(start_)
    expect(fake.callsTo('quirky.structured/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'claude', prompt: 'go' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'bg' } })
  })

  test('SC-43: the menu lists Shell, the installed enabled agents, Claude (background) and Manage agents', async () => {
    start([shell1])
    const view = await open({ worktree: WORKTREE.id })
    const labels = await openMenu(view)
    expect(labels()).toEqual(['Shell', 'Claude', 'Codex', 'Goose', 'Claude (background)', 'Manage agents'])
    expect(fake.callsTo('quirky.agents/list')).toHaveLength(1)
  })

  test('the default agent comes first, the rest keep listing order', async () => {
    const listing = agentListing([agentInfo('claude', 'Claude'), agentInfo('codex', 'Codex'), agentInfo('goose', 'Goose')], 'goose')
    start([shell1], { 'quirky.agents/list': () => listing })
    const labels = await openMenu(await open({ worktree: WORKTREE.id }))
    expect(labels()).toEqual(['Shell', 'Goose', 'Claude', 'Codex', 'Claude (background)', 'Manage agents'])
  })

  test('SC-41: disabled and undetected agents are not offered', async () => {
    const listing = agentListing([
      agentInfo('claude', 'Claude'),
      agentInfo('codex', 'Codex', { enabled: false }),
      agentInfo('goose', 'Goose', { installed: false }),
      agentInfo('aider', 'Aider')
    ])
    start([shell1], { 'quirky.agents/list': () => listing })
    const labels = await openMenu(await open({ worktree: WORKTREE.id }))
    expect(labels()).toEqual(['Shell', 'Claude', 'Aider', 'Claude (background)', 'Manage agents'])
  })

  test('Claude (background) is hidden when Claude is disabled or missing', async () => {
    for (const claudeOver of [{ enabled: false }, { installed: false }]) {
      start([shell1], { 'quirky.agents/list': () => agentListing([agentInfo('claude', 'Claude', claudeOver), agentInfo('codex', 'Codex')]) })
      const view = await open({ worktree: WORKTREE.id })
      expect((await openMenu(view))()).toEqual(['Shell', 'Codex', 'Manage agents'])
      await mounted?.unmount()
      mounted = null
      document.body.innerHTML = ''
    }
  })

  test('the menu uses the catalog label for the prompt dialog title', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Goose')
    expect(document.body.textContent).toContain('New Goose session')
    await view.click([...document.querySelectorAll('button')].find((button) => button.textContent === 'Start')!)
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'goose' })
  })

  test('Manage agents opens the Agents view', async () => {
    start([shell1])
    const view = await open({ worktree: WORKTREE.id })
    await pickFromMenu(view, 'Manage agents')
    expect(fake.opened.at(-1)).toEqual({ id: 'view:quirky.agents/settings', input: undefined })
    expect(view.element.querySelector('[role="menu"]')).toBeNull()
  })

  test('while the list loads the menu shows Shell and Manage agents only', async () => {
    let release: (value: unknown) => void = () => {}
    const pending = new Promise((resolve) => (release = resolve))
    start([shell1], { 'quirky.agents/list': () => pending })
    const view = await open({ worktree: WORKTREE.id })
    const labels = await openMenu(view)
    expect(labels()).toEqual(['Shell', 'Manage agents'])
    release(agentListing([agentInfo('codex', 'Codex')]))
    await settle()
    expect(labels()).toEqual(['Shell', 'Codex', 'Manage agents'])
  })

  test('a failed list call leaves Shell and Manage agents', async () => {
    start([shell1], { 'quirky.agents/list': () => Promise.reject(new Error('down')) })
    const labels = await openMenu(await open({ worktree: WORKTREE.id }))
    expect(labels()).toEqual(['Shell', 'Manage agents'])
  })

  test('the list is read again each time the menu opens', async () => {
    let listing = agentListing([agentInfo('codex', 'Codex')])
    start([shell1], { 'quirky.agents/list': () => listing })
    const view = await open({ worktree: WORKTREE.id })
    expect((await openMenu(view))()).toEqual(['Shell', 'Codex', 'Manage agents'])
    await view.click(newSessionTrigger(view))
    listing = agentListing([agentInfo('goose', 'Goose')])
    expect((await openMenu(view))()).toEqual(['Shell', 'Goose', 'Manage agents'])
  })

  test('an open menu reads the catalog again on quirky.agents/changed and setting.changed', async () => {
    let listing = agentListing([agentInfo('codex', 'Codex'), agentInfo('goose', 'Goose')])
    start([shell1], { 'quirky.agents/list': () => listing })
    const view = await open({ worktree: WORKTREE.id })
    const labels = await openMenu(view)
    expect(labels()).toEqual(['Shell', 'Codex', 'Goose', 'Manage agents'])
    listing = agentListing([agentInfo('codex', 'Codex')])
    await fake.emit({ type: 'quirky.agents/changed', data: {} } as QuirkyEvent)
    await settle()
    expect(labels()).toEqual(['Shell', 'Codex', 'Manage agents'])
    listing = agentListing([])
    await fake.emit({ type: 'setting.changed', id: 'setting:quirky.agents/anything', value: true })
    await settle()
    expect(labels()).toEqual(['Shell', 'Manage agents'])
  })

  test('a closed menu does not listen for catalog changes', async () => {
    start([shell1])
    const view = await open({ worktree: WORKTREE.id })
    await openMenu(view)
    await view.click(newSessionTrigger(view))
    const before = fake.callsTo('quirky.agents/list').length
    await fake.emit({ type: 'quirky.agents/changed', data: {} } as QuirkyEvent)
    await settle()
    expect(fake.callsTo('quirky.agents/list')).toHaveLength(before)
  })

  test('a failed start is shown as a toast', async () => {
    start([shell1], { 'quirky.session/create': () => Promise.reject(new Error('no pty')) })
    const view = await open({ worktree: WORKTREE.id })
    const before = fake.opened.length
    await pickFromMenu(view, 'Shell')
    expect(fake.toasts).toEqual([{ title: 'Could not start session', body: 'no pty' }])
    expect(fake.opened).toHaveLength(before)
  })
})

describe('closing sessions', () => {
  const closeSession = async (view: Mounted, title: string) => {
    const button = view.element.querySelector(`[aria-label="Close ${title}"]`)!
    await view.click(button)
  }

  test('a running session is closed after the person confirms', async () => {
    start([shell1], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    await closeSession(view, 'Shell 1')
    expect(fake.confirms).toEqual([{ title: 'Close session', body: '"Shell 1" is still running. Close it?', confirmLabel: 'Close' }])
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })

  test('declining the confirmation keeps the session', async () => {
    start([shell1], { 'quirky.session/close': () => ({ ok: true }) })
    fake.state.confirmAnswer = false
    const view = await open({ worktree: WORKTREE.id })
    await closeSession(view, 'Shell 1')
    expect(fake.callsTo('quirky.session/close')).toEqual([])
  })

  test('an exited session closes without asking', async () => {
    start([session({ id: 's1', title: 'Shell 1', status: 'exited', exitCode: 0 })], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    await closeSession(view, 'Shell 1')
    expect(fake.confirms).toEqual([])
    expect(fake.callsTo('quirky.session/close')).toHaveLength(1)
  })

  test('the exited bar shows the exit code and closes the session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 3 })], { 'quirky.session/close': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('exited (code 3)')
    const close = [...view.element.querySelectorAll('button')].find((button) => button.textContent === 'Close')!
    await view.click(close)
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })
})

describe('UI commands', () => {
  test('new-shell starts a shell in the open view\'s worktree', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    await open({ worktree: WORKTREE.id })
    await fake.command('new-shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: WORKTREE.id, agent: 'shell' })
    expect(fake.opened.at(-1)).toEqual({ id: VIEW, input: { worktree: WORKTREE.id, session: 'new' } })
  })

  test('new-shell uses the selected layout worktree when no workspace is mounted', async () => {
    start([shell1], { 'quirky.session/create': () => session({ id: 'new' }) })
    fake.layout.worktree = 'wt-other'
    fake.layout.view = { id: VIEW, input: { worktree: 'wt-view' } }
    await fake.command('new-shell')
    expect(fake.callsTo('quirky.session/create')[0]!.params).toEqual({ worktree: 'wt-other', agent: 'shell' })
  })

  test('close-session closes the active session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 0 }), claude], { 'quirky.session/close': () => ({ ok: true }) })
    await open({ worktree: WORKTREE.id, session: 's1' })
    await fake.command('close-session')
    expect(fake.callsTo('quirky.session/close')[0]!.params).toEqual({ session: 's1' })
  })

  test('select-tab picks a tab by its 1-based index and ignores a missing one', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's1' })
    await fake.command('select-tab', { index: 2 })
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's2' } }])
    await fake.command('select-tab', { index: 5 })
    await fake.command('select-tab', { index: 0 })
    await fake.command('select-tab', {})
    expect(fake.opened).toHaveLength(1)
  })

  test('select-tab-N commands pick the Nth tab', async () => {
    start()
    await open({ worktree: WORKTREE.id, session: 's2' })
    await fake.command('select-tab-1')
    expect(fake.opened).toEqual([{ id: VIEW, input: { worktree: WORKTREE.id, session: 's1' } }])
  })

  test('commands do nothing once the view is gone', async () => {
    start()
    const view = await open({ worktree: WORKTREE.id })
    await view.unmount()
    mounted = null
    const before = fake.opened.length
    await fake.command('select-tab', { index: 2 })
    await fake.command('close-session')
    expect(fake.opened).toHaveLength(before)
    expect(fake.callsTo('quirky.session/close')).toEqual([])
  })
})

describe('terminal pane', () => {
  const text = (bytes: string) => new TextEncoder().encode(bytes)
  const decode = (bytes: Uint8Array | string) => (typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes))
  let terminals: XtermTerminal[]
  let writes: string[]
  let restore: () => void

  beforeEach(() => {
    terminals = []
    writes = []
    const open = Terminal.prototype.open
    const write = Terminal.prototype.write
    Terminal.prototype.open = function (this: XtermTerminal, element: HTMLElement) {
      terminals.push(this)
      return open.call(this, element)
    }
    Terminal.prototype.write = function (this: XtermTerminal, data: string | Uint8Array, callback?: () => void) {
      writes.push(decode(data))
      return write.call(this, data, callback)
    }
    restore = () => {
      Terminal.prototype.open = open
      Terminal.prototype.write = write
    }
  })
  afterEach(() => restore())

  test('attaches the active terminal session and takes its output from the stream', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    const attach = fake.callsTo('quirky.terminal/attach')
    expect(attach).toHaveLength(1)
    expect(attach[0]!.params.session).toBe('s1')
    expect(typeof attach[0]!.params.cols).toBe('number')
    expect(typeof attach[0]!.params.rows).toBe('number')
    await act(async () => fake.streams.get(7)!(text('hello')))
    expect(writes).toEqual(['hello'])
  })

  test('replays the output recorded before the attach', async () => {
    start([shell1], { 'quirky.terminal/attach': () => attachResult({ replay: bytesToBase64(text('old output')), offset: 10 }) })
    await open({ worktree: WORKTREE.id })
    expect(writes).toEqual(['old output'])
  })

  test('sends typed input and resizes to the session while it is alive', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')[0]!.params).toEqual({ session: 's1', data: 'ls' })
    await act(async () => terminals[0]!.resize(100, 30))
    expect(fake.callsTo('quirky.terminal/resize').at(-1)!.params).toEqual({ session: 's1', cols: 100, rows: 30 })
  })

  test('sends no input to an exited session', async () => {
    start([session({ id: 's1', status: 'exited', exitCode: 0 })])
    await open({ worktree: WORKTREE.id })
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
  })

  test('asks the attach for as many history lines as the scrollback setting holds', async () => {
    start([shell1], {}, { 'setting:quirky.terminal/scrollback': 4000 })
    await open({ worktree: WORKTREE.id })
    expect(fake.callsTo('quirky.terminal/attach')[0]!.params.historyLines).toBe(4000)
    await mounted!.unmount()
    mounted = null
    start([shell1])
    await open({ worktree: WORKTREE.id })
    expect(fake.callsTo('quirky.terminal/attach')[0]!.params.historyLines).toBe(2000)
  })

  test('SC-17, SC-28: a session that turns exited and restorable while shown attaches once more', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
    const lost = { ...shell1, status: 'exited' as const, exitCause: 'host-lost' as const, restorable: true }
    await fake.emit({ type: 'quirky.session/changed', data: { session: lost } })
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(2)
    expect(fake.callsTo('quirky.terminal/detach')).toHaveLength(1)
    expect(terminals).toHaveLength(2)

    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...lost, title: 'renamed' } } })
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(2)

    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...shell1, status: 'running' } } })
    await fake.emit({ type: 'quirky.session/changed', data: { session: lost } })
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(3)
  })

  test('SC-17: a pane opened on a lost session attaches once, since the attach restores it', async () => {
    start([session({ id: 's1', status: 'exited', exitCause: 'host-lost', restorable: true })])
    await open({ worktree: WORKTREE.id })
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
  })

  test('a session that exits for good keeps its pane and does not attach again', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...shell1, status: 'exited', exitCode: 0, restorable: false } } })
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
    expect(mounted!.element.textContent).toContain('exited')
  })

  test('SC-42: an attach that is not live writes the final screen and sends no typed input', async () => {
    const ended = session({ id: 's1', status: 'exited', exitCode: 0 })
    start([ended], { 'quirky.terminal/attach': () => attachResult({ replay: bytesToBase64(text('bye')), live: false }) })
    await open({ worktree: WORKTREE.id })
    expect(writes).toEqual(['bye'])
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
    expect(mounted!.element.textContent).toContain('exited')
  })

  test('SC-42: a running session whose attach is not live stays read only', async () => {
    start([shell1], { 'quirky.terminal/attach': () => attachResult({ replay: bytesToBase64(text('bye')), live: false }) })
    await open({ worktree: WORKTREE.id })
    await act(async () => terminals[0]!.input('ls'))
    expect(fake.callsTo('quirky.terminal/write')).toEqual([])
  })

  test('takes the scrollback from the terminal setting and defaults when it is unavailable', async () => {
    start([shell1], {}, { 'setting:quirky.terminal/scrollback': 4000 })
    await open({ worktree: WORKTREE.id })
    expect(terminals[0]!.options.scrollback).toBe(4000)
    await mounted!.unmount()
    mounted = null
    start([shell1])
    await open({ worktree: WORKTREE.id })
    expect(terminals[1]!.options.scrollback).toBe(2000)
  })

  test('applies a changed scrollback setting to the open terminal without remounting it', async () => {
    start([shell1], {}, { 'setting:quirky.terminal/scrollback': 4000 })
    await open({ worktree: WORKTREE.id })
    await fake.emit({ type: 'setting.changed', id: 'setting:quirky.terminal/scrollback', value: 9000 })
    expect(terminals).toHaveLength(1)
    expect(terminals[0]!.options.scrollback).toBe(9000)
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(1)
    await fake.emit({ type: 'setting.changed', id: 'setting:other.plugin/x', value: 1 })
    expect(terminals[0]!.options.scrollback).toBe(9000)
  })

  test('uses the complete app palette in place without losing output and stops observing on unmount', async () => {
    document.documentElement.setAttribute('data-theme', 'light')
    start([shell1])
    mounted = await mountView(fake, { worktree: WORKTREE.id }, {
      '--terminal-background': '#101010',
      '--terminal-cursor': '#ff0000'
    })
    const terminal = terminals[0]!
    expectGraphitePalette(terminal.options.theme, 'light', { background: '#101010', cursor: '#ff0000' })
    await act(async () => fake.streams.get(7)!(text('retained output')))
    expect(writes).toContain('retained output')

    document.documentElement.setAttribute('data-theme', 'dark')
    await settle()
    expectGraphitePalette(terminal.options.theme, 'dark', { background: '#101010', cursor: '#ff0000' })
    expect(terminals).toHaveLength(1)

    await act(async () => mounted!.element.style.setProperty('--terminal-foreground', '#00ff00'))
    await settle()
    expectGraphitePalette(terminal.options.theme, 'dark', {
      background: '#101010',
      foreground: '#00ff00',
      cursor: '#ff0000'
    })
    const themeBeforeUnmount = terminal.options.theme

    await mounted.unmount()
    mounted = null
    document.documentElement.setAttribute('data-theme', 'light')
    await settle()
    expect(terminal.options.theme).toEqual(themeBeforeUnmount)
  })

  test('detaches when the view unmounts', async () => {
    start([shell1])
    const view = await open({ worktree: WORKTREE.id })
    await view.unmount()
    mounted = null
    expect(fake.callsTo('quirky.terminal/detach').map((call) => call.params)).toEqual([{ streamId: 7 }])
    expect(fake.streams.size).toBe(0)
  })

  test('detaches the old stream and attaches again after a reconnect', async () => {
    start([shell1])
    await open({ worktree: WORKTREE.id })
    await fake.setConnection('reconnecting')
    expect(fake.callsTo('quirky.terminal/detach')).toHaveLength(1)
    await fake.setConnection('connected')
    await settle()
    expect(fake.callsTo('quirky.terminal/attach')).toHaveLength(2)
  })

  test('writes the reason into the terminal when the attach fails', async () => {
    start([shell1], { 'quirky.terminal/attach': () => Promise.reject(new RpcError(RpcErrorCode.MethodNotFound, 'unknown method: quirky.terminal/attach')) })
    await open({ worktree: WORKTREE.id })
    expect(writes.join('')).toContain('Could not attach: unknown method: quirky.terminal/attach')
  })

  test('mounts no terminal for a structured session', async () => {
    start([session({ id: 'bg', kind: 'structured', agent: 'claude' })], { 'quirky.structured/messages': () => [] })
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.querySelector('.terminal-host')).toBeNull()
    expect(fake.callsTo('quirky.terminal/attach')).toEqual([])
  })
})

describe('structured sessions', () => {
  const message = (seq: number, role: string, body: string) => ({ sessionId: 'bg', seq, role, text: body, at: 0 })
  const bg = session({ id: 'bg', kind: 'structured', agent: 'claude', title: 'Claude 1' })

  test('renders the transcript, hides hook chatter and takes new messages from events', async () => {
    start([bg], {
      'quirky.structured/messages': () => [message(1, 'user', 'hi'), message(2, 'system', 'hook_started: x'), message(3, 'assistant', 'hello')]
    })
    const view = await open({ worktree: WORKTREE.id })
    expect(fake.callsTo('quirky.structured/messages')[0]!.params).toEqual({ session: 'bg' })
    expect([...view.element.querySelectorAll('article[aria-label$="message"]')].map((row) => row.textContent)).toEqual(['userhi', 'assistanthello'])
    await fake.emit({ type: 'quirky.structured/message', data: { message: message(4, 'assistant', 'more') } })
    expect(view.element.querySelectorAll('article[aria-label$="message"]')).toHaveLength(3)
    await fake.emit({ type: 'quirky.structured/message', data: { message: { ...message(9, 'assistant', 'other'), sessionId: 'else' } } })
    expect(view.element.querySelectorAll('article[aria-label$="message"]')).toHaveLength(3)
  })

  test('sends a follow-up with Enter', async () => {
    start([bg], { 'quirky.structured/messages': () => [], 'quirky.structured/send': () => ({ ok: true }) })
    const view = await open({ worktree: WORKTREE.id })
    const textarea = view.element.querySelector('textarea')!
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, ' next ')
      textarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => void textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
    expect(fake.callsTo('quirky.structured/send')[0]!.params).toEqual({ session: 'bg', text: 'next' })
  })

  test('says so when quirky.structured is off', async () => {
    start([bg])
    const view = await open({ worktree: WORKTREE.id })
    expect(view.element.textContent).toContain('Structured sessions are off')
    expect(view.element.querySelector('textarea')).toBeNull()
  })

  describe('when quirky.structured changes while the transcript is open', () => {
    let on: boolean

    const start2 = (initial: boolean) => {
      on = initial
      start([bg], {
        'quirky.structured/messages': () => {
          if (!on) throw new RpcError(RpcErrorCode.MethodNotFound, 'unknown method: quirky.structured/messages')
          return [message(1, 'user', 'hi')]
        }
      })
    }

    test('disabling it shows the off state and removes the input', async () => {
      start2(true)
      const view = await open({ worktree: WORKTREE.id })
      expect(view.element.querySelector('textarea')).not.toBeNull()
      on = false
      await fake.emit({ type: 'plugin.changed' })
      await settle()
      expect(view.element.textContent).toContain('Structured sessions are off')
      expect(view.element.querySelector('textarea')).toBeNull()
    })

    test('enabling it reloads the transcript and enables the input', async () => {
      start2(false)
      const view = await open({ worktree: WORKTREE.id })
      expect(view.element.textContent).toContain('Structured sessions are off')
      on = true
      await fake.emit({ type: 'plugin.changed' })
      await settle()
      expect(fake.callsTo('quirky.structured/messages')).toHaveLength(2)
      expect([...view.element.querySelectorAll('article[aria-label$="message"]')].map((row) => row.textContent)).toEqual(['userhi'])
      expect(view.element.querySelector('textarea')).not.toBeNull()
      expect(view.element.textContent).not.toContain('Structured sessions are off')
    })

    test('a reconnect re-checks too', async () => {
      start2(true)
      const view = await open({ worktree: WORKTREE.id })
      await fake.setConnection('reconnecting')
      on = false
      await fake.setConnection('connected')
      await settle()
      expect(view.element.textContent).toContain('Structured sessions are off')
    })
  })
})

describe('agent status presentation', () => {
  const MIN = 60_000
  const summary = (display: AgentDisplayState, label: string, over: Partial<AgentStatusSummary> = {}): AgentStatusSummary => ({
    state: display === 'done' || display === 'failed' || display === 'interrupted' ? 'done' : 'working',
    display,
    label,
    detail: '',
    progress: null,
    stateStartedAt: Date.now(),
    evidenceAt: Date.now(),
    restoredUnconfirmed: false,
    ...over
  })
  const statusOf = (view: Mounted) =>
    view.element.querySelector('[role="status"] [role="img"]') as HTMLElement | null


  test('a session with no summary keeps its coarse status label and reports no display', async () => {
    const current = session({ id: 's1', status: 'waiting' })
    start([current])
    const view = await open({ worktree: WORKTREE.id })
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('waiting')
    expect(view.tabs()[0]!.textContent).toContain('waiting')
    expect(sessionStatusPresentation(current, Date.now()).status).toBe('needs-you')
    expect((view.lastReport() as { tabs: object[] }).tabs[0]).not.toHaveProperty('display')
  })

  test('the active status indicator follows session events', async () => {
    const s1 = session({ id: 's1', status: 'working', agentStatus: summary('working', 'Working') })
    start([s1])
    const view = await open({ worktree: WORKTREE.id })
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('Working')
    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...s1, status: 'waiting', agentStatus: summary('waiting', 'Waiting for input') } } })
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('Waiting for input')
    await fake.emit({ type: 'quirky.session/changed', data: { session: { ...s1, status: 'done', agentStatus: summary('done', 'Done') } } })
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('Done')
  })

  test('progress remains visible for active states with progress indicators', async () => {
    start([
      session({ id: 's1', status: 'working', agentStatus: summary('working', 'Working', { progress: 60 }) }),
      session({ id: 's2', status: 'waiting', agentStatus: summary('waiting', 'Waiting for input', { progress: 25 }) }),
      session({ id: 's3', status: 'waiting', agentStatus: summary('permission', 'Needs attention', { progress: 70 }) }),
      session({ id: 's4', status: 'working', agentStatus: summary('monitoring', 'Monitoring background tasks', { progress: 50 }) }),
      session({ id: 's5', status: 'done', agentStatus: summary('done', 'Done', { progress: 100 }) })
    ])
    const view = await open({ worktree: WORKTREE.id })
    expect(view.tabs()[0]!.textContent).toContain('60%')
    expect(view.tabs()[1]!.textContent).toContain('25%')
    expect(view.tabs()[2]!.textContent).toContain('70%')
    expect(view.tabs()[3]!.textContent).not.toContain('50%')
    expect(view.tabs()[4]!.textContent).not.toContain('100%')
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('Working')
    expect(view.element.querySelector('[role="status"]')?.textContent).toContain('60%')
  })

  test('an unfinished state with no evidence for 30 minutes becomes stale, while done remains done', async () => {
    const stale = Date.now() - 31 * MIN
    start([
      session({ id: 's1', status: 'working', agentStatus: summary('working', 'Working', { evidenceAt: stale }) }),
      session({ id: 's2', status: 'working', agentStatus: summary('waiting', 'Waiting for input', { evidenceAt: stale, progress: 40 }) }),
      session({ id: 's3', status: 'done', agentStatus: summary('done', 'Done', { evidenceAt: stale }) }),
      session({ id: 's4', status: 'exited', agentStatus: summary('working', 'Working', { evidenceAt: stale }) })
    ])
    const view = await open({ worktree: WORKTREE.id })
    expect(statusOf(view)?.getAttribute('aria-label')).toBe('No recent update')
    expect(view.tabs()[1]!.textContent).toContain('No recent update')
    expect(view.tabs()[2]!.textContent).toContain('Done')
    expect(view.tabs()[3]!.textContent).toContain('Idle')
  })

  test('a one-minute tick shows decay without a session event', async () => {
    const realNow = Date.now
    const realSetInterval = globalThis.setInterval
    const ticks: (() => void)[] = []
    globalThis.setInterval = ((callback: () => void, ms?: number) => {
      if (ms === MIN) {
        ticks.push(callback)
        return 0
      }
      return realSetInterval(callback, ms)
    }) as typeof setInterval
    try {
      const t0 = realNow()
      start([session({ id: 's1', status: 'working', agentStatus: summary('working', 'Working', { evidenceAt: t0 - 29 * MIN }) })])
      const view = await open({ worktree: WORKTREE.id })
      expect(statusOf(view)?.getAttribute('aria-label')).toBe('Working')
      Date.now = () => t0 + 2 * MIN
      await act(async () => ticks.forEach((tick) => tick()))
      expect(statusOf(view)?.getAttribute('aria-label')).toBe('No recent update')
    } finally {
      Date.now = realNow
      globalThis.setInterval = realSetInterval
    }
  })
})
