export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringField(value: unknown, name: string, maximum = 4096): string | null {
  if (!isRecord(value)) return null
  const field = value[name]
  return typeof field === 'string' && field.length > 0 && field.length <= maximum ? field : null
}

export function optionalStringField(value: unknown, name: string, maximum = 4096): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[name]
  return typeof field === 'string' && field.length <= maximum ? field : undefined
}

export function safeIntegerField(value: unknown, name: string, minimum = 0, maximum = Number.MAX_SAFE_INTEGER): number | null {
  if (!isRecord(value)) return null
  const field = value[name]
  return typeof field === 'number' && Number.isSafeInteger(field) && field >= minimum && field <= maximum ? field : null
}

export function optionalBooleanField(value: unknown, name: string): boolean | undefined {
  if (!isRecord(value)) return undefined
  const field = value[name]
  return typeof field === 'boolean' ? field : undefined
}

export function boundedStringArray(value: unknown, name: string, maxItems: number, maxLength: number): string[] | null {
  if (!isRecord(value) || !Array.isArray(value[name]) || value[name].length > maxItems) return null
  const output: string[] = []
  for (const item of value[name]) {
    if (typeof item !== 'string' || item.length === 0 || item.length > maxLength) return null
    output.push(item)
  }
  return output
}
