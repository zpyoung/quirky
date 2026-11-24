import { ipcRenderer } from 'electron'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import type { PreloadApi } from '../api-types'

export const cliApi = {
  getInstallStatus: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:getInstallStatus'),
  install: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:install'),
  remove: (): Promise<CliInstallStatus> => ipcRenderer.invoke('cli:remove')
} satisfies PreloadApi['cli']
