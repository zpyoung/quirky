import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { activate, deactivate } from '../src/ui'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import type { Preferences } from '../src/types'

const providers = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode']
const preferences = {
  mode: 'compact', direction: 'used', hidden: false, visibleProviders: providers,
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
} as const
const systemDefault = {
  claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' },
  codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' }
} as const

type ConfigWarningFixture = { provider: 'codex'; accountId: string | null; kind: 'source-missing' | 'source-empty' | 'source-unreadable' | 'sync-failed'; message: string }

function accountState(revision: number, label: string) {
  return {
    accounts: [{ id: 'managed-1', provider: 'claude', label, email: `${label.toLowerCase()}@example.test`, organization: null, createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1, needsSignIn: false, active: true }],
    active: { claude: 'managed-1', codex: null }, systemDefault,
    pendingLogin: null, staleSessions: [], configWarnings: [], preferences, revision
  }
}
function emptyAccountState(revision: number, preferences: Preferences) {
  return {
    accounts: [], active: { claude: null, codex: null }, systemDefault,
    pendingLogin: null, staleSessions: [], configWarnings: [], preferences, revision
  }
}

function codexState(revision: number, id: string, label: string, configWarnings: ConfigWarningFixture[] = []) {
  return {
    accounts: [{ id, provider: 'codex', label, email: `${id}@example.test`, organization: null, createdAt: 1, updatedAt: revision, lastAuthenticatedAt: 1, needsSignIn: false, active: true }],
    active: { claude: null, codex: id }, systemDefault,
    pendingLogin: null, staleSessions: [], configWarnings, preferences, revision
  }
}

function codexUsage(expectedScope: { accountId: string | null; accountRevision: number; offerRevision: string }) {
  return {
    providers: providers.map((provider) => provider === 'codex'
      ? { provider, accountId: expectedScope.accountId, status: 'ok', error: null, updatedAt: 10, session: null, weekly: { usedPercent: 75, windowMinutes: 10080, resetsAt: 1_000, resetDescription: 'soon' }, rateLimitResetCredits: { availableCount: 1, expectedScope } }
      : { provider, accountId: null, status: 'unavailable', error: null, updatedAt: 0, session: null, weekly: null }),
    inactive: {}, updatedAt: 10
  }
}

const emptyUsage = {
  providers: providers.map((provider) => ({ provider, accountId: provider === 'claude' ? 'managed-1' : null, status: 'unavailable', error: null, updatedAt: 0, session: null, weekly: null })),
  inactive: {}, updatedAt: 0
}

let unregister: (() => void) | undefined
let container: HTMLElement
let calls: { method: string; params?: Record<string, unknown> }[]
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let provided: Map<string, unknown>
let listCalls: number
let firstList: Promise<unknown>
let resolveFirstList!: (value: unknown) => void
let toastCalls: unknown[]
let uiStateValue: { open: boolean; provider: string | null; expanded: 'claude' | 'codex' | null; settingsSection: string | null }
let usageValue: unknown
let listResponse: (callNumber: number) => unknown
let consumeFailures: number
let settingValue: unknown
let agentListing: unknown
let refreshedAgentListing: unknown
let preferencesValue: Preferences
let openedViews: string[]

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  calls = []
  listeners = []
  provided = new Map()
  listCalls = 0
  toastCalls = []
  uiStateValue = { open: false, provider: null, expanded: null, settingsSection: null }
  usageValue = emptyUsage
  consumeFailures = 0
  settingValue = false
  preferencesValue = { ...preferences, visibleProviders: [...providers] }
  openedViews = []
  agentListing = { agents: [] }
  refreshedAgentListing = { agents: [] }
  const deferred = Promise.withResolvers<unknown>()
  firstList = deferred.promise
  resolveFirstList = deferred.resolve
  listResponse = (callNumber) => callNumber === 1 ? firstList : accountState(2, 'Fresh account')
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
  const context = {
    pluginId: 'quirky.accounts',
    log: () => {},
    provide: (id: string, implementation: unknown) => provided.set(id, implementation),
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.agents/list') return agentListing
      if (method === 'quirky.agents/refresh') return refreshedAgentListing
      if (method === 'quirky.accounts/refresh') return usageValue
      if (method === 'quirky.accounts/list') {
        listCalls += 1
        return listResponse(listCalls)
      }
      if (method === 'quirky.accounts/usage') return usageValue
      if (method === 'quirky.accounts/uiState') return { ...uiStateValue }
      if (method === 'quirky.accounts/credentialStatus') return []
      if (method === 'quirky.accounts/setUiState') {
        const open = params?.open
        const provider = params?.provider
        const expanded = params?.expanded
        const settingsSection = params?.settingsSection
        if (typeof open === 'boolean') uiStateValue.open = open
        if (provider === null || typeof provider === 'string') uiStateValue.provider = provider
        if (expanded === null || expanded === 'claude' || expanded === 'codex') uiStateValue.expanded = expanded
        if (settingsSection === null || typeof settingsSection === 'string') uiStateValue.settingsSection = settingsSection
        return { ...uiStateValue }
      }
      if (method === 'quirky.accounts/consumeResetCredit') {
        if (consumeFailures > 0) {
          consumeFailures -= 1
          throw new Error('fixture failure')
        }
        return { outcome: 'reset' }
      }
      if (method === 'setting.set') {
        if (params?.id === 'setting:quirky.accounts/gemini-cli-oauth-enabled' && typeof params.value === 'boolean') settingValue = params.value
        return settingValue
      }
      if (method === 'quirky.accounts/setPreferences') {
        if (typeof params?.hidden === 'boolean') preferencesValue = { ...preferencesValue, hidden: params.hidden }
        return preferencesValue
      }
      return undefined
    },
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((current) => current !== listener) }
    },
    getSetting: () => settingValue,
    executeCommand: async () => {},
    openView: (id: string) => openedViews.push(id),
    closeView: () => {},
    togglePanel: () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {},
    onStream: () => () => {},
    onConnection: () => () => {},
    confirm: async () => true,
    toast: (...args: unknown[]) => toastCalls.push(args),
    setPanelBadge: () => {},
    setContext: () => {},
    mountView: () => () => {}
  }
  return context as unknown as UiPluginContext
}

