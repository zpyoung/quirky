import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { activate, deactivate } from '../src/ui'
import type { AccountState, ManagedProvider, Preferences, StaleSession } from '../src/types'
import type { CredentialStatus, ProviderSnapshot, ResetCreditExpectedScope } from '../src/usage/types'

const preferences: Preferences = {
  mode: 'compact', direction: 'used', hidden: false,
  visibleProviders: ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}
const systemDefault = {
  claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' as const },
  codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' as const }
}

function makeState(provider: ManagedProvider, revision: number, selectedLabel: string, options: { stale?: boolean; kept?: boolean } = {}): AccountState {
  const accountId = `${provider}-a`
  const account = {
    id: accountId, provider, label: 'Account A', email: 'a@example.test', organization: null,
    createdAt: 1, updatedAt: revision, lastAuthenticatedAt: 1, needsSignIn: false, active: true
  }
  const staleSession: StaleSession = {
    sessionId: 'session-1', provider, accountId, accountLabel: 'Account A', selectedId: `${provider}-b`, selectedLabel,
    busy: false, queued: false, kept: options.kept ?? false, error: null, selectionRevision: revision
  }
  return {
    accounts: [account], active: { claude: provider === 'claude' ? accountId : null, codex: provider === 'codex' ? accountId : null },
    systemDefault, pendingLogin: null,
    staleSessions: options.stale === false ? [] : [staleSession], configWarnings: [], preferences: { ...preferences }, revision
  }
}
function makeClaudeSelection(revision: number, selectedId: string, selectedLabel: string): AccountState {
  const state = makeState('claude', revision, selectedLabel)
  const oldAccount = state.accounts[0]!
  return {
    ...state,
    accounts: [{ ...oldAccount, active: false }, { ...oldAccount, id: selectedId, label: selectedLabel, email: `${selectedId}@example.test`, active: true }],
    active: { ...state.active, claude: selectedId },
    staleSessions: state.staleSessions.map((session) => ({ ...session, selectedId }))
  }
}

type UsageFixture = { providers: ProviderSnapshot[]; inactive: Record<string, ProviderSnapshot>; updatedAt: number }
type ResetScope = ResetCreditExpectedScope

function usageFor(state: AccountState, scope: ResetScope = { accountId: state.active.codex, accountRevision: state.revision, offerRevision: `offer-${state.revision}` }): UsageFixture {
  return {
    providers: [
      { provider: 'claude', accountId: state.active.claude, status: 'ok', error: null, updatedAt: 10, session: { usedPercent: 25, windowMinutes: 300, resetsAt: 1000, resetDescription: 'soon' }, weekly: null },
      { provider: 'codex', accountId: state.active.codex, status: 'ok', error: null, updatedAt: 10, session: null, weekly: { usedPercent: 75, windowMinutes: 10080, resetsAt: 1000, resetDescription: 'soon' }, rateLimitResetCredits: { availableCount: 1, expectedScope: scope } }
    ],
    inactive: {}, updatedAt: 10
  }
}

let container: HTMLElement
let unregister: (() => void) | undefined
let stateValue: AccountState
let usageValue: UsageFixture
let provided: Map<string, unknown>
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let calls: { method: string; params?: Record<string, unknown> }[]
let loginGate: Promise<unknown> | null
let resolveLogin!: (value: unknown) => void
let restartGate: Promise<unknown> | null
let restartStarted: Promise<void>
let resolveRestartStarted!: () => void
let rejectStaleReset: boolean
let resetOutcome: 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit'
let credentialStatuses: CredentialStatus[]
let clearCredentialGate: Promise<unknown> | null
let confirmGate: Promise<boolean> | null
let confirmCalls: unknown[]
let externalOpenGate: Promise<unknown> | null

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  stateValue = makeState('codex', 21, 'Account B')
  usageValue = usageFor(stateValue)
  provided = new Map()
  listeners = []
  calls = []
  loginGate = null
  restartGate = null
  const restart = Promise.withResolvers<void>()
  restartStarted = restart.promise
  resolveRestartStarted = restart.resolve
  rejectStaleReset = false
  resetOutcome = 'reset'
  credentialStatuses = []
  clearCredentialGate = null
  confirmGate = null
  confirmCalls = []
  externalOpenGate = null
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => {
    unregister?.()
    deactivate()
  })
  unregister = undefined
  container.remove()
})

