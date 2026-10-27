export const USAGE_PROVIDERS = [
  'claude',
  'codex',
  'gemini',
  'antigravity',
  'opencode-go',
  'kimi',
  'minimax',
  'grok',
  'cursor',
  'zcode'
] as const

export type UsageProvider = (typeof USAGE_PROVIDERS)[number]
export type UsageStatus = 'idle' | 'fetching' | 'ok' | 'error' | 'unavailable'
export type UsageSource = 'oauth' | 'cli' | 'web' | 'live-session'
export type UsageFailureKind =
  | 'missing-credentials'
  | 'stale-token'
  | 'refreshable-credentials-without-token'
  | 'delegated-refresh-required'
  | 'deferred-by-live-session'
  | 'keychain-unavailable'
  | 'missing-scope'
  | 'no-subscription'
  | 'network'
  | 'server'
  | 'parse'
  | 'rate-limited'
  | 'cli-unavailable'
  | 'usage-unavailable'
  | 'unknown'

export type UsageWindow = {
  usedPercent: number
  windowMinutes: number
  resetsAt: number | null
  resetDescription: string | null
}

export type UsageBucket = UsageWindow & {
  name: string
  group?: string
  windowName?: string
}

export type ExtraUsageBase = {
  enabled: boolean
  disabledReason: string | null
  resetsAt: number | null
}

export type CurrencyExtraUsage = ExtraUsageBase & {
  unit: 'currency'
  balance: number | null
  currencyCode: string
  spent: number | null
  spendLimit: number | null
  spentPercent: number | null
}

export type CreditExtraUsage = ExtraUsageBase & {
  unit: 'credits'
  balance: number
  unlimited: boolean
}

export type ExtraUsage = CurrencyExtraUsage | CreditExtraUsage

export type ResetCreditExpectedScope = {
  accountId: string | null
  accountRevision: number
  offerRevision: string
}

export type RateLimitResetCredits = {
  availableCount: number
  totalEarnedCount?: number
  nextExpiresAt?: number | null
  credits?: {
    status: string
    expiresAt: number | null
    grantedAt: number | null
  }[]
  expectedScope?: ResetCreditExpectedScope
}

export type UsageMetadata = {
  source?: UsageSource
  attemptedSources?: UsageSource[]
  failureKind?: UsageFailureKind
  credentialSource?: string
  authProvenance?: string
  lastSuccessfulSource?: UsageSource
  retryAtMs?: number
}

export type ProviderSnapshot = {
  provider: UsageProvider
  accountId: string | null
  accountRevision?: number
  status: UsageStatus
  error: string | null
  updatedAt: number
  session: UsageWindow | null
  weekly: UsageWindow | null
  monthly?: UsageWindow | null
  fableWeekly?: UsageWindow | null
  buckets?: UsageBucket[]
  extraUsage?: ExtraUsage | null
  rateLimitResetCredits?: RateLimitResetCredits | null
  planType?: string | null
  usageMetadata?: UsageMetadata
}

export type UsageTarget = {
  provider: string
  accountId: string | null
  home: string | null
  active: boolean
  label: string
  revision?: number
}

export type UsageState = {
  providers: ProviderSnapshot[]
  inactive: Record<string, ProviderSnapshot>
  updatedAt: number
}

export type CredentialStatus = {
  provider: string
  kind: string
  configured: boolean
  readable: boolean
}

export type UsageRefreshOptions = {
  provider?: string
  force?: boolean
}

export type ResetCreditConsumeOptions = {
  idempotencyKey: string
  expectedScope: ResetCreditExpectedScope
  yes?: boolean
}
