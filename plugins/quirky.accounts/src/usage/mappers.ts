import type {
  ExtraUsage,
  ProviderSnapshot,
  RateLimitResetCredits,
  UsageBucket,
  UsageProvider,
  UsageWindow
} from './types'

const SESSION_MINUTES = 300
const WEEKLY_MINUTES = 10_080
const MONTHLY_MINUTES = 43_200

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function clamped(value: number): number {
  return Math.min(100, Math.max(0, value))
}

function timestamp(value: unknown, numericSeconds = false): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const result = numericSeconds && value < 10_000_000_000 ? value * 1000 : value
    return Number.isFinite(new Date(result).getTime()) ? result : null
  }
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) {
      const result = numericSeconds && numeric < 10_000_000_000 ? numeric * 1000 : numeric
      return Number.isFinite(new Date(result).getTime()) ? result : null
    }
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

function description(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null
  const date = new Date(resetsAt)
  const today = new Date(now)
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
}

function window(
  usedPercent: number,
  windowMinutes: number,
  resetsAt: number | null,
  now: number
): UsageWindow {
  return {
    usedPercent: clamped(usedPercent),
    windowMinutes,
    resetsAt,
    resetDescription: description(resetsAt, now)
  }
}

function snapshot(
  provider: UsageProvider,
  now: number,
  values: Partial<ProviderSnapshot> = {}
): ProviderSnapshot {
  return {
    provider,
    accountId: null,
    status: 'ok',
    error: null,
    updatedAt: now,
    session: null,
    weekly: null,
    ...values
  }
}

function readUsageWindow(value: unknown, minutes: number, now: number): UsageWindow | null {
  const data = record(value)
  if (!data) return null
  const amount = finite(data.utilization) ?? finite(data.used_percentage) ?? finite(data.percent)
  if (amount === null) return null
  return window(amount, minutes, timestamp(data.resets_at ?? data.resetAt ?? data.resetsAt, true), now)
}

function mapClaudeSpend(value: unknown): ExtraUsage | null {
  const spend = record(value)
  if (!spend) return null
  const money = (item: unknown): number | null => {
    const parsed = record(item)
    if (!parsed) return finite(item)
    const amount = finite(parsed.amount_minor)
    const exponent = finite(parsed.exponent) ?? 2
    return amount === null || exponent < 0 || exponent > 6 || !Number.isInteger(exponent)
      ? null
      : amount / 10 ** exponent
  }
  const used = money(spend.used)
  const cap = record(spend.cap)
  const limit = money(spend.limit) ?? money(cap?.money)
  const balance = money(spend.balance)
  const percent = finite(spend.percent) ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null)
  if (used === null && limit === null && balance === null && percent === null) return null
  const currency = record(spend.limit)?.currency ?? record(spend.used)?.currency
  return {
    unit: 'currency',
    enabled: spend.enabled === true,
    disabledReason: typeof spend.disabled_reason === 'string' ? spend.disabled_reason : null,
    resetsAt: null,
    balance,
    currencyCode: typeof currency === 'string' ? currency : 'USD',
    spent: used,
    spendLimit: limit,
    spentPercent: percent === null ? null : clamped(percent)
  }
}

function mapClaudeLegacyExtra(value: unknown): ExtraUsage | null {
  const extra = record(value)
  if (!extra) return null
  const limit = finite(extra.monthly_limit)
  const used = finite(extra.used_credits)
  const percent = finite(extra.utilization)
  if (limit === null && used === null && percent === null) return null
  const exponent = finite(extra.decimal_places) ?? 2
  const divisor = 10 ** Math.max(0, Math.min(6, exponent))
  const spent = used === null ? null : used / divisor
  const spendLimit = limit === null ? null : limit / divisor
  return {
    unit: 'currency',
    enabled: extra.is_enabled === true,
    disabledReason: typeof extra.disabled_reason === 'string' ? extra.disabled_reason : null,
    resetsAt: null,
    balance: null,
    currencyCode: typeof extra.currency === 'string' ? extra.currency.trim() || 'USD' : 'USD',
    spent,
    spendLimit,
    spentPercent: percent === null ? spendLimit !== null && spendLimit > 0 && spent !== null ? clamped((spent / spendLimit) * 100) : null : clamped(percent)
  }
}

