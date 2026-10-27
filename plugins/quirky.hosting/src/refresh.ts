import type { Handler, HostingEnv, Scope } from './env'
import { isRecord, nonEmptyString, parseBranch, parseIdentity, parseOid, parsePositiveInteger, sameIdentity, type IdentityValue } from './pr-data'
import type { Lookup, Review } from './pr-review'

export type RefreshReason = 'visible' | 'active' | 'post-push' | 'manual' | 'swr'
type RefreshCandidate = { worktree: string; branch?: string; number?: number; headOid?: string; active?: boolean }
type ResolvedCandidate = { candidate: RefreshCandidate; scope: Scope; key: string; budgetKey: string; ownerKey: string }
type Owner = { generation: number; candidates: Map<string, ResolvedCandidate>; removeClose: () => void }
type RefreshEvent = {
  sequence: number
  worktreeId: string | null
  repoId: string | null
  reason: RefreshReason
  aliases: string[]
  status?: 'queued' | 'in-flight' | 'paused' | 'skipped'
  skippedReason?: 'fresh' | 'not-git' | 'bare' | 'archived' | 'disconnected' | 'remote' | 'rate-limit' | 'capacity'
  pausedUntil?: number
  requestStartedAt?: number
  outcome?: unknown
}
type QueueEntry = {
  key: string
  candidate: RefreshCandidate
  scope: Scope
  budgetKey: string
  owners: Set<string>
  reason: RefreshReason
  priority: number
  bypassFreshness: boolean
  bypassBackgroundBudget: boolean
  queuedAt: number
  dueAt: number
  aliases: Set<string>
  sequence: number
}
type OutcomeState = { outcome: Lookup; fetchedAt: number }
type DirectOutcome =
  | { kind: 'completed'; outcome: Lookup; stale: boolean }
  | { kind: 'paused'; pausedUntil: number; skippedReason: 'rate-limit' }
type RetryState = { failures: number; nextTryAt: number; retryDisabledUntil?: number }
type StartHistory = Map<string, number[]>

const BACKGROUND_WINDOW_MS = 5 * 60_000
const BACKGROUND_MAX_STARTS = 20
const BACKGROUND_MIN_SPACING_MS = 10_000
const ACTIVE_WINDOW_MS = 30_000
const ACTIVE_MAX_STARTS = 3
const REFRESH_COOLDOWN_MS = 10_000
const POST_PUSH_DELAY_MS = 2_500
const PENDING_MERGEABILITY_DELAY_MS = 2_500
const FAILURE_BASE_MS = 60_000
const FAILURE_MAX_MS = 15 * 60_000
const VALIDATION_BACKOFF_MS = 5 * 60_000
const MAX_TRACKED = 1_000
const MAX_CANDIDATES = 1_000
const MAX_VALIDATION_BACKOFF = 256

function inputError(env: HostingEnv, message: string): never {
  throw env.invalid('validation_error', message)
}

function parseReason(env: HostingEnv, value: unknown, fallback: RefreshReason = 'manual'): RefreshReason {
  if (value === undefined) return fallback
  if (value === 'visible' || value === 'active' || value === 'post-push' || value === 'manual' || value === 'swr') return value
  return inputError(env, 'reason must be visible, active, post-push, manual, or swr.')
}

function parseCandidate(env: HostingEnv, value: unknown): RefreshCandidate {
  if (!isRecord(value)) return inputError(env, 'candidate must be an object.')
  const allowed = new Set(['worktree', 'branch', 'number', 'headOid', 'active'])
  if (Object.keys(value).some((key) => !allowed.has(key))) return inputError(env, 'candidate contains unsupported fields.')
  const worktree = nonEmptyString(value.worktree)
  const branch = value.branch === undefined ? undefined : parseBranch(value.branch)
  const number = value.number === undefined ? undefined : parsePositiveInteger(value.number)
  const headOid = value.headOid === undefined ? undefined : parseOid(value.headOid)
  const active = value.active === undefined ? undefined : value.active
  if (!worktree) return inputError(env, 'candidate.worktree must identify a registered worktree.')
  if (value.branch !== undefined && !branch) return inputError(env, 'candidate.branch must be a valid branch name.')
  if (value.number !== undefined && !number) return inputError(env, 'candidate.number must be a positive integer.')
  if (value.headOid !== undefined && !headOid) return inputError(env, 'candidate.headOid must be a 40- or 64-character hexadecimal commit SHA.')
  if (active !== undefined && typeof active !== 'boolean') return inputError(env, 'candidate.active must be a boolean.')
  if (!branch && !number) return inputError(env, 'candidate must include a branch or pull request number.')
  return { worktree, ...(branch ? { branch } : {}), ...(number ? { number } : {}), ...(headOid ? { headOid } : {}), ...(active !== undefined ? { active } : {}) }
}

