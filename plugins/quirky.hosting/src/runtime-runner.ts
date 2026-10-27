import { createHash } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { setTimeout as delayTimer, clearTimeout } from 'node:timers'
import type { PluginContext } from '@quirky/protocol'
import type { Identity, RunOptions, Scope } from './env'
import { isRecord } from './data'
import { parseAuthInventory, type AuthAccount } from './auth-inventory'

const GENERAL_OUTPUT_LIMIT = 10 * 1024 * 1024
const LOG_OUTPUT_LIMIT = 64 * 1024 * 1024
const MAX_INPUT_BYTES = 10 * 1024 * 1024
const MAX_CONCURRENT = 4
const RETRY_DELAYS_MS = [250, 1000]
const TOKEN_TTL_MS = 5 * 60_000
const NEGATIVE_TOKEN_TTL_MS = 30_000
const AUTH_INVENTORY_TTL_MS = 60_000
const RATE_LIMIT_TTL_MS = 30_000
const SEARCH_CIRCUIT_MS = 70_000
const CORE_CIRCUIT_MS = 5 * 60_000
const GRAPHQL_CIRCUIT_MS = 5 * 60_000
const MUTATING_HTTP_METHODS: Record<string, true> = { POST: true, PATCH: true, PUT: true, DELETE: true }
const MUTATING_GH_VERBS: Record<string, true> = { create: true, edit: true, update: true, delete: true, close: true, reopen: true, merge: true, comment: true, review: true, ready: true, lock: true, unlock: true, pin: true, unpin: true, transfer: true, develop: true }
const TOKEN_ENV_NAMES = ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN'] as const
const API_FLAGS_WITH_VALUE: Record<string, true> = {
  '--hostname': true, '--repo': true, '-R': true, '-X': true, '--method': true, '--jq': true,
  '--cache': true, '--input': true, '-H': true, '--header': true, '-f': true, '-F': true,
  '--field': true, '--raw-field': true
}

type BucketName = 'core' | 'search' | 'graphql'
type Budget = { limit: number; remaining: number; resetAt: number }
export type RateLimitSnapshot = { core: Budget; search: Budget; graphql: Budget; fetchedAt: number }
type ProcessResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  spawnError?: string
  timedOut: boolean
  outputLimit: boolean
  aborted: boolean
}
type Circuit = { until: number }
type AuthCache = { accounts: AuthAccount[]; expiresAt: number }
type TokenCache = { token: string | null; expiresAt: number }
type CapabilityCache = { supported: boolean | null; expiresAt: number }
type Waiter = { resolve: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; onAbort?: () => void }

export type RuntimeRunner = {
  run(scope: Scope, args: string[], options?: RunOptions): Promise<string>
  json(scope: Scope, args: string[], options?: RunOptions): Promise<unknown>
  rest(scope: Scope, path: string, method?: string, fields?: Record<string, unknown>, options?: RunOptions): Promise<unknown>
  graphql(scope: Scope, query: string, variables?: Record<string, unknown>, options?: RunOptions): Promise<unknown>
  authAccounts(scope: Scope, force?: boolean): Promise<AuthAccount[]>
  validateBinding(scope: Scope, binding: { host: string; user: string }): Promise<void>
  rateLimit(scope: Scope, force?: boolean): Promise<RateLimitSnapshot>
  dispose(): Promise<void>
}

