import type { GitDiff } from '@quirky/protocol'

/** The most lines either side of a text diff may have before the editor is replaced by the large-diff fallback. */
export const MAX_LINES = 120_000
/** The most characters both sides together may have before the same fallback applies. */
export const MAX_CHARACTERS = 6_000_000

export type TooLarge = NonNullable<GitDiff['tooLarge']>

/** Lines in `text`; a trailing line break does not start another line, and '' has none. */
export function countLines(text: string): number {
  if (text === '') return 0
  let lines = 1
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines++
  return text.endsWith('\n') ? lines - 1 : lines
}

/**
 * The too-large marker for a pair of sides, or null when both fit the display limits. The
 * character limit is checked first, matching the daemon's `diff`, so a draft that crosses a limit
 * in the editor gets the same reason the reload would report.
 */
export function tooLargeFor(original: string, modified: string): TooLarge | null {
  const characters = original.length + modified.length
  const originalLines = countLines(original)
  const modifiedLines = countLines(modified)
  if (characters > MAX_CHARACTERS) return { originalLines, modifiedLines, characters, reason: 'characters' }
  if (originalLines > MAX_LINES || modifiedLines > MAX_LINES) {
    return { originalLines, modifiedLines, characters, reason: 'lines' }
  }
  return null
}

/** The sentence the large-diff fallback shows for a reason. */
export function reasonText(reason: TooLarge['reason']): string {
  return reason === 'lines'
    ? 'line count exceeds the safe display limit'
    : 'character count exceeds the safe display limit'
}

/** The line the fallback prints under its counts. */
export const LIMITS_TEXT = 'Limits: 120,000 lines per side · 6,000,000 combined characters'
