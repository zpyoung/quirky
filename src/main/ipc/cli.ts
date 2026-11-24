import { ipcMain } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliInstaller } from '../cli/cli-installer'
import { runKeyedSerializedOperation } from '../cli/keyed-promise-queue'
import { hydrateShellPath, mergePathSegments } from '../startup/hydrate-shell-path'

const localCliRegistrationQueues = new Map<string, Promise<void>>()

function runLocalCliRegistrationOperation<T>(operation: () => Promise<T>): Promise<T> {
  return runKeyedSerializedOperation(localCliRegistrationQueues, 'local', operation)
}

async function hydrateLocalShellPathForCli(force = false): Promise<void> {
  if (process.platform === 'win32') {
    return
  }
  // Why: CLI registration must match `which orca` in the user's terminal, not
  // the sparse PATH a GUI-launched Electron process inherited from launchd.
  const hydration = await hydrateShellPath(force ? { force: true } : undefined)
  if (hydration.ok) {
    mergePathSegments(hydration.segments)
  }
}

export function registerCliHandlers(): void {
  ipcMain.handle('cli:getInstallStatus', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    return new CliInstaller().getStatus()
  })

  ipcMain.handle('cli:install', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli(true)
    return runLocalCliRegistrationOperation(() => new CliInstaller().install())
  })

  ipcMain.handle('cli:remove', async (): Promise<CliInstallStatus> => {
    await hydrateLocalShellPathForCli()
    return runLocalCliRegistrationOperation(() => new CliInstaller().remove())
  })
}
