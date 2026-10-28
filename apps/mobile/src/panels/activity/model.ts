export type Provider = 'claude' | 'codex'
export type UsageWindowView = { usedPercent: number; resetsAt: number | null; resetDescription: string | null }
export type AccountRowView = {
  id: string | null
  provider: Provider
  label: string
  email: string | null
  organization: string | null
  active: boolean
  isSystemDefault: boolean
  needsSignIn: boolean
  hasAuth?: boolean
  authKind?: 'oauth' | 'api-key' | 'none' | 'unknown'
  fiveHour: UsageWindowView | null
  sevenDay: UsageWindowView | null
}
export type AccountPanelSnapshot = {
  rows: AccountRowView[]
  active: Record<Provider, string | null>
  revision: number | null
}

type RecordValue = Record<string, unknown>
type RpcCall = (method: string, params?: Record<string, unknown>) => Promise<unknown>

const isRecord = (value: unknown): value is RecordValue =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
export { isRecord as isActivityRecord }
const isProvider = (value: unknown): value is Provider => value === 'claude' || value === 'codex'
const nullableString = (value: unknown): string | null => typeof value === 'string' ? value : null
const finiteNumber = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) ? value : null

export function mergeUsageStates(values: readonly unknown[]): unknown {
  const providers: unknown[] = []
  const providerKeys = new Set<string>()
  const inactive: RecordValue = {}
  let updatedAt = 0
  let found = false
  for (const value of values) {
    if (!isRecord(value)) continue
    found = true
    if (Array.isArray(value.providers)) {
      for (const candidate of value.providers) {
        if (!isRecord(candidate) || !isProvider(candidate.provider) || !(candidate.accountId === null || typeof candidate.accountId === 'string')) continue
        const key = `${candidate.provider}:${candidate.accountId ?? 'system'}`
        if (!providerKeys.has(key)) {
          providerKeys.add(key)
          providers.push(candidate)
        }
      }
    }
    if (isRecord(value.inactive)) Object.assign(inactive, value.inactive)
    updatedAt = Math.max(updatedAt, finiteNumber(value.updatedAt) ?? 0)
  }
  return found ? { providers, inactive, updatedAt } : null
}

export type MobileNotificationPreferences = {
  enabled: boolean
  onlyWhenDesktopAway: boolean
  suppressFocusedWorkspace: boolean
  soundWhileOpen: boolean
}

export const DEFAULT_NOTIFICATION_PREFERENCES: MobileNotificationPreferences = {
  enabled: false,
  onlyWhenDesktopAway: true,
  suppressFocusedWorkspace: true,
  soundWhileOpen: false
}

export function parseMobileNotificationPreferences(value: string | null): MobileNotificationPreferences {
  if (value === null) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  }
  if (!isRecord(decoded)) return { ...DEFAULT_NOTIFICATION_PREFERENCES }
  return {
    enabled: typeof decoded.enabled === 'boolean' ? decoded.enabled : DEFAULT_NOTIFICATION_PREFERENCES.enabled,
    onlyWhenDesktopAway: typeof decoded.onlyWhenDesktopAway === 'boolean' ? decoded.onlyWhenDesktopAway : DEFAULT_NOTIFICATION_PREFERENCES.onlyWhenDesktopAway,
    suppressFocusedWorkspace: typeof decoded.suppressFocusedWorkspace === 'boolean' ? decoded.suppressFocusedWorkspace : DEFAULT_NOTIFICATION_PREFERENCES.suppressFocusedWorkspace,
    soundWhileOpen: typeof decoded.soundWhileOpen === 'boolean' ? decoded.soundWhileOpen : DEFAULT_NOTIFICATION_PREFERENCES.soundWhileOpen
  }
}

function usageWindow(value: unknown): UsageWindowView | null {
  if (!isRecord(value)) return null
  const usedPercent = finiteNumber(value.usedPercent)
  if (usedPercent === null) return null
  return {
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    resetsAt: finiteNumber(value.resetsAt),
    resetDescription: nullableString(value.resetDescription)
  }
}

function matchingUsage(usage: unknown, provider: Provider, accountId: string | null): { fiveHour: UsageWindowView | null; sevenDay: UsageWindowView | null } {
  if (!isRecord(usage)) return { fiveHour: null, sevenDay: null }
  const providers = Array.isArray(usage.providers) ? usage.providers : []
  const active = providers.find((candidate) => isRecord(candidate) && candidate.provider === provider && candidate.accountId === accountId)
  let snapshot = active
  if (!snapshot && accountId !== null && isRecord(usage.inactive)) {
    const candidate = usage.inactive[`${provider}:${accountId}`]
    if (isRecord(candidate) && candidate.provider === provider && candidate.accountId === accountId) snapshot = candidate
  }
  if (!isRecord(snapshot)) return { fiveHour: null, sevenDay: null }
  return { fiveHour: usageWindow(snapshot.session), sevenDay: usageWindow(snapshot.weekly) }
}

