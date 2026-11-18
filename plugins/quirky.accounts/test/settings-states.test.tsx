import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { AccountsUiStore, parseUsageState, type AccountState, type AccountWindowScope, type ProviderSnapshot } from '../src/window/model'
import { AccountsSettings } from '../src/window/AccountsSettings'
import type { Preferences } from '../src/types'

const preferences: Preferences = {
  mode: 'compact', direction: 'used', hidden: false,
  visibleProviders: ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}

function accountState(revision: number): AccountState {
  return {
    accounts: [],
    active: { claude: null, codex: null },
    systemDefault: {
      claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' },
      codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' }
    },
    pendingLogin: null,
    staleSessions: [],
    configWarnings: [],
    preferences,
    revision
  }
}

const emptyUsage = { providers: [], inactive: {}, updatedAt: 1 }

for (const mode of ['rejected', 'invalid'] as const) {
  test(`a successful usage read preserves a ${mode} account error until accounts load successfully`, async () => {
    let accountRead: 'failed' | 'valid' = 'failed'
    const context = {
      call: async (method: string) => {
        if (method === 'quirky.accounts/list') {
          if (accountRead === 'failed') {
            if (mode === 'rejected') throw new Error('fixture account failure')
            return null
          }
          return accountState(1)
        }
        if (method === 'quirky.accounts/uiState') return { open: false, provider: null, expanded: null, settingsSection: null }
        if (method === 'quirky.accounts/usage') return emptyUsage
        return undefined
      }
    } as unknown as UiPluginContext
    const store = new AccountsUiStore(context)

    try {
      await store.loadAccounts()
      expect(store.getSnapshot().error).toBe('Account state is temporarily unavailable.')

      await store.loadUsage()
      expect(store.getSnapshot().error).toBe('Account state is temporarily unavailable.')

      accountRead = 'valid'
      await store.loadAccounts()
      expect(store.getSnapshot().error).toBeNull()
    } finally {
      store.stop()
    }
  })
}

test('parseUsageState preserves JSON own __proto__ entries and drops invalid inactive snapshots', () => {
  const snapshot = {
    provider: 'codex', accountId: 'codex-a', status: 'ok', error: null, updatedAt: 1,
    session: null, weekly: null
  }
  const inactive: Record<string, unknown> = {
    valid: snapshot,
    invalid: { ...snapshot, provider: 'not-a-provider' }
  }
  Object.defineProperty(inactive, '__proto__', { value: snapshot, enumerable: true })
  const value = JSON.parse(JSON.stringify({ providers: [snapshot], inactive, updatedAt: 2 })) as unknown
  const parsed = parseUsageState(value)

  expect(parsed).not.toBeNull()
  expect(parsed?.providers).toHaveLength(1)
  expect(Object.hasOwn(parsed!.inactive, 'valid')).toBe(true)
  expect(Object.hasOwn(parsed!.inactive, '__proto__')).toBe(true)
  expect(parsed!.inactive.__proto__).toMatchObject({ provider: 'codex', accountId: 'codex-a' })
  expect(Object.hasOwn(parsed!.inactive, 'invalid')).toBe(false)
  expect(Object.getPrototypeOf(parsed!.inactive)).toBe(Object.prototype)
})

type FixtureOptions = {
  section?: string
  accounts?: AccountState
  accountRead?: () => Promise<unknown>
  usage?: ProviderSnapshot[]
  usageFails?: boolean
  scope?: AccountWindowScope
  error?: string
  hold?: string
}
type Fixture = {
  store: AccountsUiStore
  context: UiPluginContext
  container: HTMLElement
  root: Root
  calls: Array<{ method: string; params: Record<string, unknown> }>
  toasts: unknown[][]
  pending: PromiseWithResolvers<unknown>
  emitSetting(value: boolean): Promise<void>
}
const mounted: Fixture[] = []

beforeAll(() => {
  GlobalRegistrator.register()
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
})

afterEach(async () => {
  await act(async () => {
    for (const fixture of mounted.splice(0)) {
      fixture.pending.resolve(undefined)
      fixture.store.stop()
      fixture.root.unmount()
      fixture.container.remove()
    }
  })
})

afterAll(async () => { await GlobalRegistrator.unregister() })