function identityKey(scope: Scope): string {
  return `${scope.origin.host.toLowerCase()}/${scope.origin.owner.toLowerCase()}/${scope.origin.repo.toLowerCase()}`
}

function budgetKey(scope: Scope): string {
  const account = scope.binding ? `${scope.binding.host.toLowerCase()}/${scope.binding.user.toLowerCase()}` : 'ambient'
  return `${scope.origin.host.toLowerCase()}|${account}`
}

function normalizedCandidate(scope: Scope, candidate: RefreshCandidate): RefreshCandidate {
  const branch = candidate.branch ?? parseBranch(scope.worktree.branch)
  return { worktree: scope.worktree.id, ...(branch ? { branch } : {}), ...(candidate.number ? { number: candidate.number } : {}),
    ...(candidate.headOid ? { headOid: candidate.headOid } : {}), ...(candidate.active !== undefined ? { active: candidate.active } : {}) }
}

function candidateKey(scope: Scope, candidate: RefreshCandidate): string {
  const review = candidate.number ? `pr:${candidate.number}` : `branch:${candidate.branch?.toLowerCase() ?? ''}`
  return `${scope.worktree.repoId}:${identityKey(scope)}:${review}`
}

function ownerKey(caller: Parameters<Handler>[1]): string | undefined {
  if (caller.role === 'plugin') return undefined
  return caller.connection ? String(caller.connection.id) : undefined
}

function safeOutcome(value: unknown): Lookup | undefined {
  if (!isRecord(value) || typeof value.fetchedAt !== 'number' || !Number.isFinite(value.fetchedAt)) return undefined
  if (value.kind === 'no-review') return { kind: 'no-review', fetchedAt: value.fetchedAt }
  if (value.kind === 'unavailable' && typeof value.reason === 'string' && typeof value.message === 'string') {
    return {
      kind: 'unavailable',
      reason: value.reason,
      message: value.message,
      fetchedAt: value.fetchedAt,
      ...(typeof value.retryDisabledUntil === 'number' && Number.isFinite(value.retryDisabledUntil) ? { retryDisabledUntil: value.retryDisabledUntil } : {}),
      ...(typeof value.nextAutoRetryAt === 'number' && Number.isFinite(value.nextAutoRetryAt) ? { nextAutoRetryAt: value.nextAutoRetryAt } : {})
    }
  }
  if (value.kind !== 'found' || !isRecord(value.review)) return undefined
  const source = value.review
  const number = parsePositiveInteger(source.number)
  const url = typeof source.url === 'string' ? source.url : undefined
  const title = typeof source.title === 'string' ? source.title : undefined
  const body = typeof source.body === 'string' ? source.body : undefined
  const state = source.state === 'open' || source.state === 'draft' || source.state === 'closed' || source.state === 'merged'
    ? source.state
    : undefined
  const mergeable = source.mergeable === 'MERGEABLE' || source.mergeable === 'CONFLICTING' || source.mergeable === 'UNKNOWN'
    ? source.mergeable
    : undefined
  const checksStatus = source.checksStatus === 'neutral' || source.checksStatus === 'pending' ||
    source.checksStatus === 'success' || source.checksStatus === 'failure' ? source.checksStatus : undefined
  const headRefName = parseBranch(source.headRefName)
  const baseRefName = parseBranch(source.baseRefName)
  const headRefOid = parseOid(source.headRefOid)
  const baseRefOid = parseOid(source.baseRefOid)
  const reviewDecision = typeof source.reviewDecision === 'string' ? source.reviewDecision : undefined
  const mergeStateStatus = typeof source.mergeStateStatus === 'string' ? source.mergeStateStatus : undefined
  if (source.provider !== 'github' || !number || !url || title === undefined || body === undefined ||
    !state || !mergeable || !checksStatus || !headRefName || !baseRefName || !headRefOid || !baseRefOid ||
    reviewDecision === undefined || mergeStateStatus === undefined ||
    !Object.hasOwn(source, 'autoMergeRequest') || !Object.hasOwn(source, 'stack') || !Object.hasOwn(source, 'mergeMethods')) return undefined
  const review: Review = {
    provider: 'github',
    number,
    url,
    title,
    body,
    state,
    headRefName,
    baseRefName,
    headRefOid,
    baseRefOid,
    mergeable,
    checksStatus,
    reviewDecision,
    mergeStateStatus,
    autoMergeRequest: source.autoMergeRequest,
    stack: source.stack,
    mergeMethods: source.mergeMethods
  }
  if (isRecord(source.headRepositoryOwner) && typeof source.headRepositoryOwner.login === 'string') {
    review.headRepositoryOwner = { login: source.headRepositoryOwner.login }
  }
  const headRepository = source.headRepository
  if (isRecord(headRepository) && typeof headRepository.name === 'string') {
    const repository: { name: string; owner?: { login: string } } = { name: headRepository.name }
    if (isRecord(headRepository.owner) && typeof headRepository.owner.login === 'string') {
      repository.owner = { login: headRepository.owner.login }
    }
    review.headRepository = repository
  }
  return { kind: 'found', review, fetchedAt: value.fetchedAt }
}

