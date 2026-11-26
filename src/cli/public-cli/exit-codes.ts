import { matchAutomationOwnerConflict } from '../../shared/automation-owner-conflict'
import { EXIT_CODE, normalizeErrorCode } from '../../shared/public-rpc/error-contract'
import { RuntimeClientError } from '../runtime/types'

/** The code an error carries before normalization; anything that is not a client error is `runtime_error`. */
export function rawCliErrorCode(error: unknown): string {
  return (
    matchAutomationOwnerConflict(error) ??
    (error instanceof RuntimeClientError ? error.code : 'runtime_error')
  )
}

/** The process exit code for a failure: the stable contract's code for whatever legacy code was thrown. */
export function exitCodeFor(error: unknown): number {
  return EXIT_CODE[normalizeErrorCode(rawCliErrorCode(error)).code]
}
