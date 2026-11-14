import { expect, test } from 'bun:test'
import type { UiPluginContext } from '@quirky/protocol'
import { AccountsUiStore, parseUsageState } from '../src/window/model'
import type { Preferences } from '../src/types'

const preferences: Preferences = {
  mode: 'compact', direction: 'used', hidden: false,
  visibleProviders: ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}

function accountState(revision: number) {
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
