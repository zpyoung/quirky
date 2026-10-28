import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act, createElement, type ReactNode } from 'react'
import type { Root, createRoot as ReactCreateRoot } from 'react-dom/client'
import type { MobilePageBridge, MobileRoute } from '../src/contracts'
import type { Session } from '@quirky/protocol'
import { validatePageReport, validatePageRpc } from '../src/shell/bridge-policy'
import { validatePanelRoute } from '../src/panels/routes'
import { PAGE_BUNDLE_ROUTES } from '../src/shell/generation'
import { TerminalArtifactsPanel } from '../src/panels/terminal-artifacts'
import { SessionPage } from '../src/pages/SessionPage'
import { PageApp } from '../src/pages/PageApp'

const source = { worktreeId: 'wt-1', sessionId: 'sess-1' }
const artifact = {
  source: 'terminalArtifact' as const,
  artifactId: 'artifact-opaque-1',
  grant: 'grant-old',
  expiresAt: 100,
  worktree: source.worktreeId,
  session: source.sessionId,
  name: 'report.md',
  path: '/tmp/report.md'
}
const textPreview = {
  kind: 'preview' as const,
  artifact,
  format: 'markdown' as const,
  content: '# Report\nOriginal text',
  bytes: 22,
  truncated: false,
  writable: true,
  revision: 'revision-1'
}

let container: HTMLDivElement | null = null
let root: Root | null = null
let createRoot: typeof ReactCreateRoot

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Happy DOM must register before react-dom initializes its DOM host config.
  ;({ createRoot } = await import('react-dom/client'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

afterEach(async () => {
  if (root) await act(async () => root?.unmount())
  root = null
  container?.remove()
  container = null
})

type Call = { method: string; params: Record<string, unknown> }
type ArtifactRpc = <T>(method: string, params: Record<string, unknown>) => Promise<T>
function fakeBridge(route: MobileRoute, rpc: ArtifactRpc, grants = ['rpc', 'navigate'], phase: MobilePageBridge['state']['phase'] = 'connected') {
  const calls: Call[] = []
  const navigations: unknown[] = []
  const stateHandlers = new Set<(state: MobilePageBridge['state']) => void>()
  const bridge = {
    init: {
      v: 1,
      sessionId: 'page-session',
      host: { id: 'host-1', name: 'Desk', endpoint: 'wss://desk.invalid/rpc', publicKeyB64: 'key', lastConnected: 1 },
      route,
      grants,
      preferences: { sessionView: 'terminal', onboardingCompleted: true, notificationChoice: 'disabled', terminalTextScale: 1, autocomplete: false, terminalLinkMode: 'phone', shortcuts: [] },
      connectionState: { phase, attempts: 0 },
      safeArea: { top: 0, right: 0, bottom: 0, left: 0 }
    },
    state: { phase, attempts: 0 },
    async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      calls.push({ method, params })
      return rpc<T>(method, params)
    },
    onEvent: () => () => {},
    onStream: () => () => {},
    onState(handler: (state: MobilePageBridge['state']) => void) {
      stateHandlers.add(handler)
      handler(bridge.state)
      return () => stateHandlers.delete(handler)
    },
    storage: { async get() { return null }, async set() {}, async remove() {} },
    native: { async clipboardRead() { return '' }, async clipboardWrite() {}, async openExternal() {}, async haptic() {} },
    async navigate(next: unknown) { navigations.push(next) },
    report() {},
    close() {}
  } as unknown as MobilePageBridge
  return { bridge, calls, navigations }
}

async function mount(node: ReactNode): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => { root!.render(createElement(() => node)) })
}

