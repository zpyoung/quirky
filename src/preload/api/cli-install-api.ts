import type { CliInstallStatus } from '../../shared/cli-install-types'

export type CliApi = {
  getInstallStatus: () => Promise<CliInstallStatus>
  install: () => Promise<CliInstallStatus>
  remove: () => Promise<CliInstallStatus>
}
