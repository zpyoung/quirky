import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import type { QuirkyEvent, UiPluginContext } from '@quirky/protocol'
import { AccountsSettings } from '../src/window/AccountsSettings'
import { AccountsUiStore } from '../src/window/model'
import type { Preferences } from '../src/types'

const preferences: Preferences = {
  mode: 'compact', direction: 'used', hidden: false,
  visibleProviders: ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}
const loginAUrl = 'https://auth.openai.com/oauth/authorize?login=a'
const loginBUrl = 'https://auth.openai.com/oauth/authorize?login=b'

type RecordedCall = { method: string; params?: Record<string, unknown> }
type OpenerResult = { resolve(value: unknown): void; reject(error: unknown): void }

let container: HTMLElement
let root: Root
let context: UiPluginContext
let listeners: ((event: QuirkyEvent) => void | Promise<void>)[]
let calls: RecordedCall[]
let toasts: unknown[][]
let openers: OpenerResult[]
let listedState: unknown
let store: AccountsUiStore

function accountState(revision: number, accountId: string, label: string, loginId: string | null, loginUrl: string | null) {
  return {
    accounts: [{
      id: accountId, provider: 'codex', label, email: `${label.toLowerCase().replaceAll(' ', '.')}@example.test`, organization: null,
      createdAt: 1, updatedAt: revision, lastAuthenticatedAt: 1, needsSignIn: false, active: true
    }],
    active: { claude: null, codex: accountId },
    systemDefault: {
      claude: { label: 'System default', email: null, hasAuth: false, authKind: 'none' },
      codex: { label: 'System default', email: null, hasAuth: false, authKind: 'none' }
    },
    pendingLogin: loginId ? {
      id: loginId, provider: 'codex', accountId, status: 'pending', url: loginUrl, error: null, result: null
    } : null,
    staleSessions: [], configWarnings: [], preferences, revision
  }
}

function makeContext(): UiPluginContext {
  const uiContext = {
    pluginId: 'quirky.accounts',
    call: async (method: string, params?: Record<string, unknown>) => {
      calls.push({ method, params })
      if (method === 'quirky.accounts/list') return listedState
      if (method === 'quirky.accounts/uiState') return { open: false, provider: null, expanded: null, settingsSection: 'codex' }
      if (method === 'quirky.accounts/usage') return { providers: [], inactive: {}, updatedAt: 0 }
      if (method === 'quirky.accounts/credentialStatus') return []
      if (method === 'quirky.agents/list') return { agents: [] }
      if (method === 'quirky.terminal/openExternal') {
        const deferred = Promise.withResolvers<unknown>()
        openers.push({ resolve: deferred.resolve, reject: deferred.reject })
        return deferred.promise
      }
      if (method === 'quirky.accounts/cancelLogin') {
        listedState = accountState(3, 'codex-b', 'Account B', null, null)
        return { ok: true }
      }
      return undefined
    },
    subscribe: (listener: (event: QuirkyEvent) => void | Promise<void>) => {
      listeners.push(listener)
      return () => { listeners = listeners.filter((current) => current !== listener) }
    },
    toast: (...args: unknown[]) => toasts.push(args),
    closeView: () => {},
    getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
    onLayout: () => () => {}
  }
  return uiContext as unknown as UiPluginContext
}

function buttonByText(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll('button')].find((button) => button.textContent?.trim() === text)
  if (!(element instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`)
  return element
}

async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

async function wait(ms: number): Promise<void> {
  const deferred = Promise.withResolvers<void>()
  setTimeout(deferred.resolve, ms)
  await deferred.promise
}

beforeAll(() => {
  GlobalRegistrator.register()
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  listeners = []
  calls = []
  toasts = []
  openers = []
  listedState = accountState(1, 'codex-a', 'Account A', 'login-a', loginAUrl)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  context = makeContext()
  store = new AccountsUiStore(context)
})

afterEach(async () => {
  await act(async () => {
    for (const opener of openers) opener.resolve({ ok: true })
    store.stop()
    root.unmount()
    await Promise.resolve()
  })
  container.remove()
})

test('Codex Open uses the rendered URL and a late refusal leaves the current login selected and cancellable', async () => {
  await act(async () => {
    root.render(<AccountsSettings context={context} store={store} />)
    store.start()
  })
  await settle()

  await act(async () => { buttonByText('Open').click() })
  expect(calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([{ target: loginAUrl }])

  listedState = accountState(2, 'codex-b', 'Account B', 'login-b', loginBUrl)
  await act(async () => {
    for (const listener of [...listeners]) await listener({ type: 'quirky.accounts/changed', data: { revision: 2 } } as QuirkyEvent)
    await wait(40)
  })
  await settle()
  expect(container.textContent).toContain('Account B')

  await act(async () => { buttonByText('Open').click() })
  expect(calls.filter((call) => call.method === 'quirky.terminal/openExternal').map((call) => call.params)).toEqual([
    { target: loginAUrl }, { target: loginBUrl }
  ])

  await act(async () => {
    openers[0]!.reject(new Error('system browser refused invocation'))
    await Promise.resolve()
    await Promise.resolve()
  })
  expect(container.textContent).not.toContain('system browser refused invocation')
  expect(buttonByText('Cancel').disabled).toBe(false)
  expect(container.querySelector('[aria-label="Select Codex account Account B"]')?.getAttribute('disabled')).not.toBeNull()

  await act(async () => { buttonByText('Cancel').click() })
  await settle()
  expect(calls.find((call) => call.method === 'quirky.accounts/cancelLogin')?.params).toEqual({ id: 'login-b' })
})
