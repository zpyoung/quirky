/** A repeat above this many times counts as unbounded when judging how a pattern can backtrack. */
const LARGE_REPEAT = 10

/** More repeats than this in one pattern can backtrack polynomially on a long wrapped line. */
const MAX_UNBOUNDED_REPEATS = 4

type Frame = {
  /** Whether anything inside has a repeat large enough to backtrack on. */
  unbounded: boolean
  /** First-token signature of each finished alternative, and of the one being read (null until it has a token). */
  firsts: (string | null)[]
}

/** A signature only a plain literal character can distinguish; classes, dots and escapes may match anything. */
const WILD = '*'

const overlap = (a: string, b: string): boolean => a === WILD || b === WILD || a === b

/**
 * Whether a pattern is safe to hand to the synchronous search addon. The addon runs the
 * expression on the UI thread, and JavaScript cannot interrupt a running match, so this rejects
 * the shapes that backtrack catastrophically instead: a large repeat of a group that itself
 * repeats (`(a+)+`), a large repeat of a group with alternatives that can start alike
 * (`(a|aa)*`), and patterns with many repeats. A pattern that does not parse is let through for
 * the addon to refuse.
 */
export function isSafeRegex(pattern: string, caseSensitive = true): boolean {
  const source = caseSensitive ? pattern : pattern.toLowerCase()
  const stack: Frame[] = [{ unbounded: false, firsts: [null] }]
  let previous: { group: boolean; unbounded: boolean; alternativesOverlap: boolean } | null = null
  let repeats = 0
  let i = 0

  const top = () => stack[stack.length - 1]!
  const note = (signature: string) => {
    const frame = top()
    if (frame.firsts[frame.firsts.length - 1] === null) frame.firsts[frame.firsts.length - 1] = signature
  }
  const atom = (signature: string) => {
    note(signature)
    previous = { group: false, unbounded: false, alternativesOverlap: false }
  }

  while (i < source.length) {
    const char = source[i]!
    if (char === '\\') {
      const next = source[i + 1]
      i += 2
      if ((next === 'p' || next === 'P') && source[i] === '{') i = source.indexOf('}', i) + 1 || source.length
      else if (next === 'k' && source[i] === '<') i = source.indexOf('>', i) + 1 || source.length
      else if (next === 'u' && source[i] === '{') i = source.indexOf('}', i) + 1 || source.length
      atom(next !== undefined && /[^a-z0-9]/i.test(next) ? next : WILD)
    } else if (char === '[') {
      i += 1
      if (source[i] === '^') i += 1
      if (source[i] === ']') i += 1
      while (i < source.length && source[i] !== ']') i += source[i] === '\\' ? 2 : 1
      i += 1
      atom(WILD)
    } else if (char === '.') {
      i += 1
      atom(WILD)
    } else if (char === '(') {
      i += 1
      if (source[i] === '?') {
        const header = /^\?(?::|=|!|<=|<!|<[^>]*>)/.exec(source.slice(i))
        i += header ? header[0].length : 1
      }
      stack.push({ unbounded: false, firsts: [null] })
      previous = null
    } else if (char === '|') {
      i += 1
      top().firsts.push(null)
      previous = null
    } else if (char === ')') {
      i += 1
      if (stack.length === 1) return true
      const frame = stack.pop()!
      const tokens = frame.firsts.map((first) => first ?? WILD)
      const alternativesOverlap = tokens.some((first, index) => tokens.some((other, at) => at > index && overlap(first, other)))
      if (frame.unbounded) top().unbounded = true
      note(tokens[0] ?? WILD)
      previous = { group: true, unbounded: frame.unbounded, alternativesOverlap }
    } else if (char === '^' || char === '$') {
      i += 1
      previous = null
    } else if (char === '*' || char === '+' || char === '?' || char === '{') {
      let max = Infinity
      if (char === '?') max = 1
      else if (char === '{') {
        const match = /^\{(\d+)(?:(,)(\d*))?\}/.exec(source.slice(i))
        if (!match) {
          i += 1
          atom(char)
          continue
        }
        max = match[2] === undefined ? Number(match[1]) : match[3] === '' ? Infinity : Number(match[3])
        i += match[0].length - 1
      }
      i += 1
      if (source[i] === '?') i += 1
      const target = previous
      previous = null
      const large = max > LARGE_REPEAT
      if (large) {
        repeats += 1
        top().unbounded = true
        if (repeats > MAX_UNBOUNDED_REPEATS) return false
      }
      if (target?.group && large && (target.unbounded || target.alternativesOverlap)) return false
    } else {
      i += 1
      atom(char)
    }
  }
  return true
}
