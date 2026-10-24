export const INITIAL_DELAY_MS = 500
export const MAX_DELAY_MS = 5000

export function nextDelay(previous: number): number {
  return Math.min(previous * 2, MAX_DELAY_MS)
}