function makeContext(): UiPluginContext {
  let uiState = { open: false, provider: null as string | null, expanded: null as ManagedProvider | null, settingsSection: null as string | null }
  const context = {
    pluginId: 'quirky.accounts', log: () => {}, provide: (id: string, implementation: unknown) => provided.set(id, implementation),
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.accounts/list') return stateValue
      if (method === 'quirky.accounts/uiState') return { ...uiState }
      if (method === 'quirky.accounts/usage' || method === 'quirky.accounts/refresh') return usageValue
      if (method === 'quirky.accounts/credentialStatus') return credentialStatuses
      if (method === 'quirky.agents/list' || method === 'quirky.agents/refresh') return { agents: [] }
      if (method === 'quirky.accounts/setUiState') {
        if (typeof params?.open === 'boolean') uiState.open = params.open
        if (params?.provider === null || typeof params?.provider === 'string') uiState.provider = params.provider
        if (params?.expanded === null || params?.expanded === 'claude' || params?.expanded === 'codex') uiState.expanded = params.expanded
        if (params?.settingsSection === null || typeof params?.settingsSection === 'string') uiState.settingsSection = params.settingsSection
        return { ...uiState }
      }
      if (method === 'quirky.accounts/setPreferences') {
        const updated = { ...stateValue.preferences }
        const policy = params?.claudeSwitchPolicy
        if (policy === 'ask' || policy === 'always' || policy === 'never') updated.claudeSwitchPolicy = policy
        if (typeof params?.skipCodexResetConfirm === 'boolean') updated.skipCodexResetConfirm = params.skipCodexResetConfirm
        stateValue = { ...stateValue, preferences: updated }
        return stateValue
      }
      if (method === 'quirky.accounts/keep') {
        const sessionIds = params?.sessions as string[]
        if (params?.selectionRevision !== stateValue.revision) throw new Error('The selected account changed. Refresh the account state and choose again.')
        stateValue = { ...stateValue, staleSessions: stateValue.staleSessions.map((session) => sessionIds.includes(session.sessionId) ? { ...session, kept: true } : session) }
        return stateValue
      }
      if (method === 'quirky.accounts/restart') {
        resolveRestartStarted()
        if (restartGate) return await restartGate
        if (params?.selectionRevision !== stateValue.revision) throw new Error('The selected account changed. Refresh the account state and choose again.')
        stateValue = { ...stateValue, staleSessions: [] }
        return stateValue
      }
      if (method === 'quirky.accounts/beginLogin') {
        if (loginGate) return await loginGate
        return { id: 'login-1' }
      }
      if (method === 'quirky.accounts/loginStatus') return { status: 'pending', url: null, error: null, result: null }
      if (method === 'quirky.accounts/cancelLogin') return { cancelled: true }
      if (method === 'quirky.terminal/openExternal') {
        if (externalOpenGate) return await externalOpenGate
        return { ok: true }
      }
      if (method === 'quirky.accounts/remove') return stateValue
      if (method === 'quirky.accounts/clearCredential') {
        if (clearCredentialGate) return await clearCredentialGate
        return { provider: params?.provider, kind: params?.kind, configured: false, readable: false }
      }
      if (method === 'quirky.accounts/consumeResetCredit') {
        const codex = usageValue.providers.find((item) => item.provider === 'codex')
        if (rejectStaleReset && JSON.stringify(params?.expectedScope) !== JSON.stringify(codex?.rateLimitResetCredits?.expectedScope)) {
          throw new Error('Codex reset offer changed; refresh usage and confirm again')
        }
        return resetOutcome
      }
      return undefined
    },
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => { listeners.push(listener); return () => { listeners = listeners.filter((item) => item !== listener) } },
    getSetting: () => false, executeCommand: async () => {}, openView: () => {}, closeView: () => {}, togglePanel: () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }), onLayout: () => () => {}, onStream: () => () => {}, onConnection: () => () => {},
    confirm: async (confirmation: unknown) => {
      confirmCalls.push(confirmation)
      if (confirmGate) return await confirmGate
      return true
    }, toast: () => {}, setPanelBadge: () => {}, setContext: () => {}, mountView: () => () => {}
  }
  return context as unknown as UiPluginContext
}