async function mountSettings(options: FixtureOptions = {}): Promise<Fixture> {
  const pending = Promise.withResolvers<unknown>()
  const calls: Fixture['calls'] = []
  const toasts: unknown[][] = []
  const listeners = new Set<(event: QuirkyEvent) => void | Promise<void>>()
  let setting = false
  const loaded = options.accounts ?? accountState(1)
  const usage = {
    providers: [
      ...(['claude', 'codex'] as const).map((provider) => ({
        provider, accountId: loaded.active[provider], status: 'idle', error: null, updatedAt: 1, session: null, weekly: null,
      })),
      ...(options.usage ?? []),
    ],
    inactive: {}, updatedAt: 1,
  }
  let store: AccountsUiStore
  const context = {
    call: async (method: string, params: Record<string, unknown> = {}) => {
      calls.push({ method, params })
      if (method === options.hold) return pending.promise
      if (method === 'quirky.accounts/list') return options.accountRead ? options.accountRead() : loaded
      if (method === 'quirky.accounts/uiState') return { open: false, provider: null, expanded: null, settingsSection: options.section ?? 'claude' }
      if (method === 'quirky.accounts/usage') {
        if (options.usageFails) throw new Error('fixture usage unavailable')
        return usage
      }
      if (method === 'quirky.accounts/refresh') return usage
      if (method === 'quirky.agents/refresh') return { agents: [] }
      if (method === 'quirky.terminal/openExternal') throw new Error('private fixture opener error')
      return undefined
    },
    executeCommand: async (id: string, args?: unknown) => {
      if (id === 'command:quirky.accounts/refresh') {
        const provider = args && typeof args === 'object' && 'provider' in args ? args.provider : undefined
        await store.refresh(typeof provider === 'string' ? provider : undefined)
      }
    },
    getSetting: () => setting,
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    toast: (...args: unknown[]) => toasts.push(args),
    closeView: () => {},
  } as unknown as UiPluginContext
  store = new AccountsUiStore(context)
  await store.loadUsage()
  if (options.hold !== 'quirky.accounts/list') await store.loadAccounts()
  if (options.scope) {
    const snapshot = { ...store.getSnapshot(), accounts: null, scope: options.scope, error: options.error ?? null }
    store.getSnapshot = () => snapshot
  }
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const fixture: Fixture = {
    store, context, container, root, calls, toasts, pending,
    emitSetting: async (value) => {
      setting = value
      await act(async () => {
        for (const listener of listeners) await listener({ type: 'setting.changed', id: 'setting:quirky.accounts/gemini-cli-oauth-enabled' } as QuirkyEvent)
      })
    },
  }
  mounted.push(fixture)
  await act(async () => { root.render(<AccountsSettings context={context} store={store} />) })
  return fixture
}

for (const hostName of [undefined, 'Fixture owner', null] as const) {
  test(`initial ${hostName === undefined ? 'local' : 'remote'} accounts use shared loading, not a false empty list (${hostName})`, async () => {
    const scope: AccountWindowScope | undefined = hostName === undefined ? undefined : {
      kind: 'remote', mirrorId: 'fixture-mirror', owner: null, workspace: null, hostName, status: 'loading', error: null,
    }
    const fixture = await mountSettings({ hold: 'quirky.accounts/list', usageFails: true, scope })
    expect(fixture.store.getSnapshot().loading).toBe(false)
    const expected = hostName === undefined ? 'Loading accounts…' : `Loading Accounts from ${hostName ?? 'the remote owner'}…`
    expect(fixture.container.querySelector('.ui-notice-line')?.textContent).toBe(expected)
    expect(fixture.container.querySelector('.ui-notice-line')?.closest('[role="status"][aria-live="polite"]')).not.toBeNull()
    expect(fixture.container.textContent).not.toContain('No managed Claude accounts yet.')
    expect(fixture.container.textContent).not.toContain('Add Account')
    expect(fixture.container.querySelector('nav')).not.toBeNull()
    expect([...fixture.container.querySelectorAll('button')].some(button => button.textContent === 'Close settings')).toBe(true)
  })
}

for (const mode of ['rejected', 'invalid'] as const) {
  test(`a ${mode} account read renders one shared error without inventing empty accounts`, async () => {
    const fixture = await mountSettings({ accountRead: async () => {
      if (mode === 'rejected') throw new Error('private fixture account error')
      return { invalid: true }
    } })
    expect(fixture.container.querySelector('.ui-inline-error')?.textContent).toBe('Account state is temporarily unavailable.')
    expect(fixture.container.querySelectorAll('[role="alert"]')).toHaveLength(1)
    expect(fixture.container.textContent).not.toContain('No managed Claude accounts yet.')
    expect(fixture.container.textContent).not.toContain('private fixture account error')
  })
}

