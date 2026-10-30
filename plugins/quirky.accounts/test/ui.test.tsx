import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { activate, deactivate } from '../src/ui'
import { AccountsUiStore } from '../src/window/model'
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
let consumeReply: unknown | undefined
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
  consumeReply = undefined
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
        return consumeReply === undefined ? { outcome: 'reset', state: usageValue } : consumeReply
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
function inputByLabel(root: ParentNode, text: string): HTMLInputElement {
  const label = [...root.querySelectorAll<HTMLLabelElement>('label')].find((candidate) => candidate.textContent?.trim() === text)
  const input = label?.control
  if (!(input instanceof HTMLInputElement)) throw new Error(`Missing input: ${text}`)
  return input
}
function dialogByTitle(root: ParentNode, title: string): HTMLElement | null {
  return [...root.querySelectorAll<HTMLElement>('[role="dialog"][aria-labelledby]')].find((dialog) => {
    const titleText = (dialog.getAttribute('aria-labelledby') ?? '')
      .split(/\s+/)
      .map((id) => dialog.ownerDocument.getElementById(id)?.textContent?.trim())
      .filter(Boolean)
      .join(' ')
    return titleText === title
  }) ?? null
}




type UsageColorProvider = 'claude' | 'codex'

function usageWithPercentages(values: Partial<Record<UsageColorProvider, number | null>>) {
  return {
    providers: providers.map((provider) => {
      const usedPercent = provider === 'claude' || provider === 'codex' ? values[provider] ?? null : null
      return {
        provider,
        accountId: provider === 'claude' ? 'managed-1' : provider === 'codex' ? 'codex-1' : null,
        status: usedPercent === null ? 'unavailable' : 'ok',
        error: null,
        updatedAt: 10,
        session: null,
        weekly: usedPercent === null ? null : { usedPercent, windowMinutes: 10_080, resetsAt: 1_000, resetDescription: 'soon' }
      }
    }),
    inactive: {},
    updatedAt: 10
  }
}

function accountsForDirection(direction: 'used' | 'remaining') {
  const claude = accountState(1, 'Claude account')
  const codex = codexState(1, 'codex-1', 'Codex account')
  return {
    ...claude,
    accounts: [...claude.accounts, ...codex.accounts],
    active: { claude: 'managed-1', codex: 'codex-1' },
    preferences: { ...preferences, direction }
  }
}

async function openUsageRoster(direction: 'used' | 'remaining', values: Partial<Record<UsageColorProvider, number | null>>) {
  usageValue = usageWithPercentages(values)
  listResponse = () => accountsForDirection(direction)
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
}

function rosterSummary(provider: UsageColorProvider): HTMLElement {
  const name = provider === 'claude' ? 'Claude' : 'Codex'
  const row = container.querySelector(`[aria-label="Open ${name} details and account switcher"]`)
  if (!(row instanceof HTMLButtonElement)) throw new Error(`Missing ${name} roster row`)
  const summary = row.querySelector('small')
  if (!(summary instanceof HTMLElement)) throw new Error(`Missing ${name} roster summary`)
  return summary
}

function assertProviderColor(provider: UsageColorProvider, color: string, direction: 'used' | 'remaining', displayedPercent: number) {
  const summary = rosterSummary(provider)
  expect(summary.style.color).toBe(color)
  expect(summary.textContent).toContain(`${displayedPercent}% ${direction}`)
  const chip = container.querySelector(`.usage-chips [data-provider="${provider}"]`)
  if (!(chip instanceof HTMLElement)) throw new Error(`Missing ${provider} status-bar chip`)
  const value = chip.querySelector('span[style]')
  if (!(value instanceof HTMLElement)) throw new Error(`Missing ${provider} status-bar value`)
  expect(value.style.color).toBe(color)
  expect(chip.getAttribute('aria-label')).toContain(`${displayedPercent}% ${direction}`)
}

