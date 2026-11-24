import {
  classifyGhRateLimitBucket,
  createGhRateLimitBlockedError,
  getGhRateLimitBlockedUntilMs,
  ghRateLimitScopeKey,
  isGhPrimaryRateLimitStderr,
  isGhLocalOnlyCommand,
  isGhRateLimitProbe,
  notifyGhPrimaryRateLimit,
  type GhRateLimitBucket
} from '../gh-rate-limit-breaker'
import { extractExecError, parseRetryAfterMs } from '../exec-error'
import { execFileCaptureToTermination } from './exec-file-capture'
import { logHostedCliDeadlineKill } from './hosted-cli-deadline-log'
import type { GitExecOptions } from './git-exec-options'
import { argsLookIdempotent } from './gh-idempotency'
import { applyGhHostToArgs, explicitGhHostname, explicitGhRepoHostname } from './gh-host-args'
import { isGhBoundAccountError, resolveBoundGhExecEnv } from './gh-bound-account-env'
import {
  assertGhCallActive,
  createGhLogicalLifetime,
  type GhCaptureLifetimeHooks
} from './gh-capture-lifetime'
import {
  defaultGhExecTimeoutMs,
  isTransientGhError,
  sleep,
  GH_RETRY_AFTER_MAX_MS,
  GH_RETRY_DELAYS_MS
} from './gh-retry-policy'

// `cwd?` omitted for non-repo-scoped gh calls (rate_limit, listAccessibleProjects).
// `idempotent?` gates transient-error retry (auto-detected from argv); retrying a write that already reached GitHub would duplicate it.
export type GhExecOptions = Omit<GitExecOptions, 'cwd'> & {
  cwd?: string
  wslDistro?: string
  idempotent?: boolean
  // Why: `gh api` and `--repo OWNER/REPO` shorthand resolve against gh's
  // default host, not the repo's remote. Carrying the host here lets the
  // runner qualify every spawn once, so call sites can't silently fall back
  // to github.com for GHES repos; it also scopes the rate-limit breaker.
  host?: string
  /** Per-project account binding; the runner resolves and injects a child-only token. */
  ghAccount?: { host: string; user: string }
}

function nonInteractiveGhEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...env,
    GH_PROMPT_DISABLED: env.GH_PROMPT_DISABLED ?? '1'
  }
}

function ghRateLimitScope(args: readonly string[], options: GhExecOptions): string {
  // Why: an explicit argv hostname controls the actual gh request even when
  // GH_HOST or options.host disagree, so breaker state must follow that host.
  const host =
    explicitGhHostname(args) ??
    options.host ??
    explicitGhRepoHostname(args) ??
    options.env?.GH_HOST ??
    process.env.GH_HOST ??
    'github.com'
  return ghRateLimitScopeKey('native', host)
}

function assertGhRateLimitScopeAvailable(
  args: readonly string[],
  options: GhExecOptions,
  bucket: GhRateLimitBucket,
  exemptProbe: boolean
): void {
  if (exemptProbe) {
    return
  }
  const blockedUntilMs = getGhRateLimitBlockedUntilMs(
    bucket,
    Date.now(),
    ghRateLimitScope(args, options)
  )
  if (blockedUntilMs !== null) {
    throw createGhRateLimitBlockedError(bucket, blockedUntilMs)
  }
}

/**
 * Async gh CLI execution. Drop-in replacement for
 * `execFileAsync('gh', args, { cwd, encoding, ... })`.
 *
 * Retries transient 5xx / 429-without-Retry-After / network-reset failures with
 * exponential backoff; other errors fail fast.
 */
export async function ghExecFileAsync(
  args: string[],
  options: GhExecOptions = {},
  lifetimeHooks?: GhCaptureLifetimeHooks
): Promise<{ stdout: string; stderr: string }> {
  const { stdout, stderr } = await ghExecFileWithScopeAsync(args, options, lifetimeHooks)
  return { stdout, stderr }
}

