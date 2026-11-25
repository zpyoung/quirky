/** Static screening of user-supplied regular expressions in `field` questions. */

export const MAX_PATTERN_LENGTH = 200
export const MAX_PATTERN_TEST_LENGTH = 200
const MAX_PATTERN_QUANTIFIERS = 3

type CountedQuantifier = { length: number; variable: boolean }

/** Reads a `{n}`, `{n,}` or `{n,m}` quantifier at `index`; anything else is a literal brace. */
function readCountedQuantifier(pattern: string, index: number): CountedQuantifier | undefined {
  const match = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(index, index + 24))
  if (!match) {
    return undefined
  }
  const [text, min, comma, max] = match
  const variable = comma !== undefined && (max === '' || Number(max) > Number(min))
  return { length: text.length, variable }
}

export type UnsafePatternShape =
  | 'nested-repetition'
  | 'repeated-alternation'
  | 'too-many-quantifiers'

/**
 * Names the first regex shape that can backtrack badly, since a synchronous regex can't be
 * interrupted once matching starts: a repeated group whose body has a variable quantifier
 * (`(a+)+`), a repeated group with alternatives (`(a|ab)+`), and more than
 * `MAX_PATTERN_QUANTIFIERS` variable quantifiers. With none of those, matching a 200-character
 * input stays polynomial of low degree. A `?` after a group does not count as repeating it.
 */
export function findUnsafePatternShape(pattern: string): UnsafePatternShape | undefined {
  const groupHasQuantifier: boolean[] = []
  const groupHasAlternation: boolean[] = []
  let inClass = false
  let quantifierCount = 0
  const markQuantifier = (): void => {
    quantifierCount++
    if (groupHasQuantifier.length > 0) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true
    }
  }
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      // each backreference lets the matcher revisit earlier captures, so it spends quantifier budget
      if (!inClass && /[1-9k]/.test(pattern[i + 1] ?? '')) {
        markQuantifier()
      }
      i++
      continue
    }
    if (inClass) {
      if (char === ']') {
        inClass = false
      }
      continue
    }
    if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupHasQuantifier.push(false)
      groupHasAlternation.push(false)
      if (pattern[i + 1] === '?') {
        i++
      }
    } else if (char === '|') {
      if (groupHasAlternation.length > 0) {
        groupHasAlternation[groupHasAlternation.length - 1] = true
      }
    } else if (char === ')') {
      const bodyHadQuantifier = groupHasQuantifier.pop() ?? false
      const bodyHadAlternation = groupHasAlternation.pop() ?? false
      const next = pattern[i + 1]
      const repeats =
        next === '+' || next === '*' || readCountedQuantifier(pattern, i + 1) !== undefined
      if (repeats && bodyHadQuantifier) {
        return 'nested-repetition'
      }
      if (repeats && bodyHadAlternation) {
        return 'repeated-alternation'
      }
      if (groupHasQuantifier.length > 0 && bodyHadQuantifier) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
      if (groupHasAlternation.length > 0 && bodyHadAlternation) {
        groupHasAlternation[groupHasAlternation.length - 1] = true
      }
    } else if (char === '+' || char === '*' || char === '?') {
      markQuantifier()
      if (pattern[i + 1] === '?') {
        i++
      }
    } else if (char === '{') {
      const counted = readCountedQuantifier(pattern, i)
      if (counted) {
        if (counted.variable) {
          markQuantifier()
        }
        i += counted.length - 1
        if (pattern[i + 1] === '?') {
          i++
        }
      }
    }
  }
  return quantifierCount > MAX_PATTERN_QUANTIFIERS ? 'too-many-quantifiers' : undefined
}

export const UNSAFE_PATTERN_MESSAGES: Record<UnsafePatternShape, string> = {
  'nested-repetition':
    'pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine',
  'repeated-alternation':
    'pattern must not repeat a group with alternatives (e.g. (a|ab)+); it can hang the regex engine',
  'too-many-quantifiers': `pattern must have at most ${MAX_PATTERN_QUANTIFIERS} variable quantifiers; it can hang the regex engine`
}
