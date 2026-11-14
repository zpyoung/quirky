import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import type { Repo, Session, UiPluginContext, Worktree } from '@quirky/protocol'
import { UI_CONTROL_COMMAND } from '../src/ui-control'
import type { UiControlArgs, UiControlResult } from '../src/ui-control'
import type { act as ReactAct, createElement as ReactCreateElement, ReactNode } from 'react'
import type { createRoot as ReactCreateRoot } from 'react-dom/client'
import type { RemoteWorkspace as RemoteWorkspaceComponent } from '../src/RemoteWorkspace'
import type { VmRecipeSelector as VmRecipeSelectorComponent } from '../src/VmRecipeSelector'
import type { RemoveProjectDialog as RemoveProjectDialogComponent } from '../src/RemoveProjectDialog'
import type { UpdateDialog as UpdateDialogComponent } from '../src/UpdateDialog'

type Params = Record<string, unknown>
type Call = { method: string; params: Params }
type Handler = (params: Params) => unknown | Promise<unknown>
type Provided = (element: HTMLElement, props: { input?: unknown }) => () => void
type MountHandle = { cleanup: () => void; active: boolean }

const UI_COMMAND = UI_CONTROL_COMMAND
const REMOTE_SECTION = 'sidebar-section:quirky.worktree/remote-workspaces'
const REMOTE_VIEW = 'view:quirky.worktree/remote'
const ENVIRONMENTS_VIEW = 'view:quirky.worktree/environments'

const host1 = {
  id: 'h1', runtime: { id: 'rt1', name: 'owner-mac' }, connected: true, error: null
}
const ws1 = { id: 'rw-1', hostId: 'h1', worktree: { name: 'api-remote' }, connected: true }
const ws2 = { id: 'rw-2', hostId: 'h1', worktree: { name: 'web-remote' }, connected: false }
const vm1 = {
  id: 'vm-1', name: 'api-vm', vmName: 'quirky-api', instanceId: 'inst-1', state: 'running',
  backendState: 'Running', error: null, remoteWorkspace: null
}
const vm2 = {
  ...vm1, id: 'vm-2', vmName: 'quirky-web', error: 'Guest agent timed out'
}
const mirror = {
  id: 'rw-1', hostId: 'h1', identity: { hostId: 'hid', generation: 'g1' },
  worktree: {
    id: 'mirror-w1', name: 'api-remote', path: '/w/api-remote', instanceId: 'i1', kind: 'git',
    repoId: 'r1', branch: 'main', head: 'abc'
  },
  connected: true, fingerprint: 'fingerprint-1'
}
const hostStatus = {
  id: 'h1', runtime: { id: 'rt1', name: 'owner-mac', endpoint: 'local', grantId: 'grant-1' },
  identity: { hostId: 'hid', generation: 'g1' }, connected: true, error: null
}

let act: typeof ReactAct
let createElement: typeof ReactCreateElement
let createRoot: typeof ReactCreateRoot
let activate: (context: UiPluginContext) => void
let deactivate: () => void
let RemoteWorkspace: typeof RemoteWorkspaceComponent
let VmRecipeSelector: typeof VmRecipeSelectorComponent
let RemoveProjectDialog: typeof RemoveProjectDialogComponent
let UpdateDialog: typeof UpdateDialogComponent


const mounted: MountHandle[] = []
let harness: Harness

type Harness = {
  calls: Call[]
  executed: Array<{ id: string; args?: unknown; options?: unknown }>
  logs: string[]
  toasts: Array<{ title: string; body: string }>
  confirms: unknown[]
  provided: Map<string, unknown>
  context: UiPluginContext
  windowFailure: Error | null
  windowReply: unknown
  respond(method: string, handler: Handler): void
}

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // react and plugin modules must bind to happy-dom globals.
  const react = await import('react')
  act = react.act
  createElement = react.createElement
  createRoot = (await import('react-dom/client')).createRoot
  ;({ activate, deactivate } = await import('../src/ui'))
  ;({ RemoteWorkspace } = await import('../src/RemoteWorkspace'))
  ;({ VmRecipeSelector } = await import('../src/VmRecipeSelector'))
  ;({ RemoveProjectDialog } = await import('../src/RemoveProjectDialog'))
  ;({ UpdateDialog } = await import('../src/UpdateDialog'))
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(async () => {
  document.body.replaceChildren()
  harness = createHarness()
  activate(harness.context)
  await flush()
})

