/**
 * `quirkyd.js --quirkyd-native-preflight`: the node-pty precondition quirkyd checks at boot, run on
 * its own so `quirky serve` can choose Electron before handing the terminal to an quirkyd that
 * would refuse to start. One JSON line on stdout, exit 0 whatever the verdict.
 */
export const QUIRKYD_NATIVE_PREFLIGHT_FLAG = '--quirkyd-native-preflight'
const REPORT_TYPE = 'quirkyd_native_preflight'

export type QuirkydNativePreflightReport = {
  type: typeof REPORT_TYPE
  status: 'ok' | 'degraded' | 'blocked' | 'unverifiable'
  reason: string | null
}

export function formatQuirkydNativePreflightReport(
  status: QuirkydNativePreflightReport['status'],
  reason: string | null
): string {
  return JSON.stringify({ type: REPORT_TYPE, status, reason })
}

/** The last report line in `output`, or null when none parses. */
export function parseQuirkydNativePreflightReport(
  output: string
): QuirkydNativePreflightReport | null {
  for (const line of output.split(/\r?\n/u).toReversed()) {
    try {
      const parsed: unknown = JSON.parse(line)
      if (
        parsed &&
        typeof parsed === 'object' &&
        'type' in parsed &&
        parsed.type === REPORT_TYPE &&
        'status' in parsed &&
        (parsed.status === 'ok' ||
          parsed.status === 'degraded' ||
          parsed.status === 'blocked' ||
          parsed.status === 'unverifiable')
      ) {
        const reason =
          'reason' in parsed && typeof parsed.reason === 'string' ? parsed.reason : null
        return { type: REPORT_TYPE, status: parsed.status, reason }
      }
    } catch {
      // Not the report line.
    }
  }
  return null
}