export function createRuntimeRunner(context: PluginContext, invalidateUnknownWrite: (scope: Scope) => void): RuntimeRunner {
  let active = 0
  let disposed = false
  const waiters: Waiter[] = []
  const activeChildren = new Set<ChildProcess>()
  const circuits = new Map<string, Circuit>()
  const budgets = new Map<string, RateLimitSnapshot>()
  const rateLimitCache = new Map<string, { snapshot: RateLimitSnapshot; expiresAt: number }>()
  const rateLimitInflight = new Map<string, Promise<RateLimitSnapshot>>()
  const authCache = new Map<string, AuthCache>()
  const authInflight = new Map<string, Promise<AuthAccount[]>>()
  const tokenCache = new Map<string, TokenCache>()
  const capabilityCache = new Map<string, CapabilityCache>()

  function pluginError(reason: string, message: string, extra: Record<string, unknown> = {}): Error {
    return Object.assign(context.error('conflict', message), { data: { reason, ...extra } })
  }

  function invalidError(reason: string, message: string): Error {
    return Object.assign(context.error('invalid-params', message), { data: { reason } })
  }

  function acquire(signal?: AbortSignal): Promise<() => void> {
    if (disposed) return Promise.reject(pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.'))
    if (signal?.aborted) return Promise.reject(pluginError('cancelled', 'The GitHub request was cancelled.'))
    if (active < MAX_CONCURRENT) {
      active += 1
      return Promise.resolve(makeRelease())
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, ...(signal ? { signal } : {}) }
      if (signal) {
        waiter.onAbort = () => {
          const index = waiters.indexOf(waiter)
          if (index >= 0) waiters.splice(index, 1)
          reject(pluginError('cancelled', 'The GitHub request was cancelled.'))
        }
        signal.addEventListener('abort', waiter.onAbort, { once: true })
      }
      waiters.push(waiter)
    })
  }

  function makeRelease(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      active -= 1
      while (waiters.length > 0) {
        const waiter = waiters.shift()!
        if (waiter.signal?.aborted) {
          if (waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
          waiter.reject(pluginError('cancelled', 'The GitHub request was cancelled.'))
          continue
        }
        if (waiter.onAbort && waiter.signal) waiter.signal.removeEventListener('abort', waiter.onAbort)
        active += 1
        waiter.resolve(makeRelease())
        break
      }
    }
  }

  async function run(scope: Scope, args: string[], options: RunOptions = {}): Promise<string> {
    validateArguments(args, invalidError)
    const target = trustedTarget(scope)
    const pinnedArgs = pinArguments(args, target)
    const isAuthCommand = args[0] === 'auth'
    const rateProbe = isRateLimitProbe(args)
    const bucket = classifyBucket(args)
    const budgetKey = authenticationScopeKey(scope)
    const circuitKey = `${budgetKey}:${bucket}`
    const retryable = isIdempotent(args, options)
    if (!isAuthCommand && !rateProbe) {
      enforceCircuit(circuitKey)
      enforceBudget(budgetKey, bucket, target.host)
    }

    const release = await acquire(options.signal)
    try {
      if (disposed) throw pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.')
      if (!isAuthCommand && !rateProbe) {
        enforceCircuit(circuitKey)
        enforceBudget(budgetKey, bucket, target.host)
      }
      const maxBytes = outputLimitFor(options, args)
      const timeoutMs = timeoutFor(options)
      for (let attempt = 0; ; attempt += 1) {
        if (disposed) throw pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.')
        const childEnv = await environmentFor(scope, options, isAuthCommand)
        if (!isAuthCommand && !rateProbe) noteSpend(budgetKey, bucket)
        const result = await spawnProcess('gh', pinnedArgs, {
          cwd: scope.worktree.path,
          env: childEnv,
          timeoutMs,
          maxBytes,
          input: options.input,
          signal: options.signal
        }, activeChildren)
        if (result.exitCode === 0 && !result.timedOut && !result.outputLimit && !result.aborted) {
          circuits.delete(circuitKey)
          return result.stdout
        }
        const combined = `${result.stderr}\n${result.stdout}`
        if (result.spawnError) throw normalizeFailure(context, result, combined)
        if (args[0] === 'auth' && args[1] === 'status' && result.exitCode !== null
          && (/^Logged in to /m.test(combined) || /not logged in|not logged into any GitHub hosts|no hosts are logged in/i.test(combined))) return combined
        if (args[0] === 'pr' && args[1] === 'checks' && /no checks reported/i.test(combined)) return '[]'

        const failure = classifyFailure(result, combined)
        if (failure.reason === 'rate_limited' && !rateProbe) setCircuit(circuitKey, bucket, failure.retryAfterMs)
        if (failure.reason === 'timeout' && !retryable) invalidateUnknownWrite(scope)
        const canRetry = retryable && isTransient(result, combined) && failure.retryAfterMs === undefined && attempt < RETRY_DELAYS_MS.length
        if (canRetry) {
          try {
            await sleep(RETRY_DELAYS_MS[attempt] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 1000, options.signal)
          } catch {
            throw pluginError('cancelled', 'The GitHub request was cancelled.')
          }
          continue
        }
        const reportedFailure = failure.reason === 'rate_limited' && failure.retryAfterMs === undefined
          ? { ...failure, retryAfterMs: circuitDuration(bucket) }
          : failure
        throw normalizeFailure(context, result, combined, reportedFailure)
      }
    } finally {
      release()
    }
  }

  async function environmentFor(scope: Scope, options: RunOptions, isAuthCommand: boolean): Promise<Record<string, string>> {
    const env = processEnvironment()
    delete env.GH_HOST
    delete env.GH_REPO
    env.GH_PROMPT_DISABLED = env.GH_PROMPT_DISABLED || '1'
    if (isAuthCommand) {
      if (options.ambient === false && scope.binding) stripTokenEnvironment(env)
      return env
    }

    env.GH_HOST = scope.repository.host
    if (options.ambient === true || !scope.binding) return env
    const token = await resolveBoundToken(scope, scope.binding)
    stripTokenEnvironment(env)
    env.GH_TOKEN = token
    return env
  }

  async function resolveBoundToken(scope: Scope, binding: { host: string; user: string }): Promise<string> {
    if (binding.host !== scope.repository.host) throw pluginError('binding_host_mismatch', 'The selected GitHub account does not match this repository host.')
    const key = `${scope.repository.host}:${binding.host}:${binding.user}`
    const cached = tokenCache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      refreshMapLru(tokenCache, key, cached)
      if (cached.token === null) throw pluginError('bound_account_unavailable', 'The selected GitHub account is unavailable.')
      return cached.token
    }

    const capability = await multiAccountCapability(scope)
    if (capability === false) throw pluginError('multi_account_unsupported', 'This GitHub CLI does not support selecting a logged-in account.')
    if (capability === null) throw pluginError('multi_account_capability_unknown', 'Could not verify GitHub CLI account-selection support.')
    if (disposed) throw pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.')
    try {
      const env = processEnvironment()
      stripTokenEnvironment(env)
      delete env.GH_HOST
      delete env.GH_REPO
      env.GH_PROMPT_DISABLED = env.GH_PROMPT_DISABLED || '1'
      const output = await spawnProcess('gh', ['auth', 'token', '--hostname', binding.host, '--user', binding.user], {
        cwd: scope.worktree.path,
        env,
        timeoutMs: 10_000,
        maxBytes: 64 * 1024,
        signal: undefined
      }, activeChildren)
      if (output.exitCode !== 0 || output.timedOut || output.outputLimit || output.spawnError) {
        const failure = classifyFailure(output, `${output.stderr}\n${output.stdout}`)
        const negativeTtl = failure.reason === 'timeout' || failure.reason === 'gh_unavailable' || failure.reason === 'network_error'
          ? 0
          : NEGATIVE_TOKEN_TTL_MS
        if (negativeTtl > 0) tokenCache.set(key, { token: null, expiresAt: Date.now() + negativeTtl })
        throw pluginError('bound_account_unavailable', 'The selected GitHub account token could not be resolved.')
      }
      const token = output.stdout.trim()
      if (!token || token.length > 16_384 || /\s/.test(token)) {
        tokenCache.set(key, { token: null, expiresAt: Date.now() + NEGATIVE_TOKEN_TTL_MS })
        throw pluginError('bound_account_unavailable', 'The selected GitHub account token could not be resolved.')
      }
      tokenCache.set(key, { token, expiresAt: Date.now() + TOKEN_TTL_MS })
      pruneMap(tokenCache, 128)
      return token
    } catch (error) {
      if (error instanceof Error && isReason(error, 'bound_account_unavailable')) throw error
      throw pluginError('bound_account_unavailable', 'The selected GitHub account token could not be resolved.')
    }
  }

  async function multiAccountCapability(scope: Scope): Promise<boolean | null> {
    const key = `${scope.repository.host}|${createHash('sha256').update(`${scope.worktree.path}|${process.env.PATH ?? ''}`).digest('hex')}`
    const cached = capabilityCache.get(key)
    if (cached && cached.expiresAt > Date.now()) return cached.supported
    try {
      if (disposed) throw pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.')
      stripTokenEnvironment(env)
      delete env.GH_HOST
      delete env.GH_REPO
      env.GH_PROMPT_DISABLED = env.GH_PROMPT_DISABLED || '1'
      const result = await spawnProcess('gh', ['auth', 'token', '--help'], {
        cwd: scope.worktree.path,
        env,
        timeoutMs: 10_000,
        maxBytes: 64 * 1024
      }, activeChildren)
      if (result.spawnError || result.timedOut || result.outputLimit || result.exitCode !== 0) {
        capabilityCache.set(key, { supported: null, expiresAt: Date.now() + 60_000 })
        return null
      }
      const supported = /--user(?:\s|,|\[|$)/.test(`${result.stdout}\n${result.stderr}`)
      capabilityCache.set(key, { supported, expiresAt: supported ? Number.MAX_SAFE_INTEGER : Date.now() + 30 * 60_000 })
      pruneMap(capabilityCache, 64)
      return supported
    } catch {
      capabilityCache.set(key, { supported: null, expiresAt: Date.now() + 60_000 })
      return null
    }
  }

  async function authAccounts(scope: Scope, force = false): Promise<AuthAccount[]> {
    const key = authenticationScopeKey(scope)
    const cached = authCache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) {
      refreshMapLru(authCache, key, cached)
      return cached.accounts
    }
    const pending = authInflight.get(key)
    if (!force && pending) return pending
    const loading = run(scope, ['auth', 'status'], { ambient: true })
      .then((output) => {
        const accounts = parseAuthInventory(output)
        authCache.set(key, { accounts, expiresAt: Date.now() + (accounts.length > 0 ? 15 * 60_000 : AUTH_INVENTORY_TTL_MS) })
        pruneMap(authCache, 256)
        return accounts
      })
      .finally(() => {
        if (authInflight.get(key) === loading) authInflight.delete(key)
      })
    authInflight.set(key, loading)
    return loading
  }

  async function validateBinding(scope: Scope, binding: { host: string; user: string }): Promise<void> {
    if (binding.host !== scope.origin.host) throw invalidError('binding_host_mismatch', 'The selected account host does not match this repository.')
    const accounts = await authAccounts(scope, true)
    const account = accounts.find((entry) => entry.host === binding.host && entry.user === binding.user)
    if (!account) throw invalidError('bound_account_unavailable', 'The selected GitHub account is not logged in.')
    if (account.source !== 'keyring') throw invalidError('bound_account_not_keyring', 'Only a GitHub keyring account can be bound to a repository.')
    const release = await acquire()
    try {
      await resolveBoundToken(scope, binding)
    } finally {
      release()
    }
  }

  async function rateLimit(scope: Scope, force = false): Promise<RateLimitSnapshot> {
    const key = authenticationScopeKey(scope)
    const cached = rateLimitCache.get(key)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.snapshot
    const pending = rateLimitInflight.get(key)
    if (!force && pending) return pending
    const loading = run(scope, ['api', 'rate_limit'], { idempotent: true })
      .then((output) => {
        let snapshot: Omit<RateLimitSnapshot, 'fetchedAt'>
        try {
          snapshot = parseRateLimit(parsed)
        } catch {
          throw pluginError('invalid_response', 'GitHub returned an invalid rate-limit response.')
        }
        const value = { ...snapshot, fetchedAt: Date.now() }
        rateLimitCache.set(key, { snapshot: value, expiresAt: Date.now() + RATE_LIMIT_TTL_MS })
        budgets.set(key, value)
        pruneMap(rateLimitCache, 128)
        pruneMap(budgets, 128)
        return value
      })
      .finally(() => {
        if (rateLimitInflight.get(key) === loading) rateLimitInflight.delete(key)
      })
    rateLimitInflight.set(key, loading)
    return loading
  }

  function enforceCircuit(key: string): void {
    const blocked = circuits.get(key)
    if (!blocked) return
    if (blocked.until <= Date.now()) {
      circuits.delete(key)
      return
    }
    const retryDisabledUntil = blocked.until
    throw pluginError('rate_limited', 'GitHub API rate limit reached; retry after the reported reset time.', {
      retryDisabledUntil,
      nextAutoRetryAt: retryDisabledUntil
    })
  }

  function enforceBudget(key: string, bucket: BucketName, host: string): void {
    if (host !== 'github.com') return
    const snapshot = budgets.get(key)
    if (!snapshot) return
    const resource = snapshot[bucket]
    if (resource.limit === 0 || resource.resetAt <= Date.now()) return
    const floor = bucket === 'search' ? 2 : 50
    if (resource.remaining < floor) {
      const circuitKey = `${key}:${bucket}`
      circuits.set(circuitKey, { until: resource.resetAt })
      throw pluginError('rate_limited', 'GitHub API budget is below the safe request floor.', {
        retryDisabledUntil: resource.resetAt,
        nextAutoRetryAt: resource.resetAt
      })
    }
  }

  function noteSpend(key: string, bucket: BucketName): void {
    const snapshot = budgets.get(key)
    if (!snapshot) return
    const current = snapshot[bucket]
    budgets.set(key, { ...snapshot, [bucket]: { ...current, remaining: Math.max(0, current.remaining - 1) } })
  }

  function circuitDuration(bucket: BucketName): number {
    return bucket === 'search' ? SEARCH_CIRCUIT_MS : bucket === 'graphql' ? GRAPHQL_CIRCUIT_MS : CORE_CIRCUIT_MS
  }

  function setCircuit(key: string, bucket: BucketName, retryAfterMs?: number): void {
    circuits.set(key, { until: Date.now() + (retryAfterMs ?? circuitDuration(bucket)) })
  }

  async function json(scope: Scope, args: string[], options?: RunOptions): Promise<unknown> {
    return parseJson(await run(scope, args, options))
  }

  async function rest(
    scope: Scope,
    path: string,
    method = 'GET',
    fields?: Record<string, unknown>,
    options: RunOptions = {}
  ): Promise<unknown> {
    const normalizedMethod = method.toUpperCase()
    if (!['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].includes(normalizedMethod)) {
      throw invalidError('invalid_method', 'The GitHub request method is not supported.')
    }
    if (!isSafeApiPath(path)) throw invalidError('invalid_api_path', 'The GitHub API path must be relative to the selected repository.')
    const input = fields === undefined ? undefined : JSON.stringify(fields)
    if (input !== undefined && Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
      throw invalidError('input_too_large', 'The GitHub request body exceeds the supported size limit.')
    }
    const output = await run(scope, ['api', path, '-X', normalizedMethod, ...(input === undefined ? [] : ['--input', '-'])], {
      ...options,
      idempotent: options.idempotent ?? !Object.hasOwn(MUTATING_HTTP_METHODS, normalizedMethod),
      ...(input !== undefined ? { input } : {})
    })
    return parseJson(output)
  }

  async function graphql(scope: Scope, query: string, variables: Record<string, unknown> = {}, options: RunOptions = {}): Promise<unknown> {
    if (Buffer.byteLength(query, 'utf8') > 8192) throw invalidError('query_too_large', 'The GraphQL query exceeds the supported size limit.')
    const input = JSON.stringify({ query, variables })
    if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) throw invalidError('input_too_large', 'The GraphQL request body exceeds the supported size limit.')
    const output = await run(scope, ['api', 'graphql', '-X', 'POST', '--input', '-'], {
      ...options,
      idempotent: options.idempotent ?? !isGraphqlMutation(query),
      input
    })
    return parseJson(output)
  }

  async function dispose(): Promise<void> {
    if (disposed) return
    disposed = true
    const children = [...activeChildren]
    const closures = children.map((child) => new Promise<void>((resolve) => child.once('close', () => resolve())))
    for (const child of children) terminateProcess(child)
    for (const waiter of waiters.splice(0)) {
      if (waiter.signal && waiter.onAbort) waiter.signal.removeEventListener('abort', waiter.onAbort)
      waiter.reject(pluginError('plugin_inactive', 'The GitHub hosting plugin is shutting down.'))
    }
    circuits.clear()
    budgets.clear()
    rateLimitCache.clear()
    rateLimitInflight.clear()
    authCache.clear()
    authInflight.clear()
    tokenCache.clear()
    capabilityCache.clear()
    await new Promise<void>((resolve) => delayTimer(resolve, 100))
    for (const child of children) terminateProcess(child, 'SIGKILL')
    await Promise.all(closures)
  }

  return { run, json, rest, graphql, authAccounts, validateBinding, rateLimit, dispose }

  function parseJson(output: string): unknown {
    if (output.trim() === '') return null
    try {
      return JSON.parse(output) as unknown
    } catch {
      throw invalidError('invalid_response', 'GitHub returned an invalid JSON response.')
    }
  }

  function trustedTarget(scope: Scope): Identity {
    if (!isRecord(scope) || !isRecord(scope.repository)) throw invalidError('invalid_scope', 'The selected GitHub repository is invalid.')
    const { host, owner, repo } = scope.repository
    if (typeof host !== 'string' || !isTrustedHost(host) || typeof owner !== 'string' || !isSlug(owner) || typeof repo !== 'string' || !isSlug(repo)) {
      throw invalidError('invalid_scope', 'The selected GitHub repository is invalid.')
    }
    const origin = scope.origin
    const candidates = scope.candidates
    if (!sameIdentity(scope.repository, origin) && !candidates.some((candidate) => sameIdentity(scope.repository, candidate))) {
      throw invalidError('repository_mismatch', 'The GitHub repository does not match a configured remote.')
    }
    return { host, owner, repo }
  }

  function pinArguments(args: string[], target: Identity): string[] {
    const pinned = [...args]
    const fullRepo = `${target.host}/${target.owner}/${target.repo}`
    if (pinned[0] === 'auth') return pinned
    if (pinned[0] === 'api') {
      let endpointIndex = -1
      for (let index = 1; index < pinned.length; index += 1) {
        const argument = pinned[index] ?? ''
        if (!argument.startsWith('-')) {
          endpointIndex = index
          break
        }
        if (argument.includes('=')) continue
        if (Object.hasOwn(API_FLAGS_WITH_VALUE, argument)) index += 1
      }
      const endpoint = endpointIndex >= 0 ? pinned[endpointIndex] : undefined
      if (typeof endpoint !== 'string' || !isSafeApiPath(endpoint)) throw invalidError('invalid_api_path', 'The GitHub API path must be relative to the selected repository.')
      for (let index = 1; index < pinned.length; index += 1) {
        if (pinned[index] === '--hostname') {
          pinned.splice(index, 2)
          index -= 1
        } else if (pinned[index]?.startsWith('--hostname=')) {
          pinned.splice(index, 1)
          index -= 1
        } else if (pinned[index] === '--repo' || pinned[index] === '-R') {
          pinned[index + 1] = fullRepo
          index += 1
        } else if (pinned[index]?.startsWith('--repo=')) {
          pinned[index] = `--repo=${fullRepo}`
        }
      }
      pinned.splice(1, 0, '--hostname', target.host)
      return pinned
    }

    let hasRepo = false
    for (let index = 0; index < pinned.length; index += 1) {
      if (pinned[index] === '--repo' || pinned[index] === '-R') {
        pinned[index + 1] = fullRepo
        hasRepo = true
        index += 1
      } else if (pinned[index]?.startsWith('--repo=')) {
        pinned[index] = `--repo=${fullRepo}`
        hasRepo = true
      }
    }
    if (!hasRepo) pinned.push('--repo', fullRepo)
    return pinned
  }


}

