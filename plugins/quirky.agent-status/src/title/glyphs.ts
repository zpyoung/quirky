export const CLAUDE_IDLE = '✳' // ✳
export const GEMINI_WORKING = '✦' // ✦
export const GEMINI_SILENT_WORKING = '⏲' // ⏲
export const GEMINI_IDLE = '◇' // ◇
export const GEMINI_PERMISSION = '✋' // ✋

export const BRAILLE_SPINNER_RE = /[⠀-⣿]/g

// claude 2.1.228 swapped its busy spinner from braille to quarter circles; reserve the whole block
export const QUARTER_CIRCLE_SPINNER_RE = /[◐-◓]/g

function hasCodePointIn(title: string, low: number, high: number): boolean {
  for (const char of title) {
    const codePoint = char.codePointAt(0)
    if (codePoint !== undefined && codePoint >= low && codePoint <= high) return true
  }
  return false
}

export function containsBrailleSpinner(title: string): boolean {
  return hasCodePointIn(title, 0x2800, 0x28ff)
}

export function containsQuarterCircleSpinner(title: string): boolean {
  return hasCodePointIn(title, 0x25d0, 0x25d3)
}

/** Any spinner frame an agent animates its title with; proves activity, not identity. */
export function containsAgentSpinnerGlyph(title: string): boolean {
  return containsBrailleSpinner(title) || containsQuarterCircleSpinner(title)
}