async function click(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
}
async function inputValue(selector: string, value: string): Promise<void> {
  const input = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector)
  if (!input) throw new Error(`No field matches ${selector}`)
  await act(async () => {
    const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find((candidate) =>
    candidate.getAttribute('aria-label') === name || candidate.textContent?.trim() === name
  )
  if (!(button instanceof HTMLButtonElement)) throw new Error(`No button named ${name}`)
  return button
}
async function waitForEnabledButton(name: string): Promise<HTMLButtonElement> {
  const until = Date.now() + 1000
  while (Date.now() < until) {
    const button = buttonNamed(name)
    if (!button.disabled) return button
    const { promise, resolve } = Promise.withResolvers<void>()
    setTimeout(resolve, 0)
    await act(async () => { await promise })
  }
  throw new Error(`No enabled button named ${name} after loading the selected session`)
}

const artifactRoute = { kind: 'terminal-artifact' as const, ...source, artifactId: artifact.artifactId, grant: artifact.grant }
const artifactListRoute = { kind: 'terminal-artifacts' as const, ...source }
const routeGrants = (kind: 'terminal-artifacts' | 'terminal-artifact') => PAGE_BUNDLE_ROUTES.find((entry) => entry.kind === kind)!.grants

test('artifact routes reject paths and only authorize methods bound to the selected route and grant', () => {
  expect(validatePanelRoute(artifactListRoute)).toEqual(artifactListRoute)
  expect(validatePanelRoute(artifactRoute)).toEqual(artifactRoute)
  expect(routeGrants('terminal-artifacts')).toEqual(['rpc', 'storage', 'navigate'])
  expect(routeGrants('terminal-artifact')).toEqual(['rpc', 'storage', 'navigate'])
  expect(() => validatePanelRoute({ ...artifactRoute, path: artifact.path })).toThrow()
  expect(() => validatePanelRoute({ ...artifactRoute, grant: '' })).toThrow()

  const call = (route: MobileRoute, params: Record<string, unknown>, grants = routeGrants(route.kind as 'terminal-artifacts' | 'terminal-artifact')) =>
    validatePageRpc('quirky.terminal/artifacts', params, grants, route)
  expect(() => call(artifactListRoute, { action: 'list', worktree: source.worktreeId, session: source.sessionId })).not.toThrow()
  expect(() => call(artifactRoute, { action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: artifact.artifactId, grant: artifact.grant })).not.toThrow()
  expect(() => call(artifactRoute, { action: 'list', worktree: source.worktreeId, session: source.sessionId })).toThrow()
  expect(() => call(artifactListRoute, { action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: artifact.artifactId, grant: artifact.grant })).toThrow()
  expect(() => call(artifactRoute, { action: 'preview', worktree: 'other', session: source.sessionId, artifactId: artifact.artifactId, grant: artifact.grant })).toThrow()
  expect(() => call(artifactRoute, { action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: 'other-artifact', grant: artifact.grant })).toThrow()
  expect(() => call(artifactRoute, { action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: artifact.artifactId, grant: 'foreign-grant' })).toThrow()
  expect(() => validatePageRpc('quirky.terminal/artifacts', { action: 'list', worktree: source.worktreeId, session: source.sessionId }, ['rpc', 'terminal'], { kind: 'session', worktreeId: source.worktreeId, sessionId: source.sessionId })).toThrow()
  expect(() => validatePageRpc('quirky.terminal/artifacts', {
    action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: artifact.artifactId, grant: 'grant-new'
  }, routeGrants('terminal-artifact'), artifactRoute, 'grant-new')).not.toThrow()
  expect(() => validatePageRpc('quirky.terminal/artifacts', {
    action: 'preview', worktree: source.worktreeId, session: source.sessionId, artifactId: artifact.artifactId, grant: artifact.grant
  }, routeGrants('terminal-artifact'), artifactRoute, 'grant-new')).toThrow()
  expect(() => validatePageRpc('quirky.mobile/notificationPoll', {
    subscriptionId: 'poll-1', waitMs: 20_000, onlyWhenDesktopAway: true, suppressWorktree: source.worktreeId
  }, routeGrants('terminal-artifact'), artifactRoute)).not.toThrow()
  expect(() => validatePageRpc('quirky.mobile/notificationCancel', { subscriptionId: 'poll-1' }, routeGrants('terminal-artifact'), artifactRoute)).not.toThrow()
  expect(() => validatePageRpc('quirky.git/status', { worktree: source.worktreeId }, routeGrants('terminal-artifact'), artifactRoute)).toThrow()
  const report = { route: 'terminal-artifact', worktreeId: source.worktreeId, sessionId: source.sessionId, artifactId: artifact.artifactId, connectionPhase: 'connected', stale: false }
  expect(() => validatePageReport(report)).not.toThrow()
  expect(() => validatePageReport({ ...report, grant: artifact.grant })).toThrow()
})

test('Session More actions opens artifacts for the exact selected terminal session', async () => {
  const session: Session = {
    id: source.sessionId, kind: 'terminal', agent: 'shell', worktreeId: source.worktreeId, cwd: '/work', title: 'Shell', status: 'running',
    createdAt: 1, lastActivityAt: 1, exitCode: null, exitSignal: null, exitCause: null, restorable: false
  }
  const otherSession: Session = { ...session, id: 'sess-other', title: 'Other shell' }
  const { bridge, navigations } = fakeBridge({ kind: 'session', ...source }, async <T,>(method) => {
    if (method === 'quirky.session/list') return [otherSession, session] as T
    if (method === 'quirky.ask/list' || method === 'quirky.worktree/list' || method === 'quirky.mobile/sessionTabs') return [] as T
    throw new Error(`Unexpected RPC ${method}`)
  }, ['rpc', 'navigate'])
  await mount(createElement(SessionPage, { bridge, route: { kind: 'session', ...source }, connected: true, onNavigate: async (route) => { navigations.push(route) }, onReport() {} }))

  await click(buttonNamed('More session actions'))
  await click(await waitForEnabledButton('Terminal artifacts'))

  expect(navigations).toEqual([artifactListRoute])
})

test('Session actions disable terminal artifacts when no terminal is selected', async () => {
  const { bridge, navigations } = fakeBridge({ kind: 'session', worktreeId: source.worktreeId }, async <T,>(method) => {
    if (method === 'quirky.session/list' || method === 'quirky.ask/list' || method === 'quirky.worktree/list' || method === 'quirky.mobile/sessionTabs') return [] as T
    throw new Error(`Unexpected RPC ${method}`)
  })
  await mount(createElement(SessionPage, {
    bridge,
    route: { kind: 'session', worktreeId: source.worktreeId },
    connected: true,
    onNavigate: async (route) => { navigations.push(route) },
    onReport() {}
  }))

  await click(buttonNamed('More session actions'))
  expect(buttonNamed('Terminal artifacts').disabled).toBe(true)
  expect(navigations).toHaveLength(0)
})

test('artifact list opens a capability route without forwarding its absolute path', async () => {
  const { bridge, calls, navigations } = fakeBridge(artifactListRoute, async <T,>(method) => {
    if (method === 'quirky.terminal/artifacts') return { kind: 'listed', artifacts: [artifact], limited: false } as T
    throw new Error(`Unexpected RPC ${method}`)
  })
  await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactListRoute }))

  await click(buttonNamed(artifact.name))

  expect(calls).toEqual([{ method: 'quirky.terminal/artifacts', params: { action: 'list', worktree: source.worktreeId, session: source.sessionId } }])
  expect(navigations).toContainEqual(artifactRoute)
})

