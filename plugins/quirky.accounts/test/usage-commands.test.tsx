import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type * as AccountsUiModule from '../src/ui'
import {
  PROVIDERS, REFRESH_COMMAND_ID, SELECT_ACCOUNT_COMMAND_ID,
  type AccountState, type AccountUiState, type ManagedProvider, type Preferences, type ProviderId, type UsageState
} from '../src/window/model'
import { discoverCandidates } from '../../../scripts/ui-scoreboard/audit-discovery'
import type { PluginInventory } from '../../../scripts/ui-scoreboard/contracts'

const STATUS_BAR_ID = 'status-bar:quirky.accounts/usage'
const DEFAULT_PREFERENCES: Preferences = {
  mode: 'compact', direction: 'used', hidden: false, visibleProviders: [...PROVIDERS],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}
const INITIAL_UI: AccountUiState = { open: false, provider: null, expanded: null, settingsSection: null }

type RpcCall = { method: string; params: Record<string, unknown> }
type CommandInvocation = { id: string; args?: unknown; options?: { activateOwner?: boolean } }
type FixtureOptions = {
  remote?: boolean
  resetOffer?: boolean
  resetOutcome?: 'noCredit'
  ui?: AccountUiState
}
type Fixture = {
  context: UiPluginContext
  calls: RpcCall[]
  commands: CommandInvocation[]
  provided: Map<string, unknown>
  openViews: string[]
}

let accountsUi: typeof AccountsUiModule
let container: HTMLElement
let cleanupMount: (() => void) | undefined

beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  // Import after happy-dom registration so ReactDOM detects the simulated browser event environment.
  accountsUi = await import('../src/ui')
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => {
    cleanupMount?.()
    cleanupMount = undefined
    accountsUi.deactivate()
  })
  container.remove()
})

function makeAccount(id: string, provider: ManagedProvider, label: string, active: boolean) {
  return {
    id, provider, label, email: `${id}@example.test`, organization: null,
    createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1, needsSignIn: false, active
  }
}

function makeAccountState(prefix: string): AccountState {
  return {
    accounts: [
      makeAccount(`${prefix.toLowerCase()}-claude-a`, 'claude', `${prefix} Claude A`, true),
      makeAccount(`${prefix.toLowerCase()}-claude-b`, 'claude', `${prefix} Claude B`, false),
      makeAccount(`${prefix.toLowerCase()}-codex-a`, 'codex', `${prefix} Codex A`, true)
    ],
    active: { claude: `${prefix.toLowerCase()}-claude-a`, codex: `${prefix.toLowerCase()}-codex-a` },
    systemDefault: {
      claude: { label: 'System default', email: null, hasAuth: true, authKind: 'oauth' },
      codex: { label: 'System default', email: null, hasAuth: true, authKind: 'oauth' }
    },
    pendingLogin: null, staleSessions: [], configWarnings: [],
    preferences: { ...DEFAULT_PREFERENCES, visibleProviders: [...DEFAULT_PREFERENCES.visibleProviders] },
    revision: 1
  }
}

function selectAccount(state: AccountState, provider: ManagedProvider, accountId: string | null): AccountState {
  return {
    ...state,
    active: { ...state.active, [provider]: accountId },
    accounts: state.accounts.map((account) => account.provider === provider
      ? { ...account, active: account.id === accountId }
      : account),
    revision: state.revision + 1
  }
}

function makeUsageState(state: AccountState, resetOffer: boolean): UsageState {
  return {
    providers: PROVIDERS.map((provider: ProviderId) => {
      const managed = provider === 'claude' || provider === 'codex'
      const accountId = managed ? state.active[provider] : null
      const snapshot = {
        provider,
        accountId,
        status: managed ? 'ok' as const : 'unavailable' as const,
        error: null,
        updatedAt: 10,
        session: null,
        weekly: managed ? { usedPercent: provider === 'claude' ? 42 : 61, windowMinutes: 10_080, resetsAt: 1_000, resetDescription: 'soon' } : null
      }
      if (provider !== 'codex' || !resetOffer) return snapshot
      return {
        ...snapshot,
        rateLimitResetCredits: {
          availableCount: 1,
          expectedScope: { accountId: state.active.codex, accountRevision: state.revision, offerRevision: 'fixture-offer' }
        }
      }
    }),
    inactive: {},
    updatedAt: 10
  }
}

