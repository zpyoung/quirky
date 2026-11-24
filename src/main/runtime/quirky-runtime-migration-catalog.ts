import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReference,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type {
  QuirkydMigrationSnapshotChunkRequest,
  QuirkydMigrationSnapshotChunkResult
} from '../../shared/quirkyd-migration/quirkyd-migration-scrollback'
import type {
  QuirkydMigrationBlobChunkRequest,
  QuirkydMigrationBlobChunkResult,
  QuirkydMigrationBlobDescriptor
} from '../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import {
  abortStagedQuirkydMigrationCatalogByReferenceDurably,
  abortStagedQuirkydMigrationCatalogDurably,
  commitStagedQuirkydMigrationCatalogDurably,
  getQuirkydMigrationCatalogState,
  stageQuirkydMigrationCatalogDurably
} from './quirkyd-migration-catalog-import'
import { QuirkyRuntimeWithResolveWaiter } from './quirky-runtime-resolve-waiter'
import type { RuntimeStore } from './runtime-store-contract'

type MigrationStoreKey =
  | 'stageQuirkydMigrationCatalog'
  | 'commitStagedQuirkydMigrationCatalog'
  | 'stageQuirkydMigrationSnapshotChunk'
  | 'stageQuirkydMigrationBlobChunk'
  | 'abortStagedQuirkydMigrationCatalog'
  | 'abortStagedQuirkydMigrationCatalogByReference'
  | 'getQuirkydMigrationCatalogState'
  | 'flushPendingOrThrowAsync'

/** The destination half of a dormant catalog migration; every mutation is flushed before it answers. */
export abstract class QuirkyRuntimeWithMigrationCatalog extends QuirkyRuntimeWithResolveWaiter {
  async stageQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<QuirkydMigrationCatalogState> {
    return stageQuirkydMigrationCatalogDurably({
      store: this.requireMigrationStore('stageQuirkydMigrationCatalog', 'flushPendingOrThrowAsync'),
      manifest,
      signal: options.signal
    })
  }

  async commitStagedQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest,
    options: {
      signal?: AbortSignal
      expectedBlobs?: readonly QuirkydMigrationBlobDescriptor[]
    } = {}
  ): Promise<QuirkydMigrationCatalogState> {
    return commitStagedQuirkydMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'commitStagedQuirkydMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal,
      expectedBlobs: options.expectedBlobs,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells,
      onDurableCommit: () => {
        this.invalidateResolvedWorktreeCache()
        this.notifyReposChanged()
      }
    })
  }

  stageQuirkydMigrationSnapshotChunk(
    request: QuirkydMigrationSnapshotChunkRequest
  ): QuirkydMigrationSnapshotChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageQuirkydMigrationSnapshotChunk')
      .stageQuirkydMigrationSnapshotChunk!(request)
  }

  stageQuirkydMigrationBlobChunk(
    request: QuirkydMigrationBlobChunkRequest
  ): QuirkydMigrationBlobChunkResult {
    // SAFETY: The virtual Store may differ from the checked Store; preserve its native failure.
    return this.requireMigrationStore('stageQuirkydMigrationBlobChunk')
      .stageQuirkydMigrationBlobChunk!(request)
  }

  async abortStagedQuirkydMigrationCatalog(
    manifest: QuirkydMigrationManifest,
    options: { signal?: AbortSignal } = {}
  ): Promise<QuirkydMigrationCatalogAbortResult> {
    return abortStagedQuirkydMigrationCatalogDurably({
      store: this.requireMigrationStore(
        'abortStagedQuirkydMigrationCatalog',
        'flushPendingOrThrowAsync'
      ),
      manifest,
      signal: options.signal
    })
  }

  async abortStagedQuirkydMigrationCatalogByReference(
    reference: QuirkydMigrationCatalogReference,
    options: { signal?: AbortSignal } = {}
  ): Promise<QuirkydMigrationCatalogReferenceAbortResult> {
    return abortStagedQuirkydMigrationCatalogByReferenceDurably({
      store: this.requireMigrationStore(
        'abortStagedQuirkydMigrationCatalogByReference',
        'flushPendingOrThrowAsync'
      ),
      reference,
      signal: options.signal
    })
  }

  getQuirkydMigrationCatalogState(
    manifest: QuirkydMigrationManifest
  ): QuirkydMigrationCatalogState {
    return getQuirkydMigrationCatalogState({
      store: this.requireMigrationStore('getQuirkydMigrationCatalogState'),
      manifest,
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  /**
   * The moved shell history store load left waiting, installed once this runtime can see the
   * host's shells. An unanswered inventory leaves it for the next catalog-state query.
   */
  async installPendingQuirkydMigrationShellHistory(): Promise<void> {
    const store = this.store
    // Why: runs on every quirkyd start; with nothing to install it must not pay a process inventory.
    if (
      !store?.installPendingQuirkydMigrationReceivedBlobs ||
      !store.hasPendingQuirkydMigrationShellHistory?.()
    ) {
      return
    }
    // Daemon shells that outlived a restart count as live only once the inventory recorded them.
    // Why the real worktrees: an empty list re-files sessions it cannot resolve and drops their
    // restored orchestration receipts.
    if (
      this.ptyController?.listProcesses &&
      !(await this.refreshPtyWorktreeRecordsWithControllerInventory([
        ...(await this.getResolvedWorktreeMap()).values()
      ]))
    ) {
      console.warn('[quirkyd-migration] shell history waits: the terminal inventory did not answer')
      return
    }
    store.installPendingQuirkydMigrationReceivedBlobs({
      worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
    })
  }

  // The last shell of a worktree exiting releases a moved history that waited on it.
  override onPtyExit(
    ...args: Parameters<QuirkyRuntimeWithResolveWaiter['onPtyExit']>
  ): ReturnType<QuirkyRuntimeWithResolveWaiter['onPtyExit']> {
    const worktreeId = this.ptysById.get(args[0])?.worktreeId
    const result = super.onPtyExit(...args)
    // The store checks its deferred set first, so an exit in any other worktree costs one lookup.
    if (worktreeId) {
      try {
        this.store?.installDeferredQuirkydMigrationShellHistory?.(worktreeId, {
          worktreeHasLiveShells: this.migrationWorktreeHasLiveShells
        })
      } catch (error) {
        console.error('[quirkyd-migration] installing deferred shell history failed:', error)
      }
    }
    return result
  }

  // A moved history is this machine's; a same-id SSH twin's shell never writes it.
  private readonly migrationWorktreeHasLiveShells = (worktreeId: string): boolean =>
    this.getLivePtyIdsForWorktree(worktreeId, undefined, { resolvedConnectionId: null }).size > 0

  // The capability check covers the captured Store, not a different virtual return.
  private requireMigrationStore(...methods: MigrationStoreKey[]): RuntimeStore {
    const store = this.store
    if (!store || methods.some((method) => typeof store[method] !== 'function')) {
      throw new Error('runtime_unavailable')
    }
    return this.requireStore()
  }
}