async function spawnProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number; maxBytes: number; input?: string; signal?: AbortSignal },
  activeChildren: Set<ChildProcess>
): Promise<ProcessResult> {
  const { promise, resolve } = createPromiseResolvers<ProcessResult>()
  let stdoutBytes = 0
  let stderrBytes = 0
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let spawnError: string | undefined
  let timedOut = false
  let outputLimit = false
  let aborted = false
  let child: ChildProcess
  if (options.signal?.aborted) return { stdout: '', stderr: '', exitCode: null, timedOut: false, outputLimit: false, aborted: true }
  try {
    child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
  } catch (error) {
    return { stdout: '', stderr: '', exitCode: null, spawnError: errorMessage(error), timedOut: false, outputLimit: false, aborted: false }
  }
  activeChildren.add(child)
  let finished = false
  let pendingExit = false
  let pendingExitCode: number | null = null
  let killTimer: ReturnType<typeof setTimeout> | undefined
  let stopping = false
  const complete = (exitCode: number | null) => {
    if (finished) return
    finished = true
    clearTimeout(timeout)
    clearTimeout(killTimer)
    options.signal?.removeEventListener('abort', onAbort)
    activeChildren.delete(child)
    resolve({
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      exitCode,
      ...(spawnError !== undefined ? { spawnError } : {}),
      timedOut,
      outputLimit,
      aborted
    })
  }
  const finish = (exitCode: number | null) => {
    if (finished) return
    if (stopping && killTimer !== undefined) {
      pendingExit = true
      pendingExitCode = exitCode
      return
    }
    complete(exitCode)
  }
  const stop = () => {
    if (stopping) return
    stopping = true
    terminateProcess(child)
    killTimer = delayTimer(() => {
      terminateProcess(child, 'SIGKILL')
      killTimer = undefined
      if (pendingExit) complete(pendingExitCode)
    }, 100)
  }
  const onAbort = () => {
    aborted = true
    stop()
  }
  const timeout = delayTimer(() => {
    timedOut = true
    stop()
  }, options.timeoutMs)
  timeout.unref?.()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  child.stdout?.on('data', (chunk: Buffer) => {
    const next = stdoutBytes + chunk.byteLength
    if (next + stderrBytes > options.maxBytes) {
      outputLimit = true
      stop()
      return
    }
    stdoutBytes = next
    stdoutChunks.push(chunk)
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    const next = stderrBytes + chunk.byteLength
    if (stdoutBytes + next > options.maxBytes) {
      outputLimit = true
      stop()
      return
    }
    stderrBytes = next
    stderrChunks.push(chunk)
  })
  child.once('error', (error) => {
    spawnError = errorMessage(error)
    finish(null)
  })
  child.once('close', (code) => finish(code))
  child.stdin?.on('error', () => {})
  if (options.input === undefined) child.stdin?.end()
  else child.stdin?.end(options.input, 'utf8')
  return promise
}

