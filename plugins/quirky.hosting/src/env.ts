import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { isAbsolute } from 'node:path'
import { promisify } from 'node:util'
import type { PluginCaller, PluginContext, PluginErrorKind, Worktree } from '@quirky/protocol'
import { isHost, type AuthAccount } from './auth-inventory'
import { isRecord } from './data'
import { parseRemoteIdentity, resolveTrustedIdentity } from './identity-remote'
import { createRuntimeRunner, type RateLimitSnapshot, type RuntimeRunner } from './runtime-runner'

const execFileAsync = promisify(execFile)
export type IssueSourcePreference = 'auto' | 'origin' | 'upstream'
function isPreference(value: unknown): value is IssueSourcePreference {
  return value === 'auto' || value === 'origin' || value === 'upstream'
}


export type Handler = (params: Record<string, unknown>, caller: PluginCaller) => unknown
export type Identity = { host: string; owner: string; repo: string }
export type Scope = {
  worktree: Worktree
  origin: Identity
  repository: Identity
  binding?: { host: string; user: string }
  candidates: Identity[]
  issueRepository: Identity
  issueSourcePreference: IssueSourcePreference
  issueSourceFellBack: boolean
}
export type RunOptions = {
  idempotent?: boolean
  timeoutMs?: number
  maxBytes?: number
  input?: string
  ambient?: boolean
  signal?: AbortSignal
  projectHost?: string
}
export type HostingConfiguration = {
  issueSourcePreference: IssueSourcePreference
  account: { host: string; user: string } | null
}
export type HostingEnv = {
  context: PluginContext
  resolve(params: Record<string, unknown>, caller: PluginCaller): Promise<Scope>
  run(scope: Scope, args: string[], options?: RunOptions): Promise<string>
  json(scope: Scope, args: string[], options?: RunOptions): Promise<unknown>
  rest(scope: Scope, path: string, method?: string, fields?: Record<string, unknown>, options?: RunOptions): Promise<unknown>
  graphql(scope: Scope, query: string, variables?: Record<string, unknown>, options?: RunOptions): Promise<unknown>
  git(scope: Scope, args: string[]): Promise<string>
  changed(scope: Scope, data?: Record<string, unknown>): void
  invalidate(scope: Scope): void
  invalid(reason: string, message: string): Error
  cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T>
  cacheKey(scope: Scope, key: string): string
  authAccounts(scope: Scope, force?: boolean): Promise<AuthAccount[]>
  validateBinding(scope: Scope, binding: { host: string; user: string }): Promise<void>
  rateLimit(scope: Scope, force?: boolean): Promise<RateLimitSnapshot>
  configuration(worktree: Worktree): HostingConfiguration
  saveConfiguration(worktree: Worktree, config: HostingConfiguration): void
  onDispose(callback: () => void): void
  dispose(): Promise<void>
}

type CacheEntry = { value: unknown; expiresAt: number; generation: number; scopeGeneration: number }
type PendingEntry = { promise: Promise<unknown>; generation: number; scopeGeneration: number }

