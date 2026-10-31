import type { OwnerSessionHostRef, OwnerSessionWorkspaceRef, QuirkyEvent, UiLayout, UiPluginContext } from '@quirky/protocol'
import type { AccountState, AccountSummary, AccountUiState, ConfigWarning, ManagedProvider, OwnerCallOperation, PendingLogin, Preferences, StaleSession, SystemAccount } from '../types'
import { DEFAULT_PREFERENCES } from '../types'
import type { CredentialStatus, ExtraUsage as MeterExtraUsage, RateLimitResetCredits as MeterResetCredits, UsageBucket as MeterBucket, UsageProvider, UsageWindow } from '../usage'
export type { AccountState, AccountSummary, AccountUiState, ConfigWarning, ManagedProvider, PendingLogin, Preferences, StaleSession, SystemAccount }
export type { CredentialStatus }

export const SETTINGS_VIEW_ID = 'view:quirky.accounts/settings'
export const MANAGED_PROVIDERS: readonly ManagedProvider[] = ['claude', 'codex']
export const PROVIDERS: readonly UsageProvider[] = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode']

export type ProviderId = UsageProvider
export const AGENT_GATED_PROVIDERS: readonly ProviderId[] = ['claude', 'codex', 'gemini', 'kimi', 'antigravity', 'grok', 'zcode']
export type AgentDetectionState = { status: 'loading' | 'ready' | 'unavailable'; installedProviders: ProviderId[] }
export type UsageMode = Preferences['mode']
export type UsageDirection = Preferences['direction']
export type UsageDensity = Preferences['density']
export type SwitchPolicy = Preferences['claudeSwitchPolicy']
export type WindowData = UsageWindow
export type UsageBucket = MeterBucket
export type ExtraUsage = MeterExtraUsage
export type ResetExpectedScope = NonNullable<MeterResetCredits['expectedScope']>
export type RateLimitResetCredits = MeterResetCredits
export type UsageFailure = { source?: string; failureKind?: string; credentialSource?: string | null; lastSuccessfulSource?: string | null; retryAtMs?: number | null }
export type ProviderSnapshot = {
  provider: ProviderId
  accountId: string | null
  status: 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'
  error: string | null
  updatedAt: number
  session: WindowData | null
  weekly: WindowData | null
  monthly?: WindowData | null
  fableWeekly?: WindowData | null
  buckets?: UsageBucket[]
  extraUsage?: ExtraUsage | null
  rateLimitResetCredits?: RateLimitResetCredits | null
  planType?: string | null
  usageMetadata?: UsageFailure
}
export type UsageState = { providers: ProviderSnapshot[]; inactive: Record<string, ProviderSnapshot>; updatedAt: number }
export type AccountWindowScope =
  | { kind: 'local'; worktreeId: string | null }
  | {
      kind: 'remote'
      mirrorId: string
      owner: OwnerSessionHostRef | null
      workspace: OwnerSessionWorkspaceRef | null
      hostName: string | null
      status: 'loading' | 'ready' | 'unavailable'
      error: string | null
    }
export type AccountUiSnapshot = { scope: AccountWindowScope; accounts: AccountState | null; usage: UsageState | null; ui: AccountUiState; credentials: CredentialStatus[]; login: PendingLogin | null; loginStarting: boolean; loginCancelling: boolean; agentDetection: AgentDetectionState; loading: boolean; refreshing: boolean; error: string | null }
export type SessionActionResult = 'applied' | 'selection-changed' | 'failed'
export type ResetCreditResult = 'reset' | 'alreadyRedeemed' | 'nothingToReset' | 'noCredit' | 'scope-changed' | 'failed'

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  claude: 'Claude', codex: 'Codex', gemini: 'Gemini', antigravity: 'Antigravity', 'opencode-go': 'OpenCode Go',
  kimi: 'Kimi', minimax: 'MiniMax', grok: 'Grok', cursor: 'Cursor', zcode: 'ZCode'
}
export const PROVIDER_BADGES: Record<ProviderId, string> = {
  claude: 'C', codex: 'X', gemini: 'G', antigravity: 'A', 'opencode-go': 'O', kimi: 'K', minimax: 'M', grok: 'R', cursor: 'U', zcode: 'Z'
}



const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const isProviderId = (value: unknown): value is ProviderId => typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value)
const isManagedProvider = (value: unknown): value is ManagedProvider => typeof value === 'string' && (MANAGED_PROVIDERS as readonly string[]).includes(value)
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)
function parseAgentDetection(value: unknown): AgentDetectionState | null {
  if (!isRecord(value) || !Array.isArray(value.agents)) return null
  const installed = new Set<ProviderId>()
  for (const candidate of value.agents) {
    if (!isRecord(candidate) || !isProviderId(candidate.id) || candidate.installed !== true || !AGENT_GATED_PROVIDERS.includes(candidate.id)) continue
    installed.add(candidate.id)
  }
  return { status: 'ready', installedProviders: AGENT_GATED_PROVIDERS.filter((provider) => installed.has(provider)) }
}

const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : value === null ? null : null
const nullableNumber = (value: unknown): number | null => isFiniteNumber(value) ? value : value === null ? null : null

function parseWindow(value: unknown): WindowData | null {
  if (value === null) return null
  if (!isRecord(value) || !isFiniteNumber(value.usedPercent) || !isFiniteNumber(value.windowMinutes)) return null
  return {
    usedPercent: Math.min(100, Math.max(0, value.usedPercent)),
    windowMinutes: value.windowMinutes,
    resetsAt: nullableNumber(value.resetsAt),
    resetDescription: nullableString(value.resetDescription)
  }
}

function parseExtraUsage(value: unknown): ExtraUsage | null {
  if (!isRecord(value) || typeof value.unit !== 'string' || typeof value.enabled !== 'boolean') return null
  const shared = { enabled: value.enabled, disabledReason: nullableString(value.disabledReason), resetsAt: nullableNumber(value.resetsAt) }
  if (value.unit === 'currency' && typeof value.currencyCode === 'string') {
    return {
      ...shared, unit: 'currency', currencyCode: value.currencyCode, balance: nullableNumber(value.balance),
      spent: nullableNumber(value.spent), spendLimit: nullableNumber(value.spendLimit), spentPercent: nullableNumber(value.spentPercent)
    }
  }
  if (value.unit === 'credits' && isFiniteNumber(value.balance) && typeof value.unlimited === 'boolean') {
    return { ...shared, unit: 'credits', balance: value.balance, unlimited: value.unlimited }
  }
  return null
}

function parseExpectedScope(value: unknown): ResetExpectedScope | undefined {
  if (!isRecord(value) || !(value.accountId === null || typeof value.accountId === 'string') || !isFiniteNumber(value.accountRevision) || typeof value.offerRevision !== 'string') return undefined
  // Keep the validated daemon offer object intact so the confirmation can submit this exact scope.
  return value as ResetExpectedScope
}

function parseResetCredits(value: unknown): RateLimitResetCredits | null {
  if (!isRecord(value) || !isFiniteNumber(value.availableCount)) return null
  const credits = Array.isArray(value.credits) ? value.credits.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.status !== 'string') return []
    return [{ status: candidate.status, expiresAt: nullableNumber(candidate.expiresAt), grantedAt: nullableNumber(candidate.grantedAt) }]
  }) : undefined
  const expectedScope = parseExpectedScope(value.expectedScope)
  return {
    availableCount: value.availableCount,
    ...(isFiniteNumber(value.totalEarnedCount) ? { totalEarnedCount: value.totalEarnedCount } : {}),
    ...(value.nextExpiresAt === null || isFiniteNumber(value.nextExpiresAt) ? { nextExpiresAt: value.nextExpiresAt } : {}),
    ...(credits ? { credits } : {}),
    ...(expectedScope ? { expectedScope } : {})
  }
}

function parseUsageFailure(value: unknown): UsageFailure | undefined {
  if (!isRecord(value)) return undefined
  return {
    ...(typeof value.source === 'string' ? { source: value.source } : {}),
    ...(typeof value.failureKind === 'string' ? { failureKind: value.failureKind } : {}),
    ...(value.credentialSource === null || typeof value.credentialSource === 'string' ? { credentialSource: value.credentialSource } : {}),
    ...(value.lastSuccessfulSource === null || typeof value.lastSuccessfulSource === 'string' ? { lastSuccessfulSource: value.lastSuccessfulSource } : {}),
    ...(value.retryAtMs === null || isFiniteNumber(value.retryAtMs) ? { retryAtMs: value.retryAtMs } : {})
  }
}

