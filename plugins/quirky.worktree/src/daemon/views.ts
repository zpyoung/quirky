import type { CallerConnection, PluginStore } from '@quirky/protocol'
import {
  ACTIVITY_WINDOWS,
  DEFAULT_VIEWS_STATE,
  GROUP_BYS,
  ROW_FACTS,
  SORT_BYS,
  WORKTREE_STATUSES,
  type ActivityPreferences,
  type ActivityWindow,
  type SavedView,
  type ViewDisplay,
  type ViewFilter,
  type ViewId,
  type ViewsState
} from '../view-types'

const VIEWS_KEY = 'worktree-views'
const LAST_VIEW_KEY = 'worktree-last-view'
const MAX_NAME_LENGTH = 60
const BUILT_IN_IDS: readonly string[] = ['all', 'needs-you']

type ViewsEnv = {
  store: PluginStore
  fail(kind: 'invalid-params', message: string): Error
}

/** Thrown by the normaliser for the first field that is not valid. */
class ViewsInvalid extends Error {}

function recordOf(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new ViewsInvalid(`${path} must be an object`)
  return value as Record<string, unknown>
}

function booleanOf(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new ViewsInvalid(`${path} must be a boolean`)
  return value
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (!allowed.includes(value as T)) throw new ViewsInvalid(`${path} must be one of ${allowed.join(', ')}`)
  return value as T
}

function stringsOf(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && item !== '')) {
    throw new ViewsInvalid(`${path} must be an array of non-empty strings`)
  }
  return [...new Set(value as string[])]
}

function activityOf(value: unknown, path: string): ActivityPreferences {
  const record = recordOf(value, path)
  const days = record.workspaceActivityCustomDays
  if (typeof days !== 'number' || !Number.isSafeInteger(days) || days < 1) {
    throw new ViewsInvalid(`${path}.workspaceActivityCustomDays must be a positive integer`)
  }
  const beforeLiveOnly = oneOf<ActivityWindow>(record.workspaceActivityWindowBeforeLiveOnly, ACTIVITY_WINDOWS, `${path}.workspaceActivityWindowBeforeLiveOnly`)
  if (beforeLiveOnly === 'live-only') throw new ViewsInvalid(`${path}.workspaceActivityWindowBeforeLiveOnly must not be live-only`)
  return {
    workspaceActivityWindow: oneOf(record.workspaceActivityWindow, ACTIVITY_WINDOWS, `${path}.workspaceActivityWindow`),
    workspaceActivityCustomDays: days,
    alwaysShowDefaultBranchWorkspace: booleanOf(record.alwaysShowDefaultBranchWorkspace, `${path}.alwaysShowDefaultBranchWorkspace`),
    workspaceActivityWindowBeforeLiveOnly: beforeLiveOnly,
    hideCompletedReviewWorkspaces: booleanOf(record.hideCompletedReviewWorkspaces, `${path}.hideCompletedReviewWorkspaces`),
    hidePassingCheckWorkspaces: booleanOf(record.hidePassingCheckWorkspaces, `${path}.hidePassingCheckWorkspaces`),
    hideAutomationCreated: booleanOf(record.hideAutomationCreated, `${path}.hideAutomationCreated`)
  }
}

function filterOf(value: unknown, path: string): ViewFilter {
  const record = recordOf(value, path)
  if (!Array.isArray(record.statuses)) throw new ViewsInvalid(`${path}.statuses must be an array`)
  return {
    tagIds: stringsOf(record.tagIds, `${path}.tagIds`),
    sectionIds: stringsOf(record.sectionIds, `${path}.sectionIds`),
    repoIds: stringsOf(record.repoIds, `${path}.repoIds`),
    statuses: [...new Set(record.statuses.map((status) => oneOf(status, WORKTREE_STATUSES, `${path}.statuses`)))],
    hideCliCreated: booleanOf(record.hideCliCreated, `${path}.hideCliCreated`),
    hideOtherDesktopClients: booleanOf(record.hideOtherDesktopClients, `${path}.hideOtherDesktopClients`),
    hideDefaultBranch: booleanOf(record.hideDefaultBranch, `${path}.hideDefaultBranch`),
    hideDetachedHead: booleanOf(record.hideDetachedHead, `${path}.hideDetachedHead`),
    hideArchived: booleanOf(record.hideArchived, `${path}.hideArchived`),
    activity: activityOf(record.activity, `${path}.activity`)
  }
}

function displayOf(value: unknown, path: string): ViewDisplay {
  const record = recordOf(value, path)
  return {
    groupBy: oneOf(record.groupBy, GROUP_BYS, `${path}.groupBy`),
    sortBy: oneOf(record.sortBy, SORT_BYS, `${path}.sortBy`),
    projectOrder: oneOf(record.projectOrder, ['manual', 'recent'] as const, `${path}.projectOrder`),
    showAsleep: booleanOf(record.showAsleep, `${path}.showAsleep`),
    showNested: booleanOf(record.showNested, `${path}.showNested`)
  }
}

