/** Readers for view node props. A spec is validated before it renders; these keep a stored one that predates a rule from breaking the render. */

export type NodeProps = Record<string, unknown>

export const isRecord = (value: unknown): value is NodeProps =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

export const asString = (value: unknown, fallback = ''): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : fallback

export const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

export const asItems = (value: unknown): NodeProps[] =>
  Array.isArray(value) ? value.filter(isRecord) : []

export const asStrings = (value: unknown): string[] =>
  Array.isArray(value) ? value.map((entry) => asString(entry)) : []

export function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((candidate) => candidate === value) ?? fallback
}
