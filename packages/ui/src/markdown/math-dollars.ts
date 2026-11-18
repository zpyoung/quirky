const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/
const BLANK = /^\s*$/

type Segment = { text: string; protectedText: boolean }

/** Splits markdown into runs that may hold math and runs (fenced or indented code) that never do. */
function splitCodeBlocks(markdown: string): Segment[] {
  const lines = markdown.split('\n')
  const segments: Segment[] = []
  let plain: string[] = []
  const flushPlain = () => {
    if (plain.length > 0) segments.push({ text: plain.join('\n'), protectedText: false })
    plain = []
  }
  let index = 0
  let previousBlank = true
  let previousListOrIndented = false
  while (index < lines.length) {
    const line = lines[index]
    const open = FENCE_OPEN.exec(line)
    if (open) {
      flushPlain()
      const marker = open[1]
      const block = [line]
      index += 1
      while (index < lines.length) {
        const current = lines[index]
        block.push(current)
        index += 1
        const close = FENCE_OPEN.exec(current)
        if (close && close[1][0] === marker[0] && close[1].length >= marker.length && current.trim() === close[1]) break
      }
      segments.push({ text: block.join('\n'), protectedText: true })
      previousBlank = false
      previousListOrIndented = false
      continue
    }
    const indented = /^(?: {4}|\t)/.test(line) && !BLANK.test(line)
    if (indented && previousBlank && !previousListOrIndented) {
      flushPlain()
      const block = [line]
      index += 1
      while (index < lines.length && (BLANK.test(lines[index]) || /^(?: {4}|\t)/.test(lines[index]))) {
        block.push(lines[index])
        index += 1
      }
      while (block.length > 1 && BLANK.test(block[block.length - 1])) {
        index -= 1
        block.pop()
      }
      segments.push({ text: block.join('\n'), protectedText: true })
      previousBlank = false
      previousListOrIndented = false
      continue
    }
    plain.push(line)
    index += 1
    if (BLANK.test(line)) previousBlank = true
    else {
      previousBlank = false
      previousListOrIndented = LIST_ITEM.test(line) || indented
    }
  }
  flushPlain()
  return segments
}

function isWhitespace(char: string | undefined): boolean {
  return char !== undefined && /\s/.test(char)
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9'
}

/** Finds the next single dollar that is not escaped and is not part of a longer run, stopping at a blank line. */
function findCloser(text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const char = text[index]
    if (char === '\n' && /^\n[ \t]*\n/.test(text.slice(index))) return -1
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === '$') {
      let run = 1
      while (text[index + run] === '$') run += 1
      if (run === 1) return index
      index += run
      continue
    }
    index += 1
  }
  return -1
}

function rewriteInline(text: string): string {
  let out = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '`') {
      let run = 1
      while (text[index + run] === '`') run += 1
      const ticks = '`'.repeat(run)
      const close = text.indexOf(ticks, index + run)
      let end = close
      while (end !== -1 && text[end + run] === '`') end = text.indexOf(ticks, end + run + 1)
      if (end === -1) {
        out += ticks
        index += run
        continue
      }
      out += text.slice(index, end + run)
      index = end + run
      continue
    }
    if (char === '\\') {
      const next = text[index + 1]
      if (next === '(' || next === '[') {
        const closer = next === '(' ? '\\)' : '\\]'
        const end = text.indexOf(closer, index + 2)
        if (end !== -1) {
          const inner = text.slice(index + 2, end)
          out += next === '(' ? `$${inner}$` : `$$${inner}$$`
          index = end + 2
          continue
        }
      }
      out += next === undefined ? char : char + next
      index += 2
      continue
    }
    if (char === '$') {
      let run = 1
      while (text[index + run] === '$') run += 1
      if (run >= 2) {
        const delimiter = '$'.repeat(run)
        const end = text.indexOf(delimiter, index + run)
        if (end !== -1) {
          out += text.slice(index, end + run)
          index = end + run
          continue
        }
        out += '\\$'.repeat(run)
        index += run
        continue
      }
      const closer = isWhitespace(text[index + 1]) || index + 1 >= text.length ? -1 : findCloser(text, index + 1)
      const tight = closer > index + 1 && !isWhitespace(text[closer - 1]) && !isDigit(text[closer + 1])
      if (tight) {
        out += text.slice(index, closer + 1)
        index = closer + 1
        continue
      }
      out += '\\$'
      index += 1
      continue
    }
    out += char
    index += 1
  }
  return out
}

/**
 * Makes dollar signs safe for remark-math with single-dollar math on. The result has only `$…$`,
 * `$$…$$` and `\$`: a single `$…$` pair survives only when nothing but a non-space sits inside both
 * dollars and no digit follows the closing one, so prices stay text. `\(…\)` and `\[…\]` become math.
 * Fenced code, indented code and inline code are returned as written.
 */
export function escapeLooseDollars(markdown: string): string {
  if (!markdown.includes('$') && !markdown.includes('\\(') && !markdown.includes('\\[')) return markdown
  return splitCodeBlocks(markdown)
    .map((segment) => (segment.protectedText ? segment.text : rewriteInline(segment.text)))
    .join('\n')
}