test('save advances only to the returned revision while a conflict preserves the edited draft', async () => {
  const { bridge, calls } = fakeBridge(artifactRoute, async <T,>(_method, params) => {
    if (params.action === 'preview') return textPreview as T
    if (params.action === 'save' && params.expectedRevision === 'revision-1') return { kind: 'saved', artifact, revision: 'revision-2' } as T
    if (params.action === 'save' && params.expectedRevision === 'revision-2') return { kind: 'refused', reason: 'file-changed', guidance: 'Reload the artifact before saving.' } as T
    throw new Error('Unexpected artifact request')
  })
  await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactRoute }))
  await click(buttonNamed('Edit draft'))
  await inputValue('textarea[aria-label="Terminal artifact draft"]', 'first edit')
  await click(buttonNamed('Save terminal artifact'))
  expect(document.body.textContent).toContain('10 B')
  await inputValue('textarea[aria-label="Terminal artifact draft"]', 'second edit')
  await click(buttonNamed('Save terminal artifact'))

  const saves = calls.filter((call) => call.params.action === 'save')
  expect(saves.map((call) => call.params.expectedRevision)).toEqual(['revision-1', 'revision-2'])
  expect(saves[1]?.params.content).toBe('second edit')
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal artifact draft"]')?.value).toBe('second edit')
  expect(document.body.textContent).toContain('file-changed')
})

