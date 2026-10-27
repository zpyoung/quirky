import { randomUUID } from 'node:crypto'
import { isAbsolute, join, resolve } from 'node:path'
import type { PluginContext, PluginStore, QuirkyEvent } from '@quirky/protocol'
import type {
  AccountSummary,
  AccountPrepareResult,
  AccountIdentity,
  AccountRecord,
  AccountSessionRecord,
  AccountState,
  AccountUiState,
  ConfigWarning,
  ManagedProvider,
  PendingLogin,
  Preferences,
  PrepareInput,
  StaleSession,
  SystemAccount
} from './types'
import { DEFAULT_PREFERENCES, DEFAULT_UI_STATE, MANAGED_ID_RE } from './types'
import {
  AccountProfiles,
  isProviderAuth,
  isSameIdentity,
  type CodexConfigSyncResult,
  type ProviderIdentity
} from './profiles'
import {
  getAccount,
  getActiveAccountId,
  getRevision,
  getSessionRecord,
  incrementRevision,
  listAccountRecords,
  listSessionRecords,
  readPreferences,
  writePreferences
} from './store'
import { AccountRouting } from './routing'
import { AccountLoginManager, type LoginCompletion, type LoginRequest } from './login'
import { restartSession, sessionBusy, sessionIsAlive, type RestartOutcome, type SessionView } from './restarts'
import { CodexHistoryError, prepareCodexHistoryResume, type CodexResumeMetadata } from './codex-history'
import type { CredentialStatus, UsageService, UsageState, UsageTarget } from './usage'

type ResetCreditScope = { accountId: string | null; accountRevision: number; offerRevision: string }
type ResetCreditInput = { idempotencyKey: string; expectedScope: ResetCreditScope; yes?: boolean }
type CredentialInput = { provider: string; kind: string; value: string }
type CredentialClearInput = { provider: string; kind: string }
const MANAGED_PROVIDERS: readonly ManagedProvider[] = ['claude', 'codex']
const USAGE_PROVIDERS = ['claude', 'codex', 'gemini', 'antigravity', 'opencode-go', 'kimi', 'minimax', 'grok', 'cursor', 'zcode'] as const
const USAGE_LABELS: Record<(typeof USAGE_PROVIDERS)[number], string> = {
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  antigravity: 'Antigravity',
  'opencode-go': 'OpenCode Go',
  kimi: 'Kimi',
  minimax: 'MiniMax',
  grok: 'Grok',
  cursor: 'Cursor',
  zcode: 'ZCode'
}
const MAX_ACCOUNT_LABEL = 100
const MAX_SESSION_ID = 256

export class AccountService {
  readonly profiles: AccountProfiles
  readonly routing: AccountRouting
  private readonly login: AccountLoginManager
  private usageService: UsageService | null = null
  private readonly ui: AccountUiState = { ...DEFAULT_UI_STATE }
  private pendingLoginId: string | null = null
  private readonly configWarnings: ConfigWarning[] = []
  private mutationTail: Promise<void> = Promise.resolve()
  private userMutationGeneration = 0
  private inlineLoginFinalizationDepth = 0
  private readonly pendingUsageWork = new Set<Promise<unknown>>()
  private active = false

  constructor(private readonly context: PluginContext, private readonly store: PluginStore) {
    this.profiles = new AccountProfiles(context.dataDir)
    this.routing = new AccountRouting(context.dataDir, this.profiles)
    this.login = new AccountLoginManager(
      this.profiles,
      (completion) => this.finishLogin(completion),
      () => this.publishChanged()
    )
  }

  attachUsageService(service: UsageService): void {
    if (this.usageService !== null) throw new Error('UsageService has already been attached.')
    this.usageService = service
  }

  start(): void {
    if (this.active) return
    this.active = true
    for (const provider of MANAGED_PROVIDERS) {
      const accountId = getActiveAccountId(this.store, provider)
      if (accountId === null) {
        this.routing.writePointer(provider, null)
        continue
      }
      try {
        this.routing.writePointer(provider, accountId)
      } catch {
        this.routing.writeInvalidPointer(provider)
        continue
      }
      if (provider === 'codex') this.syncCodexConfigWarning(accountId)
    }
  }

  async shutdown(): Promise<void> {
    this.active = false
    await this.mutationTail
    await this.login.shutdown()
    this.usageService?.shutdown()
    await Promise.allSettled([...this.pendingUsageWork])
  }

  async list(params: Record<string, unknown> = {}): Promise<AccountState> {
    const provider = params.provider === undefined ? undefined : this.readManagedProvider(params.provider)
    return this.buildState(provider)
  }

  usage(): UsageState {
    return this.requireUsage().state()
  }

  async refresh(params: Record<string, unknown> = {}): Promise<UsageState> {
    this.requireActive()
    const provider = params.provider === undefined ? undefined : this.readUsageProvider(params.provider)
    const force = params.force === undefined ? false : this.readBoolean(params.force, 'force')
    const state = await this.trackUsage(this.requireUsage().refresh({ ...(provider === undefined ? {} : { provider }), force }))
    this.emitIfActive('usageChanged', state)
    return state
  }

  async inactiveUsage(params: Record<string, unknown>): Promise<UsageState> {
    const provider = this.readManagedProvider(params.provider)
    return this.trackUsage(this.requireUsage().inactive(provider))
  }

  async beginLogin(params: Record<string, unknown>): Promise<PendingLogin> {
    const mutationGeneration = ++this.userMutationGeneration
    await this.login.supersedePending()
    return this.serialize(async () => {
      this.requireActive()
      await this.supersedeLoginsWithinMutation()
      const provider = this.readManagedProvider(params.provider)
      const accountIdValue = params.accountId
      const accountId = accountIdValue === undefined ? randomUUID() : this.readId(accountIdValue)
      const reauthenticating = accountIdValue !== undefined
      const inputLabel = params.label === undefined ? null : this.readAccountLabel(params.label)
      const copyLink = params.copyLink === undefined ? false : this.readBoolean(params.copyLink, 'copyLink')
      let home: string
      if (reauthenticating) {
        const saved = getAccount(this.store, accountId)
        if (!saved || saved.provider !== provider) this.fail('not-found', 'The managed account was not found for this provider.')
        try {
          home = this.profiles.ensureOwned(provider, accountId)
        } catch {
          this.fail('conflict', 'The managed account home is missing or untrusted. It was not changed.')
        }
      } else {
        if (provider === 'codex') {
          try {
            this.profiles.assertCodexOAuthAllowed()
          } catch (error) {
            this.fail('conflict', safeMessage(error, 'Codex OAuth account setup was not started because its configuration could not be verified.'))
          }
        }
        try {
          home = await this.profiles.create(provider, accountId)
        } catch (error) {
          this.fail('conflict', safeMessage(error, 'The private account home could not be prepared.'))
        }
      }
      if (!this.active) {
        if (!reauthenticating) this.removeFailedProfile(provider, accountId)
        this.fail('conflict', 'The accounts plugin is shutting down.')
      }
      const request: LoginRequest = {
        provider,
        accountId,
        home,
        label: inputLabel,
        copyLink,
        reauthenticating,
        mutationGeneration
      }
      const pending = this.login.begin(request)
      this.pendingLoginId = pending.id
      this.publishChanged()
      return pending
    })
  }