export function mapClaudeUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const data = record(value) ?? {}
  const session = readUsageWindow(data.five_hour, SESSION_MINUTES, now)
  const weekly = readUsageWindow(data.seven_day, WEEKLY_MINUTES, now)
  let fableWeekly =
    readUsageWindow(data.fable_weekly, WEEKLY_MINUTES, now) ??
    readUsageWindow(data.fable_seven_day, WEEKLY_MINUTES, now) ??
    readUsageWindow(data.seven_day_fable, WEEKLY_MINUTES, now)
  const limits = Array.isArray(data.limits) ? data.limits : []
  for (const item of limits) {
    const limit = record(item)
    const scope = record(limit?.scope)
    const model = record(scope?.model)
    if (limit?.kind === 'weekly_scoped' && typeof model?.display_name === 'string' && model.display_name.toLowerCase() === 'fable') {
      const candidate = readUsageWindow({ utilization: limit.percent, resets_at: limit.resets_at }, WEEKLY_MINUTES, now)
      if (candidate) fableWeekly = candidate
    }
  }
  const extraUsage = mapClaudeSpend(data.spend) ?? mapClaudeLegacyExtra(data.extra_usage)
  const hasUsage = session !== null || weekly !== null || fableWeekly !== null
  return snapshot('claude', now, {
    session,
    weekly,
    ...(fableWeekly ? { fableWeekly } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    status: hasUsage ? 'ok' : 'error',
    error: hasUsage ? null : 'Claude usage response did not include quota windows',
    usageMetadata: { source: 'oauth' }
  })
}

function resetCredits(value: unknown): RateLimitResetCredits | null {
  const data = record(value)
  if (!data) return null
  const count = finite(data.availableCount)
  if (count === null) return null
  const rawCredits = Array.isArray(data.credits) ? data.credits : null
  const credits = rawCredits?.flatMap((item) => {
    const credit = record(item)
    if (!credit) return []
    return [{
      status: typeof credit.status === 'string' ? credit.status.toLowerCase() : 'unknown',
      expiresAt: timestamp(credit.expiresAt, true),
      grantedAt: timestamp(credit.grantedAt, true)
    }]
  })
  const available = Math.max(0, Math.floor(count))
  const expiries = credits?.filter((credit) => credit.status === 'available').map((credit) => credit.expiresAt).filter((date): date is number => date !== null).sort((left, right) => left - right) ?? []
  return {
    availableCount: available,
    ...(finite(data.totalEarnedCount) !== null ? { totalEarnedCount: Math.max(0, Math.floor(finite(data.totalEarnedCount)!)) } : {}),
    nextExpiresAt: timestamp(data.nextExpiresAt, true) ?? expiries[0] ?? null,
    ...(credits ? { credits } : {})
  }
}

function codexWindow(value: unknown, fallback: number, now: number): { duration: number; reading: UsageWindow } | null {
  const data = record(value)
  const used = finite(data?.usedPercent)
  if (used === null) return null
  const duration = finite(data?.windowDurationMins) ?? fallback
  return { duration, reading: window(used, duration, timestamp(data?.resetsAt, true), now) }
}