export function createEnv(context: PluginContext): HostingEnv {
  const store = context.openStore([
    `CREATE TABLE IF NOT EXISTS hosting_preferences (
      repo_id TEXT PRIMARY KEY,
      issue_source_preference TEXT NOT NULL DEFAULT 'auto',
      account_host TEXT,
      account_user TEXT
    )`
  ])
  const cacheValues = new Map<string, CacheEntry>()
  const cacheInflight = new Map<string, PendingEntry>()
  const scopeGenerations = new Map<string, number>()
  const disposeCallbacks = new Set<() => void>()
  let generation = 0
  let eventSequence = 0
  let disposed = false

  function invalid(reason: string, message: string): Error {
    return Object.assign(context.error('invalid-params', message), { data: { reason } })
  }

  function reasoned(kind: PluginErrorKind, reason: string, message: string): Error {
    return Object.assign(context.error(kind, message), { data: { reason } })
  }

  function invalidate(scope: Scope): void {
    generation += 1
    const repoId = scope.worktree.repoId
    scopeGenerations.set(repoId, (scopeGenerations.get(repoId) ?? 0) + 1)
    const prefix = `repo:${repoId}|`
    for (const key of cacheValues.keys()) {
      if (key.startsWith(prefix) || !key.startsWith('repo:')) cacheValues.delete(key)
    }
  }

  function changed(scope: Scope, data: Record<string, unknown> = {}): void {
    invalidate(scope)
    eventSequence += 1
    const safeData = safeEventFields(data)
    context.emit('changed', {
      ...safeData,
      worktreeId: scope.worktree.id,
      repoId: scope.worktree.repoId,
      host: scope.repository.host,
      owner: scope.repository.owner,
      repo: scope.repository.repo,
      sequence: eventSequence
    })
  }

  const runtime: RuntimeRunner = createRuntimeRunner(context, invalidate)

  async function resolve(params: Record<string, unknown>, caller: PluginCaller): Promise<Scope> {
    if (disposed) throw reasoned('conflict', 'plugin_inactive', 'The GitHub hosting plugin is shutting down.')
    const requestedSelector = params.worktree
    if (requestedSelector !== undefined && (typeof requestedSelector !== 'string' || requestedSelector.length === 0 || requestedSelector.length > 4096)) {
      throw invalid('invalid_worktree_selector', 'The worktree selector is invalid.')
    }
    const selector = typeof requestedSelector === 'string' ? requestedSelector : 'current'
    const callerSelection = caller.role === 'plugin'
      ? {}
      : {
          ...(caller.cwd !== undefined ? { cwd: caller.cwd } : {}),
          ...(caller.worktreeId !== undefined ? { worktreeId: caller.worktreeId } : {})
        }
    let rawWorktree: unknown
    try {
      rawWorktree = await context.call('quirky.worktree/resolve', { selector, ...callerSelection })
    } catch {
      throw reasoned('not-found', 'worktree_unavailable', 'The selected worktree is not registered or is unavailable.')
    }
    if (!isWorktree(rawWorktree)) throw reasoned('not-found', 'worktree_unavailable', 'The selected worktree is not registered or is unavailable.')
    if (rawWorktree.kind !== 'git') throw invalid('folder_workspace', 'GitHub hosting requires a registered Git worktree.')

    const stored = configuration(rawWorktree)
    const originUrl = await remoteUrl(rawWorktree, 'origin')
    if (originUrl === null) throw reasoned('not-found', 'missing_origin', 'The registered repository has no origin remote.')
    const parsedOrigin = parseRemoteIdentity(originUrl)
    if (!parsedOrigin) throw invalid('unsupported_provider', 'The origin remote is not a supported GitHub repository URL.')
    const provisional = provisionalScope(rawWorktree, parsedOrigin.identity, stored)
    const origin = await resolveTrustedIdentity(parsedOrigin, async () => runtime.authAccounts(provisional))
    if (!origin) throw invalid('unsupported_provider', 'The origin remote is not GitHub.com or a host authenticated by gh.')

    const upstreamUrl = await remoteUrl(rawWorktree, 'upstream')
    let upstream: Identity | null = null
    if (upstreamUrl !== null) {
      const parsedUpstream = parseRemoteIdentity(upstreamUrl)
      if (parsedUpstream) {
        const upstreamScope = provisionalScope(rawWorktree, parsedUpstream.identity, stored)
        upstream = await resolveTrustedIdentity(parsedUpstream, async () => runtime.authAccounts(upstreamScope))
      }
    }

    const originScope = provisionalScope(rawWorktree, origin, stored)
    if (stored.account && stored.account.host !== origin.host) {
      throw invalid('binding_host_mismatch', 'The selected account host does not match this repository.')
    }
    if (stored.issueSourcePreference === 'upstream' && upstreamUrl !== null && upstream === null) {
      throw invalid('unsupported_provider', 'The upstream remote is not an authenticated GitHub repository.')
    }
    const issueSourceFellBack = (stored.issueSourcePreference === 'upstream' && upstreamUrl === null)
      || (stored.issueSourcePreference === 'auto' && upstreamUrl !== null && upstream === null)
    const issueRepository = stored.issueSourcePreference === 'origin'
      ? origin
      : upstream ?? origin
    const candidates = uniqueIdentities([...(upstream ? [upstream] : []), origin])
    return {
      ...originScope,
      origin,
      repository: issueRepository,
      candidates,
      issueRepository,
      issueSourcePreference: stored.issueSourcePreference,
      issueSourceFellBack,
      ...(stored.account ? { binding: stored.account } : {})
    }
  }

  async function git(scope: Scope, args: string[]): Promise<string> {
    if (!Array.isArray(args) || args.length === 0 || args.length > 128 || args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) {
      throw invalid('invalid_git_args', 'The local Git request is invalid.')
    }
    try {
      const result = await execFileAsync('git', args, {
        cwd: scope.worktree.path,
        timeout: 30_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        windowsHide: true
      })
      return result.stdout
    } catch {
      throw reasoned('conflict', 'git_failed', 'The local Git query failed.')
    }
  }

  function cacheKey(scope: Scope, key: string): string {
    const environment = Object.entries(process.env)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => `${name}=${value}`)
      .join('\0')
    const auth = scope.binding ? `${scope.binding.host}:${scope.binding.user}` : 'ambient'
    const scopeGeneration = scopeGenerations.get(scope.worktree.repoId) ?? 0
    const fingerprint = createHash('sha256')
      .update(`${scope.worktree.path}\0${environment}\0${JSON.stringify({ origin: scope.origin, repository: scope.repository, candidates: scope.candidates, issueRepository: scope.issueRepository, issueSourcePreference: scope.issueSourcePreference, issueSourceFellBack: scope.issueSourceFellBack, binding: scope.binding ?? null })}\0${auth}`)
      .digest('hex')
    return `repo:${scope.worktree.repoId}|scope-generation:${scopeGeneration}|worktree:${scope.worktree.id}|${fingerprint}|${key}`
  }

  async function cache<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (disposed) throw reasoned('conflict', 'plugin_inactive', 'The GitHub hosting plugin is shutting down.')
    const now = Date.now()
    const repoId = /^repo:([^|]+)\|/.exec(key)?.[1] ?? ''
    const isScoped = repoId.length > 0
    const currentGeneration = isScoped ? 0 : generation
    const currentScopeGeneration = scopeGenerations.get(repoId) ?? 0
    const cached = cacheValues.get(key)
    if (cached && cached.expiresAt > now && cached.generation === currentGeneration && cached.scopeGeneration === currentScopeGeneration) {
      cacheValues.delete(key)
      cacheValues.set(key, cached)
      return cached.value as T
    }
    const pending = cacheInflight.get(key)
    if (pending && pending.generation === currentGeneration && pending.scopeGeneration === currentScopeGeneration) return pending.promise as Promise<T>

    const promise = Promise.resolve()
      .then(load)
      .then((value) => {
        if (!disposed && currentGeneration === (isScoped ? 0 : generation) && currentScopeGeneration === (scopeGenerations.get(repoId) ?? 0)) {
          cacheValues.set(key, {
            value,
            expiresAt: Date.now() + Math.max(0, Math.min(ttlMs, 60 * 60_000)),
            generation: currentGeneration,
            scopeGeneration: currentScopeGeneration
          })
          while (cacheValues.size > 512) {
            const oldest = cacheValues.keys().next().value
            if (oldest === undefined) break
            cacheValues.delete(oldest)
          }
        }
        return value
      })
      .finally(() => {
        if (cacheInflight.get(key)?.promise === promise) cacheInflight.delete(key)
      })
    cacheInflight.set(key, { promise, generation: currentGeneration, scopeGeneration: currentScopeGeneration })
    return promise
  }

  function onDispose(callback: () => void): void {
    if (disposed) {
      callback()
      return
    }
    disposeCallbacks.add(callback)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    for (const callback of disposeCallbacks) {
      try {
        callback()
      } catch {
        continue
      }
    }
    disposeCallbacks.clear()
    await runtime.dispose()
    cacheValues.clear()
    cacheInflight.clear()
    scopeGenerations.clear()
  }

  return {
    context,
    resolve,
    run: runtime.run,
    json: runtime.json,
    rest: runtime.rest,
    graphql: runtime.graphql,
    git,
    changed,
    invalidate,
    invalid,
    cache,
    cacheKey,
    authAccounts: runtime.authAccounts,
    validateBinding: runtime.validateBinding,
    rateLimit: runtime.rateLimit,
    configuration,
    saveConfiguration,
    onDispose,
    dispose
  }

  function configuration(worktree: Worktree): HostingConfiguration {
    const row: unknown = store.get('SELECT issue_source_preference, account_host, account_user FROM hosting_preferences WHERE repo_id = ?', worktree.repoId)
    if (!isRecord(row)) return { issueSourcePreference: 'auto', account: null }
    const preference = row.issue_source_preference
    if (!isPreference(preference)) throw invalid('invalid_configuration', 'The saved GitHub hosting preference is invalid.')
    const accountHost = row.account_host
    const accountUser = row.account_user
    if (accountHost === null && accountUser === null) return { issueSourcePreference: preference, account: null }
    if (typeof accountHost !== 'string' || !isHost(accountHost) || typeof accountUser !== 'string' || accountUser.length < 1 || accountUser.length > 100 || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(accountUser)) {
      throw invalid('invalid_configuration', 'The saved GitHub account binding is invalid.')
    }
    return { issueSourcePreference: preference, account: { host: accountHost, user: accountUser } }
  }

  function saveConfiguration(worktree: Worktree, config: HostingConfiguration): void {
    store.run(
      `INSERT INTO hosting_preferences(repo_id, issue_source_preference, account_host, account_user)
       VALUES(?, ?, ?, ?)
       ON CONFLICT(repo_id) DO UPDATE SET
         issue_source_preference = excluded.issue_source_preference,
         account_host = excluded.account_host,
         account_user = excluded.account_user`,
      worktree.repoId,
      config.issueSourcePreference,
      config.account?.host ?? null,
      config.account?.user ?? null
    )
  }
}

