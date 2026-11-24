import type {
  QuirkydMigrationCatalogAbortResult,
  QuirkydMigrationCatalogReference,
  QuirkydMigrationCatalogReferenceAbortResult,
  QuirkydMigrationCatalogState,
  QuirkydMigrationManifest
} from '../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { QuirkydMigrationBlobDescriptor } from '../../shared/quirkyd-migration/quirkyd-migration-blob-transfer'
import type { Store } from '../persistence'

/** A moved history waits while a shell runs in its worktree: that shell would overwrite it. */
type WorktreeHasLiveShells = (worktreeId: string) => boolean

type QuirkydMigrationCatalogFlushStore = Partial<Pick<Store, 'flushPendingOrThrowAsync'>>
type QuirkydMigrationCatalogStageStore = QuirkydMigrationCatalogFlushStore &
  Partial<Pick<Store, 'stageQuirkydMigrationCatalog'>>
type QuirkydMigrationCatalogCommitStore = QuirkydMigrationCatalogFlushStore &
  Partial<
    Pick<Store, 'commitStagedQuirkydMigrationCatalog' | 'installQuirkydMigrationReceivedBlobs'>
  >
type QuirkydMigrationCatalogAbortStore = QuirkydMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedQuirkydMigrationCatalog'>>
type QuirkydMigrationCatalogAbortByReferenceStore = QuirkydMigrationCatalogFlushStore &
  Partial<Pick<Store, 'abortStagedQuirkydMigrationCatalogByReference'>>

export async function stageQuirkydMigrationCatalogDurably(args: {
  store: QuirkydMigrationCatalogStageStore
  manifest: QuirkydMigrationManifest
  signal?: AbortSignal
}): Promise<QuirkydMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.stageQuirkydMigrationCatalog!(args.manifest)
  await flushMigrationState(args.store, args.signal)
  return result
}

export async function commitStagedQuirkydMigrationCatalogDurably(args: {
  store: QuirkydMigrationCatalogCommitStore
  manifest: QuirkydMigrationManifest
  signal?: AbortSignal
  expectedBlobs?: readonly QuirkydMigrationBlobDescriptor[]
  onDurableCommit: () => void
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): Promise<QuirkydMigrationCatalogState> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.commitStagedQuirkydMigrationCatalog!(
    args.manifest,
    args.expectedBlobs ? { expectedBlobs: args.expectedBlobs } : {}
  )
  await flushMigrationState(args.store, args.signal)
  args.onDurableCommit()
  installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  return result
}

/** After the durable commit, on its retries and state queries; the store load retries too. */
function installReceivedBlobs(
  store: Partial<Pick<Store, 'installQuirkydMigrationReceivedBlobs'>>,
  manifest: QuirkydMigrationManifest,
  worktreeHasLiveShells: WorktreeHasLiveShells | undefined
): void {
  try {
    store.installQuirkydMigrationReceivedBlobs?.(manifest, { worktreeHasLiveShells })
  } catch (error) {
    // The catalog is committed; a failed install keeps its blob for the next retry.
    console.error('[quirkyd-migration] installing received blobs failed:', error)
  }
}

export async function abortStagedQuirkydMigrationCatalogDurably(args: {
  store: QuirkydMigrationCatalogAbortStore
  manifest: QuirkydMigrationManifest
  signal?: AbortSignal
}): Promise<QuirkydMigrationCatalogAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedQuirkydMigrationCatalog!(args.manifest)
  // An already-absent retry may follow an in-memory abort whose flush failed.
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export async function abortStagedQuirkydMigrationCatalogByReferenceDurably(args: {
  store: QuirkydMigrationCatalogAbortByReferenceStore
  reference: QuirkydMigrationCatalogReference
  signal?: AbortSignal
}): Promise<QuirkydMigrationCatalogReferenceAbortResult> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.abortStagedQuirkydMigrationCatalogByReference!(args.reference)
  if (result.state === 'absent') {
    await flushMigrationState(args.store, args.signal)
    return { ...result, durableAbsent: true }
  }
  return result
}

export function getQuirkydMigrationCatalogState(args: {
  store: Partial<
    Pick<Store, 'getQuirkydMigrationCatalogState' | 'installQuirkydMigrationReceivedBlobs'>
  >
  manifest: QuirkydMigrationManifest
  worktreeHasLiveShells?: WorktreeHasLiveShells
}): QuirkydMigrationCatalogState {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  const result = args.store.getQuirkydMigrationCatalogState!(args.manifest)
  if (result.state === 'committed') {
    installReceivedBlobs(args.store, args.manifest, args.worktreeHasLiveShells)
  }
  return result
}

function flushMigrationState(
  store: QuirkydMigrationCatalogFlushStore,
  signal?: AbortSignal
): Promise<void> {
  // SAFETY: Returned or mutable Store slots retain their original native missing-method failure.
  return store.flushPendingOrThrowAsync!({
    signal,
    drainToStableGeneration: false
  })
}