function makeFixture(options: FixtureOptions = {}): Fixture {
  let localAccounts = makeAccountState('Local')
  let remoteAccounts = makeAccountState('Remote')
  let localUsage = makeUsageState(localAccounts, options.resetOffer ?? false)
  let remoteUsage = makeUsageState(remoteAccounts, false)
  let uiState: AccountUiState = options.ui ?? INITIAL_UI
  const calls: RpcCall[] = []
  const commands: CommandInvocation[] = []
  const provided = new Map<string, unknown>()
  const listeners: ((event: QuirkyEvent) => void | Promise<void>)[] = []
  const openViews: string[] = []
  const ownerIdentity = { hostId: 'fixture-owner', generation: 'owner-generation' }
  const owner = {
    hostId: ownerIdentity.hostId,
    identity: ownerIdentity,
    runtime: { id: 'fixture-runtime', name: 'Fixture owner', endpoint: 'http://127.0.0.1', grantId: 'fixture-grant' }
  }
  const mirror = {
    id: 'fixture-mirror', hostId: ownerIdentity.hostId, identity: ownerIdentity,
    worktree: { id: 'fixture-worktree', instanceId: 'fixture-instance' },
    connected: true, fingerprint: 'fixture-fingerprint'
  }

  const call = async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    calls.push({ method, params })
    if (method === 'ui.window.self') return { connId: 7 }
    if (method === 'ui.window.command.run') {
      const id = params.id
      const handler = typeof id === 'string' ? provided.get(id) : undefined
      if (typeof handler !== 'function') throw new Error(`Missing fixture command: ${String(id)}`)
      const result = await (handler as (args?: unknown) => unknown)(params.args)
      return { result: result ?? null }
    }
    if (method === 'quirky.worktree/remoteShow') return mirror
    if (method === 'quirky.worktree/remoteHostStatus') {
      return { id: ownerIdentity.hostId, identity: ownerIdentity, runtime: owner.runtime, connected: true }
    }
    if (method === 'quirky.accounts/ownerCall') {
      const operation = params.operation
      if (operation === 'list') return remoteAccounts
      if (operation === 'usage') return remoteUsage
      if (operation === 'credentialStatus') return []
      if (operation === 'agentsList' || operation === 'agentsRefresh') return { agents: [] }
      if (operation === 'refresh') return remoteUsage
      if (operation === 'select') {
        const action = params.params
        if (action && typeof action === 'object' && !Array.isArray(action)) {
          const selection = action as Record<string, unknown>
          const provider = selection.provider
          const accountId = selection.accountId
          if ((provider === 'claude' || provider === 'codex') && (accountId === null || typeof accountId === 'string')) {
            remoteAccounts = selectAccount(remoteAccounts, provider, accountId)
            remoteUsage = makeUsageState(remoteAccounts, false)
          }
        }
        return remoteAccounts
      }
      throw new Error(`Unexpected fixture owner operation: ${String(operation)}`)
    }
    if (method === 'quirky.accounts/list') return localAccounts
    if (method === 'quirky.accounts/usage') return localUsage
    if (method === 'quirky.accounts/credentialStatus') return []
    if (method === 'quirky.agents/list' || method === 'quirky.agents/refresh') return { agents: [] }
    if (method === 'quirky.accounts/uiState') return { ...uiState }
    if (method === 'quirky.accounts/setUiState') {
      uiState = { ...uiState, ...params } as AccountUiState
      return { ...uiState }
    }
    if (method === 'quirky.accounts/setPreferences') {
      localAccounts = {
        ...localAccounts,
        preferences: { ...localAccounts.preferences, ...params } as Preferences
      }
      return localAccounts
    }
    if (method === 'quirky.accounts/select') {
      const provider = params.provider
      const accountId = params.accountId
      if ((provider !== 'claude' && provider !== 'codex') || !(accountId === null || typeof accountId === 'string')) {
        throw new Error('Invalid fixture account selection')
      }
      localAccounts = selectAccount(localAccounts, provider, accountId)
      localUsage = makeUsageState(localAccounts, options.resetOffer ?? false)
      return localAccounts
    }
    if (method === 'quirky.accounts/refresh') return options.remote ? localUsage : localUsage
    if (method === 'quirky.accounts/consumeResetCredit') {
      return { outcome: options.resetOutcome ?? 'noCredit', state: localUsage }
    }
    throw new Error(`Unexpected fixture RPC: ${method}`)
  }

  const layout = options.remote
    ? { view: { id: 'view:quirky.worktree/remote', input: { workspace: mirror.id } }, panel: null, sidebar: true, focus: 'view' }
    : { view: null, panel: null, sidebar: true, focus: null }
  const context = {
    pluginId: 'quirky.accounts',
    log: () => {},
    provide: (id: string, implementation: unknown) => provided.set(id, implementation),
    call,
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      listeners.push(listener)
      return () => { const index = listeners.indexOf(listener); if (index !== -1) listeners.splice(index, 1) }
    },
    executeCommand: async (id: string, args?: unknown, commandOptions?: { activateOwner?: boolean }) => {
      commands.push({ id, args, ...(commandOptions ? { options: commandOptions } : {}) })
      const handler = provided.get(id)
      return typeof handler === 'function' ? await (handler as (args?: unknown) => unknown)(args) : undefined
    },
    getSetting: () => false,
    openView: (id: string) => openViews.push(id),
    closeView: () => {},
    togglePanel: () => {},
    getLayout: () => layout,
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast: () => {},
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }

  return { context: context as unknown as UiPluginContext, calls, commands, provided, openViews }
}

