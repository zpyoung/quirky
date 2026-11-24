import { ipcMain } from 'electron'
import { registerManagedServerActions } from '../../runtime/managed-server-actions-registry'
import {
  createManagedQuirkydActions,
  restartManagedQuirkyd,
  type ManagedQuirkydActionOptions
} from './managed-quirkyd-actions'
import { requiredString } from './quirkyd-runtime-lifecycle-handlers'

export function registerQuirkydRuntimeMaintenanceHandlers(
  options: ManagedQuirkydActionOptions
): void {
  const actions = createManagedQuirkydActions(options)
  // Why: the CLI reaches these same actions over runtime RPC (managedServer.*).
  registerManagedServerActions(actions)
  ipcMain.handle(
    'runtimeEnvironments:updateQuirkyd',
    async (_event, args: { selector: string; force?: boolean }) =>
      actions.update(requiredString(args?.selector, 'Server'), args?.force === true)
  )
  ipcMain.handle(
    'runtimeEnvironments:rollbackQuirkyd',
    async (_event, args: { selector: string }) =>
      actions.rollback(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:recoverQuirkyd',
    async (_event, args: { selector: string; acceptChangedState?: boolean }) =>
      actions.recover(requiredString(args?.selector, 'Server'), args?.acceptChangedState === true)
  )
  ipcMain.handle('runtimeEnvironments:restartQuirkyd', async (_event, args: { selector: string }) =>
    restartManagedQuirkyd(options, requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:stopQuirkyd', async (_event, args: { selector: string }) =>
    actions.stop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle(
    'runtimeEnvironments:cancelQuirkydStop',
    async (_event, args: { selector: string }) =>
      actions.cancelStop(requiredString(args?.selector, 'Server'))
  )
  ipcMain.handle('runtimeEnvironments:forgetQuirkyd', async (_event, args: { selector: string }) =>
    actions.forget(requiredString(args?.selector, 'Server'))
  )
}