export function mapCodexUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const root = record(value) ?? {}
  const rates = record(root.rateLimits) ?? root
  const primary = codexWindow(rates.primary, SESSION_MINUTES, now)
  const secondary = codexWindow(rates.secondary, WEEKLY_MINUTES, now)
  const windows = [primary, secondary].filter((item): item is NonNullable<typeof item> => item !== null)
  let session = windows.find((item) => Math.abs(item.duration - SESSION_MINUTES) <= 1)?.reading ?? null
  let weekly = windows.find((item) => Math.abs(item.duration - WEEKLY_MINUTES) <= 1)?.reading ?? null
  if (!session && !weekly) {
    session = primary?.reading ?? null
    weekly = secondary?.reading ?? null
  } else {
    if (!session && primary && primary.duration !== WEEKLY_MINUTES) session = primary.reading
    if (!weekly && secondary && secondary.duration !== SESSION_MINUTES) weekly = secondary.reading
  }
  const rawCredits = record(rates.credits)
  const balance = finite(rawCredits?.balance)
  const extraUsage: ExtraUsage | null = rawCredits && (rawCredits.hasCredits === true || rawCredits.unlimited === true) && (balance !== null || rawCredits.unlimited === true)
    ? { unit: 'credits', balance: Math.max(0, balance ?? 0), unlimited: rawCredits.unlimited === true, enabled: true, disabledReason: null, resetsAt: null }
    : null
  const credits = resetCredits(root.rateLimitResetCredits)
  const account = record(root.account)
  const planType = typeof root.planType === 'string' ? root.planType : typeof account?.planType === 'string' ? account.planType : null
  const hasUsage = session !== null || weekly !== null || credits !== null || extraUsage !== null
  return snapshot('codex', now, {
    session,
    weekly,
    ...(credits ? { rateLimitResetCredits: credits } : {}),
    ...(extraUsage ? { extraUsage } : {}),
    planType,
    status: hasUsage ? 'ok' : 'error',
    error: hasUsage ? null : 'Codex rate limit response did not include quota windows',
    usageMetadata: { source: 'cli' }
  })
}

const GEMINI_NAMES: Record<string, string> = {
  'gemini-3.1-pro': '3.1 Pro',
  'gemini-3.1-flash': '3.1 Flash',
  'gemini-3.1-flash-lite': '3.1 Flash Lite',
  'gemini-3.0-pro': '3.0 Pro',
  'gemini-3.0-flash': '3.0 Flash',
  'gemini-2.5-pro': 'Pro',
  'gemini-2.5-flash': 'Flash',
  'gemini-2.5-flash-lite': 'Flash Lite',
  'gemini-2.0-pro': '2.0 Pro',
  'gemini-2.0-flash': '2.0 Flash',
  'gemini-2.0-flash-lite': '2.0 Flash Lite',
  'gemini-exp': 'Exp',
  'gemini-experimental': 'Exp'
}

export function mapGeminiUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const data = record(value)
  const rawBuckets = Array.isArray(value) ? value : Array.isArray(data?.buckets) ? data.buckets : []
  const buckets: UsageBucket[] = rawBuckets.flatMap((item) => {
    const bucket = record(item)
    const remaining = finite(bucket?.remainingFraction)
    if (remaining === null || typeof bucket?.modelId !== 'string') return []
    const reset = timestamp(bucket.resetTime)
    const modelId = bucket.modelId
    const human = GEMINI_NAMES[modelId] ?? modelId.replace(/^gemini-/i, '').split('-').map((part) => part ? part[0]!.toUpperCase() + part.slice(1) : part).join(' ')
    return [windowBucket(human, clamped((1 - remaining) * 100), 60, reset, now)]
  })
  const mostUsed = buckets.reduce<UsageBucket | null>((selected, current) => selected === null || current.usedPercent > selected.usedPercent ? current : selected, null)
  return snapshot('gemini', now, {
    session: mostUsed ? window(mostUsed.usedPercent, mostUsed.windowMinutes, mostUsed.resetsAt, now) : null,
    weekly: null,
    buckets,
    status: buckets.length > 0 ? 'ok' : 'unavailable',
    error: buckets.length > 0 ? null : 'Gemini CLI credentials or quota are unavailable',
    usageMetadata: { source: 'oauth' }
  })
}

function windowBucket(name: string, usedPercent: number, minutes: number, resetsAt: number | null, now: number, extra: Partial<UsageBucket> = {}): UsageBucket {
  return { name, ...window(usedPercent, minutes, resetsAt, now), ...extra }
}