async function mountUsage(options: FixtureOptions = {}): Promise<Fixture> {
  const fixture = makeFixture(options)
  await act(async () => {
    accountsUi.activate(fixture.context)
    const mount = fixture.provided.get(STATUS_BAR_ID)
    if (typeof mount !== 'function') throw new Error('Missing Usage status bar contribution')
    const cleanup = (mount as (element: HTMLElement, props: { report?: unknown }) => (() => void) | void)(container, {})
    cleanupMount = typeof cleanup === 'function' ? cleanup : undefined
    await Promise.resolve()
  })
  await settle()
  return fixture
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let index = 0; index < 16; index += 1) await Promise.resolve()
  })
}

async function clickButton(button: HTMLButtonElement): Promise<void> {
  await act(async () => {
    button.click()
    for (let index = 0; index < 16; index += 1) await Promise.resolve()
  })
}

function buttonByLabel(root: ParentNode, label: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.getAttribute('aria-label') === label)
  if (!button) throw new Error(`Missing button with label: ${label}`)
  return button
}

function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const button = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!button) throw new Error(`Missing button with text: ${text}`)
  return button
}

function dialogByTitle(root: ParentNode, title: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"][aria-labelledby]')].find((dialog) => {
    const heading = (dialog.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => dialog.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
    return heading === title
  }) ?? null
}

test('System default account selection routes through the local select-account command', async () => {
  const fixture = await mountUsage({ ui: { open: true, provider: 'claude', expanded: 'claude', settingsSection: null } })

  await clickButton(buttonByLabel(container, 'Select Claude System default'))

  expect(fixture.commands.at(-1)).toEqual({
    id: SELECT_ACCOUNT_COMMAND_ID,
    args: { provider: 'claude', accountId: null, connId: 7 },
    options: { activateOwner: false }
  })
  expect(fixture.calls).toContainEqual({ method: 'quirky.accounts/select', params: { provider: 'claude', accountId: null } })
})

test('managed account selection routes through the local select-account command', async () => {
  const fixture = await mountUsage({ ui: { open: true, provider: 'claude', expanded: 'claude', settingsSection: null } })

  await clickButton(buttonByLabel(container, 'Select Claude account Local Claude B'))

  expect(fixture.commands.at(-1)).toEqual({
    id: SELECT_ACCOUNT_COMMAND_ID,
    args: { provider: 'claude', accountId: 'local-claude-b', connId: 7 },
    options: { activateOwner: false }
  })
  expect(fixture.calls).toContainEqual({
    method: 'quirky.accounts/select', params: { provider: 'claude', accountId: 'local-claude-b' }
  })
})

