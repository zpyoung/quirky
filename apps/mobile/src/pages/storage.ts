import type { ProjectGroup, Repo, Session, Worktree, WorktreeStatus } from '@quirky/protocol'
import type { MobilePageBridge } from '../contracts'

export type WorkspaceGroupBy = 'none' | 'status' | 'pr' | 'project'
export type WorkspaceSortBy = 'name' | 'agentActivity' | 'recent' | 'project' | 'manual'
export type WorkspaceCardLayout = 'detailed' | 'compact'
export type WorkspaceFilterKey = 'exceptDefaultBranch' | 'hideDefaultBranch' | 'hideAutomationCreated' | 'hideCliCreated' | 'hideOtherClient' | 'hideDetachedHead'
export type WorkspacePropertyKey = 'status' | 'branch' | 'project' | 'kind' | 'path' | 'head' | 'baseRef' | 'projectGroup' | 'branchRetention' | 'pushTarget' | 'pullRequest' | 'issue' | 'comment' | 'creator' | 'activity' | 'tabCount'

export type WorkspacePreferences = {
  groupBy: WorkspaceGroupBy
  sortBy: WorkspaceSortBy
  projectOrder: 'manual' | 'recent'
  cardLayout: WorkspaceCardLayout
  properties: WorkspacePropertyKey[]
  filters: Record<WorkspaceFilterKey, boolean>
  pinnedWorktreeIds: string[]
  collapsedGroups: string[]
  collapsedWorktrees: string[]
  sidebarCollapsed: boolean
  sidebarWidth: number
}

export type WorkspaceSessionSummary = Pick<Session, 'id' | 'worktreeId' | 'kind' | 'agent' | 'status' | 'title' | 'createdAt' | 'lastActivityAt'>

export type WorkspaceCache = { repos: Repo[]; groups: ProjectGroup[]; worktrees: Worktree[]; sessions: WorkspaceSessionSummary[] }

export const DEFAULT_WORKSPACE_PREFERENCES: WorkspacePreferences = {
  groupBy: 'project',
  sortBy: 'recent',
  projectOrder: 'manual',
  cardLayout: 'detailed',
  properties: ['status', 'branch', 'project', 'pullRequest', 'issue', 'comment', 'creator', 'activity', 'tabCount'],
  filters: {
    exceptDefaultBranch: false,
    hideDefaultBranch: false,
    hideAutomationCreated: false,
    hideCliCreated: false,
    hideOtherClient: false,
    hideDetachedHead: false
  },
  pinnedWorktreeIds: [],
  collapsedGroups: [],
  collapsedWorktrees: [],
  sidebarCollapsed: false,
  sidebarWidth: 292
}

const PREFS_PREFIX = 'quirky.mobile.workspaces.v1:'
const CACHE_PREFIX = 'quirky.mobile.workspaces.cache.v1:'
const GROUP_BY: WorkspaceGroupBy[] = ['none', 'status', 'pr', 'project']
const SORT_BY: WorkspaceSortBy[] = ['name', 'agentActivity', 'recent', 'project', 'manual']
const CARD_LAYOUT: WorkspaceCardLayout[] = ['detailed', 'compact']
const FILTER_KEYS: WorkspaceFilterKey[] = ['exceptDefaultBranch', 'hideDefaultBranch', 'hideAutomationCreated', 'hideCliCreated', 'hideOtherClient', 'hideDetachedHead']
const PROPERTY_KEYS: WorkspacePropertyKey[] = ['status', 'branch', 'project', 'kind', 'path', 'head', 'baseRef', 'projectGroup', 'branchRetention', 'pushTarget', 'pullRequest', 'issue', 'comment', 'creator', 'activity', 'tabCount']
const WORKTREE_STATUSES: WorktreeStatus[] = ['todo', 'in-progress', 'in-review', 'done']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function strings(value: unknown): string[] | null {
  return Array.isArray(value) && value.length <= 1000 && value.every((item) => typeof item === 'string' && item.length <= 1024)
    ? value
    : null
}