const settle = async () => {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function wait(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>()
  setTimeout(() => deferred.resolve(), ms)
  await deferred.promise
}

function buttonByLabel(name: string): HTMLButtonElement {
  const element = container.querySelector(`[aria-label="${name}"]`)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return element
}
function buttonByText(name: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === name)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${name}`)
  return element
}


test('a late account-list response cannot replace a newer selected account in Usage', async () => {
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })

  await act(async () => {
    for (const listener of listeners) await listener({ type: 'quirky.accounts/changed', data: { revision: 2 } } as QuirkyEvent)
    await wait(35)
  })
  await settle()
  await act(async () => { resolveFirstList(accountState(1, 'Stale account')) })
  await settle()

  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Claude details and account switcher').click() })
  await settle()

  expect(container.textContent).toContain('Fresh account')
  expect(container.textContent).not.toContain('Configure usage tracking')
  expect(container.textContent).not.toContain('Stale account')
  expect(toastCalls).toEqual([])
})

test('a reset confirmation keeps the displayed Codex scope and request ID across selection changes and retry', async () => {
  const scopeA = { accountId: 'codex-a', accountRevision: 1, offerRevision: 'offer-a' }
  const scopeB = { accountId: 'codex-b', accountRevision: 2, offerRevision: 'offer-b' }
  listResponse = (callNumber) => callNumber === 1 ? codexState(1, 'codex-a', 'Account A') : codexState(2, 'codex-b', 'Account B')
  usageValue = codexUsage(scopeA)
  consumeFailures = 1
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  await act(async () => { buttonByLabel('Open Codex details and account switcher').click() })
  await act(async () => { buttonByLabel('Reset Codex limits').click() })

  usageValue = codexUsage(scopeB)
  listResponse = () => codexState(2, 'codex-b', 'Account B')
  await act(async () => {
    for (const listener of listeners) await listener({ type: 'quirky.accounts/changed', data: { revision: 2 } } as QuirkyEvent)
    await wait(35)
  })
  await settle()
  expect(container.textContent).toContain('Offer shown for Account A')
  expect(container.textContent).toContain('Account B')

  const confirmation = container.querySelector('[aria-label=\"Reset Codex limits confirmation\"]')
  if (!(confirmation instanceof HTMLElement)) throw new Error('Missing Codex reset confirmation')
  const reset = [...confirmation.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Reset now')
  if (!(reset instanceof HTMLButtonElement)) throw new Error('Missing Codex reset confirmation button')
  await act(async () => { reset.click() })
  await settle()
  const retry = [...confirmation.querySelectorAll('button')].find((button) => button.textContent?.trim() === 'Retry reset')
  if (!(retry instanceof HTMLButtonElement)) throw new Error('Missing Codex reset retry button')
  await act(async () => { retry.click() })
  await settle()

  const redemptions = calls.filter((call) => call.method === 'quirky.accounts/consumeResetCredit')
  expect(redemptions).toHaveLength(2)
  expect(redemptions.map((call) => call.params?.expectedScope)).toEqual([scopeA, scopeA])
  expect(redemptions[0]?.params?.idempotencyKey).toBe(redemptions[1]?.params?.idempotencyKey)
})
test('Gemini CLI OAuth credential refresh requires an explicit setting change', async () => {
  listResponse = () => accountState(1, 'Fresh account')
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('view:quirky.accounts/settings') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()

  await act(async () => { buttonByText('Gemini CLI (legacy)').click() })
  const checkbox = container.querySelector('[aria-label=\"Allow Gemini CLI OAuth credential refresh\"]')
  if (!(checkbox instanceof HTMLInputElement)) throw new Error('Missing Gemini OAuth consent toggle')
  expect(checkbox.checked).toBe(false)

  await act(async () => { checkbox.click() })
  await settle()
  expect(checkbox.checked).toBe(true)
})

test('Codex settings show configuration warnings for the selected account only', async () => {
  const selectedWarning: ConfigWarningFixture = {
    provider: 'codex', accountId: 'codex-a', kind: 'source-unreadable',
    message: 'Codex is still using the settings it last synced because this account source could not be read.'
  }
  const otherWarning: ConfigWarningFixture = {
    provider: 'codex', accountId: 'codex-b', kind: 'source-missing',
    message: 'Account B has a separate settings warning.'
  }
  listResponse = () => codexState(1, 'codex-a', 'Account A', [selectedWarning, otherWarning])
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('view:quirky.accounts/settings') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()
  await act(async () => { buttonByText('Codex').click() })
  await settle()

  expect(container.textContent).toContain(selectedWarning.message)
  expect(container.textContent).not.toContain(otherWarning.message)
})

test('the unconfigured Usage CTA is visible in the status bar and hiding it leaves a restore path', async () => {
  listResponse = () => emptyAccountState(1, preferencesValue)
  usageValue = { ...emptyUsage, providers: emptyUsage.providers.map((provider) => ({ ...provider, accountId: null })) }
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()

  expect(container.textContent).toContain('Configure usage tracking')
  expect(buttonByLabel('Open Usage')).not.toBeNull()
  await act(async () => { buttonByLabel('Hide from status bar').click() })
  await settle()
  expect(preferencesValue.hidden).toBe(true)
  const statusBar = container.querySelector('.usage-status-bar')
  if (!(statusBar instanceof HTMLElement)) throw new Error('Missing Usage status bar root')
  expect(statusBar.style.display).toBe('none')

  const openCommand = provided.get('command:quirky.accounts/open')
  if (typeof openCommand !== 'function') throw new Error('Missing Usage open command')
  await act(async () => { await (openCommand as () => Promise<void>)() })
  expect(openedViews).toContain('view:quirky.accounts/settings')
  expect(uiStateValue.settingsSection).toBe('appearance')
})

test('status-bar visibility gates absent CLI toggles and refreshes public detection', async () => {
  const gatedAgents = ['claude', 'codex', 'gemini', 'kimi', 'antigravity', 'grok', 'zcode']
  agentListing = { agents: gatedAgents.map((id) => ({ id, installed: false })) }
  refreshedAgentListing = { agents: [{ id: 'claude', installed: true }] }
  listResponse = () => accountState(1, 'Fresh account')
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()
  const statusBar = container.querySelector('.usage-status-bar')
  if (!(statusBar instanceof HTMLElement)) throw new Error('Missing Usage status bar')
  await act(async () => { statusBar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })) })
  const labels = [...statusBar.querySelectorAll('.context-menu input')].map((input) => input.getAttribute('aria-label'))
  expect(labels).toEqual(['OpenCode Go Usage', 'MiniMax Usage', 'Cursor Usage'])
  expect(statusBar.querySelector('.usage-chips [data-provider=\"claude\"]')).not.toBeNull()

  await act(async () => { buttonByLabel('Refresh rate limits').click() })
  await settle()
  expect(statusBar.querySelector('[aria-label=\"Claude Usage\"]')).not.toBeNull()
  expect(calls.some((call) => call.method === 'quirky.agents/refresh')).toBe(true)
  expect(calls.some((call) => call.method === 'quirky.accounts/setPreferences')).toBe(false)
})