  loginStatus(params: Record<string, unknown>): PendingLogin {
    const id = this.readNonempty(params.id, 'id')
    const pending = this.login.status(id)
    if (!pending) this.fail('not-found', 'The sign-in request was not found.')
    return pending
  }

  async cancelLogin(params: Record<string, unknown>): Promise<PendingLogin> {
    const id = this.readNonempty(params.id, 'id')
    const pending = await this.login.cancel(id)
    if (!pending) this.fail('not-found', 'The sign-in request was not found.')
    this.publishChanged()
    return pending
  }

  async select(params: Record<string, unknown>): Promise<AccountState> {
    this.userMutationGeneration += 1
    await this.login.supersedePending()
    return this.serialize(async () => {
      this.requireActive()
      await this.supersedeLoginsWithinMutation()
      const provider = this.readManagedProvider(params.provider)
      const accountId = params.accountId === null ? null : this.readId(params.accountId)
      if (accountId !== null) this.verifySelectableAccount(provider, accountId)
      const previousId = getActiveAccountId(this.store, provider)
      if (previousId === accountId) {
        if (provider === 'codex' && accountId !== null) this.syncCodexConfigWarning(accountId)
        return this.buildState()
      }
      const previousPointer = this.routing.readPointerContents(provider)
      let revision: number
      try {
        revision = this.store.transaction(() => {
          this.store.run(
            'INSERT INTO active_accounts(provider, account_id) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id',
            provider,
            accountId
          )
          this.store.run('UPDATE account_sessions SET kept = 0, error = NULL WHERE provider = ?', provider)
          this.store.run('DELETE FROM restart_intentions WHERE session_id IN (SELECT session_id FROM account_sessions WHERE provider = ?)', provider)
          const nextRevision = incrementRevision(this.store)
          this.routing.writePointer(provider, accountId)
          return nextRevision
        })
      } catch {
        try {
          this.routing.restorePointerContents(provider, previousPointer)
        } catch {
          this.routing.writeInvalidPointer(provider)
        }
        this.fail('conflict', 'Account selection could not be committed safely. The previous selection remains authoritative.')
      }
      if (provider === 'codex' && accountId !== null) this.syncCodexConfigWarning(accountId, false)
      this.publishChanged()
      if (provider === 'claude' && readPreferences(this.store).claudeSwitchPolicy === 'always') {
        await this.restartAllClaude(revision)
      }
      void this.refreshAfterMutation(provider)
      return this.buildState()
    })
  }

  async remove(params: Record<string, unknown>): Promise<AccountState> {
    this.userMutationGeneration += 1
    await this.login.supersedePending()
    return this.serialize(async () => {
      this.requireActive()
      await this.supersedeLoginsWithinMutation()
      const provider = this.readManagedProvider(params.provider)
      const accountId = this.readId(params.accountId)
      const yes = params.yes === undefined ? false : this.readBoolean(params.yes, 'yes')
      void yes
      const account = getAccount(this.store, accountId)
      if (!account || account.provider !== provider) this.fail('not-found', 'The managed account was not found for this provider.')
      if (getActiveAccountId(this.store, provider) === accountId) {
        this.commitSelection(provider, null)
        this.publishChanged()
        void this.refreshAfterMutation(provider)
      }
      if (await this.hasRunningSession(accountId)) {
        this.fail('conflict', 'This account is still used by a running session. Close or restart that session before removing the account.')
      }
      try {
        this.profiles.remove(provider, accountId)
      } catch (error) {
        this.fail('conflict', safeMessage(error, 'The managed account could not be removed; it is still available for retry.'))
      }
      this.store.transaction(() => {
        this.store.run('DELETE FROM accounts WHERE id = ? AND provider = ?', accountId, provider)
        this.store.run('DELETE FROM account_sessions WHERE account_id = ?', accountId)
        incrementRevision(this.store)
      })
      if (provider === 'codex') this.updateCodexConfigWarning(accountId, { kind: 'synced' }, false, false)
      this.publishChanged()
      void this.refreshAfterMutation(provider)
      return this.buildState()
    })
  }

  describeRemove(params: Record<string, unknown>): string | null {
    const provider = this.readManagedProvider(params.provider)
    const accountId = this.readId(params.accountId)
    const account = getAccount(this.store, accountId)
    if (!account || account.provider !== provider) return null
    if (provider === 'claude') {
      return `Remove Claude Account? Quirky deletes ${account.label}'s private Claude home and its account-scoped sign-in from this computer. Shared history remains available to other accounts.`
    }
    return `Remove Codex Account? Removing ${account.label} permanently deletes its managed Codex home, including session history and MCP logins stored inside. If selected, future Codex launches use System default.`
  }

  async setPreferences(params: Record<string, unknown>): Promise<AccountState> {
    return this.serialize(async () => {
      const current = readPreferences(this.store)
      const updated: Preferences = { ...current, visibleProviders: [...current.visibleProviders] }
      const mode = params.mode
      if (mode !== undefined) {
        if (mode !== 'compact' && mode !== 'detailed') this.fail('invalid-params', 'mode must be compact or detailed.')
        updated.mode = mode
      }
      const direction = params.direction
      if (direction !== undefined) {
        if (direction !== 'used' && direction !== 'remaining') this.fail('invalid-params', 'direction must be used or remaining.')
        updated.direction = direction
      }
      if (params.hidden !== undefined) updated.hidden = this.readBoolean(params.hidden, 'hidden')
      const density = params.density
      if (density !== undefined) {
        if (density !== 'normal' && density !== 'icons') this.fail('invalid-params', 'density must be normal or icons.')
        updated.density = density
      }
      const switchPolicy = params.claudeSwitchPolicy
      if (switchPolicy !== undefined) {
        if (switchPolicy !== 'ask' && switchPolicy !== 'always' && switchPolicy !== 'never') {
          this.fail('invalid-params', 'claudeSwitchPolicy must be ask, always, or never.')
        }
        updated.claudeSwitchPolicy = switchPolicy
      }
      if (params.skipCodexResetConfirm !== undefined) {
        updated.skipCodexResetConfirm = this.readBoolean(params.skipCodexResetConfirm, 'skipCodexResetConfirm')
      }
      if (params.visibleProviders !== undefined) {
        if (!Array.isArray(params.visibleProviders)) this.fail('invalid-params', 'visibleProviders must contain known provider IDs.')
        const rawProviders: unknown[] = params.visibleProviders
        const visibleProviders: string[] = []
        for (const item of rawProviders) {
          if (!this.isUsageProvider(item)) this.fail('invalid-params', 'visibleProviders must contain known provider IDs.')
          visibleProviders.push(item)
        }
        updated.visibleProviders = [...new Set(visibleProviders)]
      }
      this.store.transaction(() => {
        writePreferences(this.store, updated)
        incrementRevision(this.store)
      })
      this.publishChanged()
      return this.buildState()
    })
  }

  uiState(): AccountUiState {
    return { ...this.ui }
  }

