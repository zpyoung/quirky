import { getAutomationRunRepoId } from '../../../shared/automation-run-identity'
import type { QuirkydMigrationManifest } from '../../../shared/quirkyd-migration/quirkyd-migration-manifest'
import type { PersistedState } from '../../../shared/persisted-state-types'
import {
  createQuirkydMigrationSourceScope,
  quirkydMigrationOwnsRepoId
} from './quirkyd-source-scope'

/** The manifest's automations, and any a downgraded build added to a moved project since. */
export function subtractQuirkydMigrationSourceAutomationState(
  state: PersistedState,
  manifest: QuirkydMigrationManifest
): void {
  const scope = createQuirkydMigrationSourceScope({
    source: manifest.source,
    catalog: manifest.payload,
    repos: state.repos
  })
  const automationIds = new Set([
    ...(manifest.payload.dormantState?.automations ?? []).map((entry) => entry.id),
    ...state.automations
      .filter(
        (entry) =>
          quirkydMigrationOwnsRepoId(scope, getAutomationRunRepoId(entry)) &&
          (entry.executionTargetType !== 'ssh' || entry.executionTargetId === scope.targetId)
      )
      .map((entry) => entry.id)
  ])
  const runIds = new Set((manifest.payload.dormantState?.automationRuns ?? []).map((run) => run.id))
  state.automations = state.automations.filter((entry) => !automationIds.has(entry.id))
  state.automationRuns = state.automationRuns.filter(
    (run) => !runIds.has(run.id) && !automationIds.has(run.automationId)
  )
}
