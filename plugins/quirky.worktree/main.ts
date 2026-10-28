import {
  formatContributionId,
  RpcErrorCode,
  type PluginCaller,
  type EffectiveHooks,
  type PluginContext,
  type ProjectGroup,
  type QuirkyEvent,
  type Repo,
  type Worktree
} from '@quirky/protocol'
import { expandHome, resolveRealPath, worktreeIdForPath } from './paths'
import { SelectorSyntaxError, matchWorktrees, type CallerIdentity } from './selector'
import { BranchCleaner } from './src/daemon/branches'
import { createWorkspace, suggestName, type CreateEnv, type CreateParams, type PendingStart } from './src/daemon/create'
import { groupRepoId, listEverything, listGroup, listProject, type ListEnv } from './src/daemon/list'
import { KeyedQueue } from './src/daemon/queue'
import { deleteBranch, describeRemove, removeWorktree, type DeleteBranchParams, type InFlightRemove, type RemoveEnv, type RemoveParams } from './src/daemon/remove'
import { createGroupForWorktree, setWorktree, showWorktree, type CreateGroupParams, type SetEnv, type SetParams } from './src/daemon/set'
import { filesystemIdentitySource } from './src/daemon/identity'
import { openWorktreeStore, readV1Rows } from './src/daemon/store'
import {
  cleanupIgnore,
  cleanupPreview,
  cleanupRemove,
  cleanupRestoreIgnored,
  previewSleep,
  sleepWorktree,
  wakeWorktree,
  worktreeRuntimeBlockers,
  type ControlEnv
} from './src/daemon/controls'
import { readProjectOrder, readStockOptions, reorderProjects, reorderWorktrees, setStockOptions } from './src/daemon/options'
import { getProjectMetadata, projectMetadata, setExternalInboxSuppressed, setProjectMetadata } from './src/daemon/project'
import { archiveWorktree, linkReference, listReferences, unlinkReference, type RecordEnv } from './src/daemon/records'
import { readStatusDefinitions, setStatusDefinitions } from './src/daemon/statuses'
import { navigate, navigationHistoryMove, navigationIndex, navigationState, navigationStep, openIn } from './src/daemon/navigation'
import type { CleanupSelection, WorktreeControl } from './src/control-types'

const DEFAULT_WORKTREES_ROOT = '~/quirky/workspaces'
const ROOT_SETTING = 'setting:quirky.worktree/worktreesRoot'
const SETTINGS_IMPORTED = 'v1-settings-imported'

type ErrorKind = 'invalid-params' | 'not-found' | 'conflict'
type Handler = (params: Record<string, any>, caller: PluginCaller) => unknown

function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sessionActivity(event: QuirkyEvent): { worktreeId: string; lastActivityAt: number } | null {
  if (event.type !== 'quirky.session/changed' || !('data' in event)) return null
  const data = event.data
  if (typeof data !== 'object' || data === null || !('session' in data)) return null
  const session = data.session
  if (typeof session !== 'object' || session === null ||
    !('worktreeId' in session) || typeof session.worktreeId !== 'string' ||
    !('lastActivityAt' in session) || typeof session.lastActivityAt !== 'number' || !Number.isFinite(session.lastActivityAt)) {
    return null
  }
  return { worktreeId: session.worktreeId, lastActivityAt: session.lastActivityAt }
}

/** git's own explanation for a failure: its stderr when it has one, else the error message. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** The cwd and session worktree to read `current` against: explicit params first, then the calling client's. */
function identityOf(caller: PluginCaller, params: { cwd?: string; worktreeId?: string } = {}): CallerIdentity {
  const client: CallerIdentity = caller.role === 'plugin' ? {} : caller
  const cwd = params.cwd ?? client.cwd
  const worktreeId = params.worktreeId ?? client.worktreeId
  return { ...(cwd ? { cwd } : {}), ...(worktreeId ? { worktreeId } : {}) }
}

