/**
 * Pure rule evaluation: which rule of a file, if any, describes the current title and screen.
 * It runs inside the matcher process, never on the daemon's event loop, because a user's regex
 * can take unbounded time.
 */
import type { EvaluateInput, Evaluation, LineMatch, Matcher, Origin, Rule, RuleFile } from './types'

const compiled = new Map<string, RegExp | null>()
const COMPILED_LIMIT = 512

function compile(source: string, flags: string): RegExp | null {
  const key = `${flags}/${source}`
  const known = compiled.get(key)
  if (known !== undefined) return known
  let regex: RegExp | null
  try {
    regex = new RegExp(source, flags)
  } catch {
    regex = null
  }
  if (compiled.size >= COMPILED_LIMIT) compiled.clear()
  compiled.set(key, regex)
  return regex
}

function holds(matcher: Matcher, text: string): boolean {
  if ('contains' in matcher) return text.toLowerCase().includes(matcher.contains.toLowerCase())
  const regex = compile(matcher.regex, matcher.ignoreCase ? 'mi' : 'm')
  return regex !== null && regex.test(text)
}

function regionText(rule: Rule, input: EvaluateInput): string {
  if (rule.region === 'title') return input.title
  if (rule.lastLines === undefined) return input.lines.join('\n')
  const shown: string[] = []
  for (let index = input.lines.length - 1; index >= 0 && shown.length < rule.lastLines; index -= 1) {
    const line = input.lines[index]!
    if (line.trim() !== '') shown.push(line)
  }
  return shown.reverse().join('\n')
}

function matches(rule: Rule, input: EvaluateInput): boolean {
  const text = regionText(rule, input)
  return (rule.all ?? []).every((matcher) => holds(matcher, text)) && !(rule.none ?? []).some((matcher) => holds(matcher, text))
}

/**
 * The verdict for `input` under `file`. Blocked rules are tried first, then working and idle
 * rules, each group in file order; the first rule whose matchers hold and whose quiet time is
 * met wins. A rule that holds except for quiet is reported as `pendingQuiet` so a caller can
 * sample again instead of concluding nothing matched.
 */
export function evaluate(file: RuleFile, input: EvaluateInput, origin: Origin): Evaluation {
  const ordered = [...file.rules.filter((rule) => rule.state === 'blocked'), ...file.rules.filter((rule) => rule.state !== 'blocked')]
  let pendingQuiet: string | undefined
  for (const rule of ordered) {
    if (!matches(rule, input)) continue
    const quietNeeded = rule.quietMs ?? 0
    if (quietNeeded > 0 && (input.quietForMs === null || input.quietForMs < quietNeeded)) {
      pendingQuiet ??= rule.id
      continue
    }
    const verdict = rule.state === 'blocked' ? { rule: rule.id, state: rule.state, kind: rule.kind ?? 'approval', origin } : { rule: rule.id, state: rule.state, origin }
    return pendingQuiet === undefined ? { verdict } : { verdict, pendingQuiet }
  }
  return pendingQuiet === undefined ? { verdict: null } : { verdict: null, pendingQuiet }
}

/** The newest of `lines` that `pattern` matches, with its whole match and capture groups; null when none does. */
export function findLine(pattern: string, ignoreCase: boolean, lines: string[]): LineMatch | null {
  const regex = compile(pattern, ignoreCase ? 'i' : '')
  if (regex === null) return null
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!
    const found = regex.exec(line)
    if (found) return { line, match: found[0], groups: found.slice(1).map((group) => group ?? '') }
  }
  return null
}