test('managed account selection routes through the command registry to a ready remote owner', async () => {
  const fixture = await mountUsage({
    remote: true,
    ui: { open: true, provider: 'claude', expanded: 'claude', settingsSection: null }
  })

  expect(container.textContent).toContain('Fixture owner')
  await clickButton(buttonByLabel(container, 'Select Claude account Remote Claude B'))

  expect(fixture.commands.at(-1)).toEqual({
    id: SELECT_ACCOUNT_COMMAND_ID,
    args: { provider: 'claude', accountId: 'remote-claude-b', connId: 7 },
    options: { activateOwner: false }
  })
  expect(fixture.calls.some((call) => call.method === 'quirky.accounts/ownerCall' && call.params.operation === 'select' &&
    (call.params.params as Record<string, unknown> | undefined)?.accountId === 'remote-claude-b')).toBe(true)
  expect(fixture.calls.some((call) => call.method === 'quirky.accounts/select')).toBe(false)
})

test('status-bar and Usage popover refresh route through the global refresh command', async () => {
  const fixture = await mountUsage()

  await clickButton(buttonByLabel(container, 'Refresh rate limits'))
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const popover = container.querySelector('.usage-popover')
  if (!(popover instanceof HTMLElement)) throw new Error('Missing Usage popover')
  await clickButton(buttonByLabel(popover, 'Refresh rate limits'))

  expect(fixture.commands.filter((command) => command.id === REFRESH_COMMAND_ID)).toEqual([
    { id: REFRESH_COMMAND_ID, args: { connId: 7 }, options: { activateOwner: false } },
    { id: REFRESH_COMMAND_ID, args: { connId: 7 }, options: { activateOwner: false } }
  ])
  expect(fixture.calls.filter((call) => call.method === 'quirky.accounts/refresh').map((call) => call.params)).toEqual([
    { force: true }, { force: true }
  ])
})

test('provider details refresh routes through the provider-scoped refresh command', async () => {
  const fixture = await mountUsage()
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const popover = container.querySelector('.usage-popover')
  if (!(popover instanceof HTMLElement)) throw new Error('Missing Usage popover')
  await clickButton(buttonByLabel(popover, 'Open Claude details and account switcher'))
  const details = container.querySelector('[aria-label="Claude usage details"]')
  if (!(details instanceof HTMLElement)) throw new Error('Missing Claude usage details')

  await clickButton(buttonByLabel(details, 'Refresh rate limits'))

  expect(fixture.commands.at(-1)).toEqual({
    id: REFRESH_COMMAND_ID,
    args: { provider: 'claude', connId: 7 },
    options: { activateOwner: false }
  })
  expect(fixture.calls).toContainEqual({ method: 'quirky.accounts/refresh', params: { provider: 'claude', force: true } })
})

test('Codex no-credit outcome refresh routes through the Codex refresh command', async () => {
  const fixture = await mountUsage({ resetOffer: true, resetOutcome: 'noCredit' })
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const popover = container.querySelector('.usage-popover')
  if (!(popover instanceof HTMLElement)) throw new Error('Missing Usage popover')
  await clickButton(buttonByLabel(popover, 'Open Codex details and account switcher'))
  await clickButton(buttonByLabel(container, 'Reset Codex limits'))
  const dialog = dialogByTitle(container, 'Reset Codex limits confirmation')
  if (!dialog) throw new Error('Missing Codex reset confirmation')
  await clickButton(buttonByText(dialog, 'Reset now'))
  if (!dialog.querySelector('[role="alert"]')?.textContent?.includes('No Codex reset credit')) {
    throw new Error('Expected the fixture no-credit reset outcome')
  }

  await clickButton(buttonByText(dialog, 'Refresh usage'))

  expect(fixture.commands.at(-1)).toEqual({
    id: REFRESH_COMMAND_ID,
    args: { provider: 'codex', connId: 7 },
    options: { activateOwner: false }
  })
  expect(fixture.calls).toContainEqual({ method: 'quirky.accounts/refresh', params: { provider: 'codex', force: true } })
  expect(fixture.calls.some((call) => call.method === 'quirky.accounts/consumeResetCredit')).toBe(true)
})

