/**
 * A converted host's source rows: hidden from this build's lists, which show the managed server
 * instead, and kept for a downgraded build that still reads them. Nothing here ever deletes them;
 * only stopping the server, removing the host or uninstalling does.
 *
 * On every start the rows are compared with what the migration committed. If an older build
 * changed them, the host is marked `sourceChangedAt`: its rows show again, it stays on the relay,
 * and it needs a new move. A second manifest is never merged into the server automatically.
 */
import { createHash } from 'node:crypto'
import { getAppEnvironment } from '../../shared/app-environment'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../shared/execution-host'
import type { FolderWorkspace } from '../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../shared/project-group-types'
import type { ProjectHostSetup } from '../../shared/project-types'
import type { QuirkydMigrationCatalogPayload } from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  isRetainedQuirkydMigrationSourceCutover,
  type QuirkydMigrationSourceCutover
} from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { Repo } from '../../shared/repo-types'
import { listEnvironments } from '../../shared/runtime-environment-store'
import { getQuirkydSshDeployment } from '../../shared/runtime-environments'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectQuirkydMigrationSourceCatalog } from '../persistence/migrating-quirkyd-catalog/quirkyd-source-catalog'
import {
  quirkydSourceFolderWorkspaceIds,
  projectGroupBelongsToQuirkydSource,
  repoBelongsToQuirkydSource
} from '../persistence/migrating-quirkyd-catalog/quirkyd-source-ownership'
import { findQuirkydMigrationSourceCutoverForTarget } from './quirkyd-migration-cutover-journal'
import {
  withoutWslMovedFolderWorkspaces,
  withoutWslMovedRepos
} from '../persistence/moving-wsl-projects/wsl-move-scope-guard'

const appUserDataPath = (): string => getAppEnvironment().getPath('userData')

type CatalogStore = Pick<Store, 'getFolderWorkspaces' | 'getProjectGroups' | 'getRepos'>
type TargetStore = Pick<Store, 'getSshTargets' | 'updateSshTarget'>

/**
 * Whether this build hides the host's source rows: committed to its server and not changed by an
 * older build since. Mid-migration the rows stay shown, since the source is still authoritative,
 * and so does a fence no journal explains (an empty host's deploy): no move owns those rows.
 */
export function isHiddenRetainedSourceTarget(
  userDataPath: string,
  target: Pick<SshTarget, 'id' | 'quirkydFence'>
): boolean {
  if (!target.quirkydFence || target.quirkydFence.sourceChangedAt) {
    return false
  }
  let head: QuirkydMigrationSourceCutover | null
  try {
    head = findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id)
  } catch {
    return true // An unreadable journal keeps the host fenced, and so hidden.
  }
  return (
    head !== null &&
    (head.phase === 'destination-committed' ||
      head.phase === 'source-retired' ||
      head.destinationEnvironmentId !== target.quirkydFence.environmentId)
  )
}

/** `getUserDataPath` is read only once a host is fenced, so unfenced lists never touch the journal. */
export function hiddenRetainedSourceTargetIds(
  getUserDataPath: () => string,
  targets: readonly SshTarget[]
): string[] {
  return targets
    .filter(
      (target) => target.quirkydFence && isHiddenRetainedSourceTarget(getUserDataPath(), target)
    )
    .map((target) => target.id)
}

/**
 * A fenced host's `ssh:` session partition is migration source from the fence on: a renderer save
 * would change it mid-conversion, and strip the rows this build hides once it commits.
 */
export function isFrozenQuirkydSourceSessionPartition(
  store: Pick<Store, 'getSshTarget'>,
  hostId: string | null | undefined
): boolean {
  const parsed = parseExecutionHostId(hostId)
  const fence =
    parsed?.kind === 'ssh' ? store.getSshTarget(parsed.targetId)?.quirkydFence : undefined
  return fence !== undefined && !fence.sourceChangedAt
}

export function visibleRepos(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): Repo[] {
  return reposShownWith(
    store.getRepos(),
    hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  )
}

function reposShownWith(allRepos: Repo[], hiddenTargets: readonly string[]): Repo[] {
  const repos = withoutWslMovedRepos(allRepos)
  if (hiddenTargets.length === 0) {
    return repos
  }
  return repos.filter(
    (repo) => !hiddenTargets.some((targetId) => repoBelongsToQuirkydSource(repo, targetId))
  )
}

/** Hides only groups the host owns; a local group holding one of its projects stays. */
export function visibleProjectGroups(
  store: Pick<Store, 'getProjectGroups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectGroup[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const groups = store.getProjectGroups()
  if (hidden.length === 0) {
    return groups
  }
  return groups.filter(
    (group) => !hidden.some((targetId) => projectGroupBelongsToQuirkydSource(group, targetId))
  )
}

export function visibleFolderWorkspaces(
  store: CatalogStore & Pick<Store, 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): FolderWorkspace[] {
  const hidden = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const folderWorkspaces = withoutWslMovedFolderWorkspaces(store.getFolderWorkspaces())
  if (hidden.length === 0) {
    return folderWorkspaces
  }
  const state = {
    repos: store.getRepos(),
    projectGroups: store.getProjectGroups(),
    folderWorkspaces
  }
  const hiddenIds = new Set(
    hidden.flatMap((targetId) => [...quirkydSourceFolderWorkspaceIds(state, targetId)])
  )
  return folderWorkspaces.filter((workspace) => !hiddenIds.has(workspace.id))
}