test('an unavailable owner renders only its shared refusal and never local account controls', async () => {
  const error = 'The focused remote owner or workspace is unavailable. Local Accounts data was not substituted.'
  const fixture = await mountSettings({ scope: {
    kind: 'remote', mirrorId: 'fixture-mirror', owner: null, workspace: null, hostName: 'Fixture owner', status: 'unavailable', error,
  }, error })
  expect(fixture.container.querySelector('.ui-inline-error')?.textContent).toBe(error)
  expect(fixture.container.textContent?.split(error)).toHaveLength(2)
  expect(fixture.container.textContent).not.toContain('System default')
  expect(fixture.container.textContent).not.toContain('Add Account')
  expect(fixture.container.querySelectorAll('p[role="status"]')).toHaveLength(0)
})

for (const provider of ['claude', 'codex'] as const) {
  test(`loaded ${provider} emptiness keeps System default and shared empty guidance`, async () => {
    const fixture = await mountSettings({ section: provider })
    expect(fixture.container.textContent).toContain('System default')
    expect(fixture.container.querySelector('.ui-empty-state')?.textContent).toBe(`No managed ${provider === 'claude' ? 'Claude' : 'Codex'} accounts yet.`)
    expect(fixture.container.textContent).not.toContain('Loading accounts…')
  })
}

test('refresh uses shared progress without hiding already loaded rows', async () => {
  const fixture = await mountSettings({ hold: 'quirky.accounts/refresh' })
  let refresh: Promise<void>
  await act(async () => { refresh = fixture.store.refresh() })
  expect(fixture.container.querySelector('.ui-notice-line')?.textContent).toBe('Refreshing…')
  expect(fixture.container.textContent).toContain('System default')
  const refreshButton = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === 'Refresh usage')!
  expect(refreshButton.disabled).toBe(true)
  await act(async () => { fixture.pending.resolve({ providers: [], inactive: {}, updatedAt: 2 }); await refresh! })
  expect(fixture.container.querySelector('.ui-notice-line')).toBeNull()
  expect(refreshButton.disabled).toBe(false)
})

for (const provider of ['grok', 'cursor'] as const) {
  for (const scenario of [
    { status: null, component: '.ui-empty-state', text: `No ${provider === 'grok' ? 'Grok' : 'Cursor'} usage reported yet.` },
    { status: 'idle', component: '.ui-notice-line', text: 'Waiting for usage' },
    { status: 'fetching', component: '.ui-notice-line', text: 'Fetching' },
    { status: 'fetching', component: '.ui-notice-line', text: 'Refreshing', withWindow: true },
    { status: 'error', component: '.ui-inline-error', text: 'Network issue' },
    { status: 'unavailable', component: '.ui-inline-error', text: 'Network issue' },
    { status: 'signed-out', component: '.ui-empty-state', text: provider === 'grok' ? 'Not signed in to Grok CLI. In a terminal, run grok login, then refresh usage here.' : 'No Cursor sign-in found on this computer.' },
  ] as const) {
    test(`${provider} ${scenario.status ?? 'missing'} usage uses shared ${scenario.text}`, async () => {
      const usage: ProviderSnapshot[] = scenario.status === null ? [] : [{
        provider, accountId: null, status: scenario.status === 'signed-out' ? 'unavailable' : scenario.status, error: 'private fixture provider error',
        updatedAt: 1, session: 'withWindow' in scenario ? { usedPercent: 37, windowMinutes: 60, resetsAt: null, resetDescription: 'fixture reset' } : null, weekly: null,
        usageMetadata: { failureKind: scenario.status === 'signed-out' ? 'missing-credentials' : 'network' },
      }]
      const fixture = await mountSettings({ section: provider, usage })
      expect(fixture.container.querySelector(scenario.component)?.textContent ?? '').toContain(scenario.text)
      expect(fixture.container.textContent).not.toContain('private fixture provider error')
    })
  }
  test(`${provider} help opens through the public method and reports refusal safely`, async () => {
    const fixture = await mountSettings({ section: provider })
    const label = provider === 'grok' ? 'Grok CLI docs' : 'Cursor dashboard'
    const help = [...fixture.container.querySelectorAll('button')].find(button => button.textContent === label)
    expect(help).toBeDefined()
    await act(async () => { help!.click() })
    expect(fixture.calls.filter(call => call.method === 'quirky.terminal/openExternal')).toEqual([{
      method: 'quirky.terminal/openExternal', params: { target: provider === 'grok' ? 'https://docs.x.ai/' : 'https://cursor.com/dashboard' },
    }])
    expect(fixture.toasts.at(-1)).toEqual(['Could not open provider help', 'Try again or open the provider help page in your browser.'])
  })
}

