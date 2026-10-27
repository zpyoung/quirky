import { findOptionOccurrence } from './arg-occurrence'
import { SelectionError } from './selection'
import { tokenize } from './shell'
import type { AgentEntry, ExtraArgKind, ExtraArgRule, ParsedExtras } from './types'

const MAX_BYTES = 4096
const UNSUPPORTED = `Extra arguments aren't supported for this agent yet.`

type WordSpan = { start: number; end: number; diverges: boolean }

// c0, del, c1 and the unicode line and paragraph separators
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x2028 || code === 0x2029) return true
  }
  return false
}

/**
 * Splits `text` into words like a POSIX shell and marks each word whose real shell meaning
 * `tokenize` would silently flatten into literal text: an unquoted `; & | < > `` ` ``, a
 * word-leading `#`, an unquoted `$` before `(`, `{`, `'` or `"`, a backtick, `$(` or `${` inside
 * double quotes, a backslash before an ordinary character inside double quotes, an unquoted
 * backslash-newline, and a trailing unpaired backslash. Expects balanced quotes.
 */
function scanWords(text: string): WordSpan[] {
  const spans: WordSpan[] = []
  let inWord = false
  let start = 0
  let diverges = false
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]!
    const next = text[i + 1]
    if (quote) {
      if (ch === '\\' && quote === '"' && i + 1 < text.length) {
        diverges ||= !'$`"\\'.includes(next!)
        i += 2
        continue
      }
      diverges ||= quote === '"' && (ch === '`' || (ch === '$' && '({'.includes(next ?? '\0')))
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      if (!inWord) start = i
      inWord = true
      i++
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      diverges ||= next === '\n'
      if (!inWord) start = i
      inWord = true
      i += 2
      continue
    }
    if (/\s/.test(ch)) {
      if (inWord) {
        spans.push({ start, end: i, diverges })
        inWord = false
        diverges = false
      }
      i++
      continue
    }
    if (!inWord) start = i
    diverges ||= ch === '\\' && i + 1 >= text.length
    diverges ||= ';&|<>`'.includes(ch) || (ch === '#' && !inWord) || (ch === '$' && '({\'"'.includes(next ?? '\0'))
    inWord = true
    i++
  }
  if (inWord) spans.push({ start, end: text.length, diverges })
  return spans
}

function allowedList(rules: readonly ExtraArgRule[]): string {
  return [...new Set(rules.map((rule) => (rule.valuePrefix ? `${rule.flags[0]} ${rule.valuePrefix}…` : rule.flags.at(-1)!)))].join(', ')
}

function matchRule(tokens: readonly string[], rules: readonly ExtraArgRule[]) {
  for (const rule of rules) {
    const found = findOptionOccurrence(tokens, rule.flags, false)
    if (found?.index === 0) return { rule, value: found.value, consumed: found.consumed }
  }
  return null
}

function optionName(token: string): string {
  const equals = token.indexOf('=')
  return equals > 0 ? token.slice(0, equals) : token
}

/**
 * Checks extra launch arguments against the agent's allowlist and returns their tokens, or null
 * for blank text. Refuses, with the message shown to the user, anything outside the allowlist or
 * written with shell syntax, so extras can't carry flags the launch owns.
 */
export function parseExtraArgs(entry: AgentEntry, text: string): ParsedExtras | null {
  if (!text.trim()) return null
  const rules = entry.launchOptions?.extraArgs?.allowed
  if (!rules) throw new SelectionError(UNSUPPORTED)
  if (new TextEncoder().encode(text).length > MAX_BYTES) throw new SelectionError('Extra arguments must be 4 KB or less.')
  if (hasControlCharacter(text)) {
    throw new SelectionError('Extra arguments cannot contain control characters or line breaks.')
  }
  const trimmed = text.trim()
  const split = tokenize(trimmed)
  if (!split.ok) throw new SelectionError('Extra arguments are invalid: Unclosed quote in command template.')
  const divergent = scanWords(trimmed).find((span) => span.diverges)
  if (divergent) {
    throw new SelectionError(
      `${trimmed.slice(divergent.start, divergent.end)} uses shell syntax that extra arguments don't allow.`
    )
  }

  const label = entry.label
  const allowed = allowedList(rules)
  const kinds = new Set<ExtraArgKind>()
  const { tokens } = split
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token === '--') throw new SelectionError(`"--" isn't allowed in extra arguments.`)
    if (!token.startsWith('-')) {
      throw new SelectionError(`"${token}" isn't an option. Extra arguments for ${label} accept only: ${allowed}.`)
    }
    const match = matchRule(tokens.slice(index, index + 2), rules)
    if (!match) {
      throw new SelectionError(`"${optionName(token)}" isn't allowed in extra arguments for ${label}. Allowed: ${allowed}.`)
    }
    const name = optionName(token)
    const { value } = match
    if (!value) throw new SelectionError(`"${name}" needs a value.`)
    const { kind, valuePrefix } = match.rule
    if (valuePrefix && (!value.startsWith(valuePrefix) || value.length === valuePrefix.length)) {
      throw new SelectionError(
        `"${name} ${value}" isn't allowed. ${label} extra arguments accept only "${name} ${valuePrefix}<level>".`
      )
    }
    if (kind !== 'repeatable' && kinds.has(kind)) {
      throw new SelectionError(`Extra arguments set the ${kind} more than once.`)
    }
    kinds.add(kind)
    index += match.consumed - 1
  }
  return { tokens, kinds }
}

/** What `quirky.agents/options` reports about an agent's extra arguments. */
export function extrasSummary(entry: AgentEntry): {
  supported: boolean
  allowed: string | null
  placeholder: string | null
  message: string | null
} {
  const extra = entry.launchOptions?.extraArgs
  if (!extra) return { supported: false, allowed: null, placeholder: null, message: UNSUPPORTED }
  return { supported: true, allowed: allowedList(extra.allowed), placeholder: extra.placeholder, message: null }
}
