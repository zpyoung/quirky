/** Shapes `format: "email"` and `format: "url"` text must match. */
export const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/** True only for a real calendar date in `YYYY-MM-DD` form. */
export function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false
  // Date rolls 2026-02-30 into March, so the parsed value must round-trip to the input
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** The text itself, or undefined when it is missing or only whitespace. */
export function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