function isEnum<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === 'string' && values.includes(value as T)
}

export function workspacePreferencesKey(hostId: string): string {
  return `${PREFS_PREFIX}${hostId}`
}

function preferencesFrom(value: unknown): WorkspacePreferences | null {
  if (!isRecord(value)) return null
  const filters = isRecord(value.filters) ? value.filters : {}
  const properties = strings(value.properties)?.filter((property): property is WorkspacePropertyKey => isEnum(property, PROPERTY_KEYS))
  const pinnedWorktreeIds = strings(value.pinnedWorktreeIds)
  const collapsedGroups = strings(value.collapsedGroups)
  const collapsedWorktrees = strings(value.collapsedWorktrees)
  const sidebarWidth = typeof value.sidebarWidth === 'number' && Number.isFinite(value.sidebarWidth)
    ? Math.max(220, Math.min(480, Math.round(value.sidebarWidth)))
    : DEFAULT_WORKSPACE_PREFERENCES.sidebarWidth
  const nextFilters = { ...DEFAULT_WORKSPACE_PREFERENCES.filters }
  for (const key of FILTER_KEYS) if (typeof filters[key] === 'boolean') nextFilters[key] = filters[key] as boolean
  nextFilters.hideAutomationCreated = false
  nextFilters.hideOtherClient = false
  return {
    groupBy: isEnum(value.groupBy, GROUP_BY) ? value.groupBy : DEFAULT_WORKSPACE_PREFERENCES.groupBy,
    sortBy: isEnum(value.sortBy, SORT_BY) ? value.sortBy : DEFAULT_WORKSPACE_PREFERENCES.sortBy,
    projectOrder: value.projectOrder === 'recent' ? 'recent' : 'manual',
    cardLayout: isEnum(value.cardLayout, CARD_LAYOUT) ? value.cardLayout : DEFAULT_WORKSPACE_PREFERENCES.cardLayout,
    properties: properties ?? [...DEFAULT_WORKSPACE_PREFERENCES.properties],
    filters: nextFilters,
    pinnedWorktreeIds: pinnedWorktreeIds ?? [],
    collapsedGroups: collapsedGroups ?? [],
    collapsedWorktrees: collapsedWorktrees ?? [],
    sidebarCollapsed: typeof value.sidebarCollapsed === 'boolean' ? value.sidebarCollapsed : false,
    sidebarWidth
  }
}

export async function readWorkspacePreferences(bridge: MobilePageBridge): Promise<WorkspacePreferences> {
  try {
    const raw = await bridge.storage.get(workspacePreferencesKey(bridge.init.host.id))
    if (raw === null) return { ...DEFAULT_WORKSPACE_PREFERENCES, filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters } }
    const value: unknown = JSON.parse(raw)
    return preferencesFrom(value) ?? { ...DEFAULT_WORKSPACE_PREFERENCES, filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters } }
  } catch {
    return { ...DEFAULT_WORKSPACE_PREFERENCES, filters: { ...DEFAULT_WORKSPACE_PREFERENCES.filters } }
  }
}

export async function writeWorkspacePreferences(bridge: MobilePageBridge, value: WorkspacePreferences): Promise<void> {
  await bridge.storage.set(workspacePreferencesKey(bridge.init.host.id), JSON.stringify(value))
}

function isRepo(value: unknown): value is Repo {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.name === 'string' && typeof value.path === 'string' &&
    typeof value.addedAt === 'number' && (value.kind === 'git' || value.kind === 'folder') &&
    (value.displayName === null || typeof value.displayName === 'string') &&
    (value.groupId === null || typeof value.groupId === 'string')
}

function isGroup(value: unknown): value is ProjectGroup {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.name === 'string' &&
    (value.parentPath === null || typeof value.parentPath === 'string') && typeof value.collapsed === 'boolean' &&
    typeof value.order === 'number' && (value.createdFrom === 'manual' || value.createdFrom === 'folder-scan') &&
    Array.isArray(value.repoIds) && value.repoIds.every((id) => typeof id === 'string') &&
    (value.parentId === null || typeof value.parentId === 'string')
}

