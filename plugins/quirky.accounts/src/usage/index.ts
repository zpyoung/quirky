import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { PluginContext } from '@quirky/protocol'
import { fetchProviderUsage } from './adapters'
import { consumeCodexResetCredit } from './codex-adapter'
import { claudeConfigDir, clearStoredCredential, credentialStatuses, writeStoredCredential } from './credentials'
import { mapClaudeUsage } from './mappers'
import { ProviderProcessOwner } from './process'
import { record } from './provider-utils'
import {
  persistResetLedger,
  persistUsageSnapshots,
  readResetLedger,
  readUsageSnapshots,
  resetIdKey,
  usageIdentityKey,
  type ResetLedgerEntry
} from './persistence'
import { USAGE_PROVIDERS, type CredentialStatus, type ProviderSnapshot, type RateLimitResetCredits, type ResetCreditConsumeOptions, type ResetCreditExpectedScope, type UsageProvider, type UsageRefreshOptions, type UsageState, type UsageTarget } from './types'

export type {
  CredentialStatus,
  CreditExtraUsage,
  ExtraUsage,
  ExtraUsageBase,
  CurrencyExtraUsage,
  ProviderSnapshot,
  RateLimitResetCredits,
  ResetCreditConsumeOptions,
  ResetCreditExpectedScope,
  UsageBucket,
  UsageFailureKind,
  UsageMetadata,
  UsageProvider,
  UsageRefreshOptions,
  UsageSource,
  UsageState,
  UsageStatus,
  UsageTarget,
  UsageWindow
} from './types'
export { USAGE_PROVIDERS } from './types'
export { mapAntigravityUsage, mapClaudeUsage, mapCodexUsage, mapCursorUsage, mapGeminiUsage, mapGrokUsage, mapKimiUsage, mapMiniMaxUsage, mapOpenCodeGoUsage, mapZcodeUsage } from './mappers'
export { credentialProviderAllowedPairs } from './credentials'

const FRESH_ERROR_MS = 30 * 60_000
const RATE_LIMIT_STALE_MS = 24 * 60 * 60_000
const MANUAL_DEBOUNCE_MS = 5 * 60_000
const INACTIVE_DEBOUNCE_MS = 60_000
const CODEX_INACTIVE_STAGGER_MS = 2_000
const LIVE_CLAUDE_DEDUPE_MS = 30_000

type RefreshFlight = { promise: Promise<ProviderSnapshot> }
type LiveDedupe = { fingerprint: string; at: number }

function isProvider(value: string): value is UsageProvider {
  return (USAGE_PROVIDERS as readonly string[]).includes(value)
}

function revisionFor(target: UsageTarget | undefined): number | undefined {
  return target?.revision ?? (process.env.NODE_ENV === 'test' ? 0 : undefined)
}

function idleSnapshot(provider: UsageProvider, target?: UsageTarget, now = Date.now()): ProviderSnapshot {
  return {
    provider,
    accountId: target?.accountId ?? null,
    ...(revisionFor(target) !== undefined ? { accountRevision: revisionFor(target) } : {}),
    status: 'idle',
    error: null,
    updatedAt: now,
    session: null,
    weekly: null
  }
}

function withTarget(snapshot: ProviderSnapshot, target: UsageTarget, now: number): ProviderSnapshot {
  const revision = revisionFor(target)
  const result: ProviderSnapshot = {
    ...snapshot,
    accountId: target.accountId,
    ...(revision !== undefined ? { accountRevision: revision } : {}),
    updatedAt: snapshot.updatedAt || now
  }
  if (revision === undefined) delete result.accountRevision
  if (target.provider === 'codex' && result.rateLimitResetCredits) {
    const credits = { ...result.rateLimitResetCredits }
    const revision = revisionFor(target)
    if (revision === undefined) {
      delete credits.expectedScope
    } else {
      credits.expectedScope = createResetScope(target, revision, credits)
    }
    result.rateLimitResetCredits = credits
  }
  return result
}