for (const direction of ['used', 'remaining'] as const) {
  test(`Claude 90% and Codex 87% usage stay red in ${direction} mode`, async () => {
    await openUsageRoster(direction, { claude: 90, codex: 87 })
    assertProviderColor('claude', 'var(--ui-failing)', direction, direction === 'used' ? 90 : 10)
    assertProviderColor('codex', 'var(--ui-failing)', direction, direction === 'used' ? 87 : 13)
  })
}

const usageColorCases = [
  [59, 'var(--ui-accent)'],
  [60, 'var(--ui-needs-you)'],
  [79, 'var(--ui-needs-you)'],
  [80, 'var(--ui-failing)']
] as const

for (const direction of ['used', 'remaining'] as const) {
  for (const [usedPercent, color] of usageColorCases) {
    test(`${usedPercent}% usage uses the expected summary color in ${direction} mode`, async () => {
      await openUsageRoster(direction, { claude: usedPercent, codex: usedPercent })
      const displayedPercent = direction === 'used' ? usedPercent : 100 - usedPercent
      assertProviderColor('claude', color, direction, displayedPercent)
      assertProviderColor('codex', color, direction, displayedPercent)
    })
  }
}

test('no-window usage summaries retain fallback status styling', async () => {
  await openUsageRoster('used', { claude: null, codex: null })
  for (const provider of ['claude', 'codex'] as const) {
    const summary = rosterSummary(provider)
    expect(summary.classList.contains('status-muted')).toBe(true)
    expect(summary.style.color).toBe('')
    expect(summary.textContent).not.toMatch(/\d+%/)
  }
})


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

for (const direction of ['used', 'remaining'] as const) {
  test(`the Claude status chip is an accessible button that opens Claude details and account choices in ${direction} mode`, async () => {
    const displayedPercent = direction === 'used' ? 62 : 38
    listResponse = () => ({ ...accountState(1, 'Current Claude account'), preferences: { ...preferences, direction } })
    usageValue = {
      ...emptyUsage,
      providers: emptyUsage.providers.map((snapshot) => snapshot.provider === 'claude'
        ? { ...snapshot, accountId: 'managed-1', status: 'ok', weekly: { usedPercent: 62, windowMinutes: 10_080, resetsAt: null, resetDescription: '7h 36m' } }
        : snapshot)
    }
    uiStateValue = { open: false, provider: 'codex', expanded: 'codex', settingsSection: null }
    const context = makeContext()
    await act(async () => {
      activate(context)
      const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
      unregister = mount(container, {}) as (() => void) | undefined
    })
    await settle()

    expect(container.querySelector('[role="dialog"]')).toBeNull()
    const chip = container.querySelector('.usage-chips [data-provider="claude"]')
    if (!(chip instanceof HTMLButtonElement)) throw new Error('Missing Claude usage chip button')
    expect(chip.type).toBe('button')
    expect(chip.getAttribute('aria-label')).toContain('Claude')
    expect(chip.getAttribute('aria-label')).toContain(`${displayedPercent}% ${direction}`)
    expect(chip.getAttribute('aria-label')).toContain('Open')
    expect(chip.getAttribute('aria-label')).toContain('7h 36m')

    await act(async () => { chip.click() })
    await settle()

    expect(container.querySelector('[aria-label="Claude usage details"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Claude account switcher"]')).not.toBeNull()
    expect(container.querySelector('[aria-label="Codex account switcher"]')).toBeNull()
    expect(buttonByLabel('Expand account choices').getAttribute('aria-expanded')).toBe('false')
  })
}

