/** Which dormant migrations into managed servers have not finished, for status and resume. */
import {
  isRetainedQuirkydMigrationSourceCutover,
  type QuirkydMigrationSourceCutover
} from '../../../shared/quirkyd-migration/quirkyd-migration-source-cutover'
import {
  getQuirkydSshDeployment,
  type KnownRuntimeEnvironment
} from '../../../shared/runtime-environments'
import { listQuirkydMigrationSourceCutovers } from '../../ssh/quirkyd-migration-cutover-journal'

export type QuirkydManagedPendingMigration = {
  migrationId: string
  environmentId: string
  name: string
  sshTargetId: string
  phase: QuirkydMigrationSourceCutover['phase']
  startedAt: string
}

/** Throws on an unreadable journal: a migration we cannot read is not "none". */
export function listPendingManagedQuirkydMigrations(
  userDataPath: string
): QuirkydManagedPendingMigration[] {
  return (
    listQuirkydMigrationSourceCutovers(userDataPath)
      // Why retained too: committed is finished; keeping source rows is downgrade insurance, not work.
      .filter(
        (cutover) =>
          cutover.phase !== 'source-retired' && !isRetainedQuirkydMigrationSourceCutover(cutover)
      )
      .map((cutover) => ({
        migrationId: cutover.migrationId,
        environmentId: cutover.destinationEnvironmentId,
        name: cutover.destinationName,
        sshTargetId: cutover.sshTargetId,
        phase: cutover.phase,
        startedAt: cutover.startedAt
      }))
  )
}

export function findIncompleteManagedQuirkydMigration(
  userDataPath: string,
  environmentId: string
): QuirkydManagedPendingMigration | null {
  return (
    listPendingManagedQuirkydMigrations(userDataPath).find(
      (migration) => migration.environmentId === environmentId
    ) ?? null
  )
}

/** The registered server is the one the journal deploys into, on the journaled registration. */
export function environmentMatchesManagedQuirkydCutover(
  environment: KnownRuntimeEnvironment,
  cutover: QuirkydMigrationSourceCutover
): boolean {
  const deployment = getQuirkydSshDeployment(environment)
  return (
    environment.id === cutover.destinationEnvironmentId &&
    environment.name === cutover.destinationName &&
    deployment?.sshTargetId === cutover.sshTargetId &&
    deployment.sshTargetGeneration === cutover.sshTargetGeneration
  )
}
