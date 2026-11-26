/** "12s" or "1m 05s"; empty under one second, so an instant call shows no time. */
export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000)
  if (seconds < 1) {
    return ''
  }
  return formatElapsed(ms)
}

/** "12s" below a minute, then "1m 05s". */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return seconds < 60
    ? `${seconds}s`
    : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}
