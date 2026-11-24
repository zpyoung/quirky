import type { QuirkydMigrationCatalogState } from '../../shared/quirkyd-migration/quirkyd-migration-manifest'

export async function resolveDurableQuirkydCatalogMutation(
  mutate: () => Promise<QuirkydMigrationCatalogState>,
  read: () => Promise<QuirkydMigrationCatalogState>,
  accepted: (state: QuirkydMigrationCatalogState) => boolean
) {
  try {
    return await mutate()
  } catch (mutationError) {
    let observed: QuirkydMigrationCatalogState
    try {
      observed = await read()
    } catch {
      throw mutationError
    }
    if (!accepted(observed)) {
      throw mutationError
    }
  }
  // State reads may reflect unflushed mutations; an idempotent acknowledgment proves durability.
  return mutate()
}