afterEach(async () => {
  for (const handle of mounted.splice(0).reverse()) {
    if (!handle.active) continue
    handle.active = false
    await act(async () => handle.cleanup())
  }
  deactivate()
  document.body.replaceChildren()
})

function createHarness(): Harness {
  const calls: Call[] = []
  const executed: Harness['executed'] = []
  const logs: string[] = []
  const toasts: Harness['toasts'] = []
  const confirms: unknown[] = []
  const provided = new Map<string, unknown>()
  const responses = new Map<string, Handler>()
  const state: Harness = {
    calls,
    executed,
    logs,
    toasts,
    confirms,
    provided,
    context: {} as UiPluginContext,
    windowFailure: null,
    windowReply: undefined,
    respond(method, handler) { responses.set(method, handler) }
  }
  responses.set('quirky.worktree/remoteHostList', () => ({ hosts: [host1] }))
  responses.set('quirky.worktree/remoteList', () => ({ workspaces: [ws1, ws2] }))
  responses.set('quirky.worktree/remoteShow', () => mirror)
  responses.set('quirky.worktree/remoteHostStatus', () => hostStatus)
  responses.set('quirky.worktree/remoteCall', (params) => {
    if (params.operation === 'changes') return { entries: [], files: [], branch: 'main', operation: 'none' }
    if (params.operation === 'sessions') return []
    if (params.operation === 'terminalWorkspace') return { workspace: { id: 'mirror-w1' } }
    return []
  })
  responses.set('quirky.repo/list', () => [{ id: 'r1', name: 'api', kind: 'git' }])
  responses.set('quirky.worktree/vmList', () => ({ environments: [vm1, vm2] }))
  responses.set('quirky.worktree/vmDoctor', () => ({ available: true }))
  responses.set('quirky.worktree/vmRecipes', () => ({ recipes: [] }))
  responses.set('quirky.ledger/request', () => ({ removalPreview: [] }))

  const context = {
    pluginId: 'quirky.worktree',
    log(message: string) { logs.push(message) },
    provide(id: string, implementation: unknown) { provided.set(id, implementation) },
    async call(method: string, params: Params = {}): Promise<unknown> {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 1 }
      if (method === 'ui.window.command.run') {
        if (state.windowFailure) throw state.windowFailure
        if (state.windowReply !== undefined) return state.windowReply
        if (params.connId !== 1) throw new Error(`no live UI window ${String(params.connId)}`)
        const target = provided.get(String(params.id))
        if (typeof target !== 'function') throw new Error(`no UI command ${String(params.id)}`)
        return { result: await (target as (args: unknown) => unknown)(params.args) }
      }
      const handler = responses.get(method)
      return handler ? await handler(params) : []
    },
    async executeCommand(id: string, args?: unknown, options?: unknown) {
      executed.push({ id, args, options })
    },
    confirm(options: unknown) { confirms.push(options); return true },
    toast(title: string, body: string) { toasts.push({ title, body }) },
    subscribe() { return () => {} },
    onConnection() { return () => {} },
    setPanelBadge() {},
    getSetting() { return undefined },
    openView() {},
    togglePanel() {}
  } as unknown as UiPluginContext
  state.context = context
  return state
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 16; i++) await Promise.resolve()
  })
}

async function mountProvided(id: string, input?: unknown): Promise<MountHandle> {
  const implementation = harness.provided.get(id)
  if (typeof implementation !== 'function') throw new Error(`No provided mount for ${id}`)
  const host = document.createElement('div')
  document.body.append(host)
  let cleanup = () => {}
  await act(async () => { cleanup = (implementation as Provided)(host, { input }) })
  const handle = { cleanup, active: true }
  mounted.push(handle)
  await flush()
  return handle
}

