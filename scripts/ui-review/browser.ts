import { accessSync, constants, statSync } from 'node:fs'
import { chromium } from 'playwright'

export const CAPTURE_BROWSER_CANDIDATES: readonly string[] = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser'
]

function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** Finds an installed capture browser without downloading or opening one. */
export function captureBrowserExecutable(isExecutable = isExecutableFile): string {
  const candidates = [chromium.executablePath(), ...CAPTURE_BROWSER_CANDIDATES]
  const executable = candidates.find(isExecutable)
  if (!executable) throw new Error(`UI capture needs Chromium or Google Chrome; none of these exist: ${candidates.join(', ')}`)
  return executable
}