function createPromiseResolvers<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolvePromise!: (value: T) => void
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve
  })
  return { promise, resolve: resolvePromise }
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): void {
  if (!child.pid) return
  try {
    if (process.platform !== 'win32' && child.spawnargs.length > 0) process.kill(-child.pid, signal)
    else child.kill(signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      return
    }
  }
}

function processEnvironment(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value
  }
  return env
}

function stripTokenEnvironment(env: Record<string, string>): void {
  for (const name of TOKEN_ENV_NAMES) delete env[name]
}

function validateArguments(args: string[], invalidError: (reason: string, message: string) => Error): void {
  if (!Array.isArray(args) || args.length === 0 || args.length > 256 || args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) {
    throw invalidError('invalid_arguments', 'The GitHub CLI argument list is invalid.')
  }
}

function outputLimitFor(options: RunOptions, args: string[]): number {
  const requested = options.maxBytes
  const limit = requested ?? (args.includes('logs') ? LOG_OUTPUT_LIMIT : GENERAL_OUTPUT_LIMIT)
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > LOG_OUTPUT_LIMIT) throw new Error('invalid GitHub output limit')
  return limit
}

function timeoutFor(options: RunOptions): number {
  const configured = options.timeoutMs ?? Number.parseInt(process.env.ORCA_GH_EXEC_TIMEOUT_MS ?? '30000', 10)
  if (!Number.isSafeInteger(configured) || configured < 1 || configured > 10 * 60_000) return 30_000
  return configured
}

