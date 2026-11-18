/** A half-open run of source offsets that must be left exactly as written, such as a code block. */
export type SourceSpan = readonly [from: number, to: number]

const BLANK_LINE = /\n[ \t]*\n/g

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

function spanContaining(spans: readonly SourceSpan[], index: number): SourceSpan | undefined {
  return spans.find(([from, to]) => index >= from && index < to)
}

/** Offset of the first blank line at or after `from`, or the end of the source. */
function paragraphEnd(source: string, from: number): number {
  BLANK_LINE.lastIndex = from
  return BLANK_LINE.exec(source)?.index ?? source.length
}

/** Finds the next single dollar that is not escaped, not in a span, and not part of a longer run, stopping at a blank line. */
function findCloser(source: string, from: number, spans: readonly SourceSpan[]): number {
  const limit = paragraphEnd(source, from)
  let index = from
  while (index < limit) {
    const char = source[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '$') {
      const span = spanContaining(spans, index)
      if (span) {
        index = span[1]
        continue
      }
      let run = 1
      while (source[index + run] === '$') run += 1
      if (run === 1) return index
      index += run
      continue
    }
    index += 1
  }
  return -1
}

const DEFINITION_START = /^ {0,3}\[(?:[^\]\\\n]|\\.)+\]:/

/** Offset just past the parenthesis that closes a link destination starting at `from`, or -1 when the paragraph ends first. */
function destinationEnd(source: string, from: number): number {
  const limit = paragraphEnd(source, from)
  let depth = 0
  for (let index = from; index < limit; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '(') depth += 1
    else if (char === ')') {
      if (depth === 0) return index + 1
      depth -= 1
    }
  }
  return -1
}

/** True when `index` sits after the label of a link reference definition on its own line. */
function inDefinitionLine(source: string, index: number): boolean {
  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const label = DEFINITION_START.exec(source.slice(lineStart, index))
  return label !== null && lineStart + label[0].length <= index
}

/** Rewrites `\(…\)` and `\[…\]` to dollar math of the same length, or returns null when the pair is not math. */
function rewriteEscapedDelimiter(source: string, index: number, spans: readonly SourceSpan[]): { text: string; next: number } | null {
  const inline = source[index + 1] === '('
  const end = source.indexOf(inline ? '\\)' : '\\]', index + 2)
  if (end === -1 || end >= paragraphEnd(source, index) || spanContaining(spans, end)) return null
  const inner = source.slice(index + 2, end)
  const core = inner.trim()
  if (core === '' || /(?:^|[^\\])\$/.test(core)) return null
  if (!inline) return { text: `$$${inner}$$`, next: end + 2 }
  const lead = inner.length - inner.trimStart().length
  const trail = inner.length - inner.trimEnd().length
  return { text: ` ${inner.slice(0, lead)}$${core}$${inner.slice(inner.length - trail)} `, next: end + 2 }
}

/**
 * Prepares `source` for remark-math with single-dollar math on, without moving any character.
 * A single `$…$` pair survives only when no whitespace follows the opening dollar or precedes the
 * closing one and no digit follows the closing one, so prices stay text; every other loose dollar
 * becomes `mask`, which the caller swaps back after parsing. `\(…\)` and `\[…\]` become math of the
 * same length. Text in `spans` and inline code are returned as written.
 */
export function maskLooseDollars(source: string, spans: readonly SourceSpan[], mask: string): string {
  let out = ''
  let index = 0
  let destinationUntil = 0
  while (index < source.length) {
    const span = spanContaining(spans, index)
    if (span) {
      out += source.slice(index, span[1])
      index = span[1]
      continue
    }
    const char = source[index]
    if (char === '`') {
      let run = 1
      while (source[index + run] === '`') run += 1
      const ticks = '`'.repeat(run)
      const limit = paragraphEnd(source, index)
      let end = source.indexOf(ticks, index + run)
      while (end !== -1 && source[end + run] === '`') end = source.indexOf(ticks, end + run + 1)
      if (end === -1 || end >= limit) {
        out += ticks
        index += run
        continue
      }
      out += source.slice(index, end + run)
      index = end + run
      continue
    }
    if (char === '\\') {
      const next = source[index + 1]
      if ((next === '(' || next === '[') && index >= destinationUntil && !inDefinitionLine(source, index)) {
        const rewritten = rewriteEscapedDelimiter(source, index, spans)
        if (rewritten) {
          out += rewritten.text
          index = rewritten.next
          continue
        }
      }
      out += next === undefined ? char : char + next
      index += 2
      continue
    }
    if (char === ']' && source[index + 1] === '(') {
      const end = destinationEnd(source, index + 2)
      if (end !== -1) destinationUntil = end
    }
    if (char === '$') {
      let run = 1
      while (source[index + run] === '$') run += 1
      if (run >= 2) {
        const delimiter = '$'.repeat(run)
        const end = source.indexOf(delimiter, index + run)
        if (end !== -1) {
          out += source.slice(index, end + run)
          index = end + run
          continue
        }
        out += mask.repeat(run)
        index += run
        continue
      }
      const closer = isWhitespace(source[index + 1]) || index + 1 >= source.length ? -1 : findCloser(source, index + 1, spans)
      const tight = closer > index + 1 && !isWhitespace(source[closer - 1]) && !isDigit(source[closer + 1])
      if (tight) {
        out += source.slice(index, closer + 1)
        index = closer + 1
        continue
      }
      out += mask
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}
