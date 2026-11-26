import type { AskAnswer, AskAnswers } from './ask-answer-envelope'
import type { AskOption, AskQuestion, AskSpec } from './ask-question-schema'
import {
  nonBlank,
  parseConfirmAnswerValue,
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue
} from './ask-answer-value-parsing'

export type AskAnswerValidationError = { path: string; message: string }
export type AskAnswerValidationResult =
  | { ok: true; answers: AskAnswers; skipped: string[] }
  | { ok: false; errors: AskAnswerValidationError[] }

function findOption(options: AskOption[], value: string): AskOption | undefined {
  return options.find((option) => option.value === value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null
  }
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length === value.length ? strings : null
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function validateOneAnswer(
  question: AskQuestion,
  raw: Record<string, unknown>,
  path: string,
  errors: AskAnswerValidationError[]
): void {
  switch (question.type) {
    case 'select': {
      if (raw.source === 'other') {
        if (typeof raw.value !== 'string' || nonBlank(raw.value) === undefined) {
          errors.push({
            path: `${path}.value`,
            message: 'free-text value must be a non-empty string'
          })
        }
        return
      }
      if (typeof raw.value !== 'string' || !findOption(question.options, raw.value)) {
        errors.push({ path: `${path}.value`, message: 'value must be one of the question options' })
      }
      return
    }
    case 'multiselect': {
      const submitted = readStringArray(raw.values)
      if (submitted === null) {
        errors.push({ path: `${path}.values`, message: 'values must be an array of strings' })
        return
      }
      for (const value of submitted) {
        if (!findOption(question.options, value)) {
          errors.push({
            path: `${path}.values`,
            message: `${value} is not one of the question options`
          })
        }
      }
      if (
        question.required &&
        submitted.length === 0 &&
        nonBlank(optionalString(raw.other)) === undefined
      ) {
        errors.push({
          path: `${path}.values`,
          message: 'a required question needs at least one value or a non-blank other'
        })
      }
      return
    }
    case 'text':
      if (typeof raw.value === 'string' && question.required && nonBlank(raw.value) === undefined) {
        errors.push({
          path: `${path}.value`,
          message: 'a required question needs a non-blank value'
        })
        return
      }
      if (typeof raw.value !== 'string' || parseTextAnswerValue(question, raw.value) === null) {
        errors.push({
          path: `${path}.value`,
          message: 'value does not match the question pattern/format'
        })
      }
      return
    case 'number':
      if (
        typeof raw.value !== 'number' ||
        parseNumberAnswerValue(question, String(raw.value)) === null
      ) {
        errors.push({ path: `${path}.value`, message: 'value is outside the question domain' })
      }
      return
    case 'date':
      if (typeof raw.value !== 'string' || parseDateAnswerValue(raw.value) === null) {
        errors.push({ path: `${path}.value`, message: 'value must be an ISO 8601 calendar date' })
      }
      return
    case 'confirm':
      if (typeof raw.value !== 'boolean' || parseConfirmAnswerValue(String(raw.value)) === null) {
        errors.push({ path: `${path}.value`, message: 'value must be a boolean' })
      }
  }
}

function buildTypedAnswer(question: AskQuestion, raw: Record<string, unknown>): AskAnswer {
  switch (question.type) {
    case 'select': {
      const value = raw.value as string
      const option = findOption(question.options, value)
      return option
        ? {
            value: option.value,
            label: option.label,
            note: optionalString(raw.note),
            source: 'option'
          }
        : { value, note: optionalString(raw.note), source: 'other' }
    }
    case 'multiselect': {
      const matched = [...new Set(readStringArray(raw.values) ?? [])]
        .map((value) => findOption(question.options, value))
        .filter((option): option is AskOption => option !== undefined)
      return {
        values: matched.map((option) => option.value),
        labels: matched.map((option) => option.label),
        other: optionalString(raw.other),
        source: 'options'
      }
    }
    case 'text':
      return { value: raw.value as string, source: 'input' }
    case 'number':
      return { value: raw.value as number, source: 'input' }
    case 'date':
      return { value: raw.value as string, source: 'input' }
    case 'confirm':
      return { value: raw.value as boolean, source: 'input' }
  }
}

/**
 * Validates a submission against the stored spec (tech.md C4): every answered id is known, every
 * skipped id is known and non-required, every question is answered xor skipped, and each answer's
 * shape matches its own question's domain. Any violation rejects the whole submission — the
 * caller must not commit a partially-valid one.
 */
export function validateAskAnswerSubmission(
  spec: AskSpec,
  rawAnswers: Record<string, unknown>,
  skipped: string[]
): AskAnswerValidationResult {
  const errors: AskAnswerValidationError[] = []
  const questionsById = new Map(spec.questions.map((question) => [question.id, question]))
  const skippedSet = new Set(skipped)

  for (const id of Object.keys(rawAnswers)) {
    if (!questionsById.has(id)) {
      errors.push({ path: `answers.${id}`, message: 'unknown question id' })
    }
  }
  for (const id of skipped) {
    const question = questionsById.get(id)
    if (!question) {
      errors.push({ path: 'skipped', message: `${id} is not a known question id` })
    } else if (question.required) {
      errors.push({ path: 'skipped', message: `${id} is required and cannot be skipped` })
    }
    if (Object.hasOwn(rawAnswers, id)) {
      errors.push({ path: 'skipped', message: `${id} is both answered and skipped` })
    }
  }
  for (const question of spec.questions) {
    if (!Object.hasOwn(rawAnswers, question.id) && !skippedSet.has(question.id)) {
      errors.push({
        path: `answers.${question.id}`,
        message: 'question was neither answered nor skipped'
      })
    }
  }
  for (const [id, raw] of Object.entries(rawAnswers)) {
    const question = questionsById.get(id)
    if (!question) {
      continue
    }
    if (!isRecord(raw)) {
      errors.push({ path: `answers.${id}`, message: 'answer must be an object' })
      continue
    }
    validateOneAnswer(question, raw, `answers.${id}`, errors)
  }

  if (errors.length > 0) {
    return { ok: false, errors }
  }
  const answers: AskAnswers = {}
  for (const question of spec.questions) {
    const raw = Object.hasOwn(rawAnswers, question.id) ? rawAnswers[question.id] : undefined
    if (isRecord(raw)) {
      answers[question.id] = buildTypedAnswer(question, raw)
    }
  }
  return { ok: true, answers, skipped }
}