function classifyBucket(args: string[]): BucketName {
  if (args[0] === 'search' || (args[0] === 'api' && args.some((arg) => arg.startsWith('search/')))) return 'search'
  if (args[0] === 'api' && args.includes('graphql')) return 'graphql'
  return 'core'
}

function isRateLimitProbe(args: string[]): boolean {
  return args[0] === 'api' && args.includes('rate_limit')
}

function isIdempotent(args: string[], options: RunOptions): boolean {
  if (options.idempotent !== undefined) return options.idempotent
  if (args[0] === 'api') {
    let method: string | undefined
    let hasFields = false
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index]
      if (arg === '-X' || arg === '--method') method = args[index + 1]?.toUpperCase()
      if (arg === '-f' || arg === '-F' || arg === '--field' || arg === '--raw-field') hasFields = true
    }
    if (method && Object.hasOwn(MUTATING_HTTP_METHODS, method)) return false
    if (hasFields && method === undefined) return false
    if (args.includes('graphql') && options.input) {
      try {
        const input: unknown = JSON.parse(options.input)
        if (isRecord(input) && typeof input.query === 'string' && isGraphqlMutation(input.query)) return false
      } catch {
        return false
      }
    }
    return true
  }
  return !Object.hasOwn(MUTATING_GH_VERBS, args[1] ?? '')
}
function isGraphqlMutation(query: string): boolean {
  let candidate = query.trimStart()
  while (candidate.startsWith('#')) {
    const newline = candidate.indexOf('\n')
    if (newline < 0) return false
    candidate = candidate.slice(newline + 1).trimStart()
  }
  return /^mutation\b/i.test(candidate)
}

