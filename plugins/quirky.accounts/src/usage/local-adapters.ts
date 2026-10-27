import { join } from 'node:path'
import { mapAntigravityUsage, mapGeminiUsage, mapKimiUsage } from './mappers'
import { errorSnapshot, readJsonFile, record, responseFailure, responseJson } from './provider-utils'
import type { ProviderRuntime } from './process'
import type { ProviderSnapshot } from './types'
import { homeDirectory } from './credentials'
import { refreshGeminiAccessToken } from './gemini-cli-oauth'

const GEMINI_LOAD_PROJECT_URL = 'https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist'
const GEMINI_QUOTA_URL = 'https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota'
const KIMI_USAGE_URL = 'https://api.kimi.com/coding/v1/usages'

function providerError(provider: 'gemini' | 'antigravity' | 'kimi', runtime: ProviderRuntime, message: string, failureKind: 'missing-credentials' | 'stale-token' | 'network' | 'parse' | 'usage-unavailable' | 'delegated-refresh-required' | 'cli-unavailable', status: 'error' | 'unavailable' = 'error'): ProviderSnapshot {
  return errorSnapshot(provider, runtime.now(), message, failureKind, status)
}

function versionTuple(value: string): number[] | null {
  const match = value.match(/(?:^|\s|v)(\d+)\.(\d+)\.(\d+)/i)
  return match ? match.slice(1).map(Number) : null
}

function versionAtLeast(actual: number[], required: number[]): boolean {
  for (let index = 0; index < required.length; index += 1) {
    const left = actual[index] ?? 0
    const right = required[index] ?? 0
    if (left !== right) return left > right
  }
  return true
}

export async function fetchGeminiUsage(runtime: ProviderRuntime, oauthEnabled: boolean): Promise<ProviderSnapshot> {
  if (!oauthEnabled) {
    return errorSnapshot('gemini', runtime.now(), 'Gemini CLI OAuth polling is disabled; enable it to read Gemini usage.', 'usage-unavailable', 'unavailable')
  }
  const credentialsPath = join(homeDirectory(), '.gemini', 'oauth_creds.json')
  const credentialFile = record(await readJsonFile(credentialsPath))
  let accessToken = typeof credentialFile?.access_token === 'string' ? credentialFile.access_token : ''
  const refreshToken = typeof credentialFile?.refresh_token === 'string' ? credentialFile.refresh_token : ''
  const expiryDate = typeof credentialFile?.expiry_date === 'number' ? credentialFile.expiry_date : null
  if (!refreshToken) return providerError('gemini', runtime, 'Gemini CLI credentials not found', 'missing-credentials', 'unavailable')
  try {
    if (!accessToken || (expiryDate !== null && expiryDate <= runtime.now())) {
      accessToken = await refreshGeminiAccessToken(credentialsPath, credentialFile, runtime) ?? ''
      if (!accessToken) return providerError('gemini', runtime, 'Gemini sign-in expired; run Gemini CLI to refresh it', 'delegated-refresh-required')
    }
    const projectResponse = await runtime.fetch(GEMINI_LOAD_PROJECT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ metadata: { ideType: 'GEMINI_CLI', pluginType: 'GEMINI' } })
    })
    if (!projectResponse.ok) {
      return responseFailure('gemini', projectResponse, runtime.now(), {
        rateLimited: 'Gemini quota request is rate limited',
        unauthorized: 'Gemini sign-in expired',
        generic: `Gemini project lookup failed (HTTP ${projectResponse.status})`
      }, { source: 'oauth', attemptedSources: ['oauth'] })
    }
    const projectData = record(await responseJson(projectResponse))
    const projectId = typeof projectData?.cloudaicompanionProject === 'string' ? projectData.cloudaicompanionProject : ''
    if (!projectId) return providerError('gemini', runtime, 'Gemini project ID not found', 'parse')
    const quotaResponse = await runtime.fetch(GEMINI_QUOTA_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ project: projectId })
    })
    if (!quotaResponse.ok) {
      return responseFailure('gemini', quotaResponse, runtime.now(), {
        rateLimited: 'Gemini quota request is rate limited',
        unauthorized: 'Gemini sign-in expired',
        generic: `Gemini quota request failed (HTTP ${quotaResponse.status})`
      }, { source: 'oauth', attemptedSources: ['oauth'] })
    }
    const mapped = mapGeminiUsage(await responseJson(quotaResponse), runtime.now())
    if (mapped.status !== 'ok') return { ...mapped, error: 'Gemini quota response could not be parsed', usageMetadata: { source: 'oauth', failureKind: 'parse' } }
    return { ...mapped, usageMetadata: { source: 'oauth', attemptedSources: ['oauth'], lastSuccessfulSource: 'oauth', credentialSource: 'gemini-cli' } }
  } catch {
    return providerError('gemini', runtime, runtime.signal.aborted ? 'Gemini usage refresh was cancelled' : 'Gemini usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
  }
}

