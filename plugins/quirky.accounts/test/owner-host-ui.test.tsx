import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { OwnerSessionHostRef, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import type { AccountState } from '../src/types'
import { makeRepo, isolateGitConfig } from '../../quirky.repo/test/git-fixtures'
import { activate, deactivate } from '../src/ui'
import { cleanupAll, startAccounts, waitForAsync, type AccountsHarness } from './support/index'
const RUNTIME_GLOBALS = [
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate',
  'queueMicrotask', 'MessageChannel', 'performance', 'fetch', 'WebSocket', 'Response', 'Request',
  'Headers', 'AbortController', 'AbortSignal'
] as const
const nativeGlobals = RUNTIME_GLOBALS.map((name) => [name, (globalThis as Record<string, unknown>)[name]] as const)

isolateGitConfig()

type HostRegistration = {
  id: string
  runtime: { id: string; name: string; endpoint: string; grantId: string }
  identity: { hostId: string; generation: string }
  connected: boolean
  error: string | null
}
type RemoteMirror = {
  id: string
  hostId: string
  identity: { hostId: string; generation: string }
  worktree: { id: string; instanceId: string; path: string; name: string; kind: string }
  connected: boolean
  fingerprint: string
}
type Worktree = { id: string; instanceId: string; path: string; name: string; kind: string }
type OwnerWorld = {
  local: AccountsHarness
  remote: AccountsHarness
  host: HostRegistration
  runtime: { id: string; name: string; endpoint: string; grantId: string }
  mirror: RemoteMirror
  remoteRepoId: string
  remoteWorktree: Worktree
  localWorktree: Worktree
}
type Call = { method: string; params?: Record<string, unknown> }
type CommandInvocation = { id: string; args?: unknown; options?: { activateOwner?: boolean } }
type ContextFixture = {
  context: UiPluginContext
  calls: Call[]
  commandInvocations: CommandInvocation[]
  provided: Map<string, unknown>
  events: ((event: QuirkyEvent) => void | Promise<void>)[]
  emitLayout(layout: UiLayout): void
  emitEvent(event: QuirkyEvent): void
  resolveFirstRemoteList(): void
  whenIdle(): Promise<void>
  firstRemoteListStarted(): boolean
  remoteResolutionStarted(): boolean
  releaseRemoteResolution(): void
  getLayoutCalls(): number
  getLayout(): UiLayout
}
type AddedAccount = { id: string; label: string }

const worktreePlugins = ['quirky.cli', 'quirky.mobile', 'quirky.repo', 'quirky.worktree', 'quirky.agents', 'quirky.session', 'quirky.terminal', 'quirky.git', 'quirky.editor', 'quirky.sidebar-extras']
let previousMobilePort: string | undefined
let previousMobileHost: string | undefined
let previousBrowser: string | undefined
let container: HTMLElement
let statusContainer: HTMLElement
let unregister: (() => void)[]
let waitForActiveCalls: (() => Promise<void>) | null = null
let releaseHeldOwnerList: (() => void) | null = null
let releaseHeldRemoteResolution: (() => void) | null = null

const call = <T,>(h: AccountsHarness, method: string, params: Record<string, unknown> = {}) =>
  h.client.callAny(method, params) as Promise<T>

function localLayout(worktree: string): UiLayout {
  return {
    view: { id: 'view:quirky.session/worktree', input: { worktree } },
    panel: null,
    sidebar: true,
    focus: 'view'
  }
}

function remoteLayout(workspace: string): UiLayout {
  return {
    view: { id: 'view:quirky.worktree/remote', input: { workspace } },
    panel: null,
    sidebar: true,
    focus: 'view'
  }
}

function settingsLayout(workspace: string): UiLayout {
  return {
    view: { id: 'view:quirky.accounts/settings' },
    panel: null,
    sidebar: true,
    focus: 'view',
    viewTabs: [
      { id: 'view:quirky.worktree/remote', input: { workspace } },
      { id: 'view:quirky.accounts/settings' }
    ]
  }
}

function hostRef(host: HostRegistration): OwnerSessionHostRef {
  return {
    hostId: host.identity.hostId,
    identity: { ...host.identity },
    runtime: { id: host.runtime.id, endpoint: host.runtime.endpoint, grantId: host.runtime.grantId }
  }
}

async function makeOwnerWorld(prefix: string): Promise<OwnerWorld> {
  const local = await startAccounts({ plugins: worktreePlugins })
  const remote = await startAccounts({ plugins: worktreePlugins })
  for (const h of [local, remote]) {
    await call(h, 'setting.set', {
      id: 'setting:quirky.worktree/worktreesRoot',
      value: join(h.home, 'worktrees')
    })
  }

  const offer = await call<{ offer: string }>(remote, 'quirky.mobile/ownerPair', {
    name: `${prefix} owner`,
    address: '127.0.0.1',
    confirm: true
  })
  const runtime = await call<{ id: string; name: string; endpoint: string; grantId: string }>(local, 'quirky.cli/runtimeAdd', {
    name: `${prefix} saved owner`,
    pairingCode: offer.offer
  })
  const host = await call<HostRegistration>(local, 'quirky.worktree/remoteHostRegister', {
    runtime: `runtime:${runtime.id}`
  })
  const remoteRepoPath = join(remote.home, 'remote-repository')
  makeRepo(remoteRepoPath)
  const remoteRepo = await call<{ id: string }>(remote, 'quirky.repo/add', { path: remoteRepoPath })
  const remoteCreated = await call<{ worktree: Worktree }>(remote, 'quirky.worktree/create', {
    repo: remoteRepo.id,
    name: `${prefix} remote workspace`
  })
  const mirror = await call<RemoteMirror>(local, 'quirky.worktree/remoteAttach', {
    host: host.id,
    worktree: remoteCreated.worktree.id
  })
  const localRepoPath = join(local.home, 'local-repository')
  makeRepo(localRepoPath)
  const localRepo = await call<{ id: string }>(local, 'quirky.repo/add', { path: localRepoPath })
  const localCreated = await call<{ worktree: Worktree }>(local, 'quirky.worktree/create', {
    repo: localRepo.id,
    name: `${prefix} local workspace`
  })

  expect(host.connected).toBe(true)
  expect(mirror.connected).toBe(true)
  expect(mirror.identity).toEqual(host.identity)
  return {
    local, remote, host, runtime, mirror,
    remoteRepoId: remoteRepo.id,
    remoteWorktree: remoteCreated.worktree,
    localWorktree: localCreated.worktree
  }
}

async function addAccount(h: AccountsHarness, provider: 'claude' | 'codex', label: string, email: string): Promise<AddedAccount> {
  h.setLoginMode('complete', email)
  const pending = await call<{ id: string }>(h, 'quirky.accounts/beginLogin', { provider, label })
  const completed = await waitForAsync(async () => {
    const state = await call<{ status: string; result: AddedAccount | null }>(h, 'quirky.accounts/loginStatus', { id: pending.id })
    return state.status === 'pending' ? undefined : state
  })
  if (completed.status !== 'complete' || !completed.result) throw new Error(`${provider} fixture login for ${email} did not complete`)
  return completed.result
}

async function prepareAccounts(world: OwnerWorld): Promise<{ localCodex: AddedAccount; remoteActive: AddedAccount; remoteNext: AddedAccount; remoteExpired: AddedAccount }> {
  await addAccount(world.local, 'claude', 'Local Claude account', 'local-claude@example.test')
  const localCodex = await addAccount(world.local, 'codex', 'Local Codex account', 'local-codex@example.test')
  const remoteActive = await addAccount(world.remote, 'claude', 'Remote Claude active', 'remote-active@example.test')
  const remoteNext = await addAccount(world.remote, 'claude', 'Remote Claude next', 'remote-next@example.test')
  const remoteExpired = await addAccount(world.remote, 'claude', 'Remote Claude expired', 'remote-expired@example.test')
  await addAccount(world.remote, 'codex', 'Remote Codex account', 'remote-codex@example.test')

  rmSync(join(world.remote.managedHome('claude', remoteExpired.id), '.credentials.json'), { force: true })
  await expect(call(world.remote, 'quirky.accounts/select', { provider: 'claude', accountId: remoteExpired.id }))
    .rejects.toThrow(/sign in/i)
  await call(world.remote, 'quirky.accounts/select', { provider: 'claude', accountId: remoteActive.id })
  await call(world.local, 'quirky.accounts/refresh', { provider: 'codex', force: true })
  await call(world.remote, 'quirky.accounts/refresh', { provider: 'codex', force: true })
  await call(world.remote, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'always' })
  return { localCodex, remoteActive, remoteNext, remoteExpired }
}
async function prepareSignInAccounts(world: OwnerWorld): Promise<void> {
  await addAccount(world.local, 'claude', 'Local Claude account', 'signin-local@example.test')
  const remoteActive = await addAccount(world.remote, 'claude', 'Remote Claude active', 'signin-active@example.test')
  const remoteExpired = await addAccount(world.remote, 'claude', 'Remote Claude expired', 'signin-expired@example.test')
  rmSync(join(world.remote.managedHome('claude', remoteExpired.id), '.credentials.json'), { force: true })
  await expect(call(world.remote, 'quirky.accounts/select', { provider: 'claude', accountId: remoteExpired.id }))
    .rejects.toThrow(/sign in/i)
  await call(world.remote, 'quirky.accounts/select', { provider: 'claude', accountId: remoteActive.id })
  await call(world.remote, 'quirky.accounts/setPreferences', { claudeSwitchPolicy: 'always' })
}

