import { ipcMain } from 'electron'
import type { QuirkydSshProvisioningRequest } from '../../../shared/quirkyd-ssh-provisioning'
import {
  createQuirkydSshHost,
  listPendingQuirkydSshProvisioning,
  resumeQuirkydSshHost
} from '../../ssh/quirkyd-ssh-provisioning'

export function registerQuirkydSshProvisioningHandlers(getUserDataPath: () => string): void {
  ipcMain.handle(
    'runtimeEnvironments:createQuirkydSshHost',
    (_event, args: QuirkydSshProvisioningRequest) => createQuirkydSshHost(getUserDataPath(), args)
  )
  ipcMain.handle(
    'runtimeEnvironments:resumeQuirkydSshHost',
    (_event, args: { requestId: string }) =>
      resumeQuirkydSshHost(getUserDataPath(), args?.requestId)
  )
  ipcMain.handle('runtimeEnvironments:listPendingQuirkydSshProvisioning', () =>
    listPendingQuirkydSshProvisioning(getUserDataPath())
  )
}
