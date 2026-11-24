/**
 * Where a dormant catalog migrates out of, into a managed quirkyd.
 *
 * The destination half (catalog stage/commit and the cutover coordinator) reaches a source only
 * through `QuirkydMigrationSourceCutoverPort`; the conversion drives the rest. The relay-era SSH
 * target (quirkyd-migration-ssh-relay-source.ts) is the only implementation.
 */
import type { QuirkydMigrationSourceKind } from '../../shared/quirkyd-migration/quirkyd-migration-source-kind'
import type {
  QuirkydMigrationCatalogPayload,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { QuirkydMigrationSourceCutover } from '../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import type { QuirkydMigrationManifestExportOptions } from './quirkyd-migration-manifest-export'
import type {
  QuirkydMigrationFenceResult,
  QuirkydMigrationFenceState
} from './quirkyd-migration-source-fence'
import type { QuirkydMigrationTerminalVerdict } from './quirkyd-migration-terminal-gate'

/** What a cutover needs from its source once fenced, keyed by the journaled cutover alone. */
export type QuirkydMigrationSourceCutoverPort = {
  /** Before every stage and commit; throws unless the fenced source still matches the journal. */
  verifyFence: (cutover: QuirkydMigrationSourceCutover) => void
  /** Drops the fence, then the journal; only on proof the destination holds nothing. */
  releaseFence: (cutover: QuirkydMigrationSourceCutover) => Promise<void>
}

export type QuirkydMigrationFenceAcquireArgs = {
  destinationEnvironmentId: string
  destinationName: string
  /** Taken by `assessTerminals` while the source could still answer. */
  terminalProof: QuirkydMigrationTerminalVerdict
  now?: () => Date
  signal?: AbortSignal
}

export type QuirkydMigrationSource = QuirkydMigrationSourceCutoverPort & {
  readonly kind: QuirkydMigrationSourceKind
  /** What every journal entry of this source is keyed by. */
  readonly journalKey: string
  /** Scope selection: the catalog rows this source owns. Read-only. */
  collectCatalog: () => QuirkydMigrationCatalogPayload
  /** The signed manifest, after the source's path-rewrite stage. Read-only. */
  exportManifest: (options?: QuirkydMigrationManifestExportOptions) => QuirkydMigrationManifest
  /** Before the fence. Loss of contact is `unverifiable`, never `exited`. */
  assessTerminals: () => Promise<QuirkydMigrationTerminalVerdict>
  /** Marks what an exited proof covers as ended, so later checks stop counting it. */
  retireProvenExitedTerminals: (proof: QuirkydMigrationTerminalVerdict) => void
  /** Throws when the journal cannot be read: an unreadable record keeps the source fenced. */
  resolveFence: () => QuirkydMigrationFenceState
  /** Journal, then fence, then flush, then the terminal re-check under the fence. */
  acquireFence: (args: QuirkydMigrationFenceAcquireArgs) => Promise<QuirkydMigrationFenceResult>
}
