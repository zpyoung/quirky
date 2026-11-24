import { parseWslUncPath } from '../shared/wsl-paths'

export { toLinuxPath, toWindowsWslPath } from '../shared/wsl-paths'
export type WslPathInfo = {
  distro: string
  linuxPath: string
}

/** Detect and parse a WSL UNC path on Windows. */
export function parseWslPath(windowsPath: string): WslPathInfo | null {
  if (process.platform !== 'win32') {
    return null
  }

  return parseWslUncPath(windowsPath)
}

export function isWslPath(path: string): boolean {
  return parseWslPath(path) !== null
}
