import { matchAutomationOwnerConflict } from '../../shared/automation-owner-conflict'
import { EXIT_CODE, normalizeErrorCode } from '../../shared/public-rpc/error-contract'

// duck-typed so a client error from a mocked or duplicated runtime-client module still counts
function codeOf(value: unknown): string | undefined {
  if (typeof value === 'object' && value !== null && 'code' in value) {
    return typeof value.code === 'string' ? value.code : undefined
  }
  return undefined
}

function carriedErrorCode(error: unknown): string | undefined {
  const direct = codeOf(error)
  if (direct !== undefined) {
    return direct
  }
  if (typeof error === 'object' && error !== null && 'response' in error) {
    const response = error.response
    if (typeof response === 'object' && response !== null && 'error' in response) {
      return codeOf(response.error)
    }
  }
  return undefined
}

/** The code an error carries before normalization; anything that carries no code is `runtime_error`. */
export function rawCliErrorCode(error: unknown): string {
  return matchAutomationOwnerConflict(error) ?? carriedErrorCode(error) ?? 'runtime_error'
}

/** The process exit code for a failure: the stable contract's code for whatever legacy code was thrown. */
export function exitCodeFor(error: unknown): number {
  return EXIT_CODE[normalizeErrorCode(rawCliErrorCode(error)).code]
}
