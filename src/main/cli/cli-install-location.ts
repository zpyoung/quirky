import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { getAppEnvironment } from '../../shared/app-environment'
import type { CliInstallStatus } from '../../shared/cli-install-types'
import { getBundledLauncherPath } from './bundled-cli-launcher-path'
import { DEFAULT_MAC_COMMAND_PATH, DEV_COMMAND_NAME } from './cli-install-constants'
import { ensureDevLauncher } from './cli-dev-launcher'
import type { CliInstallerOptions, InstallSpec } from './cli-installer-contracts'
import {
  isExecutableFile,
  samePathEntry,
  splitPathEntries,
  uniquePathEntries
} from './cli-install-path-format'
import { runMacPrivilegedCommand } from './cli-privileged-processes'

export abstract class CliInstallLocation {
  protected abstract inspectSymlink(
    commandPath: string,
    launcherPath: string
  ): Promise<CliInstallStatus>

  protected readonly platform: NodeJS.Platform
  protected readonly isPackaged: boolean
  protected readonly userDataPath: string
  protected readonly resourcesPath: string
  protected readonly execPathValue: string
  protected readonly appPathValue: string
  protected readonly homePath: string
  protected readonly processPathEnv: string | null
  protected readonly commandPathOverride: string | null
  protected readonly macCommandPath: string
  protected readonly privilegedRunner: (command: string) => Promise<void>

  protected get commandName(): string {
    if (!this.isPackaged && !this.commandPathOverride) {
      // Why: development builds must not claim the production shell command.
      return DEV_COMMAND_NAME
    }
    return 'quirky'
  }

  constructor(options: CliInstallerOptions = {}) {
    this.platform = options.platform ?? process.platform
    this.isPackaged = options.isPackaged ?? getAppEnvironment().isPackaged()
    this.userDataPath = options.userDataPath ?? getAppEnvironment().getPath('userData')
    this.resourcesPath = options.resourcesPath ?? process.resourcesPath
    this.execPathValue = options.execPath ?? process.execPath
    this.appPathValue = options.appPath ?? getAppEnvironment().getAppPath()
    this.homePath = options.homePath ?? homedir()
    this.processPathEnv = options.processPathEnv ?? process.env.PATH ?? process.env.Path ?? null
    this.commandPathOverride =
      options.commandPathOverride ?? process.env.QUIRKY_CLI_INSTALL_PATH ?? null
    // Why: resolved once here (getStatus is hot); /usr/local/bin is absent on Apple Silicon, so fall back to user-writable ~/.local/bin.
    const candidateMacPath = options.defaultMacCommandPath ?? DEFAULT_MAC_COMMAND_PATH
    this.macCommandPath = existsSync(dirname(candidateMacPath))
      ? candidateMacPath
      : join(this.homePath, '.local', 'bin', 'quirky')
    this.privilegedRunner = options.privilegedRunner ?? runMacPrivilegedCommand
  }

  protected resolveInstallSpec(): InstallSpec | null {
    const commandPath = this.resolveCommandPath()
    if (!commandPath) {
      return null
    }

    if (this.platform === 'darwin') {
      return {
        commandPath,
        installMethod: 'symlink'
      }
    }

    return null
  }

  protected async resolveActiveInstallSpec(
    defaultSpec: InstallSpec,
    launcherPath: string
  ): Promise<InstallSpec> {
    if (
      this.commandPathOverride ||
      this.platform !== 'darwin' ||
      defaultSpec.installMethod !== 'symlink'
    ) {
      return defaultSpec
    }

    const activeCommandPath = await this.findActivePathCommand(
      launcherPath,
      defaultSpec.commandPath
    )
    return activeCommandPath
      ? {
          commandPath: activeCommandPath,
          installMethod: defaultSpec.installMethod
        }
      : defaultSpec
  }

  protected async findActivePathCommand(
    launcherPath: string,
    defaultCommandPath: string
  ): Promise<string | null> {
    let reachedDefaultCommandPath = false
    for (const commandPath of this.getPathCommandCandidates(defaultCommandPath)) {
      const isDefaultCommandPath = samePathEntry(this.platform, commandPath, defaultCommandPath)
      reachedDefaultCommandPath ||= isDefaultCommandPath

      if (!(await isExecutableFile(commandPath))) {
        continue
      }

      const status = await this.inspectSymlink(commandPath, launcherPath)
      if (status.state !== 'not_installed') {
        if (reachedDefaultCommandPath && !isDefaultCommandPath && status.state === 'conflict') {
          // Why: a non-Quirky command after an empty default slot can be shadowed by installing there; no user file replaced.
          continue
        }
        // Why: PATH lookup is first-match-wins; return the command the shell will actually run, preserving shadowing conflicts.
        return commandPath
      }
    }
    return null
  }

  protected getPathCommandCandidates(defaultCommandPath: string): string[] {
    const commandName = basename(defaultCommandPath)
    const pathCandidates = splitPathEntries(this.platform, this.processPathEnv ?? '').map((entry) =>
      join(entry, commandName)
    )
    return uniquePathEntries(this.platform, pathCandidates)
  }

  protected resolveCommandPath(): string | null {
    if (this.commandPathOverride) {
      return this.commandPathOverride
    }

    if (!this.isPackaged) {
      // Why: dev uses a separate command; tests/diagnostics still reach production paths via commandPathOverride.
      if (this.platform === 'darwin') {
        return `/usr/local/bin/${DEV_COMMAND_NAME}`
      }
    }

    if (this.platform === 'darwin') {
      return this.macCommandPath
    }

    return null
  }

  protected async resolveLauncherPath(): Promise<string | null> {
    if (this.platform !== 'darwin') {
      return null
    }

    if (this.isPackaged) {
      const bundledPath = getBundledLauncherPath(this.platform, this.resourcesPath)
      return bundledPath && existsSync(bundledPath) ? bundledPath : null
    }

    return ensureDevLauncher({
      platform: this.platform,
      userDataPath: this.userDataPath,
      execPath: this.execPathValue,
      cliEntryPath: join(this.appPathValue, 'out', 'cli', 'index.js'),
      commandName: this.commandName
    })
  }
}
