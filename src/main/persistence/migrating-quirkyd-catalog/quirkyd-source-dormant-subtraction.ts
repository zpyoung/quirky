import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import { subtractQuirkydSourceWorktreeMetadata } from './quirkyd-source-worktree-metadata'
import { subtractQuirkydMigrationSourceAutomationState } from './quirkyd-source-automation-subtraction'
import { subtractQuirkydMigrationSourceWorkspaceSession } from './quirkyd-source-workspace-session-subtraction'
import { subtractQuirkydMigrationClientState } from './quirkyd-source-client-subtraction'

/** On a copy of the profile only: what an earlier migration moved, gone from the delta view. */
export function subtractQuirkydMigrationSourceDormantState(
  state: PersistedState,
  manifest: QuirkydMigrationManifest
): void {
  // By scope, even with no dormant state: a downgraded build may have added some since.
  subtractQuirkydSourceWorktreeMetadata(state, manifest)
  subtractQuirkydMigrationSourceAutomationState(state, manifest)
  const dormant = manifest.payload.dormantState
  if (!dormant) {
    return
  }
  dormant.worktreeLineage.forEach((entry) => delete state.worktreeLineageById[entry.sourceKey])
  dormant.workspaceLineage.forEach(
    (entry) => delete state.workspaceLineageByChildKey[entry.sourceKey]
  )
  for (const preset of dormant.sparsePresets) {
    const remaining = (state.sparsePresetsByRepo[preset.repoId] ?? []).filter(
      (entry) => entry.id !== preset.id
    )
    if (remaining.length > 0) {
      state.sparsePresetsByRepo[preset.repoId] = remaining
    } else {
      delete state.sparsePresetsByRepo[preset.repoId]
    }
  }
  for (const entry of dormant.retiredWorktreeNames) {
    delete state.retiredWorktreeNamesByRepo?.[entry.repoId]
  }
  subtractQuirkydMigrationSourceWorkspaceSession(state, manifest)
  subtractQuirkydMigrationClientState(state, manifest)
  // Retain snapshot files: the prior durable profile and rollback evidence can still reference them.
}
