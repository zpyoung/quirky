import { isRecord } from './loop-status'

/** Retains unknown field types while converting the shared object guard into a nullable view. */
export function recordOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null
}
