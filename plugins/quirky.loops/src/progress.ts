import type { IterationDetail, LoopSnapshot } from './types'

function normalizedGlob(value: string): string {
  let glob = value.trim().replace(/^\.\//, '').replace(/^\/+/, '')
  while (glob.startsWith('./')) glob = glob.slice(2)
  return glob
}

function matchingBraceEnd(pattern: string, start: number): number {
  let depth = 0
  for (let index = start; index < pattern.length; index++) {
    if (pattern[index] === '{') depth++
    else if (pattern[index] === '}' && --depth === 0) return index
  }
  return -1
}

function splitAlternatives(value: string): string[] {
  const alternatives: string[] = []
  let start = 0
  let depth = 0
  for (let index = 0; index < value.length; index++) {
    if (value[index] === '{') depth++
    else if (value[index] === '}') depth--
    else if (value[index] === ',' && depth === 0) {
      alternatives.push(value.slice(start, index))
      start = index + 1
    }
  }
  alternatives.push(value.slice(start))
  return alternatives
}

function globBody(pattern: string): string {
  let expression = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]!
    if (character === '{') {
      const end = matchingBraceEnd(pattern, index)
      if (end > index) {
        const choices = splitAlternatives(pattern.slice(index + 1, end))
        expression += choices.length > 1 ? `(?:${choices.map(globBody).join('|')})` : `\\{${globBody(choices[0] ?? '')}\\}`
        index = end
        continue
      }
    }
    if (character === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) {
        let content = pattern.slice(index + 1, end)
        if (content.startsWith('!')) content = `^${content.slice(1)}`
        expression += `(?=[^/])[${content.replace(/\\/g, '\\\\').replace(/\]/g, '\\]')}]`
        index = end
        continue
      }
    }
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        if (pattern[index + 2] === '/') {
          expression += '(?:[\\s\\S]*/)?'
          index += 2
        } else {
          expression += '[\\s\\S]*'
          index++
        }
      } else expression += '[^/]*'
      continue
    }
    if (character === '?') {
      expression += '[^/]'
      continue
    }
    expression += /[\\^$.*+?()[\]{}|]/.test(character) ? `\\${character}` : character
  }
  return expression
}

function protectedGlob(pattern: string): RegExp {
  const normalized = normalizedGlob(pattern)
  const directoryOnly = normalized.endsWith('/')
  const body = directoryOnly ? normalized.slice(0, -1) : normalized
  try {
    return new RegExp(`^${globBody(body)}${directoryOnly ? '/[\\s\\S]*' : ''}$`)
  } catch {
    return /^[\s\S]*$/
  }
}


/** Returns changed paths matching any configured protected glob, preserving diff order. */
export function findProtectedPaths(files: string[], patterns: string[]): string[] {
  const globs = patterns.filter((pattern) => pattern.trim() !== '').map(protectedGlob)
  if (globs.length === 0) return []
  const hits: string[] = []
  for (const rawPath of files) {
    const path = rawPath.replace(/^\.\//, '')
    if (globs.some((glob) => glob.test(path))) hits.push(rawPath)
  }
  return hits
}

function checkSignature(iteration: IterationDetail): string {
  const check = iteration.check
  return check === null ? 'no-check' : `${check.pass}|${check.exitCode}|${check.timedOut}`
}

function checkOutput(iteration: IterationDetail): string {
  const check = iteration.check
  return check === null ? '' : `${check.exitCode}\u0000${check.stdoutTail}\u0000${check.stderrTail}`
}

/** True for three comparable settled iterations with no tree or check-output progress. */
export function hasNoProgress(history: IterationDetail[], workspaceKind: LoopSnapshot['workspaceKind']): boolean {
  const settledByIteration = new Map<number, IterationDetail>()
  for (const iteration of history) {
    if (iteration.endReason !== 'settled') continue
    const previous = settledByIteration.get(iteration.n)
    if (!previous || iteration.attempt > previous.attempt) settledByIteration.set(iteration.n, iteration)
  }
  const recent = [...settledByIteration.values()].sort((left, right) => right.n - left.n).slice(0, 3)
  if (recent.length !== 3) return false

  const measured = recent.map((iteration) => iteration.treeBefore !== null && iteration.treeAfter !== null)
  if (measured.every(Boolean)) {
    if (recent.some((iteration) => iteration.treeBefore !== iteration.treeAfter)) return false
  } else {
    if (measured.some(Boolean) || workspaceKind !== 'folder') return false
    if (recent.some((iteration) => iteration.check?.ran !== true)) return false
  }

  const signature = checkSignature(recent[0]!)
  const output = checkOutput(recent[0]!)
  return recent.every((iteration) => checkSignature(iteration) === signature && checkOutput(iteration) === output)
}