export function mapAntigravityUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const root = record(value)
  const command = record(root?.command)
  const data = record(command?.data)
  const groups = Array.isArray(data?.groups) ? data.groups : []
  const buckets: UsageBucket[] = []
  for (const item of groups) {
    const group = record(item)
    if (typeof group?.name !== 'string' || !Array.isArray(group.buckets)) continue
    const enabled = group.buckets.filter((bucket) => record(bucket)?.disabled !== true)
    for (const raw of enabled) {
      const bucket = record(raw)
      const fraction = finite(bucket?.remaining_fraction)
      if (fraction === null || typeof bucket?.id !== 'string') continue
      const windowName = typeof bucket.name === 'string' ? bucket.name : undefined
      const minutes = bucket.window === 'weekly' ? WEEKLY_MINUTES : bucket.window === '5h' ? SESSION_MINUTES : 0
      const reset = timestamp(bucket?.reset_time)
      const name = enabled.length > 1 && windowName ? `${group.name} · ${windowName}` : group.name
      buckets.push(windowBucket(name, clamped((1 - fraction) * 100), minutes, reset, now, { group: group.name, ...(windowName ? { windowName } : {}) }))
    }
  }
  if (root?.status !== 'SUCCESS' || command?.name !== 'usage' || buckets.length === 0) {
    return snapshot('antigravity', now, { status: 'unavailable', error: 'Antigravity usage is unavailable', usageMetadata: { source: 'cli', failureKind: 'usage-unavailable' } })
  }
  const constrained = (minutes: number): UsageWindow | null => {
    const selected = buckets.filter((bucket) => bucket.windowMinutes === minutes).sort((left, right) => right.usedPercent - left.usedPercent)[0]
    return selected ? window(selected.usedPercent, selected.windowMinutes, selected.resetsAt, now) : null
  }
  return snapshot('antigravity', now, {
    session: constrained(SESSION_MINUTES),
    weekly: constrained(WEEKLY_MINUTES),
    buckets,
    usageMetadata: { source: 'cli', credentialSource: 'antigravity-cli' }
  })
}

function openCodeWindow(value: unknown, minutes: number, now: number): UsageWindow | null {
  const data = record(value)
  if (!data) return null
  const percent = finite(data.percent)
  if (percent !== null) return window(percent, minutes, timestamp(data.resetsAt), now)
  const used = finite(data.usedMicroCents)
  const limit = finite(data.limitMicroCents)
  return used === null || limit === null || limit <= 0 ? null : window((used / limit) * 100, minutes, timestamp(data.resetsAt), now)
}

export function mapOpenCodeGoUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const root = record(value) ?? {}
  const usage = record(root.usage)
  const meters = record(record(record(root.access)?.meters)?.fiveHour) ? record(root.access)?.meters : null
  const session = openCodeWindow(usage?.rolling ?? record(meters)?.fiveHour, SESSION_MINUTES, now)
  const weekly = openCodeWindow(usage?.weekly ?? record(meters)?.week, WEEKLY_MINUTES, now)
  const monthly = openCodeWindow(usage?.monthly ?? record(meters)?.month, MONTHLY_MINUTES, now)
  const hasUsage = session !== null && weekly !== null
  const balance = parseOpenCodeBalance(value)
  return snapshot('opencode-go', now, {
    session,
    weekly,
    ...(monthly ? { monthly } : {}),
    ...(balance ? { extraUsage: balance } : {}),
    status: hasUsage ? 'ok' : 'error',
    error: hasUsage ? null : 'OpenCode Go usage response did not include quota windows',
    usageMetadata: { source: 'web' }
  })
}

function parseOpenCodeBalance(value: unknown): ExtraUsage | null {
  const data = record(value)
  if (typeof data?.billingMode !== 'string' || data.billingMode !== 'prepaid' || data.mode !== 'pay-as-you-go' || typeof data.balanceMicroCents !== 'string' || !/^-?\d+$/.test(data.balanceMicroCents)) return null
  const balance = Number(data.balanceMicroCents)
  if (!Number.isSafeInteger(balance)) return null
  return { unit: 'currency', balance: balance / 100_000_000, currencyCode: 'USD', enabled: true, disabledReason: null, spent: null, spendLimit: null, spentPercent: null, resetsAt: null }
}

function numericInt(value: unknown): number | null {
  const parsed = finite(value)
  return parsed === null ? null : parsed
}

