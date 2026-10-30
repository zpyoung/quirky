export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}
