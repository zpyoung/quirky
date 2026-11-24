/**
 * After commit: a migration keeps its source rows, so a downgraded build still sees the host and
 * its projects and can reach them over its own relay. New builds hide those rows and serve the host
 * from the server. They are never deleted automatically.
 */
import { toRuntimeExecutionHostId } from '../../shared/execution-host'
import type { QuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import type { Store } from '../persistence'
import { withRenamedQuirkydMigrationDrafts } from '../persistence/migrating-quirkyd-catalog/quirkyd-source-draft-rename'
import {
  listQuirkydMigrationSourceCutovers,
  writeQuirkydMigrationSourceCutover
} from './quirkyd-migration-cutover-journal'

export type QuirkydMigrationDraftRenameStore = Pick<
  Store,
  | 'collectQuirkydMigrationSourceDrafts'
  | 'getWorkspaceSession'
  | 'runDurableMutation'
  | 'setWorkspaceSession'
>

// One retain per migration at a time: a second caller waits for the first and then finds it done.
const retainsInFlight = new Map<string, Promise<QuirkydMigrationSourceCutover>>()

/**
 * Marks a committed migration as finished for this build while its source rows stay. Its unsaved
 * drafts are renamed to the server first, durably, so the retained mark proves they were.
 */
export function retainQuirkydMigrationSource(
  userDataPath: string,
  migrationId: string,
  store: QuirkydMigrationDraftRenameStore,
  now: () => Date = () => new Date()
): Promise<QuirkydMigrationSourceCutover> {
  const pending = retainsInFlight.get(migrationId)
  if (pending) {
    return pending
  }
  const retain = retainOnce(userDataPath, migrationId, store, now).finally(() =>
    retainsInFlight.delete(migrationId)
  )
  retainsInFlight.set(migrationId, retain)
  return retain
}

async function retainOnce(
  userDataPath: string,
  migrationId: string,
  store: QuirkydMigrationDraftRenameStore,
  now: () => Date
): Promise<QuirkydMigrationSourceCutover> {
  const cutover = readCommittedCutover(userDataPath, migrationId)
  if (cutover.sourceRetainedAt) {
    return cutover
  }
  await store.runDurableMutation(() => {
    const renamed = renamedDestinationSession(store, cutover)
    if (!renamed) {
      // A startup rename may still be only in memory; the retained mark must not outrun it.
      return { value: undefined, persist: 'if-dirty' }
    }
    // No rollback: the renamed rows are correct either way, and a retry adds nothing twice.
    writeDestinationSession(store, cutover, renamed.next)
    return { value: undefined }
  })
  // Why no baseline here: the source may have changed since the commit (a crash, then an older
  // build); only the fence's pre-commit baseline proves what the server holds.
  const retained = {
    ...readCommittedCutover(userDataPath, migrationId),
    sourceRetainedAt: now().toISOString()
  }
  writeQuirkydMigrationSourceCutover(userDataPath, retained)
  return retained
}

/**
 * At startup, for a commit whose retained mark a crash cut off: its drafts are renamed before any
 * window reads its sessions, since a renderer that booted without them would overwrite them; then
 * the move is retained, so the rename never runs again and a draft closed later stays closed.
 */
export function retainUnretainedQuirkydMigrationSources(
  userDataPath: string,
  store: QuirkydMigrationDraftRenameStore & Pick<Store, 'getSshTarget'>
): Promise<void> {
  const migrationIds: string[] = []
  try {
    for (const cutover of listQuirkydMigrationSourceCutovers(userDataPath)) {
      // Journals are shared across profiles; only the profile that owns the host can rename.
      const target = store.getSshTarget(cutover.sshTargetId)
      if (
        cutover.phase !== 'destination-committed' ||
        cutover.sourceRetainedAt ||
        target?.generation !== cutover.sshTargetGeneration
      ) {
        continue
      }
      const renamed = renamedDestinationSession(store, cutover)
      if (renamed) {
        writeDestinationSession(store, cutover, renamed.next)
      }
      migrationIds.push(cutover.migrationId)
    }
  } catch (error) {
    // The connect's retain renames them instead; startup must not fail on an unreadable journal.
    console.warn('[ssh] Could not rename committed migrations’ unsaved drafts:', error)
  }
  return Promise.all(
    migrationIds.map((migrationId) =>
      retainQuirkydMigrationSource(userDataPath, migrationId, store).catch((error: unknown) => {
        console.warn('[ssh] Could not mark a finished migration retained:', error)
      })
    )
  ).then(() => undefined)
}

function readCommittedCutover(userDataPath: string, migrationId: string) {
  const cutover = listQuirkydMigrationSourceCutovers(userDataPath).find(
    (entry) => entry.migrationId === migrationId
  )
  if (!cutover || cutover.phase !== 'destination-committed') {
    throw new Error('quirkyd_migration_retain_before_commit')
  }
  return cutover
}

/** Only files the server partition lacks, so the retain after a startup rename adds nothing. */
function renamedDestinationSession(
  store: Pick<
    QuirkydMigrationDraftRenameStore,
    'collectQuirkydMigrationSourceDrafts' | 'getWorkspaceSession'
  >,
  cutover: QuirkydMigrationSourceCutover
): { next: WorkspaceSessionState } | null {
  const before = store.getWorkspaceSession(
    toRuntimeExecutionHostId(cutover.destinationEnvironmentId)
  )
  const next = withRenamedQuirkydMigrationDrafts(
    before,
    store.collectQuirkydMigrationSourceDrafts(cutover.manifest),
    cutover.destinationEnvironmentId
  )
  return next ? { next } : null
}

function writeDestinationSession(
  store: Pick<QuirkydMigrationDraftRenameStore, 'setWorkspaceSession'>,
  cutover: QuirkydMigrationSourceCutover,
  session: WorkspaceSessionState
): void {
  // Baselined writer: drafts are desktop view state no layout command carries (LayoutEditorFile
  // omits them), and the tabs themselves reach the server only through the manifest.
  store.setWorkspaceSession(session, toRuntimeExecutionHostId(cutover.destinationEnvironmentId))
}
