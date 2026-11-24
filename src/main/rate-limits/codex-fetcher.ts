import type { CodexRateLimitResetOutcome, ProviderRateLimits } from '../../shared/rate-limit-types'
import { isCodexAuthError } from '../../shared/codex-auth-errors'
import { CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS } from '../codex-cli/codex-read-only-app-server-args'
import { resolveCodexCommand } from '../codex-cli/command'
// Why: import from the shared module, not the codex-cli re-export, so a test that
// mocks '../codex-cli/command' does not have to restate this pure helper.
import { withCliRuntimeOnPath } from '../../shared/node-cli-command-resolution'
import {
  resolveCodexHomeProcessLockKey,
  withCodexHomeProcessLock
} from '../codex-cli/codex-home-process-lock'
import { isCodexStateDbBackfillPending } from '../codex/codex-state-db'
import { startCodexStateDbBackfillRecoveryInBackground } from '../codex/codex-state-db-backfill-recovery'
import { spawnProcessOnWorkerThread } from '../worker-thread-child-process/worker-thread-child-process'
import { buildConfiguredProxyEnv } from '../../shared/network-proxy'
import { getMainHttpClient } from '../network/http-client'
import { probeCodexAuthPresence } from './codex-auth-presence'
import {
  fetchCodexRateLimitsViaBackend,
  supplementCodexSessionWindow
} from './codex-backend-usage-client'
import type { CodexRateLimitFetchOptions } from './codex-rate-limit-fetch-options'
import { abortedCodexRateLimitResult } from './codex-rate-limit-fetch-result'
import { terminateCodexProbeChild } from './codex-probe-termination'
import {
  consumeCodexRateLimitResetCreditFromBackend,
  supplementCodexRateLimitResetCredits
} from './codex-reset-credit-client'
import { readCodexRateLimitsViaRpc } from './codex-rpc-rate-limit-probe'
import { resolveHiddenRateLimitPtyCwd } from './hidden-rate-limit-pty-cwd'

const RPC_TIMEOUT_MS = 10_000
const RPC_INIT_TIMEOUT_MS = 30_000

export type FetchCodexRateLimitsOptions = CodexRateLimitFetchOptions

function requestCodexBackend(url: string, init: RequestInit): Promise<Response> {
  // Keep account authentication explicit; the desktop session may hold unrelated cookies.
  return getMainHttpClient().fetch(url, { ...init, credentials: 'omit' })
}

async function fetchViaRpc(options?: CodexRateLimitFetchOptions): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const codexArgs = [...CODEX_SHORT_LIVED_PROBE_APP_SERVER_ARGS]
  const codexCommand = resolveCodexCommand()
  // Why the bare CLI: spawnProcess resolves an npm `codex.cmd` shim past cmd.exe itself.
  // Why a worker thread (#27362): a cold codex.exe can block process creation for seconds.
  const child = spawnProcessOnWorkerThread({
    program: codexCommand,
    args: codexArgs,
    cwd: resolveHiddenRateLimitPtyCwd(),
    env: withCliRuntimeOnPath(codexCommand, {
      ...process.env,
      ...buildConfiguredProxyEnv(options?.networkProxySettings),
      ...(options?.codexHomePath ? { CODEX_HOME: options.codexHomePath } : {})
    })
  })
  return readCodexRateLimitsViaRpc({
    child,
    codexCommand,
    initTimeoutMs: RPC_INIT_TIMEOUT_MS,
    rpcTimeoutMs: RPC_TIMEOUT_MS,
    fetchOptions: options,
    terminate: () => terminateCodexProbeChild(child)
  })
}

export function consumeCodexRateLimitResetCredit(options: {
  codexHomePath?: string | null
  idempotencyKey: string
}): Promise<CodexRateLimitResetOutcome> {
  return consumeCodexRateLimitResetCreditFromBackend(options, requestCodexBackend)
}

async function supplementBackendMetadata(
  limits: ProviderRateLimits,
  options?: CodexRateLimitFetchOptions
): Promise<ProviderRateLimits> {
  const withSession = await supplementCodexSessionWindow(limits, requestCodexBackend, options)
  return supplementCodexRateLimitResetCredits(withSession, requestCodexBackend, options)
}

function codexUnavailable(error: string, status: 'error' | 'unavailable'): ProviderRateLimits {
  return {
    provider: 'codex',
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error,
    status
  }
}

async function fetchBackendUsage(
  options: CodexRateLimitFetchOptions | undefined
): Promise<ProviderRateLimits | null> {
  try {
    const result = await fetchCodexRateLimitsViaBackend(requestCodexBackend, options)
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    return result
      ? supplementCodexRateLimitResetCredits(result, requestCodexBackend, options)
      : null
  } catch {
    return options?.signal?.aborted ? abortedCodexRateLimitResult() : null
  }
}

export async function fetchCodexRateLimits(
  options?: FetchCodexRateLimitsOptions
): Promise<ProviderRateLimits> {
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  const authPresence = await probeCodexAuthPresence(options?.codexHomePath, {
    signal: options?.signal
  })
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  if (authPresence === 'absent') {
    return codexUnavailable('Codex not signed in', 'unavailable')
  }
  if (authPresence !== 'present') {
    return codexUnavailable(
      authPresence === 'timeout'
        ? 'Timed out while checking Codex sign-in status'
        : 'Codex sign-in status is unavailable',
      'error'
    )
  }

  if (options?.codexHomePath && isCodexStateDbBackfillPending(options.codexHomePath)) {
    void startCodexStateDbBackfillRecoveryInBackground(options.codexHomePath)
    return codexUnavailable(
      'Codex is rebuilding its session index; usage will refresh when recovery finishes',
      'error'
    )
  }

  let rpcFailure: ProviderRateLimits
  try {
    const rpcResult = await withCodexHomeProcessLock(
      resolveCodexHomeProcessLockKey(options?.codexHomePath),
      () => fetchViaRpc(options)
    )
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    if (rpcResult.status === 'ok' || rpcResult.status === 'unavailable') {
      const supplemented = await supplementBackendMetadata(rpcResult, options)
      return options?.signal?.aborted ? abortedCodexRateLimitResult() : supplemented
    }
    if (isCodexAuthError(rpcResult.error)) {
      return rpcResult
    }
    rpcFailure = rpcResult
  } catch {
    if (options?.signal?.aborted) {
      return abortedCodexRateLimitResult()
    }
    rpcFailure = codexUnavailable('RPC failed', 'error')
  }

  // Why: read usage over HTTP, never by driving the interactive Codex TUI — keystrokes sent there can accept startup dialogs such as "Update now" (#17415).
  const backendResult = await fetchBackendUsage(options)
  if (options?.signal?.aborted) {
    return abortedCodexRateLimitResult()
  }
  return backendResult ?? rpcFailure
}
