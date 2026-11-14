import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type * as ReactDOMClient from 'react-dom/client'
import type { Root } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { AccountsUiStore, REFRESH_COMMAND_ID } from '../src/window/model'
import type { AccountState, AccountUiSnapshot, ProviderSnapshot, ResetCreditResult, StaleSession } from '../src/window/model'
import type * as UsageModule from '../src/window/Usage'

let Usage: typeof UsageModule
let createRoot: typeof ReactDOMClient.createRoot
let root: Root
let container: HTMLDivElement
let store: AccountsUiStore
let state: AccountState
let calls: { method: string; params?: Record<string, unknown> }[]
let commands: { id: string; args: unknown }[]
let resetResult: ResetCreditResult
let sessionFailure: boolean

const provider = (patch: Partial<ProviderSnapshot> = {}): ProviderSnapshot => ({
  provider: 'codex', accountId: null, status: 'ok', error: null, updatedAt: 10,
  session: { usedPercent: 25, windowMinutes: 300, resetsAt: null, resetDescription: null }, weekly: null, ...patch
})
const stale = (patch: Partial<StaleSession> = {}): StaleSession => ({
  sessionId: 'session-1', provider: 'codex', accountId: 'old', accountLabel: 'Old account', selectedId: null,
  selectedLabel: 'System default', busy: false, queued: false, kept: false, error: null, selectionRevision: 1, ...patch
})

beforeAll(async () => {
  GlobalRegistrator.register()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  // ReactDOM must detect input events after happy-dom installs the browser globals.
  createRoot = (await import('react-dom/client')).createRoot
  Usage = await import('../src/window/Usage')
})
afterAll(async () => { await GlobalRegistrator.unregister() })
beforeEach(() => {
  state = {
    accounts: [], active: { claude: null, codex: null },
    systemDefault: {
      claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' },
      codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' }
    },
    pendingLogin: null, staleSessions: [], configWarnings: [], revision: 1,
    preferences: { mode: 'compact', direction: 'used', hidden: false, visibleProviders: ['codex'], density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false }
  }
  calls = []; commands = []; resetResult = 'failed'; sessionFailure = false
  const context = {
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'ui.window.self') return { connId: 7 }
      if (method === 'quirky.accounts/setUiState') return { ...store.getSnapshot().ui, ...params }
      if (method === 'quirky.accounts/setPreferences') {
        state = { ...state, preferences: { ...state.preferences, ...params } }
        return state
      }
      if (method === 'quirky.accounts/list') return state
      if (method === 'quirky.accounts/uiState') return store.getSnapshot().ui
      if (method === 'quirky.accounts/usage') return store.getSnapshot().usage
      if (method === 'quirky.accounts/consumeResetCredit') {
        if (resetResult === 'scope-changed') throw new Error('Codex reset offer is no longer current')
        if (resetResult === 'failed') throw new Error('Fixture reset failure')
        return { outcome: resetResult, state: store.getSnapshot().usage }
      }
      if (method === 'quirky.accounts/keep' || method === 'quirky.accounts/restart') {
        if (sessionFailure) throw new Error('Fixture session unavailable')
        state = { ...state, staleSessions: state.staleSessions.map((session) => ({ ...session, queued: true })) }
        return state
      }
      throw new Error(`Unexpected fixture RPC ${method}`)
    },
    executeCommand: async (id: string, args: unknown) => { commands.push({ id, args }) },
    toast: () => {}, openView: async () => {}
  } as unknown as UiPluginContext
  store = new AccountsUiStore(context)
  Object.assign(store.getSnapshot(), {
    accounts: state, usage: { providers: [], inactive: {}, updatedAt: 10 }, loading: false,
    ui: { open: true, provider: null, expanded: null, settingsSection: null },
    agentDetection: { status: 'ready', installedProviders: [] }
  })
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  store.stop(); container.remove()
})
const renderBar = async (patch: Partial<AccountUiSnapshot> = {}) => {
  Object.assign(store.getSnapshot(), patch)
  await act(async () => root.render(<Usage.StatusBarUsage store={store} />))
}
const details = async (snapshot?: ProviderSnapshot) => {
  const current = store.getSnapshot()
  await renderBar({ ui: { ...current.ui, provider: snapshot?.provider ?? 'codex' }, usage: { providers: snapshot ? [snapshot] : [], inactive: {}, updatedAt: 10 } })
}
const button = (label: string, scope: ParentNode = container) => {
  const found = [...scope.querySelectorAll<HTMLButtonElement>('button')].find((element) => element.textContent === label || element.getAttribute('aria-label') === label)
  expect(found).toBeDefined()
  return found!
}
const click = async (label: string, scope: ParentNode = container) => { await act(async () => button(label, scope).click()) }
const expectRefresh = (provider?: string) => expect(commands.at(-1)).toEqual({ id: REFRESH_COMMAND_ID, args: { ...(provider ? { provider } : {}), connId: 7 } })
const remote = (status: 'loading' | 'unavailable' | 'ready', hostName: string | null): AccountUiSnapshot['scope'] => ({ kind: 'remote', mirrorId: 'm1', owner: null, workspace: null, hostName, status, error: null })

