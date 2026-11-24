import { existsSync } from 'node:fs'
import { lstat, readFile, readlink } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { CliInstallMethod, CliInstallStatus } from '../../shared/cli-install-types'
import { DEV_COMMAND_NAME, DEV_LAUNCHER_DIR } from './cli-install-constants'
import { extractManagedUnixLauncherTarget } from './cli-dev-launcher'
import { isPermissionError } from '../../shared/permission-error'
import { isMissingError } from './cli-install-errors'
import { CliInstallLocation } from './cli-install-location'
import { isPathInsideOrEqual } from './cli-install-path-format'

export class CliCommandInspection extends CliInstallLocation {
  protected async inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus> {
    try {
      const stats = await lstat(commandPath)
      if (!stats.isSymbolicLink()) {
        if (stats.isFile()) {
          const currentContent = await readFile(commandPath, 'utf8')
          const managedTarget = extractManagedUnixLauncherTarget(currentContent)
          if (managedTarget) {
            return this.buildStatus({
              commandPath,
              launcherPath,
              installMethod: 'symlink',
              supported: true,
              state: 'stale',
              currentTarget: managedTarget,
              detail: `${commandPath} contains an older Orca launcher.`
            })
          }
        }

        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'conflict',
          currentTarget: null,
          detail: `${commandPath} exists but is not an Orca symlink.`
        })
      }

      let currentTarget: string
      try {
        currentTarget = await readlink(commandPath)
      } catch (error) {
        if (!isPermissionError(error)) {
          throw error
        }
        // Why: macOS enforces a symlink's own mode on readlink. Older Orca published the root-owned link
        // as 0700 under umask 077, so only the privileged transaction can read and replace it.
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'stale',
          currentTarget: null,
          detail: `${commandPath} cannot be read. Register again to repair it.`
        })
      }
      const resolvedCurrentTarget = resolve(dirname(commandPath), currentTarget)
      const resolvedLauncher = resolve(launcherPath)
      const isInstalled = resolvedCurrentTarget === resolvedLauncher && existsSync(resolvedLauncher)
      const isManagedStaleTarget =
        !isInstalled &&
        (resolvedCurrentTarget === resolvedLauncher ||
          this.isManagedSymlinkTarget(resolvedCurrentTarget, launcherPath))
      return this.buildStatus({
        commandPath,
        launcherPath,
        installMethod: 'symlink',
        supported: true,
        state: isInstalled ? 'installed' : isManagedStaleTarget ? 'stale' : 'conflict',
        currentTarget: resolvedCurrentTarget,
        detail: isInstalled
          ? `Registered at ${commandPath}.`
          : isManagedStaleTarget
            ? `${commandPath} points to an older Orca launcher.`
            : `${commandPath} points to a non-Orca launcher.`
      })
    } catch (error) {
      if (isMissingError(error)) {
        return this.buildStatus({
          commandPath,
          launcherPath,
          installMethod: 'symlink',
          supported: true,
          state: 'not_installed',
          currentTarget: null,
          detail: `Register ${commandPath} to use Orca from the terminal.`
        })
      }
      throw error
    }
  }

  protected isManagedSymlinkTarget(resolvedTarget: string, launcherPath: string): boolean {
    const expectedName = basename(launcherPath)
    if (this.isPackaged && this.isSiblingDevLauncherTarget(resolvedTarget, expectedName)) {
      return true
    }

    if (basename(resolvedTarget) !== expectedName) {
      return false
    }

    const devLauncherDir = resolve(this.userDataPath, ...DEV_LAUNCHER_DIR)
    if (isPathInsideOrEqual(devLauncherDir, resolvedTarget)) {
      return true
    }

    if (this.platform === 'darwin') {
      // Why: reclaim symlinks to an older Orca.app launcher, but never replace arbitrary user-owned symlinks.
      return /(?:^|[/\\])[^/\\]+\.app[/\\]Contents[/\\]Resources[/\\]bin[/\\][^/\\]+$/.test(
        resolvedTarget
      )
    }

    return false
  }

  protected isSiblingDevLauncherTarget(
    resolvedTarget: string,
    packagedLauncherName: string
  ): boolean {
    if (![packagedLauncherName, DEV_COMMAND_NAME].includes(basename(resolvedTarget))) {
      return false
    }

    const packagedUserDataPath = resolve(this.userDataPath)
    const siblingDevUserDataPath = `${packagedUserDataPath}-dev`
    const siblingDevLauncherDir = resolve(siblingDevUserDataPath, ...DEV_LAUNCHER_DIR)

    // Why: dev builds generate launchers under the sibling `*-dev` profile; packaged Orca must reclaim that command.
    return (
      basename(siblingDevUserDataPath) === `${basename(packagedUserDataPath)}-dev` &&
      isPathInsideOrEqual(siblingDevLauncherDir, resolvedTarget)
    )
  }

  protected buildStatus(args: {
    commandPath: string
    launcherPath: string
    installMethod: CliInstallMethod
    supported: boolean
    state: CliInstallStatus['state']
    currentTarget: string | null
    detail: string | null
  }): CliInstallStatus {
    return {
      platform: this.platform,
      commandName: this.commandName,
      commandPath: args.commandPath,
      pathDirectory: dirname(args.commandPath),
      pathConfigured: false,
      launcherPath: args.launcherPath,
      installMethod: args.installMethod,
      supported: args.supported,
      state: args.state,
      currentTarget: args.currentTarget,
      unsupportedReason: null,
      detail: args.detail
    }
  }
}
