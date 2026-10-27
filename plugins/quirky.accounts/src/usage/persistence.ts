import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import { USAGE_PROVIDERS, type ExtraUsage, type ProviderSnapshot, type RateLimitResetCredits, type ResetCreditExpectedScope, type UsageFailureKind, type UsageMetadata, type UsageProvider, type UsageSource, type UsageWindow } from './types'

const SNAPSHOT_FILE = 'usage-snapshots.json'
const RESET_LEDGER_FILE = 'usage-reset-ledger.json'
const MAX_SNAPSHOT_FILE_BYTES = 4 * 1024 * 1024
const MAX_LEDGER_FILE_BYTES = 4 * 1024 * 1024
const SOURCES: readonly UsageSource[] = ['oauth', 'cli', 'web', 'live-session']
const FAILURE_KINDS: readonly UsageFailureKind[] = [
  'missing-credentials', 'stale-token', 'refreshable-credentials-without-token', 'delegated-refresh-required',
  'deferred-by-live-session', 'keychain-unavailable', 'missing-scope', 'no-subscription', 'network', 'server',
  'parse', 'rate-limited', 'cli-unavailable', 'usage-unavailable', 'unknown'
]

export type ResetLedgerEntry = {
  scope: ResetCreditExpectedScope
  status: 'in-flight' | 'unknown' | 'completed'
  outcome?: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed'
}

export function usageIdentityKey(provider: UsageProvider, accountId: string | null, home: string | null): string {
  return createHash('sha256').update(JSON.stringify([provider, accountId, home])).digest('hex')
}

