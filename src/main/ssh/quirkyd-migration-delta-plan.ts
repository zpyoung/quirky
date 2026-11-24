/**
 * Planning a delta move for a host an older build changed after it was converted: what the move
 * adds, what the server keeps as it is, and the source view every later check of the move reads.
 *
 * The view subtracts what the host's earlier migrations already moved, re-exported as it is today,
 * so the delta manifest carries only rows and dormant state no earlier migration owns. Nothing
 * that overlaps an earlier migration is merged into the server.
 */
import type {
  QuirkydDeltaMovePreview,
  QuirkydDeltaMoveRow
} from '../../shared/quirkyd-managed-runtime'
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { isRetainedQuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { QuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { SshTarget } from '../../shared/ssh-types'
import type { Store } from '../persistence'
import { collectQuirkydMigrationSourceCatalog } from '../persistence/migrating-quirkyd-catalog/quirkyd-source-catalog'
import { listQuirkydMigrationCutoverChainForTarget } from './quirkyd-migration-cutover-journal'
import {
  createQuirkydMigrationManifest,
  quirkydMigrationCatalogIds,
  type QuirkydMigrationCatalogIds
} from './quirkyd-migration-manifest-export'
import type { QuirkydMigrationSnapshotSource } from './quirkyd-migration-snapshot-coordinator'
import { collectUntransferredDependentBlockers } from './targets/ssh-target-quirkyd-dependents'
import type { QuirkydMigrationPreflightStore } from './targets/ssh-target-quirkyd-preflight'

export type QuirkydDeltaSourceStore = QuirkydMigrationPreflightStore &
  QuirkydMigrationSnapshotSource

/** A delta move journaled but not yet committed and kept: the next move resumes it. */
export function unfinishedQuirkydDelta(
  chain: readonly QuirkydMigrationSourceCutover[]
): QuirkydMigrationSourceCutover | null {
  const head = chain.at(-1)
  return head?.supersedesMigrationId &&
    head.phase !== 'source-retired' &&
    !isRetainedQuirkydMigrationSourceCutover(head)
    ? head
    : null
}

/** The committed migrations a delta extends, oldest first, excluding any delta in flight. */
export function committedQuirkydMigrationChain(
  chain: readonly QuirkydMigrationSourceCutover[]
): QuirkydMigrationSourceCutover[] {
  return (unfinishedQuirkydDelta(chain) ? chain.slice(0, -1) : chain).filter(
    (cutover) => cutover.phase === 'destination-committed' || cutover.phase === 'source-retired'
  )
}

/** The real store, except its catalog and dormant state: those come from the delta view. */
export function quirkydDeltaSourceStore(
  store: Store,
  target: SshTarget,
  moved: readonly QuirkydMigrationSourceCutover[],
  /** A journaled delta's manifest: an older build may have exported server groups in it. */
  journaled?: QuirkydMigrationManifest
): QuirkydDeltaSourceStore {
  const ids = quirkydMigrationCatalogIds(moved.map((cutover) => cutover.manifest.payload))
  // A linked project or group is the server's already, so a delta never moves it either.
  const linked = moved.flatMap((cutover) => cutover.linkedRepositoryIds ?? [])
  const linkedGroups = moved.flatMap((cutover) => cutover.linkedProjectGroupIds ?? [])
  const linkedFolders = moved.flatMap((cutover) => cutover.linkedFolderWorkspaceIds ?? [])
  // The server's record of a group it got from a move or link wins: a new row in it references the
  // server's group, since this desktop's retained copy may be stale and would conflict.
  const serverGroups = new Set([...ids.projectGroupIds, ...linkedGroups])
  const exported = new Set(journaled?.payload.projectGroups.map((group) => group.id))
  return quirkydSourceStoreWithout(
    store,
    target,
    {
      ...ids,
      repositoryIds: new Set([...ids.repositoryIds, ...linked]),
      folderWorkspaceIds: new Set([...ids.folderWorkspaceIds, ...linkedFolders]),
      projectGroupIds: serverGroups
    },
    moved.at(-1)?.destinationEnvironmentId,
    new Set([...serverGroups].filter((id) => !exported.has(id)))
  )
}

/** The source minus rows the server already owns, and the dormant state that references them. */
export function quirkydSourceStoreWithout(
  store: Store,
  target: SshTarget,
  owned: QuirkydMigrationCatalogIds,
  destinationEnvironmentId: string | undefined,
  /** Groups the server's record wins for: never exported, even while a moving row sits in one. */
  serverGroupIds: ReadonlySet<string> = new Set()
): QuirkydDeltaSourceStore {
  const ownedNow = createQuirkydMigrationManifest(store, target, {
    destinationEnvironmentId,
    onlyCatalog: owned
  })
  const view = store.createQuirkydMigrationDeltaView(ownedNow)
  return {
    ...view,
    serverOwnedProjectGroupIds: serverGroupIds,
    getSshTarget: (id) => store.getSshTarget(id),
    getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id),
    readQuirkydMigrationSourceSnapshotChunk: (...args) =>
      store.readQuirkydMigrationSourceSnapshotChunk(...args)
  }
}

export type QuirkydDeltaMovePlan = QuirkydDeltaMovePreview & {
  manifest: QuirkydMigrationManifest
  moved: QuirkydMigrationSourceCutover[]
  /** The retained migration a new delta supersedes. */
  head: QuirkydMigrationSourceCutover
  /** An interrupted delta this move resumes from its journaled manifest instead of a new one. */
  resumes: QuirkydMigrationSourceCutover | null
  source: QuirkydDeltaSourceStore
}

/** Throws when the host is not a converted host an older build changed. */
export function planQuirkydDeltaMove(
  userDataPath: string,
  store: Store,
  target: SshTarget,
  options: { migrationId?: string; now?: () => Date } = {}
): QuirkydDeltaMovePlan {
  const environmentId = target.quirkydFence?.environmentId
  if (!environmentId || !target.quirkydFence?.sourceChangedAt) {
    throw new Error('quirkyd_delta_not_changed')
  }
  const chain = listQuirkydMigrationCutoverChainForTarget(userDataPath, target.id)
  const resumes = unfinishedQuirkydDelta(chain)
  const moved = committedQuirkydMigrationChain(chain)
  const head = chain.at(resumes ? -2 : -1)
  if (
    !head ||
    !isRetainedQuirkydMigrationSourceCutover(head) ||
    moved.at(-1)?.migrationId !== head.migrationId
  ) {
    throw new Error('quirkyd_delta_no_retained_migration')
  }
  const source = quirkydDeltaSourceStore(store, target, moved, resumes?.manifest)
  const manifest =
    resumes?.manifest ??
    createQuirkydMigrationManifest(source, target, {
      migrationId: options.migrationId,
      now: options.now,
      destinationEnvironmentId: environmentId
    })
  const current = collectQuirkydMigrationSourceCatalog(store, target)
  return {
    sshTargetId: target.id,
    environmentId,
    added: catalogRows(manifest.payload),
    notReflected: notReflected(
      current,
      moved.map((cutover) => cutover.manifest.payload)
    ),
    blockers: collectUntransferredDependentBlockers(source, manifest),
    manifest,
    moved,
    head,
    resumes,
    source
  }
}

function catalogRows(catalog: QuirkydMigrationCatalogPayload): QuirkydDeltaMoveRow[] {
  return [
    ...catalog.repositories.map((row) => ({
      kind: 'repository' as const,
      id: row.id,
      label: row.displayName
    })),
    ...catalog.folderWorkspaces.map((row) => ({
      kind: 'folder-workspace' as const,
      id: row.id,
      label: row.name
    })),
    ...catalog.projectGroups.map((row) => ({
      kind: 'project-group' as const,
      id: row.id,
      label: row.name
    }))
  ]
}

/** Rows earlier migrations moved that an older build has since changed or removed. */
function notReflected(
  current: QuirkydMigrationCatalogPayload,
  movedPayloads: readonly QuirkydMigrationCatalogPayload[]
): QuirkydDeltaMovePreview['notReflected'] {
  const latestMoved = new Map<string, { row: QuirkydDeltaMoveRow; identity: string }>()
  for (const payload of movedPayloads) {
    for (const row of catalogRows(payload)) {
      latestMoved.set(`${row.kind}:${row.id}`, { row, identity: identityOf(payload, row) })
    }
  }
  const currentByKey = new Map(
    catalogRows(current).map((row) => [`${row.kind}:${row.id}`, identityOf(current, row)])
  )
  const edited: QuirkydDeltaMoveRow[] = []
  const removed: QuirkydDeltaMoveRow[] = []
  for (const [key, moved] of latestMoved) {
    const identity = currentByKey.get(key)
    if (identity === undefined) {
      removed.push(moved.row)
    } else if (identity !== moved.identity) {
      edited.push(moved.row)
    }
  }
  return { edited, removed }
}

function identityOf(catalog: QuirkydMigrationCatalogPayload, row: QuirkydDeltaMoveRow): string {
  switch (row.kind) {
    case 'repository': {
      const repo = catalog.repositories.find((entry) => entry.id === row.id)
      return `${repo?.path}\0${repo?.displayName}`
    }
    case 'folder-workspace': {
      const folder = catalog.folderWorkspaces.find((entry) => entry.id === row.id)
      return `${folder?.folderPath}\0${folder?.name}`
    }
    case 'project-group':
      return catalog.projectGroups.find((entry) => entry.id === row.id)?.name ?? ''
  }
}