async function emit(event: QuirkyEvent): Promise<void> {
  for (const listener of listeners) await listener(event)
}

async function waitFor<T>(condition: () => T | null, description: string): Promise<T> {
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    const result = condition()
    if (result) return result
    const tick = Promise.withResolvers<void>()
    setTimeout(tick.resolve, 10)
    await act(async () => { await tick.promise })
  }
  throw new Error(`Timed out waiting for ${description}`)
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() })
}

async function mount(id: string, input?: unknown): Promise<void> {
  await act(async () => {
    activate(makeContext())
    const mountFunction = provided.get(id) as ((element: HTMLElement, props: { input?: unknown }) => (() => void) | void) | undefined
    if (!mountFunction) throw new Error(`Missing renderer mount: ${id}`)
    unregister = mountFunction(container, { input }) as (() => void) | undefined
  })
  await settle()
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`)
  return button
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector(`[aria-label="${label}"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  return button
}

test('Codex pane accessory keeps or restarts the old-account session', async () => {
  await mount('view:quirky.accounts/session-accessory', { sessionId: 'session-1', paneId: 'pane-1' })
  await act(async () => { buttonByText('Keep old account').click() })
  await settle()
  expect(container.querySelector('.muted')?.textContent).toContain('Account A')
  expect(container.querySelector('button')).toBeNull()

  await act(async () => { unregister?.(); deactivate() })
  unregister = undefined
  stateValue = makeState('codex', 22, 'Account C')
  await mount('view:quirky.accounts/session-accessory', { sessionId: 'session-1', paneId: 'pane-1' })
  await act(async () => { buttonByText('Restart').click() })
  await settle()
  expect(container.textContent).toBe('')
})

test('Claude switch opt-out checkbox resets when selection changes', async () => {
  stateValue = makeClaudeSelection(41, 'claude-b', 'Account B')
  await mount('overlay:quirky.accounts/switch-dialog')
  const checkbox = container.querySelector('input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing switch opt-out checkbox')
  await act(async () => { checkbox.click() })
  stateValue = makeClaudeSelection(42, 'claude-c', 'Account C')
  await act(async () => {
    await emit({ type: 'quirky.accounts/changed', data: { revision: 42 } } as QuirkyEvent)
  })
  await waitFor(
    () => container.querySelector<HTMLInputElement>('[aria-label="Switched to Account C"] input[type="checkbox"]'),
    'switch dialog to show the changed account selection'
  )
  await settle()
  const refreshedCheckbox = container.querySelector('input[type="checkbox"]')
  if (!(refreshedCheckbox instanceof HTMLInputElement)) throw new Error('Switch dialog did not update to the new selection')
  expect(refreshedCheckbox.checked).toBe(false)
  await act(async () => { refreshedCheckbox.click() })
  const keep = container.querySelector('.switch-dialog .dialog-actions button:first-child')
  if (!(keep instanceof HTMLButtonElement)) throw new Error('Missing dialog Keep as is action')
  await act(async () => { keep.click() })
  await settle()
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

test('Claude switch submission is single-flight while opt-out saves', async () => {
  stateValue = makeState('claude', 51, 'Account B')
  const gate = Promise.withResolvers<unknown>()
  restartGate = gate.promise
  const releaseRestart = gate.resolve
  await mount('overlay:quirky.accounts/switch-dialog')
  const checkbox = container.querySelector('input[type="checkbox"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing switch opt-out checkbox')
  await act(async () => { checkbox.click() })
  const restart = container.querySelector('.switch-dialog .dialog-actions button:last-child')
  if (!(restart instanceof HTMLButtonElement)) throw new Error('Missing dialog Restart session action')
  await act(async () => { restart.click(); restart.click() })
  await restartStarted
  expect(calls.filter((call) => call.method === 'quirky.accounts/restart')).toHaveLength(1)
  expect(restart.disabled).toBe(true)
  expect(container.querySelector('[role="dialog"]')).not.toBeNull()
  await act(async () => { releaseRestart(stateValue = { ...stateValue, staleSessions: [] }) })
  await settle()
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})

test('a committed restart does not leave a retry dialog when its account event arrives before the response', async () => {
  stateValue = makeState('claude', 51, 'Account B')
  usageValue = usageFor(stateValue)
  const response = Promise.withResolvers<unknown>()
  restartGate = response.promise
  await mount('overlay:quirky.accounts/switch-dialog')
  const restart = container.querySelector('.switch-dialog .dialog-actions button:last-child')
  if (!(restart instanceof HTMLButtonElement)) throw new Error('Missing dialog restart action')
  await act(async () => { restart.click() })
  await restartStarted
  const previousReads = calls.filter((entry) => entry.method === 'quirky.accounts/list').length
  stateValue = { ...stateValue, staleSessions: [] }
  await act(async () => {
    await emit({ type: 'quirky.accounts/changed', data: { revision: stateValue.revision } } as QuirkyEvent)
  })
  await waitFor(
    () => calls.filter((entry) => entry.method === 'quirky.accounts/list').length > previousReads ? true : null,
    'the committed account event to reload its snapshot'
  )
  await act(async () => { response.resolve(stateValue) })
  await settle()
  expect(container.querySelector('[role="dialog"]')).toBeNull()
  expect(container.querySelector('[role="alert"]')).toBeNull()
})

test('stale reset failure stays visible without reporting redemption', async () => {
  const scopeA = { accountId: 'codex-a', accountRevision: 61, offerRevision: 'offer-a' }
  const scopeB = { accountId: 'codex-b', accountRevision: 62, offerRevision: 'offer-b' }
  stateValue = makeState('codex', 61, 'Account B')
  usageValue = usageFor(stateValue, scopeA)
  rejectStaleReset = true
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Codex details and account switcher').click() })
  await settle()
  await act(async () => { buttonByLabel('Reset Codex limits').click() })
  stateValue = makeState('codex', 62, 'Account C')
  stateValue = {
    ...stateValue,
    accounts: stateValue.accounts.map((account) => ({ ...account, id: 'codex-b', label: 'Account C' })),
    active: { ...stateValue.active, codex: 'codex-b' }
  }
  usageValue = usageFor(stateValue, scopeB)
  await act(async () => {
    await emit({ type: 'quirky.accounts/changed', data: { revision: 62 } } as QuirkyEvent)
  })
  await waitFor(
    () => [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Account C⌄') ?? null,
    'Codex account switcher to show the changed selection'
  )
  await settle()
  const dialog = container.querySelector('[aria-label="Reset Codex limits confirmation"]')
  if (!(dialog instanceof HTMLElement)) throw new Error('Stale reset confirmation disappeared')
  const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Reset now')
  if (!(confirm instanceof HTMLButtonElement)) throw new Error('Missing reset confirmation action')
  await act(async () => { confirm.click() })
  await settle()
  expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Codex limits were reset.')
  expect(container.querySelector('[aria-label="Reset Codex limits confirmation"]')).not.toBeNull()
})


test('a provider no-credit outcome remains a visible non-success', async () => {
  const scope = { accountId: 'codex-a', accountRevision: 64, offerRevision: 'offer-64' }
  stateValue = makeState('codex', 64, 'Account B')
  usageValue = usageFor(stateValue, scope)
  resetOutcome = 'noCredit'
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Codex details and account switcher').click() })
  await settle()
  await act(async () => { buttonByLabel('Reset Codex limits').click() })
  const dialog = container.querySelector('[aria-label="Reset Codex limits confirmation"]')
  if (!(dialog instanceof HTMLElement)) throw new Error('Missing Codex reset confirmation')
  const confirm = [...dialog.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Reset now')
  if (!(confirm instanceof HTMLButtonElement)) throw new Error('Missing reset confirmation action')
  await act(async () => { confirm.click() })
  await settle()
  expect(dialog.querySelector('[role="alert"]')).not.toBeNull()
  expect(container.textContent).not.toContain('Codex limits were reset.')
  expect(container.querySelector('[aria-label="Reset Codex limits confirmation"]')).not.toBeNull()
})



test('a failed sign-in browser handoff remains retryable without losing Copy or Cancel', async () => {
  const url = 'https://auth.openai.com/oauth/authorize?response_type=code&state=fixture-only'
  stateValue.pendingLogin = { id: 'login-1', provider: 'codex', accountId: null, status: 'pending', url, error: null, result: null }
  const gate = Promise.withResolvers<unknown>()
  externalOpenGate = gate.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await settle()
  await act(async () => { buttonByText('Open').click() })
  expect(buttonByText('Opening…').disabled).toBe(true)
  expect(buttonByText('Copy link').disabled).toBe(false)
  expect(buttonByText('Cancel').disabled).toBe(false)

  await act(async () => { gate.reject(new Error('system handler unavailable')) })
  await settle()
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Could not open the sign-in link')
  expect(buttonByText('Open').disabled).toBe(false)
  expect(container.textContent).toContain('Cancel')

  externalOpenGate = null
  await act(async () => { buttonByText('Open').click() })
  await settle()
  expect(container.querySelector('[role="alert"]')).toBeNull()
  expect(buttonByText('Open').disabled).toBe(false)
  expect(buttonByText('Copy link').disabled).toBe(false)

  stateValue.pendingLogin = null
  await act(async () => { buttonByText('Cancel').click() })
  await settle()
  expect(container.textContent).not.toContain('Codex opened this sign-in link')
})

test('login controls reject a second add while the first login request is pending', async () => {
  stateValue = makeState('claude', 71, 'Account B', { stale: false })
  const gate = Promise.withResolvers<unknown>()
  loginGate = gate.promise
  resolveLogin = gate.resolve
  await mount('view:quirky.accounts/settings')
  const add = buttonByText('Add Account')
  await act(async () => { add.click(); add.click() })
  expect(calls.filter((call) => call.method === 'quirky.accounts/beginLogin')).toHaveLength(1)
  expect(add.disabled).toBe(true)
  await act(async () => { resolveLogin({ id: 'login-1' }) })
  await settle()
  expect(calls.filter((call) => call.method === 'quirky.accounts/beginLogin')).toHaveLength(1)
  buttonByText('Cancel')
})

test('Codex removal confirmation is single-flight and retains its provider-specific warning', async () => {
  stateValue = makeState('codex', 72, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  const gate = Promise.withResolvers<boolean>()
  confirmGate = gate.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  const remove = buttonByLabel('Remove Codex account Account A')
  await act(async () => { remove.click(); remove.click() })
  expect(confirmCalls).toHaveLength(1)
  const confirmation = confirmCalls[0]
  if (!confirmation || typeof confirmation !== 'object' || !('body' in confirmation) || typeof confirmation.body !== 'string') throw new Error('Missing provider-specific removal warning')
  expect(confirmation.body).toContain('session history and MCP logins')
  expect(remove.disabled).toBe(true)
  await act(async () => { gate.resolve(true) })
  await settle()
  expect(calls.filter((call) => call.method === 'quirky.accounts/remove')).toHaveLength(1)
})

test('meter credential clear is single-flight and updates configured status', async () => {
  stateValue = makeState('claude', 73, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  credentialStatuses = [{ provider: 'minimax', kind: 'api-key', configured: true, readable: true }]
  const gate = Promise.withResolvers<unknown>()
  clearCredentialGate = gate.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Meter credentials').click() })
  const clear = buttonByText('Clear')
  await act(async () => { clear.click(); clear.click() })
  expect(calls.filter((call) => call.method === 'quirky.accounts/clearCredential')).toHaveLength(1)
  expect(clear.disabled).toBe(true)
  await act(async () => { gate.resolve({ provider: 'minimax', kind: 'api-key', configured: false, readable: false }) })
  await settle()
  const keyInput = container.querySelector('[aria-label="minimax API key"]')
  expect(keyInput).not.toBeNull()
  expect(keyInput?.closest('.credential-row')?.querySelector('button[type="button"]')).toBeNull()
  expect(calls.filter((call) => call.method === 'quirky.accounts/clearCredential')).toHaveLength(1)
})
