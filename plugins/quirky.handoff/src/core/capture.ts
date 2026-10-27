export const CAPTURE_CHAR_CAP = 36_000

const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ESC_INTERMEDIATE = /\x1b[ -/]+[0-~]/g
const ESC_SINGLE = /\x1b[ -~]/g
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g

function stripEscapes(text: string): string {
  return text
    .replace(OSC, '')
    .replace(CSI, '')
    .replace(ESC_INTERMEDIATE, '')
    .replace(ESC_SINGLE, '')
    .replace(CONTROLS, '')
}

/**
 * Turns terminal history lines into the capture a brief can carry: escape sequences removed,
 * only the last 36,000 characters kept and a note saying how many were dropped. Null when
 * nothing readable remains.
 */
export function boundCapture(lines: string[]): string | null {
  const cleaned = stripEscapes(lines.join('\n')).trimEnd()
  if (cleaned.trim() === '') return null
  if (cleaned.length <= CAPTURE_CHAR_CAP) return cleaned
  let cut = cleaned.length - CAPTURE_CHAR_CAP
  const first = cleaned.charCodeAt(cut)
  if (first >= 0xdc00 && first <= 0xdfff) cut += 1
  return `[Earlier terminal output omitted: ${cut} characters]\n${cleaned.slice(cut)}`
}
