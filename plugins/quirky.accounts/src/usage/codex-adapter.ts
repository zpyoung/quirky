import { spawn, type ChildProcess } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { mapCodexUsage } from './mappers'
import { codexHome, managedCodexAuthPath } from './credentials'
import { errorSnapshot, finiteNumber, parseTimestamp, record, responseJson } from './provider-utils'
import type { ProviderRuntime } from './process'
import type { ProviderSnapshot, RateLimitResetCredits, UsageTarget } from './types'

const RPC_INITIALIZE_TIMEOUT_MS = 30_000
const RPC_READ_TIMEOUT_MS = 10_000
const BACKEND_TIMEOUT_MS = 10_000
const RESET_TIMEOUT_MS = 30_000
const CODEX_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const CODEX_RESET_CREDITS_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits'
const CODEX_RESET_CONSUME_URL = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume'

type CodexAuth = {
  accessToken: string | null
  accountId: string | null
}

function parseCodexAuth(value: unknown): CodexAuth {
  const root = record(value)
  const tokens = record(root?.tokens)
  return {
    accessToken: typeof tokens?.access_token === 'string' && tokens.access_token ? tokens.access_token : null,
    accountId: typeof tokens?.account_id === 'string' && tokens.account_id ? tokens.account_id : null
  }
}

async function readCodexAuth(target: UsageTarget): Promise<CodexAuth> {
  try {
    const raw = await readFile(managedCodexAuthPath(target), 'utf8')
    const value: unknown = JSON.parse(raw)
    return parseCodexAuth(value)
  } catch {
    return { accessToken: null, accountId: null }
  }
}

function rpcFailure(runtime: ProviderRuntime, error: string, kind: 'cli-unavailable' | 'usage-unavailable' | 'parse' = 'usage-unavailable'): ProviderSnapshot {
  return errorSnapshot('codex', runtime.now(), error, kind, kind === 'cli-unavailable' ? 'unavailable' : 'error', { source: 'cli' })
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  const hardKill = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }, 1_000)
  child.once('close', () => clearTimeout(hardKill))
}