export function resetIdKey(idempotencyKey: string): string {
  return createHash('sha256').update(idempotencyKey).digest('hex')
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseWindow(value: unknown): UsageWindow | null {
  const data = record(value)
  const percent = finite(data?.usedPercent)
  const minutes = finite(data?.windowMinutes)
  if (percent === null || minutes === null || minutes < 0) return null
  const resetsAt = data?.resetsAt === null ? null : finite(data?.resetsAt)
  return {
    usedPercent: Math.min(100, Math.max(0, percent)),
    windowMinutes: minutes,
    resetsAt,
    resetDescription: typeof data?.resetDescription === 'string' ? data.resetDescription : null
  }
}

function parseExtraUsage(value: unknown): ExtraUsage | null {
  const data = record(value)
  if (!data || typeof data.enabled !== 'boolean') return null
  const common = {
    enabled: data.enabled,
    disabledReason: typeof data.disabledReason === 'string' ? data.disabledReason : null,
    resetsAt: data.resetsAt === null ? null : finite(data.resetsAt)
  }
  if (data.unit === 'credits') {
    const balance = finite(data.balance)
    if (balance === null || typeof data.unlimited !== 'boolean') return null
    return { ...common, unit: 'credits', balance, unlimited: data.unlimited }
  }
  if (data.unit === 'currency' && typeof data.currencyCode === 'string') {
    return {
      ...common,
      unit: 'currency',
      balance: data.balance === null ? null : finite(data.balance),
      currencyCode: data.currencyCode,
      spent: data.spent === null ? null : finite(data.spent),
      spendLimit: data.spendLimit === null ? null : finite(data.spendLimit),
      spentPercent: data.spentPercent === null ? null : finite(data.spentPercent)
    }
  }
  return null
}

function parseScope(value: unknown): ResetCreditExpectedScope | null {
  const data = record(value)
  if (!data || (data.accountId !== null && typeof data.accountId !== 'string')) return null
  const accountRevision = finite(data.accountRevision)
  if (accountRevision === null || typeof data.offerRevision !== 'string') return null
  return { accountId: data.accountId, accountRevision, offerRevision: data.offerRevision }
}

function parseResetCredits(value: unknown): RateLimitResetCredits | null {
  const data = record(value)
  const count = finite(data?.availableCount)
  if (count === null) return null
  const credits = Array.isArray(data?.credits) ? data.credits.flatMap((item) => {
    const credit = record(item)
    if (!credit || typeof credit.status !== 'string') return []
    return [{ status: credit.status, expiresAt: credit.expiresAt === null ? null : finite(credit.expiresAt), grantedAt: credit.grantedAt === null ? null : finite(credit.grantedAt) }]
  }) : undefined
  const expectedScope = parseScope(data?.expectedScope)
  return {
    availableCount: Math.max(0, Math.floor(count)),
    ...(finite(data?.totalEarnedCount) !== null ? { totalEarnedCount: Math.max(0, Math.floor(finite(data?.totalEarnedCount)!)) } : {}),
    ...(data?.nextExpiresAt === null ? { nextExpiresAt: null } : finite(data?.nextExpiresAt) !== null ? { nextExpiresAt: finite(data?.nextExpiresAt)! } : {}),
    ...(credits ? { credits } : {}),
    ...(expectedScope ? { expectedScope } : {})
  }
}

function parseMetadata(value: unknown): UsageMetadata | undefined {
  const data = record(value)
  if (!data) return undefined
  const source = SOURCES.includes(data.source as UsageSource) ? data.source as UsageSource : undefined
  const lastSuccessfulSource = SOURCES.includes(data.lastSuccessfulSource as UsageSource) ? data.lastSuccessfulSource as UsageSource : undefined
  const failureKind = FAILURE_KINDS.includes(data.failureKind as UsageFailureKind) ? data.failureKind as UsageFailureKind : undefined
  const attemptedSources = Array.isArray(data.attemptedSources) ? data.attemptedSources.filter((item): item is UsageSource => SOURCES.includes(item as UsageSource)) : undefined
  const retryAtMs = finite(data.retryAtMs)
  return {
    ...(source ? { source } : {}),
    ...(attemptedSources ? { attemptedSources } : {}),
    ...(failureKind ? { failureKind } : {}),
    ...(typeof data.credentialSource === 'string' ? { credentialSource: data.credentialSource } : {}),
    ...(typeof data.authProvenance === 'string' ? { authProvenance: data.authProvenance } : {}),
    ...(lastSuccessfulSource ? { lastSuccessfulSource } : {}),
    ...(retryAtMs !== null ? { retryAtMs } : {})
  }
}

function parseSnapshot(value: unknown): ProviderSnapshot | null {
  const data = record(value)
  if (!data || typeof data.provider !== 'string' || !USAGE_PROVIDERS.includes(data.provider as UsageProvider)) return null
  if (data.accountId !== null && typeof data.accountId !== 'string') return null
  const updatedAt = finite(data.updatedAt)
  const session = data.session === null ? null : parseWindow(data.session)
  const weekly = data.weekly === null ? null : parseWindow(data.weekly)
  if (updatedAt === null || (data.status !== 'idle' && data.status !== 'fetching' && data.status !== 'ok' && data.status !== 'error' && data.status !== 'unavailable') || (data.error !== null && typeof data.error !== 'string') || (data.session !== null && session === null) || (data.weekly !== null && weekly === null)) return null
  const monthly = data.monthly === null ? null : parseWindow(data.monthly)
  const fableWeekly = data.fableWeekly === null ? null : parseWindow(data.fableWeekly)
  const buckets = Array.isArray(data.buckets) ? data.buckets.flatMap((item) => {
    const bucket = record(item)
    const mapped = parseWindow(bucket)
    if (!bucket || !mapped || typeof bucket.name !== 'string') return []
    return [{ ...mapped, name: bucket.name, ...(typeof bucket.group === 'string' ? { group: bucket.group } : {}), ...(typeof bucket.windowName === 'string' ? { windowName: bucket.windowName } : {}) }]
  }) : undefined
  const extraUsage = data.extraUsage === null ? null : parseExtraUsage(data.extraUsage)
  const credits = data.rateLimitResetCredits === null ? null : parseResetCredits(data.rateLimitResetCredits)
  const metadata = parseMetadata(data.usageMetadata)
  return {
    provider: data.provider as UsageProvider,
    accountId: data.accountId,
    ...(finite(data.accountRevision) !== null ? { accountRevision: finite(data.accountRevision)! } : {}),
    status: data.status,
    error: data.error,
    updatedAt,
    session,
    weekly,
    ...(data.monthly === null ? { monthly: null } : monthly ? { monthly } : {}),
    ...(data.fableWeekly === null ? { fableWeekly: null } : fableWeekly ? { fableWeekly } : {}),
    ...(buckets ? { buckets } : {}),
    ...(data.extraUsage === null ? { extraUsage: null } : extraUsage ? { extraUsage } : {}),
    ...(data.rateLimitResetCredits === null ? { rateLimitResetCredits: null } : credits ? { rateLimitResetCredits: credits } : {}),
    ...(typeof data.planType === 'string' || data.planType === null ? { planType: data.planType } : {}),
    ...(metadata ? { usageMetadata: metadata } : {})
  }
}

function parseLedger(value: unknown): Map<string, ResetLedgerEntry> {
  const root = record(value)
  const entries = new Map<string, ResetLedgerEntry>()
  if (!root) return entries
  for (const [key, raw] of Object.entries(root)) {
    const entry = record(raw)
    const scope = parseScope(entry?.scope)
    const status = entry?.status
    if (!scope || (status !== 'in-flight' && status !== 'unknown' && status !== 'completed')) continue
    const outcome = entry?.outcome
    entries.set(key, {
      scope,
      status: status === 'in-flight' ? 'unknown' : status,
      ...(outcome === 'reset' || outcome === 'nothingToReset' || outcome === 'noCredit' || outcome === 'alreadyRedeemed' ? { outcome } : {})
    })
  }
  return entries
}

function readJson(path: string, maxBytes: number): unknown {
  let fd: number
  try {
    const info = lstatSync(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) return null
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBytes) return null
    const buffer = Buffer.alloc(info.size)
    const length = readSync(fd, buffer, 0, buffer.length, 0)
    return JSON.parse(buffer.subarray(0, length).toString('utf8')) as unknown
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}

function writeJson(path: string, data: unknown): void {
  const directory = join(path, '..')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const temp = join(directory, `.${randomUUID()}.tmp`)
  const fd = openSync(temp, 'wx', 0o600)
  try {
    writeFileSync(fd, JSON.stringify(data), 'utf8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  try {
    renameSync(temp, path)
    chmodSync(path, 0o600)
  } catch (error) {
    try { unlinkSync(temp) } catch { /* temporary entry may already be gone */ }
    throw error
  }
}

export function readUsageSnapshots(dataDir: string): Map<string, ProviderSnapshot> {
  const raw = record(readJson(join(dataDir, SNAPSHOT_FILE), MAX_SNAPSHOT_FILE_BYTES))
  const snapshots = new Map<string, ProviderSnapshot>()
  if (!raw) return snapshots
  for (const [key, value] of Object.entries(raw)) {
    const snapshot = parseSnapshot(value)
    if (snapshot) snapshots.set(key, snapshot)
  }
  return snapshots
}

export function persistUsageSnapshots(dataDir: string, snapshots: Map<string, ProviderSnapshot>): void {
  const safe: Record<string, ProviderSnapshot> = {}
  for (const [key, snapshot] of snapshots) safe[key] = snapshot
  writeJson(join(dataDir, SNAPSHOT_FILE), safe)
}

export function readResetLedger(dataDir: string): Map<string, ResetLedgerEntry> {
  return parseLedger(readJson(join(dataDir, RESET_LEDGER_FILE), MAX_LEDGER_FILE_BYTES))
}

export function persistResetLedger(dataDir: string, ledger: Map<string, ResetLedgerEntry>): void {
  const safe: Record<string, ResetLedgerEntry> = {}
  for (const [key, entry] of ledger) safe[key] = entry
  writeJson(join(dataDir, RESET_LEDGER_FILE), safe)
}
