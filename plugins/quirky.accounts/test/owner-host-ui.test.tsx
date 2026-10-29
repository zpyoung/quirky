import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { OwnerSessionHostRef, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
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
type ContextFixture = {
  context: UiPluginContext
  calls: Call[]
  provided: Map<string, unknown>
  events: ((event: QuirkyEvent) => void | Promise<void>)[]
  emitLayout(layout: UiLayout): void
  emitEvent(event: QuirkyEvent): void
  resolveFirstRemoteList(): void
  whenIdle(): Promise<void>
  firstRemoteListStarted(): boolean
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

function makeContext(world: OwnerWorld, options: { layout: UiLayout; holdFirstRemoteList?: boolean }): ContextFixture {
  let layout = options.layout
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
  const calls: Call[] = []
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
        const result = await world.local.client.callAny(method, params)
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
    getSetting: () => false,
    executeCommand: async () => {},
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
  expect(fixture.calls).toContainEqual(expect.objectContaining({
    method: 'quirky.accounts/ownerCall',
    params: expect.objectContaining({
      owner,
      operation: 'select',
      params: { provider: 'claude', accountId: accounts.remoteNext.id }
    })
  }))
  expect(container.textContent).not.toContain('Local Claude account')

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
})

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
})

test('a stale remote response and owner event cannot replace the new local scope; a replaced offline mirror never falls back locally', async () => {
  const world = await makeOwnerWorld('accounts-ui-stale-scope')
  await prepareScopeAccounts(world)
  const owner = hostRef(world.host)
  const fixture = makeContext(world, { layout: remoteLayout(world.mirror.id), holdFirstRemoteList: true })
  await act(async () => {
    activate(fixture.context)
    mount(fixture, 'view:quirky.accounts/settings', container)
  })
  await waitUntil(() => fixture.firstRemoteListStarted(), 'Remote Accounts request did not start for the focused mirror.')

  await act(async () => { fixture.emitLayout(localLayout(world.localWorktree.id)) })
  await waitUntil(() => container.textContent?.includes('Local Claude account') === true, 'The new local workspace scope did not load.')
  const remoteOwnerCallsBeforeStaleDelivery = fixture.calls.filter((item) => item.method === 'quirky.accounts/ownerCall').length
  fixture.resolveFirstRemoteList()
  await settle(40)
  fixture.emitEvent({ type: 'quirky.accounts/changed', data: { revision: 99, owner } } as unknown as QuirkyEvent)
  await settle(50)
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
})