/**
 * A setup is listed only while its repo row is: the server that took a hidden row lists its own
 * setup under the same id, so leaking ours shows every moved project's host twice (#30859).
 */
export function visibleProjectHostSetups(
  store: CatalogStore & Pick<Store, 'getProjectHostSetups' | 'getSshTargets'>,
  getUserDataPath = appUserDataPath
): ProjectHostSetup[] {
  const setups = store.getProjectHostSetups()
  if (setups.length === 0) {
    return setups
  }
  const hiddenTargets = hiddenRetainedSourceTargetIds(getUserDataPath, store.getSshTargets())
  const allRepos = store.getRepos()
  const shownRepos = reposShownWith(allRepos, hiddenTargets)
  if (hiddenTargets.length === 0 && shownRepos.length === allRepos.length) {
    return setups
  }
  const rowKey = (hostId: string, repoId: string): string => `${hostId}\0${repoId}`
  const shownKeys = new Set(shownRepos.map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id)))
  const hiddenKeys = new Set(
    allRepos
      .map((repo) => rowKey(getRepoExecutionHostId(repo), repo.id))
      .filter((key) => !shownKeys.has(key))
  )
  return setups.filter((setup) => {
    if (setup.repoId && hiddenKeys.has(rowKey(setup.hostId, setup.repoId))) {
      return false
    }
    // Repo-less placeholders have no row to follow, so the hidden host decides for them.
    const host = parseExecutionHostId(setup.hostId)
    return !(host?.kind === 'ssh' && hiddenTargets.includes(host.targetId))
  })
}

/**
 * Identity only, hashed to fit the journal: an older build adding, removing or moving a project is
 * a change, a touched timestamp is not.
 */
export function quirkydCatalogFingerprint(catalog: QuirkydMigrationCatalogPayload): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        catalog.repositories.map((repo) => `${repo.id}\0${repo.path}`).sort(),
        catalog.folderWorkspaces.map((folder) => `${folder.id}\0${folder.folderPath}`).sort(),
        catalog.projectGroups.map((group) => group.id).sort()
      ])
    )
    .digest('hex')
}

export function currentQuirkydSourceFingerprint(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>
): string {
  return quirkydCatalogFingerprint(collectQuirkydMigrationSourceCatalog(store, target))
}

/** What the retained source must still look like for this build to keep serving it from quirkyd. */
export function retainedQuirkydSourceBaseline(head: QuirkydMigrationSourceCutover): string {
  return head.sourceBaselineFingerprint ?? quirkydCatalogFingerprint(head.manifest.payload)
}

type RetainedSourceVerdict = 'unchanged' | 'changed'

/** Identity only: an older build's edits inside moved projects stay in the retained rows. */
function compareRetainedQuirkydSource(
  store: CatalogStore,
  target: Pick<SshTarget, 'id'>,
  head: QuirkydMigrationSourceCutover
): RetainedSourceVerdict {
  return currentQuirkydSourceFingerprint(store, target) === retainedQuirkydSourceBaseline(head)
    ? 'unchanged'
    : 'changed'
}

/**
 * Startup pass: restore a fence the profile lost from the registered managed server, and mark a
 * retained host whose rows an older build changed. Never throws; a failed pass changes nothing.
 */
export function reconcileManagedQuirkydSshTargets(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date = () => new Date()
): void {
  try {
    restoreFencesFromManagedServers(userDataPath, store)
    markChangedRetainedSources(userDataPath, store, now)
  } catch (error) {
    console.warn('[ssh] Could not reconcile managed Quirky server hosts:', error)
  }
}

function restoreFencesFromManagedServers(userDataPath: string, store: TargetStore): void {
  const targets = new Map(store.getSshTargets().map((target) => [target.id, target]))
  for (const environment of listEnvironments(userDataPath)) {
    const deployment = getQuirkydSshDeployment(environment)
    const target = deployment ? targets.get(deployment.sshTargetId) : undefined
    // Why generation-bound: a host re-created under the same id is a different registration.
    if (target && !target.quirkydFence && target.generation === deployment?.sshTargetGeneration) {
      store.updateSshTarget(target.id, { quirkydFence: { environmentId: environment.id } })
    }
  }
}

function markChangedRetainedSources(
  userDataPath: string,
  store: CatalogStore & TargetStore,
  now: () => Date
): void {
  for (const target of store.getSshTargets()) {
    const fence = target.quirkydFence
    const head = fence ? findQuirkydMigrationSourceCutoverForTarget(userDataPath, target.id) : null
    if (
      !fence ||
      !head ||
      fence.environmentId !== head.destinationEnvironmentId ||
      fence.sourceChangedAt
    ) {
      continue
    }
    // A delta move a crash interrupted lost its mark with it; the mark leads back to resuming it.
    const interruptedDelta =
      head.supersedesMigrationId !== undefined &&
      (head.phase === 'source-fenced' || head.phase === 'destination-staged')
    if (
      interruptedDelta ||
      (isRetainedQuirkydMigrationSourceCutover(head) &&
        compareRetainedQuirkydSource(store, target, head) === 'changed')
    ) {
      store.updateSshTarget(target.id, {
        quirkydFence: { ...fence, sourceChangedAt: now().toISOString() }
      })
    }
  }
}
