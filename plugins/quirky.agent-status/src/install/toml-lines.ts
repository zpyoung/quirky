/**
 * Just enough TOML to edit lines inside a region Quirky owns: which lines start a table or a key,
 * which are continuations of a multi-line value, and how to read and write a one-line string.
 * It is not a parser and trusts its input to be valid TOML; callers validate with a real parser first.
 */

export type TomlKind = 'blank' | 'comment' | 'header' | 'key' | 'continuation'

export type TomlScan = { kinds: TomlKind[] }

type ValueState = { multi: '"""' | "'''" | null; depth: number }

/** Reads one value's text and reports whether it leaves a multi-line string or an array open. */
function scanValue(text: string, state: ValueState): void {
  let index = 0
  while (index < text.length) {
    if (state.multi) {
      const close = text.indexOf(state.multi, index)
      if (close === -1) return
      index = close + 3
      state.multi = null
      continue
    }
    const char = text[index]!
    if (char === '#') return
    if (text.startsWith('"""', index) || text.startsWith("'''", index)) {
      state.multi = text.slice(index, index + 3) as '"""' | "'''"
      index += 3
    } else if (char === '"') {
      index++
      while (index < text.length && text[index] !== '"') index += text[index] === '\\' ? 2 : 1
      index++
    } else if (char === "'") {
      const close = text.indexOf("'", index + 1)
      index = close === -1 ? text.length : close + 1
    } else {
      if (char === '[' || char === '{') state.depth++
      else if (char === ']' || char === '}') state.depth--
      index++
    }
  }
}

export type KeyLine = { segments: string[]; value: string }

/** Splits `a."b c".d = value` into its key segments and the value text. */
export function parseKeyLine(line: string): KeyLine | null {
  let index = 0
  const segments: string[] = []
  for (;;) {
    while (line[index] === ' ' || line[index] === '\t') index++
    const char = line[index]
    let segment: string
    if (char === '"') {
      const end = findClosingQuote(line, index)
      if (end === -1) return null
      segment = unescapeBasic(line.slice(index + 1, end))
      index = end + 1
    } else if (char === "'") {
      const end = line.indexOf("'", index + 1)
      if (end === -1) return null
      segment = line.slice(index + 1, end)
      index = end + 1
    } else {
      const bare = /^[A-Za-z0-9_-]+/.exec(line.slice(index))
      if (!bare) return null
      segment = bare[0]
      index += segment.length
    }
    segments.push(segment)
    while (line[index] === ' ' || line[index] === '\t') index++
    if (line[index] === '.') {
      index++
      continue
    }
    break
  }
  if (line[index] !== '=') return null
  return { segments, value: line.slice(index + 1) }
}

function findClosingQuote(text: string, open: number): number {
  for (let index = open + 1; index < text.length; index++) {
    if (text[index] === '\\') index++
    else if (text[index] === '"') return index
  }
  return -1
}

const ESCAPES: Record<string, string> = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' }

function unescapeBasic(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape: string) =>
    escape.length > 1 ? String.fromCodePoint(Number.parseInt(escape.slice(1), 16)) : (ESCAPES[escape] ?? escape)
  )
}

/** The text of a one-line basic or literal string value, or null for anything else. */
export function parseStringValue(value: string): string | null {
  const text = value.trimStart()
  if (text.startsWith('"') && !text.startsWith('"""')) {
    const end = findClosingQuote(text, 0)
    if (end === -1 || !isBlankOrComment(text.slice(end + 1))) return null
    return unescapeBasic(text.slice(1, end))
  }
  if (text.startsWith("'") && !text.startsWith("'''")) {
    const end = text.indexOf("'", 1)
    if (end === -1 || !isBlankOrComment(text.slice(end + 1))) return null
    return text.slice(1, end)
  }
  return null
}

function isBlankOrComment(text: string): boolean {
  const trimmed = text.trim()
  return trimmed === '' || trimmed.startsWith('#')
}

/** A TOML basic string literal for `value`. */
export function quoteBasic(value: string): string {
  const escaped = value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n').replaceAll('\r', '\\r').replaceAll('\t', '\\t')
  return `"${escaped}"`
}

export type HeaderLine = { segments: string[]; array: boolean }

/** The key path of a `[table]` or `[[array]]` line. */
export function parseHeader(line: string): HeaderLine | null {
  const match = /^\s*(\[\[?)\s*(.+?)\s*(\]\]?)\s*(?:#.*)?$/.exec(line)
  if (!match || match[1]!.length !== match[3]!.length) return null
  const parsed = parseKeyLine(`${match[2]} =`)
  return parsed ? { segments: parsed.segments, array: match[1] === '[[' } : null
}

/** Classifies every line of valid TOML as a blank, comment, header, key or continuation of a multi-line value. */
export function scanToml(lines: readonly string[]): TomlScan {
  const kinds: TomlKind[] = []
  const state: ValueState = { multi: null, depth: 0 }
  for (const line of lines) {
    if (state.multi || state.depth > 0) {
      scanValue(line, state)
      kinds.push('continuation')
      continue
    }
    const trimmed = line.trim()
    if (trimmed === '') kinds.push('blank')
    else if (trimmed.startsWith('#')) kinds.push('comment')
    else if (trimmed.startsWith('[')) kinds.push('header')
    else {
      kinds.push('key')
      const key = parseKeyLine(line)
      if (key) scanValue(key.value, state)
    }
  }
  return { kinds }
}
