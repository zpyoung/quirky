import { accessSync, constants, statSync } from 'node:fs'
import { chromium } from 'playwright'

export const BROWSER_CANDIDATES: readonly string[] = [
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

/** Playwright's checked-in executable wins; installed candidates are only a fallback. */
export function resolveBrowserExecutable(bundledPath: string | undefined, lookup = isExecutableFile): string {
  if (bundledPath && lookup(bundledPath)) return bundledPath
  for (const candidate of BROWSER_CANDIDATES) if (lookup(candidate)) return candidate
  const attempted = bundledPath ? [bundledPath, ...BROWSER_CANDIDATES] : BROWSER_CANDIDATES
  throw new Error(`No executable Chrome or Chromium was found (checked ${attempted.join(', ')}).`)
}

export function browserExecutable(lookup = isExecutableFile): string {
  let bundledPath: string | undefined
  try {
    bundledPath = chromium.executablePath()
  } catch {
    bundledPath = undefined
  }
  return resolveBrowserExecutable(bundledPath, lookup)
}