/** Includes the breaker scope the call ran under. */
export async function ghExecFileWithScopeAsync(
  args: string[],
  options: GhExecOptions = {},
  lifetimeHooks?: GhCaptureLifetimeHooks
): Promise<{ stdout: string; stderr: string; rateLimitScope: string }> {
  const idempotent = options.idempotent ?? argsLookIdempotent(args)
  // Why: legacy github.com ownerRepos omit `host`; bound calls still need a pinned
  // options.host before token-var selection and argv qualification.
  if (options.ghAccount && !options.host?.trim() && args[0] !== 'auth') {
    options = { ...options, host: options.ghAccount.host.trim().toLowerCase() }
  }
  args = applyGhHostToArgs(args, options.host)
  const resolved = { binary: 'gh', args, cwd: options.cwd }
  // Why: while a bucket is rate-limited every spawn returns 403 — fail fast; the probe is exempt so the breaker can learn the reset,
  // and `auth token` is exempt because a keyring read never spends API quota (a bound token resolve must not report "unavailable").
  // Why: scope by host so unrelated github.com and GHES quotas cannot block each other.
  const rateLimitBucket = classifyGhRateLimitBucket(args)
  const rateLimitExempt = isGhRateLimitProbe(args) || isGhLocalOnlyCommand(args)
  let boundEnv: NodeJS.ProcessEnv | undefined = options.env
  let boundEnvResolved = false
  // Why: unbound calls must reach the spawn in the same tick — callers that abort
  // synchronously would otherwise never get a child to kill.
  const ensureBoundEnv = (hooks?: GhCaptureLifetimeHooks): Promise<void> | null => {
    if (boundEnvResolved) {
      return null
    }
    if (!options.ghAccount || args[0] === 'auth') {
      boundEnv = options.env
      boundEnvResolved = true
      return null
    }
    return resolveBoundGhExecEnv(options, args, hooks).then((env) => {
      boundEnv = env
      boundEnvResolved = true
    })
  }
  const timeoutMs = options.timeout ?? defaultGhExecTimeoutMs(options.env)
  assertGhRateLimitScopeAvailable(args, options, rateLimitBucket, rateLimitExempt)
  let lastError: unknown
  for (let attempt = 0; attempt <= GH_RETRY_DELAYS_MS.length; attempt++) {
    const lifetime = lifetimeHooks ? createGhLogicalLifetime(lifetimeHooks) : null
    if (lifetime) {
      lifetimeHooks?.onTerminationPending(lifetime.terminated)
    }
    try {
      if (lifetime) {
        assertGhCallActive(options.signal)
      }
      const boundEnvReady = ensureBoundEnv(lifetime?.hooks)
      if (boundEnvReady) {
        await boundEnvReady
        // Why: the breaker may have tripped while the token resolved.
        assertGhRateLimitScopeAvailable(args, options, rateLimitBucket, rateLimitExempt)
      }
      if (lifetime) {
        await lifetime.waitPending(options.signal)
      }
      // Why to-termination and not execFileCapture: `gh` on PATH is routinely a
      // shim (mise, asdf, volta, a hand-written wrapper), so the deadline below
      // has a chain to reap, not one process. execFileCapture's POSIX kill only
      // signals the direct child, which orphans the rest to init — a wedged
      // helper then outlives the timeout that was supposed to bound it (#18234).
      const { stdout, stderr } = await execFileCaptureToTermination(
        resolved.binary,
        resolved.args,
        {
          cwd: resolved.cwd,
          encoding: (options.encoding ?? 'utf-8') as BufferEncoding,
          maxBuffer: options.maxBuffer,
          // Why: bound gh so one stuck child fails visibly instead of wedging the IPC lane.
          timeout: timeoutMs,
          env: nonInteractiveGhEnv(boundEnv ?? options.env),
          signal: options.signal,
          onChildTerminated: lifetime?.capture(),
          onDeadlineKill: () => logHostedCliDeadlineKill('gh', resolved.binary, args, timeoutMs)
        }
      )
      if (lifetime) {
        await lifetime.waitPending(options.signal)
      }
      return {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Capture decodes stdout with the requested string encoding above.
        stdout: stdout as string,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Capture decodes stderr with the requested string encoding above.
        stderr: stderr as string,
        rateLimitScope: ghRateLimitScope(args, options)
      }
    } catch (err) {
      if (lifetime) {
        try {
          await lifetime.waitPending(options.signal)
        } catch (waitError) {
          if (!options.signal?.aborted) {
            throw err
          }
          if (
            waitError instanceof Error &&
            err &&
            typeof err === 'object' &&
            'outputTruncated' in err &&
            typeof err.outputTruncated === 'boolean'
          ) {
            Object.assign(waitError, { outputTruncated: err.outputTruncated })
          }
          throw waitError
        }
      }
      lastError = err
      if (isGhBoundAccountError(err)) {
        throw err
      }
      const { stderr } = extractExecError(err)
      if (isGhPrimaryRateLimitStderr(stderr)) {
        notifyGhPrimaryRateLimit(rateLimitBucket, ghRateLimitScope(args, options))
      }
      const isLastAttempt = attempt >= GH_RETRY_DELAYS_MS.length
      if (idempotent && !isLastAttempt && isTransientGhError(stderr)) {
        // Why: honor the server's Retry-After over our backoff (a shorter sleep just re-fails); cap so a huge hint can't stall IPC.
        const retryAfterMs = parseRetryAfterMs(stderr)
        const delayMs =
          retryAfterMs !== null
            ? Math.min(retryAfterMs, GH_RETRY_AFTER_MAX_MS)
            : GH_RETRY_DELAYS_MS[attempt]
        await sleep(delayMs, options.signal)
        continue
      }
      throw err
    } finally {
      lifetime?.seal()
    }
  }
  // Unreachable: the loop either returns or throws. Here for TS exhaustiveness.
  throw lastError
}
