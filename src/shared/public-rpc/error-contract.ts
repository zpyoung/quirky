/**
 * The public CLI/API error vocabulary: eight stable codes with fixed exit codes, plus the mapping
 * from the legacy codes the runtime already throws. Agents branch on `code`; `reason` keeps the
 * legacy detail.
 */

export type StableErrorCode =
  | 'internal'
  | 'invalid_argument'
  | 'not_found'
  | 'needs_confirmation'
  | 'conflict'
  | 'unavailable'
  | 'timeout'
  | 'unauthorized'

export const EXIT_CODE: Record<StableErrorCode, 1 | 2 | 3 | 4 | 5 | 6> = {
  internal: 1,
  invalid_argument: 2,
  not_found: 3,
  needs_confirmation: 4,
  conflict: 5,
  unavailable: 6,
  timeout: 6,
  unauthorized: 6
}

/** A suggested follow-up command an agent can run after a failure. */
export type NextStep = { command: string; why: string }

const STABLE_CODES: ReadonlySet<string> = new Set(Object.keys(EXIT_CODE))

const LEGACY_CODE_TO_STABLE: Readonly<Record<string, { code: StableErrorCode; reason?: string }>> =
  {
    invalid_argument: { code: 'invalid_argument' },
    selector_not_found: { code: 'not_found' },
    repo_not_found: { code: 'not_found' },
    run_not_found: { code: 'not_found' },
    task_not_found: { code: 'not_found' },
    terminal_not_found: { code: 'not_found' },
    tab_not_found: { code: 'not_found' },
    method_not_found: { code: 'unavailable', reason: 'capability_missing' },
    capability_unsupported: { code: 'unavailable', reason: 'capability_missing' },
    method_not_supported: { code: 'unavailable', reason: 'capability_missing' },
    runtime_unavailable: { code: 'unavailable' },
    no_active_terminal: { code: 'unavailable' },
    renderer_unavailable: { code: 'unavailable' },
    timeout: { code: 'timeout' },
    runtime_timeout: { code: 'timeout' },
    unauthorized: { code: 'unauthorized' },
    forbidden: { code: 'unauthorized' },
    runtime_access_denied: { code: 'unauthorized' },
    confirmation_required: { code: 'needs_confirmation' },
    selector_ambiguous: { code: 'conflict' },
    terminal_handle_stale: { code: 'conflict' },
    stale_delivery: { code: 'conflict' },
    conflict: { code: 'conflict' }
  }

/**
 * Maps any code the runtime or CLI emits to a stable code and a reason. Stable codes map to
 * themselves with the code as reason; unknown codes become `internal` and keep the original code
 * as the reason so nothing is lost.
 */
export function normalizeErrorCode(code: string): { code: StableErrorCode; reason: string } {
  const legacy = Object.hasOwn(LEGACY_CODE_TO_STABLE, code)
    ? LEGACY_CODE_TO_STABLE[code]
    : undefined
  if (legacy) {
    return { code: legacy.code, reason: legacy.reason ?? code }
  }
  if (STABLE_CODES.has(code)) {
    return { code: code as StableErrorCode, reason: code }
  }
  return { code: 'internal', reason: code }
}

const CODES_REQUIRING_NEXT: ReadonlySet<StableErrorCode> = new Set([
  'not_found',
  'needs_confirmation',
  'conflict',
  'unavailable'
])

/** Whether an error with this code must carry a non-empty `next` step. */
export function requiresNext(code: StableErrorCode): boolean {
  return CODES_REQUIRING_NEXT.has(code)
}
