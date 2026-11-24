import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  readTerminalScrollbackStoredBytesSync,
  writeTerminalScrollbackSnapshotSync
} from '../../terminal-scrollback-snapshots'
import { deleteUnreferencedQuirkydMigrationScrollback } from './quirkyd-source-scrollback-cleanup'
import {
  findSnapshotBytes,
  matchesQuirkydMigrationSnapshotBytes
} from './quirkyd-source-scrollback-state'

type RetentionRuntime = Pick<
  StoreRuntimeState,
  'state' | 'terminalScrollbackSnapshotStorage' | 'retainedScrollbackRefsByMigrationId'
>

/**
 * Holds every snapshot an unfinished migration's manifest names, from the journaled export until
 * the destination commits or the migration is abandoned, so a tab closed meanwhile still sends
 * its bytes on any retry. An inline buffer has no file, so its bytes are written to its ref first.
 * Released refs no session names are deleted.
 */
export function syncQuirkydMigrationScrollbackRetention(
  runtime: RetentionRuntime,
  pending: readonly QuirkydMigrationManifest[]
): void {
  const held = runtime.retainedScrollbackRefsByMigrationId
  const pendingIds = new Set(pending.map((manifest) => manifest.migrationId))
  const released = [...held].filter(([migrationId]) => !pendingIds.has(migrationId))
  for (const manifest of pending) {
    if (held.has(manifest.migrationId)) {
      continue
    }
    const snapshots = manifest.payload.dormantState?.terminalScrollbackSnapshots ?? []
    for (const descriptor of snapshots) {
      persistInlineSnapshot(runtime, descriptor)
    }
    held.set(manifest.migrationId, new Set(snapshots.map((snapshot) => snapshot.ref)))
  }
  for (const [migrationId] of released) {
    held.delete(migrationId)
  }
  deleteUnreferencedQuirkydMigrationScrollback(
    runtime,
    released.flatMap(([, refs]) => [...refs])
  )
}

function persistInlineSnapshot(
  runtime: RetentionRuntime,
  descriptor: NonNullable<
    NonNullable<QuirkydMigrationManifest['payload']['dormantState']>['terminalScrollbackSnapshots']
  >[number]
): void {
  const storage = runtime.terminalScrollbackSnapshotStorage
  // A newer inline copy (local-only park) can supersede a file under the same ref; keep what was signed.
  const stored = readTerminalScrollbackStoredBytesSync(descriptor.ref, storage)
  if (matchesQuirkydMigrationSnapshotBytes(stored, descriptor)) {
    return
  }
  const bytes = findSnapshotBytes(runtime.state, descriptor, storage)
  if (bytes) {
    writeTerminalScrollbackSnapshotSync({
      tabId: descriptor.tabId,
      leafId: descriptor.leafId,
      buffer: bytes.toString('utf8'),
      storage
    })
  }
}
