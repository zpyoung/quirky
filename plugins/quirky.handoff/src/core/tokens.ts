const PROSE_CHARS_PER_TOKEN = 6.5
const CODE_CHARS_PER_TOKEN = 4.5
const DIFF_CHARS_PER_TOKEN = 3.5

/**
 * Rough token cost of an editable brief: prose, fenced code and diff lines weigh differently.
 * Always at least 1 and labelled "about" wherever it is shown.
 */
export function estimateTokens(text: string): number {
  let prose = 0
  let code = 0
  let diff = 0
  let open: { char: string; length: number } | null = null
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    const chars = line.length + (index === lines.length - 1 ? 0 : 1)
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (open === null) {
      if (marker) {
        open = { char: marker[1]![0]!, length: marker[1]!.length }
        prose += chars
      } else if (/^(?:\+|-|@@)/.test(line)) {
        diff += chars
      } else {
        prose += chars
      }
      return
    }
    const closes = marker && marker[1]![0] === open.char && marker[1]!.length >= open.length && marker[2]!.trim() === ''
    if (closes) {
      open = null
      prose += chars
    } else {
      code += chars
    }
  })
  const tokens = prose / PROSE_CHARS_PER_TOKEN + code / CODE_CHARS_PER_TOKEN + diff / DIFF_CHARS_PER_TOKEN
  return Math.max(1, Math.ceil(tokens))
}