function kimiMinutes(value: unknown): number | null {
  const data = record(value)
  const duration = numericInt(data?.duration)
  if (duration === null) return null
  const unit = typeof data?.timeUnit === 'string' ? data.timeUnit.toUpperCase() : ''
  if (unit.includes('MINUTE')) return duration
  if (unit.includes('HOUR')) return duration * 60
  if (unit.includes('DAY')) return duration * 1440
  if (unit.includes('SECOND')) return Math.round(duration / 60)
  return duration
}

function kimiWindow(value: unknown, minutes: number, now: number): UsageWindow | null {
  const data = record(value)
  if (!data) return null
  const limit = numericInt(data.limit)
  const used = numericInt(data.used) ?? (limit !== null ? limit - (numericInt(data.remaining) ?? Number.NaN) : null)
  if (limit === null || limit <= 0 || used === null || !Number.isFinite(used)) return null
  return window((used / limit) * 100, minutes, timestamp(data.resetTime ?? data.resetAt), now)
}

export function mapKimiUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const data = record(value) ?? {}
  const weekly = kimiWindow(data.usage, WEEKLY_MINUTES, now)
  let session: UsageWindow | null = null
  for (const item of Array.isArray(data.limits) ? data.limits : []) {
    const limit = record(item)
    const mapped = kimiWindow(limit?.detail, kimiMinutes(limit?.window) ?? SESSION_MINUTES, now)
    if (mapped && (session === null || Math.abs(mapped.windowMinutes - SESSION_MINUTES) < Math.abs(session.windowMinutes - SESSION_MINUTES))) session = mapped
  }
  const hasUsage = weekly !== null || session !== null
  return snapshot('kimi', now, {
    session,
    weekly,
    status: hasUsage ? 'ok' : 'error',
    error: hasUsage ? null : 'Kimi usage response did not include quota windows',
    usageMetadata: { source: 'oauth' }
  })
}

function miniMaxItem(value: unknown, now: number): { model: string; session: UsageWindow; weekly: UsageWindow | null } | null {
  const data = record(value)
  const remaining = finite(data?.current_interval_remaining_percent)
  const start = finite(data?.start_time)
  const end = finite(data?.end_time)
  if (typeof data?.model_name !== 'string' || remaining === null || start === null || end === null) return null
  const weekRemaining = finite(data.current_weekly_remaining_percent)
  const weeklyRemainMs = finite(data.weekly_remains_time)
  return {
    model: data.model_name,
    session: window(100 - remaining, SESSION_MINUTES, timestamp(end), now),
    weekly: weekRemaining === null ? null : window(100 - weekRemaining, WEEKLY_MINUTES, weeklyRemainMs === null ? null : now + weeklyRemainMs, now)
  }
}

export function mapMiniMaxUsage(value: unknown, models: readonly string[] = ['general'], now = Date.now()): ProviderSnapshot {
  const data = record(value) ?? {}
  const code = finite(record(data.base_resp)?.status_code)
  if (code !== null && code !== 0) {
    return snapshot('minimax', now, { status: 'error', error: code === 1004 ? 'MiniMax credential expired' : 'MiniMax returned an error', usageMetadata: { source: 'web', failureKind: code === 1004 ? 'stale-token' : 'usage-unavailable' } })
  }
  const candidates = (Array.isArray(data.model_remains) ? data.model_remains : []).map((item) => miniMaxItem(item, now)).filter((item): item is NonNullable<typeof item> => item !== null)
  const selected = models.map((name) => candidates.find((candidate) => candidate.model === name)).find((item): item is NonNullable<typeof item> => item !== undefined) ?? (candidates.length === 1 ? candidates[0] : undefined)
  if (!selected) return snapshot('minimax', now, { status: 'error', error: 'MiniMax usage data for the configured model was not found', usageMetadata: { source: 'web', failureKind: 'usage-unavailable' } })
  return snapshot('minimax', now, { session: selected.session, weekly: selected.weekly, usageMetadata: { source: 'web' } })
}

function grokConfig(value: unknown): Record<string, unknown> | null {
  const root = record(value)
  const config = record(root?.config)
  return config ?? root
}

