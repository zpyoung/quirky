/** Prop readers for view nodes. The daemon has already checked the spec; these keep a stored record that predates a rule from breaking the render. */

export type Props = Record<string, unknown>

export const isRecord = (value: unknown): value is Props => typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : fallback

export const asNumber = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined)

export const asItems = (value: unknown): Props[] => (Array.isArray(value) ? value.filter(isRecord) : [])

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback
}