  setUiState(params: Record<string, unknown>): AccountUiState {
    const next: AccountUiState = { ...this.ui }
    if (params.open !== undefined) next.open = this.readBoolean(params.open, 'open')
    if (params.provider !== undefined) {
      const provider = params.provider
      if (provider !== null && !this.isUsageProvider(provider)) this.fail('invalid-params', 'provider must be a known provider ID or null.')
      next.provider = provider
    }
    if (params.expanded !== undefined) {
      const expanded = params.expanded
      if (expanded !== null && !this.isManagedProvider(expanded)) this.fail('invalid-params', 'expanded must be claude, codex, or null.')
      next.expanded = expanded
    }
    if (params.settingsSection !== undefined) {
      if (params.settingsSection !== null && (typeof params.settingsSection !== 'string' || params.settingsSection.length > 128)) {
        this.fail('invalid-params', 'settingsSection must be a short string or null.')
      }
      next.settingsSection = params.settingsSection
    }
    Object.assign(this.ui, next)
    return this.uiState()
  }

  async prepare(params: Record<string, unknown>): Promise<AccountPrepareResult> {
    const input = this.readPrepareInput(params)
    if (input.agent === 'shell') {
      if (input.resume) this.fail('invalid-params', 'Resume metadata is only valid for Claude or Codex sessions.')
      const overrides = input.homeOverrides
      const env = this.routing.shellEnvironment(overrides)
      if (overrides.claude.source === 'injected') env.CLAUDE_CONFIG_DIR = null
      if (overrides.codex.source === 'injected') env.CODEX_HOME = null
      return { env, shellInit: this.routing.createShellInit(), account: null }
    }
    const provider = this.providerForAgent(input.agent)
    if (provider === null) {
      if (input.resume) this.fail('invalid-params', 'Resume metadata is only valid for Claude or Codex sessions.')
      return { env: {}, shellInit: null, account: null }
    }
    const override = input.homeOverrides[provider]
    if (override.source === 'explicit') {
      if (override.value === null) {
        const home = this.unsetHome(provider)
        const identity = this.readIdentitySafely(provider, home, provider === 'claude')
        const account = this.identityFor(provider, null, identity.email ?? 'System default', 'default')
        const resumeTranscriptPath = provider === 'codex' && input.resume
          ? await this.bridgeCodexResume(input.resume, home, null)
          : undefined
        this.saveSessionIdentity(input, account, home)
        return {
          env: { [this.homeVariable(provider)]: null },
          shellInit: null,
          account,
          ...(resumeTranscriptPath === undefined ? {} : { resumeTranscriptPath })
        }
      }
      if (provider === 'codex' && input.resume) {
        this.fail('conflict', 'Codex conversations can only be resumed into the System default or a Quirky-managed account.')
      }
      const home = resolve(input.cwd, override.value)
      const identity = this.readIdentitySafely(provider, home, false)
      const label = identity.email ?? `Custom ${provider === 'claude' ? 'Claude' : 'Codex'} home`
      const account = this.identityFor(provider, null, label, 'custom')
      this.saveSessionIdentity(input, account, home)
      return { env: {}, shellInit: null, account }
    }
    const selectedId = getActiveAccountId(this.store, provider)
    if (selectedId === null) {
      const home = override.source === 'inherited' && override.value !== null
        ? resolve(input.cwd, override.value)
        : override.source === 'injected'
          ? this.unsetHome(provider)
          : this.profiles.defaultHome(provider)
      const identity = this.readIdentitySafely(provider, home, provider === 'claude')
      const account = this.identityFor(provider, null, identity.email ?? 'System default', 'default')
      const resumeTranscriptPath = provider === 'codex' && input.resume
        ? await this.bridgeCodexResume(input.resume, home, null)
        : undefined
      this.saveSessionIdentity(input, account, home)
      const env = override.source === 'injected' ? { [this.homeVariable(provider)]: null } : {}
      return {
        env,
        shellInit: null,
        account,
        ...(resumeTranscriptPath === undefined ? {} : { resumeTranscriptPath })
      }
    }
    const account = getAccount(this.store, selectedId)
    if (!account || account.provider !== provider) this.fail('conflict', `The selected ${provider} account is unavailable; no fallback account was used.`)
    let home: string
    let identity: ProviderIdentity
    try {
      home = this.profiles.ensureOwned(provider, selectedId)
      identity = this.profiles.readIdentity(provider, home)
    } catch {
      this.fail('conflict', `The selected ${provider} account home is unavailable or untrusted; no fallback account was used.`)
    }
    if (!isProviderAuth(identity) || !this.identityMatchesRecord(account, identity)) {
      this.markNeedsSignIn(account)
      this.fail('conflict', `Sign in to the selected ${provider} account again before launching it.`)
    }
    const resumeTranscriptPath = provider === 'codex' && input.resume
      ? await this.bridgeCodexResume(input.resume, home, selectedId)
      : undefined
    if (provider === 'codex') this.syncCodexConfigWarning(account.id)
    const accountIdentity = this.identityFor(provider, account.id, account.label, 'managed')
    this.saveSessionIdentity(input, accountIdentity, home)
    return {
      env: { [this.homeVariable(provider)]: home },
      shellInit: null,
      account: accountIdentity,
      ...(resumeTranscriptPath === undefined ? {} : { resumeTranscriptPath })
    }
  }

  async restart(params: Record<string, unknown>): Promise<AccountState> {
    return this.serialize(async () => {
      const sessions = this.readStringArray(params.sessions, 'sessions')
      const selectionRevision = this.readRevisionParam(params.selectionRevision)
      const revision = getRevision(this.store)
      if (selectionRevision !== revision) this.fail('conflict', 'The selected account changed. Refresh the account state and choose again.')
      const state = await this.buildState()
      for (const sessionId of [...new Set(sessions)]) {
        const stale = state.staleSessions.find((item) => item.sessionId === sessionId)
        const record = getSessionRecord(this.store, sessionId)
        if (!stale || !record || stale.selectionRevision !== selectionRevision) {
          this.fail('conflict', 'A requested session is no longer stale at this account revision.')
        }
        if (record.provider === 'claude' && stale.busy) {
          this.store.run(
            'INSERT INTO restart_intentions(session_id, target_id, selection_revision) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET target_id = excluded.target_id, selection_revision = excluded.selection_revision',
            sessionId,
            stale.selectedId,
            selectionRevision
          )
          continue
        }
        await this.performRestart(record, stale.selectedId, selectionRevision)
      }
      return this.buildState()
    })
  }

  async keep(params: Record<string, unknown>): Promise<AccountState> {
    return this.serialize(async () => {
      const sessions = this.readStringArray(params.sessions, 'sessions')
      const selectionRevision = this.readRevisionParam(params.selectionRevision)
      if (selectionRevision !== getRevision(this.store)) this.fail('conflict', 'The selected account changed. Refresh the account state and choose again.')
      const state = await this.buildState()
      for (const sessionId of [...new Set(sessions)]) {
        const stale = state.staleSessions.find((item) => item.sessionId === sessionId)
        if (!stale || stale.selectionRevision !== selectionRevision) this.fail('conflict', 'A requested session is no longer stale at this account revision.')
        this.store.run('UPDATE account_sessions SET kept = 1, error = NULL WHERE session_id = ?', sessionId)
        this.store.run('DELETE FROM restart_intentions WHERE session_id = ?', sessionId)
      }
      return this.buildState()
    })
  }

