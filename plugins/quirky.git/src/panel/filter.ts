/** The longest file filter, in UTF-8 bytes; longer text is refused instead of scanned. */
export const MAX_FILTER_BYTES = 2048

export const FILTER_TOO_LARGE = { title: 'Search text is too large', message: 'Use a shorter file filter.' } as const

const encoder = new TextEncoder()

/** Whether `query` is longer than `MAX_FILTER_BYTES` once encoded as UTF-8. */
export function filterTooLarge(query: string): boolean {
  return encoder.encode(query).length > MAX_FILTER_BYTES
}

/** Case-insensitive substring match of `query` on the whole path. */
export function matchesFilter(path: string, query: string): boolean {
  return path.toLowerCase().includes(query.toLowerCase())
}

/**
 * The outcome of the file filter. `inactive`: nothing typed, every row stays and the section
 * and bulk buttons stay. `filtering`: `items` are the matches and the buttons hide. `too-large`:
 * show `title` and `message` instead of rows.
 */
export type FilterResult<T> =
  | { state: 'inactive'; items: T[] }
  | { state: 'filtering'; items: T[] }
  | { state: 'too-large'; items: []; title: string; message: string }

/** Filters rows by path. Surrounding whitespace in the query is ignored; a blank query is inactive. */
export function applyFilter<T extends { path: string }>(items: readonly T[], query: string): FilterResult<T> {
  if (filterTooLarge(query)) return { state: 'too-large', items: [], ...FILTER_TOO_LARGE }
  const text = query.trim()
  if (text === '') return { state: 'inactive', items: [...items] }
  return { state: 'filtering', items: items.filter((item) => matchesFilter(item.path, text)) }
}
