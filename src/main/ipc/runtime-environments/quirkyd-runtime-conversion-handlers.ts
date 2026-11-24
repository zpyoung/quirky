import { ipcMain } from 'electron'
import type {
  QuirkydManagedConversionResult,
  QuirkydManagedPendingMigrationRow
} from '../../../shared/quirkyd-managed-runtime'
import { listPendingManagedQuirkydMigrations } from '../../managed-server/lifecycle/quirkyd-managed-migration-status'
import { convertSshTargetToManagedQuirkyd } from '../../managed-server/lifecycle/quirkyd-runtime-conversion'
import { conversionCollaborators } from '../../managed-server/lifecycle/quirkyd-runtime-conversion-wiring'
import { requiredString } from './quirkyd-runtime-lifecycle-handlers'

export function registerQuirkydRuntimeConversionHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:convertSshHostToManagedQuirkyd',
    (
      _event,
      args: { sshTargetId: string; name: string }
    ): Promise<QuirkydManagedConversionResult> => {
      return convertSshTargetToManagedQuirkyd(getUserDataPath(), {
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        name: requiredString(args?.name, 'Server name'),
        ...conversionCollaborators()
      })
    }
  )
  ipcMain.handle(
    'runtimeEnvironments:listPendingQuirkydMigrations',
    (): QuirkydManagedPendingMigrationRow[] =>
      listPendingManagedQuirkydMigrations(getUserDataPath())
  )
}
