import type { AskSpec } from '@quirky/protocol'
import { UsageError } from '../args'

const QUESTION_TYPES = ['select', 'multiselect', 'text', 'confirm']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== ''
}

/** Checks an ask spec against the protocol's shape, naming the offending field on failure. */
export function validateAskSpec(value: unknown): AskSpec {
  if (!isRecord(value)) throw new UsageError('--spec: spec must be an object with a "questions" array')
  if (value.title !== undefined && typeof value.title !== 'string') {
    throw new UsageError('--spec: title must be a string')
  }
  const questions = value.questions
  if (!Array.isArray(questions)) throw new UsageError('--spec: "questions" must be an array')
  if (questions.length === 0) throw new UsageError('--spec: questions must contain at least one question')
  const seen = new Set<string>()
  questions.forEach((question, index) => {
    const at = `questions[${index}]`
    if (!isRecord(question)) throw new UsageError(`--spec: ${at} must be an object`)
    if (!nonEmptyString(question.id)) throw new UsageError(`--spec: ${at}.id must be a non-empty string`)
    if (seen.has(question.id)) throw new UsageError(`--spec: ${at}.id is a duplicate of "${question.id}"`)
    seen.add(question.id)
    if (typeof question.type !== 'string' || !QUESTION_TYPES.includes(question.type)) {
      throw new UsageError(`--spec: ${at}.type must be one of ${QUESTION_TYPES.join(', ')}`)
    }
    if (!nonEmptyString(question.question)) {
      throw new UsageError(`--spec: ${at}.question must be a non-empty string`)
    }
    if (question.header !== undefined && typeof question.header !== 'string') {
      throw new UsageError(`--spec: ${at}.header must be a string`)
    }
    if (question.type === 'select' || question.type === 'multiselect') {
      const options = question.options
      if (!Array.isArray(options) || options.length === 0) {
        throw new UsageError(`--spec: ${at}.options must be a non-empty array`)
      }
      options.forEach((option, optionIndex) => {
        const optionAt = `${at}.options[${optionIndex}]`
        if (!isRecord(option)) throw new UsageError(`--spec: ${optionAt} must be an object`)
        if (!nonEmptyString(option.value)) throw new UsageError(`--spec: ${optionAt}.value must be a non-empty string`)
        if (!nonEmptyString(option.label)) throw new UsageError(`--spec: ${optionAt}.label must be a non-empty string`)
      })
    }
  })
  return value as unknown as AskSpec
}

/** Parses the `--spec` argument: inline JSON, or `@path` read through `readFile`. */
export function parseAskSpec(arg: string, readFile: (path: string) => string): AskSpec {
  let text = arg
  if (arg.startsWith('@')) {
    const path = arg.slice(1)
    try {
      text = readFile(path)
    } catch (error) {
      throw new UsageError(`--spec: cannot read ${path}: ${(error as Error).message}`)
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new UsageError(`--spec is not valid JSON: ${(error as Error).message}`)
  }
  return validateAskSpec(parsed)
}
