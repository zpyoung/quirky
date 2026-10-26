/** The session a Cmd+1..9 key selects, by its 1-based position; undefined for other keys or no such tab. */
export function sessionForDigit<T>(sessions: readonly T[], key: string): T | undefined {
  return /^[1-9]$/.test(key) ? sessions[Number(key) - 1] : undefined
}
