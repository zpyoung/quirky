const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const MARKUP: Record<string, true> = { '<': true, '>': true, '&': true, '"': true, "'": true, '`': true, '/': true, '\\': true }

/** Project and status icons are plain text glyphs only, never URLs or markup. */
export function isSafeIcon(value: string): boolean {
  const icon = value.trim()
  if (icon.length > 32 || URI_SCHEME.test(icon)) return false
  for (const character of icon) {
    const codePoint = character.codePointAt(0)
    if (MARKUP[character] || (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f))) return false
  }
  return true
}
