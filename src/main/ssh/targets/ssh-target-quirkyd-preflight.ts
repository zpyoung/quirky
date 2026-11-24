/**
 * Can this relay-hosted SSH target's state be exported to a managed quirkyd?
 *
 * Unlike claiming an empty target, export carries the target's repositories, folder
 * workspaces and the dormant state the manifest can represent, so those drain rather than block.
 * What blocks is what cannot move: another owner, live terminal leases, and dependent state the
 * manifest cannot carry. Read-only: building the manifest here exports nothing.
 */
import { isLiveSshPtyLease } from '../../../shared/ssh-types'
import type { Store } from '../../persistence'
import type {
  QuirkydMigrationBlocker,
  QuirkydMigrationPreflight
} from '../../../shared/quirkyd-migration/quirkyd-migration-preflight'
import {
  createQuirkydMigrationManifest,
  type QuirkydMigrationExportStore
} from '../quirkyd-migration-manifest-export'
import {
  collectTargetCatalogBlockers,
  resolveQuirkydPreflightTarget
} from './ssh-target-quirkyd-claims'
import { collectUntransferredDependentBlockers } from './ssh-target-quirkyd-dependents'

export type QuirkydMigrationPreflightStore = QuirkydMigrationExportStore &
  Pick<
    Store,
    'getSshTarget' | 'getSshRemotePtyLeases' | 'inspectQuirkydMigrationUntransferredDependencies'
  >

/** `owner` passes the environment's own fence only when its migration journal is on disk. */
export function preflightQuirkydMigrationExport(
  store: QuirkydMigrationPreflightStore,
  targetId: string,
  owner?: { environmentId: string; recorded: boolean },
  /** COMPAT(legacy-relay-bridge): leases a bridged proof left running for the bridge. */
  bridgedPtyIds: readonly string[] = []
): QuirkydMigrationPreflight {
  const resolved = resolveQuirkydPreflightTarget(store, targetId, owner)
  if ('result' in resolved) {
    return resolved.result
  }
  const { target } = resolved
  const blockers: QuirkydMigrationBlocker[] = [...collectTargetCatalogBlockers(store, target)]
  const terminalLeases = store
    .getSshRemotePtyLeases(targetId)
    .filter((lease) => isLiveSshPtyLease(lease) && !bridgedPtyIds.includes(lease.ptyId))
    .map(({ ptyId, worktreeId, tabId, leafId, state, updatedAt }) => ({
      ptyId,
      worktreeId,
      tabId,
      leafId,
      state,
      updatedAt
    }))
  if (terminalLeases.length > 0) {
    // A relay PTY cannot move to quirkyd; its work must finish first.
    blockers.push({
      code: 'quirkyd_migration_direct_ssh_terminal_leases',
      category: 'live-or-unverifiable',
      terminalLeases
    })
  }
  blockers.push(
    ...collectUntransferredDependentBlockers(store, createQuirkydMigrationManifest(store, target))
  )
  return {
    targetId,
    targetLabel: target.label,
    claimable: !blockers.some(isBlockingQuirkydMigrationBlocker),
    blockers
  }
}

/** Whether a confirmed "Move anyway" would export: what it can't leave (desktop drafts) still refuses. */
export function leaveBehindClearsQuirkydMigrationBlockers(
  store: QuirkydMigrationPreflightStore & Pick<Store, 'createQuirkydMigrationLeaveBehindView'>,
  targetId: string
): boolean {
  const view = store.createQuirkydMigrationLeaveBehindView(targetId)
  return preflightQuirkydMigrationExport(
    {
      ...view,
      getSshTarget: (id) => store.getSshTarget(id),
      getSshRemotePtyLeases: (id) => store.getSshRemotePtyLeases(id)
    },
    targetId
  ).claimable
}

/** Only saved state blocks: a confirmed "Move anyway" may leave it on this desktop. */
export function onlyLeavableQuirkydMigrationBlockers(
  blockers: readonly QuirkydMigrationBlocker[]
): boolean {
  const blocking = blockers.filter(isBlockingQuirkydMigrationBlocker)
  return (
    blocking.length > 0 &&
    blocking.every((blocker) => blocker.code === 'quirkyd_migration_dependent_state')
  )
}

// Exported catalog rows and saved port forwards (which stay with the source) do not block.
export function isBlockingQuirkydMigrationBlocker(blocker: QuirkydMigrationBlocker): boolean {
  return (
    blocker.category !== 'drainable-static-state' &&
    blocker.code !== 'quirkyd_migration_saved_port_forwards'
  )
}