function parseSnapshot(value: unknown): ProviderSnapshot | null {
  if (!isRecord(value) || !isProviderId(value.provider) || !['idle', 'fetching', 'ok', 'error', 'unavailable'].includes(String(value.status))) return null
  if (!(value.accountId === null || typeof value.accountId === 'string') || !isFiniteNumber(value.updatedAt)) return null
  const status = value.status as ProviderSnapshot['status']
  const buckets = Array.isArray(value.buckets) ? value.buckets.flatMap((candidate) => {
    if (!isRecord(candidate) || typeof candidate.name !== 'string') return []
    const window = parseWindow(candidate)
    if (!window) return []
    return [{ ...window, name: candidate.name, ...(typeof candidate.group === 'string' ? { group: candidate.group } : {}), ...(typeof candidate.windowName === 'string' ? { windowName: candidate.windowName } : {}) }]
  }) : undefined
  const usageMetadata = parseUsageFailure(value.usageMetadata)
  return {
    provider: value.provider,
    accountId: value.accountId,
    status,
    error: nullableString(value.error),
    updatedAt: value.updatedAt,
    session: parseWindow(value.session),
    weekly: parseWindow(value.weekly),
    ...(Object.hasOwn(value, 'monthly') ? { monthly: parseWindow(value.monthly) } : {}),
    ...(Object.hasOwn(value, 'fableWeekly') ? { fableWeekly: parseWindow(value.fableWeekly) } : {}),
    ...(buckets ? { buckets } : {}),
    ...(Object.hasOwn(value, 'extraUsage') ? { extraUsage: value.extraUsage === null ? null : parseExtraUsage(value.extraUsage) } : {}),
    ...(Object.hasOwn(value, 'rateLimitResetCredits') ? { rateLimitResetCredits: value.rateLimitResetCredits === null ? null : parseResetCredits(value.rateLimitResetCredits) } : {}),
    ...(value.planType === null || typeof value.planType === 'string' ? { planType: value.planType } : {}),
    ...(usageMetadata ? { usageMetadata } : {})
  }
}

export function parseUsageState(value: unknown): UsageState | null {
  if (!isRecord(value) || !Array.isArray(value.providers) || !isRecord(value.inactive) || !isFiniteNumber(value.updatedAt)) return null
  const providers = value.providers.flatMap((candidate) => {
    const snapshot = parseSnapshot(candidate)
    return snapshot ? [snapshot] : []
  })
  const inactive: Record<string, ProviderSnapshot> = {}
  for (const [id, candidate] of Object.entries(value.inactive)) {
    const snapshot = parseSnapshot(candidate)
    if (snapshot) inactive[id] = snapshot
  }
  return { providers, inactive, updatedAt: value.updatedAt }
}

function parseAccountSummary(value: unknown): AccountSummary | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isManagedProvider(value.provider) || typeof value.label !== 'string') return null
  if (!isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt) || typeof value.needsSignIn !== 'boolean' || typeof value.active !== 'boolean') return null
  return {
    id: value.id, provider: value.provider, label: value.label,
    email: nullableString(value.email), organization: nullableString(value.organization),
    createdAt: value.createdAt, updatedAt: value.updatedAt, lastAuthenticatedAt: nullableNumber(value.lastAuthenticatedAt),
    needsSignIn: value.needsSignIn, active: value.active
  }
}

function parseSystemAccount(value: unknown): SystemAccount | null {
  if (!isRecord(value) || typeof value.label !== 'string' || typeof value.hasAuth !== 'boolean' || !['oauth', 'api-key', 'none', 'unknown'].includes(String(value.authKind))) return null
  return { label: value.label, email: nullableString(value.email), hasAuth: value.hasAuth, authKind: value.authKind as SystemAccount['authKind'] }
}

export function parsePreferences(value: unknown): Preferences | null {
  if (!isRecord(value) || !['compact', 'detailed'].includes(String(value.mode)) || !['used', 'remaining'].includes(String(value.direction))) return null
  if (typeof value.hidden !== 'boolean' || !Array.isArray(value.visibleProviders) || !['normal', 'icons'].includes(String(value.density))) return null
  if (!['ask', 'always', 'never'].includes(String(value.claudeSwitchPolicy)) || typeof value.skipCodexResetConfirm !== 'boolean') return null
  return {
    mode: value.mode as UsageMode, direction: value.direction as UsageDirection, hidden: value.hidden,
    visibleProviders: value.visibleProviders.filter((provider): provider is string => typeof provider === 'string' && isProviderId(provider)),
    density: value.density as UsageDensity, claudeSwitchPolicy: value.claudeSwitchPolicy as SwitchPolicy,
    skipCodexResetConfirm: value.skipCodexResetConfirm
  }
}

function parseSystemDefault(value: unknown): Record<ManagedProvider, SystemAccount> | null {
  if (!isRecord(value)) return null
  const claude = parseSystemAccount(value.claude)
  const codex = parseSystemAccount(value.codex)
  return claude && codex ? { claude, codex } : null
}

function parseStaleSession(value: unknown): StaleSession | null {
  if (!isRecord(value) || typeof value.sessionId !== 'string' || !isManagedProvider(value.provider)) return null
  if (!(value.accountId === null || typeof value.accountId === 'string') || !(value.selectedId === null || typeof value.selectedId === 'string')) return null
  if (typeof value.accountLabel !== 'string' || typeof value.selectedLabel !== 'string' || typeof value.busy !== 'boolean' || typeof value.queued !== 'boolean' || typeof value.kept !== 'boolean' || !isFiniteNumber(value.selectionRevision)) return null
  return { sessionId: value.sessionId, provider: value.provider, accountId: value.accountId, accountLabel: value.accountLabel, selectedId: value.selectedId, selectedLabel: value.selectedLabel, busy: value.busy, queued: value.queued, kept: value.kept, error: nullableString(value.error), selectionRevision: value.selectionRevision }
}
function parseConfigWarning(value: unknown): ConfigWarning | null {
  if (!isRecord(value) || value.provider !== 'codex' || !(value.accountId === null || typeof value.accountId === 'string')) return null
  if (!['source-missing', 'source-empty', 'source-unreadable', 'sync-failed'].includes(String(value.kind)) || typeof value.message !== 'string') return null
  return { provider: 'codex', accountId: value.accountId, kind: value.kind as ConfigWarning['kind'], message: value.message }
}


function isTrustedLoginUrl(provider: ManagedProvider, candidate: unknown): string | null {
  if (typeof candidate !== 'string') return null
  try {
    const url = new URL(candidate)
    if (url.protocol !== 'https:') return null
    const host = url.hostname.toLowerCase()
    const allowed = provider === 'claude'
      ? ['claude.ai', 'claude.com', 'anthropic.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
      : ['openai.com', 'chatgpt.com'].some((domain) => host === domain || host.endsWith(`.${domain}`))
    if (!allowed) return null
    if (provider === 'claude') {
      const redirect = url.searchParams.get('redirect_uri')
      if (!redirect) return null
      const callback = new URL(redirect)
      if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(callback.hostname)) return null
    }
    return url.href
  } catch {
    return null
  }
}

function parsePendingLogin(value: unknown): PendingLogin | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isManagedProvider(value.provider) || !['pending', 'complete', 'completed', 'error', 'cancelled'].includes(String(value.status))) return null
  const status = value.status === 'completed' ? 'complete' : value.status as PendingLogin['status']
  return {
    id: value.id, provider: value.provider, accountId: typeof value.accountId === 'string' ? value.accountId : null,
    status, url: isTrustedLoginUrl(value.provider, value.url), error: nullableString(value.error), result: parseAccountSummary(value.result)
  }
}