async function mountDirect(element: ReactNode): Promise<void> {
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(element))
  const handle = { cleanup: () => root.unmount(), active: true }
  mounted.push(handle)
  await flush()
}

async function click(target: Element | null | undefined): Promise<void> {
  if (!target) throw new Error('The requested control was not found.')
  await act(async () => { (target as HTMLElement).click() })
  await flush()
}

async function typeInto(target: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(target, value)
    target.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

function buttonNamed(label: string, root: ParentNode = document): HTMLButtonElement | null {
  return [...root.querySelectorAll<HTMLButtonElement>('button')].find((button) =>
    button.getAttribute('aria-label') === label || button.textContent?.replace(/\s+/g, ' ').trim() === label
  ) ?? null
}

function controlCommand(): (args: UiControlArgs) => Promise<UiControlResult> {
  const implementation = harness.provided.get(UI_COMMAND)
  if (typeof implementation !== 'function') throw new Error(`No provided command for ${UI_COMMAND}`)
  return implementation as (args: UiControlArgs) => Promise<UiControlResult>
}

async function runPublic(args: UiControlArgs): Promise<UiControlResult> {
  let result!: UiControlResult
  await act(async () => { result = await controlCommand()(args) })
  await flush()
  return result
}

function windowCommandCalls(): Call[] {
  return harness.calls.filter((call) => call.method === 'ui.window.command.run')
}

function expectWindowCommandCalls(...args: UiControlArgs[]): void {
  expect(windowCommandCalls()).toEqual(args.map((value) => ({
    method: 'ui.window.command.run',
    params: { connId: 1, id: UI_COMMAND, args: value }
  })))
}

function inlineErrors(root: ParentNode = document): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('.ui-inline-error')]
}

function emptyMessages(root: ParentNode = document): string[] {
  return [...root.querySelectorAll<HTMLElement>('.ui-empty-state')].map((state) => state.textContent?.trim() ?? '')
}

