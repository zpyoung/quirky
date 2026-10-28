export type ManagedProvider = 'claude' | 'codex'

export type AccountSummary = {
  id: string
  provider: ManagedProvider
  label: string
  email: string | null
  organization: string | null
  createdAt: number
  updatedAt: number
  lastAuthenticatedAt: number | null
  needsSignIn: boolean
  active: boolean
}

export type SystemAccount = {
  label: string
  email: string | null
  hasAuth: boolean
  authKind: 'oauth' | 'api-key' | 'none' | 'unknown'
}

export type PendingLogin = {
  id: string
  provider: ManagedProvider
  accountId: string | null
  status: 'pending' | 'complete' | 'error' | 'cancelled'
  url: string | null
  error: string | null
  result: AccountSummary | null
}

export type Preferences = {
  mode: 'compact' | 'detailed'
  direction: 'used' | 'remaining'
  hidden: boolean
  visibleProviders: string[]
  density: 'normal' | 'icons'
  claudeSwitchPolicy: 'ask' | 'always' | 'never'
  skipCodexResetConfirm: boolean
}

export type StaleSession = {
  sessionId: string
  provider: ManagedProvider
  accountId: string | null
  accountLabel: string
  selectedId: string | null
  selectedLabel: string
  busy: boolean
  queued: boolean
  kept: boolean
  error: string | null
  selectionRevision: number
}

export type ConfigWarning = {
  provider: 'codex'
  accountId: string | null
  kind: 'source-missing' | 'source-empty' | 'source-unreadable' | 'sync-failed'
  message: string
}

export type AccountState = {
  accounts: AccountSummary[]
  active: Record<ManagedProvider, string | null>
  systemDefault: Record<ManagedProvider, SystemAccount>
  pendingLogin: PendingLogin | null
  staleSessions: StaleSession[]
  configWarnings: ConfigWarning[]
  preferences: Preferences
  revision: number
}

export type AccountUiState = {
  open: boolean
  provider: string | null
  expanded: ManagedProvider | null
  settingsSection: string | null
}

export type HomeOverride = {
  value: string | null
  source: 'explicit' | 'inherited' | 'injected' | 'absent'
}

export type AccountIdentity = {
  provider: ManagedProvider
  id: string | null
  label: string
  source: 'managed' | 'default' | 'custom'
  authKind: 'oauth' | 'api-key' | 'none' | 'unknown'
}

export type PrepareInput = {
  agent: string
  sessionId: string
  worktreeId: string
  cwd: string
  homeOverrides: Record<ManagedProvider, HomeOverride>
  resume?: {
    sourceSessionId: string
    providerSession: { id: string; transcriptPath: string | null }
  }
}

export type AccountPrepareResult = {
  env: Record<string, string | null>
  shellInit: string | null
  account: AccountIdentity | null
  resumeTranscriptPath?: string
}

/** Account-scoped provider probes prepare an effective home without inventing a runtime session. */
export type ProviderPrepareInput = Omit<PrepareInput, 'sessionId' | 'worktreeId' | 'resume'>

export type AccountRecord = AccountSummary & {
  home: string
  identityKey: string | null
  authKind: 'oauth' | 'api-key' | 'none' | 'unknown'
}

export type AccountSessionRecord = {
  sessionId: string
  provider: ManagedProvider
  accountId: string | null
  accountLabel: string
  source: AccountIdentity['source']
  home: string
  selectionRevision: number
  worktreeId: string
  cwd: string
  agent: string
  busy: boolean
  kept: boolean
  error: string | null
}

export type SessionHomeResult = {
  provider: ManagedProvider | null
  home: string | null
}

export type RestartIntention = {
  sessionId: string
  targetId: string | null
  selectionRevision: number
}

export type AccountLoginInput = {
  provider: ManagedProvider
  label?: string
  accountId?: string
  copyLink?: boolean
}

export type AccountSelectInput = {
  provider: ManagedProvider
  accountId: string | null
}

export type AccountRemoveInput = {
  provider: ManagedProvider
  accountId: string
  yes?: boolean
}

export const MANAGED_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const DEFAULT_PREFERENCES: Preferences = {
  mode: 'compact',
  direction: 'used',
  hidden: false,
  visibleProviders: ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'],
  density: 'normal',
  claudeSwitchPolicy: 'ask',
  skipCodexResetConfirm: false
}

export const DEFAULT_UI_STATE: AccountUiState = {
  open: false,
  provider: null,
  expanded: null,
  settingsSection: null
}