function savedViewOf(value: unknown, path: string): SavedView {
  const record = recordOf(value, path)
  if (typeof record.id !== 'string' || record.id === '' || BUILT_IN_IDS.includes(record.id)) {
    throw new ViewsInvalid(`${path}.id must be a non-empty string other than ${BUILT_IN_IDS.join(' or ')}`)
  }
  if (typeof record.name !== 'string') throw new ViewsInvalid(`${path}.name must be a string`)
  const name = record.name.trim()
  if (name.length < 1 || name.length > MAX_NAME_LENGTH) throw new ViewsInvalid(`${path}.name must be 1 to ${MAX_NAME_LENGTH} characters`)
  const spec = recordOf(record.spec, `${path}.spec`)
  return {
    id: record.id,
    name,
    starred: booleanOf(record.starred, `${path}.starred`),
    spec: { filter: filterOf(spec.filter, `${path}.spec.filter`), display: displayOf(spec.display, `${path}.spec.display`) }
  }
}

function normalize(value: unknown): ViewsState {
  const record = recordOf(value, 'state')
  if (!Array.isArray(record.views)) throw new ViewsInvalid('state.views must be an array')
  const views = record.views.map((view, index) => savedViewOf(view, `state.views[${index}]`))
  const duplicate = views.find((view, index) => views.findIndex((other) => other.id === view.id) !== index)
  if (duplicate) throw new ViewsInvalid(`view ID ${duplicate.id} is used twice`)
  return {
    views,
    needsYouHidden: booleanOf(record.needsYouHidden, 'state.needsYouHidden'),
    rowFact: oneOf(record.rowFact, ROW_FACTS, 'state.rowFact')
  }
}

function put(store: PluginStore, key: string, value: unknown): void {
  store.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value))
}

function stored(store: PluginStore, key: string): unknown {
  const row = store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)
  if (!row) return undefined
  try {
    return JSON.parse(row.value) as unknown
  } catch {
    return undefined
  }
}

const defaults = (): ViewsState => ({ ...DEFAULT_VIEWS_STATE, views: [] })

/** The saved views; a missing or unreadable record reads as the default state. */
export function readViews(store: PluginStore): ViewsState {
  const value = stored(store, VIEWS_KEY)
  if (value === undefined) return defaults()
  try {
    return normalize(value)
  } catch {
    return defaults()
  }
}

/** Replaces the saved views with the normalised `state`, or refuses it naming the first invalid field. */
export function setViews(env: ViewsEnv, state: unknown): ViewsState {
  let next: ViewsState
  try {
    next = normalize(state)
  } catch (error) {
    if (error instanceof ViewsInvalid) throw env.fail('invalid-params', error.message)
    throw error
  }
  put(env.store, VIEWS_KEY, next)
  return next
}

function exists(state: ViewsState, viewId: ViewId): boolean {
  if (viewId === 'all') return true
  if (viewId === 'needs-you') return !state.needsYouHidden
  return state.views.some((view) => view.id === viewId)
}

function windowOf(env: ViewsEnv, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw env.fail('invalid-params', 'window must be a positive integer')
  return value
}

/**
 * Which view each window shows. A window's view lives only as long as its connection, because
 * connection IDs are reused after a reload; the last choice is stored and only seeds the view of a
 * window that has none yet, so one window switching never moves another.
 */
export class ActiveViews {
  private readonly byWindow = new Map<number, ViewId>()
  private readonly releases = new Map<number, () => void>()

  constructor(private readonly env: ViewsEnv) {}

  /** The window's view, or All when that view no longer exists. A window's first answer sticks to it. */
  get(windowParam: unknown, connection?: CallerConnection): ViewId {
    const window = windowOf(this.env, windowParam)
    const state = readViews(this.env.store)
    let viewId = this.byWindow.get(window)
    if (viewId === undefined) {
      const last = stored(this.env.store, LAST_VIEW_KEY)
      viewId = typeof last === 'string' && exists(state, last) ? last : 'all'
      this.remember(window, viewId, connection)
    }
    return exists(state, viewId) ? viewId : 'all'
  }

  set(windowParam: unknown, viewId: unknown, connection?: CallerConnection): void {
    const window = windowOf(this.env, windowParam)
    if (typeof viewId !== 'string' || !exists(readViews(this.env.store), viewId)) {
      throw this.env.fail('invalid-params', 'viewId must be all, needs-you (unless hidden) or the ID of a saved view')
    }
    put(this.env.store, LAST_VIEW_KEY, viewId)
    this.remember(window, viewId, connection)
  }

  private remember(window: number, viewId: ViewId, connection?: CallerConnection): void {
    this.byWindow.set(window, viewId)
    if (!connection) return
    this.releases.get(window)?.()
    this.releases.set(window, connection.onClose(() => {
      this.byWindow.delete(window)
      this.releases.delete(window)
    }))
  }

  dispose(): void {
    for (const release of this.releases.values()) release()
    this.releases.clear()
    this.byWindow.clear()
  }
}