test('an unavailable Claude status chip remains an accessible action for Claude details', async () => {
  listResponse = () => accountState(1, 'Current Claude account')
  uiStateValue = { open: false, provider: null, expanded: null, settingsSection: null }
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()

  const chip = container.querySelector('.usage-chips [data-provider="claude"]')
  if (!(chip instanceof HTMLButtonElement)) throw new Error('Missing unavailable Claude usage chip button')
  expect(chip.getAttribute('aria-label')).toContain('Claude')
  expect(chip.getAttribute('aria-label')).toContain('Unavailable')
  expect(chip.getAttribute('aria-label')).toContain('Open')
  expect(chip.getAttribute('aria-label')).not.toContain('resets')
  await act(async () => { chip.click() })
  await settle()

  expect(container.querySelector('[aria-label="Claude usage details"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Claude account switcher"]')).not.toBeNull()
})

test('the Codex status chip opens Codex details and its account switcher', async () => {
  const scope = { accountId: 'codex-1', accountRevision: 1, offerRevision: 'codex-offer' }
  listResponse = () => codexState(1, 'codex-1', 'Codex account')
  usageValue = codexUsage(scope)
  uiStateValue = { open: false, provider: 'claude', expanded: 'claude', settingsSection: null }
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()

  expect(container.querySelector('[role="dialog"]')).toBeNull()
  const chip = container.querySelector('.usage-chips [data-provider="codex"]')
  if (!(chip instanceof HTMLButtonElement)) throw new Error('Missing Codex usage chip button')
  expect(chip.getAttribute('aria-label')).toContain('Codex')
  expect(chip.getAttribute('aria-label')).toContain('75% used')
  expect(chip.getAttribute('aria-label')).toContain('resets now')
  await act(async () => { chip.click() })
  await settle()

  expect(container.querySelector('[aria-label="Codex usage details"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Codex account switcher"]')).not.toBeNull()
  expect(container.querySelector('[aria-label="Claude account switcher"]')).toBeNull()
  expect(buttonByLabel('Expand account choices').getAttribute('aria-expanded')).toBe('false')
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

  const confirmation = dialogByTitle(container, 'Reset Codex limits confirmation')
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
test('the reset consumer rejects a legacy scalar success response', async () => {
  const scope = { accountId: 'codex-a', accountRevision: 1, offerRevision: 'offer-a' }
  usageValue = codexUsage(scope)
  consumeReply = 'reset'
  const store = new AccountsUiStore(makeContext())
  try {
    await expect(store.consumeResetCredit('legacy-reset-request', scope)).resolves.toBe('failed')
    expect(toastCalls).toContainEqual([
      'Could not reset Codex limits',
      'The accounts service returned an unrecognized reset outcome.'
    ])
    expect(calls.filter((call) => call.method === 'quirky.accounts/consumeResetCredit')).toHaveLength(1)
  } finally {
    store.stop()
  }
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
  const checkbox = inputByLabel(container, 'Allow Gemini CLI OAuth credential refresh')
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

test('unconfigured Usage opens setup without expanding the status bar and keeps a restore path after hiding', async () => {
  listResponse = () => emptyAccountState(1, preferencesValue)
  usageValue = { ...emptyUsage, providers: emptyUsage.providers.map((provider) => ({ ...provider, accountId: null })) }
  const context = makeContext()
  await act(async () => {
    activate(context)
    const mount = provided.get('status-bar:quirky.accounts/usage') as (element: HTMLElement, props: { input?: unknown; report?(state: unknown): void }) => (() => void) | void
    unregister = mount(container, {}) as (() => void) | undefined
  })
  await settle()

  expect(container.querySelector('[role="dialog"]')).toBeNull()
  await act(async () => { buttonByLabel('Open Usage').click() })
  await settle()
  expect(uiStateValue.open).toBe(true)
  await act(async () => { buttonByLabel('Hide from status bar').click() })
  await settle()
  expect(preferencesValue.hidden).toBe(true)
  const statusBar = container.querySelector('.usage-status-bar')
  if (!(statusBar instanceof HTMLElement)) throw new Error('Missing Usage status bar root')
  expect(container.querySelector('[aria-label="Open Usage"]')).toBeNull()

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
