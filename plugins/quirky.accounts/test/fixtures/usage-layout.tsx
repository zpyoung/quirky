import { createRoot } from 'react-dom/client'
import type { UiPluginContext } from '@quirky/protocol'
import { StatusBarUsage } from '../../src/window/Usage'
import { AccountsUiStore } from '../../src/window/model'
import type { Preferences } from '../../src/types'

let preferences: Preferences = {
  mode: 'compact', direction: 'used', hidden: false, visibleProviders: ['claude', 'codex'],
  density: 'normal', claudeSwitchPolicy: 'ask', skipCodexResetConfirm: false
}
let ui = { open: false, provider: null, expanded: null, settingsSection: null }
let loaded = false
const systemAccount = { label: 'System default', email: null, hasAuth: true, authKind: 'oauth' }
const context = {
  subscribe: () => () => {},
  onLayout: () => () => {},
  getLayout: () => ({ view: null, panel: null, sidebar: true, focus: null }),
  call: async (method: string, params: Record<string, unknown>) => {
    switch (method) {
      case 'quirky.accounts/list':
        return { accounts: [], active: { claude: null, codex: null }, systemDefault: { claude: systemAccount, codex: systemAccount }, pendingLogin: null, staleSessions: [], configWarnings: [], preferences, revision: 1 }
      case 'quirky.accounts/usage':
      case 'quirky.accounts/refresh':
        return {
          providers: ['claude', 'codex'].map((provider, index) => ({
            provider, accountId: null, status: loaded ? 'ok' : 'fetching', error: null, updatedAt: Date.now(),
            session: loaded ? { usedPercent: index ? 3 : 18, windowMinutes: 300, resetsAt: Date.now() + 3_600_000 } : null,
            weekly: loaded ? { usedPercent: index ? 4 : 20, windowMinutes: 10080, resetsAt: Date.now() + 86_400_000 } : null
          })), inactive: {}, updatedAt: Date.now()
        }
      case 'quirky.accounts/uiState': return ui
      case 'quirky.accounts/setUiState': ui = { ...ui, ...params }; return ui
      case 'quirky.accounts/credentialStatus': return []
      case 'quirky.accounts/setPreferences': preferences = { ...preferences, ...params }; return preferences
      case 'quirky.agents/list': return { agents: [] }
      default: throw new Error(`Unexpected fixture method: ${method}`)
    }
  },
  toast: () => {}
} as unknown as UiPluginContext

const store = new AccountsUiStore(context)
store.start()
const element = document.querySelector<HTMLElement>('.accounts-mount-root--bar')!
createRoot(element).render(<StatusBarUsage store={store} />)
Object.assign(window, {
  loadUsage: async () => {
    loaded = true
    await store.refresh()
  }
})
