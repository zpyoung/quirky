import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { PanelState, SessionInfo } from '../src/types'

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>
type Mount = (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void

const mountedDisposers: (() => void)[] = []
function makeContext(handlers: Record<string, Handler> = {}) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const provided = new Map<string, (...args: unknown[]) => unknown>()
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  const opened: { id: string; input?: unknown }[] = []
  const commands: { id: string; args?: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const context: UiPluginContext = {
    pluginId: 'quirky.session-info',
    log() {},
    provide(id, implementation) { provided.set(id, implementation as (...args: unknown[]) => unknown) },
    async call(method, params = {}) {
      const args = params as Record<string, unknown>
      calls.push({ method, params: args })
      const handler = handlers[method]
      if (!handler) throw new Error(`unexpected call ${method}`)
      return handler(args)
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    getSetting() { throw new Error('no settings') },
    async executeCommand(id, args) {
      commands.push({ id, args })
      const handler = provided.get(id)
      if (handler) await handler(args)
    },
    openView(id, input) { opened.push({ id, input }) },
    closeView() {},
    togglePanel() {},
    getLayout() { return { view: null, panel: null, sidebar: true, focus: null } },
    onLayout() { return () => {} },
    onStream() { return () => {} },
    onConnection() { return () => {} },
    async confirm() { return true },
    toast(title, body) { toasts.push({ title, body }) },
    setPanelBadge() {},
    setContext() {},
    mountView() { return () => {} }
  }
  return {
    context,
    calls,
    provided,
    opened,
    commands,
    toasts,
    listenerCount: () => listeners.size,
    emit(event: QuirkyEvent) { return act(async () => { for (const listener of listeners) await listener(event) }) },
    mount(id: string, input?: unknown) {
      const element = document.createElement('div')
      document.body.appendChild(element)
      const reports: unknown[] = []
      let unmount: (() => void) | void
      const implementation = provided.get(id)
      if (!implementation) throw new Error(`missing mount ${id}`)
      act(() => { unmount = (implementation as Mount)(element, { input, report: (state) => reports.push(state) }) })
      const dispose = () => act(() => {
        const cleanup = unmount
        unmount = undefined
        if (cleanup) cleanup()
      })
      mountedDisposers.push(dispose)
      return { element, reports, unmount: dispose }
    },
    async run(id: string, args?: unknown) {
      const handler = provided.get(`command:quirky.session-info/${id}`)
      if (!handler) throw new Error(`missing command ${id}`)
      return await handler(args)
    }
  }
}

function info(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    identity: {
      agent: 'claude', sessionId: 'quirky-1', providerSessionId: 'provider-1', model: 'Claude Sonnet', pane: 'pane-1',
      paneTitle: 'Claude ready', worktreeId: 'wt-main', cwd: '/repo', startedAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000,
      transcriptPath: '/tmp/session.jsonl'
    },
    liveActivity: { state: 'working', label: 'Working', toolName: 'Read', toolInput: 'src/index.ts', subagentCount: 2, startedAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000 },
    ...over
  }
}

function state(value: SessionInfo | null, over: Partial<PanelState> = {}): PanelState {
  return { session: value?.identity.sessionId ?? null, pane: value?.identity.pane ?? null, workspace: value ? 'wt-main' : null, openSections: ['liveActivity'], info: value, ...over }
}

const waitForUi = () => act(async () => {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, 0)
  await promise
})
const click = (element: Element) => act(async () => { element.dispatchEvent(new MouseEvent('click', { bubbles: true })) })
const fillInput = (input: HTMLInputElement, value: string) => act(async () => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  if (!setter) throw new Error('HTMLInputElement value setter is unavailable')
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})
const button = (root: ParentNode, name: string) => root.querySelector(`button[aria-label="${name}"]`) as HTMLButtonElement

let activate: (context: UiPluginContext) => void

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // React DOM caches DOM availability at import, so initialize it after happy-dom installs globals.
  ;({ activate } = await import('../src/ui'))
})
afterAll(async () => { await GlobalRegistrator.unregister() })
afterEach(() => {
  for (const dispose of mountedDisposers.splice(0)) dispose()
  document.body.innerHTML = ''
})