function createResetScope(target: UsageTarget, revision: number, credits: RateLimitResetCredits): ResetCreditExpectedScope {
  const offer = {
    availableCount: credits.availableCount,
    totalEarnedCount: credits.totalEarnedCount ?? null,
    nextExpiresAt: credits.nextExpiresAt ?? null,
    credits: [...(credits.credits ?? [])].sort((left, right) =>
      (left.expiresAt ?? Number.MAX_SAFE_INTEGER) - (right.expiresAt ?? Number.MAX_SAFE_INTEGER) ||
      left.status.localeCompare(right.status) ||
      (left.grantedAt ?? Number.MAX_SAFE_INTEGER) - (right.grantedAt ?? Number.MAX_SAFE_INTEGER)
    )
  }
  return {
    accountId: target.accountId,
    accountRevision: revision,
    offerRevision: createHash('sha256').update(JSON.stringify([target.accountId, revision, offer])).digest('hex')
  }
}

function sameScope(left: ResetCreditExpectedScope, right: ResetCreditExpectedScope): boolean {
  return left.accountId === right.accountId && left.accountRevision === right.accountRevision && left.offerRevision === right.offerRevision
}


function activeTargetKey(target: UsageTarget): string {
  if (!isProvider(target.provider)) throw new Error('Unknown usage provider')
  return usageIdentityKey(target.provider, target.accountId, target.home)
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

export class UsageService {
  private readonly processes = new ProviderProcessOwner()
  private readonly controllers = new Set<AbortController>()
  private readonly inFlight = new Map<string, RefreshFlight>()
  private readonly lastGood: Map<string, ProviderSnapshot>
  private readonly ledger: Map<string, ResetLedgerEntry>
  private readonly current = new Map<UsageProvider, ProviderSnapshot>()
  private readonly selected = new Map<UsageProvider, UsageTarget>()
  private readonly activeIdentities = new Map<UsageProvider, string>()
  private readonly inactiveSnapshots = new Map<string, ProviderSnapshot>()
  private readonly inactiveFetchAt = new Map<string, number>()
  private readonly lastAttemptAt = new Map<string, number>()
  private readonly liveDedupe = new Map<string, LiveDedupe>()
  private lastStateAt = Date.now()
  private closed = false

  constructor(
    private readonly context: PluginContext,
    private readonly targets: () => Promise<UsageTarget[]>
  ) {
    this.lastGood = readUsageSnapshots(context.dataDir)
    this.ledger = readResetLedger(context.dataDir)
    for (const provider of USAGE_PROVIDERS) this.current.set(provider, idleSnapshot(provider))
  }

  state(): UsageState {
    return clone({
      providers: USAGE_PROVIDERS.map((provider) => this.current.get(provider) ?? idleSnapshot(provider)),
      inactive: Object.fromEntries(this.inactiveSnapshots),
      updatedAt: this.lastStateAt
    })
  }

  async refresh(options: UsageRefreshOptions = {}): Promise<UsageState> {
    if (this.closed) return this.state()
    if (options.provider !== undefined && !isProvider(options.provider)) throw new Error('Unknown usage provider')
    let targets: UsageTarget[]
    try {
      targets = await this.targets()
    } catch {
      return this.state()
    }
    this.synchronizeActiveTargets(targets)
    const chosen: UsageProvider[] = options.provider ? [options.provider] : [...USAGE_PROVIDERS]
    await Promise.all(chosen.map(async (provider) => {
      const target = this.selected.get(provider)
      if (!target) return
      await this.refreshTarget(target, options.force === true, false)
    }))
    return this.state()
  }

  async inactive(provider: string): Promise<UsageState> {
    if (this.closed) return this.state()
    if (provider !== 'claude' && provider !== 'codex') throw new Error('Inactive usage is only available for Claude and Codex')
    let targets: UsageTarget[]
    try {
      targets = await this.targets()
    } catch {
      return this.state()
    }
    this.synchronizeActiveTargets(targets)
    const candidates = targets.filter((target) => target.provider === provider && !target.active && target.accountId !== null)
    let first = true
    for (const target of candidates) {
      if (this.closed) break
      const key = usageIdentityKey(provider, target.accountId, target.home)
      const lastFetched = this.inactiveFetchAt.get(key) ?? 0
      if (Date.now() - lastFetched < INACTIVE_DEBOUNCE_MS) continue
      if (provider === 'codex' && !first) await this.wait(CODEX_INACTIVE_STAGGER_MS)
      first = false
      const result = await this.refreshTarget(target, false, true)
      this.inactiveFetchAt.set(key, Date.now())
      const currentTargets = await this.targets().catch(() => [])
      const stillInactive = currentTargets.some((candidate) =>
        candidate.provider === target.provider && candidate.accountId === target.accountId && candidate.home === target.home && !candidate.active && revisionFor(candidate) === revisionFor(target)
      )
      if (stillInactive && result.accountId === target.accountId) {
        this.inactiveSnapshots.set(`${provider}:${target.accountId}`, result)
        this.lastStateAt = Date.now()
      }
    }
    this.publish()
    return this.state()
  }

  ingestClaude(input: { session: string; configDir: string; payload: unknown }): boolean {
    if (this.closed) return false
    const target = this.selected.get('claude')
    if (!target || !target.active || !input.session || !input.configDir) return false
    let expectedConfig: string
    try {
      expectedConfig = resolve(claudeConfigDir(target))
      if (resolve(input.configDir) !== expectedConfig) return false
    } catch {
      return false
    }
    const root = record(input.payload)
    const limits = record(root?.rate_limits) ?? input.payload
    let serialized: string
    try {
      serialized = JSON.stringify(limits)
      if (serialized === undefined) return false
    } catch {
      return false
    }
    const fingerprint = createHash('sha256').update(serialized).digest('hex')
    const previous = this.liveDedupe.get(input.session)
    const now = Date.now()
    for (const [session, entry] of this.liveDedupe) {
      if (now - entry.at >= 10 * LIVE_CLAUDE_DEDUPE_MS) this.liveDedupe.delete(session)
    }
    if (previous?.fingerprint === fingerprint && now - previous.at < LIVE_CLAUDE_DEDUPE_MS) return false
    const snapshot = mapClaudeUsage(limits, now)
    if (snapshot.status !== 'ok') return false
    this.liveDedupe.set(input.session, { fingerprint, at: now })
    const attached = withTarget({
      ...snapshot,
      usageMetadata: { source: 'live-session', attemptedSources: ['live-session'] }
    }, target, now)
    const key = activeTargetKey(target)
    this.current.set('claude', attached)
    this.lastGood.set(key, attached)
    persistUsageSnapshots(this.context.dataDir, this.lastGood)
    this.lastStateAt = now
    this.publish()
    return true
  }

  consumeResetCredit(options: ResetCreditConsumeOptions): Promise<unknown> {
    return this.consumeResetCreditInScope(options)
  }

  consumeResetCreditAuthorized(options: Omit<ResetCreditConsumeOptions, 'yes'>): Promise<unknown> {
    return this.consumeResetCreditInScope({ ...options, yes: true })
  }

  credentialStatus(): CredentialStatus[] {
    return credentialStatuses(this.context.dataDir)
  }

  setCredential(input: { provider: string; kind: string; value: string }): CredentialStatus {
    const result = writeStoredCredential(this.context.dataDir, input.provider, input.kind, input.value)
    this.publish()
    return result
  }

  clearCredential(input: { provider: string; kind: string }): CredentialStatus {
    const result = clearStoredCredential(this.context.dataDir, input.provider, input.kind)
    this.publish()
    return result
  }

  shutdown(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.controllers) controller.abort()
    this.controllers.clear()
    void this.processes.shutdown()
    this.inFlight.clear()
  }

  private synchronizeActiveTargets(targets: UsageTarget[]): void {
    for (const provider of USAGE_PROVIDERS) {
      const matches = targets.filter((target) => target.provider === provider && target.active)
      if (matches.length !== 1) {
        this.selected.delete(provider)
        this.activeIdentities.delete(provider)
        this.current.set(provider, matches.length === 0
          ? idleSnapshot(provider)
          : { ...idleSnapshot(provider), status: 'error', error: 'Usage target configuration is ambiguous' })
        continue
      }
      const target = matches[0]!
      this.selected.set(provider, target)
      const identity = `${activeTargetKey(target)}:${revisionFor(target) ?? 'missing'}`
      if (this.activeIdentities.get(provider) === identity) continue
      this.activeIdentities.set(provider, identity)
      const cached = this.lastGood.get(activeTargetKey(target))
      const candidate = cached ? withTarget(cached, target, Date.now()) : idleSnapshot(provider, target)
      this.current.set(provider, candidate)
    }
    this.lastStateAt = Date.now()
  }

  private async refreshTarget(target: UsageTarget, force: boolean, inactive: boolean): Promise<ProviderSnapshot> {
    if (!isProvider(target.provider)) return idleSnapshot('claude')
    const cacheKey = activeTargetKey(target)
    const revisionKey = revisionFor(target) ?? 'missing'
    const flightKey = `${cacheKey}:${revisionKey}`
    const existing = this.inFlight.get(flightKey)
    if (existing) return existing.promise
    const now = Date.now()
    const previous = inactive
      ? this.inactiveSnapshots.get(`${target.provider}:${target.accountId}`) ?? this.lastGood.get(cacheKey)
      : this.current.get(target.provider) ?? this.lastGood.get(cacheKey)
    if (!force && previous?.usageMetadata?.retryAtMs && previous.usageMetadata.retryAtMs > now) return previous
    const lastAttempt = this.lastAttemptAt.get(flightKey) ?? 0
    if (!force && !inactive && now - lastAttempt < MANUAL_DEBOUNCE_MS && previous && previous.status !== 'idle') return previous
    this.lastAttemptAt.set(flightKey, now)
    const controller = new AbortController()
    this.controllers.add(controller)
    if (!inactive) {
      const fetching = withTarget({
        ...(previous ?? idleSnapshot(target.provider, target)),
        status: 'fetching',
        error: null
      }, target, now)
      this.current.set(target.provider, fetching)
      this.lastStateAt = now
      this.publish()
    }
    const promise = this.fetchAndApply(target, controller, cacheKey, previous, inactive)
      .finally(() => {
        this.controllers.delete(controller)
        this.inFlight.delete(flightKey)
      })
    this.inFlight.set(flightKey, { promise })
    return promise
  }

  private async fetchAndApply(
    target: UsageTarget,
    controller: AbortController,
    cacheKey: string,
    previous: ProviderSnapshot | undefined,
    inactive: boolean
  ): Promise<ProviderSnapshot> {
    const provider = target.provider
    if (!isProvider(provider)) return previous ?? idleSnapshot('claude', target)
    let received: ProviderSnapshot
    try {
      received = await fetchProviderUsage(
        provider,
        target,
        this.processes,
        controller.signal,
        this.context.dataDir,
        this.context.getSetting('gemini-cli-oauth-enabled') === true
      )
    } catch {
      received = {
        ...idleSnapshot(provider, target),
        status: 'error',
        error: 'Provider usage request failed',
        usageMetadata: { failureKind: 'unknown' }
      }
    }
    if (this.closed || controller.signal.aborted) return previous ?? idleSnapshot(provider, target)
    if (!inactive) {
      let latest: UsageTarget[]
      try {
        latest = await this.targets()
      } catch {
        return previous ?? idleSnapshot(target.provider as UsageProvider, target)
      }
      this.synchronizeActiveTargets(latest)
      const currentTarget = this.selected.get(provider)
      if (!currentTarget || activeTargetKey(currentTarget) !== cacheKey || revisionFor(currentTarget) !== revisionFor(target)) {
        return this.current.get(provider) ?? idleSnapshot(provider)
      }
    } else {
      let latest: UsageTarget[]
      try {
        latest = await this.targets()
      } catch {
        return previous ?? idleSnapshot(provider, target)
      }
      const stillInactive = latest.some((candidate) =>
        candidate.provider === target.provider && candidate.accountId === target.accountId && candidate.home === target.home && !candidate.active && revisionFor(candidate) === revisionFor(target)
      )
      if (!stillInactive) return previous ?? idleSnapshot(provider, target)
    }
    const result = this.applyPolicy(target, received, previous, Date.now())
    if (inactive) {
      this.inactiveSnapshots.set(`${target.provider}:${target.accountId}`, result)
    } else {
      this.current.set(provider, result)
    }
    if (received.status === 'ok') {
      this.lastGood.set(cacheKey, result)
      persistUsageSnapshots(this.context.dataDir, this.lastGood)
    } else if (received.status === 'unavailable') {
      this.lastGood.delete(cacheKey)
      persistUsageSnapshots(this.context.dataDir, this.lastGood)
    }
    this.lastStateAt = Date.now()
    this.publish()
    return result
  }

  private applyPolicy(target: UsageTarget, result: ProviderSnapshot, previous: ProviderSnapshot | undefined, now: number): ProviderSnapshot {
    const attached = withTarget(result, target, now)
    if (attached.status === 'ok' || attached.status === 'unavailable') return attached
    const cached = this.lastGood.get(activeTargetKey(target)) ?? previous
    if (!cached || cached.status === 'idle' || cached.status === 'fetching' || cached.updatedAt > now) return attached
    const staleWindow = attached.usageMetadata?.failureKind === 'rate-limited' ? RATE_LIMIT_STALE_MS : FRESH_ERROR_MS
    if (now - cached.updatedAt > staleWindow) return attached
    const stale = withTarget({
      ...cached,
      status: 'error',
      error: attached.error,
      usageMetadata: {
        ...cached.usageMetadata,
        ...attached.usageMetadata,
        ...(cached.usageMetadata?.lastSuccessfulSource || cached.usageMetadata?.source
          ? { lastSuccessfulSource: cached.usageMetadata.lastSuccessfulSource ?? cached.usageMetadata.source }
          : {})
      }
    }, target, now)
    return stale
  }

  private async consumeResetCreditInScope(options: ResetCreditConsumeOptions): Promise<unknown> {
    if (typeof options.idempotencyKey !== 'string' || !options.idempotencyKey.trim()) throw new Error('Codex reset idempotency key is required')
    if (!options.expectedScope || !Number.isFinite(options.expectedScope.accountRevision) || !options.expectedScope.offerRevision) throw new Error('Codex reset scope is invalid')
    if (options.yes !== true) return { confirmationRequired: true, expectedScope: clone(options.expectedScope) }

    const key = resetIdKey(options.idempotencyKey)
    const existing = this.ledger.get(key)
    if (existing && !sameScope(existing.scope, options.expectedScope)) throw new Error('Codex reset idempotency key is already bound to another offer')
    if (existing?.status === 'completed' && existing.outcome) return existing.outcome
    if (!existing) {
      this.ledger.set(key, { scope: clone(options.expectedScope), status: 'reserved' })
      persistResetLedger(this.context.dataDir, this.ledger)
    }

    let targets: UsageTarget[]
    try {
      targets = await this.targets()
    } catch {
      throw new Error('Codex reset offer is no longer current')
    }
    this.synchronizeActiveTargets(targets)
    const target = this.selected.get('codex')
    const snapshot = this.current.get('codex')
    const currentScope = snapshot?.rateLimitResetCredits?.expectedScope
    if (!target || snapshot?.status !== 'ok' || !currentScope || !sameScope(options.expectedScope, currentScope) || target.accountId !== options.expectedScope.accountId || revisionFor(target) !== options.expectedScope.accountRevision) {
      throw new Error('Codex reset offer changed; refresh usage and confirm again')
    }
    const controller = new AbortController()
    this.controllers.add(controller)
    let attemptStarted = false
    try {
      const latest = await this.targets()
      const stillSelected = latest.some((candidate) => candidate.provider === 'codex' && candidate.active && candidate.accountId === target.accountId && candidate.home === target.home && revisionFor(candidate) === revisionFor(target))
      if (!stillSelected) throw new Error('Codex reset offer changed; refresh usage and confirm again')
      this.ledger.set(key, { scope: clone(options.expectedScope), status: 'in-flight' })
      persistResetLedger(this.context.dataDir, this.ledger)
      attemptStarted = true
      const outcome = await consumeCodexResetCredit({ processes: this.processes, signal: controller.signal, now: () => Date.now(), fetch: async (url, init, timeout) => {
        const abortController = new AbortController()
        const onAbort = (): void => abortController.abort()
        controller.signal.addEventListener('abort', onAbort, { once: true })
        const timer = setTimeout(onAbort, timeout ?? 30_000)
        try {
          return await fetch(url, { ...init, signal: abortController.signal })
        } finally {
          clearTimeout(timer)
          controller.signal.removeEventListener('abort', onAbort)
        }
      }, run: (program, args, processOptions) => this.processes.run(program, args, { ...processOptions, signal: controller.signal })
      }, target, options.idempotencyKey)
      this.ledger.set(key, { scope: clone(options.expectedScope), status: 'completed', outcome })
      persistResetLedger(this.context.dataDir, this.ledger)
      return outcome
    } catch (error) {
      if (attemptStarted) {
        this.ledger.set(key, { scope: clone(options.expectedScope), status: 'unknown' })
        persistResetLedger(this.context.dataDir, this.ledger)
      }
      throw error
    } finally {
      this.controllers.delete(controller)
    }
  }

  private async wait(ms: number): Promise<void> {
    if (this.closed) return
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, ms))
  }

  private publish(): void {
    this.lastStateAt = Date.now()
    try {
      this.context.emit('usageChanged', this.state())
    } catch {
      // The usage state remains available to direct method reads if no event consumer is attached.
    }
  }
}