function authenticationScopeKey(scope: Scope): string {
  const ambient = TOKEN_ENV_NAMES.map((name) => `${name}=${process.env[name] ?? ''}`).join('\0')
  const account = scope.binding ? `${scope.binding.host}:${scope.binding.user}` : `ambient:${createHash('sha256').update(ambient).digest('hex')}`
  return `${scope.repository.host}|${account}`
}

function trustedTargetIdentity(scope: Scope): Identity {
  const target = scope.repository
  if (!isRecord(target) || typeof target.host !== 'string' || typeof target.owner !== 'string' || typeof target.repo !== 'string') {
    throw new Error('invalid trusted target')
  }
  return { host: target.host, owner: target.owner, repo: target.repo }
}

function trustedTarget(scope: Scope): Identity {
  return trustedTargetIdentity(scope)
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.host === right.host && left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase()
}

function isTrustedHost(value: string): boolean {
  return value.length <= 255 && /^[a-z0-9.-]+(?::\d{1,5})?$/.test(value) && !/[\s/@?#\\]/.test(value)
}

function isSlug(value: string): boolean {
  return value.length > 0 && value.length <= 100 && /^[A-Za-z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

function isSafeApiPath(path: string): boolean {
  if (!path || path.length > 8192 || path.startsWith('/') || path.startsWith('-') || path.includes('\\') || path.includes('\0') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return false
  const [endpoint = '', query] = path.split('?', 2)
  if (!/^[A-Za-z0-9._~\/-]+$/.test(endpoint)) return false
  try {
    if (decodeURIComponent(endpoint).split('/').some((part) => part === '.' || part === '..')) return false
  } catch {
    return false
  }
  return query === undefined || /^[A-Za-z0-9._~%=&:+,@\/\[\]\-]*$/.test(query)
}

function parseRateLimit(value: unknown): Omit<RateLimitSnapshot, 'fetchedAt'> {
  if (!isRecord(value) || !isRecord(value.resources)) throw new Error('invalid GitHub rate-limit response')
  const core = readBudget(value.resources.core)
  const search = readBudget(value.resources.search)
  const graphql = readBudget(value.resources.graphql)
  return { core, search, graphql }
}

function readBudget(value: unknown): Budget {
  if (!isRecord(value)) throw new Error('invalid GitHub rate-limit response')
  const { limit, remaining, reset } = value
  if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 0 || typeof remaining !== 'number' || !Number.isSafeInteger(remaining) || remaining < 0 || typeof reset !== 'number' || !Number.isFinite(reset) || reset < 0) {
    throw new Error('invalid GitHub rate-limit response')
  }
  return { limit, remaining, resetAt: reset * 1000 }
}


function normalizeFailure(
  context: PluginContext,
  result: ProcessResult,
  combined: string,
  classified = classifyFailure(result, combined)
): Error {
  const { reason, retryAfterMs } = classified
  const messages: Record<string, string> = {
    gh_unavailable: 'GitHub CLI is unavailable. Install gh and make it available on PATH.',
    not_authenticated: 'GitHub authentication is required. Run gh auth login.',
    permission_denied: 'The authenticated GitHub account cannot perform this operation.',
    repository_unavailable: 'The configured GitHub repository is unavailable or inaccessible.',
    network_error: 'The GitHub request could not reach the service.',
    server_error: 'GitHub returned a service error.',
    rate_limited: 'GitHub API rate limit reached.',
    timeout: 'The GitHub request timed out.',
    output_limit: 'The GitHub response exceeded the configured output limit.',
    cancelled: 'The GitHub request was cancelled.',
    validation_error: 'GitHub rejected the requested operation.',
    upstream_error: 'The GitHub request failed.'
  }
  const extra: Record<string, unknown> = {}
  if (reason === 'rate_limited') {
    const retryDisabledUntil = Date.now() + (retryAfterMs ?? CORE_CIRCUIT_MS)
    extra.retryDisabledUntil = retryDisabledUntil
    extra.nextAutoRetryAt = retryDisabledUntil
  }
  return Object.assign(context.error('conflict', messages[reason] ?? messages.upstream_error ?? 'The GitHub request failed.'), {
    data: { reason, ...extra }
  })
}

function classifyFailure(result: ProcessResult, combined: string): { reason: string; retryAfterMs?: number } {
  if (result.timedOut) return { reason: 'timeout' }
  if (result.outputLimit) return { reason: 'output_limit' }
  if (result.aborted) return { reason: 'cancelled' }
  const lower = combined.toLowerCase()
  if (result.spawnError && /enoent|not found|could not find/i.test(result.spawnError)) return { reason: 'gh_unavailable' }
  if (/gh:\s*command not found|executable file not found|no such file or directory/.test(lower)) return { reason: 'gh_unavailable' }
  const retryAfterMs = readRetryAfter(combined)
  if (/api rate limit exceeded|secondary rate limit|rate limit exceeded|http 429|status 429/.test(lower)) return { reason: 'rate_limited', ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  if (/http 401|status 401|not logged in|authentication required|bad credentials/.test(lower)) return { reason: 'not_authenticated' }
  if (/http 403|status 403|forbidden|resource not accessible|insufficient scope|permission denied/.test(lower)) return { reason: 'permission_denied' }
  if (/http 404|status 404|not found/.test(lower)) return { reason: 'repository_unavailable' }
  if (/http 5\d\d|status 5\d\d|internal server error|service unavailable|bad gateway/.test(lower)) return { reason: 'server_error' }
  if (/econnreset|etimedout|ehostunreach|enetunreach|socket hang up|connection reset|network is unreachable|temporary failure/.test(lower)) return { reason: 'network_error' }
  if (/http 422|status 422|validation failed|unprocessable entity/.test(lower)) return { reason: 'validation_error' }
  return { reason: 'upstream_error' }
}

function isTransient(result: ProcessResult, combined: string): boolean {
  if (result.timedOut || result.outputLimit || result.aborted || result.spawnError) return false
  const lower = combined.toLowerCase()
  return /http (500|502|503|504)|status (500|502|503|504)|econnreset|etimedout|socket hang up/.test(lower) || (/http 429|status 429/.test(lower) && readRetryAfter(combined) === undefined)
}

function readRetryAfter(value: string): number | undefined {
  const line = /^retry-after\s*:\s*(.+)$/im.exec(value)?.[1]?.trim()
  if (!line) return undefined
  const seconds = Number(line)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 24 * 60 * 60_000)
  const absolute = Date.parse(line)
  if (Number.isFinite(absolute)) return Math.max(0, Math.min(absolute - Date.now(), 24 * 60 * 60_000))
  return undefined
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isReason(error: Error, reason: string): boolean {
  if (!('data' in error)) return false
  const data = error.data
  return isRecord(data) && data.reason === reason
}

function refreshMapLru<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  map.set(key, value)
}

function pruneMap<T>(map: Map<string, T>, limit: number): void {
  while (map.size > limit) {
    const oldest = map.keys().next().value
    if (oldest === undefined) return
    map.delete(oldest)
  }
}

async function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('GitHub request cancelled')
  await new Promise<void>((resolve, reject) => {
    const timer = delayTimer(() => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    const abort = () => {
      clearTimeout(timer)
      reject(new Error('GitHub request cancelled'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