async function prepareScopeAccounts(world: OwnerWorld): Promise<void> {
  await addAccount(world.local, 'claude', 'Local Claude account', 'scope-local@example.test')
  await addAccount(world.remote, 'claude', 'Remote Claude active', 'scope-remote@example.test')
}

function makeContext(world: OwnerWorld, options: { layout: UiLayout; holdFirstRemoteList?: boolean; holdRemoteResolution?: boolean; connId?: number; windows?: Map<number, ContextFixture> }): ContextFixture {
  let layout = options.layout
  const connId = options.connId ?? 1
  let layoutReads = 0
  let remoteListCalls = 0
  let heldResult: unknown
  let inFlightCalls = 0
  const idleResolvers = new Set<() => void>()
  const whenIdle = async (): Promise<void> => {
    while (true) {
      if (inFlightCalls > 0) {
        const { promise, resolve } = Promise.withResolvers<void>()
        idleResolvers.add(resolve)
        await promise
      }
      await Promise.resolve()
      if (inFlightCalls === 0) return
    }
  }
  const deferredRemoteList = Promise.withResolvers<unknown>()
  const deferredRemoteResolution = Promise.withResolvers<void>()
  let remoteResolutionCalls = 0
  const calls: Call[] = []
  const commandInvocations: CommandInvocation[] = []
  const provided = new Map<string, unknown>()
  const events: ((event: QuirkyEvent) => void | Promise<void>)[] = []
  const layoutListeners: ((next: UiLayout) => void)[] = []
  const firstRemoteListStarted = () => remoteListCalls > 0
  const context = {
    pluginId: 'quirky.accounts',
    log: () => {},
    provide: (id: string, implementation: unknown) => provided.set(id, implementation),
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      inFlightCalls += 1
      try {
        if (method === 'ui.window.self') return { connId }
        if (method === 'ui.window.command.run') {
          const targetConnId = Number(params.connId)
          const targetProviders = options.windows?.get(targetConnId)?.provided ?? (targetConnId === connId ? provided : undefined)
          const id = params.id
          if (typeof id !== 'string' || !targetProviders) throw new Error('The originating window is unavailable.')
          const handler = targetProviders.get(id)
          if (typeof handler !== 'function') throw new Error(`Unknown window command: ${id}`)
          const result = await (handler as (args?: unknown) => unknown)(params.args)
          return { result: result ?? null }
        }
        const result = await world.local.client.callAny(method, params)
        if (method === 'quirky.worktree/remoteShow') {
          remoteResolutionCalls += 1
          if (options.holdRemoteResolution) {
            releaseHeldRemoteResolution = deferredRemoteResolution.resolve
            await deferredRemoteResolution.promise
          }
        }
        if (method === 'quirky.accounts/ownerCall' && params.operation === 'list') {
          remoteListCalls += 1
          if (options.holdFirstRemoteList && remoteListCalls === 1) {
            heldResult = result
            return await deferredRemoteList.promise
          }
        }
        return result
      } finally {
        inFlightCalls -= 1
        if (inFlightCalls === 0) {
          for (const resolve of idleResolvers) resolve()
          idleResolvers.clear()
        }
      }
    },
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      events.push(listener)
      return () => {
        const index = events.indexOf(listener)
        if (index !== -1) events.splice(index, 1)
      }
    },
    executeCommand: async (id: string, args?: unknown, commandOptions?: { activateOwner?: boolean }) => {
      commandInvocations.push({ id, args, ...(commandOptions ? { options: commandOptions } : {}) })
      const handler = provided.get(id)
      return typeof handler === 'function' ? await (handler as (args?: unknown) => unknown)(args) : undefined
    },
    openView: () => {},
    closeView: () => {},
    togglePanel: () => {},
    getLayout: () => {
      layoutReads += 1
      return layout
    },
    onLayout: (listener: (next: UiLayout) => void) => {
      layoutListeners.push(listener)
      return () => {
        const index = layoutListeners.indexOf(listener)
        if (index !== -1) layoutListeners.splice(index, 1)
      }
    },
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast: () => {},
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
  waitForActiveCalls = whenIdle
  releaseHeldOwnerList = () => { deferredRemoteList.resolve(heldResult) }
  return {
    context: context as unknown as UiPluginContext,
    calls,
    commandInvocations,
    provided,
    events,
    emitLayout(next) {
      layout = next
      for (const listener of [...layoutListeners]) listener(next)
    },
    emitEvent(event) {
      for (const listener of [...events]) void listener(event)
    },
    resolveFirstRemoteList() {
      deferredRemoteList.resolve(heldResult)
    },
    firstRemoteListStarted,
    remoteResolutionStarted: () => remoteResolutionCalls > 0,
    releaseRemoteResolution() {
      deferredRemoteResolution.resolve()
    },
    whenIdle,
    getLayoutCalls: () => layoutReads,
    getLayout: () => layout
  }
}