  async ingestClaude(params: Record<string, unknown>): Promise<boolean> {
    if (!this.active) return false
    const sessionId = this.readNonempty(params.session, 'session')
    const configDir = this.readNonempty(params.configDir, 'configDir')
    const payload = params.payload
    const record = getSessionRecord(this.store, sessionId)
    if (!record || record.provider !== 'claude' || record.source === 'custom') return false
    if (record.accountId !== getActiveAccountId(this.store, 'claude')) return false
    const currentHome = record.accountId === null
      ? this.profiles.defaultHome('claude')
      : this.profiles.home('claude', record.accountId)
    if (resolve(configDir) !== resolve(currentHome) || resolve(record.home) !== resolve(currentHome)) return false
    const accepted = this.requireUsage().ingestClaude({ session: sessionId, configDir, payload })
    if (accepted) this.emitIfActive('usageChanged', this.requireUsage().state())
    return accepted
  }

  credentialStatus(): CredentialStatus[] {
    return this.requireUsage().credentialStatus()
  }

  setCredential(params: Record<string, unknown>): CredentialStatus {
    const input = this.readCredentialInput(params)
    return this.requireUsage().setCredential(input)
  }

  clearCredential(params: Record<string, unknown>): CredentialStatus {
    const input = this.readCredentialClearInput(params)
    return this.requireUsage().clearCredential(input)
  }

  describeReset(params: Record<string, unknown>): string | null {
    const { expectedScope } = this.readResetCreditInput(params)
    if (readPreferences(this.store).skipCodexResetConfirm) return null
    if (
      expectedScope.accountRevision !== getRevision(this.store) ||
      expectedScope.accountId !== getActiveAccountId(this.store, 'codex')
    ) return null
    const account = expectedScope.accountId === null ? null : getAccount(this.store, expectedScope.accountId)
    const label = account?.label ?? 'System default'
    return `Use one rate-limit reset credit for ${label}'s currently displayed Codex offer?`
  }

  async consumeResetCredit(params: Record<string, unknown>): Promise<unknown> {
    const input = this.readResetCreditInput(params)
    return this.serialize(() => this.trackUsage(this.requireUsage().consumeResetCreditAuthorized({
      idempotencyKey: input.idempotencyKey,
      expectedScope: input.expectedScope
    })))
  }

  async usageTargets(): Promise<UsageTarget[]> {
    const revision = getRevision(this.store)
    const targets: UsageTarget[] = []
    for (const provider of MANAGED_PROVIDERS) {
      const activeId = getActiveAccountId(this.store, provider)
      const activeAccount = activeId === null ? null : getAccount(this.store, activeId)
      const activeHome = activeAccount?.home ?? (activeId === null ? null : this.profiles.home(provider, activeId))
      targets.push({
        provider,
        accountId: activeId,
        home: activeHome,
        active: true,
        label: activeAccount?.label ?? 'System default',
        revision
      })
      for (const account of listAccountRecords(this.store, provider)) {
        if (account.id === activeId) continue
        targets.push({ provider, accountId: account.id, home: account.home, active: false, label: account.label, revision })
      }
    }
    for (const provider of USAGE_PROVIDERS) {
      if (provider === 'claude' || provider === 'codex') continue
      targets.push({ provider, accountId: null, home: null, active: true, label: USAGE_LABELS[provider] })
    }
    return targets
  }

  async backgroundUsageRefresh(): Promise<void> {
    if (!this.active) return
    let current: unknown
    try {
      current = await this.context.call('ui.state', {})
    } catch (error) {
      if (this.active) throw error
      return
    }
    if (!this.active) return
    const windowState = asRecord(current)
    if (!windowState || !Array.isArray(windowState.windows)) return
    const focusedAndPresent = windowState.windows.some((window) => {
      const info = asRecord(window)
      return info?.focused === true && info.present === true
    })
    if (!focusedAndPresent) return
    let state: UsageState
    try {
      state = await this.trackUsage(this.requireUsage().refresh())
    } catch (error) {
      if (this.active) throw error
      return
    }
    this.emitIfActive('usageChanged', state)
  }

  onEvent(event: QuirkyEvent): void {
    if (!this.active) return
    if (event.type === 'ui.window.changed') {
      void this.backgroundUsageRefresh()
      return
    }
    if (event.type === 'quirky.session/changed') {
      const data = asRecord(event.data)
      const session = parseSessionSnapshot(data?.session)
      if (session) void this.serialize(() => this.onSessionChanged(session))
      return
    }
    if (event.type !== 'hook.received' || event.agent !== 'session-info-claude') return
    const session = getSessionRecord(this.store, event.sessionId)
    if (
      !session ||
      session.provider !== 'claude' ||
      session.agent !== 'claude' ||
      session.source === 'custom' ||
      session.selectionRevision !== getRevision(this.store) ||
      session.accountId !== getActiveAccountId(this.store, 'claude')
    ) return
    void this.ingestClaude({ session: session.sessionId, configDir: session.home, payload: event.payload }).catch(() => {})
  }

  private async onSessionChanged(session: SessionView): Promise<void> {
    if (!this.active) return
    const record = getSessionRecord(this.store, session.id)
    if (!record) return
    const busy = sessionBusy(session)
    if (record.busy !== busy) this.store.run('UPDATE account_sessions SET busy = ? WHERE session_id = ?', Number(busy), session.id)
    const intention = this.store.get<{ target_id: string | null; selection_revision: number }>(
      'SELECT target_id, selection_revision FROM restart_intentions WHERE session_id = ?',
      session.id
    )
    if (!intention) return
    if (
      record.provider !== 'claude' ||
      intention.selection_revision !== getRevision(this.store) ||
      intention.target_id !== getActiveAccountId(this.store, 'claude')
    ) {
      this.store.run('DELETE FROM restart_intentions WHERE session_id = ?', session.id)
      return
    }
    if (busy) return
    await this.performRestart(record, intention.target_id, intention.selection_revision)
  }

  private async restartAllClaude(selectionRevision: number): Promise<void> {
    const state = await this.buildState('claude')
    for (const stale of state.staleSessions) {
      const record = getSessionRecord(this.store, stale.sessionId)
      if (!record) continue
      if (stale.busy) {
        this.store.run(
          'INSERT INTO restart_intentions(session_id, target_id, selection_revision) VALUES (?, ?, ?) ON CONFLICT(session_id) DO UPDATE SET target_id = excluded.target_id, selection_revision = excluded.selection_revision',
          stale.sessionId,
          stale.selectedId,
          selectionRevision
        )
      } else {
        await this.performRestart(record, stale.selectedId, selectionRevision)
      }
    }
  }

