/**
 * Client state that still references an SSH target. An empty-host claim refuses any of it, since
 * hiding the target would strand it; a migration blocks only on what its manifest can't carry.
 */
import type { Store } from '../../persistence'
import { getDefaultWorkspaceSession } from '../../../shared/constants'
import { toSshExecutionHostId } from '../../../shared/execution-host'
import { GLOBAL_WORKSPACE_SESSION_FIELDS } from '../../../shared/workspace-session-host-field-ownership'
import {
  QUIRKYD_MIGRATION_DEPENDENCY_KINDS,
  type QuirkydMigrationBlocker,
  type QuirkydMigrationDependency,
  type QuirkydMigrationDependencyKind
} from '../../../shared/quirkyd-migration/quirkyd-migration-preflight'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'

export type DependentStateStore = Pick<
  Store,
  | 'getAllWorktreeMetaForHost'
  | 'getSshRemotePtyLeases'
  | 'getWorkspaceSession'
  | 'getWorkspaceSessionHostIds'
  | 'listAutomations'
>

const MAX_NAMES = 5

export function collectDependentStateBlockers(
  store: DependentStateStore,
  targetId: string
): QuirkydMigrationBlocker[] {
  const hostId = toSshExecutionHostId(targetId)
  const readers: [QuirkydMigrationDependencyKind, () => string[]][] = [
    ['workspace-session', () => workspaceSessionReferences(store, hostId)],
    [
      'automation',
      () =>
        store
          .listAutomations()
          .filter((a) => a.executionTargetType === 'ssh' && a.executionTargetId === targetId)
          .map((a) => a.name)
    ],
    ['worktree-metadata', () => Object.keys(store.getAllWorktreeMetaForHost(hostId))],
    // Why every status: a terminated lease is still a saved record pointing at this host.
    [
      'terminal-lease',
      () => store.getSshRemotePtyLeases(targetId).map((lease) => `${lease.ptyId} (${lease.state})`)
    ]
  ]
  const dependencies: QuirkydMigrationDependency[] = []
  const unreadable: QuirkydMigrationDependencyKind[] = []
  for (const [kind, read] of readers) {
    let names: string[]
    try {
      names = read()
    } catch {
      unreadable.push(kind)
      continue
    }
    if (names.length > 0) {
      dependencies.push({ kind, count: names.length, names: names.slice(0, MAX_NAMES) })
    }
  }
  const blockers: QuirkydMigrationBlocker[] = []
  if (dependencies.length > 0) {
    blockers.push({
      code: 'quirkyd_migration_dependent_state',
      category: 'client-owned-state',
      dependencies
    })
  }
  if (unreadable.length > 0) {
    blockers.push({
      code: 'quirkyd_migration_dependency_unverifiable',
      category: 'live-or-unverifiable',
      sources: unreadable
    })
  }
  return blockers
}

/** Kinds with their own blockers (port forwards, terminal leases) are counted elsewhere. */
const CENSUS_DEPENDENCY_KINDS = QUIRKYD_MIGRATION_DEPENDENCY_KINDS.filter(
  (kind) => kind !== 'saved-port-forward' && kind !== 'terminal-lease'
)

/**
 * The export-aware census: only state that references the target and that this manifest cannot
 * carry blocks. A census the store could not take is unverifiable, never an empty one.
 */
export function collectUntransferredDependentBlockers(
  store: Pick<Store, 'inspectQuirkydMigrationUntransferredDependencies'>,
  manifest: QuirkydMigrationManifest
): QuirkydMigrationBlocker[] {
  let census: ReturnType<Store['inspectQuirkydMigrationUntransferredDependencies']>
  try {
    census = store.inspectQuirkydMigrationUntransferredDependencies(manifest)
  } catch {
    return [
      {
        code: 'quirkyd_migration_dependency_unverifiable',
        category: 'live-or-unverifiable',
        sources: [...CENSUS_DEPENDENCY_KINDS]
      }
    ]
  }
  const dependencies = CENSUS_DEPENDENCY_KINDS.filter((kind) => census.counts[kind] > 0).map(
    (kind) => {
      const names = census.names?.[kind]?.slice(0, MAX_NAMES)
      return { kind, count: census.counts[kind], ...(names?.length ? { names } : {}) }
    }
  )
  return dependencies.length > 0
    ? [{ code: 'quirkyd_migration_dependent_state', category: 'client-owned-state', dependencies }]
    : []
}

/** Non-default host-owned fields of the host's partition, plus a local session pointed at the host. */
function workspaceSessionReferences(store: DependentStateStore, hostId: string): string[] {
  const references: string[] = []
  if (store.getWorkspaceSession().activeWorkspaceExecutionHostId === hostId) {
    references.push('active workspace')
  }
  if (!store.getWorkspaceSessionHostIds().some((id) => id === hostId)) {
    return references
  }
  const defaults: Record<string, unknown> = { ...getDefaultWorkspaceSession() }
  // A partition's global fields are copies of client-wide focus and history, not host state.
  const globalFields = new Set<string>(GLOBAL_WORKSPACE_SESSION_FIELDS)
  for (const [field, value] of Object.entries(store.getWorkspaceSession(hostId))) {
    if (globalFields.has(field)) {
      continue
    }
    if (!isEmptyValue(value) && JSON.stringify(value) !== JSON.stringify(defaults[field])) {
      references.push(field)
    }
  }
  return references
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) {
    return true
  }
  if (Array.isArray(value)) {
    return value.length === 0
  }
  return typeof value === 'object' && Object.keys(value).length === 0
}

export function dependentStateMessage(dependencies: QuirkydMigrationDependency[]): string {
  const parts = dependencies.map(
    ({ kind, count, names }) => `${kind} ×${count}${names?.length ? ` (${names.join(', ')})` : ''}`
  )
  return (
    'This SSH target is still referenced by saved Quirky state that this host’s Quirky server cannot take ' +
    `over yet: ${parts.join('; ')}. Remove it, or keep this host in direct SSH mode.`
  )
}
