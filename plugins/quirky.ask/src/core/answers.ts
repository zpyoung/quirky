import type { AskAnswer, AskOption, AskQuestion, AskSpec } from '@quirky/protocol'
import { FORMAT_PATTERNS, isPlainObject, isValidIsoDate, nonBlank } from './values'

type TextQuestion = Extract<AskQuestion, { type: 'text' }>
type NumberQuestion = Extract<AskQuestion, { type: 'number' }>

const MAX_PATTERN_TEST_LENGTH = 200

/**
 * The text if it satisfies the question's pattern and format, else null. Input beyond the
 * pattern test bound is refused unmatched, so a stored pattern can't be run on unbounded text.
 */
export function parseTextAnswerValue(question: TextQuestion, raw: string): string | null {
  if (question.pattern) {
    if (raw.length > MAX_PATTERN_TEST_LENGTH) return null
    let regex: RegExp
    try {
      regex = new RegExp(question.pattern)
    } catch {
      return null
    }
    if (!regex.test(raw)) return null
  }
  if (question.format && !FORMAT_PATTERNS[question.format].test(raw)) return null
  return raw
}

/** The number if it is finite and inside the question's integer, min and max rules, else null. */
export function parseNumberAnswerValue(question: NumberQuestion, raw: string): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return null
  if (question.integer && !Number.isInteger(parsed)) return null
  if (question.min !== undefined && parsed < question.min) return null
  if (question.max !== undefined && parsed > question.max) return null
  return parsed
}

/** The date if it is a real `YYYY-MM-DD` calendar date, else null. */
export function parseDateAnswerValue(raw: string): string | null {
  return isValidIsoDate(raw) ? raw : null
}

function renderAnswerValue(answer: AskAnswer): string {
  if ('values' in answer) {
    return answer.other ? [...answer.labels, answer.other].join(', ') : answer.labels.join(', ')
  }
  if ('label' in answer && answer.label) return answer.label
  if (typeof answer.value === 'boolean') return answer.value ? 'Yes' : 'No'
  return String(answer.value)
}

/** One line per answered question in spec order, `<header or question>: <value>`, for the agent to quote. */
export function buildSummary(spec: AskSpec, answers: Record<string, AskAnswer>): string {
  return spec.questions
    .filter((question) => question.id in answers)
    .map((question) => `${question.header ?? question.question}: ${renderAnswerValue(answers[question.id])}`)
    .join('\n')
}

function findOption(options: AskOption[], value: string): AskOption | undefined {
  return options.find((option) => option.value === value)
}

type OneAnswer = { ok: true; answer: AskAnswer } | { ok: false; message: string }

function fail(message: string): OneAnswer {
  return { ok: false, message }
}

function checkOneAnswer(question: AskQuestion, raw: Record<string, unknown>): OneAnswer {
  if (raw.source === 'default') return fail('source "default" is only set when the ask times out')
  switch (question.type) {
    case 'select': {
      const note = typeof raw.note === 'string' ? nonBlank(raw.note) : undefined
      const withNote = note === undefined ? {} : { note }
      if (raw.source === 'other') {
        if (typeof raw.value !== 'string' || nonBlank(raw.value) === undefined) {
          return fail('free-text value must be a non-empty string')
        }
        return { ok: true, answer: { value: raw.value, ...withNote, source: 'other' } }
      }
      const option = typeof raw.value === 'string' ? findOption(question.options, raw.value) : undefined
      if (!option) return fail('value must be one of the question options')
      return { ok: true, answer: { value: option.value, label: option.label, ...withNote, source: 'option' } }
    }
    case 'multiselect': {
      if (!Array.isArray(raw.values) || !raw.values.every((value) => typeof value === 'string')) {
        return fail('values must be an array of strings')
      }
      const matched: AskOption[] = []
      for (const value of raw.values as string[]) {
        const option = findOption(question.options, value)
        if (!option) return fail(`${value} is not one of the question options`)
        if (!matched.includes(option)) matched.push(option)
      }
      const other = typeof raw.other === 'string' ? nonBlank(raw.other) : undefined
      return {
        ok: true,
        answer: {
          values: matched.map((option) => option.value),
          labels: matched.map((option) => option.label),
          ...(other === undefined ? {} : { other }),
          source: 'options'
        }
      }
    }
    case 'text':
      if (typeof raw.value !== 'string' || parseTextAnswerValue(question, raw.value) === null) {
        return fail('value does not match the question pattern/format')
      }
      return { ok: true, answer: { value: raw.value, source: 'input' } }
    case 'number': {
      if (typeof raw.value !== 'number' || parseNumberAnswerValue(question, String(raw.value)) === null) {
        return fail('value is outside the question domain')
      }
      return { ok: true, answer: { value: raw.value, source: 'input' } }
    }
    case 'date':
      if (typeof raw.value !== 'string' || parseDateAnswerValue(raw.value) === null) {
        return fail('value must be an ISO 8601 calendar date')
      }
      return { ok: true, answer: { value: raw.value, source: 'input' } }
    case 'confirm':
      if (typeof raw.value !== 'boolean') return fail('value must be a boolean')
      return { ok: true, answer: { value: raw.value, source: 'input' } }
  }
}

/**
 * Checks a submission against the stored spec and rebuilds the stored answers from it, so labels
 * and sources never come from the caller. A question in neither `answers` nor `skipped` counts as
 * skipped unless it is `required`. Any violation refuses the whole submission with every problem
 * in one message, so the caller never commits a partly valid one.
 */
export function validateAnswerSubmission(
  spec: AskSpec,
  answers: unknown,
  skipped: unknown
): { ok: true; answers: Record<string, AskAnswer>; skipped: string[] } | { ok: false; message: string } {
  const problems: string[] = []
  if (!isPlainObject(answers)) return { ok: false, message: 'answers: must be an object' }
  const skippedInput = skipped ?? []
  if (!Array.isArray(skippedInput) || !skippedInput.every((id) => typeof id === 'string')) {
    return { ok: false, message: 'skipped: must be an array of strings' }
  }

  const questionsById = new Map(spec.questions.map((question) => [question.id, question]))
  const skippedIds = [...new Set(skippedInput as string[])]

  for (const id of Object.keys(answers)) {
    if (!questionsById.has(id)) problems.push(`answers.${id}: unknown question id`)
  }
  for (const id of skippedIds) {
    const question = questionsById.get(id)
    if (!question) problems.push(`skipped: ${id} is not a known question id`)
    else if (question.required) problems.push(`skipped: ${id} is required and cannot be skipped`)
    if (id in answers) problems.push(`skipped: ${id} is both answered and skipped`)
  }

  const rebuilt: Record<string, AskAnswer> = {}
  const omitted: string[] = []
  for (const question of spec.questions) {
    if (!(question.id in answers)) {
      if (skippedIds.includes(question.id)) continue
      if (question.required) problems.push(`answers.${question.id}: question was neither answered nor skipped`)
      else omitted.push(question.id)
      continue
    }
    const raw = answers[question.id]
    if (!isPlainObject(raw)) {
      problems.push(`answers.${question.id}: answer must be an object`)
      continue
    }
    const checked = checkOneAnswer(question, raw)
    if (checked.ok) rebuilt[question.id] = checked.answer
    else problems.push(`answers.${question.id}: ${checked.message}`)
  }

  if (problems.length > 0) return { ok: false, message: problems.join('; ') }
  return { ok: true, answers: rebuilt, skipped: [...skippedIds, ...omitted] }
}
