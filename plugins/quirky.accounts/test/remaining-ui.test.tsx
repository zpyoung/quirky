import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type * as AccountsUiModule from '../src/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { AccountState, ConfigWarning, ManagedProvider, Preferences, StaleSession } from '../src/types'
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
let cancelLoginGate: Promise<unknown> | null
let loginStatusGate: Promise<unknown> | null
let loginStatusValue: unknown
let loginStartCount: number
let credentialSaveFailure: boolean
let credentialClearFailure: boolean
let toastCalls: { title: string; body: string }[]

let accountsUi: typeof AccountsUiModule
// Import after happy-dom registration to exercise ReactDOM input-event feature detection.
beforeAll(async () => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  accountsUi = await import('../src/ui')
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
  cancelLoginGate = null
  loginStatusGate = null
  loginStatusValue = { status: 'pending', url: null, error: null, result: null }
  loginStartCount = 0
  credentialSaveFailure = false
  credentialClearFailure = false
  toastCalls = []
  container = document.createElement('div')
  document.body.append(container)
})

afterEach(async () => {
  await act(async () => {
    unregister?.()
    accountsUi.deactivate()
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
      if (method === 'quirky.accounts/select') {
        const provider = params?.provider
        const accountId = params?.accountId
        if ((provider !== 'claude' && provider !== 'codex') || !(accountId === null || typeof accountId === 'string')) return undefined
        const selected = stateValue.accounts.find((account) => account.provider === provider && account.id === accountId)
        const selectedLabel = selected?.label ?? stateValue.systemDefault[provider].label
        const revision = stateValue.revision + 1
        stateValue = {
          ...stateValue,
          active: { ...stateValue.active, [provider]: accountId },
          accounts: stateValue.accounts.map((account) => account.provider === provider ? { ...account, active: account.id === accountId } : account),
          staleSessions: stateValue.staleSessions.map((session) => session.provider === provider
            ? { ...session, selectedId: accountId ?? `${provider}-system`, selectedLabel, selectionRevision: revision, kept: false, queued: false }
            : session),
          revision
        }
        return stateValue
      }
      if (method === 'quirky.accounts/beginLogin') {
        loginStartCount += 1
        if (loginGate) return await loginGate
        return { id: `login-${loginStartCount}` }
      }
      if (method === 'quirky.accounts/loginStatus') {
        if (loginStatusGate) {
          const gate = loginStatusGate
          loginStatusGate = null
          return await gate
        }
        return loginStatusValue
      }
      if (method === 'quirky.accounts/cancelLogin') {
        if (cancelLoginGate) {
          const gate = cancelLoginGate
          cancelLoginGate = null
          return await gate
        }
        return { cancelled: true }
      }
      if (method === 'quirky.terminal/openExternal') {
        if (externalOpenGate) return await externalOpenGate
        return { ok: true }
      }
      if (method === 'quirky.accounts/remove') {
        const provider = params?.provider
        const accountId = params?.accountId
        if ((provider !== 'claude' && provider !== 'codex') || typeof accountId !== 'string') return undefined
        stateValue = {
          ...stateValue,
          accounts: stateValue.accounts.filter((account) => account.id !== accountId),
          active: { ...stateValue.active, [provider]: stateValue.active[provider] === accountId ? null : stateValue.active[provider] },
          staleSessions: stateValue.staleSessions.filter((session) => session.accountId !== accountId),
          revision: stateValue.revision + 1
        }
        return stateValue
      }
      if (method === 'quirky.accounts/setCredential') {
        if (credentialSaveFailure) {
          credentialSaveFailure = false
          throw new Error('api-key=private-fixture-secret at /private/home/fixture')
        }
        const status = { provider: params?.provider, kind: params?.kind, configured: true, readable: true }
        credentialStatuses = [...credentialStatuses.filter((item) => item.provider !== status.provider || item.kind !== status.kind), status as CredentialStatus]
        return status
      }
      if (method === 'quirky.accounts/clearCredential') {
        if (clearCredentialGate) return await clearCredentialGate
        if (credentialClearFailure) {
          credentialClearFailure = false
          throw new Error('api-key=private-fixture-secret at /private/home/fixture')
        }
        const status = { provider: params?.provider, kind: params?.kind, configured: false, readable: false }
        credentialStatuses = [...credentialStatuses.filter((item) => item.provider !== status.provider || item.kind !== status.kind), status as CredentialStatus]
        return status
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
    }, toast: (title: string, body: string) => { toastCalls.push({ title, body }) }, setPanelBadge: () => {}, setContext: () => {}, mountView: () => () => {}
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
    accountsUi.activate(makeContext())
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
function findButtonByText(text: string): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === text) ?? null
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = container.querySelector(`[aria-label="${label}"]`)
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${label}`)
  return button
}
const allProviders = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'] as const
const providerLabels: Record<(typeof allProviders)[number], string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', 'opencode-go': 'OpenCode Go',
  kimi: 'Kimi', minimax: 'MiniMax', grok: 'Grok', cursor: 'Cursor', zcode: 'ZCode'
}

function makeProviderSnapshot(provider: ProviderSnapshot['provider'], accountId: string | null, usedPercent: number, resetDescription: string): ProviderSnapshot {
  return {
    provider, accountId, status: 'ok', error: null, updatedAt: 10,
    session: { usedPercent, windowMinutes: 300, resetsAt: null, resetDescription },
    weekly: { usedPercent: usedPercent + 1, windowMinutes: 10080, resetsAt: null, resetDescription: `${resetDescription}-weekly` },
    planType: `Provider plan ${provider}`, usageMetadata: { source: 'cli', credentialSource: 'cli' },
    ...(provider === 'minimax' ? { extraUsage: { unit: 'credits' as const, enabled: true, disabledReason: null, resetsAt: null, balance: 12, unlimited: false } } : {})
  }
}

function makeAllProviderUsage(state: AccountState): UsageFixture {
  const providers = allProviders.map((provider, index) => makeProviderSnapshot(
    provider,
    provider === 'claude' ? state.active.claude : provider === 'codex' ? state.active.codex : null,
    10 + index,
    `reset-${provider}`
  ))
  return {
    providers,
    inactive: {
      'claude-b': makeProviderSnapshot('claude', 'claude-b', 91, 'inactive-claude-window'),
      'codex-b': makeProviderSnapshot('codex', 'codex-b', 92, 'inactive-codex-window')
    },
    updatedAt: 10
  }
}
test('all ten provider details show their supplied quota, reset, plan, state, source and managed inactive usage', async () => {
  const state = makeState('codex', 80, 'Account B')
  const codexActive = state.accounts[0]!
  const claudeActive = { ...codexActive, id: 'claude-a', provider: 'claude' as const, label: 'Claude Active', email: 'claude-a@example.test' }
  stateValue = {
    ...state,
    accounts: [
      codexActive,
      { ...codexActive, id: 'codex-b', label: 'Codex Inactive', active: false },
      claudeActive,
      { ...claudeActive, id: 'claude-b', label: 'Claude Inactive', active: false }
    ],
    active: { claude: 'claude-a', codex: 'codex-a' }
  }
  usageValue = makeAllProviderUsage(stateValue)
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()

  for (const provider of allProviders) {
    const label = providerLabels[provider]
    const row = [...container.querySelectorAll<HTMLButtonElement>('.provider-row')].find((candidate) => candidate.textContent?.includes(label))
    if (!row) throw new Error(`Missing ${label} provider row`)
    await act(async () => { row.click() })
    await settle()

    const details = container.querySelector<HTMLElement>(`[aria-label="${label} usage details"]`)
    if (!details) throw new Error(`Missing ${label} usage details`)
    expect(details.textContent).toContain(`reset-${provider}`)
    expect(details.textContent).toContain(`Provider plan ${provider}`)
    expect(details.querySelector('.usage-window')?.textContent).toContain('5h')
    expect(details.querySelector('.info-line .status-ready')?.textContent).toBe('Up to date')
    expect(details.querySelector('.info-line small')?.getAttribute('title')).toContain('Source: Provider CLI')
    if (provider === 'minimax') expect(details.textContent).toContain('12 credits')

    if (provider === 'claude' || provider === 'codex') {
      await act(async () => { buttonByLabel('Expand account choices').click() })
      await settle()
      const inactiveLabel = provider === 'claude' ? 'Claude Inactive' : 'Codex Inactive'
      const inactiveRow = [...details.querySelectorAll<HTMLElement>('.account-list .account-row')].find((candidate) => candidate.textContent?.includes(inactiveLabel))
      if (!inactiveRow) throw new Error(`Missing inactive ${label} account`)
      expect(inactiveRow.textContent).toContain(`inactive-${provider}-window`)
    }

    await act(async () => { buttonByLabel('Back to usage').click() })
    await settle()
  }
})


test('Codex pane accessory keeps or restarts the old-account session', async () => {
  await mount('view:quirky.accounts/session-accessory', { sessionId: 'session-1', paneId: 'pane-1' })
  await act(async () => { buttonByText('Keep old account').click() })
  await settle()
  expect(container.querySelector('.muted')?.textContent).toContain('Account A')
  expect(container.querySelector('button')).toBeNull()

  await act(async () => { unregister?.(); accountsUi.deactivate() })
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
  const keepCall = calls.find((call) => call.method === 'quirky.accounts/keep')
  expect(keepCall?.params?.selectionRevision).toBe(42)
  expect(keepCall?.params?.sessions).toEqual(['session-1'])
  expect(calls.some((call) => call.method === 'quirky.accounts/restart')).toBe(false)
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
  expect(stateValue.active.codex).toBeNull()
  expect(stateValue.accounts.some((account) => account.id === 'codex-a')).toBe(false)
  expect(container.querySelector('.account-row-main')?.textContent).toContain('System default')
  expect(container.querySelector('.badge.active')?.textContent).toBe('Active')
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
test('Claude copy-link and Codex add expose pending links and a working Cancel action', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    const priorCancels = calls.filter((call) => call.method === 'quirky.accounts/cancelLogin').length
    stateValue = makeState(provider, 81, 'Account B', { stale: false })
    loginStatusValue = {
      status: 'pending',
      url: provider === 'claude'
        ? 'https://claude.ai/oauth?redirect_uri=http%3A%2F%2Flocalhost%3A54545%2Fcallback'
        : 'https://auth.openai.com/oauth/authorize?response_type=code&state=fixture',
      error: null, result: null
    }
    if (provider === 'codex') usageValue = usageFor(stateValue)
    await mount('view:quirky.accounts/settings')
    if (provider === 'codex') await act(async () => { buttonByText('Codex').click() })
    await act(async () => { buttonByText(provider === 'claude' ? 'Copy sign-in link instead' : 'Add Account').click() })
    await waitFor(() => findButtonByText('Copy link'), `${provider} sign-in link`)
    expect(container.textContent).toContain(provider === 'claude' ? 'Waiting for Claude sign-in.' : 'Codex opened this sign-in link in your browser.')
    expect(buttonByText('Cancel').disabled).toBe(false)
    await act(async () => { buttonByText('Cancel').click() })
    await waitFor(() => container.querySelector('.login-notice') ? null : true, `${provider} sign-in cancellation`)
    expect(calls.filter((call) => call.method === 'quirky.accounts/cancelLogin')).toHaveLength(priorCancels + 1)

    if (provider === 'claude') {
      await act(async () => { unregister?.(); accountsUi.deactivate() })
      unregister = undefined
      provided = new Map()
      stateValue = makeState('codex', 82, 'Account B', { stale: false })
      usageValue = usageFor(stateValue)
    }
  }
})

test('a managed account needing sign-in cannot be selected and offers reauthentication', async () => {
  const state = makeState('codex', 83, 'Account B', { stale: false })
  const account = state.accounts[0]!
  const unavailable = { ...account, id: 'codex-b', label: 'Account B', email: 'b@example.test', needsSignIn: true, active: false }
  stateValue = { ...state, accounts: [account, unavailable] }
  usageValue = usageFor(stateValue)
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Codex details and account switcher').click() })
  await settle()
  await act(async () => { buttonByLabel('Expand account choices').click() })
  await settle()
  const refuse = buttonByLabel('Select Codex account Account B')
  expect(refuse.disabled).toBe(true)
  expect(container.querySelector('[aria-label="Codex account switcher"]')?.textContent).toContain('Account A')
  expect(calls.filter((call) => call.method === 'quirky.accounts/select')).toHaveLength(0)

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  provided = new Map()
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Re-authenticate').click() })
  await waitFor(() => findButtonByText('Cancel'), 'the reauthentication login')
  expect(container.textContent).toContain('Needs sign-in')
  expect(calls.filter((call) => call.method === 'quirky.accounts/beginLogin').at(-1)?.params?.accountId).toBe('codex-b')
})

test('a rejected cancel resumes sign-in observation until its completion is visible', async () => {
  stateValue = makeState('codex', 84, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  loginStatusValue = { status: 'pending', url: 'https://auth.openai.com/oauth/authorize?state=fixture', error: null, result: null }
  const cancel = Promise.withResolvers<unknown>()
  cancelLoginGate = cancel.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(() => findButtonByText('Cancel'), 'the pending Codex login')
  const initialStatusReads = calls.filter((call) => call.method === 'quirky.accounts/loginStatus').length
  await act(async () => { buttonByText('Cancel').click() })
  await act(async () => { cancel.reject(new Error('api-key=fixture-secret at /private/home')) })
  await settle()

  expect(buttonByText('Cancel').disabled).toBe(false)
  expect(toastCalls).toContainEqual({ title: 'Could not cancel sign-in', body: 'The request could not be completed. Please try again.' })
  expect(container.textContent).not.toContain('fixture-secret')
  expect(container.textContent).not.toContain('/private/home')

  const addedAccount = { ...stateValue.accounts[0]!, id: 'codex-added', label: 'Completed account', email: 'completed@example.test', active: false }
  stateValue = { ...stateValue, accounts: [...stateValue.accounts, addedAccount], revision: stateValue.revision + 1 }
  loginStatusValue = { status: 'complete', url: null, error: null, result: addedAccount }
  await waitFor(
    () => calls.filter((call) => call.method === 'quirky.accounts/loginStatus').length > initialStatusReads ? true : null,
    'login status polling after cancel failure'
  )
  await waitFor(() => container.textContent?.includes('Completed account') ? true : null, 'the completed account to appear')
  expect(container.querySelector('.login-notice')).toBeNull()
})

test('a delayed status response cannot restore a successfully cancelled login', async () => {
  stateValue = makeState('codex', 85, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  const status = Promise.withResolvers<unknown>()
  const cancel = Promise.withResolvers<unknown>()
  loginStatusGate = status.promise
  cancelLoginGate = cancel.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/loginStatus') ? true : null, 'the first login status request')
  await act(async () => { buttonByText('Cancel').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/cancelLogin') ? true : null, 'the cancel request')
  await act(async () => { cancel.resolve({ cancelled: true }) })
  await settle()
  expect(container.querySelector('.login-notice')).toBeNull()
  await act(async () => { status.resolve({ status: 'pending', url: 'https://auth.openai.com/oauth/authorize?state=late', error: null, result: null }) })
  await settle()
  const wait = Promise.withResolvers<void>()
  setTimeout(wait.resolve, 950)
  await wait.promise
  expect(container.querySelector('.login-notice')).toBeNull()
  expect(calls.filter((call) => call.method === 'quirky.accounts/loginStatus')).toHaveLength(1)
})
test('a late cancel response for a superseded login leaves the newer sign-in visible', async () => {
  stateValue = makeState('codex', 86, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  const status = Promise.withResolvers<unknown>()
  const cancel = Promise.withResolvers<unknown>()
  loginStatusGate = status.promise
  cancelLoginGate = cancel.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/loginStatus') ? true : null, 'the original login status request')
  await act(async () => { buttonByText('Cancel').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/cancelLogin') ? true : null, 'the original cancel request')

  await act(async () => { status.resolve({ status: 'complete', url: null, error: null, result: null }) })
  await waitFor(() => container.querySelector('.login-notice') ? null : true, 'the original login to complete')
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(
    () => calls.filter((call) => call.method === 'quirky.accounts/loginStatus').length === 2 ? true : null,
    'the newer login status request'
  )
  await act(async () => { cancel.resolve({ cancelled: true }) })
  await settle()

  expect(container.textContent).toContain('Codex opened this sign-in link in your browser.')
  expect(buttonByText('Cancel').disabled).toBe(false)
  expect(calls.filter((call) => call.method === 'quirky.accounts/cancelLogin')).toHaveLength(1)
})

test('stopping settings while a login status read is in flight prevents another poll', async () => {
  stateValue = makeState('codex', 87, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  const status = Promise.withResolvers<unknown>()
  loginStatusGate = status.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/loginStatus') ? true : null, 'the in-flight login status request')

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  await act(async () => { status.resolve({ status: 'pending', url: null, error: null, result: null }) })
  await settle()
  const wait = Promise.withResolvers<void>()
  setTimeout(wait.resolve, 950)
  await wait.promise
  expect(container.textContent).toBe('')
  expect(calls.filter((call) => call.method === 'quirky.accounts/loginStatus')).toHaveLength(1)
})
test('Claude Ask, Always and Never policy choices preserve their visible switch behavior', async () => {
  const withTarget = (revision: number) => {
    const state = makeState('claude', revision, 'Account B')
    const active = state.accounts[0]!
    return {
      ...state,
      accounts: [active, { ...active, id: 'claude-b', label: 'Account B', email: 'b@example.test', active: false }]
    }
  }
  stateValue = withTarget(88)
  usageValue = usageFor(stateValue)
  await mount('view:quirky.accounts/settings')
  const policy = container.querySelector<HTMLSelectElement>('[aria-label="Claude running-session switch policy"]')
  if (!policy) throw new Error('Missing Claude running-session policy')
  expect(policy.value).toBe('ask')
  expect([...policy.options].map((option) => option.value)).toEqual(['ask', 'always', 'never'])
  await act(async () => {
    policy.value = 'always'
    policy.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(policy.value).toBe('always')

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  provided = new Map()
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Claude details and account switcher').click() })
  await settle()
  await act(async () => { buttonByLabel('Expand account choices').click() })
  await settle()
  await act(async () => { buttonByLabel('Select Claude account Account B').click() })
  await settle()
  const alwaysSelectedRow = [...container.querySelectorAll<HTMLElement>('.account-list .account-row')].find((row) => row.textContent?.includes('Account B'))
  if (!alwaysSelectedRow) throw new Error('Missing visibly selected Claude account after Always restart')
  expect(alwaysSelectedRow.querySelector('.badge.active')?.textContent).toBe('Active')
  expect(alwaysSelectedRow.querySelector<HTMLButtonElement>('[aria-label="Select Claude account Account B"]')?.disabled).toBe(true)
  expect(calls.filter((call) => call.method === 'quirky.accounts/restart')).toHaveLength(1)
  expect(stateValue.staleSessions).toHaveLength(0)

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  provided = new Map()
  calls = []
  stateValue = withTarget(89)
  usageValue = usageFor(stateValue)
  await mount('view:quirky.accounts/settings')
  const neverPolicy = container.querySelector<HTMLSelectElement>('[aria-label="Claude running-session switch policy"]')
  if (!neverPolicy) throw new Error('Missing Claude running-session policy')
  await act(async () => {
    neverPolicy.value = 'never'
    neverPolicy.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await settle()
  expect(neverPolicy.value).toBe('never')

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  provided = new Map()
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Claude details and account switcher').click() })
  await settle()
  await act(async () => { buttonByLabel('Expand account choices').click() })
  await settle()
  await act(async () => { buttonByLabel('Select Claude account Account B').click() })
  await settle()
  const neverSelectedRow = [...container.querySelectorAll<HTMLElement>('.account-list .account-row')].find((row) => row.textContent?.includes('Account B'))
  if (!neverSelectedRow) throw new Error('Missing visibly selected Claude account after Never switch')
  expect(neverSelectedRow.querySelector('.badge.active')?.textContent).toBe('Active')
  expect(neverSelectedRow.querySelector<HTMLButtonElement>('[aria-label="Select Claude account Account B"]')?.disabled).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.accounts/restart')).toBe(false)

  await act(async () => { unregister?.(); accountsUi.deactivate() })
  unregister = undefined
  provided = new Map()
  await mount('overlay:quirky.accounts/switch-dialog')
  expect(container.querySelector('[role="dialog"]')).toBeNull()
})
test('removal Cancel preserves both managed selections and Claude confirmation falls back to System default', async () => {
  for (const provider of ['claude', 'codex'] as const) {
    stateValue = makeState(provider, 90, 'Account B', { stale: false })
    usageValue = usageFor(stateValue)
    const cancel = Promise.withResolvers<boolean>()
    confirmGate = cancel.promise
    await mount('view:quirky.accounts/settings')
    if (provider === 'codex') await act(async () => { buttonByText('Codex').click() })
    const remove = buttonByLabel(`Remove ${provider === 'claude' ? 'Claude' : 'Codex'} account Account A`)
    await act(async () => { remove.click() })

    const confirmation = confirmCalls[0]
    if (!confirmation || typeof confirmation !== 'object' || !('body' in confirmation) || typeof confirmation.body !== 'string') {
      throw new Error(`Missing ${provider} removal warning`)
    }
    expect(confirmation.body).toContain(provider === 'claude' ? 'Chat history shared with System default stays' : 'session history and MCP logins')
    await act(async () => { cancel.resolve(false) })
    await settle()
    expect(calls.some((call) => call.method === 'quirky.accounts/remove')).toBe(false)
    expect(stateValue.active[provider]).toBe(`${provider}-a`)
    expect(container.textContent).toContain('Account A')

    if (provider === 'claude') {
      confirmGate = null
      await act(async () => { buttonByLabel('Remove Claude account Account A').click() })
      await settle()
      expect(stateValue.active.claude).toBeNull()
      expect(stateValue.accounts.some((account) => account.id === 'claude-a')).toBe(false)
      expect(container.textContent).toContain('System default')
      expect(container.querySelector('.badge.active')?.textContent).toBe('Active')
    }

    if (provider === 'claude') {
      await act(async () => { unregister?.(); accountsUi.deactivate() })
      unregister = undefined
      provided = new Map()
      calls = []
      confirmCalls = []
    }
  }
})
test('MiniMax, OpenCode Go and ZCode secrets stay masked through save, clear and generic failures', async () => {
  stateValue = makeState('claude', 91, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Meter credentials').click() })
  const fields = [
    ['minimax', 'API key'], ['minimax', 'Cookie'],
    ['opencode-go', 'API key'], ['opencode-go', 'Cookie'],
    ['zcode', 'API key']
  ] as const
  const enterValue = async (input: HTMLInputElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('Missing native input value setter')
    await act(async () => {
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }

  for (const [provider, label] of fields) {
    const input = container.querySelector<HTMLInputElement>(`[aria-label="${provider} ${label}"]`)
    if (!input) throw new Error(`Missing ${provider} ${label} field`)
    expect(input.type).toBe('password')
    await enterValue(input, `fixture-secret-${provider}-${label}`)
    const row = input.closest<HTMLElement>('.credential-row')
    const save = row?.querySelector<HTMLButtonElement>('button[type="submit"]')
    if (!row || !save) throw new Error(`Missing ${provider} ${label} save action`)
    expect(save.disabled).toBe(false)
    await act(async () => { save.click() })
    await settle()
    expect(row.textContent).toContain('Configured · Readable')
    expect(input.value).toBe('')
    const clear = [...row.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Clear')
    if (!clear) throw new Error(`Missing ${provider} ${label} clear action`)
    await act(async () => { clear.click() })
    await settle()
    expect(row.textContent).toContain('Not configured')
    expect(row.querySelector('button[type="button"]')).toBeNull()
    expect(input.value).toBe('')
  }

  const minimaxInput = container.querySelector<HTMLInputElement>('[aria-label="minimax API key"]')
  if (!minimaxInput) throw new Error('Missing MiniMax API key field')
  credentialSaveFailure = true
  await enterValue(minimaxInput, 'failure-secret')
  const minimaxRow = minimaxInput.closest<HTMLElement>('.credential-row')
  if (!minimaxRow) throw new Error('Missing MiniMax credential row')
  await act(async () => { minimaxRow.querySelector<HTMLButtonElement>('button[type="submit"]')?.click() })
  await settle()
  expect(minimaxRow.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm saving this credential')
  expect(toastCalls).toContainEqual({ title: 'Could not save provider credential', body: 'The request could not be completed. Please try again.' })

  const zcodeInput = container.querySelector<HTMLInputElement>('[aria-label="zcode API key"]')
  if (!zcodeInput) throw new Error('Missing ZCode API key field')
  await enterValue(zcodeInput, 'zcode-secret')
  const zcodeRow = zcodeInput.closest<HTMLElement>('.credential-row')
  if (!zcodeRow) throw new Error('Missing ZCode credential row')
  await act(async () => { zcodeRow.querySelector<HTMLButtonElement>('button[type="submit"]')?.click() })
  await settle()
  credentialClearFailure = true
  const zcodeClear = [...zcodeRow.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Clear')
  if (!zcodeClear) throw new Error('Missing ZCode clear action')
  await act(async () => { zcodeClear.click() })
  await settle()
  expect(zcodeRow.querySelector('[role="alert"]')?.textContent).toContain('Could not confirm clearing this credential')
  expect(zcodeRow.textContent).toContain('Configured · Readable')
  expect(toastCalls).toContainEqual({ title: 'Could not clear provider credential', body: 'The request could not be completed. Please try again.' })
  expect(container.textContent).not.toContain('failure-secret')
  expect(container.textContent).not.toContain('/private/home')
  expect(toastCalls.some(({ body }) => body.includes('private-fixture-secret') || body.includes('/private/home'))).toBe(false)
})
test('a retained Codex settings warning clears after the source configuration is restored', async () => {
  const warning: ConfigWarning = {
    provider: 'codex', accountId: 'codex-a', kind: 'sync-failed',
    message: 'Codex is still using its last good settings because synchronization failed.'
  }
  stateValue = { ...makeState('codex', 92, 'Account B', { stale: false }), configWarnings: [warning] }
  usageValue = usageFor(stateValue)
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await waitFor(() => container.querySelector('[aria-label="Codex configuration warnings"]'), 'the retained Codex settings warning')
  expect(container.textContent).toContain(warning.message)

  stateValue = { ...stateValue, configWarnings: [], revision: 93 }
  await act(async () => { await emit({ type: 'quirky.accounts/changed', data: { revision: 93 } } as QuirkyEvent) })
  await waitFor(
    () => container.querySelector('[aria-label="Codex configuration warnings"]') ? null : true,
    'the warning to clear after synchronization recovers'
  )
  expect(container.textContent).not.toContain(warning.message)
  expect(container.textContent).toContain('Account A')
})
test('a failed cancel and delayed status response keep one polling chain', async () => {
  stateValue = makeState('codex', 93, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  const status = Promise.withResolvers<unknown>()
  const cancel = Promise.withResolvers<unknown>()
  loginStatusGate = status.promise
  cancelLoginGate = cancel.promise
  await mount('view:quirky.accounts/settings')
  await act(async () => { buttonByText('Codex').click() })
  await act(async () => { buttonByText('Add Account').click() })
  await waitFor(() => calls.some((call) => call.method === 'quirky.accounts/loginStatus') ? true : null, 'the status request that remains in flight')
  await act(async () => { buttonByText('Cancel').click() })
  await act(async () => { cancel.reject(new Error('cancel unavailable')) })
  await settle()
  expect(buttonByText('Cancel').disabled).toBe(false)

  await act(async () => { status.resolve({ status: 'pending', url: null, error: null, result: null }) })
  await settle()
  const wait = Promise.withResolvers<void>()
  setTimeout(wait.resolve, 950)
  await wait.promise
  expect(calls.filter((call) => call.method === 'quirky.accounts/loginStatus')).toHaveLength(2)
  expect(buttonByText('Cancel').disabled).toBe(false)
})
test('canceling the Codex reset offer leaves it available without consuming a credit', async () => {
  stateValue = makeState('codex', 94, 'Account B', { stale: false })
  usageValue = usageFor(stateValue)
  await mount('status-bar:quirky.accounts/usage')
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Codex details and account switcher').click() })
  await act(async () => { buttonByLabel('Reset Codex limits').click() })
  const dialog = container.querySelector('[aria-label="Reset Codex limits confirmation"]')
  if (!dialog) throw new Error('Missing Codex reset offer confirmation')
  expect(dialog.textContent).toContain('Offer shown for Account A')
  await act(async () => { buttonByText('Cancel').click() })
  await settle()
  expect(container.querySelector('[aria-label="Reset Codex limits confirmation"]')).toBeNull()
  expect(buttonByLabel('Reset Codex limits').disabled).toBe(false)
  expect(calls.filter((call) => call.method === 'quirky.accounts/consumeResetCredit')).toHaveLength(0)
})