function provisionalScope(worktree: Worktree, identity: Identity, configuration: HostingConfiguration): Scope {
  const candidates = [identity]
  return {
    worktree,
    origin: identity,
    repository: identity,
    candidates,
    issueRepository: identity,
    issueSourcePreference: configuration.issueSourcePreference,
    issueSourceFellBack: false,
    ...(configuration.account ? { binding: configuration.account } : {})
  }
}

async function remoteUrl(worktree: Worktree, remote: 'origin' | 'upstream'): Promise<string | null> {
  try {
    const result = await execFileAsync('git', ['remote', 'get-url', remote], {
      cwd: worktree.path,
      timeout: 30_000,
      maxBuffer: 64 * 1024,
      encoding: 'utf8',
      windowsHide: true
    })
    const output = result.stdout
    const value = output.trim()
    return value.length > 0 ? value : null
  } catch {
    return null
  }
}

function uniqueIdentities(items: Identity[]): Identity[] {
  const seen = new Set<string>()
  return items.filter((identity) => {
    const key = `${identity.host.toLowerCase()}\0${identity.owner.toLowerCase()}\0${identity.repo.toLowerCase()}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isWorktree(value: unknown): value is Worktree {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && /^wt_[a-f0-9]{12}$/.test(value.id)
    && typeof value.repoId === 'string' && /^repo_[a-f0-9]+$/.test(value.repoId)
    && typeof value.path === 'string' && isAbsolute(value.path)
    && (typeof value.branch === 'string' || value.branch === null)
    && typeof value.head === 'string'
    && typeof value.isMain === 'boolean'
    && typeof value.name === 'string'
    && (value.kind === 'git' || value.kind === 'folder')
    && (typeof value.displayName === 'string' || value.displayName === null)
    && typeof value.comment === 'string'
    && (value.status === 'todo' || value.status === 'in-progress' || value.status === 'in-review' || value.status === 'done')
    && typeof value.pinned === 'boolean'
    && typeof value.unread === 'boolean'
    && (typeof value.parentId === 'string' || value.parentId === null)
    && typeof value.createdAt === 'number'
    && (value.createdBy === 'window' || value.createdBy === 'cli' || value.createdBy === 'api' || value.createdBy === 'external')
    && (typeof value.baseRef === 'string' || value.baseRef === null)
    && typeof value.keepBranch === 'boolean'
    && typeof value.removing === 'boolean'
    && (typeof value.groupId === 'string' || value.groupId === null)
}

function safeEventFields(value: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {}
  for (const [name, field] of Object.entries(value)) {
    if (/token|secret|authorization|stderr|stdout|environment/i.test(name)) continue
    const sanitized = safeEventValue(field, 0)
    if (sanitized !== undefined) output[name] = sanitized
  }
  return output
}

function safeEventValue(value: unknown, depth: number): unknown {
  if (depth > 4) return undefined
  if (typeof value === 'string') return value.length <= 8192 ? value : value.slice(0, 8192)
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value === 'boolean' || value === null) return value
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((entry) => safeEventValue(entry, depth + 1)).filter((entry) => entry !== undefined)
  }
  if (isRecord(value)) return safeEventFields(value)
  return undefined
}
