import type { CliInstallStatus } from '../../shared/cli-install-types'
import { CliCommandInstallation } from './cli-command-installation'
import { samePathEntry, splitPathEntries } from './cli-install-path-format'

export class CliPathRegistration extends CliCommandInstallation {
  protected async probePathConfiguration(
    pathDirectory: string
  ): Promise<{ configured: boolean | null; detail: string | null }> {
    return {
      configured: splitPathEntries(this.platform, this.processPathEnv ?? '').some((entry) =>
        samePathEntry(this.platform, entry, pathDirectory)
      ),
      detail: null
    }
  }

  protected withPathInfo(
    status: CliInstallStatus,
    pathDirectory: string,
    pathProbe: { configured: boolean | null; detail: string | null }
  ): CliInstallStatus {
    const { configured: pathConfigured } = pathProbe
    if (status.state !== 'installed' || pathConfigured) {
      return {
        ...status,
        pathDirectory,
        pathConfigured
      }
    }

    return {
      ...status,
      pathDirectory,
      pathConfigured,
      detail: `${status.commandPath} is registered. Restart your shell if the command is not visible yet.`
    }
  }
}
