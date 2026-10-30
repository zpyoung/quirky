/** Native drops carry at most this many paths, as Orca caps them. */
export const MAX_DROP_SOURCE_PATHS = 256

/** How long a page drop waits for the native report of the same drop. */
export const DROP_SOURCE_PATHS_WAIT_MS = 500

/** How long an unclaimed native report stays matchable. */
export const DROP_SOURCE_PATHS_RETAIN_MS = 2_000

/**
 * The absolute paths in Electrobun's `drop-source-paths` webview event, or null when the event is
 * malformed. The event only ever comes from the native wrapper, never from page script.
 */
export function dropSourcePathsFromEvent(event: unknown): string[] | null {
  const detail = (event as { data?: { detail?: unknown } } | null)?.data?.detail
  const paths = (detail as { paths?: unknown } | null | undefined)?.paths
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_DROP_SOURCE_PATHS) return null
  if (!paths.every((path): path is string => typeof path === 'string' && path.startsWith('/') && !path.includes('\0'))) return null
  return paths
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).normalize('NFC')
}

/**
 * Pairs the page's dropped file names with one native drop's paths, returning the paths in file
 * order. Null unless every file has exactly one path of the same name and no path is left over.
 */
export function matchDropSourcePaths(fileNames: readonly string[], paths: readonly string[]): string[] | null {
  if (fileNames.length === 0 || fileNames.length !== paths.length) return null
  const remaining = [...paths]
  const matched: string[] = []
  for (const name of fileNames) {
    const index = remaining.findIndex((path) => basename(path) === name.normalize('NFC'))
    if (index === -1) return null
    matched.push(remaining.splice(index, 1)[0]!)
  }
  return matched
}

type Timers = {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

type Waiter = { fileNames: readonly string[]; resolve(paths: string[] | null): void; timer: unknown }

/**
 * Holds native drop reports until the page's drop claims them. The native report and the DOM drop
 * travel separately, so either may arrive first; each report is claimed at most once.
 */
export function createDropSourcePathsInbox(timers: Timers = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
}) {
  let reports: { paths: string[]; at: number }[] = []
  const waiters = new Set<Waiter>()

  const prune = () => {
    const cutoff = timers.now() - DROP_SOURCE_PATHS_RETAIN_MS
    reports = reports.filter((report) => report.at >= cutoff)
  }

  const claim = (fileNames: readonly string[]): string[] | null => {
    prune()
    for (let index = reports.length - 1; index >= 0; index--) {
      const matched = matchDropSourcePaths(fileNames, reports[index]!.paths)
      if (matched) {
        reports.splice(index, 1)
        return matched
      }
    }
    return null
  }

  return {
    receive(paths: string[]): void {
      reports.push({ paths, at: timers.now() })
      for (const waiter of waiters) {
        const matched = claim(waiter.fileNames)
        if (!matched) continue
        waiters.delete(waiter)
        timers.clearTimeout(waiter.timer)
        waiter.resolve(matched)
      }
    },
    take(fileNames: readonly string[]): Promise<string[] | null> {
      const matched = claim(fileNames)
      if (matched || fileNames.length === 0) return Promise.resolve(matched)
      return new Promise((resolve) => {
        const waiter: Waiter = { fileNames, resolve, timer: undefined }
        waiter.timer = timers.setTimeout(() => {
          waiters.delete(waiter)
          resolve(null)
        }, DROP_SOURCE_PATHS_WAIT_MS)
        waiters.add(waiter)
      })
    }
  }
}
