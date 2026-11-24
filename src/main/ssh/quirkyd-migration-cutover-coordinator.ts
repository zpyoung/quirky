/**
 * Staging, committing and aborting a dormant migration on its destination quirkyd.
 *
 * The source stays authoritative until the destination proves a commit: before every stage and
 * commit the fenced source must still export the journaled manifest and carry no state the
 * manifest cannot. A lost answer is never read as success or as absence; the destination's
 * catalog state is re-read, and only that observation moves the journal, which is on disk before
 * anything is returned. A committed destination is never released.
 */
import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type {
  QuirkydMigrationSnapshotChunkRequest,
  QuirkydMigrationSnapshotChunkResult
} from '../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import type {
  QuirkydMigrationSourceCutover,
  QuirkydMigrationSourceCutoverPhase
} from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import { resolveDurableQuirkydCatalogMutation } from './quirkyd-catalog-durable-mutation'
import { QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED } from './quirkyd-migration-catalog-client'
import { quirkydMigrationRequestFits } from './quirkyd-migration-manifest-export'
import {
  listQuirkydMigrationSourceCutovers,
  writeQuirkydMigrationSourceCutover
} from './quirkyd-migration-cutover-journal'
import type { QuirkydMigrationSourceCutoverPort } from './quirkyd-migration-source'
import {
  transferQuirkydMigrationSnapshots,
  type QuirkydMigrationSnapshotSource
} from './quirkyd-migration-snapshot-coordinator'
import type { QuirkydMigrationPreflightStore } from './targets/ssh-target-quirkyd-preflight'
import { sshRelayMigrationCutoverPort } from './quirkyd-migration-ssh-relay-source'
import type { SshTargetQuirkydClaims } from './targets/ssh-target-quirkyd-claims'

/** The destination's catalog operations, served by the T6-9 quirkyd.migration.* client. */
export type QuirkydMigrationDestinationCatalog = {
  readState: (manifest: QuirkydMigrationManifest) => Promise<QuirkydMigrationCatalogState>
  stage: (manifest: QuirkydMigrationManifest) => Promise<QuirkydMigrationCatalogState>
  commit: (manifest: QuirkydMigrationManifest) => Promise<QuirkydMigrationCatalogState>
  abort: (manifest: QuirkydMigrationManifest) => Promise<QuirkydMigrationCatalogAbortResult>
  /** Sends only the manifest's identity; for a journal whose manifest no request can carry. */
  abortByReference: (
    manifest: QuirkydMigrationManifest
  ) => Promise<QuirkydMigrationCatalogReferenceAbortResult>
  stageChunk: (
    request: QuirkydMigrationSnapshotChunkRequest
  ) => Promise<QuirkydMigrationSnapshotChunkResult>
}

export type QuirkydMigrationCutoverContext = {
  userDataPath: string
  store: QuirkydMigrationPreflightStore & QuirkydMigrationSnapshotSource
  claims: SshTargetQuirkydClaims
  destination: QuirkydMigrationDestinationCatalog
  /** Rebuilt for every check when `store` is a copy that would never see a later edit. */
  freshSource?: () => QuirkydMigrationPreflightStore
  /** The fenced source; defaults to the relay-era SSH target the journal names. */
  source?: QuirkydMigrationSourceCutoverPort
  now?: () => Date
}

function cutoverSource(context: QuirkydMigrationCutoverContext): QuirkydMigrationSourceCutoverPort {
  return context.source ?? sshRelayMigrationCutoverPort(context)
}

export async function stageQuirkydMigrationDestination(
  context: QuirkydMigrationCutoverContext,
  migrationId: string
): Promise<QuirkydMigrationSourceCutover> {
  let cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return cutover
  }
  assertSourceUnchanged(context, cutover)
  const { destination } = context
  const read = await destination.readState(cutover.manifest)
  const state =
    read.state === 'committed'
      ? await confirmDurableCommit(destination, cutover.manifest)
      : await resolveDurableQuirkydCatalogMutation(
          () => destination.stage(cutover.manifest),
          () => destination.readState(cutover.manifest),
          (observed) => observed.state !== 'absent'
        )
  cutover = recordObservedState(context, cutover, state)
  if (state.state === 'staged') {
    await transferQuirkydMigrationSnapshots({
      source: context.store,
      manifest: cutover.manifest,
      state,
      destination: { readState: destination.readState, stageChunk: destination.stageChunk }
    })
  }
  return cutover
}

export async function commitQuirkydMigrationDestination(
  context: QuirkydMigrationCutoverContext,
  migrationId: string
): Promise<QuirkydMigrationSourceCutover> {
  const staged = await stageQuirkydMigrationDestination(context, migrationId)
  if (staged.phase !== 'destination-staged') {
    return staged
  }
  assertSourceUnchanged(context, staged)
  const { destination } = context
  // Why re-read: a lost commit reply may hide a commit that landed; the read decides.
  const state = await resolveDurableQuirkydCatalogMutation(
    () => destination.commit(staged.manifest),
    () => destination.readState(staged.manifest),
    (observed) => observed.state === 'committed'
  )
  if (state.state !== 'committed') {
    throw new Error(`quirkyd_migration_commit_not_committed:${state.state}`)
  }
  return recordObservedState(context, staged, state)
}

export type QuirkydMigrationAbortResult =
  | { outcome: 'released'; evidence: 'catalog-absent' | 'destination-unsupported' }
  | { outcome: 'refused'; code: string; reason: string }