test('Gemini consent saving is shared, remains explicit, and responds to setting changes', async () => {
  const fixture = await mountSettings({ section: 'gemini', hold: 'setting.set' })
  const checkbox = fixture.container.querySelector<HTMLInputElement>('#gemini-cli-oauth-enabled')!
  expect(checkbox.checked).toBe(false)
  await act(async () => { checkbox.click() })
  expect(checkbox.disabled).toBe(true)
  expect(fixture.container.querySelector('.ui-notice-line')?.textContent).toBe('Saving…')
  expect(fixture.calls.filter(call => call.method === 'setting.set')).toEqual([{
    method: 'setting.set', params: { id: 'setting:quirky.accounts/gemini-cli-oauth-enabled', value: true },
  }])
  await act(async () => { fixture.pending.resolve(undefined); await Promise.resolve() })
  expect(checkbox.checked).toBe(true)
  expect(checkbox.disabled).toBe(false)
  await fixture.emitSetting(false)
  expect(checkbox.checked).toBe(false)
})

test('Gemini consent failure retains false and uses safe failure copy', async () => {
  const fixture = await mountSettings({ section: 'gemini', hold: 'setting.set' })
  const checkbox = fixture.container.querySelector<HTMLInputElement>('#gemini-cli-oauth-enabled')!
  await act(async () => { checkbox.click() })
  expect(fixture.container.querySelector('.ui-notice-line')?.textContent).toBe('Saving…')
  await act(async () => { fixture.pending.reject(new Error('private fixture setting error')); await Promise.resolve() })
  expect(checkbox.checked).toBe(false)
  expect(checkbox.disabled).toBe(false)
  expect(fixture.toasts.at(-1)).toEqual(['Could not update Gemini CLI access', 'The setting could not be saved.'])
})

for (const provider of ['claude', 'codex'] as const) {
  for (const status of ['pending', 'error'] as const) {
    test(`${provider} ${status} sign-in uses shared progress or error copy`, async () => {
      const accounts = accountState(1)
      accounts.pendingLogin = {
        id: 'fixture-login', provider, accountId: null, status, url: null, error: 'private fixture sign-in error', result: null,
      }
      const fixture = await mountSettings({ section: provider, accounts })
      if (status === 'pending') {
        expect(fixture.container.querySelector('.ui-notice-line')?.textContent).toBe(provider === 'claude' ? 'Waiting for Claude sign-in.' : 'Codex opened this sign-in link in your browser.')
      } else {
        expect(fixture.container.querySelector('.ui-inline-error')?.textContent).toBe('Sign-in failed. Check the provider CLI and try again.')
      }
      expect(fixture.container.textContent).not.toContain('private fixture sign-in error')
    })
  }
}

test('reauthentication and only the selected Codex sync warnings use shared errors', async () => {
  const accounts = accountState(1)
  accounts.accounts = [{
    id: 'codex-a', provider: 'codex', label: 'Fixture A', email: null, organization: null,
    createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1, needsSignIn: true, active: true,
  }, {
    id: 'codex-b', provider: 'codex', label: 'Fixture B', email: null, organization: null,
    createdAt: 1, updatedAt: 1, lastAuthenticatedAt: 1, needsSignIn: false, active: false,
  }]
  accounts.active.codex = 'codex-a'
  accounts.configWarnings = [
    { provider: 'codex', accountId: 'codex-a', kind: 'sync-failed', message: 'Fixture sync failed.' },
    { provider: 'codex', accountId: 'codex-b', kind: 'sync-failed', message: 'Hidden other account warning.' },
  ]
  const fixture = await mountSettings({ section: 'codex', accounts })
  expect([...fixture.container.querySelectorAll('.ui-inline-error')].map(element => element.textContent)).toContain('Sign in again to use this account.')
  const warning = fixture.container.querySelector('[aria-label="Codex configuration warnings"] .ui-inline-error')
  expect(warning?.textContent).toBe('Fixture sync failed.')
  expect(fixture.container.textContent).not.toContain('Hidden other account warning.')
})
