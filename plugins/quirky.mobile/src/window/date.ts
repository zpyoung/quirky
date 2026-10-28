/** Returns the user-facing paired-device timestamp, including the required separator after `Paired`. */
export function pairedDateLabel(timestamp: number): string {
  const date = Number.isFinite(timestamp) ? new Date(timestamp) : null
  const formatted = date === null ? 'date unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(date)
  return `Paired ${formatted}`
}
