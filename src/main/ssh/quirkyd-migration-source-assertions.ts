/** Checks run before every stage and commit: the fenced source is still what the journal says. */
import { createHash } from 'node:crypto'
import {
  serializeQuirkydMigrationValue,
  type QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { QuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import { createQuirkydMigrationManifest } from './quirkyd-migration-manifest-export'
import { resolveQuirkydMigrationFence } from './quirkyd-migration-source-fence'
import { confirmQuirkydMigrationTerminalsUnderFence } from './quirkyd-migration-terminal-gate'
import { collectUntransferredDependentBlockers } from './targets/ssh-target-quirkyd-dependents'
import type { QuirkydMigrationPreflightStore } from './targets/ssh-target-quirkyd-preflight'

export function assertQuirkydMigrationSourceUnchanged(
  context: { userDataPath: string; store: QuirkydMigrationPreflightStore },
  cutover: QuirkydMigrationSourceCutover
): void {
  const target = context.store.getSshTarget(cutover.sshTargetId)
  const fence = target ? resolveQuirkydMigrationFence(context.userDataPath, target) : null
  if (!target || fence?.state !== 'fenced' || fence.cutover.migrationId !== cutover.migrationId) {
    throw new Error('quirkyd_migration_source_fence_lost')
  }
  // Same id, time and destination as the journaled export: any difference is a source change.
  const current = createQuirkydMigrationManifest(context.store, target, {
    migrationId: cutover.migrationId,
    destinationEnvironmentId: cutover.destinationEnvironmentId,
    now: () => new Date(cutover.manifest.createdAt)
  })
  if (frozenSourceDigest(current) !== frozenSourceDigest(cutover.manifest)) {
    throw new Error('quirkyd_migration_source_changed')
  }
  if (collectUntransferredDependentBlockers(context.store, cutover.manifest).length > 0) {
    throw new Error('quirkyd_migration_source_dependencies_present')
  }
  const terminals = confirmQuirkydMigrationTerminalsUnderFence(
    context.store,
    target.id,
    cutover.bridgedPtyIds
      ? {
          verdict: 'bridged',
          relayVerdict: 'unverifiable',
          bridgedPtyIds: cutover.bridgedPtyIds,
          hostTerminals: 0
        }
      : { verdict: 'exited', provenPtyIds: cutover.provenPtyIds }
  )
  if (terminals.verdict === 'live' || terminals.verdict === 'unverifiable') {
    throw new Error(`quirkyd_migration_source_terminals_${terminals.verdict}`)
  }
}

/**
 * The manifest minus what the UI rewrites as the user works (tabs, focus, routing): the server
 * gets those as journaled, and a tab reorder mid-conversion must not fail the move.
 */
function frozenSourceDigest(manifest: QuirkydMigrationManifest): string {
  const { manifestSha256: _digest, payload, ...rest } = manifest
  const {
    version: _version,
    workspaceSession: _session,
    clientState: _client,
    // Retained for the transfer, so a tab closed mid-move still sends its journaled bytes.
    terminalScrollbackSnapshots: _snapshots,
    ...dormant
  } = payload.dormantState ?? {}
  // Export omits an empty dormant payload, so UI state alone can make one appear.
  const empty = Object.values(dormant).every(
    (value) => value === undefined || (Array.isArray(value) && value.length === 0)
  )
  const frozen = { ...rest, payload: { ...payload, dormantState: empty ? undefined : dormant } }
  return createHash('sha256').update(serializeQuirkydMigrationValue(frozen)).digest('hex')
}
