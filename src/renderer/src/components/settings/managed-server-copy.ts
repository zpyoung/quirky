/** User-facing words for managed-server states; every string goes through the catalog. */
import type {
  QuirkydManagedPendingMigrationRow,
  QuirkydManagedRuntimeStatus
} from '../../../../shared/quirkyd-managed-runtime'
import type { QuirkydMigrationBlocker } from '../../../../shared/quirkyd-migration/quirkyd-migration-preflight'
import { translate } from '@/i18n/i18n'
import { dependencyKindLabel } from './managed-server-dependency-kinds'

export function migrationPhaseLabel(phase: QuirkydManagedPendingMigrationRow['phase']): string {
  switch (phase) {
    case 'source-fenced':
      return translate('auto.components.settings.managedServers.phase.fenced', 'Host locked')
    case 'destination-staged':
      return translate('auto.components.settings.managedServers.phase.staged', 'Copy staged')
    case 'destination-committed':
      return translate('auto.components.settings.managedServers.phase.committed', 'Copy committed')
    case 'source-retired':
      return translate('auto.components.settings.managedServers.phase.retired', 'Finished')
  }
}

export function recoveryLabel(
  recovery: NonNullable<QuirkydManagedRuntimeStatus['recovery']>
): string {
  switch (recovery.operation) {
    case 'activate':
      return translate(
        'auto.components.settings.managedServers.recovery.activate',
        'An update was interrupted'
      )
    case 'rollback':
      return translate(
        'auto.components.settings.managedServers.recovery.rollback',
        'A rollback was interrupted'
      )
    case 'decommission':
      return translate(
        'auto.components.settings.managedServers.recovery.decommission',
        'A stop was interrupted'
      )
  }
}

/** `null` counts are unknown, never zero: the server did not answer. */
export function terminalCensusLabel(terminals: QuirkydManagedRuntimeStatus['terminals']): string {
  if (terminals.liveSessions === null) {
    return translate(
      'auto.components.settings.managedServers.terminals.unknown',
      'Running terminals: unknown'
    )
  }
  return translate(
    'auto.components.settings.managedServers.terminals.count',
    'Running terminals: {{count}}',
    { count: terminals.liveSessions }
  )
}

export function conversionBlockerLabel(blocker: QuirkydMigrationBlocker): string {
  switch (blocker.code) {
    case 'quirkyd_migration_target_not_found':
      return translate(
        'auto.components.settings.managedServers.blocker.notFound',
        'The SSH host is gone.'
      )
    case 'quirkyd_migration_target_owned':
    case 'quirkyd_migration_owner_unrecorded':
      return translate(
        'auto.components.settings.managedServers.blocker.owned',
        'Quirky already runs on this SSH host.'
      )
    case 'quirkyd_migration_direct_ssh_repositories':
    case 'quirkyd_migration_direct_ssh_folder_workspaces':
      return translate(
        'auto.components.settings.managedServers.blocker.catalog',
        'Projects on this host cannot move yet.'
      )
    case 'quirkyd_migration_direct_ssh_terminal_leases':
      return translate(
        'auto.components.settings.managedServers.blocker.terminals',
        'Terminals on this host are still running ({{count}}). Close them first.',
        { count: blocker.terminalLeases.length }
      )
    case 'quirkyd_migration_saved_port_forwards':
      return translate(
        'auto.components.settings.managedServers.blocker.portForwards',
        'Saved port forwards stay with the SSH host.'
      )
    case 'quirkyd_migration_dependent_state':
      return translate(
        'auto.components.settings.managedServers.blocker.dependents',
        'State that cannot move yet: {{kinds}}.',
        {
          kinds: blocker.dependencies
            .map((dependency) => `${dependencyKindLabel(dependency.kind)} (${dependency.count})`)
            .join(', ')
        }
      )
    case 'quirkyd_migration_dependency_unverifiable':
      return translate(
        'auto.components.settings.managedServers.blocker.unverifiable',
        'Quirky could not read its saved {{sources}}, so it cannot tell what would move.',
        { sources: blocker.sources.map(dependencyKindLabel).join(', ') }
      )
  }
}

// Main's refusal codes, grouped by what the user does next; its English `reason` never reaches UI.
const LIVE_TERMINAL_CODES = new Set([
  'quirkyd_initial_runtime_live',
  'quirkyd_update_strands_live_terminals',
  'quirkyd_update_terminals_running',
  'quirkyd_update_ends_in_process_terminals',
  'quirkyd_rollback_orphans_live_terminals',
  'quirkyd_rollback_strands_live_terminals',
  'quirkyd_recovery_orphans_live_terminals',
  'quirkyd_stop_still_running'
])
const UNVERIFIABLE_CODES = new Set([
  'quirkyd_initial_runtime_unverifiable',
  'quirkyd_update_terminal_census_unavailable',
  'quirkyd_update_daemon_protocol_unverifiable',
  'quirkyd_rollback_active_identity_unverifiable',
  'quirkyd_rollback_census_unavailable',
  'quirkyd_rollback_daemon_protocol_unverifiable',
  'quirkyd_rollback_snapshot_unverifiable',
  'quirkyd_recovery_census_required',
  'quirkyd_recovery_unverifiable',
  'quirkyd_stop_cancel_unverifiable'
])
const MIGRATION_CODES = new Set([
  'quirkyd_rollback_migration_in_progress',
  'quirkyd_rollback_crosses_migration'
])

/** The one localized line for a managed-server action that did not go through. */
export function managedServerOutcomeLabel(result: {
  outcome: string
  code?: string
  verdict?: string
}): string {
  const code = result.code ?? ''
  if (code === 'quirkyd_stop_active_environment') {
    return translate(
      'auto.components.settings.managedServers.outcome.defaultServer',
      'Not done: this server is the default host for new projects. Choose another one under New projects open on before stopping it.'
    )
  }
  if (result.verdict === 'live' || LIVE_TERMINAL_CODES.has(code)) {
    return translate(
      'auto.components.settings.managedServers.outcome.live',
      'Not done: terminals on this server are still running. Close them and try again.'
    )
  }
  if (result.verdict === 'unverifiable' || UNVERIFIABLE_CODES.has(code)) {
    return translate(
      'auto.components.settings.managedServers.outcome.unverifiable',
      'Not done: Quirky couldn’t confirm what is running on this server. Try again when the host is reachable.'
    )
  }
  if (MIGRATION_CODES.has(code)) {
    return translate(
      'auto.components.settings.managedServers.outcome.migration',
      'Not done: a move onto this server is unfinished. Resume it first.'
    )
  }
  if (result.outcome === 'deferred' || result.outcome === 'pending') {
    return translate(
      'auto.components.settings.managedServers.outcome.deferred',
      'Not done yet: the server isn’t ready for this. Try again later.'
    )
  }
  return translate(
    'auto.components.settings.managedServers.outcome.failed',
    'Quirky couldn’t finish this on the server. Try again.'
  )
}
