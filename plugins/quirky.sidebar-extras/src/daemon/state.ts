import type { PluginContext, PluginStore } from '@quirky/protocol'

export const ACTIVITY_WINDOWS = ['all', 'live-only', 'today', 'week', 'month', 'custom'] as const
export type ActivityWindow = (typeof ACTIVITY_WINDOWS)[number]
export type NonLiveActivityWindow = Exclude<ActivityWindow, 'live-only'>

export type Preferences = {
  workspaceActivityWindow: ActivityWindow
  workspaceActivityCustomDays: number
  alwaysShowDefaultBranchWorkspace: boolean
  workspaceActivityWindowBeforeLiveOnly: NonLiveActivityWindow
}

export type ActiveWorkspace = { worktreeId: string; instanceId: string }

export type ExtrasState = {
  client: string
  preferences: Preferences
  active: ActiveWorkspace | null
  visits: Record<string, number>
  exits: Record<string, number>
}

export type SetPatch = {
  workspaceActivityWindow?: ActivityWindow
  workspaceActivityCustomDays?: number
  alwaysShowDefaultBranchWorkspace?: boolean
  hideSleepingWorkspaces?: boolean
  showSleepingWorkspaces?: boolean
}

export const DEFAULT_PREFERENCES: Preferences = {
  workspaceActivityWindow: 'all',
  workspaceActivityCustomDays: 30,
  alwaysShowDefaultBranchWorkspace: true,
  workspaceActivityWindowBeforeLiveOnly: 'all'
}

const nonLiveWindows: readonly NonLiveActivityWindow[] = ['all', 'today', 'week', 'month', 'custom']
const READ_KEYS: Readonly<Partial<Record<string, true>>> = { client: true }
const SET_KEYS: Readonly<Partial<Record<string, true>>> = {
  client: true,
  workspaceActivityWindow: true,
  workspaceActivityCustomDays: true,
  alwaysShowDefaultBranchWorkspace: true,
  hideSleepingWorkspaces: true,
  showSleepingWorkspaces: true
}
const ACTIVATE_KEYS: Readonly<Partial<Record<string, true>>> = { client: true, worktree: true }
const DIRTY_KEYS: Readonly<Partial<Record<string, true>>> = { worktree: true }

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isActivityWindow(value: unknown): value is ActivityWindow {
  return typeof value === 'string' && (ACTIVITY_WINDOWS as readonly string[]).includes(value)
}

