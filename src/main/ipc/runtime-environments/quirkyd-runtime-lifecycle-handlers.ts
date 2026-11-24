import { ipcMain } from 'electron'
import type { QuirkydManagedRuntimeStatus } from '../../../shared/quirkyd-managed-runtime'
import { createManagedQuirkydEnvironment } from '../../managed-server/lifecycle/quirkyd-runtime-deployment'
import { getManagedQuirkydRuntimeStatus } from '../../managed-server/lifecycle/quirkyd-runtime-status'
import { registerQuirkydSshProvisioningHandlers } from './quirkyd-ssh-provisioning-handlers'

export function registerQuirkydRuntimeLifecycleHandlers(options: {
  getUserDataPath: () => string
}): void {
  registerQuirkydSshProvisioningHandlers(options.getUserDataPath)
  ipcMain.handle(
    'runtimeEnvironments:deployQuirkyd',
    async (_event, args: { name: string; sshTargetId: string; force?: boolean }) =>
      createManagedQuirkydEnvironment(options.getUserDataPath(), {
        name: requiredString(args?.name, 'Server name'),
        sshTargetId: requiredString(args?.sshTargetId, 'SSH target'),
        force: args?.force === true
      })
  )
  ipcMain.handle(
    'runtimeEnvironments:getQuirkydStatus',
    (_event, args: { selector: string }): Promise<QuirkydManagedRuntimeStatus> =>
      getManagedQuirkydRuntimeStatus(
        options.getUserDataPath(),
        requiredString(args?.selector, 'Server')
      )
  )
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required.`)
  }
  return value.trim()
}