test('expired grants refresh authorization without previewing or adopting a newer revision', async () => {
  const refreshed = { ...artifact, grant: 'grant-new', expiresAt: 200 }
  const { bridge, calls } = fakeBridge(artifactRoute, async <T,>(_method, params) => {
    if (params.action === 'preview') return textPreview as T
    if (params.action === 'save') return { kind: 'refused', reason: 'grant-expired', guidance: 'Refresh authorization.' } as T
    if (params.action === 'refresh') return { kind: 'refreshed', artifact: refreshed } as T
    throw new Error('Unexpected artifact request')
  })
  await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactRoute }))
  await click(buttonNamed('Edit draft'))
  await inputValue('textarea[aria-label="Terminal artifact draft"]', 'keep this draft')
  await click(buttonNamed('Save terminal artifact'))
  await click(buttonNamed('Refresh authorization'))
  await click(buttonNamed('Save terminal artifact'))

  expect(calls.filter((call) => call.params.action === 'preview')).toHaveLength(1)
  const saves = calls.filter((call) => call.params.action === 'save')
  expect(saves.map((call) => [call.params.grant, call.params.expectedRevision, call.params.content])).toEqual([
    ['grant-old', 'revision-1', 'keep this draft'],
    ['grant-new', 'revision-1', 'keep this draft']
  ])
  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal artifact draft"]')?.value).toBe('keep this draft')
})

test('disconnected artifact details do not issue reads, refreshes, or saves', async () => {
  const { bridge, calls } = fakeBridge(artifactRoute, async <T,>() => { throw new Error('Disconnected RPC must not run') }, ['rpc', 'navigate'], 'disconnected')
  await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactRoute }))

  expect(document.body.textContent).toContain('Desktop disconnected')
  expect(buttonNamed('Save terminal artifact').disabled).toBe(true)
  expect(buttonNamed('Reload content').disabled).toBe(true)
  expect(buttonNamed('Refresh authorization').disabled).toBe(true)
  expect(calls).toEqual([])
})

test('binary, invalid-text metadata and truncated previews cannot be saved', async () => {
  for (const preview of [
    { ...textPreview, format: 'binary' as const, writable: false, content: '' },
    { ...textPreview, format: 'text' as const, truncated: true, writable: false }
  ]) {
    const { bridge } = fakeBridge(artifactRoute, async <T,>() => preview as T)
    await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactRoute }))
    expect(buttonNamed('Save terminal artifact').disabled).toBe(true)
    expect(document.body.textContent).toMatch(/read.only|truncated|binary|UTF-8/i)
    await act(async () => root?.unmount())
    root = null
    container?.remove()
    container = null
  }
})

test('canceling a dirty content reload retains the draft', async () => {
  const { bridge } = fakeBridge(artifactRoute, async <T,>(_method, params) => {
    if (params.action === 'preview') return textPreview as T
    throw new Error('Unexpected artifact request')
  })
  await mount(createElement(TerminalArtifactsPanel, { bridge, route: artifactRoute }))
  await click(buttonNamed('Edit draft'))
  await inputValue('textarea[aria-label="Terminal artifact draft"]', 'unsaved phone draft')
  await click(buttonNamed('Reload content'))
  await click(buttonNamed('Cancel reload'))

  expect(document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Terminal artifact draft"]')?.value).toBe('unsaved phone draft')
})

test('shared header and artifact Back both confirm before leaving a dirty draft', async () => {
  const { bridge, navigations } = fakeBridge(artifactRoute, async <T,>(method, params) => {
    if (method === 'quirky.terminal/artifacts' && params.action === 'preview') return textPreview as T
    if (method === 'quirky.session/list' || method === 'quirky.ask/list' || method === 'quirky.worktree/list') return [] as T
    throw new Error(`Unexpected RPC ${method}`)
  })
  await mount(createElement(PageApp, { bridge }))
  await click(buttonNamed('Edit draft'))
  await inputValue('textarea[aria-label="Terminal artifact draft"]', 'keep me until confirmed')

  await click(buttonNamed('Back to terminal session'))
  await click(buttonNamed('Stay on artifact'))
  expect(navigations).toHaveLength(0)

  await click(buttonNamed('Back to session'))
  await click(buttonNamed('Discard and continue'))
  expect(navigations).toContainEqual({ kind: 'session', worktreeId: source.worktreeId, sessionId: source.sessionId })
})
