/**
 * Static screening of user-supplied regexes before they are compiled or run. It rejects the shapes
 * that backtrack exponentially (a repeated group with a variable body, backreferences, lookbehind);
 * it does not catch polynomial blowups, which the matcher's time budget handles.
 */

const MAX_PATTERN_LENGTH = 512

/** Why `pattern` must not be run, or null when it passes the shape checks. */
export function unsafePatternReason(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LENGTH) return `is longer than ${MAX_PATTERN_LENGTH} characters`
  try {
    new RegExp(pattern)
  } catch {
    return 'does not compile'
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'uses a backreference'
  if (/\(\?<[=!]/.test(pattern)) return 'uses a lookbehind'
  return repeatsAVariableGroup(pattern) ? 'repeats a group that can match in more than one way' : null
}

const isRepeatingQuantifier = (char: string | undefined) => char === '*' || char === '+' || char === '{'

/** A group with a variable body followed by `*`, `+` or `{` can split failing input exponentially: (a+)*, (a?)+, (a|aa)+. */
function repeatsAVariableGroup(pattern: string): boolean {
  const groupVaries: boolean[] = []
  let inClass = false
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      index += 1
    } else if (inClass) {
      inClass = char !== ']'
    } else if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupVaries.push(false)
      // the ? of a group opener is not a quantifier
      if (pattern[index + 1] === '?') index += 1
    } else if (char === ')') {
      const bodyVaries = groupVaries.pop() ?? false
      if (bodyVaries && isRepeatingQuantifier(pattern[index + 1])) return true
      if (bodyVaries && groupVaries.length > 0) groupVaries[groupVaries.length - 1] = true
    } else if ((isRepeatingQuantifier(char) || char === '?' || char === '|') && groupVaries.length > 0) {
      groupVaries[groupVaries.length - 1] = true
    }
  }
  return false
}
