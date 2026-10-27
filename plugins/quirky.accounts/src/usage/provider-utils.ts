import { lstat, readFile } from 'node:fs/promises'
import type { ProviderSnapshot, UsageFailureKind, UsageMetadata, UsageProvider } from './types'

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

export function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

export function parseRetryAfterMs(header: string | null, now = Date.now()): number | null {
  if (!header?.trim()) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - now) : null
}

export function errorSnapshot(
  provider: UsageProvider,
  now: number,
  message: string,
  failureKind: UsageFailureKind,
  status: 'error' | 'unavailable' = 'error',
  metadata: Partial<UsageMetadata> = {}
): ProviderSnapshot {
  return {
    provider,
    accountId: null,
    status,
    error: message,
    updatedAt: now,
    session: null,
    weekly: null,
    usageMetadata: { ...metadata, failureKind }
  }
}

export function parseTimestamp(value: unknown, seconds = false): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = seconds && value < 10_000_000_000 ? value * 1000 : value
    return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      const timestamp = seconds && numeric < 10_000_000_000 ? numeric * 1000 : numeric
      return Number.isFinite(new Date(timestamp).getTime()) ? timestamp : null
    }
    const timestamp = Date.parse(value)
    return Number.isFinite(timestamp) ? timestamp : null
  }
  return null
}

export async function readJsonFile(path: string, maxBytes = 2_000_000): Promise<unknown | null> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null
    const text = await readFile(path, 'utf8')
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

export async function responseJson(response: Response): Promise<unknown | null> {
  try {
    return await response.json() as unknown
  } catch {
    return null
  }
}

export function responseFailure(
  provider: UsageProvider,
  response: Response,
  now: number,
  names: { rateLimited: string; unauthorized?: string; generic?: string },
  metadata: Partial<UsageMetadata> = {}
): ProviderSnapshot {
  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), now)
    return errorSnapshot(provider, now, names.rateLimited, 'rate-limited', 'error', {
      ...metadata,
      ...(retryAfterMs !== null ? { retryAtMs: now + retryAfterMs } : {})
    })
  }
  if (response.status === 401 || response.status === 403) {
    return errorSnapshot(provider, now, names.unauthorized ?? `Sign-in expired (HTTP ${response.status})`, 'stale-token', 'error', metadata)
  }
  return errorSnapshot(provider, now, names.generic ?? `Usage request failed (HTTP ${response.status})`, response.status >= 500 ? 'server' : 'usage-unavailable', 'error', metadata)
}