  private async performRestart(record: AccountSessionRecord, targetId: string | null, revision: number): Promise<RestartOutcome> {
    if (revision !== getRevision(this.store) || targetId !== getActiveAccountId(this.store, record.provider)) {
      this.store.run('DELETE FROM restart_intentions WHERE session_id = ?', record.sessionId)
      return { sessionId: record.sessionId, resumedSessionId: null, error: 'The selected account changed; choose restart again for the current account.' }
    }
    const options = record.provider === 'codex'
      ? { preflightResume: (old: SessionView) => this.preflightCodexRestart(old, targetId) }
      : undefined
    const outcome = await restartSession(this.context, record.sessionId, record.provider, options)
    this.store.run('DELETE FROM restart_intentions WHERE session_id = ?', record.sessionId)
    if (outcome.error) {
      this.store.run('UPDATE account_sessions SET error = ? WHERE session_id = ?', outcome.error, record.sessionId)
      this.publishChanged()
      return outcome
    }
    this.store.run('DELETE FROM account_sessions WHERE session_id = ?', record.sessionId)
    this.publishChanged()
    return outcome
  }
  private async preflightCodexRestart(old: SessionView, targetId: string | null): Promise<void> {
    if (!old.providerSession) throw new CodexHistoryError('The previous Codex session has no provider conversation metadata.')
    let targetHome: string
    if (targetId === null) {
      targetHome = this.profiles.defaultHome('codex')
    } else {
      const account = getAccount(this.store, targetId)
      if (!account || account.provider !== 'codex') {
        throw new CodexHistoryError('The selected Codex account is unavailable; the previous session was not stopped.')
      }
      let identity: ProviderIdentity
      try {
        targetHome = this.profiles.ensureOwned('codex', targetId)
        identity = this.profiles.readIdentity('codex', targetHome)
      } catch {
        throw new CodexHistoryError('The selected Codex account home is unavailable or untrusted; the previous session was not stopped.')
      }
      if (!isProviderAuth(identity) || !this.identityMatchesRecord(account, identity)) {
        throw new CodexHistoryError('Sign in to the selected Codex account before restarting this session.')
      }
    }
    await this.bridgeCodexResume({
      sourceSessionId: old.id,
      providerSession: old.providerSession
    }, targetHome, targetId)
  }



  private async supersedeLoginsWithinMutation(): Promise<void> {
    this.inlineLoginFinalizationDepth += 1
    try {
      await this.login.supersedePending(false)
    } finally {
      this.inlineLoginFinalizationDepth -= 1
    }
  }
  private async finishLogin(completion: LoginCompletion): Promise<AccountSummary | null> {
    const superseded = completion.superseded || completion.request.mutationGeneration !== this.userMutationGeneration
    const effective = superseded ? { ...completion, superseded: true } : completion
    if (completion.superseded && this.inlineLoginFinalizationDepth > 0) return this.finishLoginMutation(effective)
    return this.serialize(() => this.finishLoginMutation(effective))
  }

  private async finishLoginMutation(completion: LoginCompletion): Promise<AccountSummary | null> {
      const { request } = completion
      const existing = getAccount(this.store, request.accountId)
      if (completion.status !== 'complete' || !completion.identity) {
        if (!request.reauthenticating) this.removeFailedProfile(request.provider, request.accountId)
        this.publishChanged()
        return null
      }
      if (request.reauthenticating && (!existing || existing.provider !== request.provider)) return null
      try {
        const identity = completion.identity
        if (!identity.hasAuth || identity.authKind !== 'oauth') throw new Error('The provider sign-in is incomplete.')
        this.assertUniqueIdentity(request.provider, identity, request.accountId)
        const now = Date.now()
        const label = request.label ?? existing?.label ?? identity.email ?? `${request.provider === 'claude' ? 'Claude' : 'Codex'} account`
        const createdAt = existing?.createdAt ?? now
        this.store.transaction(() => {
          if (existing) {
            this.store.run(
              'UPDATE accounts SET label = ?, email = ?, organization = ?, updated_at = ?, last_authenticated_at = ?, needs_sign_in = 0, identity_key = ?, auth_kind = ? WHERE id = ? AND provider = ?',
              label,
              identity.email,
              identity.organization,
              now,
              now,
              identity.identityKey,
              identity.authKind,
              request.accountId,
              request.provider
            )
          } else {
            this.store.run(
              'INSERT INTO accounts(id, provider, label, email, organization, created_at, updated_at, last_authenticated_at, needs_sign_in, home, identity_key, auth_kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)',
              request.accountId,
              request.provider,
              label,
              identity.email,
              identity.organization,
              createdAt,
              now,
              now,
              request.home,
              identity.identityKey,
              identity.authKind
            )
          }
          if (request.provider === 'codex' && !request.reauthenticating && !completion.superseded) {
            this.store.run(
              'INSERT INTO active_accounts(provider, account_id) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id',
              'codex',
              request.accountId
            )
            this.routing.writePointer('codex', request.accountId)
          }
          incrementRevision(this.store)
        })
      } catch (error) {
        if (!request.reauthenticating) this.removeFailedProfile(request.provider, request.accountId)
        if (error instanceof Error && /already added/i.test(error.message)) throw error
        throw new Error(request.provider === 'claude' ? 'Claude sign-in could not be saved.' : 'Codex sign-in could not be saved.')
      }
      if (request.provider === 'codex') this.syncCodexConfigWarning(request.accountId, false)
      this.publishChanged()
      void this.refreshAfterMutation(request.provider)
      const saved = getAccount(this.store, request.accountId)
      if (!saved) throw new Error('The saved account could not be read.')
      return this.summary(saved)
  }

  private async buildState(provider?: ManagedProvider): Promise<AccountState> {
    const records = listAccountRecords(this.store)
    const filteredRecords = provider === undefined ? records : records.filter((account) => account.provider === provider)
    const systemDefault = this.readSystemDefaults()
    const accounts = filteredRecords.map((account) => this.summary(account))
    const staleSessions = await this.readStaleSessions(provider, systemDefault)
    return {
      accounts,
      active: {
        claude: getActiveAccountId(this.store, 'claude'),
        codex: getActiveAccountId(this.store, 'codex')
      },
      systemDefault,
      pendingLogin: this.pendingLoginId === null ? null : this.login.status(this.pendingLoginId),
      staleSessions,
      preferences: readPreferences(this.store),
      configWarnings: this.configWarnings.map((warning) => ({ ...warning })),
      revision: getRevision(this.store)
    }
  }

  private syncCodexConfigWarning(accountId: string, publish = true): void {
    this.updateCodexConfigWarning(accountId, this.profiles.syncCodexConfig(accountId), publish, true)
  }

  private updateCodexConfigWarning(
    accountId: string,
    result: CodexConfigSyncResult,
    publish: boolean,
    bumpRevision: boolean
  ): void {
    const index = this.configWarnings.findIndex((warning) => warning.accountId === accountId)
    const current = index < 0 ? null : this.configWarnings[index] ?? null
    const next: ConfigWarning | null = result.kind === 'synced'
      ? null
      : { provider: 'codex', accountId, kind: result.kind, message: result.message }
    if (
      current === null && next === null ||
      current !== null && next !== null &&
      current.kind === next.kind && current.message === next.message
    ) return
    if (index >= 0) this.configWarnings.splice(index, 1)
    if (next !== null) this.configWarnings.push(next)
    if (bumpRevision) incrementRevision(this.store)
    if (publish) this.publishChanged()
  }