test('closing the visibility menu leaves Usage open and does not route an action', async () => {
  const fixture = await mountUsage()
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const statusBar = container.querySelector('.usage-status-bar')
  if (!(statusBar instanceof HTMLElement)) throw new Error('Missing Usage status bar')
  await act(async () => {
    statusBar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  const menu = container.querySelector('[role="menu"][aria-label="Usage visibility"]')
  if (!(menu instanceof HTMLElement)) throw new Error('Missing Usage visibility menu')
  const uiWritesBefore = fixture.calls.filter((call) => call.method === 'quirky.accounts/setUiState').length
  const commandsBefore = fixture.commands.length

  await clickButton(buttonByText(menu, 'Close menu'))

  expect(container.querySelector('[role="menu"][aria-label="Usage visibility"]')).toBeNull()
  expect(container.querySelector('.usage-popover')).not.toBeNull()
  expect(fixture.calls.filter((call) => call.method === 'quirky.accounts/setUiState')).toHaveLength(uiWritesBefore)
  expect(fixture.commands).toHaveLength(commandsBefore)
})

test('cancelling Codex reset confirmation leaves provider details open without an RPC or command', async () => {
  const fixture = await mountUsage({ resetOffer: true })
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const popover = container.querySelector('.usage-popover')
  if (!(popover instanceof HTMLElement)) throw new Error('Missing Usage popover')
  await clickButton(buttonByLabel(popover, 'Open Codex details and account switcher'))
  await clickButton(buttonByLabel(container, 'Reset Codex limits'))
  const dialog = dialogByTitle(container, 'Reset Codex limits confirmation')
  if (!dialog) throw new Error('Missing Codex reset confirmation')
  const callsBefore = fixture.calls.length
  const commandsBefore = fixture.commands.length

  await clickButton(buttonByText(dialog, 'Cancel'))

  expect(dialogByTitle(container, 'Reset Codex limits confirmation')).toBeNull()
  expect(container.querySelector('[aria-label="Codex usage details"]')).not.toBeNull()
  expect(container.querySelector('.usage-popover')).not.toBeNull()
  expect(fixture.calls.slice(callsBefore)).toEqual([])
  expect(fixture.commands.slice(commandsBefore)).toEqual([])
})

test('Usage display preferences and settings navigation use their store routes', async () => {
  const fixture = await mountUsage()
  await clickButton(buttonByLabel(container, 'Open Usage'))
  const popover = container.querySelector('.usage-popover')
  if (!(popover instanceof HTMLElement)) throw new Error('Missing Usage popover')

  await clickButton(buttonByText(popover, 'Detailed'))
  expect(fixture.calls).toContainEqual({ method: 'quirky.accounts/setPreferences', params: { mode: 'detailed' } })
  await clickButton(buttonByText(popover, 'Manage Accounts…'))

  expect(fixture.calls).toContainEqual({
    method: 'quirky.accounts/setUiState', params: { open: false, provider: null, settingsSection: 'claude' }
  })
  expect(fixture.openViews).toContain('view:quirky.accounts/settings')
})

test('Usage source has no unresolved spread or assignment scoreboard candidates', () => {
  const file = 'plugins/quirky.accounts/src/window/Usage.tsx'
  const source = readFileSync(new URL('../src/window/Usage.tsx', import.meta.url), 'utf8')
  const plugin: PluginInventory = {
    id: 'quirky.accounts', directory: 'plugins/quirky.accounts', hasUi: true, targets: [],
    sources: [{ file, content: source }]
  }
  const unresolved = discoverCandidates(plugin, [file]).filter((candidate) =>
    candidate.kind === 'unresolved-spread' || candidate.kind === 'unresolved-assignment'
  )

  expect(unresolved).toEqual([])
})