export function parseAccountState(value: unknown): AccountState | null {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !isRecord(value.active) || !isRecord(value.systemDefault) || !Array.isArray(value.staleSessions) || !Array.isArray(value.configWarnings) || !isFiniteNumber(value.revision)) return null
  const preferences = parsePreferences(value.preferences)
  const systemDefault = parseSystemDefault(value.systemDefault)
  if (!preferences || !systemDefault || !(value.active.claude === null || typeof value.active.claude === 'string') || !(value.active.codex === null || typeof value.active.codex === 'string')) return null
  const accounts = value.accounts.flatMap((candidate) => {
    const account = parseAccountSummary(candidate)
    return account ? [account] : []
  })
  const staleSessions = value.staleSessions.flatMap((candidate) => {
    const session = parseStaleSession(candidate)
    return session ? [session] : []
  })
  const pendingLogin = value.pendingLogin === null ? null : parsePendingLogin(value.pendingLogin)
  const configWarnings = value.configWarnings.flatMap((candidate) => {
    const warning = parseConfigWarning(candidate)
    return warning ? [warning] : []
  })
  return { accounts, active: { claude: value.active.claude, codex: value.active.codex }, systemDefault, pendingLogin, staleSessions, configWarnings, preferences, revision: value.revision }
}

export function parseUiState(value: unknown): AccountUiState | null {
  if (!isRecord(value) || typeof value.open !== 'boolean') return null
  if (!(value.provider === null || typeof value.provider === 'string') || !(value.settingsSection === null || typeof value.settingsSection === 'string')) return null
  if (!(value.expanded === null || isManagedProvider(value.expanded))) return null
  return { open: value.open, provider: value.provider, expanded: value.expanded, settingsSection: value.settingsSection }
}

function parseCredentialStatus(value: unknown): CredentialStatus | null {
  if (!isRecord(value) || typeof value.provider !== 'string' || typeof value.kind !== 'string' || typeof value.configured !== 'boolean' || typeof value.readable !== 'boolean') return null
  return { provider: value.provider, kind: value.kind, configured: value.configured, readable: value.readable }
}

function eventPayload(event: QuirkyEvent): unknown {
  return 'data' in event ? event.data : undefined
}

function eventRevision(event: QuirkyEvent): number | null {
  const data = eventPayload(event)
  return isRecord(data) && isFiniteNumber(data.revision) ? data.revision : null
}

const INITIAL_UI: AccountUiState = { open: false, provider: null, expanded: null, settingsSection: null }
const INITIAL_AGENT_DETECTION: AgentDetectionState = { status: 'loading', installedProviders: [] }
type WorkspaceFocus =
  | { kind: 'local'; worktreeId: string | null }
  | { kind: 'remote'; mirrorId: string }

const REMOTE_WORKSPACE_VIEW = 'view:quirky.worktree/remote'
const LOCAL_WORKSPACE_VIEW = 'view:quirky.session/worktree'
const OWNER_OPERATION_BY_METHOD: Record<string, OwnerCallOperation> = {
  'quirky.accounts/list': 'list',
  'quirky.accounts/usage': 'usage',
  'quirky.accounts/refresh': 'refresh',
  'quirky.accounts/inactiveUsage': 'inactiveUsage',
  'quirky.accounts/select': 'select',
  'quirky.accounts/credentialStatus': 'credentialStatus',
  'quirky.agents/list': 'agentsList',
  'quirky.agents/refresh': 'agentsRefresh'
}

function workspaceFocusFromView(view: UiLayout['view'] | undefined): WorkspaceFocus | null {
  if (!view) return null
  const input = isRecord(view.input) ? view.input : null
  if (view.id === REMOTE_WORKSPACE_VIEW) {
    return { kind: 'remote', mirrorId: typeof input?.workspace === 'string' ? input.workspace : '' }
  }
  if (view.id === LOCAL_WORKSPACE_VIEW && typeof input?.worktree === 'string' && input.worktree.length > 0) {
    return { kind: 'local', worktreeId: input.worktree }
  }
  return null
}

function workspaceFocusFromLayout(layout: UiLayout, previous: WorkspaceFocus | null): WorkspaceFocus {
  const current = workspaceFocusFromView(layout.view ?? undefined)
  if (current) return current
  if (previous) return previous
  const tabs = layout.viewTabs ?? []
  for (let index = tabs.length - 1; index >= 0; index -= 1) {
    const fromTab = workspaceFocusFromView(tabs[index])
    if (fromTab) return fromTab
  }
  return { kind: 'local', worktreeId: null }
}
function sameWorkspaceFocus(left: WorkspaceFocus, right: WorkspaceFocus): boolean {
  if (left.kind === 'local') return right.kind === 'local'
  return right.kind === 'remote' && left.mirrorId === right.mirrorId
}

export class AccountsUiStore {
  private snapshot: AccountUiSnapshot = {
    scope: { kind: 'local', worktreeId: null },
    accounts: null,
    usage: null,
    ui: INITIAL_UI,
    credentials: [],
    login: null,
    loginStarting: false,
    loginCancelling: false,
    agentDetection: INITIAL_AGENT_DETECTION,
    loading: true,
    refreshing: false,
    error: null
  }
  private readonly listeners = new Set<() => void>()
  private unsubscribe: (() => void) | null = null
  private unsubscribeLayout: (() => void) | null = null
  private workspaceFocus: WorkspaceFocus | null = null
  private lastWorkspaceFocus: WorkspaceFocus | null = null
  private layoutHasWorkspaceFocus = false
  private scopeGeneration = 0
  private localPreferences: Preferences = { ...DEFAULT_PREFERENCES, visibleProviders: [...DEFAULT_PREFERENCES.visibleProviders] }
  private stopped = false
  private accountGeneration = 0
  private usageGeneration = 0
  private usageMismatchReloaded = false
  private credentialGeneration = 0
  private agentDetectionGeneration = 0
  private minimumRevision = 0
  private revisionRetryUsed = false
  private reloadTimer: ReturnType<typeof setTimeout> | null = null
  private fullReloadRequested = false
  private loginTimer: ReturnType<typeof setTimeout> | null = null
  private readonly loginPollsInFlight = new Set<string>()
  private loginGeneration = 0
  private loginStarting = false
  private loginCancelling = false
  private uiQueue: Promise<void> = Promise.resolve()
  private preferencesQueue: Promise<void> = Promise.resolve()
  private readonly resetRequestIds = new Map<string, string>()

  constructor(private readonly context: UiPluginContext) {}

  start(): void {
    if (this.unsubscribe || this.stopped) return
    this.unsubscribe = this.context.subscribe((event) => this.onEvent(event))
    this.unsubscribeLayout = this.context.onLayout((layout) => this.handleLayout(layout))
    this.handleLayout(this.context.getLayout())
  }

  stop(): void {
    this.stopped = true
    this.scopeGeneration += 1
    this.accountGeneration += 1
    this.usageGeneration += 1
    this.credentialGeneration += 1
    this.loginGeneration += 1
    this.agentDetectionGeneration += 1
    this.unsubscribe?.()
    this.unsubscribe = null
    this.unsubscribeLayout?.()
    this.unsubscribeLayout = null
    clearTimeout(this.reloadTimer ?? undefined)
    clearTimeout(this.loginTimer ?? undefined)
    this.reloadTimer = null
    this.loginTimer = null
    this.loginPollsInFlight.clear()
    this.listeners.clear()
  }

  private handleLayout(layout: UiLayout): void {
    if (this.stopped) return
    const visibleWorkspace = workspaceFocusFromView(layout.view ?? undefined)
    const next = workspaceFocusFromLayout(layout, this.lastWorkspaceFocus)
    this.lastWorkspaceFocus = next
    const returnedToWorkspace = visibleWorkspace !== null && !this.layoutHasWorkspaceFocus
    this.layoutHasWorkspaceFocus = visibleWorkspace !== null
    if (this.workspaceFocus && sameWorkspaceFocus(this.workspaceFocus, next) && !returnedToWorkspace) {
      if (next.kind === 'local' && this.workspaceFocus.kind === 'local' && next.worktreeId !== this.workspaceFocus.worktreeId) {
        this.workspaceFocus = next
        this.commit({ scope: { kind: 'local', worktreeId: next.worktreeId } })
      }
      return
    }
    this.workspaceFocus = next
    this.changeWorkspaceFocus(next)
  }