function grokMoney(value: unknown): number | null {
  return finite(record(value)?.val)
}

function grokWindow(value: number, minutes: number, reset: unknown, now: number): UsageWindow {
  return window(value, minutes, timestamp(reset), now)
}

export function mapGrokUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const config = grokConfig(value) ?? {}
  const period = record(config.currentPeriod)
  const reset = period?.end ?? config.billingPeriodEnd
  let weeklyPercent = finite(config.creditUsagePercent)
  if (weeklyPercent === null && period?.type === 'USAGE_PERIOD_TYPE_WEEKLY' && timestamp(period.end) === timestamp(config.billingPeriodEnd) && timestamp(period.start) === timestamp(config.billingPeriodStart)) {
    const scalars = [config.onDemandCap, config.onDemandUsed, config.prepaidBalance, config.monthlyLimit, config.used].map(grokMoney)
    if (!scalars.some((item) => item === 0) && scalars.every((item) => item === null) && finite(config.creditUsagePercent) === null) weeklyPercent = 0
  }
  const weekly = weeklyPercent === null ? null : grokWindow(weeklyPercent, WEEKLY_MINUTES, reset, now)
  const limit = grokMoney(config.monthlyLimit)
  const used = grokMoney(config.used)
  const monthly = limit !== null && limit > 0 && used !== null ? grokWindow((used / limit) * 100, MONTHLY_MINUTES, reset, now) : null
  const cap = grokMoney(config.onDemandCap)
  const onDemandUsed = grokMoney(config.onDemandUsed)
  const balance = grokMoney(config.prepaidBalance)
  const extraUsage: ExtraUsage | null = cap !== null || onDemandUsed !== null || balance !== null
    ? { unit: 'currency', balance: balance ?? (cap !== null && onDemandUsed !== null ? Math.max(0, cap - onDemandUsed) : null), currencyCode: 'USD', enabled: true, disabledReason: null, spent: onDemandUsed, spendLimit: cap, spentPercent: cap !== null && onDemandUsed !== null && cap > 0 ? clamped((onDemandUsed / cap) * 100) : null, resetsAt: timestamp(reset) }
    : null
  const tier = typeof config.subscriptionTier === 'string' ? config.subscriptionTier : null
  const hasUsage = weekly !== null || monthly !== null || extraUsage !== null
  return snapshot('grok', now, { session: null, weekly, ...(monthly ? { monthly } : {}), ...(extraUsage ? { extraUsage } : {}), planType: tier, status: hasUsage ? 'ok' : 'unavailable', error: hasUsage ? null : 'Grok usage is unavailable', usageMetadata: { source: 'web', credentialSource: 'grok-cli' } })
}

function cursorPoolWindow(value: unknown, field: string, name: string, minutes: number, reset: number | null, now: number): UsageBucket | null {
  const pool = record(value)
  const used = finite(pool?.used)
  const limit = finite(pool?.limit)
  const percent = used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : finite(pool?.[field])
  return percent === null ? null : windowBucket(name, percent, minutes, reset, now)
}