function isWorktreeLink(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (!isRecord(value) || value.provider !== 'github' || (value.kind !== 'issue' && value.kind !== 'pullRequest') ||
    typeof value.number !== 'number' || typeof value.title !== 'string' || typeof value.url !== 'string' || !isRecord(value.repository)) return false
  const repository = value.repository
  return typeof repository.host === 'string' && typeof repository.owner === 'string' && typeof repository.repo === 'string'
}

function isPushTarget(value: unknown): boolean {
  if (value === undefined || value === null) return true
  return isRecord(value) && typeof value.remoteName === 'string' && typeof value.branchName === 'string' && typeof value.maintainerCanModify === 'boolean'
}

function isWorktree(value: unknown): value is Worktree {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.repoId === 'string' && typeof value.path === 'string' &&
    (value.branch === null || typeof value.branch === 'string') && typeof value.head === 'string' &&
    typeof value.isMain === 'boolean' && typeof value.name === 'string' && (value.kind === 'git' || value.kind === 'folder') &&
    (value.displayName === null || typeof value.displayName === 'string') && typeof value.comment === 'string' &&
    isEnum(value.status, WORKTREE_STATUSES) && typeof value.pinned === 'boolean' && typeof value.unread === 'boolean' &&
    (value.parentId === null || typeof value.parentId === 'string') && typeof value.createdAt === 'number' &&
    (value.createdBy === 'window' || value.createdBy === 'cli' || value.createdBy === 'api' || value.createdBy === 'external') &&
    (value.baseRef === null || typeof value.baseRef === 'string') && typeof value.keepBranch === 'boolean' &&
    typeof value.removing === 'boolean' && (value.groupId === null || typeof value.groupId === 'string') &&
    (value.projectGroupId === null || typeof value.projectGroupId === 'string') && typeof value.lastActivityAt === 'number' &&
    typeof value.instanceId === 'string' && isWorktreeLink(value.linkedPR) && isWorktreeLink(value.linkedIssue) && isPushTarget(value.pushTarget)
}

function isSessionSummary(value: unknown): value is WorkspaceSessionSummary {
  if (!isRecord(value)) return false
  return typeof value.id === 'string' && typeof value.worktreeId === 'string' &&
    (value.kind === 'terminal' || value.kind === 'structured') && typeof value.agent === 'string' &&
    isEnum(value.status, ['starting', 'running', 'working', 'waiting', 'done', 'exited']) &&
    typeof value.title === 'string' && typeof value.createdAt === 'number' && typeof value.lastActivityAt === 'number'
}

export function projectWorkspaceSessions(sessions: Session[]): WorkspaceSessionSummary[] {
  return sessions.map(({ id, worktreeId, kind, agent, status, title, createdAt, lastActivityAt }) => ({
    id, worktreeId, kind, agent, status, title, createdAt, lastActivityAt,
  }))
}

function cacheFrom(value: unknown): WorkspaceCache | null {
  if (!isRecord(value) || !Array.isArray(value.repos) || !value.repos.every(isRepo) ||
    !Array.isArray(value.groups) || !value.groups.every(isGroup) ||
    !Array.isArray(value.worktrees) || !value.worktrees.every(isWorktree) ||
    !Array.isArray(value.sessions) || !value.sessions.every(isSessionSummary)) return null
  return { repos: value.repos, groups: value.groups, worktrees: value.worktrees, sessions: value.sessions }
}

export async function readWorkspaceCache(bridge: MobilePageBridge): Promise<WorkspaceCache | null> {
  try {
    const raw = await bridge.storage.get(`${CACHE_PREFIX}${bridge.init.host.id}`)
    if (raw === null) return null
    return cacheFrom(JSON.parse(raw) as unknown)
  } catch {
    return null
  }
}

export async function writeWorkspaceCache(bridge: MobilePageBridge, value: WorkspaceCache): Promise<void> {
  await bridge.storage.set(`${CACHE_PREFIX}${bridge.init.host.id}`, JSON.stringify(value))
}
