export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
}

export function nonEmptyString(value: unknown, max = 2048): value is string {
  return typeof value === 'string' && value.trim() !== '' && value.length <= max
}
