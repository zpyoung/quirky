/**
 * The Store's read-only view of a relay-hosted SSH target, for migrating it to a managed quirkyd.
 *
 * Everything here reads the profile-state store and returns copies; nothing writes or deletes
 * source rows, and nothing else deletes them after an import either.
 */
import {
  QUIRKYD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
  type QuirkydMigrationTerminalScrollbackSnapshot
} from '../../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationDormantStatePayload,
  QuirkydMigrationManifest,
  QuirkydMigrationManifestSource
} from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import { assertQuirkydMigrationManifestDigest } from '../../quirkyd/quirkyd-migration-manifest-digest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  collectQuirkydMigrationUntransferredDependencyCensus,
  type QuirkydMigrationSourceDependencyCensus
} from './quirkyd-source-dependency-census'
import { collectQuirkydMigrationSourceDormantState } from './quirkyd-source-dormant-state'
import { readQuirkydMigrationSourceScrollbackChunk } from './quirkyd-source-scrollback-state'
import {
  createQuirkydMigrationDeltaView,
  type QuirkydMigrationDeltaView
} from './quirkyd-source-delta-view'
import { syncQuirkydMigrationScrollbackRetention } from './quirkyd-source-scrollback-retention'
import { createQuirkydMigrationLeaveBehindView } from './quirkyd-source-leave-behind-view'
import {
  collectQuirkydMigrationSourceDrafts,
  type QuirkydMigrationSourceDrafts
} from './quirkyd-source-draft-rename'

type QuirkydSourceExportRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

const quirkydSourceExportContext = Symbol('QuirkydSourceExportPersistence')

export class QuirkydSourceExportPersistence {
  readonly [quirkydSourceExportContext]: QuirkydSourceExportRuntime

  constructor(runtime: QuirkydSourceExportRuntime) {
    this[quirkydSourceExportContext] = runtime
  }

  collectQuirkydMigrationSourceDormantState(
    source: QuirkydMigrationManifestSource,
    catalog: QuirkydMigrationCatalogPayload,
    destinationEnvironmentId?: string
  ): QuirkydMigrationDormantStatePayload {
    const runtime = this[quirkydSourceExportContext]
    return collectQuirkydMigrationSourceDormantState(
      runtime.state,
      source,
      catalog,
      runtime.terminalScrollbackSnapshotStorage,
      destinationEnvironmentId
    ).payload
  }

  /** This desktop's drafts for what `manifest` moves, keyed as the server names the worktrees. */
  collectQuirkydMigrationSourceDrafts(
    manifest: QuirkydMigrationManifest
  ): QuirkydMigrationSourceDrafts {
    return collectQuirkydMigrationSourceDrafts(this[quirkydSourceExportContext].state, manifest)
  }

  /** A copy of the source with `moved` subtracted from it, for a delta move. */
  createQuirkydMigrationDeltaView(moved: QuirkydMigrationManifest): QuirkydMigrationDeltaView {
    return createQuirkydMigrationDeltaView(this[quirkydSourceExportContext], moved)
  }

  /** The source as a confirmed "Move anyway" would export it, consent unrecorded. */
  createQuirkydMigrationLeaveBehindView(targetId: string): QuirkydMigrationDeltaView {
    return createQuirkydMigrationLeaveBehindView(this[quirkydSourceExportContext], targetId)
  }

  /** What still references the target that this manifest cannot carry. */
  inspectQuirkydMigrationUntransferredDependencies(
    manifest: QuirkydMigrationManifest
  ): QuirkydMigrationSourceDependencyCensus {
    const runtime = this[quirkydSourceExportContext]
    return collectQuirkydMigrationUntransferredDependencyCensus(
      runtime.state,
      manifest,
      runtime.terminalScrollbackSnapshotStorage
    )
  }

  /** Holds the snapshots unfinished migrations name; see syncQuirkydMigrationScrollbackRetention. */
  syncQuirkydMigrationScrollbackRetention(pending: readonly QuirkydMigrationManifest[]): void {
    syncQuirkydMigrationScrollbackRetention(this[quirkydSourceExportContext], pending)
  }

  /**
   * One bounded chunk of a scrollback snapshot the signed manifest names. The bytes are checked
   * against the manifest's length and digest, so a buffer that changed since export is refused.
   */
  readQuirkydMigrationSourceSnapshotChunk(
    manifest: QuirkydMigrationManifest,
    ref: string,
    offset: number
  ): { bytesBase64: string; totalBytes: number; eof: boolean } {
    assertQuirkydMigrationManifestDigest(manifest)
    const descriptor: QuirkydMigrationTerminalScrollbackSnapshot | undefined =
      manifest.payload.dormantState?.terminalScrollbackSnapshots?.find((entry) => entry.ref === ref)
    if (!descriptor) {
      throw new Error('quirkyd_migration_source_snapshot_unknown')
    }
    const runtime = this[quirkydSourceExportContext]
    return readQuirkydMigrationSourceScrollbackChunk({
      state: runtime.state,
      descriptor,
      retained: [...runtime.retainedScrollbackRefsByMigrationId.values()].some((refs) =>
        refs.has(ref)
      ),
      offset,
      length: QUIRKYD_MIGRATION_SCROLLBACK_CHUNK_BYTES,
      storage: runtime.terminalScrollbackSnapshotStorage
    })
  }
}