function isNonLiveWindow(value: unknown): value is NonLiveActivityWindow {
  return typeof value === 'string' && nonLiveWindows.includes(value as NonLiveActivityWindow)
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function invalid(context: PluginContext, message: string): never {
  throw context.error('invalid-params', message)
}

function checkKeys(
  params: Record<string, unknown>,
  allowed: Readonly<Partial<Record<string, true>>>,
  context: PluginContext
): void {
  const extra = Object.keys(params).find((key) => allowed[key] !== true)
  if (extra !== undefined) invalid(context, `unknown parameter "${extra}"`)
}

export function clientFrom(params: Record<string, unknown>, context: PluginContext): string {
  const client = params.client
  if (client === undefined) return 'desktop'
  if (typeof client !== 'string' || client.length === 0) invalid(context, 'client must be a non-empty string')
  return client
}

export function validateReadParams(params: Record<string, unknown>, context: PluginContext): string {
  checkKeys(params, READ_KEYS, context)
  return clientFrom(params, context)
}

export function validateSetParams(
  params: Record<string, unknown>,
  context: PluginContext
): { client: string; patch: SetPatch } {
  checkKeys(params, SET_KEYS, context)
  const client = clientFrom(params, context)
  const patch: SetPatch = {}

  if (params.workspaceActivityWindow !== undefined) {
    if (!isActivityWindow(params.workspaceActivityWindow)) {
      invalid(context, `workspaceActivityWindow must be one of ${ACTIVITY_WINDOWS.join(', ')}`)
    }
    patch.workspaceActivityWindow = params.workspaceActivityWindow
  }
  if (params.workspaceActivityCustomDays !== undefined) {
    if (!isPositiveSafeInteger(params.workspaceActivityCustomDays)) {
      invalid(context, 'workspaceActivityCustomDays must be a positive safe integer')
    }
    patch.workspaceActivityCustomDays = params.workspaceActivityCustomDays
  }
  if (params.alwaysShowDefaultBranchWorkspace !== undefined) {
    if (typeof params.alwaysShowDefaultBranchWorkspace !== 'boolean') {
      invalid(context, 'alwaysShowDefaultBranchWorkspace must be a boolean')
    }
    patch.alwaysShowDefaultBranchWorkspace = params.alwaysShowDefaultBranchWorkspace
  }
  if (params.hideSleepingWorkspaces !== undefined) {
    if (typeof params.hideSleepingWorkspaces !== 'boolean') invalid(context, 'hideSleepingWorkspaces must be a boolean')
    patch.hideSleepingWorkspaces = params.hideSleepingWorkspaces
  }
  if (params.showSleepingWorkspaces !== undefined) {
    if (typeof params.showSleepingWorkspaces !== 'boolean') invalid(context, 'showSleepingWorkspaces must be a boolean')
    patch.showSleepingWorkspaces = params.showSleepingWorkspaces
  }
  return { client, patch }
}

export function validateWorktreeParams(
  params: Record<string, unknown>,
  context: PluginContext
): { client: string; worktree: string | null } {
  checkKeys(params, ACTIVATE_KEYS, context)
  const client = clientFrom(params, context)
  if (params.worktree === null) return { client, worktree: null }
  if (typeof params.worktree !== 'string' || params.worktree.length === 0) {
    invalid(context, 'worktree must be a non-empty selector or null')
  }
  return { client, worktree: params.worktree }
}

export function validateDirtyParams(params: Record<string, unknown>, context: PluginContext): { worktree?: string | null } {
  checkKeys(params, DIRTY_KEYS, context)
  if (params.worktree === undefined) return {}
  if (params.worktree === null) return { worktree: null }
  if (typeof params.worktree !== 'string' || params.worktree.length === 0) {
    invalid(context, 'worktree must be a non-empty selector or null')
  }
  return { worktree: params.worktree }
}

function hydratePreferences(serialized: string | null): Preferences {
  if (serialized === null) return { ...DEFAULT_PREFERENCES }
  let value: unknown
  try {
    value = JSON.parse(serialized)
  } catch {
    return { ...DEFAULT_PREFERENCES }
  }
  if (!isPlainRecord(value)) return { ...DEFAULT_PREFERENCES }
  return {
    workspaceActivityWindow: isActivityWindow(value.workspaceActivityWindow)
      ? value.workspaceActivityWindow
      : DEFAULT_PREFERENCES.workspaceActivityWindow,
    workspaceActivityCustomDays: isPositiveSafeInteger(value.workspaceActivityCustomDays)
      ? value.workspaceActivityCustomDays
      : DEFAULT_PREFERENCES.workspaceActivityCustomDays,
    alwaysShowDefaultBranchWorkspace: typeof value.alwaysShowDefaultBranchWorkspace === 'boolean'
      ? value.alwaysShowDefaultBranchWorkspace
      : DEFAULT_PREFERENCES.alwaysShowDefaultBranchWorkspace,
    workspaceActivityWindowBeforeLiveOnly: isNonLiveWindow(value.workspaceActivityWindowBeforeLiveOnly)
      ? value.workspaceActivityWindowBeforeLiveOnly
      : DEFAULT_PREFERENCES.workspaceActivityWindowBeforeLiveOnly
  }
}

function mergePreferences(current: Preferences, patch: SetPatch): Preferences {
  const next: Preferences = { ...current }
  const explicitWindow = patch.workspaceActivityWindow

  if (explicitWindow !== undefined) {
    next.workspaceActivityWindow = explicitWindow
    next.workspaceActivityWindowBeforeLiveOnly = explicitWindow === 'live-only'
      ? current.workspaceActivityWindow === 'live-only'
        ? current.workspaceActivityWindowBeforeLiveOnly
        : current.workspaceActivityWindow
      : explicitWindow
  }

  if (patch.workspaceActivityCustomDays !== undefined) {
    next.workspaceActivityCustomDays = patch.workspaceActivityCustomDays
  }
  if (patch.alwaysShowDefaultBranchWorkspace !== undefined) {
    next.alwaysShowDefaultBranchWorkspace = patch.alwaysShowDefaultBranchWorkspace
  }

  if (explicitWindow === undefined) {
    if (patch.hideSleepingWorkspaces === true) {
      if (current.workspaceActivityWindow !== 'live-only') {
        next.workspaceActivityWindowBeforeLiveOnly = current.workspaceActivityWindow
      }
      next.workspaceActivityWindow = 'live-only'
    } else if (
      current.workspaceActivityWindow === 'live-only' &&
      (patch.hideSleepingWorkspaces === false || patch.showSleepingWorkspaces === true)
    ) {
      next.workspaceActivityWindow = current.workspaceActivityWindowBeforeLiveOnly
    }
  }

  return next
}

function samePreferences(left: Preferences, right: Preferences): boolean {
  return left.workspaceActivityWindow === right.workspaceActivityWindow &&
    left.workspaceActivityCustomDays === right.workspaceActivityCustomDays &&
    left.alwaysShowDefaultBranchWorkspace === right.alwaysShowDefaultBranchWorkspace &&
    left.workspaceActivityWindowBeforeLiveOnly === right.workspaceActivityWindowBeforeLiveOnly
}

function identityKey(active: ActiveWorkspace): string {
  return `${active.worktreeId}@${active.instanceId}`
}

function timestamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

export function stateMigrations(): ((store: PluginStore) => void)[] {
  return [
    (store) => {
      store.exec(`
        CREATE TABLE preferences (
          client TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE visits (
          client TEXT NOT NULL,
          identity TEXT NOT NULL,
          visited_at INTEGER NOT NULL,
          PRIMARY KEY (client, identity)
        );
      `)
    }
  ]
}

export class ExtrasStateStore {
  private readonly active = new Map<string, ActiveWorkspace | null>()
  private readonly exits = new Map<string, Record<string, number>>()

  constructor(private readonly store: PluginStore, private readonly now: () => number) {}

  read(client: string): ExtrasState {
    const row = this.store.get<{ value: string }>('SELECT value FROM preferences WHERE client = ?', client)
    const visits: Record<string, number> = {}
    for (const visit of this.store.all<{ identity: string; visited_at: number }>(
      'SELECT identity, visited_at FROM visits WHERE client = ?',
      client
    )) {
      const at = timestamp(visit.visited_at)
      if (typeof visit.identity === 'string' && at !== null) visits[visit.identity] = at
    }
    return {
      client,
      preferences: hydratePreferences(row?.value ?? null),
      active: this.copyActive(this.active.get(client) ?? null),
      visits,
      exits: { ...(this.exits.get(client) ?? {}) }
    }
  }

  set(client: string, patch: SetPatch): { state: ExtrasState; changed: boolean } {
    const current = this.read(client)
    const preferences = mergePreferences(current.preferences, patch)
    if (samePreferences(current.preferences, preferences)) return { state: current, changed: false }
    this.store.run(
      'INSERT INTO preferences (client, value) VALUES (?, ?) ON CONFLICT(client) DO UPDATE SET value = excluded.value',
      client,
      JSON.stringify(preferences)
    )
    return { state: this.read(client), changed: true }
  }

  activate(client: string, next: ActiveWorkspace | null): { state: ExtrasState; changed: boolean } {
    const previous = this.active.get(client) ?? null
    if (this.sameActive(previous, next)) return { state: this.read(client), changed: false }

    const at = this.now()
    if (!Number.isSafeInteger(at) || at < 0) throw new Error('clock must return a non-negative safe integer')
    const nextExits = { ...(this.exits.get(client) ?? {}) }
    if (previous !== null) {
      const key = identityKey(previous)
      nextExits[key] = Math.max(nextExits[key] ?? 0, at)
    }

    if (next !== null) {
      const key = identityKey(next)
      this.store.transaction(() => {
        this.store.run(
          'INSERT INTO visits (client, identity, visited_at) VALUES (?, ?, ?) ON CONFLICT(client, identity) DO UPDATE SET visited_at = MAX(visited_at, excluded.visited_at)',
          client,
          key,
          at
        )
      })
    }
    this.active.set(client, this.copyActive(next))
    this.exits.set(client, nextExits)
    return { state: this.read(client), changed: true }
  }

  private sameActive(left: ActiveWorkspace | null, right: ActiveWorkspace | null): boolean {
    return left === null
      ? right === null
      : right !== null && left.worktreeId === right.worktreeId && left.instanceId === right.instanceId
  }

  private copyActive(active: ActiveWorkspace | null): ActiveWorkspace | null {
    return active === null ? null : { worktreeId: active.worktreeId, instanceId: active.instanceId }
  }
}

/** Serializes mutations for one client while allowing independent clients to proceed concurrently. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>()

  run<T>(key: string, operation: () => T | Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const result = previous.then(operation)
    const tail = result.then(() => undefined, () => undefined)
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return result
  }
}