  private changeWorkspaceFocus(focus: WorkspaceFocus): void {
    const generation = ++this.scopeGeneration
    this.accountGeneration += 1
    this.usageGeneration += 1
    this.credentialGeneration += 1
    this.agentDetectionGeneration += 1
    this.loginGeneration += 1
    this.loginStarting = false
    this.loginCancelling = false
    this.loginPollsInFlight.clear()
    clearTimeout(this.reloadTimer ?? undefined)
    clearTimeout(this.loginTimer ?? undefined)
    this.reloadTimer = null
    this.loginTimer = null
    this.fullReloadRequested = false
    this.minimumRevision = 0
    this.revisionRetryUsed = false
    this.usageMismatchReloaded = false
    this.commit({
      scope: focus.kind === 'local'
        ? { kind: 'local', worktreeId: focus.worktreeId }
        : { kind: 'remote', mirrorId: focus.mirrorId, owner: null, workspace: null, hostName: null, status: 'loading', error: null },
      accounts: null,
      usage: null,
      credentials: [],
      login: null,
      loginStarting: false,
      loginCancelling: false,
      agentDetection: INITIAL_AGENT_DETECTION,
      loading: true,
      refreshing: false,
      error: null
    })
    if (focus.kind === 'remote') void this.resolveRemoteFocus(focus, generation)
    else this.loadScopeData()
  }

  private async resolveRemoteFocus(focus: Extract<WorkspaceFocus, { kind: 'remote' }>, generation: number): Promise<void> {
    if (!focus.mirrorId) {
      this.markRemoteUnavailable(focus, generation)
      return
    }
    let mirrorValue: unknown
    try {
      mirrorValue = await this.context.call('quirky.worktree/remoteShow', { workspace: focus.mirrorId })
    } catch {
      this.markRemoteUnavailable(focus, generation)
      return
    }
    if (this.stopped || generation !== this.scopeGeneration) return
    const mirror = isRecord(mirrorValue) ? mirrorValue : null
    const mirrorIdentity = isRecord(mirror?.identity) ? mirror.identity : null
    const worktree = isRecord(mirror?.worktree) ? mirror.worktree : null
    if (
      !mirror || mirror.id !== focus.mirrorId ||
      typeof mirror.hostId !== 'string' || !mirrorIdentity ||
      typeof mirrorIdentity.hostId !== 'string' || typeof mirrorIdentity.generation !== 'string' ||
      !worktree || typeof worktree.id !== 'string' || typeof worktree.instanceId !== 'string' ||
      typeof mirror.fingerprint !== 'string' || typeof mirror.connected !== 'boolean'
    ) {
      this.markRemoteUnavailable(focus, generation)
      return
    }

    let hostValue: unknown
    try {
      hostValue = await this.context.call('quirky.worktree/remoteHostStatus', { host: mirror.hostId })
    } catch {
      this.markRemoteUnavailable(focus, generation)
      return
    }
    if (this.stopped || generation !== this.scopeGeneration) return
    const host = isRecord(hostValue) ? hostValue : null
    const identity = isRecord(host?.identity) ? host.identity : null
    const runtime = isRecord(host?.runtime) ? host.runtime : null
    if (
      !host || !identity || !runtime ||
      typeof host.id !== 'string' || typeof identity.hostId !== 'string' || typeof identity.generation !== 'string' ||
      typeof runtime.id !== 'string' || typeof runtime.name !== 'string' ||
      typeof runtime.endpoint !== 'string' || typeof runtime.grantId !== 'string' ||
      typeof host.connected !== 'boolean'
    ) {
      this.markRemoteUnavailable(focus, generation)
      return
    }
    if (
      mirror.hostId !== mirrorIdentity.hostId ||
      host.id !== mirror.hostId ||
      identity.hostId !== mirror.hostId ||
      identity.hostId !== mirrorIdentity.hostId ||
      identity.generation !== mirrorIdentity.generation
    ) {
      this.markRemoteUnavailable(focus, generation)
      return
    }
    const owner: OwnerSessionHostRef = {
      hostId: identity.hostId,
      identity: { hostId: identity.hostId, generation: identity.generation },
      runtime: { id: runtime.id, endpoint: runtime.endpoint, grantId: runtime.grantId }
    }
    const workspace: OwnerSessionWorkspaceRef = {
      owner,
      mirrorId: mirror.id,
      worktreeId: worktree.id,
      instanceId: worktree.instanceId,
      fingerprint: mirror.fingerprint
    }
    if (mirror.connected !== true || host.connected !== true) {
      this.markRemoteUnavailable(focus, generation, runtime.name, owner, workspace)
      return
    }
    this.commit({
      scope: { kind: 'remote', mirrorId: focus.mirrorId, owner, workspace, hostName: runtime.name, status: 'ready', error: null },
      error: null
    })
    this.loadScopeData()
  }

  private markRemoteUnavailable(
    focus: Extract<WorkspaceFocus, { kind: 'remote' }>,
    generation: number,
    hostName: string | null = null,
    owner: OwnerSessionHostRef | null = null,
    workspace: OwnerSessionWorkspaceRef | null = null
  ): void {
    if (this.stopped || generation !== this.scopeGeneration) return
    this.scopeGeneration += 1
    this.accountGeneration += 1
    this.usageGeneration += 1
    this.credentialGeneration += 1
    this.agentDetectionGeneration += 1
    this.loginGeneration += 1
    this.loginStarting = false
    this.loginCancelling = false
    this.loginPollsInFlight.clear()
    clearTimeout(this.reloadTimer ?? undefined)
    clearTimeout(this.loginTimer ?? undefined)
    this.reloadTimer = null
    this.loginTimer = null
    this.fullReloadRequested = false
    const error = 'The focused remote owner or workspace is unavailable. Local Accounts data was not substituted.'
    this.commit({
      scope: { kind: 'remote', mirrorId: focus.mirrorId, owner, workspace, hostName, status: 'unavailable', error },
      accounts: null,
      usage: null,
      credentials: [],
      login: null,
      loginStarting: false,
      loginCancelling: false,
      agentDetection: { status: 'unavailable', installedProviders: [] },
      loading: false,
      refreshing: false,
      error
    })
  }

  private loadScopeData(): void {
    if (this.stopped) return
    void this.loadAccounts()
    void this.loadUsage()
    void this.loadCredentials()
    void this.loadAgentDetection()
  }

  private scopedCall(
    method: string,
    params: Record<string, unknown> = {},
    scope: AccountWindowScope = this.snapshot.scope
  ): Promise<unknown> {
    if (scope.kind === 'local') return this.context.call(method, params)
    const operation = OWNER_OPERATION_BY_METHOD[method]
    if (!operation) return Promise.reject(new Error('This action is not available for a remote Accounts owner.'))
    if (scope.status !== 'ready' || !scope.owner) {
      return Promise.reject(new Error(scope.error ?? 'The remote Accounts owner is unavailable; no local result was used.'))
    }
    return this.context.call('quirky.accounts/ownerCall', { owner: scope.owner, operation, params })
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): AccountUiSnapshot => this.snapshot

  private commit(change: Partial<AccountUiSnapshot>): void {
    if (this.stopped) return
    this.snapshot = { ...this.snapshot, ...change }
    for (const listener of [...this.listeners]) listener()
  }

  private usageMatchesSelection(usage: UsageState): boolean {
    const accounts = this.snapshot.accounts
    if (!accounts) return true
    return MANAGED_PROVIDERS.every((provider) => {
      const current = usage.providers.find((snapshot) => snapshot.provider === provider)
      return current?.accountId === accounts.active[provider]
    })
  }

  private onEvent(event: QuirkyEvent): void {
    if (this.stopped) return
    const type = event.type
    if (type === 'quirky.agents/changed') {
      if (this.snapshot.scope.kind === 'local') void this.loadAgentDetection()
      return
    }
    if (type === 'quirky.accounts/changed') {
      this.usageMismatchReloaded = false
      if (this.snapshot.scope.kind === 'remote') {
        void this.loadLocalPreferences()
        return
      }
      this.minimumRevision = Math.max(this.minimumRevision, eventRevision(event) ?? 0)
      this.revisionRetryUsed = false
      this.accountGeneration += 1
      this.usageGeneration += 1
      this.scheduleReload()
      return
    }
    if (type === 'quirky.accounts/usageChanged') {
      if (this.snapshot.scope.kind === 'remote') return
      this.usageGeneration += 1
      const usage = parseUsageState(eventPayload(event))
      if (usage && this.usageMatchesSelection(usage)) {
        this.usageMismatchReloaded = false
        this.commit({ usage })
      } else if (!this.usageMismatchReloaded) {
        this.usageMismatchReloaded = true
        this.scheduleUsageReload()
      }
      return
    }
    if (type === 'quirky.accounts/uiStateChanged') {
      const ui = parseUiState(eventPayload(event))
      if (ui) this.commit({ ui })
      else this.scheduleReload()
    }
  }