export function mapCursorUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const data = record(value) ?? {}
  const start = timestamp(data.billingCycleStart, true)
  const end = timestamp(data.billingCycleEnd, true)
  const minutes = start === null || end === null || end <= start
    ? MONTHLY_MINUTES
    : Math.max(1, Math.round((end - start) / 60_000))
  const usage = record(data.individualUsage)
  const plan = record(usage?.plan)
  const onDemand = record(usage?.onDemand)
  const buckets: UsageBucket[] = []
  if (plan?.enabled !== false) {
    const models = cursorPoolWindow(plan, 'autoPercentUsed', 'Cursor Models', minutes, end, now)
    const other = cursorPoolWindow(plan, 'apiPercentUsed', 'Other Models', minutes, end, now)
    if (models) buckets.push(models)
    if (other) buckets.push(other)
  }
  if (onDemand?.enabled === true) {
    const rawPercent = finite(onDemand.totalPercentUsed)
    const used = finite(onDemand.used)
    const limit = finite(onDemand.limit)
    const percent = rawPercent ?? (used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : null)
    if (percent !== null) buckets.push(windowBucket('On-demand', percent, minutes, end, now))
  }
  const planTotal = plan?.enabled === false ? null : (() => {
    const used = finite(plan?.used)
    const limit = finite(plan?.limit)
    return used !== null && limit !== null && limit > 0 ? (used / limit) * 100 : finite(plan?.totalPercentUsed)
  })()
  const monthly = planTotal === null ? null : window(planTotal, minutes, end, now)
  const unlimited = data.isUnlimited === true
  const planType = typeof data.membershipType === 'string' && data.membershipType.trim() ? data.membershipType.trim() : null
  return snapshot('cursor', now, {
    session: null,
    weekly: null,
    ...(monthly ? { monthly } : {}),
    buckets,
    planType,
    status: monthly || buckets.length > 0 || unlimited ? 'ok' : 'unavailable',
    error: monthly || buckets.length > 0 || unlimited ? null : 'Cursor usage is unavailable',
    usageMetadata: { source: 'web', credentialSource: 'cursor' }
  })
}

function zcodeMinutes(limit: Record<string, unknown>): number | null {
  const unit = finite(limit.unit)
  const count = finite(limit.number)
  if (unit === null || count === null || !Number.isInteger(count) || count <= 0) return null
  if (limit.type === 'TIME_LIMIT' && unit === 5 && count === 1) return MONTHLY_MINUTES
  const unitMinutes: Record<number, number> = { 1: 1440, 3: 60, 5: 1, 6: WEEKLY_MINUTES }
  return unitMinutes[unit] ? count * unitMinutes[unit]! : null
}

function zcodeWindow(limit: Record<string, unknown>, now: number): UsageWindow | null {
  const total = finite(limit.usage)
  if (total === null || total <= 0) return null
  const current = finite(limit.currentValue)
  const remaining = finite(limit.remaining)
  const reported = finite(limit.percentage)
  const used = current ?? (remaining !== null ? total - remaining : null)
  const usedPercent = used !== null ? (used / total) * 100 : reported
  const minutes = zcodeMinutes(limit)
  if (usedPercent === null || minutes === null) return null
  const reset = timestamp(limit.nextResetTime)
  return window(usedPercent, minutes, minutes === SESSION_MINUTES && reset !== null && reset > now + 301 * 60_000 ? null : reset, now)
}

export function mapZcodeUsage(value: unknown, now = Date.now()): ProviderSnapshot {
  const root = record(value) ?? {}
  const data = record(root.data)
  const rawLimits = Array.isArray(data?.limits) ? data.limits : []
  const limits = rawLimits.map(record).filter((item): item is Record<string, unknown> => item !== null)
  const planLimits = limits.filter((item) => item.type === 'TOKENS_LIMIT' || item.type === 'CREDIT_LIMIT').map((item) => ({ item, window: zcodeWindow(item, now) })).filter((item): item is { item: Record<string, unknown>; window: UsageWindow } => item.window !== null).sort((left, right) => left.window.windowMinutes - right.window.windowMinutes)
  const session = planLimits.find((item) => item.window.windowMinutes === SESSION_MINUTES)?.window ?? null
  const weekly = planLimits.find((item) => item.window.windowMinutes === WEEKLY_MINUTES)?.window ?? null
  const monthly = limits.find((item) => item.type === 'TIME_LIMIT')
  const mappedMonthly = monthly ? zcodeWindow(monthly, now) : null
  const valid = root.success === true && (root.code === undefined || root.code === 0 || root.code === 200)
  const hasUsage = session !== null || weekly !== null || mappedMonthly !== null
  return snapshot('zcode', now, {
    session,
    weekly,
    ...(mappedMonthly ? { monthly: mappedMonthly } : {}),
    planType: typeof data?.level === 'string' ? data.level : null,
    status: valid && hasUsage ? 'ok' : valid ? 'error' : 'error',
    error: valid && hasUsage ? null : 'ZCode quota response contained no usable limits',
    usageMetadata: { source: 'web' }
  })
}
