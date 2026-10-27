import { act } from 'react'
import { RpcError, RpcErrorCode, type QuirkyEvent, type Session, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import type { AgentInfo, AgentListing } from '../../quirky.agents/src/core/types'

type Handler = (params: Record<string, any>) => unknown

export type FakeContext = ReturnType<typeof fakeContext>

export const WORKTREE = { id: 'wt-main', repoId: 'repo-1', path: '/tmp/work/main', branch: 'main', head: 'abc', isMain: true, name: 'main' }

export function session(over: Partial<Session> & Pick<Session, 'id'>): Session {
  return {
    kind: 'terminal',
    agent: 'shell',
    worktreeId: WORKTREE.id,
    cwd: WORKTREE.path,
    title: over.id,
    status: 'running',
    createdAt: 1,
    lastActivityAt: 1,
    exitCode: null,
    exitSignal: null,
    exitCause: null,
    restorable: false,
    ...over
  }
}

/** One catalog agent as `quirky.agents/list` reports it; installed and enabled unless `over` says otherwise. */
export function agentInfo(id: string, label: string, over: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    label,
    plugin: 'quirky.agents',
    installed: true,
    enabled: true,
    isDefault: false,
    promptMode: 'argv',
    resumable: false,
    canFork: false,
    homepage: null,
    install: null,
    command: id,
    commandOverridden: false,
    args: '',
    argsOverridden: false,
    env: {},
    envOverridden: false,
    showEnv: false,
    permissions: { mode: null, hasAuto: false },
    ...over
  }
}

/** A `quirky.agents/list` result holding `agents`, with `defaultAgent` as the default. */
export function agentListing(agents: AgentInfo[], defaultAgent = 'auto'): AgentListing {
  return {
    defaultAgent,
    workspaceTrust: true,
    permissions: { summary: 'manual', nonAuto: 'manual' },
    agents: agents.map((agent) => ({ ...agent, isDefault: agent.id === defaultAgent }))
  }
}

export const DEFAULT_AGENTS = agentListing([agentInfo('claude', 'Claude'), agentInfo('codex', 'Codex'), agentInfo('goose', 'Goose')])

/** A `UiPluginContext` whose daemon calls are served by `handlers`; every other method rejects as unknown. */
export function fakeContext(handlers: Record<string, Handler> = {}, settings: Record<string, unknown> = {}) {
  const calls: { method: string; params: Record<string, any> }[] = []
  const provided = new Map<string, (...args: any[]) => any>()
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const streams = new Map<number, (bytes: Uint8Array) => void>()
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const confirms: { title: string; body?: string; confirmLabel?: string }[] = []
  const state = { confirmAnswer: true }
  const layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }

  const context: UiPluginContext = {
    pluginId: 'quirky.session',
    log() {},
    provide(id, implementation) {
      provided.set(id, implementation as (...args: any[]) => any)
    },
    async call(method, params = {}) {
      calls.push({ method, params })
      const handler = handlers[method]
      if (!handler) throw new RpcError(RpcErrorCode.MethodNotFound, `unknown method: ${method}`)
      return handler(params)
    },
    subscribe(listener) {
      eventListeners.add(listener as (event: QuirkyEvent) => void)
      return () => eventListeners.delete(listener as (event: QuirkyEvent) => void)
    },
    getSetting(name) {
      if (!(name in settings)) throw new Error(`no setting ${name}`)
      return settings[name]
    },
    async executeCommand() {},
    openView(id, input) {
      opened.push({ id, input })
      layout.view = { id, input }
    },
    closeView() {
      layout.view = null
    },
    togglePanel() {},
    getLayout: () => layout,
    onLayout: () => () => {},
    onStream(streamId, listener) {
      streams.set(streamId, listener)
      return () => streams.delete(streamId)
    },
    onConnection(listener) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    async confirm(options) {
      confirms.push(options)
      return state.confirmAnswer
    },
    toast(title, body) {
      toasts.push({ title, body })
    },
    setPanelBadge() {},
    setContext() {},
    mountView: () => () => {}
  }

  return {
    context,
    calls,
    provided,
    opened,
    toasts,
    confirms,
    streams,
    layout,
    state,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    emit: (event: QuirkyEvent) => act(async () => void eventListeners.forEach((listener) => listener(event))),
    setConnection: (status: 'connected' | 'reconnecting') =>
      act(async () => void connectionListeners.forEach((listener) => listener(status))),
    command: (id: string, args?: unknown) => act(async () => void (await provided.get(`command:quirky.session/${id}`)!(args)))
  }
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export type Mounted = Awaited<ReturnType<typeof mountView>>

/** Mounts the session view on a fresh element of the document with `input`. */
export async function mountView(fake: FakeContext, input: unknown, style: Record<string, string> = {}) {
  const element = document.createElement('div')
  for (const [name, value] of Object.entries(style)) element.style.setProperty(name, value)
  document.body.appendChild(element)
  const reports: unknown[] = []
  let unmount: (() => void) | void = undefined
  await act(async () => {
    unmount = fake.provided.get('view:quirky.session/worktree')!(element, { input, report: (state: unknown) => reports.push(state) })
  })
  await settle()
  return {
    element,
    reports,
    lastReport: () => reports[reports.length - 1],
    tabs: () => [...element.querySelectorAll('[role="tab"]')] as HTMLElement[],
    click: (target: Element) => act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true }))),
    unmount: () => act(async () => void (unmount as () => void)())
  }
}

/** The result of `quirky.terminal/attach` for a live session, with `over` applied. */
export function attachResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    streamId: 7,
    replay: '',
    offset: 0,
    historyCursor: null,
    cols: 80,
    rows: 24,
    restored: false,
    shellState: 'unsupported',
    live: true,
    ...over
  }
}

/** Serves the calls the view makes with a worktree, its sessions and the lifecycle methods. */
export function sessionHandlers(sessions: Session[], extra: Record<string, Handler> = {}): Record<string, Handler> {
  return {
    'quirky.worktree/resolve': () => WORKTREE,
    'quirky.session/list': () => sessions,
    'quirky.agents/list': () => DEFAULT_AGENTS,
    'quirky.terminal/attach': () => attachResult(),
    'quirky.terminal/detach': () => ({ ok: true }),
    'quirky.terminal/write': () => ({ ok: true }),
    'quirky.terminal/resize': () => ({ ok: true }),
    ...extra
  }
}