/** Project only public account labels and the two safe usage windows rendered by the phone panel. */
export function projectAccountState(accountValue: unknown, usageValue: unknown): AccountPanelSnapshot | null {
  if (!isRecord(accountValue) || !Array.isArray(accountValue.accounts) || !isRecord(accountValue.active) || !isRecord(accountValue.systemDefault)) return null
  const active: Record<Provider, string | null> = { claude: '', codex: '' }
  for (const provider of ['claude', 'codex'] as const) {
    const selected = accountValue.active[provider]
    if (selected !== null && typeof selected !== 'string') return null
    const system = accountValue.systemDefault[provider]
    if (!isRecord(system) || typeof system.hasAuth !== 'boolean' || !['oauth', 'api-key', 'none', 'unknown'].includes(String(system.authKind))) return null
    active[provider] = selected
  }

  const rows: AccountRowView[] = []
  for (const provider of ['claude', 'codex'] as const) {
    const system = accountValue.systemDefault[provider] as RecordValue
    const systemUsage = matchingUsage(usageValue, provider, null)
    rows.push({
      id: null,
      provider,
      label: 'System default',
      email: nullableString(system.email),
      organization: null,
      active: active[provider] === null,
      isSystemDefault: true,
      needsSignIn: false,
      hasAuth: typeof system.hasAuth === 'boolean' ? system.hasAuth : undefined,
      authKind: system.authKind as AccountRowView['authKind'],
      ...systemUsage
    })
    for (const candidate of accountValue.accounts) {
      if (!isRecord(candidate) || candidate.provider !== provider || typeof candidate.id !== 'string' || typeof candidate.label !== 'string') continue
      const accountUsage = matchingUsage(usageValue, provider, candidate.id)
      rows.push({
        id: candidate.id,
        provider,
        label: candidate.label,
        email: nullableString(candidate.email),
        organization: nullableString(candidate.organization),
        active: active[provider] === candidate.id,
        isSystemDefault: false,
        needsSignIn: candidate.needsSignIn === true,
        ...accountUsage
      })
    }
  }
  return { rows, active, revision: finiteNumber(accountValue.revision) }
}

export async function selectProviderAccount(
  call: RpcCall,
  current: AccountPanelSnapshot,
  provider: Provider,
  accountId: string | null
): Promise<{ snapshot: AccountPanelSnapshot; error: string | null }> {
  try {
    const result = await call('quirky.accounts/select', { provider, accountId })
    const snapshot = projectAccountState(result, null)
    if (!snapshot) throw new Error('The host returned an invalid account selection.')
    return { snapshot, error: null }
  } catch (error) {
    return { snapshot: current, error: errorMessage(error) }
  }
}

export type MobileNotification = {
  id: string
  seq: number
  at: number
  title: string
  body: string
  worktreeId?: string
  sessionId?: string
  desktopAway: boolean | null
}
export type NotificationBatch = {
  epoch: string
  cursor: number
  notifications: MobileNotification[]
  reset: boolean
  truncated: boolean
  presenceAvailable: boolean
}
export type NotificationFeedState = {
  epoch: string | null
  cursor: number
  seenIds: string[]
  notifications: MobileNotification[]
  arrivals: MobileNotification[]
  reset: boolean
  truncated: boolean
  presenceAvailable: boolean
}

export function createNotificationFeedState(): NotificationFeedState {
  return { epoch: null, cursor: 0, seenIds: [], notifications: [], arrivals: [], reset: false, truncated: false, presenceAvailable: true }
}

