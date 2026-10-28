import type { Json } from './contracts'
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isJsonValue(value: unknown, ancestors = new Set<object>()): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || ancestors.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) return false
  ancestors.add(value)
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, ancestors))
    : Object.entries(value).every(([, item]) => isJsonValue(item, ancestors))
  ancestors.delete(value)
  return valid
}
