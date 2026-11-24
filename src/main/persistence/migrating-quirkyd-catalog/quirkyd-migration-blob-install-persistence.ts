import { QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS } from '../../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { parsePaneKey } from '../../../shared/stable-pane-id'
import { getHistoryRoot } from '../../terminal-history-paths'
import type { StoreRuntimeState } from '../loading-store/store-runtime-state'
import {
  findQuirkydMigrationImportReceipt,
  isQuirkydMigrationCommitDurable
} from './quirkyd-catalog-receipt-ledger'
import { installQuirkydMigrationReceivedBlobs } from './quirkyd-migration-blob-installers'
import { listQuirkydMigrationReceivedBlobNames } from './quirkyd-migration-blob-staging'
import type { QuirkydMigrationRequestIdentity } from './quirkyd-migration-staged-file'

type QuirkydMigrationBlobInstallRuntime = Pick<
  StoreRuntimeState,
  | 'state'
  | 'quirkydMigrationBlobRoot'
  | 'quirkydTerminalRestoreHints'
  | 'paneShellPath'
  | 'deferredShellHistoryWorktreeIds'
  | 'writeGeneration'
  | 'lastDurableWriteGeneration'
  | 'quirkydMigrationCommitWriteGenerations'
>

type ClockOptions = { now?: () => Date }
type InstallOptions = ClockOptions & {
  /** The runtime's live-shell check; a moved history waits while a shell runs in its worktree. */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
}

const quirkydMigrationBlobInstallContext = Symbol('QuirkydMigrationBlobInstallPersistence')
type QuirkydMigrationBlobInstallContext = {
  runtime: QuirkydMigrationBlobInstallRuntime
}

/** The destination's committed migration blobs, installed into host-local state and consumed. */
export class QuirkydMigrationBlobInstallPersistence {
  readonly [quirkydMigrationBlobInstallContext]: QuirkydMigrationBlobInstallContext

  constructor(runtime: QuirkydMigrationBlobInstallRuntime) {
    this[quirkydMigrationBlobInstallContext] = { runtime }
  }

  /**
   * Installs only once the commit is durable: installing first and then losing the commit would
   * leave live state for a catalog this host never received, and consume the received blobs a
   * retry after restart needs. A no-op before then and on repeats.
   */
  installQuirkydMigrationReceivedBlobs(
    manifest: QuirkydMigrationManifest,
    options: InstallOptions = {}
  ): void {
    const receipt = findQuirkydMigrationImportReceipt(
      this[quirkydMigrationBlobInstallContext].runtime.state,
      manifest
    )
    if (receipt?.manifestSha256 !== manifest.manifestSha256) {
      return
    }
    installCommitted(this[quirkydMigrationBlobInstallContext].runtime, manifest, options)
  }

  /** Finishes installs a crash or failed write left behind; every receipt on disk is durable. */
  installPendingQuirkydMigrationReceivedBlobs(options: InstallOptions = {}): void {
    const { runtime } = this[quirkydMigrationBlobInstallContext]
    for (const receipt of [
      ...(runtime.state.quirkydMigrationImportReceipts ?? []),
      ...(runtime.state.quirkydMigrationEvictedReceipts ?? [])
    ]) {
      try {
        installCommitted(runtime, receipt, options)
      } catch (error) {
        console.error(
          `[quirkyd-migration] installing received blobs for ${receipt.migrationId} failed:`,
          error
        )
      }
    }
  }

  /** Whether any committed migration still holds a received shell history; only the runtime installs those. */
  hasPendingQuirkydMigrationShellHistory(): boolean {
    const { runtime } = this[quirkydMigrationBlobInstallContext]
    return [
      ...(runtime.state.quirkydMigrationImportReceipts ?? []),
      ...(runtime.state.quirkydMigrationEvictedReceipts ?? [])
    ].some((receipt) =>
      listQuirkydMigrationReceivedBlobNames(
        runtime.quirkydMigrationBlobRoot,
        receipt,
        'shell-history'
      ).some((key) => QUIRKYD_MIGRATION_BLOB_KIND_CONTRACTS['shell-history'].key.test(key))
    )
  }

  /** Retries a history install that waited on this worktree's shells; a no-op for any other. */
  installDeferredQuirkydMigrationShellHistory(
    worktreeId: string,
    options: InstallOptions = {}
  ): void {
    const { runtime } = this[quirkydMigrationBlobInstallContext]
    if (runtime.deferredShellHistoryWorktreeIds.has(worktreeId)) {
      this.installPendingQuirkydMigrationReceivedBlobs(options)
    }
  }

  /** The moved pane's last folder while its hint is installed for this worktree; never removes it. */
  peekQuirkydMigrationTerminalRestoreHint(
    paneKey: string,
    worktreeId: string,
    options: ClockOptions = {}
  ): string | null {
    return this[quirkydMigrationBlobInstallContext].runtime.quirkydTerminalRestoreHints.peek(
      paneKey,
      worktreeId,
      clock(options)
    )
  }

  /** Called once the pane spawned: whatever cwd that create used, it was the restore. */
  consumeQuirkydMigrationTerminalRestoreHint(paneKey: string, options: ClockOptions = {}): void {
    this[quirkydMigrationBlobInstallContext].runtime.quirkydTerminalRestoreHints.consume(
      paneKey,
      clock(options)
    )
  }
}

function installCommitted(
  runtime: QuirkydMigrationBlobInstallRuntime,
  migration: QuirkydMigrationRequestIdentity,
  options: InstallOptions
): void {
  if (!isQuirkydMigrationCommitDurable(runtime, migration)) {
    return
  }
  installQuirkydMigrationReceivedBlobs({
    migration,
    root: runtime.quirkydMigrationBlobRoot,
    terminalRestoreHints: runtime.quirkydTerminalRestoreHints,
    shellHistoryRoot: getHistoryRoot(),
    paneShellPath: () => runtime.paneShellPath(runtime.state.settings?.terminalDefaultShell),
    worktreeHasLiveShells: options.worktreeHasLiveShells,
    deferredShellHistoryWorktreeIds: runtime.deferredShellHistoryWorktreeIds,
    paneWorktreeId: (paneKey) => findPaneWorktreeId(runtime.state, paneKey),
    now: clock(options)
  })
}

function clock(options: ClockOptions): number {
  return (options.now ?? (() => new Date()))().getTime()
}

// The commit merged the moved session in with its worktree ids unchanged.
function findPaneWorktreeId(state: PersistedState, paneKey: string): string | null {
  const tabId = parsePaneKey(paneKey)?.tabId
  if (!tabId) {
    return null
  }
  const sessions = [state.workspaceSession, ...Object.values(state.workspaceSessionsByHostId ?? {})]
  for (const session of sessions) {
    for (const [worktreeId, tabs] of Object.entries(session?.tabsByWorktree ?? {})) {
      if (tabs.some((tab) => tab.id === tabId)) {
        return worktreeId
      }
    }
  }
  return null
}