  private async readStaleSessions(provider: ManagedProvider | undefined, systemDefault: Record<ManagedProvider, SystemAccount>): Promise<StaleSession[]> {
    let sessions: SessionView[] = []
    try {
      const raw: unknown = await this.context.call('quirky.session/list', {})
      if (Array.isArray(raw)) sessions = raw.map(parseSessionSnapshot).filter((session): session is SessionView => session !== null)
    } catch {
      return []
    }
    const byId = new Map(sessions.map((session) => [session.id, session]))
    const records = listSessionRecords(this.store, provider)
    const result: StaleSession[] = []
    for (const record of records) {
      if (record.source === 'custom') continue
      const session = byId.get(record.sessionId)
      if (!session && !record.error) continue
      if (session?.status === 'exited' && !record.error) continue
      const selectedId = getActiveAccountId(this.store, record.provider)
      if (selectedId === record.accountId) continue
      const selectedAccount = selectedId === null ? null : getAccount(this.store, selectedId)
      const intention = this.store.get<{ target_id: string | null; selection_revision: number }>(
        'SELECT target_id, selection_revision FROM restart_intentions WHERE session_id = ?',
        record.sessionId
      )
      const revision = getRevision(this.store)
      const busy = session ? sessionBusy(session) : false
      if (record.busy !== busy) this.store.run('UPDATE account_sessions SET busy = ? WHERE session_id = ?', Number(busy), record.sessionId)
      result.push({
        sessionId: record.sessionId,
        provider: record.provider,
        accountId: record.accountId,
        accountLabel: record.accountLabel,
        selectedId,
        selectedLabel: selectedAccount?.label ?? systemDefault[record.provider].label,
        busy,
        queued: Boolean(intention && intention.selection_revision === revision && intention.target_id === selectedId),
        kept: record.kept,
        error: record.error,
        selectionRevision: revision
      })
    }
    return result.sort((left, right) => left.sessionId.localeCompare(right.sessionId))
  }

  private readSystemDefaults(): Record<ManagedProvider, SystemAccount> {
    return {
      claude: this.readSystemDefault('claude'),
      codex: this.readSystemDefault('codex')
    }
  }

  private readSystemDefault(provider: ManagedProvider): SystemAccount {
    try {
      const identity = this.profiles.readIdentity(provider, this.profiles.defaultHome(provider), provider === 'claude')
      return { label: 'System default', email: identity.email, hasAuth: identity.hasAuth, authKind: identity.authKind }
    } catch {
      return { label: 'System default', email: null, hasAuth: false, authKind: 'unknown' }
    }
  }

  private verifySelectableAccount(provider: ManagedProvider, id: string): void {
    const account = getAccount(this.store, id)
    if (!account || account.provider !== provider) this.fail('not-found', `The managed ${provider} account was not found.`)
    if (account.needsSignIn) this.fail('conflict', `Sign in to this ${provider} account again before selecting it.`)
    let identity: ProviderIdentity
    try {
      const home = this.profiles.ensureOwned(provider, id)
      identity = this.profiles.readIdentity(provider, home)
    } catch {
      this.fail('conflict', `The managed ${provider} home is unavailable or untrusted; the current selection was not changed.`)
    }
    if (!isProviderAuth(identity) || !this.identityMatchesRecord(account, identity)) {
      this.markNeedsSignIn(account)
      this.fail('conflict', `Sign in to this ${provider} account again before selecting it.`)
    }
  }

  private identityMatchesRecord(account: AccountRecord, identity: ProviderIdentity): boolean {
    const stored: ProviderIdentity = {
      email: account.email,
      organization: account.organization,
      authKind: account.authKind,
      hasAuth: !account.needsSignIn,
      identityKey: account.identityKey
    }
    return isSameIdentity(account.provider, stored, identity)
  }

  private assertUniqueIdentity(provider: ManagedProvider, identity: ProviderIdentity, exceptId: string): void {
    const duplicate = listAccountRecords(this.store, provider).find((account) => {
      if (account.id === exceptId) return false
      const stored: ProviderIdentity = {
        email: account.email,
        organization: account.organization,
        authKind: account.authKind,
        hasAuth: !account.needsSignIn,
        identityKey: account.identityKey
      }
      return isSameIdentity(provider, stored, identity)
    })
    if (duplicate) throw new Error(`This ${provider === 'claude' ? 'Claude' : 'Codex'} account is already added.`)
  }

  private markNeedsSignIn(account: AccountRecord): void {
    if (account.needsSignIn) return
    this.store.transaction(() => {
      this.store.run('UPDATE accounts SET needs_sign_in = 1, updated_at = ? WHERE id = ?', Date.now(), account.id)
      incrementRevision(this.store)
    })
    this.publishChanged()
  }

  private saveSessionIdentity(input: PrepareInput, identity: AccountIdentity, home: string): void {
    const sessionId = input.sessionId
    if (!sessionId || sessionId.length > MAX_SESSION_ID || /[\u0000-\u001f\u007f]/.test(sessionId)) {
      this.fail('invalid-params', 'sessionId must be a valid session identifier.')
    }
    const session: AccountSessionRecord = {
      sessionId,
      provider: identity.provider,
      accountId: identity.id,
      accountLabel: identity.label,
      source: identity.source,
      home,
      selectionRevision: getRevision(this.store),
      worktreeId: input.worktreeId,
      cwd: input.cwd,
      agent: input.agent,
      busy: input.agent !== 'shell',
      kept: false,
      error: null
    }
    this.store.run(
      `INSERT INTO account_sessions(session_id, provider, account_id, account_label, source, home, selection_revision, worktree_id, cwd, agent, busy, kept, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET provider = excluded.provider, account_id = excluded.account_id, account_label = excluded.account_label, source = excluded.source, home = excluded.home, selection_revision = excluded.selection_revision, worktree_id = excluded.worktree_id, cwd = excluded.cwd, agent = excluded.agent, busy = excluded.busy, kept = 0, error = NULL`,
      session.sessionId,
      session.provider,
      session.accountId,
      session.accountLabel,
      session.source,
      session.home,
      session.selectionRevision,
      session.worktreeId,
      session.cwd,
      session.agent,
      Number(session.busy),
      0,
      null
    )
  }

  private identityFor(provider: ManagedProvider, id: string | null, label: string, source: AccountIdentity['source']): AccountIdentity {
    return { provider, id, label, source }
  }

  private readIdentitySafely(provider: ManagedProvider, home: string, includeEnvironmentApiKey: boolean): ProviderIdentity {
    try {
      return this.profiles.readIdentity(provider, home, includeEnvironmentApiKey)
    } catch {
      return { email: null, organization: null, authKind: 'unknown', hasAuth: false, identityKey: null }
    }
  }

