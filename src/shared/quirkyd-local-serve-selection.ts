/**
 * The contract between `quirky serve` (CLI) and the app-side entry that decides whether this
 * machine can serve on quirkyd. The CLI never loads that logic: it runs the packaged app's
 * `out/main/<QUIRKYD_LOCAL_SERVE_SELECTION_ENTRY>.js` under ELECTRON_RUN_AS_NODE and reads one line.
 */
export const SERVE_RUNTIME_ENV = 'QUIRKY_SERVE_RUNTIME'
/** `QUIRKY_SERVE_RUNTIME=electron` keeps `quirky serve` on Electron; quirkyd is the default. */
export const SERVE_RUNTIME_ELECTRON = 'electron'
export const QUIRKYD_LOCAL_SERVE_SELECTION_ENTRY = 'quirkyd/quirkyd-local-serve-selection-entry'
export const QUIRKYD_LOCAL_SERVE_SELECTION_FLAGS = {
  userData: '--user-data',
  appRoot: '--app-root'
} as const
const RESULT_MARKER = 'QUIRKY_SERVE_RUNTIME'

export type ServeRuntimeSelection =
  | { kind: 'quirkyd'; runtime: string; entry: string; version: string }
  /** `reason` is null when Electron was asked for explicitly, so nothing is printed. */
  | { kind: 'electron'; reason: string | null }

export function formatServeRuntimeSelection(selection: ServeRuntimeSelection): string {
  return `${RESULT_MARKER} ${JSON.stringify(selection)}`
}

/** The last result line in `output`, or null when none parses. */
export function parseServeRuntimeSelection(output: string): ServeRuntimeSelection | null {
  const line = output
    .split(/\r?\n/u)
    .findLast((candidate) => candidate.startsWith(`${RESULT_MARKER} `))
  if (!line) {
    return null
  }
  try {
    const parsed: unknown = JSON.parse(line.slice(RESULT_MARKER.length + 1))
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) {
      return null
    }
    const record = Object.fromEntries(Object.entries(parsed))
    if (
      record.kind === 'quirkyd' &&
      typeof record.runtime === 'string' &&
      typeof record.entry === 'string' &&
      typeof record.version === 'string'
    ) {
      return {
        kind: 'quirkyd',
        runtime: record.runtime,
        entry: record.entry,
        version: record.version
      }
    }
    if (record.kind === 'electron') {
      return { kind: 'electron', reason: typeof record.reason === 'string' ? record.reason : null }
    }
    return null
  } catch {
    return null
  }
}
