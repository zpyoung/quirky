/**
 * Gives a host whose conversion stopped short back to the relay. A destination that was never
 * registered held nothing; a registered one must prove through an abort that it holds nothing,
 * and is unregistered before the fence goes so no later start re-fences the host to it.
 */
import { removeManagedQuirkydEnvironment } from '../../shared/runtime-environment-managed-quirkyd-store'
import { listEnvironments } from '../../shared/runtime-environment-store'
import type { KnownRuntimeEnvironment } from '../../shared/runtime-environments'
import { closeQuirkydManagedTunnel } from '../managed-server/lifecycle/quirkyd-managed-tunnel'
import {
  abortQuirkydMigrationCutover,
  type QuirkydMigrationAbortResult,
  type QuirkydMigrationCutoverContext,
  type QuirkydMigrationDestinationCatalog
} from './quirkyd-migration-cutover-coordinator'
import { findQuirkydMigrationSourceCutoverForTarget } from './quirkyd-migration-cutover-journal'
import {
  releaseQuirkydMigrationFence,
  releaseUndeployedMigrationFence
} from './quirkyd-migration-source-fence'

export async function abandonQuirkydConversion(args: {
  userDataPath: string
  store: QuirkydMigrationCutoverContext['store']
  claims: QuirkydMigrationCutoverContext['claims']
  targetId: string
  destinationFor: (environment: KnownRuntimeEnvironment) => QuirkydMigrationDestinationCatalog
}): Promise<QuirkydMigrationAbortResult | 'none'> {
  const cutover = findQuirkydMigrationSourceCutoverForTarget(args.userDataPath, args.targetId)
  // A delta move keeps its committed chain; it resolves through the delta flow, never here.
  if (!cutover || cutover.supersedesMigrationId) {
    return 'none'
  }
  const isRegistered = (id: string): boolean =>
    listEnvironments(args.userDataPath).some((entry) => entry.id === id)
  const environment = listEnvironments(args.userDataPath).find(
    (entry) => entry.id === cutover.destinationEnvironmentId
  )
  if (!environment) {
    await releaseUndeployedMigrationFence({ ...args, isDestinationRegistered: isRegistered })
    return 'none'
  }
  const context = { ...args, destination: args.destinationFor(environment) }
  return abortQuirkydMigrationCutover(context, cutover.migrationId, async (aborted) => {
    await closeQuirkydManagedTunnel(environment.id).catch(() => undefined)
    removeManagedQuirkydEnvironment(args.userDataPath, environment.id)
    await releaseQuirkydMigrationFence(context, aborted)
  })
}
