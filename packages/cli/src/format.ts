import { formatTable } from './output'

type Scalar = string | number | boolean | null

const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const own = (row: Record<string, unknown>, key: string): unknown => (Object.hasOwn(row, key) ? row[key] : undefined)

const singleLine = (text: string) => text.replace(/\r\n|\r|\n/g, '\\n')

function cell(value: unknown): string {
  if (value === null || value === undefined) return '-'
  return singleLine(isScalar(value) ? String(value) : JSON.stringify(value))
}

/**
 * A plain-text rendering of any method result: scalars as is, `ok` for null or `{ok: true}`,
 * `key: value` lines for an object, a table for a list of objects, compact JSON lines otherwise.
 */
export function formatGeneric(result: unknown): string {
  if (result === null || result === undefined) return 'ok'
  if (typeof result === 'string' || typeof result === 'number' || typeof result === 'boolean') return String(result)
  if (Array.isArray(result)) return formatList(result)
  if (!isPlainObject(result)) return JSON.stringify(result)
  const keys = Object.keys(result)
  if (keys.length === 1 && keys[0] === 'ok' && result.ok === true) return 'ok'
  if (keys.length === 0) return '{}'
  return keys.map((key) => `${key}: ${cell(own(result, key))}`).join('\n')
}

function formatList(list: unknown[]): string {
  if (list.length === 0) return 'none'
  if (list.every(isPlainObject)) {
    const columns = new Set<string>()
    for (const row of list) {
      for (const [key, value] of Object.entries(row)) {
        if (isScalar(value)) columns.add(key)
      }
    }
    if (columns.size) {
      return formatTable(
        [...columns].map((column) => column.toUpperCase()),
        list.map((row) => [...columns].map((column) => cell(own(row, column))))
      )
    }
  }
  return list.map((item) => JSON.stringify(item)).join('\n')
}
