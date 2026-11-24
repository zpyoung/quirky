import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  resolveLocalAccountRuntimeTarget,
  type LocalAccountRuntimeTarget
} from '../../shared/local-account-runtime'
import type { GlobalSettings } from '../../shared/global-settings-types'

export type KimiHomeResolution = LocalAccountRuntimeTarget & {
  /** null when the distro is missing or stopped, or its home could not be probed. */
  path: string | null
}

// Why: match the CLI's `KIMI_CODE_HOME ?? ~/.kimi-code` resolution so we read the
// same files the running Kimi CLI writes.
export function getHostKimiHome(): string {
  return process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code')
}

/**
 * Kimi has no per-account runtime switcher, so it follows the local-account
 * runtime policy. WSL is Windows-only — pin everywhere else so no `wsl.exe`
 * probe is attempted on a stale `wsl` setting synced from a Windows machine.
 */
export function getKimiRuntimeTarget(
  settings: GlobalSettings,
  platform: NodeJS.Platform = process.platform
): LocalAccountRuntimeTarget {
  if (platform !== 'win32') {
    return { runtime: 'host', wslDistro: null }
  }
  return resolveLocalAccountRuntimeTarget(settings, platform)
}

/**
 * Resolve a runtime target to the Kimi home Orca should read (UNC path for WSL).
 * Async because it runs on every quota poll: the sync `wsl.exe` probes park
 * Electron's main process for up to 5s each cycle while a distro is stopped.
 */
export async function resolveKimiHome(
  _target: LocalAccountRuntimeTarget,
  _platform: NodeJS.Platform = process.platform
): Promise<KimiHomeResolution> {
  return { runtime: 'host', wslDistro: null, path: getHostKimiHome() }
}