function openMenuFor(label: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[role="menu"][aria-label="${label}"]`)
}

async function escapeMenuItem(label: string): Promise<void> {
  const item = openMenuFor(label)?.querySelector<HTMLElement>('[role="menuitem"]')
  if (!item) throw new Error(`No menu item in ${label}`)
  await act(async () => {
    item.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  })
  await flush()
}

const project = { id: 'r1', name: 'api', path: '/r/api', addedAt: 1 } as Repo
const detailsWorktree = {
  id: 'w2', name: 'fix', path: '/w/fix', comment: '', displayName: null, references: []
} as Worktree

test('9 shows remote hosts loading instead of an empty state', async () => {
  harness.respond('quirky.worktree/remoteHostList', () => new Promise(() => {}))
  await mountProvided(REMOTE_SECTION)
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()).toBe('Loading owner hosts…')
  expect(document.querySelector('.ui-empty-state')).toBeNull()
})

test('10 shows the owner-host empty state only after both lists load empty', async () => {
  harness.respond('quirky.worktree/remoteHostList', () => ({ hosts: [] }))
  harness.respond('quirky.worktree/remoteList', () => ({ workspaces: [] }))
  await mountProvided(REMOTE_SECTION)
  expect(emptyMessages()).toEqual(['No owner hosts registered'])
  expect(document.querySelector('.ui-notice-line')).toBeNull()
})

test('11 renders remote inventory failures as InlineError without loading or empty states', async () => {
  harness.respond('quirky.worktree/remoteHostList', () => { throw new Error('Host registry offline') })
  await mountProvided(REMOTE_SECTION)
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain('Host registry offline')
  expect(document.querySelector('.ui-empty-state')).toBeNull()
  expect(document.querySelector('.ui-notice-line')).toBeNull()
  expect(document.querySelector('.ui-error-text')).toBeNull()
})

test('12 renders a host connectivity error with InlineError', async () => {
  harness.respond('quirky.worktree/remoteHostList', () => ({ hosts: [{ ...host1, connected: false, error: 'Grant expired' }] }))
  await mountProvided(REMOTE_SECTION)
  expect(document.querySelector('section[aria-label="owner-mac"] .ui-inline-error')?.textContent?.trim()).toBe('Grant expired')
})

test('13 reports remote refresh failures through InlineError', async () => {
  await mountProvided(REMOTE_SECTION)
  harness.respond('quirky.worktree/remoteRefresh', () => { throw new Error('Refresh refused') })
  await click(buttonNamed('Refresh'))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/remoteRefresh')).toEqual([
    { method: 'quirky.worktree/remoteRefresh', params: { host: 'h1' } }
  ])
  expect(inlineErrors().some((error) => error.textContent?.includes('Refresh refused'))).toBe(true)
})

test('14 opens and closes a remote row menu through window routing before navigating', async () => {
  await mountProvided(REMOTE_SECTION)
  expect(document.querySelector('[data-workspace-id="rw-1"]')).not.toBeNull()
  await click(buttonNamed('Actions for api-remote'))
  expectWindowCommandCalls({ action: 'open-workspace-menu', workspace: 'rw-1' })
  expect(openMenuFor('Actions for api-remote')).not.toBeNull()
  await click(buttonNamed('Open workspace'))
  expectWindowCommandCalls(
    { action: 'open-workspace-menu', workspace: 'rw-1' },
    { action: 'close-workspace-menu', workspace: 'rw-1' }
  )
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/remoteNavigate')).toEqual([
    { method: 'quirky.worktree/remoteNavigate', params: { workspace: 'rw-1', window: 1 } }
  ])
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(harness.executed).toEqual([])
})

test('15 closes a remote row menu on Escape through the window command', async () => {
  await mountProvided(REMOTE_SECTION)
  await click(buttonNamed('Actions for api-remote'))
  await escapeMenuItem('Actions for api-remote')
  expectWindowCommandCalls(
    { action: 'open-workspace-menu', workspace: 'rw-1' },
    { action: 'close-workspace-menu', workspace: 'rw-1' }
  )
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(harness.executed).toEqual([])
})

test('16 shows a failed window-routed menu open as InlineError', async () => {
  await mountProvided(REMOTE_SECTION)
  harness.windowFailure = new Error('no live UI window 1')
  await click(buttonNamed('Actions for api-remote'))
  expect(inlineErrors().some((error) => error.textContent?.includes('no live UI window 1'))).toBe(true)
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expectWindowCommandCalls({ action: 'open-workspace-menu', workspace: 'rw-1' })
  expect(harness.executed).toEqual([])
})

test('17 closes a menu locally and logs when the window-routed close fails', async () => {
  await mountProvided(REMOTE_SECTION)
  await click(buttonNamed('Actions for api-remote'))
  harness.windowFailure = new Error('no live UI window 1')
  await escapeMenuItem('Actions for api-remote')
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(harness.logs).toContain('worktree: menu close failed: no live UI window 1')
  expectWindowCommandCalls(
    { action: 'open-workspace-menu', workspace: 'rw-1' },
    { action: 'close-workspace-menu', workspace: 'rw-1' }
  )
  expect(harness.executed).toEqual([])
})

test('17a logs a delivered-zero menu open without an error or menu', async () => {
  await mountProvided(REMOTE_SECTION)
  harness.windowReply = { result: { action: 'open-workspace-menu', workspace: 'rw-1', delivered: 0 } }
  await click(buttonNamed('Actions for api-remote'))
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(inlineErrors()).toHaveLength(0)
  expect(harness.logs).toContain('worktree: open-workspace-menu reached no mounted target')
  expectWindowCommandCalls({ action: 'open-workspace-menu', workspace: 'rw-1' })
  expect(harness.executed).toEqual([])
})

test('18 routes public remote menu commands by listed ids and unregisters on unmount', async () => {
  const handle = await mountProvided(REMOTE_SECTION)
  const listed = await harness.context.call('quirky.worktree/remoteList') as { workspaces: Array<{ id: string }> }
  const [workspaceId, offlineId] = listed.workspaces.map((workspace) => workspace.id)
  expect(await runPublic({ action: 'open-workspace-menu', workspace: workspaceId })).toEqual({
    action: 'open-workspace-menu', workspace: workspaceId, delivered: 1
  })
  expect(openMenuFor('Actions for api-remote')).not.toBeNull()
  expect(await runPublic({ action: 'close-workspace-menu', workspace: offlineId })).toEqual({
    action: 'close-workspace-menu', workspace: offlineId, delivered: 0
  })
  expect(openMenuFor('Actions for api-remote')).not.toBeNull()
  expect(await runPublic({ action: 'close-workspace-menu', workspace: workspaceId })).toEqual({
    action: 'close-workspace-menu', workspace: workspaceId, delivered: 1
  })
  expect(await runPublic({ action: 'close-workspace-menu', workspace: workspaceId })).toEqual({
    action: 'close-workspace-menu', workspace: workspaceId, delivered: 0
  })
  expect(await runPublic({ action: 'open-workspace-menu', workspace: offlineId })).toEqual({
    action: 'open-workspace-menu', workspace: offlineId, delivered: 0
  })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(await runPublic({ action: 'open-workspace-menu', workspace: 'rw-9' })).toEqual({
    action: 'open-workspace-menu', workspace: 'rw-9', delivered: 0
  })
  handle.active = false
  await act(async () => handle.cleanup())
  expect(await runPublic({ action: 'open-workspace-menu', workspace: workspaceId })).toEqual({
    action: 'open-workspace-menu', workspace: workspaceId, delivered: 0
  })
  expect(harness.executed).toEqual([])
})

test('19 shows the remote workspace loading line while its owner lookup is pending', async () => {
  harness.respond('quirky.worktree/remoteShow', () => new Promise(() => {}))
  await mountProvided(REMOTE_VIEW, { workspace: 'rw-1' })
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()).toBe('Loading the owner-bound workspace…')
})

test('20 renders remote workspace lookup failure as InlineError', async () => {
  harness.respond('quirky.worktree/remoteShow', () => { throw new Error('Workspace binding is stale') })
  await mountProvided(REMOTE_VIEW, { workspace: 'rw-1' })
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain('Workspace binding is stale')
  expect(document.querySelector('.ui-error-text')).toBeNull()
})

test('21 shows empty states for unchanged files, missing terminal, and absent cleanup suggestion', async () => {
  await mountProvided(REMOTE_VIEW, { workspace: 'rw-1' })
  expect(emptyMessages()).toEqual([
    'No changed files were reported.',
    'No remote terminal session is attached to this workspace.'
  ])
  harness.respond('quirky.worktree/remoteCleanupPreview', () => ({
    workspace: 'rw-1', hostId: 'h1', identity: { hostId: 'hid', generation: 'g1' },
    instanceId: 'i1', generatedAt: 1, candidate: null
  }))
  await click(buttonNamed('Preview Canonical Cleanup'))
  expect(emptyMessages()).toEqual([
    'No changed files were reported.',
    'No remote terminal session is attached to this workspace.',
    'No canonical cleanup suggestion exists for this workspace.'
  ])
})

test('22 marks remote changes unavailable without presenting them as an empty state', async () => {
  harness.respond('quirky.worktree/remoteHostStatus', () => ({ ...hostStatus, connected: false, error: null }))
  await mountProvided(REMOTE_VIEW, { workspace: 'rw-1' })
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain(
    'This owner or workspace instance is unavailable. Refresh before using remote data.'
  )
  const unavailable = [...document.querySelectorAll('p')].find((node) => node.textContent?.trim() === 'Remote changes are unavailable.')
  expect(unavailable).not.toBeUndefined()
  expect(unavailable?.closest('.ui-empty-state')).toBeNull()
})

test('23 renders a missing remote workspace selection as InlineError', async () => {
  await mountProvided(REMOTE_VIEW, {})
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain('Select an owner-bound remote workspace.')
})

test('24 shows VM loading instead of an empty state while the inventory is pending', async () => {
  harness.respond('quirky.worktree/vmList', () => new Promise(() => {}))
  await mountProvided(ENVIRONMENTS_VIEW, {})
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()).toBe('Loading VM environments…')
  expect(document.querySelector('.ui-empty-state')).toBeNull()
})

test('25 shows the VM empty state after a successful empty inventory', async () => {
  harness.respond('quirky.worktree/vmList', () => ({ environments: [] }))
  await mountProvided(ENVIRONMENTS_VIEW, {})
  expect(emptyMessages()).toContain('No VM environments recorded')
})

test('26 renders VM inventory failure as InlineError without loading or empty states', async () => {
  harness.respond('quirky.worktree/vmList', () => { throw new Error('Lima is not installed') })
  await mountProvided(ENVIRONMENTS_VIEW, {})
  expect(inlineErrors().some((error) => error.textContent?.includes('Lima is not installed'))).toBe(true)
  expect(document.querySelector('.ui-empty-state')).toBeNull()
  expect(document.querySelector('.ui-notice-line')).toBeNull()
})

test('27 renders a per-VM lifecycle error as InlineError', async () => {
  await mountProvided(ENVIRONMENTS_VIEW, {})
  expect(document.querySelector('tr[aria-label="quirky-web"] .ui-inline-error')?.textContent?.trim()).toBe('Guest agent timed out')
})

test('28 routes suspend, resume, and destroy to literal VM lifecycle methods', async () => {
  await mountProvided(ENVIRONMENTS_VIEW, {})
  expect(document.querySelector('[data-vm-id="vm-1"]')).not.toBeNull()
  await click(buttonNamed('Actions for quirky-api'))
  expectWindowCommandCalls({ action: 'open-vm-menu', vm: 'vm-1' })
  expect(openMenuFor('Actions for quirky-api')).not.toBeNull()
  await click(buttonNamed('Suspend'))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/vmSuspend')).toEqual([
    { method: 'quirky.worktree/vmSuspend', params: { vm: 'vm-1', instanceId: 'inst-1' } }
  ])
  await click(buttonNamed('Actions for quirky-api'))
  await click(buttonNamed('Resume / reconcile'))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/vmResume')).toEqual([
    { method: 'quirky.worktree/vmResume', params: { vm: 'vm-1', instanceId: 'inst-1' } }
  ])
  await click(buttonNamed('Actions for quirky-api'))
  await click(buttonNamed('Destroy VM'))
  expect(harness.confirms).toContainEqual(expect.objectContaining({ title: 'Destroy VM quirky-api?' }))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/vmDestroy')).toEqual([
    { method: 'quirky.worktree/vmDestroy', params: { vm: 'vm-1', instanceId: 'inst-1', yes: true } }
  ])
  expect(harness.executed).toEqual([])
})

test('29 refreshes VM lifecycle state from the public list method', async () => {
  await mountProvided(ENVIRONMENTS_VIEW, {})
  const before = harness.calls.filter((call) => call.method === 'quirky.worktree/vmList').length
  await click(buttonNamed('Refresh lifecycle state'))
  expect(harness.calls.filter((call) => call.method === 'quirky.worktree/vmList')).toHaveLength(before + 1)
})

test('30 routes public VM menu commands by ids from vmList', async () => {
  await mountProvided(ENVIRONMENTS_VIEW, {})
  const listed = await harness.context.call('quirky.worktree/vmList') as { environments: Array<{ id: string }> }
  const [vmId] = listed.environments.map((environment) => environment.id)
  expect(await runPublic({ action: 'open-vm-menu', vm: vmId })).toEqual({ action: 'open-vm-menu', vm: vmId, delivered: 1 })
  expect(openMenuFor('Actions for quirky-api')).not.toBeNull()
  expect(await runPublic({ action: 'close-vm-menu', vm: vmId })).toEqual({ action: 'close-vm-menu', vm: vmId, delivered: 1 })
  expect(document.querySelector('[role="menu"]')).toBeNull()
  expect(await runPublic({ action: 'open-vm-menu', vm: 'vm-9' })).toEqual({ action: 'open-vm-menu', vm: 'vm-9', delivered: 0 })
  expect(harness.executed).toEqual([])
})

test('31 shows VM recipe loading while the catalog is pending', async () => {
  harness.respond('quirky.worktree/vmRecipes', () => new Promise(() => {}))
  await mountDirect(createElement(VmRecipeSelector, { context: harness.context, repo: 'r1', value: null, disabled: false, onChange() {} }))
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()).toBe('Loading VM recipes…')
})

test('32 renders VM recipe lookup failures as InlineError', async () => {
  harness.respond('quirky.worktree/vmRecipes', () => { throw new Error('Recipe file is invalid') })
  await mountDirect(createElement(VmRecipeSelector, { context: harness.context, repo: 'r1', value: null, disabled: false, onChange() {} }))
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain('Recipe file is invalid')
})

test('33 renders a changed selected recipe as InlineError', async () => {
  const value = { id: 'r-old', trustHash: '0'.repeat(64), checkoutMode: 'orca-worktree' as const, approved: true }
  await mountDirect(createElement(VmRecipeSelector, { context: harness.context, repo: 'r1', value, disabled: false, onChange() {} }))
  expect(inlineErrors().map((error) => error.textContent?.trim())).toContain(
    'The selected recipe changed. Select it again and review its current lifecycle.'
  )
})

test('34 shows ledger removal preview loading in a status NoticeLine', async () => {
  harness.respond('quirky.ledger/request', () => new Promise(() => {}))
  await mountDirect(createElement(RemoveProjectDialog, {
    context: harness.context, repo: project, worktrees: [], sessions: [] as Session[], onClose() {}
  }))
  expect(document.querySelector('[role="status"] .ui-notice-line')?.textContent?.trim()).toBe('Checking retained ledger records…')
})

test('35 retries ledger preview failures and enables Remove after the successful retry', async () => {
  let requests = 0
  harness.respond('quirky.ledger/request', () => {
    requests++
    if (requests === 1) throw new Error('Ledger offline')
    return { removalPreview: [] }
  })
  await mountDirect(createElement(RemoveProjectDialog, {
    context: harness.context, repo: project, worktrees: [], sessions: [] as Session[], onClose() {}
  }))
  const error = document.querySelector<HTMLElement>('.ui-inline-error')
  expect(error?.querySelector('.ui-inline-error__message')?.textContent?.trim()).toBe('Could not check retained ledger records: Ledger offline')
  expect(error?.querySelector('.ui-inline-error__action')?.textContent?.trim()).toBe('Retry')
  await click(buttonNamed('Retry'))
  expect(harness.calls.filter((call) => call.method === 'quirky.ledger/request')).toEqual([
    { method: 'quirky.ledger/request', params: { operation: 'removal-preview', removal: { repoIds: ['r1'] } } },
    { method: 'quirky.ledger/request', params: { operation: 'removal-preview', removal: { repoIds: ['r1'] } } }
  ])
  expect(document.querySelector('.ui-inline-error')).toBeNull()
  expect(buttonNamed('Remove')?.disabled).toBe(false)
})

test('36 shows linked-reference emptiness with EmptyState', async () => {
  await mountDirect(createElement(UpdateDialog, { context: harness.context, worktree: detailsWorktree, onClose() {} }))
  expect(emptyMessages()).toContain('No references linked.')
})

test('37 reports a failed reference command in a toast and preserves the empty state', async () => {
  await mountDirect(createElement(UpdateDialog, { context: harness.context, worktree: detailsWorktree, onClose() {} }))
  harness.windowFailure = new Error('no live UI window 1')
  const url = document.querySelector<HTMLInputElement>('#workspace-reference-url')
  if (!url) throw new Error('Reference URL field was not rendered.')
  await typeInto(url, 'https://example.com/a')
  await click(buttonNamed('Add reference'))
  expect(harness.toasts).toEqual([{ title: 'Could not change linked work', body: 'no live UI window 1' }])
  expect(emptyMessages()).toContain('No references linked.')
  expectWindowCommandCalls({ action: 'add-reference', worktree: 'w2', url: 'https://example.com/a', label: '' })
  expect(harness.executed).toEqual([])
})