  private readPrepareInput(params: Record<string, unknown>): PrepareInput {
    const agent = this.readNonempty(params.agent, 'agent')
    const sessionId = this.readNonempty(params.sessionId, 'sessionId')
    if (sessionId.length > MAX_SESSION_ID) this.fail('invalid-params', 'sessionId is too long.')
    const worktreeId = this.readNonempty(params.worktreeId, 'worktreeId')
    const cwd = this.readNonempty(params.cwd, 'cwd')
    const overrides = asRecord(params.homeOverrides)
    if (!overrides) this.fail('invalid-params', 'homeOverrides is required.')
    const resume = params.resume === undefined ? undefined : this.readResume(params.resume)
    return {
      agent,
      sessionId,
      worktreeId,
      cwd,
      homeOverrides: {
        claude: this.readHomeOverride(overrides.claude, 'claude'),
        codex: this.readHomeOverride(overrides.codex, 'codex')
      },
      ...(resume === undefined ? {} : { resume })
    }
  }

  private readResume(value: unknown): NonNullable<PrepareInput['resume']> {
    const resume = asRecord(value)
    if (!resume || !hasExactKeys(resume, ['sourceSessionId', 'providerSession'])) {
      this.fail('invalid-params', 'resume must contain only sourceSessionId and providerSession.')
    }
    const sourceSessionId = this.readNonempty(resume.sourceSessionId, 'resume.sourceSessionId')
    if (sourceSessionId.length > MAX_SESSION_ID) this.fail('invalid-params', 'resume.sourceSessionId is too long.')
    const providerSession = asRecord(resume.providerSession)
    if (!providerSession || !hasExactKeys(providerSession, ['id', 'transcriptPath'])) {
      this.fail('invalid-params', 'resume.providerSession must contain only id and transcriptPath.')
    }
    const id = this.readNonempty(providerSession.id, 'resume.providerSession.id')
    const transcriptPath = providerSession.transcriptPath === null
      ? null
      : this.readNonempty(providerSession.transcriptPath, 'resume.providerSession.transcriptPath')
    return { sourceSessionId, providerSession: { id, transcriptPath } }
  }

  private async bridgeCodexResume(
    resume: CodexResumeMetadata,
    targetHome: string,
    targetAccountId: string | null
  ): Promise<string> {
    if (targetAccountId === null) {
      if (!this.codexSystemHomes().some((home) => resolve(home) === resolve(targetHome))) {
        this.fail('conflict', 'Codex conversations can only be resumed into the System default or a Quirky-managed account.')
      }
    } else {
      let ownedHome: string
      try {
        ownedHome = this.profiles.ensureOwned('codex', targetAccountId)
      } catch {
        this.fail('conflict', 'The selected Codex account home is unavailable or untrusted; no fallback account was used.')
      }
      if (resolve(ownedHome) !== resolve(targetHome)) {
        this.fail('conflict', 'Codex resume target does not match the selected managed account.')
      }
    }
    const sourceHomes = this.codexResumeSourceHomes(resume.sourceSessionId)
    try {
      return await prepareCodexHistoryResume({ resume, sourceHomes, targetHome })
    } catch (error) {
      if (error instanceof CodexHistoryError) this.fail('conflict', error.message)
      this.fail('conflict', 'The Codex conversation could not be prepared safely. Verify the source rollout and target sessions folder, then retry.')
    }
  }

  private codexResumeSourceHomes(sourceSessionId: string): string[] {
    const source = getSessionRecord(this.store, sourceSessionId)
    const systemHomes = this.codexSystemHomes()
    if (source) {
      if (source.provider !== 'codex' || source.agent !== 'codex') {
        this.fail('conflict', 'The recorded source session is not a Codex session.')
      }
      if (source.source === 'managed') {
        if (!source.accountId) this.fail('conflict', 'The recorded Codex source account is unavailable or untrusted.')
        let home: string
        try {
          home = this.profiles.ensureOwned('codex', source.accountId)
        } catch {
          this.fail('conflict', 'The recorded Codex source account is unavailable or untrusted.')
        }
        if (!isAbsolute(source.home) || resolve(source.home) !== resolve(home)) {
          this.fail('conflict', 'The recorded Codex source home no longer matches its managed account.')
        }
        return [home]
      }
      if (source.source === 'default' && source.accountId === null && isAbsolute(source.home)) {
        return [source.home]
      }
      this.fail('conflict', 'The recorded Codex source home is not a trusted System default or managed account.')
    }

    const homes = [...systemHomes]
    for (const account of listAccountRecords(this.store, 'codex')) {
      try {
        homes.push(this.profiles.ensureOwned('codex', account.id))
      } catch {
        // An unavailable profile is not a trusted source candidate.
      }
    }
    return homes
  }

  private codexSystemHomes(): string[] {
    return [...new Set([this.profiles.defaultHome('codex'), this.unsetHome('codex')].map((home) => resolve(home)))]
  }

  private readHomeOverride(value: unknown, provider: ManagedProvider): PrepareInput['homeOverrides'][ManagedProvider] {
    const override = asRecord(value)
    if (!override || (override.value !== null && typeof override.value !== 'string')) {
      this.fail('invalid-params', `${provider} home override is malformed.`)
    }
    const source = override.source
    if (source !== 'explicit' && source !== 'inherited' && source !== 'injected' && source !== 'absent') {
      this.fail('invalid-params', `${provider} home override provenance is invalid.`)
    }
    return { value: override.value, source }
  }

  private providerForAgent(agent: string): ManagedProvider | null {
    return agent === 'claude' || agent === 'codex' ? agent : null
  }

  private homeVariable(provider: ManagedProvider): 'CLAUDE_CONFIG_DIR' | 'CODEX_HOME' {
    return provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : 'CODEX_HOME'
  }

  private unsetHome(provider: ManagedProvider): string {
    return join(process.env.HOME ?? '', provider === 'claude' ? '.claude' : '.codex')
  }

  private commitSelection(provider: ManagedProvider, accountId: string | null): number {
    const previousPointer = this.routing.readPointerContents(provider)
    try {
      return this.store.transaction(() => {
        this.store.run(
          'INSERT INTO active_accounts(provider, account_id) VALUES (?, ?) ON CONFLICT(provider) DO UPDATE SET account_id = excluded.account_id',
          provider,
          accountId
        )
        this.store.run('UPDATE account_sessions SET kept = 0, error = NULL WHERE provider = ?', provider)
        this.store.run('DELETE FROM restart_intentions WHERE session_id IN (SELECT session_id FROM account_sessions WHERE provider = ?)', provider)
        const revision = incrementRevision(this.store)
        this.routing.writePointer(provider, accountId)
        return revision
      })
    } catch {
      try {
        this.routing.restorePointerContents(provider, previousPointer)
      } catch {
        this.routing.writeInvalidPointer(provider)
      }
      this.fail('conflict', 'Account selection could not be committed safely. The previous selection remains authoritative.')
    }
  }

  private async hasRunningSession(accountId: string): Promise<boolean> {
    const records = listSessionRecords(this.store).filter((record) => record.accountId === accountId)
    for (const record of records) {
      const alive = await sessionIsAlive(this.context, record.sessionId)
      if (alive !== false) return true
    }
    return false
  }

