/**
 * Per-kind handling of migration blobs on the destination: a content check before the catalog
 * commits, and an installer after the commit is durable that moves the received blob into live
 * state and deletes it. Kinds without an installer are not advertised, so none arrive.
 */
import { readFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import type { QuirkydMigrationBlobKind } from '../../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import {
  QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY,
  parseQuirkydMigrationTerminalRestoreHintsText,
  type QuirkydMigrationTerminalRestoreHint
} from '../../../shared/quirkyd-migration/quirkyd-migration-terminal-restore-hints'
import { syncDirectoryDurablySync } from '../../durable-file-write'
import {
  getQuirkydMigrationReceivedBlobPath,
  stagedQuirkydMigrationBlobFiles
} from './quirkyd-migration-blob-staging'
import {
  quirkydMigrationStagingKey,
  type QuirkydMigrationRequestIdentity
} from './quirkyd-migration-staged-file'
import {
  assertQuirkydMigrationShellHistoryValid,
  installQuirkydMigrationShellHistory
} from './quirkyd-shell-history-installer'
import type {
  QuirkydTerminalRestoreHintPlacement,
  QuirkydTerminalRestoreHintStore
} from './quirkyd-terminal-restore-hint-store'

type QuirkydMigrationStagedBlobFile = {
  key: string
  path: string
  manifest: QuirkydMigrationManifest
}

type QuirkydMigrationBlobContentCheck = (file: QuirkydMigrationStagedBlobFile) => void

const UTF8 = new TextDecoder('utf-8', { fatal: true })

const BLOB_CONTENT_CHECKS: Partial<
  Record<QuirkydMigrationBlobKind, QuirkydMigrationBlobContentCheck>
> = {
  'terminal-restore-hints': ({ path }) => {
    parseQuirkydMigrationTerminalRestoreHintsText(decodeUtf8(readFileSync(path)))
  },
  'shell-history': ({ key, path, manifest }) => {
    assertQuirkydMigrationShellHistoryValid(key, path, manifest.payload)
  }
}

/**
 * Bytes that matched their digest but not their format mean a buggy sender. Refusing here, before
 * anything lands, fails the move while the source still owns everything — nothing is lost.
 */
export function assertQuirkydMigrationBlobContentsValid(
  manifest: QuirkydMigrationManifest,
  root: string
): void {
  for (const { descriptor, path } of stagedQuirkydMigrationBlobFiles(manifest, root)) {
    const check = BLOB_CONTENT_CHECKS[descriptor.blobKind]
    if (!check) {
      continue
    }
    try {
      check({ key: descriptor.key, path, manifest })
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`quirkyd_migration_blob_content_invalid:${descriptor.blobKind}:${reason}`)
    }
  }
}

export type QuirkydMigrationBlobInstall = {
  migration: QuirkydMigrationRequestIdentity
  root: string
  terminalRestoreHints: QuirkydTerminalRestoreHintStore
  /** This host's `getHistoryRoot()`, where its panes' HISTFILEs live. */
  shellHistoryRoot: string
  /** The shell binary a new pane on this host would actually run. */
  paneShellPath: () => string
  /**
   * The runtime's live-shell check. Without it (store load, before a runtime attached) shell
   * history waits: a shell that outlived a restart would overwrite whatever lands under it.
   */
  worktreeHasLiveShells?: (worktreeId: string) => boolean
  /** Worktrees whose history install waits for their live shells to exit. */
  deferredShellHistoryWorktreeIds: Set<string>
  /** The worktree that owns the pane on this host, or null when the pane is not here. */
  paneWorktreeId: (paneKey: string) => string | null
  now: number
}

/**
 * Idempotent: a blob already installed is only deleted, and the hint store remembers installed
 * migrations so a retry never revives a hint a pane already took. A write failure keeps the blob
 * for the next retry: a commit retry, a catalog-state query, the runtime's post-attach pass, or
 * (for restore hints) the next store load.
 */
export function installQuirkydMigrationReceivedBlobs(install: QuirkydMigrationBlobInstall): void {
  let firstError: unknown = null
  // One kind's failure must not hold back the others; each keeps its own blobs for the retry.
  for (const installKind of [installTerminalRestoreHints, installShellHistory]) {
    try {
      installKind(install)
    } catch (error) {
      firstError ??= error
    }
  }
  if (firstError !== null) {
    throw firstError
  }
}

function installShellHistory(install: QuirkydMigrationBlobInstall): void {
  if (!install.worktreeHasLiveShells) {
    return
  }
  installQuirkydMigrationShellHistory({
    migration: install.migration,
    root: install.root,
    historyRoot: install.shellHistoryRoot,
    paneShellPath: install.paneShellPath,
    worktreeHasLiveShells: install.worktreeHasLiveShells,
    deferredWorktreeIds: install.deferredShellHistoryWorktreeIds,
    now: install.now
  })
}

function installTerminalRestoreHints(install: QuirkydMigrationBlobInstall): void {
  const path = getQuirkydMigrationReceivedBlobPath(install.root, install.migration, {
    blobKind: 'terminal-restore-hints',
    key: QUIRKYD_MIGRATION_TERMINAL_RESTORE_HINTS_KEY
  })
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return
  }
  const migrationKey = quirkydMigrationStagingKey(install.migration)
  if (!install.terminalRestoreHints.hasInstalledMigration(migrationKey)) {
    try {
      const document = parseQuirkydMigrationTerminalRestoreHintsText(decodeUtf8(bytes))
      install.terminalRestoreHints.install(
        { migrationKey, migrationId: install.migration.migrationId },
        placeHints(document.hints, install.paneWorktreeId),
        install.now
      )
    } catch (error) {
      if (!isHintFormatError(error)) {
        throw error
      }
      // The pre-commit check passed these bytes, so only a damaged file lands here; the catalog
      // is already durable, and its panes reopen at their default folder.
      console.error(
        `[quirkyd-migration] dropped unreadable terminal restore hints for ${install.migration.migrationId}:`,
        error
      )
    }
  }
  rmSync(path, { force: true })
  syncDirectoryDurablySync(dirname(path))
}

// A hint whose pane is not in this host's session has no worktree to scope it to, so it is dropped.
function placeHints(
  hints: readonly QuirkydMigrationTerminalRestoreHint[],
  paneWorktreeId: (paneKey: string) => string | null
): QuirkydTerminalRestoreHintPlacement[] {
  return hints.flatMap((hint) => {
    const worktreeId = paneWorktreeId(hint.paneKey)
    return worktreeId ? [{ ...hint, worktreeId }] : []
  })
}

function decodeUtf8(bytes: Buffer): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new Error('quirkyd_migration_terminal_restore_hints_not_utf8')
  }
}

function isHintFormatError(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('quirkyd_migration_terminal_restore_')
}
