type ContextThreshold = 'muted' | 'strong' | 'danger'

export function formatCount(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

export function formatPercentage(value: number | undefined): number | null {
  if (value === undefined || !Number.isFinite(value)) return null
  return Math.round(Math.min(100, Math.max(0, value)))
}

export function contextThreshold(percentage: number): ContextThreshold {
  if (percentage >= 80) return 'danger'
  if (percentage >= 60) return 'strong'
  return 'muted'
}

export function formatTimestamp(value: number | undefined): string | null {
  if (value === undefined || !Number.isFinite(value) || value < 0) return null
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return null
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