  private async loadLocalPreferences(): Promise<void> {
    if (this.stopped || this.snapshot.scope.kind !== 'remote') return
    const generation = this.scopeGeneration
    try {
      const value = await this.context.call('quirky.accounts/list', {})
      if (this.stopped || generation !== this.scopeGeneration || this.snapshot.scope.kind !== 'remote') return
      const state = parseAccountState(value)
      if (!state) return
      this.localPreferences = state.preferences
      if (this.snapshot.accounts) {
        this.commit({ accounts: { ...this.snapshot.accounts, preferences: state.preferences } })
      }
    } catch {
      // Local presentation preferences are independent of remote account state.
    }
  }
  private async loadAgentDetection(): Promise<void> {
    const generation = ++this.agentDetectionGeneration
    const scopeGeneration = this.scopeGeneration
    const scope = this.snapshot.scope
    try {
      const value = await this.scopedCall('quirky.agents/list', {}, scope)
      if (this.stopped || generation !== this.agentDetectionGeneration || scopeGeneration !== this.scopeGeneration) return
      this.commit({ agentDetection: parseAgentDetection(value) ?? { status: 'unavailable', installedProviders: [] } })
    } catch {
      if (!this.stopped && generation === this.agentDetectionGeneration && scopeGeneration === this.scopeGeneration) {
        this.commit({ agentDetection: { status: 'unavailable', installedProviders: [] } })
      }
    }
  }

  private scheduleReload(): void {
    this.fullReloadRequested = true
    this.scheduleUsageReload()
  }