function appServerRateLimits(runtime: ProviderRuntime, home: string): Promise<ProviderSnapshot> {
  return new Promise((resolve) => {
    const child = spawn('codex', ['-c', 'approval_policy=never', '-c', 'features.plugins=false', '-s', 'read-only', '-a', 'never', 'app-server'], {
      cwd: home,
      env: { ...process.env, CODEX_HOME: home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    })
    runtime.processes.track(child)
    let settled = false
    let buffer = ''
    let outputBytes = 0
    let currentTimeout: ReturnType<typeof setTimeout> | null = null
    const abort = (): void => finish(rpcFailure(runtime, 'Codex usage refresh was cancelled'))
    function cleanup(): void {
      if (currentTimeout) clearTimeout(currentTimeout)
      currentTimeout = null
      runtime.signal.removeEventListener('abort', abort)
      child.stdout?.removeAllListeners('data')
      child.stderr?.removeAllListeners('data')
    }
    function finish(result: ProviderSnapshot): void {
      if (settled) return
      settled = true
      cleanup()
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(result)
        return
      }
      let closeDeadline: ReturnType<typeof setTimeout> | null = null
      child.once('close', () => {
        if (closeDeadline) clearTimeout(closeDeadline)
        resolve(result)
      })
      closeDeadline = setTimeout(() => resolve(result), 1_500)
      terminate(child)
    }
    function request(id: number, method: string, params: unknown = {}): void {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    }
    function notification(method: string): void {
      child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`)
    }
    function processLine(line: string): void {
      if (!line) return
      let message: Record<string, unknown> | null
      try {
        message = record(JSON.parse(line) as unknown)
      } catch {
        return
      }
      const id = finiteNumber(message?.id)
      if (id === 1) {
        if (message?.error) {
          finish(rpcFailure(runtime, 'Codex App Server initialization failed'))
          return
        }
        if (currentTimeout) clearTimeout(currentTimeout)
        currentTimeout = setTimeout(() => finish(rpcFailure(runtime, 'Codex rate limit request timed out')), RPC_READ_TIMEOUT_MS)
        notification('initialized')
        request(2, 'account/rateLimits/read')
        return
      }
      if (id !== 2) return
      if (message?.error) {
        finish(rpcFailure(runtime, 'Codex App Server could not read rate limits'))
        return
      }
      const mapped = mapCodexUsage(message?.result, runtime.now())
      if (mapped.status !== 'ok') {
        finish(rpcFailure(runtime, 'Codex App Server response did not include quota', 'parse'))
        return
      }
      finish(mapped)
    }
    child.stdout?.on('data', (chunk: Buffer) => {
      outputBytes += chunk.byteLength
      if (outputBytes > 512 * 1024) {
        finish(rpcFailure(runtime, 'Codex App Server response was too large', 'parse'))
        return
      }
      buffer += chunk.toString('utf8')
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        processLine(line)
        if (settled) return
        newline = buffer.indexOf('\n')
      }
    })
    child.stderr?.on('data', () => undefined)
    child.once('error', () => finish(rpcFailure(runtime, 'Codex CLI could not be started', 'cli-unavailable')))
    child.once('close', (code) => {
      if (!settled) finish(rpcFailure(runtime, code === 0 ? 'Codex App Server exited before returning quota' : 'Codex App Server exited unexpectedly'))
    })
    runtime.signal.addEventListener('abort', abort, { once: true })
    if (runtime.signal.aborted) abort()
    if (!settled) {
      currentTimeout = setTimeout(() => finish(rpcFailure(runtime, 'Codex App Server initialization timed out')), RPC_INITIALIZE_TIMEOUT_MS)
      request(1, 'initialize', { clientInfo: { name: 'orca', version: '1.0.0' } })
    }
  })
}

function backendHeaders(auth: CodexAuth): Record<string, string> | null {
  if (!auth.accessToken) return null
  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.accessToken}`,
    'User-Agent': 'codex-cli',
    'OpenAI-Beta': 'codex-1',
    originator: 'Codex Desktop'
  }
  if (auth.accountId) headers['ChatGPT-Account-Id'] = auth.accountId
  return headers
}

function backendWindow(raw: unknown, fallbackMinutes: number): Record<string, unknown> | null {
  const window = record(raw)
  const usedPercent = finiteNumber(window?.used_percent)
  if (usedPercent === null) return null
  const seconds = finiteNumber(window?.limit_window_seconds)
  return {
    usedPercent,
    windowDurationMins: seconds !== null && seconds > 0 ? Math.ceil(seconds / 60) : fallbackMinutes,
    resetsAt: window?.reset_at
  }
}

function backendCredits(value: unknown): RateLimitResetCredits | null {
  const raw = record(value)
  if (!raw) return null
  const credits = Array.isArray(raw.credits) ? raw.credits.flatMap((item) => {
    const credit = record(item)
    if (!credit) return []
    return [{
      status: typeof credit.status === 'string' ? credit.status.toLowerCase() : 'unknown',
      expiresAt: parseTimestamp(credit.expires_at),
      grantedAt: parseTimestamp(credit.granted_at)
    }]
  }) : undefined
  const available = finiteNumber(raw.available_count) ?? credits?.filter((credit) => credit.status === 'available').length ?? null
  if (available === null) return null
  const total = finiteNumber(raw.total_earned_count)
  const availableExpiries = credits?.filter((credit) => credit.status === 'available').map((credit) => credit.expiresAt).filter((value): value is number => value !== null).sort((left, right) => left - right) ?? []
  return {
    availableCount: Math.max(0, Math.floor(available)),
    ...(total !== null ? { totalEarnedCount: Math.max(0, Math.floor(total)) } : {}),
    nextExpiresAt: availableExpiries[0] ?? null,
    ...(credits ? { credits } : {})
  }
}

async function fetchBackendUsage(runtime: ProviderRuntime, auth: CodexAuth): Promise<ProviderSnapshot | null> {
  const headers = backendHeaders(auth)
  if (!headers) return null
  const response = await runtime.fetch(CODEX_USAGE_URL, { headers, credentials: 'omit' }, BACKEND_TIMEOUT_MS)
  if (!response.ok) return null
  const payload = record(await responseJson(response))
  if (typeof payload?.plan_type !== 'string') return null
  const rateLimit = record(payload.rate_limit)
  const limits = {
    primary: backendWindow(rateLimit?.primary_window, 300),
    secondary: backendWindow(rateLimit?.secondary_window, 10_080)
  }
  const resetCredits = backendCredits(payload.rate_limit_reset_credits)
  const result = mapCodexUsage({
    rateLimits: limits,
    planType: payload.plan_type,
    ...(resetCredits ? { rateLimitResetCredits: resetCredits } : {})
  }, runtime.now())
  if (result.status !== 'ok') return null
  if (result.rateLimitResetCredits === undefined) {
    const credits = await fetchBackendResetCredits(runtime, auth).catch(() => null)
    return credits ? { ...result, rateLimitResetCredits: credits } : result
  }
  return result
}

async function fetchBackendResetCredits(runtime: ProviderRuntime, auth: CodexAuth): Promise<RateLimitResetCredits | null> {
  const headers = backendHeaders(auth)
  if (!headers) return null
  const response = await runtime.fetch(CODEX_RESET_CREDITS_URL, { headers, credentials: 'omit' }, BACKEND_TIMEOUT_MS)
  if (!response.ok) return null
  return backendCredits(await responseJson(response))
}

async function readCodexUsage(runtime: ProviderRuntime, target: UsageTarget): Promise<ProviderSnapshot> {
  const home = codexHome(target)
  const auth = await readCodexAuth(target)
  if (!auth.accessToken) {
    return errorSnapshot('codex', runtime.now(), 'Codex not signed in', 'missing-credentials', 'unavailable')
  }
  let rpc: ProviderSnapshot
  try {
    rpc = await appServerRateLimits(runtime, home)
  } catch {
    rpc = rpcFailure(runtime, 'Codex App Server could not be started', 'cli-unavailable')
  }
  if (rpc.status === 'ok' && rpc.session && rpc.weekly && rpc.rateLimitResetCredits) return rpc
  try {
    const backend = await fetchBackendUsage(runtime, auth)
    if (!backend) return rpc
    if (rpc.status !== 'ok') return backend
    return {
      ...rpc,
      session: rpc.session ?? backend.session,
      weekly: rpc.weekly ?? backend.weekly,
      rateLimitResetCredits: rpc.rateLimitResetCredits ?? backend.rateLimitResetCredits,
      planType: rpc.planType ?? backend.planType,
      extraUsage: rpc.extraUsage ?? backend.extraUsage
    }
  } catch {
    return rpc
  }
}

export async function fetchCodexUsage(runtime: ProviderRuntime, target: UsageTarget): Promise<ProviderSnapshot> {
  return readCodexUsage(runtime, target)
}

export async function consumeCodexResetCredit(
  runtime: ProviderRuntime,
  target: UsageTarget,
  idempotencyKey: string
): Promise<'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'> {
  if (!idempotencyKey.trim()) throw new Error('Codex reset idempotency key is required')
  const auth = await readCodexAuth(target)
  const headers = backendHeaders(auth)
  if (!headers) throw new Error('Codex not signed in')
  const controller = new AbortController()
  const abort = (): void => controller.abort()
  runtime.signal.addEventListener('abort', abort, { once: true })
  const timeout = setTimeout(abort, RESET_TIMEOUT_MS)
  try {
    const response = await runtime.fetch(CODEX_RESET_CONSUME_URL, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ redeem_request_id: idempotencyKey }),
      signal: controller.signal,
      credentials: 'omit'
    }, RESET_TIMEOUT_MS)
    if (!response.ok) throw new Error(`Codex reset failed (HTTP ${response.status})`)
    const payload = record(await responseJson(response))
    switch (payload?.code) {
      case 'reset': return 'reset'
      case 'nothing_to_reset': return 'nothingToReset'
      case 'no_credit': return 'noCredit'
      case 'already_redeemed': return 'alreadyRedeemed'
      default: throw new Error('Codex returned an unknown reset outcome')
    }
  } finally {
    clearTimeout(timeout)
    runtime.signal.removeEventListener('abort', abort)
  }
}
