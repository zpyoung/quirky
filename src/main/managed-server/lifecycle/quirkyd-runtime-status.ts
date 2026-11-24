import type { QuirkydManagedRuntimeStatus } from '../../../shared/quirkyd-managed-runtime'
import { runTargetLifecycle } from '../../ipc/ssh/ssh-target-lifecycle-queue'
import type { QuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction'
import { readQuirkydActivationTransaction } from '../activation/quirkyd-activation-transaction-store'
import {
  requireManagedQuirkydEnvironment,
  resolveLinkedQuirkydContext
} from './quirkyd-managed-runtime-context'
import { currentManagedQuirkydUpdateDeferral } from './quirkyd-managed-update-deferrals'
import { findIncompleteManagedQuirkydMigration } from './quirkyd-managed-migration-status'
import { collectManagedTerminalCensus } from '../../ssh/quirkyd-terminal-census-client'

/** Read-only: what the host's activation record and journal say, without repairing either. */
export async function getManagedQuirkydRuntimeStatus(
  userDataPath: string,
  selector: string,
  signal?: AbortSignal
): Promise<QuirkydManagedRuntimeStatus> {
  const { environment, deployment } = requireManagedQuirkydEnvironment(userDataPath, selector)
  return runTargetLifecycle(deployment.sshTargetId, async () => {
    const context = await resolveLinkedQuirkydContext(environment, deployment, signal)
    const record = context.activationRecord
    const transaction = await readQuirkydActivationTransaction({
      conn: context.connection,
      host: context.host,
      remoteHome: context.remoteHome,
      signal
    })
    return {
      environmentId: environment.id,
      sshTargetId: context.target.id,
      activeVersion: record.active,
      previousVersion: record.previous,
      activatedAt: record.activatedAt,
      rollbackAvailable: Boolean(record.previous && record.snapshot),
      recovery: transaction ? managedRecoveryStatus(transaction) : null,
      terminals: await collectManagedTerminalCensus(userDataPath, environment, record),
      migration: migrationStatus(userDataPath, environment.id),
      deferredUpdate: currentManagedQuirkydUpdateDeferral(environment.id, record.active)
    }
  })
}

function managedRecoveryStatus(
  transaction: QuirkydActivationTransaction
): NonNullable<QuirkydManagedRuntimeStatus['recovery']> {
  switch (transaction.operation) {
    case 'activate':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.candidateVersion,
        startedAt: transaction.startedAt
      }
    case 'rollback':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.targetVersion,
        startedAt: transaction.startedAt
      }
    case 'decommission':
      return {
        operation: transaction.operation,
        phase: transaction.phase,
        version: transaction.activeVersion,
        startedAt: transaction.startedAt
      }
  }
}

function migrationStatus(
  userDataPath: string,
  environmentId: string
): QuirkydManagedRuntimeStatus['migration'] {
  const migration = findIncompleteManagedQuirkydMigration(userDataPath, environmentId)
  return migration
    ? { migrationId: migration.migrationId, phase: migration.phase, startedAt: migration.startedAt }
    : null
}