beforeAll(() => {
  GlobalRegistrator.register()
  for (const [name, value] of nativeGlobals) {
    if (value !== undefined) Object.defineProperty(globalThis, name, { value, writable: true, configurable: true })
  }
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  previousMobilePort = process.env.QUIRKY_MOBILE_PORT
  previousMobileHost = process.env.QUIRKY_MOBILE_HOST
  previousBrowser = process.env.BROWSER
  delete process.env.BROWSER
  process.env.QUIRKY_MOBILE_PORT = '0'
  process.env.QUIRKY_MOBILE_HOST = '127.0.0.1'
  unregister = []
  container = document.createElement('div')
  statusContainer = document.createElement('div')
  document.body.append(container, statusContainer)
})

afterEach(async () => {
  try {
    releaseHeldOwnerList?.()
    releaseHeldRemoteResolution?.()
    if (waitForActiveCalls) await act(async () => { await waitForActiveCalls?.() })
    await act(async () => {
      for (const cleanup of unregister.splice(0)) cleanup()
      deactivate()
    })
  } finally {
    container.remove()
    statusContainer.remove()
    try {
      await cleanupAll()
    } finally {
      waitForActiveCalls = null
      releaseHeldOwnerList = null
      releaseHeldRemoteResolution = null
      if (previousMobilePort === undefined) delete process.env.QUIRKY_MOBILE_PORT
      else process.env.QUIRKY_MOBILE_PORT = previousMobilePort
      if (previousMobileHost === undefined) delete process.env.QUIRKY_MOBILE_HOST
      else process.env.QUIRKY_MOBILE_HOST = previousMobileHost
      previousMobilePort = undefined
      previousMobileHost = undefined
      if (previousBrowser === undefined) delete process.env.BROWSER
      else process.env.BROWSER = previousBrowser
      previousBrowser = undefined
    }
  }
})