  private scheduleUsageReload(): void {
    if (this.reloadTimer !== null || this.stopped) return
    const scopeGeneration = this.scopeGeneration
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null
      if (this.stopped || scopeGeneration !== this.scopeGeneration) return
      const fullReload = this.fullReloadRequested
      this.fullReloadRequested = false
      if (fullReload) {
        void this.loadAccounts()
        void this.loadCredentials()
      }
      void this.loadUsage()
    }, 25)
  }

  async loadAccounts(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.accountGeneration
    const scopeGeneration = this.scopeGeneration
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return
    const [accountResult, preferencesResult, uiResult] = await Promise.allSettled([
      this.scopedCall('quirky.accounts/list', {}, scope),
      scope.kind === 'remote' ? this.context.call('quirky.accounts/list', {}) : Promise.resolve(null),
      this.context.call('quirky.accounts/uiState', {})
    ])
    if (this.stopped || generation !== this.accountGeneration || scopeGeneration !== this.scopeGeneration) return
    if (scope.kind === 'remote' && accountResult.status === 'rejected') {
      this.markRemoteUnavailable({ kind: 'remote', mirrorId: scope.mirrorId }, scopeGeneration, scope.hostName, scope.owner, scope.workspace)
      return
    }
    if (scope.kind === 'remote' && preferencesResult.status === 'fulfilled') {
      const local = parseAccountState(preferencesResult.value)
      if (local) this.localPreferences = local.preferences
    }
    const previousAccounts = this.snapshot.accounts
    let accounts = this.snapshot.accounts
    let ui = this.snapshot.ui
    let failed = accountResult.status === 'rejected'
    if (accountResult.status === 'fulfilled') {
      const parsed = parseAccountState(accountResult.value)
      if (!parsed && scope.kind === 'remote') {
        this.markRemoteUnavailable({ kind: 'remote', mirrorId: scope.mirrorId }, scopeGeneration, scope.hostName, scope.owner, scope.workspace)
        return
      }
      if (parsed) {
        const next = scope.kind === 'remote' ? { ...parsed, preferences: this.localPreferences } : parsed
        if (next.revision >= this.minimumRevision && (!accounts || next.revision >= accounts.revision)) {
          accounts = next
          if (scope.kind === 'local') this.localPreferences = next.preferences
          this.minimumRevision = Math.max(this.minimumRevision, next.revision)
          this.revisionRetryUsed = false
        } else if (next.revision < this.minimumRevision && !this.revisionRetryUsed) {
          this.revisionRetryUsed = true
          this.scheduleReload()
        }
      } else failed = true
    }
    if (uiResult.status === 'fulfilled') ui = parseUiState(uiResult.value) ?? ui
    if (accounts !== this.snapshot.accounts || ui !== this.snapshot.ui) {
      this.commit({
        accounts,
        ui,
        login: accounts?.pendingLogin ?? this.snapshot.login,
        loading: false,
        error: failed
          ? scope.kind === 'remote'
            ? 'Remote Accounts data is unavailable; no local account data was substituted.'
            : 'Account state is temporarily unavailable.'
          : null
      })
      if (accounts !== previousAccounts && this.snapshot.usage && !this.usageMatchesSelection(this.snapshot.usage)) {
        this.usageMismatchReloaded = false
        void this.loadUsage()
      }
    } else if (this.snapshot.accounts === null) {
      this.commit({
        loading: false,
        error: failed ? 'Account state is temporarily unavailable.' : 'Account state could not be read.'
      })
    }
  }

  async loadUsage(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.usageGeneration
    const scopeGeneration = this.scopeGeneration
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return
    try {
      const value = await this.scopedCall('quirky.accounts/usage', {}, scope)
      if (this.stopped || generation !== this.usageGeneration || scopeGeneration !== this.scopeGeneration) return
      const usage = parseUsageState(value)
      if (!usage && scope.kind === 'remote') {
        this.markRemoteUnavailable({ kind: 'remote', mirrorId: scope.mirrorId }, scopeGeneration, scope.hostName, scope.owner, scope.workspace)
        return
      }
      if (usage && this.usageMatchesSelection(usage)) {
        this.usageMismatchReloaded = false
        this.commit({ usage, loading: this.snapshot.accounts === null ? this.snapshot.loading : false, error: null })
      } else if (usage && !this.usageMismatchReloaded) {
        this.usageMismatchReloaded = true
        this.scheduleUsageReload()
      }
    } catch {
      if (this.stopped || generation !== this.usageGeneration || scopeGeneration !== this.scopeGeneration) return
      if (scope.kind === 'remote') {
        this.markRemoteUnavailable({ kind: 'remote', mirrorId: scope.mirrorId }, scopeGeneration, scope.hostName, scope.owner, scope.workspace)
      } else if (this.snapshot.usage === null) this.commit({ loading: false })
    }
  }

  async loadCredentials(): Promise<void> {
    if (this.stopped) return
    const generation = ++this.credentialGeneration
    const scopeGeneration = this.scopeGeneration
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return
    try {
      const value = await this.scopedCall('quirky.accounts/credentialStatus', {}, scope)
      if (this.stopped || generation !== this.credentialGeneration || scopeGeneration !== this.scopeGeneration || !Array.isArray(value)) return
      this.commit({ credentials: value.flatMap((candidate) => {
        const status = parseCredentialStatus(candidate)
        return status ? [status] : []
      }) })
    } catch {
      // Credential status is optional; preserve account and usage data.
    }
  }

  notify(title: string, body: string): void {
    this.context.toast(title, body)
  }

  private async act(title: string, method: string, params: Record<string, unknown>, errorCopy?: (error: unknown) => string | null): Promise<unknown | null> {
    try {
      return await this.context.call(method, params)
    } catch (error) {
      this.context.toast(title, errorCopy?.(error) ?? 'The request could not be completed. Please try again.')
      return null
    }
  }

  private async scopedAct(
    title: string,
    method: string,
    params: Record<string, unknown>,
    errorCopy?: (error: unknown) => string | null,
    scope: AccountWindowScope = this.snapshot.scope
  ): Promise<unknown | null> {
    const scopeGeneration = this.scopeGeneration
    try {
      return await this.scopedCall(method, params, scope)
    } catch (error) {
      if (scope.kind === 'remote') {
        this.markRemoteUnavailable(
          { kind: 'remote', mirrorId: scope.mirrorId },
          scopeGeneration,
          scope.hostName,
          scope.owner,
          scope.workspace
        )
      }
      this.context.toast(title, errorCopy?.(error) ?? 'The request could not be completed. Please try again.')
      return null
    }
  }
  private applyAccountResult(value: unknown, generation: number): AccountState | null {
    if (this.stopped || generation !== this.accountGeneration) return null
    const parsed = parseAccountState(value)
    if (!parsed) {
      void this.loadAccounts()
      return null
    }
    const state = this.snapshot.scope.kind === 'remote'
      ? { ...parsed, preferences: this.localPreferences }
      : parsed
    if (state.revision < this.minimumRevision || (this.snapshot.accounts && state.revision < this.snapshot.accounts.revision)) {
      void this.loadAccounts()
      return null
    }
    if (this.snapshot.scope.kind === 'local') this.localPreferences = state.preferences
    this.minimumRevision = Math.max(this.minimumRevision, state.revision)
    this.usageMismatchReloaded = false
    this.commit({ accounts: state, login: state.pendingLogin ?? this.snapshot.login, loading: false, error: null })
    return state
  }

  async setUiState(patch: Partial<AccountUiState>): Promise<void> {
    this.uiQueue = this.uiQueue.then(async () => {
      if (this.stopped) return
      const result = await this.act('Could not update Usage', 'quirky.accounts/setUiState', { ...patch })
      if (result === null) return
      const ui = parseUiState(result)
      if (ui) this.commit({ ui })
      else this.commit({ ui: { ...this.snapshot.ui, ...patch } })
    })
    await this.uiQueue
  }

  async openSettingsSection(section: string): Promise<void> {
    await this.setUiState({ open: false, provider: null, settingsSection: section })
    this.context.openView(SETTINGS_VIEW_ID)
  }

  async setPreferences(patch: Partial<Preferences>): Promise<void> {
    this.preferencesQueue = this.preferencesQueue.then(async () => {
      if (this.stopped) return
      const generation = ++this.accountGeneration
      const result = await this.act('Could not save account preferences', 'quirky.accounts/setPreferences', { ...patch })
      if (result === null) return
      const state = parseAccountState(result)
      if (state) {
        this.localPreferences = state.preferences
        if (this.snapshot.scope.kind === 'remote') {
          if (this.snapshot.accounts) {
            this.commit({ accounts: { ...this.snapshot.accounts, preferences: state.preferences } })
          } else void this.loadAccounts()
        } else if (generation === this.accountGeneration) this.applyAccountResult(state, generation)
        else void this.loadAccounts()
        return
      }
      if (generation !== this.accountGeneration) {
        void this.loadAccounts()
        return
      }
      const preferences = parsePreferences(isRecord(result) && 'preferences' in result ? result.preferences : result)
      if (preferences) {
        this.localPreferences = preferences
        if (this.snapshot.accounts) this.commit({ accounts: { ...this.snapshot.accounts, preferences } })
        else void this.loadAccounts()
      } else void this.loadAccounts()
    })
    await this.preferencesQueue
  }

  async selectAccount(provider: ManagedProvider, accountId: string | null): Promise<void> {
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return
    const generation = ++this.accountGeneration
    this.usageGeneration += 1
    const result = await this.scopedAct('Could not switch accounts', 'quirky.accounts/select', { provider, accountId }, undefined, scope)
    if (result === null) return
    const selected = this.applyAccountResult(result, generation)
    if (!selected && generation !== this.accountGeneration) await this.loadAccounts()
    const state = selected ?? this.snapshot.accounts
    if (!state) return
    void this.loadUsage()
    if (scope.kind === 'local' && provider === 'claude' && state.active.claude === accountId && state.preferences.claudeSwitchPolicy === 'always') {
      await this.restartGroups(state.staleSessions.filter((session) => session.provider === 'claude' && session.selectedId === accountId && !session.queued && !session.kept), true)
    }
  }

  async removeAccount(provider: ManagedProvider, accountId: string): Promise<void> {
    if (this.snapshot.scope.kind === 'remote') return
    const account = this.snapshot.accounts?.accounts.find((candidate) => candidate.provider === provider && candidate.id === accountId)
    const providerName = provider === 'claude' ? 'Claude' : 'Codex'
    const body = provider === 'claude'
      ? "Quirky deletes this account's Claude folder and its sign-in from this computer. Chat history shared with System default stays. If it is selected, the next Claude you start uses System default."
      : 'Removing this account permanently deletes its managed Codex home, including all Codex session history and MCP logins stored inside. This cannot be undone. If the account is currently active, Quirky falls back to the system default Codex login.'
    const confirmed = await this.context.confirm({ title: `Remove ${providerName} Account?`, body, confirmLabel: 'Remove Account' })
    if (!confirmed || !account) return
    const generation = ++this.accountGeneration
    const result = await this.act(`Could not remove ${providerName} account`, 'quirky.accounts/remove', { provider, accountId, yes: true })
    if (result !== null) {
      this.applyAccountResult(result, generation)
      void this.loadUsage()
    }
  }

  async beginLogin(provider: ManagedProvider, options: { label?: string; accountId?: string; copyLink?: boolean } = {}): Promise<void> {
    if (this.snapshot.scope.kind === 'remote' || this.loginStarting || this.snapshot.login?.status === 'pending') return
    this.loginStarting = true
    this.commit({ loginStarting: true })
    try {
      this.loginGeneration += 1
      const generation = this.loginGeneration
      const params = { provider, ...options }
      const result = await this.act(`Could not start ${provider === 'claude' ? 'Claude' : 'Codex'} sign-in`, 'quirky.accounts/beginLogin', params)
      if (result === null || generation !== this.loginGeneration) return
      const id = isRecord(result) && typeof result.id === 'string' ? result.id : typeof result === 'string' ? result : null
      if (!id) {
        this.context.toast('Could not start sign-in', 'The sign-in request did not return a session ID.')
        return
      }
      const accountId = options.accountId ?? null
      const pending: PendingLogin = { id, provider, accountId, status: 'pending', url: null, error: null, result: null }
      this.commit({ login: pending })
      void this.pollLogin(pending, generation)
    } finally {
      this.loginStarting = false
      this.commit({ loginStarting: false })
    }
  }

  private scheduleLoginPoll(pending: PendingLogin, generation: number): void {
    if (this.snapshot.scope.kind === 'remote' || this.stopped || generation !== this.loginGeneration || this.loginTimer !== null || this.loginPollsInFlight.has(pending.id)) return
    const current = this.snapshot.login
    if (!current || current.id !== pending.id || current.status !== 'pending') return
    this.loginTimer = setTimeout(() => {
      this.loginTimer = null
      void this.pollLogin(pending, generation)
    }, 900)
  }

  private async pollLogin(previous: PendingLogin, generation: number): Promise<void> {
    if (this.snapshot.scope.kind === 'remote' || this.stopped || generation !== this.loginGeneration) return
    if (this.loginPollsInFlight.has(previous.id)) return
    const current = this.snapshot.login
    if (!current || current.id !== previous.id || current.status !== 'pending') return
    if (this.loginTimer !== null) {
      clearTimeout(this.loginTimer)
      this.loginTimer = null
    }
    this.loginPollsInFlight.add(previous.id)
    let next = previous
    try {
      const value = await this.context.call('quirky.accounts/loginStatus', { id: previous.id })
      const current = this.snapshot.login
      if (!this.stopped && generation === this.loginGeneration && current && current.id === previous.id && current.status === 'pending') {
        const updated = parsePendingLogin({ ...previous, ...(isRecord(value) ? value : {}) })
        if (updated) {
          this.commit({ login: updated })
          if (updated.status === 'complete') {
            this.commit({ login: null })
            void this.loadAccounts()
            void this.loadUsage()
            return
          }
          if (updated.status === 'error' || updated.status === 'cancelled') return
          next = updated
        }
      }
    } catch {
      // Retry the status read while the native sign-in remains active.
    } finally {
      this.loginPollsInFlight.delete(previous.id)
    }
    if (this.stopped) return
    const latest = this.snapshot.login
    if (generation !== this.loginGeneration || !latest || latest.id !== previous.id) {
      if (latest?.status === 'pending' && (latest.id !== previous.id || !this.loginStarting)) void this.pollLogin(latest, this.loginGeneration)
      return
    }
    if (latest.status !== 'pending') return
    this.scheduleLoginPoll(next, generation)
  }

  async cancelLogin(): Promise<void> {
    if (this.snapshot.scope.kind === 'remote') return
    const pending = this.snapshot.login
    if (!pending || this.loginCancelling) return
    this.loginCancelling = true
    this.commit({ loginCancelling: true })
    const generation = this.loginGeneration
    clearTimeout(this.loginTimer ?? undefined)
    this.loginTimer = null
    try {
      const result = await this.act('Could not cancel sign-in', 'quirky.accounts/cancelLogin', { id: pending.id })
      if (result !== null && generation === this.loginGeneration && this.snapshot.login?.id === pending.id) {
        this.loginGeneration += 1
        clearTimeout(this.loginTimer ?? undefined)
        this.loginTimer = null
        this.commit({ login: null })
        void this.loadAccounts()
      } else if (result === null && generation === this.loginGeneration) {
        const current = this.snapshot.login
        if (current?.id === pending.id && current.status === 'pending') this.scheduleLoginPoll(current, generation)
      }
    } finally {
      this.loginCancelling = false
      this.commit({ loginCancelling: false })
    }
  }


  async refresh(provider?: string): Promise<void> {
    if (this.snapshot.refreshing) return
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') {
      if (scope.status === 'unavailable' && this.workspaceFocus?.kind === 'remote') {
        this.changeWorkspaceFocus(this.workspaceFocus)
      }
      return
    }
    const scopeGeneration = this.scopeGeneration
    const generation = ++this.usageGeneration
    const detectionGeneration = provider ? null : ++this.agentDetectionGeneration
    this.commit({ refreshing: true })
    const jobs: Promise<unknown>[] = [Promise.resolve().then(() => this.scopedCall(
      'quirky.accounts/refresh',
      { ...(provider ? { provider } : {}), force: true },
      scope
    ))]
    if (!provider) jobs.push(Promise.resolve().then(() => this.scopedCall('quirky.agents/refresh', {}, scope)))
    const results = await Promise.allSettled(jobs)
    if (this.stopped || scopeGeneration !== this.scopeGeneration) return
    let detectionFailed = false
    if (!provider && detectionGeneration === this.agentDetectionGeneration) {
      const detectionResult = results[1]
      const detection = detectionResult?.status === 'fulfilled' ? parseAgentDetection(detectionResult.value) : null
      if (detection) this.commit({ agentDetection: detection })
      else {
        this.commit({ agentDetection: { status: 'unavailable', installedProviders: [] } })
        detectionFailed = true
      }
    }
    if (generation !== this.usageGeneration) {
      this.commit({ refreshing: false })
      if (detectionFailed) this.context.toast('Could not re-detect agents', 'Agent detection could not be refreshed.')
      return
    }
    const usageResult = results[0]
    if (usageResult?.status === 'fulfilled') {
      const usage = parseUsageState(usageResult.value)
      if (usage && this.usageMatchesSelection(usage)) {
        this.usageMismatchReloaded = false
        this.commit({ usage })
      } else if (usage) this.scheduleUsageReload()
      else void this.loadUsage()
    } else {
      this.context.toast('Could not refresh usage', 'The request could not be completed. Please try again.')
      if (scope.kind === 'remote') {
        this.markRemoteUnavailable(
          { kind: 'remote', mirrorId: scope.mirrorId },
          scopeGeneration,
          scope.hostName,
          scope.owner,
          scope.workspace
        )
      }
    }
    if (detectionFailed) this.context.toast('Could not re-detect agents', 'Agent detection could not be refreshed.')
    this.commit({ refreshing: false })
  }

  async inactiveUsage(provider: ManagedProvider): Promise<void> {
    const scope = this.snapshot.scope
    if (scope.kind === 'remote' && scope.status !== 'ready') return
    const generation = ++this.usageGeneration
    const scopeGeneration = this.scopeGeneration
    const result = await this.scopedAct('Could not load inactive account usage', 'quirky.accounts/inactiveUsage', { provider }, undefined, scope)
    if (result === null || this.stopped || generation !== this.usageGeneration || scopeGeneration !== this.scopeGeneration) return
    const usage = parseUsageState(result)
    if (usage && this.usageMatchesSelection(usage)) {
      this.usageMismatchReloaded = false
      this.commit({ usage })
    } else if (usage) this.scheduleUsageReload()
  }

  async restart(sessions: string[], selectionRevision: number, yes = false): Promise<SessionActionResult> {
    if (this.snapshot.scope.kind === 'remote') return 'failed'
    const generation = ++this.accountGeneration
    let selectionChanged = false
    const result = await this.act('Could not restart sessions', 'quirky.accounts/restart', { sessions, selectionRevision, ...(yes ? { yes: true } : {}) }, (error) => {
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : ''
      if (message !== 'The selected account changed. Refresh the account state and choose again.' && message !== 'A requested session is no longer stale at this account revision.') return null
      selectionChanged = true
      return message
    })
    if (result === null) {
      if (selectionChanged) void this.loadAccounts()
      return selectionChanged ? 'selection-changed' : 'failed'
    }
    // A successful RPC stays successful when a newer account event supersedes its snapshot.
    this.applyAccountResult(result, generation)
    return 'applied'
  }

  async keep(sessions: string[], selectionRevision: number): Promise<SessionActionResult> {
    if (this.snapshot.scope.kind === 'remote') return 'failed'
    const generation = ++this.accountGeneration
    let selectionChanged = false
    const result = await this.act('Could not keep the current account', 'quirky.accounts/keep', { sessions, selectionRevision }, (error) => {
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : ''
      if (message !== 'The selected account changed. Refresh the account state and choose again.' && message !== 'A requested session is no longer stale at this account revision.') return null
      selectionChanged = true
      return message
    })
    if (result === null) {
      if (selectionChanged) void this.loadAccounts()
      return selectionChanged ? 'selection-changed' : 'failed'
    }
    this.applyAccountResult(result, generation)
    return 'applied'
  }

  private async restartGroups(sessions: StaleSession[], yes: boolean): Promise<void> {
    const groups = new Map<number, string[]>()
    for (const session of sessions) {
      if (session.kept) continue
      groups.set(session.selectionRevision, [...(groups.get(session.selectionRevision) ?? []), session.sessionId])
    }
    for (const [selectionRevision, ids] of groups) await this.restart(ids, selectionRevision, yes)
  }

  async setCredential(provider: string, kind: string, value: string): Promise<boolean> {
    if (this.snapshot.scope.kind === 'remote') return false
    if (!value) return false
    const result = await this.act('Could not save provider credential', 'quirky.accounts/setCredential', { provider, kind, value })
    if (result === null) return false
    const status = parseCredentialStatus(result)
    if (status) this.updateCredential(status)
    else void this.loadCredentials()
    await this.refresh(provider)
    return true
  }

  async clearCredential(provider: string, kind: string): Promise<boolean> {
    if (this.snapshot.scope.kind === 'remote') return false
    const result = await this.act('Could not clear provider credential', 'quirky.accounts/clearCredential', { provider, kind })
    if (result === null) return false
    const status = parseCredentialStatus(result)
    if (status) this.updateCredential(status)
    else void this.loadCredentials()
    await this.refresh(provider)
    return true
  }

  private updateCredential(status: CredentialStatus): void {
    const next = this.snapshot.credentials.filter((item) => item.provider !== status.provider || item.kind !== status.kind)
    this.commit({ credentials: [...next, status] })
  }

  resetRequestId(expectedScope: ResetExpectedScope): string {
    const key = JSON.stringify([expectedScope.accountId, expectedScope.accountRevision, expectedScope.offerRevision])
    const previous = this.resetRequestIds.get(key)
    if (previous) return previous
    const id = crypto.randomUUID()
    this.resetRequestIds.set(key, id)
    return id
  }

  async consumeResetCredit(idempotencyKey: string, expectedScope: ResetExpectedScope): Promise<ResetCreditResult> {
    if (this.snapshot.scope.kind === 'remote') return 'failed'
    let scopeChanged = false
    const result = await this.act('Could not reset Codex limits', 'quirky.accounts/consumeResetCredit', { idempotencyKey, expectedScope, yes: true }, (error) => {
      const message = isRecord(error) && typeof error.message === 'string' ? error.message : ''
      if (message !== 'Codex reset offer is no longer current' && message !== 'Codex reset offer changed; refresh usage and confirm again') return null
      scopeChanged = true
      return message
    })
    if (result === null) {
      if (scopeChanged) void this.loadUsage()
      return scopeChanged ? 'scope-changed' : 'failed'
    }
    const reply = isRecord(result) ? result : null
    const outcome = reply?.outcome
    const returnedState = reply ? parseUsageState(reply.state) : null
    if (
      !returnedState ||
      outcome !== 'reset' && outcome !== 'alreadyRedeemed' && outcome !== 'nothingToReset' && outcome !== 'noCredit'
    ) {
      this.context.toast('Could not reset Codex limits', 'The accounts service returned an unrecognized reset outcome.')
      return 'failed'
    }
    void this.loadUsage()
    return outcome
  }
}

