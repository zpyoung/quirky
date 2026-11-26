import { shorten } from './view-spec-check-state'
import type { ViewValidationError } from './view-spec-types'

/** Link and image checks for `markdown` text: only absolute http(s) links, no images. */

const FENCED_CODE =
  /^(\s{0,3})(?=(?:`{3}|~{3})[^\n]*\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(\n\s{0,3}\2[`~]*\s*(?=\n|$)|$)/gm

/**
 * Removes inline code spans in one pass, pairing each backtick run with the next run at least as
 * long (CommonMark's rule); a regex for this backtracks quadratically on long runs of backticks.
 */
function stripInlineCode(text: string): string {
  let out = ''
  let copied = 0
  let at = 0
  for (;;) {
    const start = text.indexOf('`', at)
    if (start === -1) {
      break
    }
    let end = start
    while (text[end] === '`') {
      end++
    }
    const length = end - start
    const next = text.indexOf('`', end)
    let nextLength = 0
    if (next !== -1) {
      while (text[next + nextLength] === '`') {
        nextLength++
      }
    }
    if (next !== -1 && nextLength >= length) {
      out += text.slice(copied, start)
      copied = at = next + length
    } else if (length >= 2) {
      const half = length >> 1
      out += text.slice(copied, start)
      copied = at = start + 2 * half
    } else {
      at = end
    }
  }
  return out + text.slice(copied)
}

function stripMarkdownCode(text: string): string {
  return stripInlineCode(text.replace(FENCED_CODE, ''))
}

const isSpace = (char: string | undefined): boolean => char !== undefined && /\s/.test(char)
const isLineTerminator = (char: string | undefined): boolean =>
  char === '\n' || char === '\r' || char === '\u2028' || char === '\u2029'

/** Finds the first `]` at or after a position; callers move forward only, so a hit is reused. */
function closingBracketFinder(source: string): (from: number) => number {
  let found = -2
  return (from) => {
    if (found === -1 || found >= from) {
      return found
    }
    found = source.indexOf(']', from)
    return found
  }
}

/** `[text](destination` and `![text](destination` found without backtracking. */
function inlineLinks(source: string): { destination: string; image: boolean }[] {
  const found: { destination: string; image: boolean }[] = []
  const closeFrom = closingBracketFinder(source)
  let resume = 0
  for (
    let open = source.indexOf('[', resume);
    open >= 0;
    open = source.indexOf('[', Math.max(open + 1, resume))
  ) {
    const close = closeFrom(open + 1)
    if (close < 0) {
      break
    }
    if (source[close + 1] !== '(') {
      continue
    }
    let cursor = close + 2
    while (isSpace(source[cursor])) {
      cursor++
    }
    if (source[cursor] === '<') {
      cursor++
    }
    const from = cursor
    while (
      cursor < source.length &&
      source[cursor] !== ')' &&
      source[cursor] !== '>' &&
      !isSpace(source[cursor])
    ) {
      cursor++
    }
    found.push({
      destination: source.slice(from, cursor),
      image: open > resume && source[open - 1] === '!'
    })
    resume = cursor
  }
  return found
}

/** `[label]: destination` reference definitions: up to three spaces of indent, at a line start. */
function referenceDefinitions(source: string): { destination: string; image: boolean }[] {
  const found: { destination: string; image: boolean }[] = []
  const closeFrom = closingBracketFinder(source)
  const lineStartAtOrAfter = (from: number): number => {
    if (from === 0) {
      return 0
    }
    for (let index = from - 1; index < source.length; index++) {
      if (isLineTerminator(source[index])) {
        return index + 1
      }
    }
    return source.length + 1
  }
  let lineStart = 0
  while (lineStart <= source.length) {
    let open = lineStart
    while (open - lineStart < 3 && isSpace(source[open])) {
      open++
    }
    let next = lineStartAtOrAfter(lineStart + 1)
    if (source[open] === '[') {
      const close = closeFrom(open + 1)
      if (close < 0) {
        break
      }
      if (close > open + 1 && source[close + 1] === ':') {
        let cursor = close + 2
        while (isSpace(source[cursor])) {
          cursor++
        }
        if (cursor < source.length) {
          const labelled =
            source[cursor] === '<' && cursor + 1 < source.length && !isSpace(source[cursor + 1])
          const from = labelled ? cursor + 1 : cursor
          cursor = from
          while (cursor < source.length && !isSpace(source[cursor])) {
            cursor++
          }
          found.push({ destination: source.slice(from, cursor), image: false })
          next = lineStartAtOrAfter(cursor)
        }
      }
    }
    lineStart = next
  }
  return found
}

/** Every link or image destination in `text` that is not an absolute http(s) URL. */
function unsafeMarkdownLinks(text: string): { destination: string; image: boolean }[] {
  const source = stripMarkdownCode(text)
  const found = inlineLinks(source)
  found.push(...referenceDefinitions(source))
  for (const match of source.matchAll(/<([a-zA-Z][a-zA-Z0-9+.-]*:[^\s<>]*)>/g)) {
    found.push({ destination: match[1], image: false })
  }
  return found.filter(({ destination, image }) => image || !/^https?:\/\/\S/i.test(destination))
}

/** Adds an error for each link that is not an absolute http(s) URL and for every image. */
export function checkMarkdown(text: string, path: string, errors: ViewValidationError[]): void {
  for (const { destination, image } of unsafeMarkdownLinks(text)) {
    errors.push({
      path,
      message: image
        ? 'markdown images are not allowed; a view never loads remote content'
        : `markdown link '${shorten(destination)}' must be an absolute http(s) URL`
    })
  }
}
