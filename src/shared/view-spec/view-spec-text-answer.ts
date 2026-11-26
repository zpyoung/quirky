import { isPlainObject } from './view-spec-check-state'
import { MAX_PATTERN_TEST_LENGTH } from './view-spec-regex-safety'
import { FORMAT_PATTERNS, type ViewNode } from './view-spec-types'

/** The reason `raw` breaks the text question's pattern or format, else undefined. */
export function textAnswerError(
  question: { pattern?: unknown; format?: unknown },
  raw: string
): string | undefined {
  if (typeof question.pattern === 'string') {
    if (raw.length > MAX_PATTERN_TEST_LENGTH) {
      return `must be at most ${MAX_PATTERN_TEST_LENGTH} characters`
    }
    let regex: RegExp
    try {
      regex = new RegExp(question.pattern)
    } catch {
      return 'does not match the required pattern'
    }
    if (!regex.test(raw)) {
      return 'does not match the required pattern'
    }
  }
  if (
    (question.format === 'email' || question.format === 'url') &&
    !FORMAT_PATTERNS[question.format].test(raw)
  ) {
    return `is not a valid ${question.format}`
  }
  return undefined
}

/** The text field question with id `name` in the spec, if there is one. */
export function findTextQuestion(
  node: ViewNode,
  name: string
): Record<string, unknown> | undefined {
  const question = node.type === 'field' ? node.props?.question : undefined
  if (
    isPlainObject(question) &&
    question.id === name &&
    (question.type === 'text' || question.type === undefined)
  ) {
    return question
  }
  for (const child of node.children ?? []) {
    const hit = findTextQuestion(child, name)
    if (hit) {
      return hit
    }
  }
  return undefined
}
