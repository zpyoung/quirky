type Quantifier = { length: number; requiresOne: boolean }

/** Returns whether the quantifier is valid, malformed, or absent at the given source offset. */
function readQuantifier(source: string, index: number): Quantifier | null | undefined {
  const char = source[index]
  if (char === '*') return { length: 1, requiresOne: false }
  if (char === '+') return { length: 1, requiresOne: true }
  if (char === '?') return { length: 1, requiresOne: false }
  if (char !== '{') return undefined

  let cursor = index + 1
  const minStart = cursor
  while (cursor < source.length && source[cursor]! >= '0' && source[cursor]! <= '9') cursor++
  if (cursor === minStart) return null
  const minEnd = cursor
  let minIsPositive = false
  for (let i = minStart; i < minEnd; i++) {
    if (source[i] !== '0') minIsPositive = true
  }

  if (source[cursor] === '}') return { length: cursor - index + 1, requiresOne: minIsPositive }
  if (source[cursor] !== ',') return null
  cursor++
  const maxStart = cursor
  while (cursor < source.length && source[cursor]! >= '0' && source[cursor]! <= '9') cursor++
  const maxEnd = cursor
  if (source[cursor] !== '}') return null
  if (maxStart !== maxEnd && compareUnsignedIntegers(source, minStart, minEnd, maxStart, maxEnd) > 0) {
    return null
  }
  return { length: cursor - index + 1, requiresOne: minIsPositive }
}

function compareUnsignedIntegers(source: string, leftStart: number, leftEnd: number, rightStart: number, rightEnd: number): number {
  while (leftStart + 1 < leftEnd && source[leftStart] === '0') leftStart++
  while (rightStart + 1 < rightEnd && source[rightStart] === '0') rightStart++
  const leftLength = leftEnd - leftStart
  const rightLength = rightEnd - rightStart
  if (leftLength !== rightLength) return leftLength < rightLength ? -1 : 1
  for (let offset = 0; offset < leftLength; offset++) {
    const left = source.charCodeAt(leftStart + offset)
    const right = source.charCodeAt(rightStart + offset)
    if (left !== right) return left < right ? -1 : 1
  }
  return 0
}

/** Skips a simple character class, including escaped characters. */
function skipCharacterClass(source: string, start: number): number | undefined {
  let cursor = start + 1
  if (source[cursor] === '^') cursor++
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      cursor += 2
    } else if (source[cursor] === ']') {
      return cursor + 1
    } else {
      cursor++
    }
  }
  return undefined
}

/**
 * Returns true only when flat syntax proves a required literal is absent; undefined means that
 * native matching is required. Any escaped, grouped, alternative, or uncertain syntax bails out.
 */
function hasMissingRequiredLiteral(source: string, value: string): boolean | undefined {
  let missingRequiredLiteral = false
  for (let index = 0; index < source.length; ) {
    const char = source[index]!
    if (char === '[' || char === '.') {
      const end = char === '[' ? skipCharacterClass(source, index) : index + 1
      if (end === undefined) return undefined
      const quantifier = readQuantifier(source, end)
      if (quantifier === null) return undefined
      index = end
      if (quantifier) {
        index += quantifier.length
        if (source[index] === '?') index++
      }
      continue
    }

    if (char === '^' || char === '$') {
      if (readQuantifier(source, index + 1) !== undefined) return undefined
      index++
      continue
    }

    if (char === '\\' || char === '(' || char === ')' || char === '|' || char === ']' || char === '}') {
      return undefined
    }
    if (char === '*' || char === '+' || char === '?' || char === '{') return undefined

    const quantifier = readQuantifier(source, index + 1)
    if (quantifier === null) return undefined
    if (quantifier) {
      if (quantifier.requiresOne && !missingRequiredLiteral && !value.includes(char)) {
        missingRequiredLiteral = true
      }
      index += quantifier.length + 1
      if (source[index] === '?') index++
    } else {
      if (!missingRequiredLiteral && !value.includes(char)) missingRequiredLiteral = true
      index++
    }
  }
  return missingRequiredLiteral
}

/**
 * Uses only a conservative required-literal prefilter before native matching. This is not a regex
 * timeout: patterns outside the small analyzed syntax still use the synchronous native engine.
 */
export function matchesPattern(regex: RegExp, value: string): boolean {
  if (regex.flags === '') {
    if (hasMissingRequiredLiteral(regex.source, value)) return false
  }
  return regex.test(value)
}