function retryUntil(outcome: Lookup): number | undefined {
  return outcome.kind === 'unavailable' ? outcome.retryDisabledUntil : undefined
}

function isBackground(reason: RefreshReason, bypass: boolean): boolean {
  return !bypass && (reason === 'visible' || reason === 'swr')
}

function isActiveRequest(reason: RefreshReason, candidate: RefreshCandidate, priority: number): boolean {
  return reason === 'active' || (reason === 'visible' && candidate.active === true && priority >= 80)
}

function freshness(outcome: Lookup | undefined, active: boolean): number {
  if (!outcome) return 0
  if (outcome.kind === 'unavailable') return 0
  if (outcome.kind === 'no-review') return active ? 60_000 : 15 * 60_000
  const review = outcome.review
  if (review.state === 'merged') return review.checksStatus === 'pending' ? 60_000 : Number.POSITIVE_INFINITY
  if (review.state === 'closed') return 15 * 60_000
  return active ? 60_000 : 120_000
}

function resultHead(outcome: Lookup | undefined): string | undefined {
  return outcome?.kind === 'found' ? outcome.review.headRefOid : undefined
}

export function refreshMethods(env: HostingEnv, prHandlers: Record<string, Handler>): Record<string, Handler> {
  const owners = new Map<string, Owner>()
  const candidateOwners = new Map<string, Set<string>>()
  const entries = new Map<string, QueueEntry>()
  const inFlightEntries = new Map<string, QueueEntry>()
  const outcomes = new Map<string, OutcomeState>()
  const retry = new Map<string, RetryState>()
  const cooldown = new Map<string, number>()
  const backgroundStarts: StartHistory = new Map()
  const activeStarts: StartHistory = new Map()
  const validationBackoff = new Map<string, number>()
  let sequence = 0
  let draining = false
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined

  const emit = (event: Omit<RefreshEvent, 'sequence' | 'worktreeId' | 'repoId'>, scope?: Scope): void => {
    if (disposed) return
    sequence += 1
    env.context.emit('refresh', { sequence, worktreeId: scope?.worktree.id ?? null, repoId: scope?.worktree.repoId ?? null, ...event })
  }

  const unregisterOwner = (id: string): void => {
    const owner = owners.get(id)
    if (!owner) return
    owner.removeClose()
    for (const [key] of owner.candidates) {
      const ownersForKey = candidateOwners.get(key)
      ownersForKey?.delete(id)
      entries.get(key)?.owners.delete(id)
      inFlightEntries.get(key)?.owners.delete(id)
      if (ownersForKey?.size === 0) {
        candidateOwners.delete(key)
        const entry = entries.get(key)
        if (entry?.reason === 'visible') {
          entries.delete(key)
          emit({ reason: entry.reason, aliases: [...entry.aliases], status: 'skipped', skippedReason: 'disconnected' }, entry.scope)
        }
      }
    }
    for (const entry of entries.values()) entry.owners.delete(id)
    owners.delete(id)
    for (const key of activeStarts.keys()) if (key.startsWith(`${id}|`)) activeStarts.delete(key)
    schedule()
  }

  const registerOwner = (caller: Parameters<Handler>[1]): string => {
    if (caller.role === 'plugin') return inputError(env, 'This refresh method requires an authenticated client connection.')
    const connection = caller.connection
    if (!connection) return inputError(env, 'This refresh method requires an authenticated client connection.')
    const id = String(connection.id)
    if (owners.has(id)) return id
    const owner: Owner = { generation: -1, candidates: new Map(), removeClose: () => {} }
    owners.set(id, owner)
    owner.removeClose = connection.onClose(() => unregisterOwner(id))
    if (!owners.has(id)) return inputError(env, 'The refresh connection has already closed.')
    return id
  }

  const resolveCandidate = async (value: unknown, caller: Parameters<Handler>[1]): Promise<ResolvedCandidate> => {
    const parsed = parseCandidate(env, value)
    const scope = await env.resolve({ worktree: parsed.worktree }, caller)
    if (scope.worktree.kind !== 'git') throw env.invalid('validation_error', 'PR refresh requires a registered Git worktree.')
    const candidates = scope.candidates ?? [scope.origin]
    const origin = parseIdentity(scope.origin)
    const trustsOrigin = origin !== undefined && candidates.some((candidate) => {
      const identity: IdentityValue | undefined = parseIdentity(candidate)
      return identity !== undefined && sameIdentity(identity, origin)
    })
    if (!trustsOrigin) throw env.invalid('unsupported_provider', 'This worktree does not resolve to a configured GitHub repository.')
    const normalized = normalizedCandidate(scope, parsed)
    if (!normalized.branch && !normalized.number) throw env.invalid('validation_error', 'A detached worktree needs an explicit branch or pull request number.')
    return {
      candidate: normalized,
      scope,
      key: candidateKey(scope, normalized),
      budgetKey: budgetKey(scope),
      ownerKey: ownerKey(caller) ?? 'local'
    }
  }

  const callPR = async (resolved: ResolvedCandidate, caller: Parameters<Handler>[1]): Promise<Lookup> => {
    const handler = prHandlers.forBranch
    if (!handler) throw env.invalid('upstream_unavailable', 'Pull request lookup is unavailable.')
    const result = await handler({
      worktree: resolved.candidate.worktree,
      ...(resolved.candidate.branch ? { branch: resolved.candidate.branch } : {}),
      ...(resolved.candidate.number ? { number: resolved.candidate.number } : {}),
      ...(resolved.candidate.headOid ? { headOid: resolved.candidate.headOid } : {}),
      ...(resolved.candidate.active !== undefined ? { active: resolved.candidate.active } : {})
    }, caller)
    const outcome = safeOutcome(result)
    if (!outcome) throw env.invalid('upstream_unavailable', 'Pull request lookup returned an invalid result.')
    return outcome
  }

  const retryDelay = (key: string, outcome: Lookup): void => {
    if (outcome.kind !== 'unavailable') {
      retry.delete(key)
      return
    }
    const now = Date.now()
    const current = retry.get(key) ?? { failures: 0, nextTryAt: 0 }
    current.failures += 1
    const delay = Math.min(FAILURE_BASE_MS * 2 ** Math.min(current.failures - 1, 4), FAILURE_MAX_MS)
    const backoffUntil = now + delay
    current.nextTryAt = Math.max(backoffUntil, outcome.nextAutoRetryAt ?? 0)
    if (outcome.retryDisabledUntil !== undefined) current.retryDisabledUntil = outcome.retryDisabledUntil
    retry.set(key, current)
    pruneBounded(retry)
  }

  const directRefresh = async (resolved: ResolvedCandidate, caller: Parameters<Handler>[1], reason: RefreshReason): Promise<DirectOutcome> => {
    const currentRetry = retry.get(resolved.key)
    if (currentRetry?.retryDisabledUntil && currentRetry.retryDisabledUntil > Date.now()) {
      const pausedUntil = currentRetry.retryDisabledUntil
      emit({ reason, aliases: [resolved.candidate.worktree], status: 'paused', skippedReason: 'rate-limit', pausedUntil }, resolved.scope)
      return { kind: 'paused', pausedUntil, skippedReason: 'rate-limit' }
    }
    const last = outcomes.get(resolved.key)
    const retryAfter = last ? retryUntil(last.outcome) : undefined
    if (retryAfter !== undefined && retryAfter > Date.now()) {
      emit({ reason, aliases: [resolved.candidate.worktree], status: 'paused', skippedReason: 'rate-limit', pausedUntil: retryAfter }, resolved.scope)
      return { kind: 'paused', pausedUntil: retryAfter, skippedReason: 'rate-limit' }
    }
    const requestStartedAt = Date.now()
    cooldown.set(resolved.key, requestStartedAt + REFRESH_COOLDOWN_MS)
    pruneBounded(cooldown)
    const cacheGeneration = env.cacheKey(resolved.scope, `refresh-generation:${resolved.key}`)
    emit({ reason, aliases: [resolved.candidate.worktree], status: 'in-flight', requestStartedAt }, resolved.scope)
    let outcome: Lookup
    try {
      outcome = await callPR(resolved, caller)
    } catch {
      outcome = { kind: 'unavailable', reason: 'upstream_unavailable', message: 'GitHub pull request refresh failed.', fetchedAt: Date.now() }
    }
    if (disposed) return { kind: 'completed', outcome, stale: true }
    if (cacheGeneration !== env.cacheKey(resolved.scope, `refresh-generation:${resolved.key}`)) {
      emit({ reason, aliases: [resolved.candidate.worktree], outcome }, resolved.scope)
      return { kind: 'completed', outcome, stale: true }
    }
    const fetchedAt = Date.now()
    outcomes.set(resolved.key, { outcome, fetchedAt })
    pruneBounded(outcomes)
    retryDelay(resolved.key, outcome)
    if (reason === 'manual' && outcome.kind === 'found' && outcome.review.state === 'open' && outcome.review.mergeable === 'UNKNOWN' &&
      !['CLEAN', 'BEHIND', 'BLOCKED'].includes(outcome.review.mergeStateStatus)) {
      const followUp = queue(resolved, 'swr', 40, resolved.ownerKey)
      followUp.bypassFreshness = true
      followUp.dueAt = Math.max(followUp.dueAt, fetchedAt + PENDING_MERGEABILITY_DELAY_MS)
    }
    emit({ reason, aliases: [resolved.candidate.worktree], outcome }, resolved.scope)
    return { kind: 'completed', outcome, stale: false }
  }

  const makeEntry = (resolved: ResolvedCandidate, reason: RefreshReason, priority: number, owner?: string): QueueEntry => {
    const now = Date.now()
    const bypassFreshness = reason === 'manual' || reason === 'active' || reason === 'post-push'
    const bypassBackgroundBudget = reason === 'active' || (reason === 'visible' && resolved.candidate.active === true && priority >= 80)
    const dueAt = now + (reason === 'post-push' ? POST_PUSH_DELAY_MS : 0)
    const entry: QueueEntry = {
      key: resolved.key,
      candidate: resolved.candidate,
      scope: resolved.scope,
      budgetKey: resolved.budgetKey,
      owners: new Set(owner ? [owner] : []),
      reason,
      priority,
      bypassFreshness,
      bypassBackgroundBudget,
      queuedAt: now,
      dueAt,
      aliases: new Set([resolved.candidate.worktree]),
      sequence: sequence + 1
    }
    return entry
  }

  const queue = (resolved: ResolvedCandidate, reason: RefreshReason, priority: number, owner?: string): QueueEntry => {
    const existing = entries.get(resolved.key)
    if (!existing) {
      const entry = makeEntry(resolved, reason, priority, owner)
      if (entries.size >= MAX_TRACKED) {
        emit({ reason, aliases: [...entry.aliases], status: 'skipped', skippedReason: 'capacity' }, entry.scope)
        return entry
      }
      entries.set(entry.key, entry)
      const wait = entryDelay(entry, Date.now())
      if (wait >= 1_000 && wait <= 5_000 && !isBackground(reason, entry.bypassBackgroundBudget) && !isActiveRequest(reason, entry.candidate, priority)) {
        emit({ reason, aliases: [...entry.aliases], status: 'queued' }, entry.scope)
      }
      schedule()
      return entry
    }
    existing.aliases.add(resolved.candidate.worktree)
    if (owner) existing.owners.add(owner)
    if (priority > existing.priority || (isImmediateReason(reason) && !isImmediateReason(existing.reason))) {
      existing.reason = reason
      existing.priority = priority
      existing.bypassFreshness = reason === 'manual' || reason === 'active' || reason === 'post-push'
      existing.bypassBackgroundBudget = reason === 'active' || (reason === 'visible' && resolved.candidate.active === true && priority >= 80)
    }
    existing.dueAt = Math.min(existing.dueAt, reason === 'post-push' ? Date.now() + POST_PUSH_DELAY_MS : Date.now())
    schedule()
    return existing
  }

  function isImmediateReason(reason: RefreshReason): boolean {
    return reason === 'manual' || reason === 'active' || reason === 'post-push'
  }

  function purgeHistory(history: StartHistory, key: string, window: number, now: number): number[] {
    const kept = (history.get(key) ?? []).filter((started) => now - started < window)
    if (kept.length > 0) history.set(key, kept)
    else history.delete(key)
    return kept
  }

  function nextPacingTime(entry: QueueEntry, now: number): number | undefined {
    const active = isActiveRequest(entry.reason, entry.candidate, entry.priority)
    if (active) {
      const key = `${entry.owners.values().next().value ?? 'local'}|${entry.budgetKey}`
      const starts = purgeHistory(activeStarts, key, ACTIVE_WINDOW_MS, now)
      if (starts.length >= ACTIVE_MAX_STARTS) return starts[0]! + ACTIVE_WINDOW_MS
      return undefined
    }
    if (!isBackground(entry.reason, entry.bypassBackgroundBudget)) return undefined
    const starts = purgeHistory(backgroundStarts, entry.budgetKey, BACKGROUND_WINDOW_MS, now)
    if (starts.length >= BACKGROUND_MAX_STARTS) return starts[0]! + BACKGROUND_WINDOW_MS
    const last = starts.at(-1)
    if (last !== undefined && now - last < BACKGROUND_MIN_SPACING_MS) return last + BACKGROUND_MIN_SPACING_MS
    return undefined
  }

  function freshnessTime(entry: QueueEntry): number | undefined {
    if (entry.bypassFreshness) return undefined
    const cached = outcomes.get(entry.key)
    if (!cached) return undefined
    if (entry.candidate.headOid && resultHead(cached.outcome) && entry.candidate.headOid.toLowerCase() !== resultHead(cached.outcome)!.toLowerCase()) return undefined
    const interval = freshness(cached.outcome, entry.candidate.active === true)
    if (!Number.isFinite(interval)) return Number.POSITIVE_INFINITY
    return cached.fetchedAt + interval
  }

  const entryDelay = (entry: QueueEntry, now: number): number => {
    const retryState = retry.get(entry.key)
    const cooldownUntil = cooldown.get(entry.key) ?? 0
    const freshUntil = freshnessTime(entry)
    const delays = [entry.dueAt, retryState?.retryDisabledUntil ?? 0]
    if (entry.reason !== 'manual') delays.push(retryState?.nextTryAt ?? 0)
    if (!isImmediateReason(entry.reason)) delays.push(cooldownUntil, freshUntil ?? 0)
    const pacing = nextPacingTime(entry, now)
    if (pacing !== undefined) delays.push(pacing)
    const dueAt = Math.max(...delays)
    return Math.max(0, dueAt - now)
  }

  function selectEntry(now: number): { entry?: QueueEntry; nextDelay?: number } {
    const due = [...entries.values()].sort((left, right) => {
      if (left.priority !== right.priority) return right.priority - left.priority
      const leftScope = isActiveRequest(left.reason, left.candidate, left.priority)
        ? `${left.owners.values().next().value ?? 'local'}|${left.budgetKey}`
        : left.budgetKey
      const rightScope = isActiveRequest(right.reason, right.candidate, right.priority)
        ? `${right.owners.values().next().value ?? 'local'}|${right.budgetKey}`
        : right.budgetKey
      if (leftScope === rightScope && left.queuedAt !== right.queuedAt) return right.queuedAt - left.queuedAt
      return left.dueAt - right.dueAt
    })
    let best: QueueEntry | undefined
    let bestDelay = Number.POSITIVE_INFINITY
    for (const entry of due) {
      if (entry.reason === 'visible' && entry.owners.size === 0 && (candidateOwners.get(entry.key)?.size ?? 0) === 0) {
        entries.delete(entry.key)
        emit({ reason: entry.reason, aliases: [...entry.aliases], status: 'skipped', skippedReason: 'fresh' }, entry.scope)
        continue
      }
      const delay = entryDelay(entry, now)
      if (!Number.isFinite(delay)) {
        entries.delete(entry.key)
        emit({ reason: entry.reason, aliases: [...entry.aliases], status: 'skipped', skippedReason: 'fresh' }, entry.scope)
        continue
      }
      if (delay === 0) return { entry }
      if (delay < bestDelay) {
        bestDelay = delay
        best = entry
      }
    }
    return best ? { nextDelay: bestDelay } : {}
  }

  async function drain(): Promise<void> {
    if (draining || disposed) return
    draining = true
    try {
      while (!disposed) {
        const selected = selectEntry(Date.now())
        if (!selected.entry) {
          if (selected.nextDelay !== undefined) schedule(selected.nextDelay)
          break
        }
        const entry = selected.entry
        entries.delete(entry.key)
        const now = Date.now()
        const active = isActiveRequest(entry.reason, entry.candidate, entry.priority)
        if (active) {
          const owner = entry.owners.values().next().value ?? 'local'
          const key = `${owner}|${entry.budgetKey}`
          const starts = purgeHistory(activeStarts, key, ACTIVE_WINDOW_MS, now)
          starts.push(now)
          activeStarts.set(key, starts)
          pruneBounded(activeStarts)
        } else if (isBackground(entry.reason, entry.bypassBackgroundBudget)) {
          const starts = purgeHistory(backgroundStarts, entry.budgetKey, BACKGROUND_WINDOW_MS, now)
          starts.push(now)
          backgroundStarts.set(entry.budgetKey, starts)
          pruneBounded(backgroundStarts)
        }
        inFlightEntries.set(entry.key, entry)
        try {
          const resolved: ResolvedCandidate = {
            candidate: entry.candidate,
            scope: entry.scope,
            key: entry.key,
            budgetKey: entry.budgetKey,
            ownerKey: entry.owners.values().next().value ?? 'local'
          }
          const result = await directRefresh(resolved, { role: 'plugin', pluginId: 'quirky.hosting' }, entry.reason)
          if (disposed) continue
          if (entry.reason === 'visible' && (candidateOwners.get(entry.key)?.size ?? 0) === 0) {
            emit({ reason: entry.reason, aliases: [...entry.aliases], status: 'skipped', skippedReason: 'disconnected' }, entry.scope)
            continue
          }
          if (result.kind === 'paused') {
            entry.dueAt = result.pausedUntil
            entries.set(entry.key, entry)
            continue
          }
          if (result.stale) continue
          const outcome = result.outcome
          if (outcome.kind === 'unavailable') {
            const retryState = retry.get(entry.key)
            if (retryState) {
              entry.dueAt = Math.max(retryState.nextTryAt, retryState.retryDisabledUntil ?? 0)
              entries.set(entry.key, entry)
            }
            continue
          }
          if (entries.has(entry.key)) continue
          const visibleOwners = candidateOwners.get(entry.key)
          const shouldRepeat = entry.reason === 'visible' || entry.reason === 'swr' || (entry.reason === 'active' && entry.owners.size > 0)
          if (!shouldRepeat || (entry.reason === 'visible' && (!visibleOwners || visibleOwners.size === 0))) continue
          const interval = freshness(outcome, entry.candidate.active === true)
          if (!Number.isFinite(interval)) continue
          const next = makeEntry(resolved, entry.reason, entry.priority)
          next.dueAt = Date.now() + interval
          next.aliases = new Set(entry.aliases)
          next.owners = new Set(visibleOwners ?? entry.owners)
          entries.set(next.key, next)
        } finally {
          inFlightEntries.delete(entry.key)
        }
      }
    } finally {
      draining = false
    }
  }

  function schedule(delay = 0): void {
    if (disposed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      void drain()
    }, Math.max(0, Math.min(delay, 2_147_000_000)))
  }

  function deniedKey(candidate: RefreshCandidate, reason: string): string {
    return `${candidate.worktree}:${candidate.branch ?? candidate.number ?? ''}:${reason}`
  }

  function pruneBounded<T>(map: Map<string, T>, limit = MAX_TRACKED): void {
    while (map.size > limit) {
      const first = map.keys().next().value
      if (first === undefined) return
      map.delete(first)
    }
  }

  const enqueueRefresh: Handler = async (params, caller) => {
    const owner = registerOwner(caller)
    const candidate = parseCandidate(env, params.candidate)
    const reason = parseReason(env, params.reason, 'visible')
    const priorityValue = params.priority
    if (priorityValue !== undefined && (typeof priorityValue !== 'number' || !Number.isSafeInteger(priorityValue) || priorityValue < 0 || priorityValue > 100)) {
      inputError(env, 'priority must be an integer from 0 to 100.')
    }
    const priority = typeof priorityValue === 'number' ? priorityValue : reason === 'active' ? 80 : reason === 'post-push' ? 100 : 40
    const denyKey = deniedKey(candidate, reason)
    const deniedUntil = validationBackoff.get(denyKey)
    if (deniedUntil && deniedUntil > Date.now()) return { kind: 'skipped', skippedReason: 'validation-backoff' }
    let resolved: ResolvedCandidate
    try {
      resolved = await resolveCandidate(candidate, caller)
    } catch {
      validationBackoff.set(denyKey, Date.now() + VALIDATION_BACKOFF_MS)
      pruneBounded(validationBackoff, MAX_VALIDATION_BACKOFF)
      emit({ reason, aliases: [candidate.worktree], status: 'skipped', skippedReason: 'remote' })
      return { kind: 'skipped', skippedReason: 'validation-denied' }
    }
    if (!owners.has(owner)) return { kind: 'skipped', skippedReason: 'validation-denied' }
    const entry = queue(resolved, reason, priority, owner)
    if (entries.get(entry.key) !== entry) return { kind: 'skipped', skippedReason: 'capacity' }
    return { kind: 'queued' }
  }

  const visibleRefreshCandidates: Handler = async (params, caller) => {
    const ownerId = registerOwner(caller)
    const generation = params.generation
    const values = params.candidates
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) inputError(env, 'generation must be a nonnegative safe integer.')
    if (!Array.isArray(values) || values.length > MAX_CANDIDATES) inputError(env, `candidates must be an array of at most ${MAX_CANDIDATES} entries.`)
    const owner = owners.get(ownerId)
    if (!owner) inputError(env, 'The refresh connection has already closed.')
    if (generation <= owner.generation) return { accepted: false, generation: owner.generation, candidates: owner.candidates.size }

    const resolved = await Promise.all(values.map((value) => resolveCandidate(parseCandidate(env, value), caller)))
    if (owners.get(ownerId) !== owner) inputError(env, 'The refresh connection has already closed.')
    const next = new Map<string, ResolvedCandidate>()
    for (const candidate of resolved) next.set(candidate.key, candidate)
    const removedLastOwners = [...owner.candidates.keys()].filter((key) => !next.has(key) && candidateOwners.get(key)?.size === 1).length
    const newKeys = [...next.keys()].filter((key) => !candidateOwners.has(key)).length
    if (candidateOwners.size - removedLastOwners + newKeys > MAX_TRACKED) inputError(env, 'The refresh candidate set exceeds the queue capacity.')
    for (const key of owner.candidates.keys()) {
      if (next.has(key)) continue
      const currentOwners = candidateOwners.get(key)
      currentOwners?.delete(ownerId)
      entries.get(key)?.owners.delete(ownerId)
      if (currentOwners?.size === 0) {
        candidateOwners.delete(key)
        const queued = entries.get(key)
        if (queued?.reason === 'visible') {
          entries.delete(key)
          emit({ reason: queued.reason, aliases: [...queued.aliases], status: 'skipped', skippedReason: 'fresh' }, queued.scope)
        }
      }
    }
    owner.generation = generation
    owner.candidates = next
    for (const [key, candidate] of next) {
      const set = candidateOwners.get(key) ?? new Set<string>()
      set.add(ownerId)
      candidateOwners.set(key, set)
      const freshnessProbe = makeEntry(candidate, 'visible', 40, ownerId)
      const freshUntil = freshnessTime(freshnessProbe)
      if (freshUntil === Number.POSITIVE_INFINITY) {
        emit({ reason: 'visible', aliases: [candidate.candidate.worktree], status: 'skipped', skippedReason: 'fresh' }, candidate.scope)
        continue
      }
      const entry = queue(candidate, 'visible', 40, ownerId)
      entry.owners = new Set(set)
      entry.bypassBackgroundBudget = candidate.candidate.active === true && entry.priority >= 80
      if (freshUntil !== undefined && freshUntil > Date.now()) entry.dueAt = Math.max(entry.dueAt, freshUntil)
    }
    schedule()
    return { accepted: true, generation, candidates: next.size }
  }

  const refresh: Handler = async (params, caller) => {
    const owner = registerOwner(caller)
    const candidate = parseCandidate(env, params.candidate)
    const reason = parseReason(env, params.reason, 'manual')
    const priorityValue = params.priority
    if (priorityValue !== undefined && (typeof priorityValue !== 'number' || !Number.isSafeInteger(priorityValue) || priorityValue < 0 || priorityValue > 100)) {
      inputError(env, 'priority must be an integer from 0 to 100.')
    }
    const priority = typeof priorityValue === 'number' ? priorityValue : reason === 'active' ? 80 : reason === 'post-push' ? 100 : 40
    const resolved = await resolveCandidate(candidate, caller)
    if (!owners.has(owner)) return { kind: 'unavailable', reason: 'validation_error', message: 'The refresh connection has already closed.', fetchedAt: Date.now() }
    if (reason === 'post-push' || reason === 'visible' || reason === 'swr') {
      const entry = queue(resolved, reason, priority, owner)
      if (entries.get(entry.key) !== entry) return { kind: 'skipped', skippedReason: 'capacity' }
      return { kind: 'queued', ...(reason === 'post-push' ? { sequence: entry.sequence, dueAt: entry.dueAt } : {}) }
    }
    if (reason === 'active') {
      const key = `${owner}|${resolved.budgetKey}`
      const starts = purgeHistory(activeStarts, key, ACTIVE_WINDOW_MS, Date.now())
      if (starts.length >= ACTIVE_MAX_STARTS) {
        const entry = queue(resolved, reason, priority, owner)
        if (entries.get(entry.key) !== entry) return { kind: 'skipped', skippedReason: 'capacity' }
        entry.dueAt = Math.max(entry.dueAt, starts[0]! + ACTIVE_WINDOW_MS)
        schedule(entry.dueAt - Date.now())
        return { kind: 'queued', dueAt: entry.dueAt }
      }
      starts.push(Date.now())
      activeStarts.set(key, starts)
      pruneBounded(activeStarts)
    }
    const result = await directRefresh(resolved, caller, reason)
    return result.kind === 'completed' ? result.outcome : result
  }

  const refreshState: Handler = async (_params, caller) => {
    const owner = registerOwner(caller)
    const now = Date.now()
    let backgroundCount = 0
    let activeCount = 0
    for (const budget of backgroundStarts.keys()) {
      backgroundCount += purgeHistory(backgroundStarts, budget, BACKGROUND_WINDOW_MS, now).length
    }
    for (const activeKey of activeStarts.keys()) {
      if (activeKey.startsWith(`${owner}|`)) activeCount += purgeHistory(activeStarts, activeKey, ACTIVE_WINDOW_MS, now).length
    }
    return {
      queued: entries.size,
      visibleCandidates: candidateOwners.size,
      inFlight: inFlightEntries.size,
      budgets: { backgroundStarts: backgroundCount, activeStarts: activeCount },
      owners: owners.size
    }
  }

  env.onDispose(() => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    for (const owner of owners.values()) owner.removeClose()
    owners.clear()
    candidateOwners.clear()
    entries.clear()
    inFlightEntries.clear()
    outcomes.clear()
    retry.clear()
    cooldown.clear()
    backgroundStarts.clear()
    activeStarts.clear()
    validationBackoff.clear()
  })

  return { refresh, enqueueRefresh, visibleRefreshCandidates, refreshState }
}