describe('Session Info UI contributions', () => {
  test('registers the fixed panel, views, and routed commands', () => {
    const fake = makeContext()
    activate(fake.context)
    expect([...fake.provided.keys()].sort()).toEqual([
      'command:quirky.session-info/copy-id', 'command:quirky.session-info/copy-resume-command', 'command:quirky.session-info/focus-pane',
      'command:quirky.session-info/fork', 'command:quirky.session-info/open', 'command:quirky.session-info/open-history',
      'command:quirky.session-info/open-transcript', 'command:quirky.session-info/resume', 'command:quirky.session-info/reveal-transcript',
      'panel:quirky.session-info/info', 'view:quirky.session-info/history', 'view:quirky.session-info/transcript'
    ])
  })

  test('shows the no-agent guidance without leaking the last agent projection', async () => {
    const fake = makeContext({
      'quirky.session-info/get': () => state(null),
      'quirky.session-info/sections': () => ({ open: ['liveActivity'] })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    expect(panel.element.textContent).toContain('No agent session')
    expect(panel.element.textContent).toContain('Focus a terminal pane with an agent session to inspect it here.')
    expect(panel.element.textContent).not.toContain('Claude Sonnet')
    expect(panel.reports.at(-1)).toMatchObject({ session: null, state: 'empty' })
    panel.unmount()
  })

  test('renders multiple accessible sections, preserves interrupted states, and applies context thresholds', async () => {
    let usedPercentage = 59
    const currentInfo = () => info({
      liveActivity: { state: 'done', label: 'Interrupted', toolName: 'Bash', toolInput: 'sleep 5', subagentCount: 0, startedAt: 1_700_000_000_000, updatedAt: 1_700_000_060_000 },
      usage: { status: 'ready', freshness: 'stale', totalTokens: 1200, turnCount: 2, input: 300, output: 500, cacheRead: 200, cacheWrite: 200, updatedAt: 1_700_000_060_000, error: 'scan failed' },
      context: { status: 'ready', usedPercentage, remainingPercentage: 100 - usedPercentage, window: 200_000, used: 118_000, remaining: 82_000, estimated: true, updatedAt: 1_700_000_060_000 },
      filesTouched: { added: 12, removed: 4, updatedAt: 1_700_000_060_000 }
    })
    const fake = makeContext({
      'quirky.session-info/get': () => state(currentInfo(), { openSections: ['liveActivity', 'identity', 'context'] }),
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    expect(panel.element.textContent).toContain('Session Info')
    expect(panel.element.textContent).toContain('Claude Sonnet')
    expect(panel.element.textContent).toContain('59% context used')
    expect(panel.element.querySelector('[data-context-threshold="muted"]')).not.toBeNull()
    expect(panel.element.textContent).toContain('Interrupted')
    expect(panel.element.textContent).toContain('Stale')
    expect(panel.element.textContent).toContain('Lines added')
    expect(button(panel.element, 'Identity').getAttribute('aria-expanded')).toBe('true')
    expect(button(panel.element, 'Context').getAttribute('aria-controls')).toBeTruthy()

    usedPercentage = 60
    await fake.emit({ type: 'quirky.session-info/changed', data: { sessionId: 'quirky-1' } })
    await waitForUi()
    expect(panel.element.querySelector('[data-context-threshold="strong"]')).not.toBeNull()
    usedPercentage = 80
    await fake.emit({ type: 'quirky.session-info/changed', data: { sessionId: 'quirky-1' } })
    await waitForUi()
    expect(panel.element.querySelector('[data-context-threshold="danger"]')).not.toBeNull()

    await click(button(panel.element, 'Usage'))
    await waitForUi()
    expect(fake.calls.at(-1)).toMatchObject({ method: 'quirky.session-info/sections', params: { open: ['liveActivity', 'identity', 'context', 'usage'] } })
    panel.unmount()
  })

  test('retains stale Usage on retry failure and recovers with Hooks & MCP closed', async () => {
    let currentUsage: NonNullable<SessionInfo['usage']> = {
      status: 'ready', freshness: 'stale', totalTokens: 100, turnCount: 2, input: 70, output: 20, cacheRead: 5, cacheWrite: 5,
      updatedAt: 1_700_000_060_000, error: 'ENOENT: transcript missing'
    }
    const firstInspection = Promise.withResolvers<unknown>()
    let inspectCount = 0
    const fake = makeContext({
      'quirky.session-info/get': () => state(info({ usage: currentUsage }), { openSections: ['liveActivity', 'usage'] }),
      'quirky.session-info/inspect': () => {
        inspectCount++
        if (inspectCount === 1) {
          currentUsage = { ...currentUsage, freshness: 'stale', error: 'ENOENT: transcript missing' }
          return firstInspection.promise
        }
        currentUsage = {
          status: 'ready', freshness: 'fresh', totalTokens: 200, turnCount: 3, input: 120, output: 40, cacheRead: 30, cacheWrite: 10,
          updatedAt: 1_700_000_060_001
        }
        return {
          hooks: { state: 'installed', detail: 'Hooks ready' },
          statusline: { state: 'available', detail: 'Custom statusline detected' },
          mcp: [], updatedAt: 1_700_000_060_001
        }
      },
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()

    const usage = () => panel.element.querySelector('#session-info-section-usage') as HTMLElement
    expect(usage().textContent).toContain('100')
    expect(usage().textContent).toContain('ENOENT: transcript missing')
    expect(button(panel.element, 'Hooks & MCP').getAttribute('aria-expanded')).toBe('false')
    expect(inspectCount).toBe(0)

    await click(button(panel.element, 'Retry usage'))
    await waitForUi()
    expect(button(panel.element, 'Retry usage').disabled).toBe(true)
    expect(usage().textContent).toContain('Refreshing usage…')
    expect(usage().textContent).toContain('100')

    firstInspection.resolve({
      hooks: { state: 'installed', detail: 'Hooks ready' },
      statusline: { state: 'available', detail: 'Custom statusline detected' },
      mcp: [], updatedAt: 1_700_000_060_001
    })
    await waitForUi()

    expect(inspectCount).toBe(1)
    expect(button(panel.element, 'Hooks & MCP').getAttribute('aria-expanded')).toBe('false')
    expect(usage().textContent).toContain('100')
    expect(usage().textContent).toContain('ENOENT: transcript missing')
    expect(button(panel.element, 'Retry usage').disabled).toBe(false)

    await click(button(panel.element, 'Retry usage'))
    await waitForUi()

    expect(inspectCount).toBe(2)
    expect(button(panel.element, 'Hooks & MCP').getAttribute('aria-expanded')).toBe('false')
    expect(usage().textContent).toContain('200')
    expect(usage().textContent).not.toContain('100')
    expect(usage().textContent).not.toContain('Stale')
    expect(usage().textContent).not.toContain('ENOENT')
    expect(usage().textContent).not.toContain('Refreshing usage…')
    panel.unmount()
  })

  test('keeps waiting values absent and shows actionable Retry errors', async () => {
    let attempts = 0
    const fake = makeContext({
      'quirky.session-info/get': () => {
        attempts++
        if (attempts === 1) throw new Error('daemon unavailable')
        return state(info({ context: { status: 'waiting' }, usage: { status: 'waiting' } }))
      },
      'quirky.session-info/sections': ({ open }) => ({ open })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    expect(panel.element.textContent).toContain('daemon unavailable')
    await click(button(panel.element, 'Retry'))
    await waitForUi()
    await click(button(panel.element, 'Usage'))
    await click(button(panel.element, 'Context'))
    await waitForUi()
    expect(panel.element.textContent).toContain('Waiting for the first completed turn')
    expect(panel.element.textContent).toContain('Waiting for the first statusline update')
    expect(panel.element.textContent).not.toContain('0 tokens')
    panel.unmount()
  })

  test('inspects Hooks & MCP lazily, renders consent, and explains its next-launch effect', async () => {
    const projection = info()
    let inspectCount = 0
    const fake = makeContext({
      'quirky.session-info/get': () => state(projection, { openSections: ['liveActivity'] }),
      'quirky.session-info/sections': ({ open }) => ({ open }),
      'quirky.session-info/inspect': () => {
        inspectCount++
        return { hooks: { state: 'installed', detail: 'Hooks ready' }, statusline: { state: 'available', detail: 'Custom statusline detected' }, mcp: [], updatedAt: 1_700_000_060_000 }
      },
      'quirky.session-info/enableTelemetry': ({ enabled }) => enabled === false
        ? ({ statusline: { state: 'disabled' }, nextLaunchEffect: 'Telemetry will be disabled on the next launch.' })
        : ({ statusline: { state: 'chained' }, nextLaunchEffect: 'Applies on the next launch.' })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    expect(inspectCount).toBe(0)
    await click(button(panel.element, 'Hooks & MCP'))
    await waitForUi()
    expect(inspectCount).toBe(1)
    expect(panel.element.textContent).toContain('Custom statusline detected')
    expect(panel.element.textContent).toContain('No configured servers found')
    await click(button(panel.element, 'Retry'))
    await waitForUi()
    expect(inspectCount).toBe(2)
    await click(button(panel.element, 'Enable session telemetry'))
    await waitForUi()
    expect(fake.calls.at(-1)).toMatchObject({ method: 'quirky.session-info/enableTelemetry', params: { session: 'quirky-1', enabled: true } })
    expect(panel.element.textContent).toContain('next launch')
    await click(button(panel.element, 'Disable session telemetry'))
    await waitForUi()
    expect(fake.calls.at(-1)).toMatchObject({ method: 'quirky.session-info/enableTelemetry', params: { session: 'quirky-1', enabled: false } })
    panel.unmount()
  })
  test('does not let an older pull replace focus-invalidated data and releases event listeners', async () => {
    const firstPull = Promise.withResolvers<PanelState>()
    let pulls = 0
    const focused = info({ identity: { ...info().identity, sessionId: 'focused-session', model: 'Focused model' } })
    const fake = makeContext({
      'quirky.session-info/get': () => ++pulls === 1 ? firstPull.promise : state(focused),
      'quirky.session-info/sections': () => ({ open: ['liveActivity'] })
    })
    activate(fake.context)
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    expect(pulls).toBe(1)
    await fake.emit({ type: 'quirky.terminal/focusContextChanged', data: { workspace: 'wt-main' } })
    await fake.emit({ type: 'quirky.terminal/focusContextChanged', data: { workspace: 'wt-main' } })
    firstPull.resolve(state(info({ identity: { ...info().identity, sessionId: 'stale-session', model: 'Stale model' } })))
    await waitForUi()
    expect(pulls).toBe(2)
    expect(panel.element.textContent).toContain('Focused model')
    expect(panel.element.textContent).not.toContain('Stale model')
    panel.unmount()
    expect(fake.listenerCount()).toBe(0)
  })
})

describe('Session Info routed actions and views', () => {
  test('shows Copy ID feedback only after provider-ID clipboard writes succeed and routes history by provider ID', async () => {
    let failClipboard = true
    const writes: string[] = []
    const fake = makeContext({
      'quirky.session-info/get': ({ session }) => state(info({ identity: { ...info().identity, sessionId: typeof session === 'string' ? session : 'quirky-1' } }))
    })
    activate(fake.context)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { if (failClipboard) throw new Error('clipboard denied'); writes.push(text) } }
    })
    const panel = fake.mount('panel:quirky.session-info/info')
    await waitForUi()
    await click(button(panel.element, 'Copy ID'))
    await waitForUi()
    expect(button(panel.element, 'Copy ID').textContent).toBe('Copy ID')
    expect(panel.element.textContent).toContain('clipboard denied')
    expect(fake.toasts.at(-1)?.title).toMatch(/copy/i)

    failClipboard = false
    await click(button(panel.element, 'Copy ID'))
    await waitForUi()
    expect(writes).toEqual(['provider-1'])
    expect(button(panel.element, 'Copy ID').textContent).toBe('Copied')
    await act(async () => { await Bun.sleep(1500) })
    expect(button(panel.element, 'Copy ID').textContent).toBe('Copy ID')
    await fake.run('open-history', { session: 'quirky-1' })
    expect(fake.opened.at(-1)).toEqual({ id: 'view:quirky.session-info/history', input: { query: 'provider-1' } })
    panel.unmount()
  })
  test('focuses the exact pane, opens transcript read-only, and reveals only the recorded path', async () => {
    const fake = makeContext({
      'quirky.session-info/get': () => state(info()),
      'quirky.terminal/openExternal': () => ({ ok: true })
    })
    activate(fake.context)
    await fake.run('focus-pane', { session: 'quirky-1' })
    expect(fake.commands).toContainEqual({ id: 'command:quirky.terminal/focus-pane', args: { pane: 'pane-1', workspace: 'wt-main' } })
    await fake.run('open-transcript', { session: 'quirky-1' })
    expect(fake.opened.at(-1)).toEqual({ id: 'view:quirky.session-info/transcript', input: { session: 'quirky-1' } })
    await fake.run('reveal-transcript', { session: 'quirky-1' })
    expect(fake.calls).toContainEqual({ method: 'quirky.terminal/openExternal', params: { target: '/tmp/session.jsonl', reveal: true } })
  })

  test('renders history search results and session resume errors', async () => {
    const sessions = [
      { id: 'q1', kind: 'terminal', agent: 'claude', worktreeId: 'wt', cwd: '/repo', title: 'First', status: 'done', createdAt: 1, lastActivityAt: 2, exitCode: 0, exitSignal: null, exitCause: null, restorable: false, launch: null, providerSession: { id: 'provider-1', transcriptPath: null } },
      { id: 'q2', kind: 'terminal', agent: 'codex', worktreeId: 'wt', cwd: '/repo', title: 'Two', status: 'done', createdAt: 2, lastActivityAt: 3, exitCode: 0, exitSignal: null, exitCause: null, restorable: false, launch: null, providerSession: { id: 'provider-2', transcriptPath: null } }
    ]
    const fake = makeContext({
      'quirky.session-info/history': ({ query }) => {
        const normalized = typeof query === 'string' ? query.trim().toLowerCase() : ''
        return sessions.filter((session) =>
          !normalized || [session.id, session.title, session.providerSession.id].some((value) => value.toLowerCase().includes(normalized))
        )
      },
      'quirky.session/resume': () => { throw new Error('cannot resume this session') }
    })
    activate(fake.context)
    const history = fake.mount('view:quirky.session-info/history', { query: 'provider-1' })
    await waitForUi()
    expect(history.element.textContent).toContain('First')
    expect(history.element.textContent).not.toContain('Two')
    await click(button(history.element, 'Resume q1'))
    await waitForUi()
    expect(history.element.textContent).toContain('cannot resume this session')
    const search = history.element.querySelector('input[aria-label="Search session history"]') as HTMLInputElement
    await fillInput(search, 'two')
    await waitForUi()
    expect(history.element.textContent).toContain('Two')
    expect(history.element.textContent).not.toContain('First')
    history.unmount()
  })

  test('copy-resume-command uses its public method and resume/fork place the returned session in a pane', async () => {
    const fake = makeContext({
      'quirky.session-info/get': () => state(info()),
      'quirky.session-info/resumeCommand': ({ fork }) => ({ command: fork ? 'claude --fork-session' : 'claude --resume provider-1' }),
      'quirky.session/resume': ({ session, fork }) => ({ id: `${String(session)}-new`, kind: 'terminal', agent: 'claude', worktreeId: 'wt-main', cwd: '/repo', title: 'Claude', status: 'starting', createdAt: 3, lastActivityAt: 3, exitCode: null, exitSignal: null, exitCause: null, restorable: true, launch: null, providerSession: null, ...(fork ? { fork: true } : {}) })
    })
    activate(fake.context)
    const writes: string[] = []
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => writes.push(text) } })
    await fake.run('copy-resume-command', { session: 'quirky-1' })
    expect(fake.calls).toContainEqual({ method: 'quirky.session-info/resumeCommand', params: { session: 'quirky-1' } })
    expect(writes).toEqual(['claude --resume provider-1'])
    await fake.run('resume', { session: 'quirky-1' })
    await fake.run('fork', { session: 'quirky-1' })
    expect(fake.calls.filter((call) => call.method === 'quirky.session/resume')).toEqual([
      { method: 'quirky.session/resume', params: { session: 'quirky-1' } },
      { method: 'quirky.session/resume', params: { session: 'quirky-1', fork: true } }
    ])
    expect(fake.commands).toEqual([
      { id: 'command:quirky.terminal/open-session', args: { session: 'quirky-1-new', workspace: 'wt-main' } },
      { id: 'command:quirky.terminal/open-session', args: { session: 'quirky-1-new', workspace: 'wt-main' } }
    ])
  })

  test('transcript view displays daemon-provided text without an editable control and reports read errors', async () => {
    const fake = makeContext({
      'quirky.session-info/transcript': ({ session }) => {
        if (session === 'bad') throw new Error('transcript is unreadable')
        return { path: '/tmp/session.jsonl', text: '{"type":"assistant"}\nTranscript body' }
      }
    })
    activate(fake.context)
    const view = fake.mount('view:quirky.session-info/transcript', { session: 'good' })
    await waitForUi()
    expect(view.element.textContent).toContain('Transcript body')
    expect(view.element.querySelector('textarea,input')).toBeNull()
    view.unmount()
    const broken = fake.mount('view:quirky.session-info/transcript', { session: 'bad' })
    await waitForUi()
    expect(broken.element.textContent).toContain('transcript is unreadable')
    broken.unmount()
  })
})
