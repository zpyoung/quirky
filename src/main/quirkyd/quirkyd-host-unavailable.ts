/**
 * Deploy failures that mean managed quirkyd can't run on this host at all, as opposed to failures
 * a later connect may not hit again. Only these send a host back to the pinned-relay ladder.
 */

/** No quirkyd build exists for this host's platform or target. */
export class QuirkydHostUnsupportedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuirkydHostUnsupportedError'
  }
}

/** This build carries no quirkyd template (dev builds): retried once the app version changes. */
export class QuirkydArtifactsUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuirkydArtifactsUnavailableError'
  }
}

/** The host refuses port forwarding and can't run the stdio bridge either. */
export class QuirkydStdioBridgeUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuirkydStdioBridgeUnavailableError'
  }
}

export const QUIRKYD_TUNNEL_UNAVAILABLE_REASON = 'ssh_tunnel_unavailable'
export const QUIRKYD_WINDOWS_LAUNCH_REFUSED_CODE = 'quirkyd_windows_launch_refused'
export const QUIRKYD_WINDOWS_COMMAND_LINE_UNSAFE_CODE = 'quirkyd_windows_command_line_unsafe'

export type QuirkydHostUnavailableReason =
  | 'unsupported_host'
  | 'artifacts_unavailable'
  | 'libc_unidentified'
  | 'runtime_self_test'
  | 'runtime_noexec'
  | 'security_software'
  | 'native_preflight'
  | typeof QUIRKYD_TUNNEL_UNAVAILABLE_REASON

const UNAVAILABLE_BY_ERROR_NAME: Record<string, QuirkydHostUnavailableReason> = {
  QuirkydHostUnsupportedError: 'unsupported_host',
  QuirkydArtifactsUnavailableError: 'artifacts_unavailable',
  QuirkydRemoteLaunchUnsupportedError: 'unsupported_host',
  UnidentifiedHostLibcError: 'libc_unidentified',
  RemoteNodeRuntimeSelfTestError: 'runtime_self_test',
  RemoteNodeRuntimeNoexecError: 'runtime_noexec',
  RemoteNodeRuntimeSecurityModifiedError: 'security_software',
  QuirkydStdioBridgeUnavailableError: QUIRKYD_TUNNEL_UNAVAILABLE_REASON,
  QuirkydWindowsLaunchRefusedError: 'unsupported_host',
  QuirkydWindowsCommandLineError: 'unsupported_host'
}

// Why only these deferrals: the candidate's native preflight (libc floor, missing libraries), its
// PTY self-test and a Windows launch refusal fail the same way on every retry; races don't.
const UNAVAILABLE_BY_DEFERRAL_CODE: Record<string, QuirkydHostUnavailableReason> = {
  quirkyd_candidate_preflight_failed: 'native_preflight',
  quirkyd_activation_pty_self_test_failed: 'native_preflight',
  [QUIRKYD_WINDOWS_LAUNCH_REFUSED_CODE]: 'unsupported_host',
  [QUIRKYD_WINDOWS_COMMAND_LINE_UNSAFE_CODE]: 'unsupported_host'
}

/** Host settings the user can change, so a later connect checks again instead of remembering it. */
export function isQuirkydHostUnavailableFixableOnHost(reason: string): boolean {
  return reason === 'runtime_noexec'
}

/** The deferral code for a candidate launch failure, keeping the permanent Windows refusals. */
export function quirkydCandidateLaunchFailureCode(error: unknown): string {
  const code = error instanceof Error && 'code' in error ? error.code : undefined
  return code === QUIRKYD_WINDOWS_LAUNCH_REFUSED_CODE ||
    code === QUIRKYD_WINDOWS_COMMAND_LINE_UNSAFE_CODE
    ? code
    : 'quirkyd_candidate_launch_failed'
}

export function classifyQuirkydHostUnavailable(
  failure: unknown
): QuirkydHostUnavailableReason | null {
  if (failure instanceof Error) {
    return UNAVAILABLE_BY_ERROR_NAME[failure.name] ?? null
  }
  if (failure && typeof failure === 'object' && 'code' in failure) {
    const code = failure.code
    return typeof code === 'string' ? (UNAVAILABLE_BY_DEFERRAL_CODE[code] ?? null) : null
  }
  return null
}