test.each(['accounts', 'usage'] as const)('initial missing %s shows a notice, not configuration', async (field) => {
  await renderBar({ [field]: null, loading: true })
  expect(container.querySelector('.ui-notice-line [role="status"]')?.textContent).toBe('Loading usage…')
  expect(container.textContent).not.toContain('Configure usage tracking')
})
test('a deferred usage read keeps the loading state until data arrives', async () => {
  const gate = Promise.withResolvers<unknown>()
  const context = { call: () => gate.promise } as unknown as UiPluginContext
  store.stop(); store = new AccountsUiStore(context)
  Object.assign(store.getSnapshot(), { accounts: state, ui: { ...store.getSnapshot().ui, open: true } })
  const loading = store.loadUsage()
  await renderBar()
  expect(container.querySelector('.ui-notice-line')?.textContent).toContain('Loading usage…')
  await act(async () => {
    gate.resolve({ providers: [provider({ provider: 'claude', status: 'unavailable', session: null }), provider({ status: 'unavailable', session: null })], inactive: {}, updatedAt: 10 })
    await loading
  })
  expect(container.textContent).toContain('Configure usage tracking')
})
test('initial loading with empty loaded collections is not configuration', async () => {
  await renderBar({ loading: true })
  expect(container.querySelector('.ui-notice-line')?.textContent).toContain('Loading usage…')
  expect(container.textContent).not.toContain('Configure usage tracking')
})
test.each(['Fixture owner', null])('remote loading and unavailable states identify %s and offer retry', async (host) => {
  await renderBar({ scope: remote('loading', host) })
  expect(container.querySelector('.ui-notice-line')?.textContent).toBe(`Loading Usage from ${host ?? 'the remote owner'}…`)
  await renderBar({ scope: remote('unavailable', host), error: 'Suppressed duplicate' })
  const alerts = container.querySelectorAll('.ui-inline-error[role="alert"]')
  expect(alerts.length).toBe(1)
  expect(alerts[0]?.textContent).toContain(`${host ?? 'Remote owner'} usage is unavailable.`)
  expect(container.textContent).not.toContain('Configure usage tracking')
  await click('Retry'); expectRefresh()
})
test('local load errors offer command retry without configuration', async () => {
  await renderBar({ error: 'Usage service is temporarily unavailable.' })
  expect(container.querySelector('.ui-inline-error')?.textContent).toContain('Usage service is temporarily unavailable.')
  expect(container.textContent).not.toContain('Configure usage tracking')
  await click('Retry'); expectRefresh()
})
test('a load failure stays visible beside previously loaded provider details', async () => {
  store.getSnapshot().error = 'Usage service is temporarily unavailable.'
  await details(provider())
  expect(container.querySelector('.usage-popover > .ui-inline-error')?.textContent).toContain('Usage service is temporarily unavailable.')
  await click('Retry'); expectRefresh()
  expect(container.querySelector('.usage-window-list')).not.toBeNull()
})
test('background refresh keeps rows visible and refresh disabled', async () => {
  await renderBar({ usage: { providers: [provider()], inactive: {}, updatedAt: 10 }, refreshing: true, scope: remote('ready', 'Fixture owner') })
  expect(container.querySelector('.ui-notice-line')?.textContent).toBe('Refreshing usage…')
  expect(container.querySelector('.provider-row')).not.toBeNull()
  expect(container.textContent).toContain('Usage on Fixture owner.')
  expect(button('Refresh rate limits').disabled).toBe(true)
})
test('configured accounts awaiting a snapshot get an actionable empty state without an outer status role', async () => {
  state.systemDefault.codex.hasAuth = true
  await renderBar()
  const empty = container.querySelector('.ui-empty-state')!
  expect(empty.textContent).toContain('Usage for the selected account is loading.')
  expect(empty.parentElement?.getAttribute('role')).not.toBe('status')
  await click('Refresh usage'); expectRefresh()
})
test.each(['idle', 'fetching'] as const)('SnapshotLine %s uses a shared notice and retains age metadata', async (status) => {
  await act(async () => root.render(<Usage.SnapshotLine snapshot={provider({ status, session: null })} />))
  expect(container.querySelector('.ui-notice-line .status-loading[role="status"]')?.textContent).toBe(status === 'idle' ? 'Waiting for usage' : 'Fetching')
  expect(container.querySelector('.info-line small')).not.toBeNull()
})
test('SnapshotLine errors retain last good usage and provider Retry; ready state stays compatible', async () => {
  await details(provider({ status: 'error' }))
  expect(container.querySelector('.info-line .ui-inline-error')?.textContent).toContain('Refresh failed — showing last good usage')
  await click('Retry'); expectRefresh('codex')
  await act(async () => root.render(<Usage.SnapshotLine snapshot={provider()} />))
  expect(container.querySelector('.info-line .status-ready')?.textContent).toBe('Up to date')
})
test('missing provider distinguishes failure, loading, and actionable empty state', async () => {
  store.getSnapshot().error = 'Fixture unavailable'
  await details()
  expect(container.querySelector('.provider-details .ui-inline-error')?.textContent).toContain('Fixture unavailable')
  await click('Retry', container.querySelector('.provider-details')!); expectRefresh('codex')
  store.getSnapshot().error = null; store.getSnapshot().loading = true
  await details()
  expect(container.querySelector('.provider-details .ui-notice-line')?.textContent).toBe('Loading Codex usage…')
  store.getSnapshot().loading = false
  await details()
  expect(container.querySelector('.provider-details .ui-empty-state')?.textContent).toContain('Usage has not been read yet.')
  await click('Refresh usage'); expectRefresh('codex')
})
test.each(['fetching', 'error'] as const)('empty provider %s has no duplicate empty note', async (status) => {
  await details(provider({ status, session: null }))
  const panel = container.querySelector('.usage-popover > .provider-details')!
  expect(panel.querySelector('.empty-note')).toBeNull()
  expect(panel.querySelector(':scope > .ui-empty-state')).toBeNull()
  expect(panel.querySelectorAll(status === 'error' ? '.ui-inline-error' : '.ui-notice-line').length).toBe(1)
})
test('signed-out empty provider offers one local Sign in action and none remotely', async () => {
  const signedOut = provider({ status: 'unavailable', session: null, error: 'Not signed in' })
  await details(signedOut)
  expect(container.querySelector('.ui-empty-state')?.textContent).toContain('Not signed in')
  expect([...container.querySelectorAll('button')].filter((element) => element.textContent === 'Sign in').length).toBe(1)
  await click('Sign in')
  expect(calls.some((call) => call.method === 'quirky.accounts/setUiState' && call.params?.settingsSection === 'codex')).toBe(true)
  store.getSnapshot().scope = remote('ready', 'Fixture owner')
  await details(signedOut)
  expect([...container.querySelectorAll('button')].some((element) => element.textContent === 'Sign in')).toBe(false)
})
test('balance-only providers do not duplicate empty usage states', async () => {
  await details(provider({ provider: 'cursor', session: null, extraUsage: { unit: 'credits', enabled: true, disabledReason: null, resetsAt: null, balance: 7, unlimited: false } }))
  expect(container.querySelector('.empty-note')).toBeNull()
  expect(container.querySelector('.ui-empty-state')).toBeNull()
  expect(container.textContent).toContain('7')
})
test.each(['fetching', 'error'] as const)('expanded account %s usage and sign-in failure use shared states', async (status) => {
  state.accounts = [{ id: 'a', provider: 'codex', label: 'Account A', email: null, organization: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: null, active: false, needsSignIn: true }]
  store.getSnapshot().ui.expanded = 'codex'
  await details(provider({ status, session: null }))
  expect(container.querySelector('.account-list')?.textContent).toContain('Sign in again to use this account.')
  const active = container.querySelector('.account-row-main')!
  expect(active.querySelector(status === 'error' ? '.ui-inline-error' : '.ui-notice-line')).not.toBeNull()
})
test.each(['loading', 'unavailable'] as const)('agent detection %s is shared in Settings and the visibility menu', async (status) => {
  store.getSnapshot().agentDetection = { status, installedProviders: [] }
  await act(async () => root.render(<Usage.UsagePreferencesControls store={store} preferences={state.preferences} />))
  const selector = status === 'loading' ? '.ui-notice-line [role="status"]' : '.ui-inline-error[role="alert"]'
  expect(container.querySelector(selector)?.textContent).toContain(status === 'loading' ? 'Checking installed agent CLIs…' : 'Agent detection is unavailable; CLI-specific toggles are hidden.')
  if (status === 'unavailable') { await click('Retry'); expectRefresh() }
  await renderBar()
  await act(async () => container.querySelector('.usage-status-bar')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })))
  const menu = container.querySelector('.context-menu')!
  expect(menu.querySelector(selector)).not.toBeNull()
  if (status === 'unavailable') { await click('Retry', menu); expectRefresh() }
})
test('unbound reset offers are shared alerts and cannot be submitted', async () => {
  await details(provider({ rateLimitResetCredits: { availableCount: 1 } }))
  expect(container.querySelector('.ui-inline-error[role="alert"]')?.textContent).toContain('could not be bound to an account revision')
  expect(button('Reset Codex limits').disabled).toBe(true)
})
test.each(['reset', 'alreadyRedeemed', 'scope-changed', 'noCredit', 'nothingToReset', 'failed'] as const)('fake reset outcome %s uses the appropriate shared state', async (outcome) => {
  resetResult = outcome
  await details(provider({ rateLimitResetCredits: { availableCount: 1, expectedScope: { accountId: null, accountRevision: 1, offerRevision: 'fixture-offer' } } }))
  await click('Reset Codex limits')
  await click('Reset now', document.querySelector('.ui-dialog')!)
  const success = outcome === 'reset' || outcome === 'alreadyRedeemed'
  const reset = container.querySelector('[aria-label="Codex reset credits"]')!
  if (success) {
    expect(reset.querySelector('.ui-notice-line .status-ready[role="status"]')?.textContent).toContain(outcome === 'reset' ? 'Codex limits were reset.' : 'already redeemed')
    expect(document.querySelector('[role="alert"]')).toBeNull()
  } else {
    expect(document.querySelector('.ui-inline-error[role="alert"]')).not.toBeNull()
    if (outcome !== 'failed') { await click('Refresh usage', document.body); expectRefresh('codex') }
  }
})
test('queued and failed accessory states preserve selectors and shared errors', async () => {
  state.staleSessions = [stale({ provider: 'claude', busy: true, queued: true, error: 'Fixture failed' })]
  sessionFailure = true
  await act(async () => root.render(<Usage.SessionAccessory store={store} input={{ sessionId: 'session-1' }} />))
  expect(container.querySelector('.ui-notice-line .status-loading[role="status"]')?.textContent).toContain('Waiting for this Claude session')
  expect(container.querySelector('.ui-inline-error')?.textContent).toContain('The session remains on its previous account')
  await click('Restart session')
  expect(container.querySelectorAll('.ui-inline-error').length).toBe(2)
})
test('remote provider stale-session restriction and failure use shared components', async () => {
  state.staleSessions = [stale({ error: 'Fixture failed' })]
  store.getSnapshot().scope = remote('ready', 'Fixture owner')
  await details(provider())
  expect(container.querySelector('.section-card .ui-notice-line')?.textContent).toBe('Restart and keep actions are available only on this device.')
  expect(container.querySelector('.stale-row .ui-inline-error')?.textContent).toBe('Restart failed. Retry when the session is available.')
  expect(button('Keep old account').disabled).toBe(true)
})
test('switch dialog shows shared failure feedback and closes after a successful queued restart', async () => {
  state.staleSessions = [stale({ provider: 'claude', busy: true, error: 'Fixture failed' })]
  sessionFailure = true
  await act(async () => root.render(<Usage.AccountSwitchDialog store={store} />))
  expect(document.querySelector('.ui-inline-error')?.textContent).toContain('This session remains on its old account.')
  await click('Keep as is', document.body)
  expect(document.querySelectorAll('.ui-inline-error').length).toBeGreaterThan(1)
  sessionFailure = false
  await click('Restart session', document.body)
  expect(document.querySelector('.accounts-switch-dialog-root')).toBeNull()
})
test('surfaces with no stale sessions render no placeholder', async () => {
  await act(async () => root.render(<><Usage.SessionAccessory store={store} input={{ sessionId: 'missing' }} /><Usage.AccountSwitchDialog store={store} /></>))
  expect(container.textContent).toBe('')
})