async function settle(milliseconds = 20): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Bun.sleep(milliseconds)
    await Promise.resolve()
  })
}

async function waitUntil(check: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 2_000
  while (Date.now() < deadline) {
    if (check()) return
    await settle(10)
  }
  throw new Error(failure)
}

function mount(fixture: ContextFixture, id: string, element: HTMLElement): void {
  const implementation = fixture.provided.get(id)
  if (typeof implementation !== 'function') throw new Error(`Missing Accounts UI contribution ${id}`)
  const cleanup = (implementation as (element: HTMLElement, props: Record<string, unknown>) => (() => void) | void)(element, {})
  if (typeof cleanup === 'function') unregister.push(cleanup)
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement {
  const button = root.querySelector(`[aria-label=\"${label}\"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button with aria-label ${label}`)
  return button
}

function buttonsByText(root: ParentNode, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll('button')].filter((button) => button.textContent?.trim() === text)
}

test('the window layout keeps the remote workspace owner through Accounts settings and restores local account usage on a local workspace', async () => {
  const world = await makeOwnerWorld('accounts-ui-layout')
  const accounts = await prepareAccounts(world)
  const owner = hostRef(world.host)
  const fixture = makeContext(world, { layout: remoteLayout(world.mirror.id) })
  await act(async () => {
    activate(fixture.context)
    mount(fixture, 'view:quirky.accounts/settings', container)
    mount(fixture, 'status-bar:quirky.accounts/usage', statusContainer)
  })
  await waitUntil(() => container.textContent?.includes('Remote Claude active') === true, 'Remote focused workspace did not load its owner Accounts state.')
  expect(fixture.getLayoutCalls()).toBeGreaterThan(0)
  expect(fixture.calls).toContainEqual(expect.objectContaining({
    method: 'quirky.accounts/ownerCall',
    params: expect.objectContaining({ owner })
  }))
  expect(container.textContent).toContain(world.host.runtime.name)
  expect(container.textContent).not.toContain('Local Claude account')

  const remotePolicy = container.querySelector('#claude-switch-policy')
  if (!(remotePolicy instanceof HTMLSelectElement)) throw new Error('Missing Claude switch-policy control')
  expect(remotePolicy.value).toBe('ask')
  await act(async () => { fixture.emitLayout(settingsLayout(world.mirror.id)) })
  await settle()
  expect(fixture.getLayout().view?.id).toBe('view:quirky.accounts/settings')
  expect(container.textContent).toContain('Remote Claude active')
  expect(container.textContent).not.toContain('Local Claude account')

  await act(async () => { buttonByLabel(statusContainer, 'Open Usage').click() })
  await settle()
  expect(statusContainer.querySelector('[data-provider=\"codex\"]')?.getAttribute('aria-label')).toContain('20%')
  const codexRow = buttonByLabel(statusContainer, 'Open Codex details and account switcher')
  await act(async () => { codexRow.click() })
  await settle()
  expect(statusContainer.textContent).toContain('Remote Codex account')

  const selectRemote = buttonByLabel(container, `Select Claude account ${accounts.remoteNext.label}`)
  await act(async () => { selectRemote.click() })
  await settle()
  expect(container.textContent).not.toContain('Local Claude account')
  expect(fixture.calls).toContainEqual(expect.objectContaining({
    method: 'quirky.accounts/ownerCall',
    params: expect.objectContaining({
      owner,
      operation: 'select',
      params: { provider: 'claude', accountId: accounts.remoteNext.id }
    })
  }))
  await act(async () => {
    await fixture.context.executeCommand('command:quirky.accounts/select-account', { provider: 'claude', accountId: accounts.remoteActive.id })
    await fixture.whenIdle()
  })
  expect(fixture.commandInvocations.at(-1)).toEqual({
    id: 'command:quirky.accounts/select-account',
    args: { provider: 'claude', accountId: accounts.remoteActive.id }
  })
  expect(fixture.calls).toContainEqual(expect.objectContaining({
    method: 'quirky.accounts/ownerCall',
    params: expect.objectContaining({ owner, operation: 'select', params: { provider: 'claude', accountId: accounts.remoteActive.id } })
  }))
  expect(fixture.calls.some((item) => item.method === 'quirky.accounts/select')).toBe(false)
  await act(async () => {
    await fixture.context.executeCommand('command:quirky.accounts/refresh', { provider: 'grok' })
    await fixture.whenIdle()
  })
  expect(fixture.commandInvocations.at(-1)).toEqual({
    id: 'command:quirky.accounts/refresh',
    args: { provider: 'grok' }
  })
  expect(fixture.calls).toContainEqual(expect.objectContaining({
    method: 'quirky.accounts/ownerCall',
    params: expect.objectContaining({ owner, operation: 'refresh', params: { provider: 'grok', force: true } })
  }))
  const copyCommand = fixture.provided.get('command:quirky.accounts/copy-login-link')
  if (typeof copyCommand !== 'function') throw new Error('Missing copy-login-link command')
  expect(await (copyCommand as (args?: unknown) => unknown)({ id: 'login-a', provider: 'codex', url: 'https://auth.openai.com/oauth/authorize?login=a' }))
    .toEqual({ ok: false, reason: 'remote-owner' })
  expect(container.textContent).not.toContain('Local Claude account')
  expect(container.textContent).toContain('Remote Claude active')

  await act(async () => { fixture.emitLayout(localLayout(world.localWorktree.id)) })
  await waitUntil(() => container.textContent?.includes('Local Claude account') === true, 'Switching to a local workspace view did not restore local Accounts state.')
  expect(container.textContent).not.toContain('Remote Claude active')
  await waitUntil(() => statusContainer.textContent?.includes('Local Codex account') === true, 'The local Usage account was not restored for the local workspace.')
  const localPolicy = container.querySelector('#claude-switch-policy')
  if (!(localPolicy instanceof HTMLSelectElement)) throw new Error('Missing local Claude switch-policy control')
  expect(localPolicy.value).toBe('ask')
  await act(async () => {
    localPolicy.value = 'never'
    localPolicy.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  const preferenceWrite = fixture.calls.find((item) => item.method === 'quirky.accounts/setPreferences' && item.params?.claudeSwitchPolicy === 'never')
  expect(preferenceWrite).toBeDefined()
  expect(fixture.calls.some((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'setPreferences')).toBe(false)
  expect((await call<{ preferences: { claudeSwitchPolicy: string } }>(world.local, 'quirky.accounts/list')).preferences.claudeSwitchPolicy).toBe('never')
  expect((await call<{ preferences: { claudeSwitchPolicy: string } }>(world.remote, 'quirky.accounts/list')).preferences.claudeSwitchPolicy).toBe('always')
}, 15_000)

test('remote Accounts disables browser sign-in and reauthentication while keeping local policy state local', async () => {
  const world = await makeOwnerWorld('accounts-ui-sign-in')
  await prepareSignInAccounts(world)
  const fixture = makeContext(world, { layout: remoteLayout(world.mirror.id) })
  await act(async () => {
    activate(fixture.context)
    mount(fixture, 'view:quirky.accounts/settings', container)
  })
  await waitUntil(() => container.textContent?.includes('Remote Claude expired') === true, 'Remote account settings did not load.')

  expect(buttonsByText(container, 'Add Account').some((button) => button.disabled)).toBe(true)
  const expiredAccountRow = [...container.querySelectorAll('.account-row')].find((row) => row.textContent?.includes('Remote Claude expired'))
  if (!(expiredAccountRow instanceof HTMLElement)) throw new Error('Missing the saved account that requires reauthentication')
  const signInAction = [...expiredAccountRow.querySelectorAll('button')].find((button) => /sign.?in|reauth/i.test(`${button.getAttribute('aria-label') ?? ''} ${button.textContent ?? ''}`))
  expect(signInAction).toBeDefined()
  expect(signInAction?.disabled).toBe(true)
  const more = container.querySelector('summary[aria-label="More sign-in options"]')
  if (!(more instanceof HTMLElement)) throw new Error('Missing sign-in alternatives disclosure')
  await act(async () => { more.click() })
  expect(buttonsByText(container, 'Copy sign-in link instead').some((button) => button.disabled)).toBe(true)
  const policy = container.querySelector('#claude-switch-policy')
  if (!(policy instanceof HTMLSelectElement)) throw new Error('Missing Claude switch-policy control')
  expect(policy.value).toBe('ask')

  const codexTab = buttonsByText(container, 'Codex')[0]
  if (!codexTab) throw new Error('Missing Codex settings tab')
  await act(async () => { codexTab.click() })
  await settle()
  expect(buttonsByText(container, 'Add Account').some((button) => button.disabled)).toBe(true)
  expect(fixture.calls.some((item) => item.method === 'quirky.accounts/beginLogin')).toBe(false)
  expect(fixture.calls.some((item) => item.method === 'quirky.terminal/openExternal')).toBe(false)
  expect(fixture.calls.some((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'beginLogin')).toBe(false)
}, 15_000)

test('a stale remote response and owner event cannot replace the new local scope; a replaced offline mirror never falls back locally', async () => {
  const world = await makeOwnerWorld('accounts-ui-stale-scope')
  await prepareScopeAccounts(world)
  const owner = hostRef(world.host)
  const fixture = makeContext(world, { layout: remoteLayout(world.mirror.id), holdFirstRemoteList: true, holdRemoteResolution: true })
  await act(async () => {
    activate(fixture.context)
    mount(fixture, 'view:quirky.accounts/settings', container)
  })
  await waitUntil(() => fixture.remoteResolutionStarted(), 'Remote owner resolution did not reach its held response.')
  const handler = fixture.provided.get('command:quirky.accounts/select-account')
  if (typeof handler !== 'function') throw new Error('Missing select-account command')
  let loadingRefusal: Promise<unknown> | undefined
  await act(() => {
    loadingRefusal = (handler as (args?: unknown) => Promise<unknown>)({ provider: 'claude', accountId: 'remote-account' })
  })
  if (!loadingRefusal) throw new Error('Missing loading-owner selection result')
  expect(await loadingRefusal).toEqual({ ok: false, reason: 'owner-unavailable' })
  await act(async () => { fixture.releaseRemoteResolution(); await Promise.resolve() })
  await waitUntil(() => fixture.firstRemoteListStarted(), 'Remote Accounts request did not start for the focused mirror.')
  expect(fixture.calls.filter((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'select')).toEqual([])

  await act(async () => { fixture.emitLayout(localLayout(world.localWorktree.id)) })
  await waitUntil(() => container.textContent?.includes('Local Claude account') === true, 'The new local workspace scope did not load.')
  const remoteOwnerCallsBeforeStaleDelivery = fixture.calls.filter((item) => item.method === 'quirky.accounts/ownerCall').length
  await act(async () => { fixture.resolveFirstRemoteList(); await fixture.whenIdle() })
  await act(async () => {
    fixture.emitEvent({ type: 'quirky.accounts/changed', data: { revision: 99, owner } } as unknown as QuirkyEvent)
    await Bun.sleep(50)
    await fixture.whenIdle()
  })
  expect(container.textContent).toContain('Local Claude account')
  expect(container.textContent).not.toContain('Remote Claude active')
  expect(fixture.calls.filter((item) => item.method === 'quirky.accounts/ownerCall')).toHaveLength(remoteOwnerCallsBeforeStaleDelivery)

  await call(world.remote, 'quirky.worktree/remove', {
    worktree: `id:${world.remoteWorktree.id}`,
    safeOnly: true,
    skipArchive: true,
    yes: true
  })
  const replacement = await call<{ worktree: Worktree }>(world.remote, 'quirky.worktree/create', {
    repo: world.remoteRepoId,
    name: world.remoteWorktree.name
  })
  expect(replacement.worktree.id).toBe(world.remoteWorktree.id)
  expect(replacement.worktree.instanceId).not.toBe(world.remoteWorktree.instanceId)
  await world.remote.harness.daemon.stop()

  await act(async () => {
    fixture.emitLayout(remoteLayout(world.mirror.id))
    await fixture.whenIdle()
    await Promise.resolve()
  })
  expect(container.textContent).not.toContain('Remote Claude active')
  expect(container.textContent).not.toContain('Local Claude account')
  const unavailableHandler = fixture.provided.get('command:quirky.accounts/select-account')
  if (typeof unavailableHandler !== 'function') throw new Error('Missing select-account command')
  const unavailableRefusal = await (unavailableHandler as (args?: unknown) => unknown)({ provider: 'claude', accountId: 'remote-account' })
  expect(unavailableRefusal).toEqual({ ok: false, reason: 'owner-unavailable' })
  expect(fixture.calls.filter((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'select')).toEqual([])
  const refreshCommand = fixture.provided.get('command:quirky.accounts/refresh')
  if (typeof refreshCommand !== 'function') throw new Error('Missing refresh command')
  await act(async () => {
    await (refreshCommand as (args?: unknown) => unknown)({ provider: 'grok' })
    await fixture.whenIdle()
  })
  expect(fixture.calls.some((item) => item.method === 'quirky.accounts/refresh')).toBe(false)
}, 15_000)
type IsolatedAccountsUi = { activate: typeof activate; deactivate: typeof deactivate }

async function buildWindowUiModules(): Promise<{ main: IsolatedAccountsUi; auxiliary: IsolatedAccountsUi; remove(): void }> {
  const directory = mkdtempSync(join(import.meta.dir, '.accounts-ui-windows-'))
  const mainPath = join(directory, 'main.mjs')
  const auxiliaryPath = join(directory, 'auxiliary.mjs')
  try {
    const bundle = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/ui.tsx')],
      target: 'bun',
      packages: 'external'
    })
    if (!bundle.success) throw new Error(bundle.logs.map((entry) => entry.message).join('\n'))
    await Bun.write(mainPath, bundle.outputs[0]!)
    copyFileSync(mainPath, auxiliaryPath)
    return {
      main: await import(pathToFileURL(mainPath).href) as IsolatedAccountsUi,
      auxiliary: await import(pathToFileURL(auxiliaryPath).href) as IsolatedAccountsUi,
      remove: () => rmSync(directory, { recursive: true, force: true })
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}

function usageForAccounts(state: AccountState) {
  return {
    providers: (['claude', 'codex'] as const).map((provider) => ({
      provider, accountId: state.active[provider], status: 'ok', error: null, updatedAt: 1, session: null, weekly: null
    })),
    inactive: {},
    updatedAt: 1
  }
}

test('auxiliary Settings routes commands to its own local Accounts store when main is remote', async () => {
  const world = await makeOwnerWorld('accounts-ui-origin-window')
  await prepareScopeAccounts(world)
  await addAccount(world.local, 'claude', 'Auxiliary Claude target', 'auxiliary-target@example.test')
  const localState = await call<AccountState>(world.local, 'quirky.accounts/list')
  const remoteState = await call<AccountState>(world.remote, 'quirky.accounts/list')
  const target = localState.accounts.find((account) => account.provider === 'claude' && account.id !== localState.active.claude)
  if (!target) throw new Error('Missing auxiliary local Claude selection target')
  const auxiliaryLoginUrl = 'https://auth.openai.com/oauth/authorize?state=auxiliary-window'
  const loginStatus = Promise.withResolvers<unknown>()
  let auxiliaryAccounts: AccountState = {
    ...localState,
    pendingLogin: {
      id: 'auxiliary-login', provider: 'codex', accountId: null, status: 'pending',
      url: auxiliaryLoginUrl, error: null, result: null
    }
  }
  let auxiliaryUsage = usageForAccounts(localState)
  const windows = new Map<number, ContextFixture>()
  const main = makeContext(world, { layout: remoteLayout(world.mirror.id), connId: 101, windows })
  const auxiliary = makeContext(world, { layout: localLayout(world.localWorktree.id), connId: 202, windows })
  windows.set(101, main)
  windows.set(202, auxiliary)
  const originalAuxiliaryCall = auxiliary.context.call.bind(auxiliary.context)
  auxiliary.context.call = async (method, params = {}) => {
    if (method === 'quirky.accounts/list') {
      auxiliary.calls.push({ method, params })
      return auxiliaryAccounts
    }
    if (method === 'quirky.accounts/loginStatus') {
      auxiliary.calls.push({ method, params })
      return await loginStatus.promise
    }
    if (method === 'quirky.accounts/usage' || method === 'quirky.accounts/refresh') {
      auxiliary.calls.push({ method, params })
      return auxiliaryUsage
    }
    return originalAuxiliaryCall(method, params)
  }
  auxiliary.context.executeCommand = async (id, args, options) => {
    auxiliary.commandInvocations.push({ id, args, ...(options ? { options } : {}) })
    const handler = main.provided.get(id)
    if (typeof handler === 'function') await (handler as (args?: unknown) => unknown)(args)
  }

  const modules = await buildWindowUiModules()
  const { main: mainUi, auxiliary: auxiliaryUi } = modules
  const originalClipboard = navigator.clipboard
  const clipboardWrites: string[] = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (value: string) => { clipboardWrites.push(value) } }
  })
  try {
    await act(async () => {
      mainUi.activate(main.context)
      mount(main, 'view:quirky.accounts/settings', container)
      auxiliaryUi.activate(auxiliary.context)
      mount(auxiliary, 'view:quirky.accounts/settings', statusContainer)
    })
    await waitUntil(
      () => container.textContent?.includes('Remote Claude active') === true,
      `The main window did not load its remote Accounts owner. Text: ${container.textContent}; calls: ${JSON.stringify(main.calls)}`
    )
    await waitUntil(() => statusContainer.textContent?.includes('Auxiliary Claude target') === true, 'The auxiliary window did not load its local Accounts state.')

    const codexTab = buttonsByText(statusContainer, 'Codex')[0]
    if (!codexTab) throw new Error('Missing auxiliary Codex settings tab')
    await act(async () => { codexTab.click() })
    await waitUntil(() => buttonsByText(statusContainer, 'Copy link').length > 0, 'The auxiliary pending login did not render its Copy link action.')
    await act(async () => { buttonsByText(statusContainer, 'Copy link')[0]!.click() })
    await auxiliary.whenIdle()
    await main.whenIdle()
    expect(auxiliary.calls.some((item) => item.method === 'ui.window.self')).toBe(true)
    expect(main.calls.some((item) => item.method === 'ui.window.self')).toBe(true)
    expect(clipboardWrites).toEqual([auxiliaryLoginUrl])
    expect(auxiliary.commandInvocations.at(-1)).toEqual({
      id: 'command:quirky.accounts/copy-login-link',
      args: { id: 'auxiliary-login', provider: 'codex', url: auxiliaryLoginUrl, connId: 202 },
      options: { activateOwner: false }
    })
    expect(main.calls.filter((item) => item.method === 'ui.window.command.run').at(-1)?.params).toEqual({
      connId: 202,
      id: 'command:quirky.accounts/copy-login-link',
      args: { id: 'auxiliary-login', provider: 'codex', url: auxiliaryLoginUrl }
    })

    const claudeTab = buttonsByText(statusContainer, 'Claude')[0]
    if (!claudeTab) throw new Error('Missing auxiliary Claude settings tab')
    await act(async () => { claudeTab.click() })
    await act(async () => { await auxiliary.whenIdle() })
    await waitUntil(
      () => Boolean(statusContainer.querySelector(`[aria-label="Select Claude account ${target.label}"]`)),
      'The auxiliary Claude account selection did not render.'
    )
    const select = buttonByLabel(statusContainer, `Select Claude account ${target.label}`)
    await act(async () => { select.click() })
    await act(async () => {
      await auxiliary.whenIdle()
      await main.whenIdle()
    })
    const localAfterSelection = await call<AccountState>(world.local, 'quirky.accounts/list')
    auxiliaryAccounts = localAfterSelection
    auxiliaryUsage = usageForAccounts(localAfterSelection)
    expect(localAfterSelection.active.claude).toBe(target.id)
    expect((await call<AccountState>(world.remote, 'quirky.accounts/list')).active.claude).toBe(remoteState.active.claude)
    expect(auxiliary.calls.filter((item) => item.method === 'quirky.accounts/select').at(-1)?.params)
      .toEqual({ provider: 'claude', accountId: target.id })
    expect(main.calls.some((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'select')).toBe(false)
    expect(auxiliary.commandInvocations.at(-1)).toEqual({
      id: 'command:quirky.accounts/select-account',
      args: { provider: 'claude', accountId: target.id, connId: 202 },
      options: { activateOwner: false }
    })
    expect(main.calls.filter((item) => item.method === 'ui.window.command.run').at(-1)?.params).toEqual({
      connId: 202,
      id: 'command:quirky.accounts/select-account',
      args: { provider: 'claude', accountId: target.id }
    })

    const grokTab = buttonsByText(statusContainer, 'Grok (xAI)')[0]
    if (!grokTab) throw new Error('Missing auxiliary Grok settings tab')
    await act(async () => { grokTab.click() })
    await act(async () => { await auxiliary.whenIdle() })
    await waitUntil(
      () => Boolean(statusContainer.querySelector('[aria-label="Refresh Grok (xAI) usage"]')),
      'The auxiliary Grok refresh action did not render.'
    )
    await act(async () => { buttonByLabel(statusContainer, 'Refresh Grok (xAI) usage').click() })
    await act(async () => {
      await auxiliary.whenIdle()
      await main.whenIdle()
    })
    expect(auxiliary.calls.filter((item) => item.method === 'quirky.accounts/refresh').at(-1)?.params)
      .toEqual({ provider: 'grok', force: true })
    expect(main.calls.some((item) => item.method === 'quirky.accounts/ownerCall' && item.params?.operation === 'refresh')).toBe(false)
    expect(auxiliary.commandInvocations.at(-1)).toEqual({
      id: 'command:quirky.accounts/refresh',
      args: { provider: 'grok', connId: 202 },
      options: { activateOwner: false }
    })
    expect(main.calls.filter((item) => item.method === 'ui.window.command.run').at(-1)?.params).toEqual({
      connId: 202,
      id: 'command:quirky.accounts/refresh',
      args: { provider: 'grok' }
    })

    const selectCommand = main.provided.get('command:quirky.accounts/select-account')
    if (typeof selectCommand !== 'function') throw new Error('Missing owner select-account command')
    const staleResult = await (selectCommand as (args?: unknown) => unknown)({
      provider: 'claude', accountId: target.id, connId: 999
    })
    expect(staleResult).toEqual({ ok: false, reason: 'owner-unavailable' })
    expect(JSON.stringify(staleResult)).not.toContain(auxiliaryLoginUrl)
    expect(auxiliary.calls.filter((item) => item.method === 'quirky.accounts/select')).toHaveLength(1)
  } finally {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: originalClipboard })
    await act(async () => {
      for (const cleanup of unregister.splice(0)) cleanup()
      mainUi.deactivate()
      auxiliaryUi.deactivate()
      loginStatus.resolve({ status: 'pending', url: auxiliaryLoginUrl, error: null, result: null })
      await Promise.resolve()
      modules.remove()
    })
  }
}, 30_000)