  private async refreshAfterMutation(provider: ManagedProvider): Promise<void> {
    if (!this.active) return
    let state: UsageState
    try {
      state = await this.trackUsage(this.requireUsage().refresh({ provider, force: true }))
    } catch {
      if (this.active) this.context.log('Usage refresh failed after a committed account change.')
      return
    }
    this.emitIfActive('usageChanged', state)
  }

  private trackUsage<T>(work: Promise<T>): Promise<T> {
    this.pendingUsageWork.add(work)
    void work.then(
      () => this.pendingUsageWork.delete(work),
      () => this.pendingUsageWork.delete(work)
    )
    return work
  }

  private removeFailedProfile(provider: ManagedProvider, id: string): void {
    try {
      this.profiles.remove(provider, id)
    } catch {
      // A failed cleanup leaves an owned, unlisted profile rather than deleting an unproven path.
    }
  }

  private summary(account: AccountRecord): AccountSummary {
    return {
      id: account.id,
      provider: account.provider,
      label: account.label,
      email: account.email,
      organization: account.organization,
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
      lastAuthenticatedAt: account.lastAuthenticatedAt,
      needsSignIn: account.needsSignIn,
      active: account.active
    }
  }

  private publishChanged(revision = getRevision(this.store)): void {
    this.emitIfActive('changed', { revision })
  }

  private emitIfActive(event: string, data: unknown): void {
    if (!this.active) return
    try {
      this.context.emit(event, data)
    } catch (error) {
      if (this.active) throw error
    }
  }

  private requireUsage(): UsageService {
    if (!this.usageService) throw new Error('Account usage service is not available.')
    return this.usageService
  }

  private requireActive(): void {
    if (!this.active) this.fail('conflict', 'The accounts plugin is shutting down.')
  }

  private readManagedProvider(value: unknown): ManagedProvider {
    if (value === 'claude' || value === 'codex') return value
    return this.fail('invalid-params', 'provider must be claude or codex.')
  }

  private readUsageProvider(value: unknown): (typeof USAGE_PROVIDERS)[number] {
    if (this.isUsageProvider(value)) return value
    return this.fail('invalid-params', 'provider must be a supported usage provider.')
  }

  private readId(value: unknown): string {
    if (typeof value === 'string' && MANAGED_ID_RE.test(value)) return value
    return this.fail('invalid-params', 'accountId must be a valid managed account UUID.')
  }

  private readAccountLabel(value: unknown): string {
    if (typeof value !== 'string') return this.fail('invalid-params', 'label must be a string.')
    const label = value.trim()
    if (!label || label.length > MAX_ACCOUNT_LABEL || /[\u0000-\u001f\u007f]/.test(label)) {
      return this.fail('invalid-params', `label must be 1-${MAX_ACCOUNT_LABEL} printable characters.`)
    }
    return label
  }

  private readNonempty(value: unknown, name: string): string {
    if (typeof value === 'string' && value.length > 0 && value.length <= 2048 && !/[\u0000-\u001f\u007f]/.test(value)) return value
    return this.fail('invalid-params', `${name} must be a nonempty string.`)
  }

  private readBoolean(value: unknown, name: string): boolean {
    if (typeof value === 'boolean') return value
    return this.fail('invalid-params', `${name} must be a boolean.`)
  }

  private readRevisionParam(value: unknown): number {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value
    return this.fail('invalid-params', 'selectionRevision must be a nonnegative integer.')
  }

  private readStringArray(value: unknown, name: string): string[] {
    if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item.length > 0)) {
      return this.fail('invalid-params', `${name} must be an array of session IDs.`)
    }
    return value
  }

  private readCredentialInput(params: Record<string, unknown>): CredentialInput {
    if (typeof params.value !== 'string') this.fail('invalid-params', 'value must be provided through stdin or a file-backed CLI argument.')
    return {
      provider: this.readNonempty(params.provider, 'provider'),
      kind: this.readNonempty(params.kind, 'kind'),
      value: params.value
    }
  }

  private readCredentialClearInput(params: Record<string, unknown>): CredentialClearInput {
    return { provider: this.readNonempty(params.provider, 'provider'), kind: this.readNonempty(params.kind, 'kind') }
  }

  private readResetCreditInput(params: Record<string, unknown>): ResetCreditInput {
    const idempotencyKey = this.readNonempty(params.idempotencyKey, 'idempotencyKey')
    const rawScope = asRecord(params.expectedScope)
    if (!rawScope || (rawScope.accountId !== null && typeof rawScope.accountId !== 'string') || typeof rawScope.accountRevision !== 'number' || !Number.isSafeInteger(rawScope.accountRevision) || typeof rawScope.offerRevision !== 'string') {
      this.fail('invalid-params', 'expectedScope is malformed.')
    }
    const expectedScope: ResetCreditScope = {
      accountId: rawScope.accountId,
      accountRevision: rawScope.accountRevision,
      offerRevision: rawScope.offerRevision
    }
    const yes = params.yes === undefined ? undefined : this.readBoolean(params.yes, 'yes')
    return { idempotencyKey, expectedScope, ...(yes === undefined ? {} : { yes }) }
  }

  private isManagedProvider(value: unknown): value is ManagedProvider {
    return value === 'claude' || value === 'codex'
  }

  private isUsageProvider(value: unknown): value is (typeof USAGE_PROVIDERS)[number] {
    return typeof value === 'string' && USAGE_PROVIDERS.includes(value as (typeof USAGE_PROVIDERS)[number])
  }

  private fail(kind: 'invalid-params' | 'not-found' | 'conflict', message: string): never {
    throw this.context.error(kind, message)
  }

  private serialize<T>(work: () => Promise<T> | T): Promise<T> {
    const next = this.mutationTail.then(work, work)
    this.mutationTail = next.then(() => undefined, () => undefined)
    return next
  }
}

function parseSessionSnapshot(value: unknown): SessionView | null {
  const record = asRecord(value)
  if (!record) return null
  const id = typeof record.id === 'string' ? record.id : null
  const kind = typeof record.kind === 'string' ? record.kind : null
  const agent = typeof record.agent === 'string' ? record.agent : null
  const worktreeId = typeof record.worktreeId === 'string' ? record.worktreeId : null
  const cwd = typeof record.cwd === 'string' ? record.cwd : null
  const status = typeof record.status === 'string' ? record.status : null
  if (!id || !kind || !agent || !worktreeId || !cwd || !status) return null
  const providerData = asRecord(record.providerSession)
  let providerSession: SessionView['providerSession'] = null
  if (providerData && typeof providerData.id === 'string') {
    providerSession = {
      id: providerData.id,
      transcriptPath: typeof providerData.transcriptPath === 'string' ? providerData.transcriptPath : null
    }
  }
  return {
    id,
    kind,
    agent,
    worktreeId,
    cwd,
    status,
    providerSession,
    resumedFrom: typeof record.resumedFrom === 'string' ? record.resumedFrom : null
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).length === keys.length && keys.every((key) => Object.prototype.hasOwnProperty.call(record, key))
}

function safeMessage(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback
  if (error.message.includes('custom provider') || error.message.includes('already added')) return error.message
  return fallback
}
