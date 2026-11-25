import type { ViewValidationError } from './view-spec-types'

/** Mutable state threaded through one validation run. */
export type Check = {
  errors: ViewValidationError[]
  fieldIds: Set<string>
  ids: Set<string>
  nodes: number
  nodeLimitHit: boolean
}

export function newCheck(): Check {
  return { errors: [], fieldIds: new Set(), ids: new Set(), nodes: 0, nodeLimitHit: false }
}

export function addError(check: Check, path: string, message: string): void {
  check.errors.push({ path, message })
}

export function checkKeys(
  raw: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  check: Check
): void {
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) {
      addError(
        check,
        path ? `${path}.${key}` : key,
        `unknown field '${key}'; allowed: ${allowed.join(', ') || 'none'}`
      )
    }
  }
}

export const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function shorten(text: string): string {
  return text.length > 40 ? `${text.slice(0, 40)}...` : text
}

/** The UTF-8 size of `text` in bytes; a lone surrogate counts as the 3 bytes of U+FFFD. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let at = 0; at < text.length; at++) {
    const code = text.charCodeAt(at)
    if (code < 0x80) {
      bytes += 1
    } else if (code < 0x800) {
      bytes += 2
    } else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      at + 1 < text.length &&
      (text.charCodeAt(at + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4
      at++
    } else {
      bytes += 3
    }
  }
  return bytes
}
