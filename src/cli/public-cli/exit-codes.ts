import { matchAutomationOwnerConflict } from '../../shared/automation-owner-conflict'
import { EXIT_CODE, normalizeErrorCode } from '../../shared/public-rpc/error-contract'

// duck-typed so a client error from a mocked or duplicated runtime-client module still counts
function stringProperty(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object') {
    return undefined
  }
  const property: unknown = Reflect.get(value, key)
  return typeof property === 'string' ? property : undefined
}

function carriedErrorCode(error: unknown): string | undefined {
  const direct = stringProperty(error, 'code')
  if (direct !== undefined) {
    return direct
  }
  if (error === null || typeof error !== 'object') {
    return undefined
  }
  const response: unknown = Reflect.get(error, 'response')
  if (response === null || typeof response !== 'object') {
    return undefined
  }
  return stringProperty(Reflect.get(response, 'error'), 'code')
}

/** The code an error carries before normalization; anything that carries no code is `runtime_error`. */
export function rawCliErrorCode(error: unknown): string {
  return matchAutomationOwnerConflict(error) ?? carriedErrorCode(error) ?? 'runtime_error'
}

/** The process exit code for a failure: the stable contract's code for whatever legacy code was thrown. */
export function exitCodeFor(error: unknown): number {
  return EXIT_CODE[normalizeErrorCode(rawCliErrorCode(error)).code]
}