function parseAntigravityJsonObjects(text: string): unknown[] {
  const values: unknown[] = []
  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (start < 0) {
      if (character === '{') {
        start = index
        depth = 1
      }
      continue
    }
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          values.push(JSON.parse(text.slice(start, index + 1)) as unknown)
        } catch {
          // Ignore non-JSON log braces and continue searching for the quota envelope.
        }
        start = -1
      }
    }
  }
  return values
}
export async function fetchAntigravityUsage(runtime: ProviderRuntime): Promise<ProviderSnapshot> {
  const env = { ...process.env, AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }
  const version = await runtime.run('agy', ['--version'], { timeoutMs: 5_000, maxOutputBytes: 8_192, env })
  const versionText = version.stdout.trim() || version.stderr.trim()
  const parsedVersion = versionTuple(versionText)
  if (version.code !== 0 || version.timedOut || !parsedVersion) {
    return providerError('antigravity', runtime, 'Antigravity CLI version could not be read', 'cli-unavailable', 'unavailable')
  }
  if (!versionAtLeast(parsedVersion, [1, 1, 11])) {
    return providerError('antigravity', runtime, 'Antigravity usage needs agy 1.1.11 or newer', 'usage-unavailable', 'unavailable')
  }
  const result = await runtime.run('agy', ['-p', '/usage', '--output-format', 'json', '--print-timeout', '20s'], {
    timeoutMs: 30_000,
    maxOutputBytes: 512 * 1024,
    env
  })
  if (result.timedOut) return providerError('antigravity', runtime, 'Antigravity CLI did not answer in time', 'usage-unavailable')
  if (result.code === null) return providerError('antigravity', runtime, 'Antigravity CLI is not installed', 'cli-unavailable', 'unavailable')
  for (const parsed of parseAntigravityJsonObjects(result.stdout)) {
    const mapped = mapAntigravityUsage(parsed, runtime.now())
    if (mapped.status === 'ok') return { ...mapped, usageMetadata: { source: 'cli', attemptedSources: ['cli'], lastSuccessfulSource: 'cli', credentialSource: 'antigravity-cli' } }
  }
  return providerError('antigravity', runtime, 'Antigravity CLI did not report quota', result.code === 0 ? 'parse' : 'usage-unavailable')
}

export async function fetchKimiUsage(runtime: ProviderRuntime): Promise<ProviderSnapshot> {
  const envHome = process.env.KIMI_CODE_HOME?.trim()
  const kimiHome = envHome || join(homeDirectory(), '.kimi-code')
  const credentialFile = record(await readJsonFile(join(kimiHome, 'credentials', 'kimi-code.json')))
  const accessToken = typeof credentialFile?.access_token === 'string' ? credentialFile.access_token : ''
  const expiresAt = typeof credentialFile?.expires_at === 'number' ? credentialFile.expires_at : null
  if (!accessToken) return providerError('kimi', runtime, 'Not signed in to Kimi Code', 'missing-credentials', 'unavailable')
  if (expiresAt === null || expiresAt * 1000 - runtime.now() <= 5_000) {
    return providerError('kimi', runtime, 'Kimi session expired — run kimi to refresh it', 'delegated-refresh-required')
  }
  const configuredBase = process.env.KIMI_CODE_BASE_URL?.trim()
  let endpoint = KIMI_USAGE_URL
  if (configuredBase) {
    try {
      const parsed = new URL(configuredBase)
      if (parsed.protocol !== 'https:' || parsed.hostname !== 'api.kimi.com' || parsed.port !== '' || parsed.pathname.replace(/\/$/, '') !== '/coding/v1') {
        return providerError('kimi', runtime, 'Kimi usage base URL is not allowlisted', 'usage-unavailable')
      }
      endpoint = `${parsed.origin}/coding/v1/usages`
    } catch {
      return providerError('kimi', runtime, 'Kimi usage base URL is invalid', 'usage-unavailable')
    }
  }
  try {
    const response = await runtime.fetch(endpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
      redirect: 'error',
      credentials: 'omit'
    })
    if (!response.ok) {
      return responseFailure('kimi', response, runtime.now(), {
        rateLimited: 'Kimi usage is rate limited',
        unauthorized: `Kimi usage request unauthorized (HTTP ${response.status})`,
        generic: `Kimi usage request failed (HTTP ${response.status})`
      }, { source: 'oauth', credentialSource: 'kimi-cli' })
    }
    const mapped = mapKimiUsage(await responseJson(response), runtime.now())
    return mapped.status === 'ok'
      ? { ...mapped, usageMetadata: { source: 'oauth', attemptedSources: ['oauth'], lastSuccessfulSource: 'oauth', credentialSource: 'kimi-cli' } }
      : { ...mapped, error: 'Kimi usage response did not include quota windows', usageMetadata: { source: 'oauth', failureKind: 'parse' } }
  } catch {
    return providerError('kimi', runtime, runtime.signal.aborted ? 'Kimi usage refresh was cancelled' : 'Kimi usage request failed', runtime.signal.aborted ? 'usage-unavailable' : 'network')
  }
}

