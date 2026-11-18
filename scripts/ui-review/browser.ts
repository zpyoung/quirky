import { BROWSER_CANDIDATES, browserExecutable } from '../test-support/browser'

export const CAPTURE_BROWSER_CANDIDATES: readonly string[] = BROWSER_CANDIDATES

/** Finds an installed capture browser without downloading or opening one. */
export function captureBrowserExecutable(isExecutable?: (path: string) => boolean): string {
  return browserExecutable(isExecutable)
}
