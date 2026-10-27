import { act } from 'react'
import { RpcError, RpcErrorCode, type QuirkyEvent, type UiLayout, type UiPluginContext } from '@quirky/protocol'
import manifest from '../../quirky-plugin.json'
import type { AgentInfo, AgentListing, PermissionMode } from '../../src/core/types'

type Handler = (params: Record<string, any>) => unknown

export type FakeContext = ReturnType<typeof fakeContext>

export const VIEW_ID = 'view:quirky.agents/settings'
export const SESSION_VIEW_ID = 'view:quirky.session/worktree'

/** A `UiPluginContext` whose daemon calls are served by `handlers`; every other method rejects as unknown. */
export function fakeContext(handlers: Record<string, Handler> = {}) {
  const calls: { method: string; params: Record<string, any> }[] = []
  const provided = new Map<string, (...args: any[]) => any>()
  const eventListeners = new Set<(event: QuirkyEvent) => void>()
  const connectionListeners = new Set<(status: 'connected' | 'reconnecting') => void>()
  const opened: { id: string; input: unknown }[] = []
  const toasts: { title: string; body: string }[] = []
  const layout: UiLayout = { view: null, panel: null, sidebar: true, focus: null }

  const context: UiPluginContext = {
    pluginId: 'quirky.agents',
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
    getSetting() {
      throw new Error('no settings in this fake')
    },
    async executeCommand() {},
    createCommandDrag() {
      throw new Error('command dragging is unavailable in this fake')
    },
    consumeCommandDrag() {
      return null
    },
    cancelCommandDrag() {},
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
    onStream: () => () => {},
    onConnection(listener) {
      connectionListeners.add(listener)
      return () => connectionListeners.delete(listener)
    },
    async confirm() {
      return true
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
    layout,
    callsTo: (method: string) => calls.filter((call) => call.method === method),
    emit: (event: QuirkyEvent) => act(async () => void eventListeners.forEach((listener) => listener(event))),
    dispatch: (event: QuirkyEvent) => void eventListeners.forEach((listener) => listener(event)),
    setConnection: (status: 'connected' | 'reconnecting') =>
      act(async () => void connectionListeners.forEach((listener) => listener(status))),
    command: (id: string, args?: unknown) => act(async () => void (await provided.get(`command:quirky.agents/${id}`)!(args)))
  }
}

export async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

export type Mounted = Awaited<ReturnType<typeof mountSettings>>

/** Mounts the Agents view on a fresh element of the document. */
export async function mountSettings(fake: FakeContext) {
  const element = document.createElement('div')
  document.body.appendChild(element)
  let unmount: (() => void) | void = undefined
  await act(async () => {
    unmount = fake.provided.get(VIEW_ID)!(element, { input: undefined, report: () => {} })
  })
  await settle()
  const q = (selector: string) => element.querySelector(selector) as HTMLElement | null
  const byText = (selector: string, text: string, root: ParentNode = element) =>
    ([...root.querySelectorAll(selector)] as HTMLElement[]).find((node) => node.textContent?.trim() === text) ?? null
  return {
    element,
    q,
    byText,
    text: () => element.textContent ?? '',
    row: (id: string) => q(`[data-agent="${id}"]`),
    button: (name: string, root: ParentNode = element) =>
      ([...root.querySelectorAll('button')] as HTMLElement[]).find((node) => node.textContent?.trim() === name || node.getAttribute('aria-label') === name) ?? null,
    click: (target: Element | null) => {
      if (!target) throw new Error('nothing to click')
      return act(async () => void target.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    },
    type: async (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      await act(async () => {
        const proto = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
        Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(field, value)
        field.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    key: (field: Element, key: string) =>
      act(async () => void field.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))),
    blur: (field: HTMLElement) =>
      act(async () => {
        field.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
        field.dispatchEvent(new FocusEvent('blur'))
      }),
    unmount: () => act(async () => void (unmount as () => void)())
  }
}

type Spec = { yolo?: string; yoloEnv?: Record<string, string>; auto?: string }

// the agents with permission control in the fixture: claude and claude-agent-teams (with Auto), codex (with Auto), goose (environment only)
const SPECS: Record<string, Spec> = {
  claude: { yolo: '--dangerously-skip-permissions', auto: '--permission-mode auto' },
  'claude-agent-teams': { yolo: '--dangerously-skip-permissions', auto: '--permission-mode auto' },
  codex: { yolo: '--dangerously-bypass-approvals-and-sandbox', auto: '--approve-for-me' },
  goose: { yoloEnv: { GOOSE_MODE: 'auto' } }
}

type State = { enabled: boolean; command: string | null; args: string | null; env: Record<string, string> | null }

export const AGENT_IDS: string[] = manifest.contributes.agent.map((entry) => entry.id)

/**
 * An in-memory `quirky.agents` that answers the methods the Agents view calls, with the
 * permission rules the real service applies, and announces each change as an event.
 */
export class FakeAgents {
  default = 'auto'
  trust = true
  failNextRefresh: Error | null = null
  refreshGate: Promise<void> | null = null
  private states = new Map<string, State>()
  private onChange: () => void = () => {}

  constructor(public installed: string[] = ['claude', 'claude-agent-teams', 'codex', 'goose']) {
    for (const id of AGENT_IDS) this.states.set(id, { enabled: true, command: null, args: null, env: null })
  }

  announce(listener: () => void): void {
    this.onChange = listener
  }

  handlers(): Record<string, Handler> {
    return {
      'quirky.agents/list': () => this.listing(),
      'quirky.agents/get': (params) => this.info(this.known(params.agent)),
      'quirky.agents/refresh': async () => {
        await this.refreshGate
        if (this.failNextRefresh) throw this.failNextRefresh
        return this.listing()
      },
      'quirky.agents/setEnabled': (params) => {
        const state = this.state(params.agent)
        state.enabled = params.enabled
        if (!state.enabled && this.default === params.agent) this.default = 'auto'
        this.onChange()
        return this.info(params.agent)
      },
      'quirky.agents/setDefault': (params) => {
        if (params.agent !== 'auto' && params.agent !== 'shell') this.state(params.agent)
        this.default = params.agent
        this.onChange()
        return this.listing()
      },
      'quirky.agents/configure': (params) => this.configure(params),
      'quirky.agents/setPermissions': (params) => this.setPermissions(params),
      'quirky.agents/pick': (params) => {
        const usable = (id: string) => this.installed.includes(id) && this.states.get(id)!.enabled
        const preferred = usable(this.default) ? this.default : null
        const agent = preferred ?? AGENT_IDS.find(usable)
        if (!agent) throw new RpcError(RpcErrorCode.InvalidParams, 'No installed agent is enabled.')
        return { agent, forAgentTab: params.forAgentTab }
      },
      'setting.set': (params) => {
        if (params.id !== 'setting:quirky.agents/workspace-trust') throw new RpcError(RpcErrorCode.NotFound, `no setting ${params.id}`)
        this.trust = params.value
        this.onChange()
        return {}
      }
    }
  }

  listing(): AgentListing {
    const agents = AGENT_IDS.map((id) => this.info(id))
    const votes = agents.filter((agent) => agent.permissions.mode !== null && agent.permissions.mode !== 'custom')
    const same = (modes: string[]) => (modes.length > 0 && modes.every((mode) => mode === modes[0]) ? modes[0] : 'mixed')
    return {
      defaultAgent: this.default,
      workspaceTrust: this.trust,
      permissions: {
        summary: same(votes.map((agent) => agent.permissions.mode as string)) as AgentListing['permissions']['summary'],
        nonAuto: same(votes.filter((agent) => !agent.permissions.hasAuto).map((agent) => agent.permissions.mode as string)) as AgentListing['permissions']['nonAuto']
      },
      agents
    }
  }

  info(id: string): AgentInfo {
    const entry = manifest.contributes.agent.find((candidate) => candidate.id === id)!
    const state = this.states.get(id)!
    const spec = SPECS[id]
    const args = state.args ?? spec?.yolo ?? ''
    const env = state.env ?? spec?.yoloEnv ?? {}
    return {
      id,
      label: entry.label,
      plugin: 'quirky.agents',
      installed: this.installed.includes(id),
      enabled: state.enabled,
      isDefault: this.default === id,
      promptMode: 'argv',
      resumable: false,
      canFork: false,
      homepage: `https://example.test/${id}`,
      install: null,
      command: state.command ?? entry.launch ?? entry.detect,
      commandOverridden: state.command !== null,
      args,
      argsOverridden: state.args !== null,
      env,
      envOverridden: state.env !== null,
      showEnv: spec?.yoloEnv !== undefined || state.env !== null,
      permissions: { mode: spec ? this.modeOf(spec, args, env) : null, hasAuto: spec?.auto !== undefined }
    }
  }

  private modeOf(spec: Spec, args: string, env: Record<string, string>): PermissionMode | 'custom' {
    if (spec.yoloEnv) return Object.entries(spec.yoloEnv).every(([key, value]) => env[key] === value) && args === '' ? 'yolo' : args === '' ? 'manual' : 'custom'
    if (args === spec.yolo) return 'yolo'
    if (args === spec.auto) return 'auto'
    return args === '' ? 'manual' : 'custom'
  }

  private known(id: string): string {
    if (!this.states.has(id)) throw new RpcError(RpcErrorCode.NotFound, `unknown agent: ${id}`)
    return id
  }

  private state(id: string): State {
    return this.states.get(this.known(id))!
  }

  private configure(params: Record<string, any>) {
    const state = this.state(params.agent)
    for (const field of (params.reset ?? []) as string[]) state[field as 'command' | 'args' | 'env'] = null
    if (params.command !== undefined) state.command = params.command === '' ? null : params.command
    if (params.args !== undefined) {
      if ((params.args.match(/"/g) ?? []).length % 2 === 1) {
        throw new RpcError(RpcErrorCode.InvalidParams, 'CLI arguments are invalid: unterminated quote')
      }
      state.args = params.args
    }
    if (params.env !== undefined) state.env = params.env
    this.onChange()
    return this.info(params.agent)
  }

  private setPermissions(params: Record<string, any>) {
    const mode = params.mode as PermissionMode
    const targets = params.agent === undefined ? AGENT_IDS.filter((id) => SPECS[id]) : [this.known(params.agent)]
    const changed: string[] = []
    for (const id of targets) {
      const spec = SPECS[id]
      if (!spec) throw new RpcError(RpcErrorCode.InvalidParams, `${id} has no permission modes`)
      const info = this.info(id)
      if (info.permissions.mode === 'custom' && !params.replaceCustom) {
        if (params.agent !== undefined) throw new RpcError(RpcErrorCode.InvalidParams, `${id} has custom arguments; pass --replace-custom to replace them`)
        continue
      }
      if (mode === 'auto' && !spec.auto) {
        if (params.agent !== undefined) throw new RpcError(RpcErrorCode.InvalidParams, `${id} has no Auto mode`)
        continue
      }
      const state = this.state(id)
      if (spec.yoloEnv) {
        state.args = ''
        state.env = mode === 'yolo' ? spec.yoloEnv : {}
      } else {
        state.args = mode === 'yolo' ? spec.yolo! : mode === 'auto' ? spec.auto! : ''
      }
      changed.push(id)
    }
    if (changed.length > 0) this.onChange()
    return { summary: this.listing().permissions.summary, changed }
  }
}

/** A fake context served by a `FakeAgents`, whose changes arrive as `quirky.agents/changed` events. */
export function fakeAgentsContext(agents: FakeAgents, extra: Record<string, Handler> = {}) {
  const fake = fakeContext({ ...agents.handlers(), ...extra })
  agents.announce(() => fake.dispatch({ type: 'quirky.agents/changed', data: {} } as QuirkyEvent))
  return fake
}