export function maxUsed(snapshot: ProviderSnapshot | null | undefined): number | null {
  if (!snapshot) return null
  const values = [snapshot.session, snapshot.weekly, snapshot.monthly, snapshot.fableWeekly, ...(snapshot.buckets ?? [])]
    .flatMap((window) => window ? [window.usedPercent] : [])
  return values.length ? Math.max(...values) : null
}

export function isCurrentSnapshot(snapshot: ProviderSnapshot, state: AccountState | null): boolean {
  if (!state || (snapshot.provider !== 'claude' && snapshot.provider !== 'codex')) return true
  return snapshot.accountId === state.active[snapshot.provider]
}

export function isConfigured(snapshot: ProviderSnapshot | undefined, state: AccountState | null, credentials: CredentialStatus[]): boolean {
  if (!snapshot || !isCurrentSnapshot(snapshot, state)) return false
  if (snapshot.session || snapshot.weekly || snapshot.monthly || snapshot.fableWeekly || snapshot.extraUsage || (snapshot.buckets?.length ?? 0) > 0 || snapshot.accountId) return true
  if (snapshot.status === 'ok' || snapshot.status === 'error') return true
  if ((snapshot.provider === 'claude' || snapshot.provider === 'codex') && state) {
    const provider = snapshot.provider
    if (state.systemDefault[provider].hasAuth || state.accounts.some((account) => account.provider === provider && !account.needsSignIn)) return true
  }
  return credentials.some((status) => status.provider === snapshot.provider && status.configured)
}
export function canShowProviderVisibility(provider: ProviderId, detection: AgentDetectionState): boolean {
  return !AGENT_GATED_PROVIDERS.includes(provider) || (detection.status === 'ready' && detection.installedProviders.includes(provider))
}