let releasePending: (() => void) | undefined

/** Drops the agent starts still waiting for a Setup terminal; they do not survive a daemon stop. */
export function deactivate(): void {
  releasePending?.()
  releasePending = undefined
}

export async function activate(context: PluginContext): Promise<void> {
  const store = openWorktreeStore(context)

  const fail = (kind: ErrorKind, message: string, data?: unknown) =>
    data === undefined ? context.error(kind, message) : Object.assign(context.error(kind, message), { data })

  const listRepos = async () => (await context.call('quirky.repo/list')) as Repo[]

  const listGroups = async () => (await context.call('quirky.repo/groupList')) as ProjectGroup[]

  function releaseGroupMembership(groups: string[]): void {
    const ids = [...new Set(groups)]
    if (ids.length === 0) return
    const changed: { repo_id: string; id: string }[] = []
    store.transaction(() => {
      for (const groupId of ids) {
        changed.push(...store.all<{ repo_id: string; id: string }>(
          'SELECT repo_id, id FROM worktrees WHERE project_group_id = ?',
          groupId
        ))
        store.run('UPDATE worktrees SET project_group_id = NULL WHERE project_group_id = ?', groupId)
      }
    })
    for (const row of changed) context.emit('changed', { repoId: row.repo_id, worktreeId: row.id })
  }

  async function reconcileDeletedGroups(): Promise<void> {
    const deleted = (await context.call('quirky.repo/groupDeletedIds')) as string[]
    releaseGroupMembership(deleted)
  }
  const removing = new Set<string>()
  const pendingStarts = new Set<PendingStart>()
  releasePending = () => {
    for (const start of [...pendingStarts]) {
      context.log(`dropped the pending start of ${start.label}: the daemon stopped before setup finished`)
      start.dispose()
    }
  }
  const listEnv: ListEnv = { store, groups: listGroups, log: context.log, removing, identitySource: filesystemIdentitySource }

  /** The group with this ID or exact name; several of one name is a conflict. */
  async function resolveGroup(selector: string): Promise<ProjectGroup> {
    const groups = await listGroups()
    const byId = groups.filter((group) => group.id === selector)
    const matches = byId.length > 0 ? byId : groups.filter((group) => group.name === selector)
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw fail('not-found', `no group matches ${selector}; use its ID or exact name`)
    const ids = matches.map((group) => group.id)
    throw fail('conflict', `${selector} matches ${matches.length} groups: ${ids.join(', ')}`, { matches: ids })
  }

  /** The directory under the worktrees root for a repo's worktrees; unique even for repos sharing a name. */
  async function worktreeDirName(repo: Repo): Promise<string> {
    const shareName = (await listRepos()).some((other) => other.id !== repo.id && other.name === repo.name)
    return shareName ? `${repo.name}-${repo.id.replace(/^repo_/, '').slice(0, 6)}` : repo.name
  }

  function worktreesRoot(): string {
    const configured = String(context.getSetting('worktreesRoot')).trim()
    return resolveRealPath(expandHome(configured === '' ? DEFAULT_WORKTREES_ROOT : configured))
  }

  async function findWorktree(
    selector: string,
    identity: CallerIdentity
  ): Promise<{ repo: Repo | undefined; worktree: WorktreeControl; all: WorktreeControl[] }> {
    await reconcileDeletedGroups()
    const repos = await listRepos()
    const all = await listEverything(listEnv, repos)
    let matches: Worktree[]
    try {
      matches = matchWorktrees(all, selector, identity)
    } catch (error) {
      if (error instanceof SelectorSyntaxError) throw fail('invalid-params', error.message)
      throw error
    }
    if (matches.length === 0) {
      throw fail('not-found', `no worktree matches ${selector}; use id:, name:, branch:, path: or current`)
    }
    if (matches.length > 1) {
      const ids = matches.map((worktree) => `id:${worktree.id}`)
      throw fail('conflict', `${selector} matches ${matches.length} worktrees: ${ids.join(', ')}`, { matches: ids })
    }
    const worktree = all.find((candidate) => candidate.id === matches[0]!.id)!
    return { repo: repos.find((repo) => repo.id === worktree.repoId), worktree, all }
  }

  /** Closes every session of the worktree, attempting all of them; returns one message per failure. */
  async function closeSessions(worktreeId: string): Promise<string[]> {
    let sessions: { id: string; worktreeId: string }[]
    try {
      sessions = (await context.call('quirky.session/list')) as typeof sessions
    } catch (error) {
      if (isMethodNotFound(error)) return []
      return [`could not list sessions: ${errorMessage(error)}`]
    }
    const errors: string[] = []
    for (const session of sessions) {
      if (session.worktreeId !== worktreeId) continue
      try {
        await context.call('quirky.session/close', { session: session.id })
      } catch (error) {
        errors.push(`could not close session ${session.id}: ${errorMessage(error)}`)
      }
    }
    return errors
  }

  const createEnv: CreateEnv = {
    ...listEnv,
    fail,
    changed: (data) => void context.emit('changed', data),
    call: (method, params) => context.call(method, params),
    subscribe: (listener) => context.subscribe(listener),
    getSetting: (name) => context.getSetting(name),
    dataDir: context.dataDir,
    worktreesRoot,
    worktreeDirName,
    resolveRepo: async (selector) => (await context.call('quirky.repo/resolve', { selector })) as Repo,
    resolveGroup,
    find: async (selector, identity) => {
      const { worktree, all } = await findWorktree(selector, identity)
      return { worktree, all }
    },
    queue: new KeyedQueue(),
    suggestions: new Map(),
    pending: pendingStarts
  }

  const removeEnv: RemoveEnv = {
    ...listEnv,
    removing,
    inflight: new Map<string, InFlightRemove>(),
    fail,
    changed: (data) => void context.emit('changed', data),
    repos: listRepos,
    resolveRepo: async (selector) => (await context.call('quirky.repo/resolve', { selector })) as Repo,
    hooksAt: async (repo, ref) => (await context.call('quirky.repo/hooks', { repo: repo.id, ref })) as EffectiveHooks,
    closeSessions,
    assertNoActiveSessions: async (worktreeId) =>
      (await worktreeRuntimeBlockers((method, params) => context.call(method, params), worktreeId))
        .map((blocker) => `${blocker.code}: ${blocker.detail}`),
    branches: new BranchCleaner()
  }

  /**
   * Every worktree ID recorded for `repo`, plus its main worktree's, so removing the repo can find
   * their sessions. Rows git no longer knows are kept: their sessions may still be open.
   */
  async function ownedIds(params: Record<string, any>): Promise<string[]> {
    const repo = (await context.call('quirky.repo/resolve', { selector: String(params.repo) })) as Repo
    const listed = await listProject(listEnv, repo, { prune: false }).catch(() => [] as WorktreeControl[])
    const recorded = store.all<{ id: string }>('SELECT id FROM worktrees WHERE repo_id = ?', repo.id).map((row) => row.id)
    return [...new Set([...recorded, ...listed.map((worktree) => worktree.id), worktreeIdForPath(repo.path)])].sort()
  }

  /**
   * Drops the metadata of projects and groups that no longer exist, so a re-added project starts
   * from defaults. Group workspaces are kept while their group is known; when the group list
   * can't be read nothing of theirs is dropped.
   */
  async function pruneRemovedRepos(): Promise<void> {
    const live = new Set((await listRepos()).map((repo) => repo.id))
    const liveGroups = await listGroups().then(
      (groups) => new Set(groups.map((group) => groupRepoId(group.id))),
      () => null
    )
    const recorded = store.all<{ repo_id: string }>('SELECT DISTINCT repo_id FROM worktrees').map((row) => row.repo_id)
    for (const repoId of recorded) {
      const known = repoId.startsWith('group:') ? (liveGroups === null || liveGroups.has(repoId)) : live.has(repoId)
      if (!known) store.run('DELETE FROM worktrees WHERE repo_id = ?', repoId)
    }
  }

  /** Moves v1's `worktreesRoot` setting over once, unless the user has already chosen a value. */
  async function importV1Root(): Promise<void> {
    if (store.get('SELECT 1 FROM meta WHERE key = ?', SETTINGS_IMPORTED)) return
    store.run('INSERT INTO meta (key, value) VALUES (?, ?)', SETTINGS_IMPORTED, '1')
    const row = readV1Rows<{ key: string; value: string }>(context.home, 'settings', context.log).find((r) => r.key === 'worktreesRoot')
    if (!row) return
    const stored = (await context.call('setting.get', { id: ROOT_SETTING })) as { stored?: unknown }
    if (stored.stored !== undefined) return
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      value = undefined
    }
    if (typeof value !== 'string' || value.trim() === '') {
      context.log('skipped the v1 worktreesRoot setting: it is not a non-empty string')
      return
    }
    await context.call('setting.set', { id: ROOT_SETTING, value })
  }

  context.subscribe((event: QuirkyEvent) => {
    if (event.type === 'quirky.repo/changed') {
      pruneRemovedRepos().catch((error) => context.log(`could not prune worktree records: ${error}`))
      reconcileDeletedGroups().catch((error) => context.log(`could not release deleted project-group memberships: ${error}`))
    }
    const activity = sessionActivity(event)
    if (!activity) return
    const row = store.get<{ repo_id: string; last_activity_at: number }>('SELECT repo_id, last_activity_at FROM worktrees WHERE id = ?', activity.worktreeId)
    if (!row || activity.lastActivityAt <= row.last_activity_at) return
    store.run('UPDATE worktrees SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?', activity.lastActivityAt, activity.worktreeId)
    context.emit('changed', { repoId: row.repo_id, worktreeId: activity.worktreeId })
  })

  const setEnv: SetEnv = {
    store,
    fail,
    find: async (selector, identity) => {
      const { worktree, all } = await findWorktree(selector, identity)
      return { worktree, all }
    },
    resolveRepo: async (selector) => (await context.call('quirky.repo/resolve', { selector })) as Repo,
    groups: listGroups,
    call: (method, params) => context.call(method, params),
    identitySource: filesystemIdentitySource,
    changed: (data) => void context.emit('changed', data)
  }
  const recordEnv: RecordEnv = {
    store,
    fail,
    find: async (selector, identity) => {
      const { worktree, all } = await findWorktree(selector, identity)
      return { worktree, all }
    },
    changed: (data) => void context.emit('changed', data)
  }
  const projectEnv = {
    store,
    fail,
    call: (method: string, params: Record<string, unknown>) => context.call(method, params),
    resolveRepo: async (selector: string) => (await context.call('quirky.repo/resolve', { selector })) as Repo
  }
  const controlEnv: ControlEnv = {
    list: listEnv,
    remove: removeEnv,
    store,
    repos: listRepos,
    call: (method, params) => context.call(method, params),
    find: async (selector, identity) => {
      const { worktree, all } = await findWorktree(selector, identity)
      return { worktree, all }
    },
    fail,
    changed: (data) => void context.emit('changed', data)
  }
  const navigationEnv = {
    store,
    fail,
    call: (method: string, params?: Record<string, unknown>) => context.call(method, params),
    list: async () => listEverything(listEnv, await listRepos()),
    find: async (selector: string, identity: CallerIdentity) => {
      const { worktree, all } = await findWorktree(selector, identity)
      return { worktree, all }
    },
    options: () => readStockOptions(store),
    changed: (data: { repoId: string; worktreeId: string }) => void context.emit('changed', data)
  }
  async function notifyProjectWorktrees(selector?: string): Promise<void> {
    const repos = selector === undefined ? await listRepos() : [await projectEnv.resolveRepo(selector)]
    const rows = await Promise.all(repos.map((repo) => listProject(listEnv, repo).catch(() => [] as WorktreeControl[])))
    for (const worktree of rows.flat()) context.emit('changed', { repoId: worktree.repoId, worktreeId: worktree.id })
  }

  const handlers: Record<string, Handler> = {
    async list(params) {
      await reconcileDeletedGroups()
      if (params.repo === undefined && params.group === undefined) return await listEverything(listEnv, await listRepos())
      const result: WorktreeControl[] = []
      if (params.repo !== undefined) {
        const repo = (await context.call('quirky.repo/resolve', { selector: String(params.repo) })) as Repo
        try {
          result.push(...(await listProject(listEnv, repo)))
        } catch (error) {
          throw new Error(gitMessage(error))
        }
      }
      if (params.group !== undefined) result.push(...listGroup(listEnv, await resolveGroup(String(params.group))))
      return result
    },
    create: (params, caller) => createWorkspace(createEnv, params as CreateParams, identityOf(caller)),
    suggestName: (params) => suggestName(createEnv, params as { repo: string }),
    set: (params, caller) => setWorktree(setEnv, params as SetParams, identityOf(caller)),
    createGroup: (params, caller) => createGroupForWorktree(setEnv, params as CreateGroupParams, identityOf(caller)),
    releaseGroups(params) {
      if (!Array.isArray(params.groups) || !params.groups.every((group) => typeof group === 'string')) {
        throw fail('invalid-params', 'groups must be an array of group IDs')
      }
      releaseGroupMembership(params.groups)
      return { ok: true }
    },
    show: (params, caller) => showWorktree(setEnv, params as { worktree: string }, identityOf(caller)),
    remove: (params, caller) => removeWorktree(removeEnv, params as RemoveParams, identityOf(caller)),
    describeRemove: (params, caller) => describeRemove(removeEnv, params as RemoveParams, identityOf(caller)),
    deleteBranch: (params) => deleteBranch(removeEnv, params as DeleteBranchParams),
    async resolve(params, caller) {
      return (await findWorktree(String(params.selector), identityOf(caller, params))).worktree
    },
    navigate: (params, caller) => navigate(navigationEnv, params as { worktree: string; target?: unknown }, identityOf(caller)),
    openIn: (params, caller) => openIn(navigationEnv, params as { worktree: string; target: unknown }, identityOf(caller)),
    navigationState: () => navigationState(store),
    navigationBack: () => navigationHistoryMove(navigationEnv, 'back'),
    navigationForward: () => navigationHistoryMove(navigationEnv, 'forward'),
    navigationMove(params) {
      if (params.direction !== 'previous' && params.direction !== 'next') throw fail('invalid-params', 'direction must be previous or next')
      return navigationStep(navigationEnv, params.direction)
    },
    navigationIndex: (params) => navigationIndex(navigationEnv, params.index),
    projectMetadata(params) {
      if (params.repo === undefined) throw fail('invalid-params', 'repo is required')
      return getProjectMetadata(projectEnv, String(params.repo), readStockOptions(store).externalVisibilityDefault)
    },
    projectMetadataList() {
      const globalExternalVisibility = readStockOptions(store).externalVisibilityDefault
      return listRepos().then((repos) => repos.map((repo) => projectMetadata(store, repo, globalExternalVisibility)))
    },
    async setProjectMetadata(params) {
      const updated = await setProjectMetadata(projectEnv, params as { repo: string; identity?: unknown; externalVisibility?: unknown; sharedDirectories?: unknown }, readStockOptions(store).externalVisibilityDefault)
      context.emit('projectMetadataChanged', { repoId: updated.repoId })
      return updated
    },
    async suppressExternalInbox(params) {
      const updated = await setExternalInboxSuppressed(projectEnv, params as { repo: string; suppressed: unknown }, readStockOptions(store).externalVisibilityDefault)
      await notifyProjectWorktrees(String(params.repo))
      return updated
    },
    async externalInbox() {
      const repos = await listRepos()
      const worktrees = await listEverything(listEnv, repos)
      const defaultVisibility = readStockOptions(store).externalVisibilityDefault
      const projects = repos.map((repo) => {
        const metadata = projectMetadata(store, repo, defaultVisibility)
        const hidden = worktrees.filter((worktree) =>
          worktree.repoId === repo.id && worktree.kind === 'git' && !worktree.isMain &&
          worktree.createdBy === 'external' && !worktree.externalVisible
        )
        return {
          repoId: repo.id,
          projectName: repo.displayName ?? repo.name,
          externalVisibility: metadata.externalVisibility,
          effectiveExternalVisibility: metadata.effectiveExternalVisibility,
          suppressed: metadata.externalInboxSuppressed,
          hiddenWorktreeIds: hidden.map((worktree) => worktree.id),
          hiddenWorktrees: hidden
        }
      }).filter((project) => project.hiddenWorktreeIds.length > 0)
      return { defaultVisibility, projects }
    },
    projectOrder: async () => readProjectOrder(store, await listRepos()),
    async reorderProjects(params) {
      const result = reorderProjects({ store, fail }, await listRepos(), params.projects)
      context.emit('optionsChanged', { options: readStockOptions(store) })
      return result
    },
    statusDefinitions: () => readStatusDefinitions(store),
    setStatusDefinitions(params) {
      const statuses = setStatusDefinitions(store, fail, params.statuses)
      context.emit('statusDefinitionsChanged', { statuses })
      return statuses
    },
    archive: (params, caller) => archiveWorktree(recordEnv, params as { worktree: string; archivedAt?: unknown }, identityOf(caller)),
    references: (params, caller) => listReferences(recordEnv, String(params.worktree), identityOf(caller)),
    linkReference: (params, caller) => linkReference(recordEnv, params as { worktree: string; url: unknown; label?: unknown }, identityOf(caller)),
    unlinkReference: (params, caller) => unlinkReference(recordEnv, params as { worktree: string; reference: unknown }, identityOf(caller)),
    options: () => readStockOptions(store),
    setOptions(params) {
      const before = readStockOptions(store)
      const options = setStockOptions({ store, fail }, params)
      context.emit('optionsChanged', { options })
      if (before.externalVisibilityDefault !== options.externalVisibilityDefault) void notifyProjectWorktrees()
      return options
    },
    async reorder(params) {
      const all = await listEverything(listEnv, await listRepos())
      const result = reorderWorktrees({ store, fail }, all, params.worktrees)
      if (Array.isArray(params.worktrees)) {
        for (const id of params.worktrees) {
          if (typeof id !== 'string') continue
          const worktree = all.find((candidate) => candidate.id === id)
          if (worktree) context.emit('changed', { repoId: worktree.repoId, worktreeId: worktree.id })
        }
      }
      return result
    },
    sleepPreview: (params, caller) => previewSleep(controlEnv, params as { worktree: string; withDescendants?: boolean }, identityOf(caller)),
    sleep: (params, caller) => sleepWorktree(controlEnv, params as { worktree: string; withDescendants?: boolean }, identityOf(caller)),
    wake: (params, caller) => wakeWorktree(controlEnv, params as { worktree: string; withDescendants?: boolean }, identityOf(caller)),
    cleanupPreview: () => cleanupPreview(controlEnv),
    cleanupIgnore: (params) => cleanupIgnore(controlEnv, params as { worktreeId: string; fingerprint: string }),
    cleanupRestoreIgnored: () => cleanupRestoreIgnored(controlEnv),
    cleanupRemove: (params, caller) => cleanupRemove(
      controlEnv,
      params as { selection: CleanupSelection[]; confirmed: boolean },
      identityOf(caller)
    ),
  }
  for (const [name, handler] of Object.entries(handlers)) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }

  await importV1Root()
}