/**
 * Releases the source only on proof the destination holds nothing of this migration. `release`
 * defaults to dropping the fence and journal; a delta move keeps the fence instead.
 */
export async function abortQuirkydMigrationCutover(
  context: QuirkydMigrationCutoverContext,
  migrationId: string,
  release: (cutover: QuirkydMigrationSourceCutover) => Promise<void> = (cutover) =>
    cutoverSource(context).releaseFence(cutover)
): Promise<QuirkydMigrationAbortResult> {
  const cutover = requireCutover(context.userDataPath, migrationId)
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    return committedRefusal()
  }
  const { destination } = context
  // A journal from before #30836 may hold a manifest no request can carry; only abort could not.
  if (!quirkydMigrationRequestFits({ manifest: cutover.manifest })) {
    const aborted = await destination.abortByReference(cutover.manifest)
    if (aborted.state === 'committed') {
      return committedRefusal()
    }
    await release(cutover)
    return { outcome: 'released', evidence: 'catalog-absent' }
  }
  let state: QuirkydMigrationCatalogState
  try {
    state = await destination.readState(cutover.manifest)
  } catch (error) {
    // Unsupported means nothing could have been staged, but only if nothing ever was.
    if (isDestinationUnsupported(error) && cutover.phase === 'source-fenced') {
      await release(cutover)
      return { outcome: 'released', evidence: 'destination-unsupported' }
    }
    throw error
  }
  if (state.state !== 'committed') {
    state = await abortWithRecovery(destination, cutover.manifest)
  }
  if (state.state === 'committed') {
    recordObservedState(context, cutover, await confirmDurableCommit(destination, cutover.manifest))
    return committedRefusal()
  }
  if (state.state !== 'absent') {
    throw new Error(`quirkyd_migration_abort_not_absent:${state.state}`)
  }
  await release(cutover)
  return { outcome: 'released', evidence: 'catalog-absent' }
}

/**
 * A committed read may come from memory the server never flushed; only commit()'s acknowledgement,
 * which flushes before it answers, may move the journal to committed.
 */
async function confirmDurableCommit(
  destination: QuirkydMigrationDestinationCatalog,
  manifest: QuirkydMigrationManifest
): Promise<QuirkydMigrationCatalogState> {
  const state = await destination.commit(manifest)
  if (state.state !== 'committed') {
    throw new Error(`quirkyd_migration_commit_not_committed:${state.state}`)
  }
  return state
}

function assertSourceUnchanged(
  context: QuirkydMigrationCutoverContext,
  cutover: QuirkydMigrationSourceCutover
): void {
  cutoverSource(context).verifyFence(cutover)
}

/** Moves the journal to what the destination reported; durable before it returns. */
function recordObservedState(
  context: QuirkydMigrationCutoverContext,
  cutover: QuirkydMigrationSourceCutover,
  state: QuirkydMigrationCatalogState
): QuirkydMigrationSourceCutover {
  if (state.state === 'absent') {
    throw new Error('quirkyd_migration_destination_catalog_absent')
  }
  if (
    state.migrationId !== cutover.migrationId ||
    state.manifestSha256 !== cutover.manifestSha256
  ) {
    throw new Error('quirkyd_migration_destination_state_mismatch')
  }
  if (
    state.state === 'committed' &&
    (state.receipt.migrationId !== cutover.migrationId ||
      state.receipt.manifestSha256 !== cutover.manifestSha256)
  ) {
    throw new Error('quirkyd_migration_destination_receipt_mismatch')
  }
  const phase: QuirkydMigrationSourceCutoverPhase =
    state.state === 'committed' ? 'destination-committed' : 'destination-staged'
  if (phase === cutover.phase) {
    return cutover
  }
  if (cutover.phase === 'destination-committed' || cutover.phase === 'source-retired') {
    // Why: a journal never moves back from a proven commit.
    return cutover
  }
  const next: QuirkydMigrationSourceCutover = {
    ...cutover,
    phase,
    updatedAt: (context.now ?? (() => new Date()))().toISOString()
  }
  writeQuirkydMigrationSourceCutover(context.userDataPath, next)
  return next
}

async function abortWithRecovery(
  destination: QuirkydMigrationDestinationCatalog,
  manifest: QuirkydMigrationManifest
): Promise<QuirkydMigrationCatalogState> {
  try {
    return await destination.abort(manifest)
  } catch (abortError) {
    try {
      const observed = await destination.readState(manifest)
      if (observed.state === 'committed') {
        return observed
      }
      if (observed.state === 'absent') {
        // An absent read may predate the flush; a repeated abort proves it durable.
        return await destination.abort(manifest)
      }
    } catch {
      // Still unverifiable: keep the first failure and the fence.
    }
    throw abortError
  }
}

function requireCutover(userDataPath: string, migrationId: string): QuirkydMigrationSourceCutover {
  const cutover = listQuirkydMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover) {
    throw new Error('quirkyd_migration_source_cutover_not_found')
  }
  return cutover
}

function committedRefusal(): QuirkydMigrationAbortResult {
  return {
    outcome: 'refused',
    code: 'quirkyd_migration_committed_source_cannot_be_released',
    reason: 'This host’s Quirky server already holds this migration; it can only move forward.'
  }
}

function isDestinationUnsupported(error: unknown): boolean {
  return error instanceof Error && error.message === QUIRKYD_MIGRATION_DESTINATION_UNSUPPORTED
}