export function displayPercent(usedPercent: number, direction: UsageDirection): number {
  const used = Math.round(Math.max(0, Math.min(100, usedPercent)))
  return direction === 'remaining' ? 100 - used : used
}

export function windowEntries(snapshot: ProviderSnapshot): { name: string; window: WindowData }[] {
  return [
    ...(snapshot.session ? [{ name: '5h', window: snapshot.session }] : []),
    ...(snapshot.weekly ? [{ name: '7d', window: snapshot.weekly }] : []),
    ...(snapshot.fableWeekly ? [{ name: 'Fable', window: snapshot.fableWeekly }] : []),
    ...(snapshot.monthly ? [{ name: '30d', window: snapshot.monthly }] : []),
    ...(snapshot.buckets ?? []).map((bucket) => ({ name: bucket.name, window: bucket }))
  ]
}

export function compactWindow(snapshot: ProviderSnapshot): { name: string; window: WindowData } | null {
  const windows = windowEntries(snapshot)
  return windows.reduce<{ name: string; window: WindowData } | null>((best, current) => !best || current.window.usedPercent > best.window.usedPercent ? current : best, null)
}

export function formatReset(window: WindowData): string {
  if (window.resetsAt !== null) {
    const remaining = Math.max(0, window.resetsAt - Date.now())
    if (remaining < 60_000) return 'now'
    const minutes = Math.ceil(remaining / 60_000)
    if (minutes < 60) return `${minutes}m`
    const hours = Math.floor(minutes / 60)
    const rest = minutes % 60
    if (hours < 24) return rest ? `${hours}h ${rest}m` : `${hours}h`
    const days = Math.floor(hours / 24)
    return `${days}d ${hours % 24}h`
  }
  return window.resetDescription ?? 'reset time unavailable'
}

export function ageLabel(updatedAt: number): string {
  if (!updatedAt) return 'Not refreshed yet'
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt) / 60_000))
  if (minutes < 1) return 'Updated just now'
  if (minutes < 60) return `Updated ${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `Updated ${hours}h ago`
  return `Updated ${Math.floor(hours / 24)}d ago`
}

const FAILURE_COPY: Record<string, string> = {
  'missing-credentials': 'Not signed in', 'stale-token': 'Sign-in expired', 'refreshable-credentials-without-token': 'Refresh when this provider runs',
  'delegated-refresh-required': 'Sign in with this provider', 'keychain-unavailable': 'Keychain unavailable', 'missing-scope': 'Sign in again',
  'no-subscription': 'No subscription', network: 'Network issue', server: 'Provider issue', parse: 'Usage could not be read',
  'rate-limited': 'Rate limited', 'cli-unavailable': 'Run the provider to refresh', 'usage-unavailable': 'Usage unavailable',
  'deferred-by-live-session': 'Updates when Claude runs', unknown: 'Refresh failed'
}

export function snapshotStatus(snapshot: ProviderSnapshot): { label: string; kind: 'ready' | 'muted' | 'warning' | 'danger' | 'loading'; signedOut: boolean } {
  const failure = snapshot.usageMetadata?.failureKind
  const errorText = snapshot.error?.toLowerCase() ?? ''
  const signedOut = failure === 'missing-credentials' || errorText.includes('not signed in') || errorText.includes('signed out')
  if (snapshot.status === 'fetching') return { label: windowEntries(snapshot).length ? 'Refreshing' : 'Fetching', kind: 'loading', signedOut: false }
  if (snapshot.status === 'idle') return { label: 'Waiting for usage', kind: 'loading', signedOut: false }
  if (snapshot.status === 'unavailable') return { label: signedOut ? 'Not signed in' : FAILURE_COPY[failure ?? ''] ?? 'Unavailable', kind: 'muted', signedOut }
  if (snapshot.status === 'error') return { label: FAILURE_COPY[failure ?? ''] ?? 'Refresh failed', kind: 'warning', signedOut }
  const hasWindows = windowEntries(snapshot).length > 0
  return { label: hasWindows ? 'Up to date' : snapshot.extraUsage ? 'Balance available' : 'No usage windows reported', kind: hasWindows ? 'ready' : 'muted', signedOut: false }
}

export function providerSource(snapshot: ProviderSnapshot | undefined): string | null {
  const source = snapshot?.usageMetadata?.credentialSource
  if (!source) return null
  const names: Record<string, string> = {
    keychain: 'macOS Keychain', 'macos-keychain': 'macOS Keychain', 'cursor-agent': 'Cursor CLI',
    cli: 'Provider CLI', ide: 'IDE sign-in', desktop: 'IDE sign-in', file: 'Local sign-in file', oauth: 'OAuth sign-in', 'live-session': 'Live session'
  }
  return names[source] ?? 'Provider sign-in'
}

export function accountSort(a: AccountSummary, b: AccountSummary): number {
  return b.updatedAt - a.updatedAt || a.label.localeCompare(b.label)
}

export function displayIdentity(account: Pick<SystemAccount, 'email' | 'authKind' | 'hasAuth'>): string {
  if (!account.hasAuth) return 'Not signed in'
  return `${account.authKind === 'api-key' ? 'API-key authentication' : account.authKind === 'oauth' ? 'OAuth sign-in' : 'Authentication detected'}${account.email ? ` · ${account.email}` : ''}`
}


export function credentialLabel(kind: string): string {
  const labels: Record<string, string> = { 'api-key': 'API key', cookie: 'Cookie', 'group-id': 'Group ID', 'base-url': 'Base URL', model: 'Model' }
  return labels[kind] ?? kind
}