export function parseNotificationBatch(value: unknown): NotificationBatch | null {
  if (!isRecord(value) || typeof value.epoch !== 'string' || !Number.isSafeInteger(value.cursor) || (value.cursor as number) < 0 ||
      !Array.isArray(value.notifications) || typeof value.reset !== 'boolean' || typeof value.truncated !== 'boolean' || typeof value.presenceAvailable !== 'boolean') return null
  const notifications: MobileNotification[] = []
  for (const item of value.notifications) {
    if (!isRecord(item) || typeof item.id !== 'string' || !Number.isSafeInteger(item.seq) || typeof item.at !== 'number' || !Number.isFinite(item.at) ||
        typeof item.title !== 'string' || typeof item.body !== 'string' ||
        !(item.desktopAway === null || typeof item.desktopAway === 'boolean') ||
        (item.worktreeId !== undefined && typeof item.worktreeId !== 'string') ||
        (item.sessionId !== undefined && typeof item.sessionId !== 'string')) return null
    notifications.push({
      id: item.id,
      seq: item.seq as number,
      at: item.at,
      title: item.title,
      body: item.body,
      ...(typeof item.worktreeId === 'string' ? { worktreeId: item.worktreeId } : {}),
      ...(typeof item.sessionId === 'string' ? { sessionId: item.sessionId } : {}),
      desktopAway: item.desktopAway as boolean | null
    })
  }
  return {
    epoch: value.epoch,
    cursor: value.cursor as number,
    notifications,
    reset: value.reset,
    truncated: value.truncated,
    presenceAvailable: value.presenceAvailable
  }
}

export function applyNotificationBatch(
  current: NotificationFeedState,
  batch: NotificationBatch
): NotificationFeedState {
  const seen = new Set(current.seenIds)
  const arrivals: MobileNotification[] = []
  for (const notification of batch.notifications) {
    const identity = `${batch.epoch}\u0000${notification.id}`
    if (seen.has(identity)) continue
    seen.add(identity)
    arrivals.push(notification)
  }
  const epochChanged = current.epoch !== null && current.epoch !== batch.epoch
  const seenIds = [...current.seenIds, ...arrivals.map((notification) => `${batch.epoch}\u0000${notification.id}`)].slice(-256)
  return {
    epoch: batch.epoch,
    cursor: batch.cursor,
    seenIds,
    notifications: [...arrivals, ...current.notifications].slice(0, 100),
    arrivals,
    reset: batch.reset || epochChanged,
    truncated: batch.truncated,
    presenceAvailable: batch.presenceAvailable
  }
}

export function notificationCheckpoint(state: NotificationFeedState): string {
  return JSON.stringify({
    version: 1,
    epoch: state.epoch,
    cursor: state.cursor,
    seenIds: state.seenIds,
    notifications: state.notifications.slice(0, 100),
    reset: state.reset,
    truncated: state.truncated,
    presenceAvailable: state.presenceAvailable
  })
}

export function parseNotificationCheckpoint(value: string | null): NotificationFeedState | null {
  if (value === null) return null
  let decoded: unknown
  try {
    decoded = JSON.parse(value)
  } catch {
    return null
  }
  if (!isRecord(decoded) || decoded.version !== 1 || !(decoded.epoch === null || typeof decoded.epoch === 'string') ||
      !Number.isSafeInteger(decoded.cursor) || (decoded.cursor as number) < 0 || !Array.isArray(decoded.seenIds) ||
      !decoded.seenIds.every((id) => typeof id === 'string') || !Array.isArray(decoded.notifications)) return null
  const notifications: MobileNotification[] = []
  for (const item of decoded.notifications) {
    const projected = parseNotificationBatch({
      epoch: decoded.epoch ?? 'stored', cursor: decoded.cursor, notifications: [item], reset: false, truncated: false, presenceAvailable: true
    })?.notifications[0]
    if (projected) notifications.push(projected)
  }
  return {
    epoch: decoded.epoch,
    cursor: decoded.cursor as number,
    seenIds: decoded.seenIds.slice(-256) as string[],
    notifications: notifications.slice(0, 100),
    arrivals: [],
    reset: decoded.reset === true,
    truncated: decoded.truncated === true,
    presenceAvailable: decoded.presenceAvailable !== false
  }
}

export type ResumedSession = { id: string; worktreeId: string; status?: string; title?: string }
export async function resumeVaultSource(
  call: RpcCall,
  navigate: (route: { kind: 'session'; worktreeId: string; sessionId?: string }) => Promise<void>,
  id: string
): Promise<ResumedSession> {
  const value = await call('quirky.vault/resume', { id })
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.worktreeId !== 'string') {
    throw new Error('The host did not return the resumed session and its workspace.')
  }
  const session: ResumedSession = {
    id: value.id,
    worktreeId: value.worktreeId,
    ...(typeof value.status === 'string' ? { status: value.status } : {}),
    ...(typeof value.title === 'string' ? { title: value.title } : {})
  }
  try {
    await navigate({ kind: 'session', worktreeId: session.worktreeId, sessionId: session.id })
  } catch (error) {
    throw new Error(`Session ${session.id} started, but this device could not open it: ${errorMessage(error)}`)
  }
  return session
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
