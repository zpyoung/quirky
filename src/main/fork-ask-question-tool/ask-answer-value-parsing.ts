import type { AskAnswer, AskAnswers } from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import { MAX_PATTERN_TEST_LENGTH } from '../../shared/fork-ask-question-tool/ask-question-field-validation'
import type {
  AskNumberQuestion,
  AskSpec,
  AskTextQuestion
} from '../../shared/fork-ask-question-tool/ask-question-schema'

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}

/** A value counts as absent once trimmed to nothing, matching every free-text draft in this feature. */
export function nonBlank(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

/** True only for a real calendar date: `Date` silently rolls `2026-02-30` into March, so the parsed value must round-trip. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** `question.pattern` was already validated compilable at registration; the try/catch is defense in depth. */
export function parseTextAnswerValue(question: AskTextQuestion, raw: string): string | null {
  if (question.pattern) {
    if (raw.length > MAX_PATTERN_TEST_LENGTH) {
      return null
    }
    let regex: RegExp
    try {
      regex = new RegExp(question.pattern)
    } catch {
      return null
    }
    if (!regex.test(raw)) {
      return null
    }
  }
  if (question.format && !FORMAT_PATTERNS[question.format].test(raw)) {
    return null
  }
  return raw
}

export function parseNumberAnswerValue(question: AskNumberQuestion, raw: string): number | null {
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) {
    return null
  }
  if (question.integer && !Number.isInteger(parsed)) {
    return null
  }
  if (question.min !== undefined && parsed < question.min) {
    return null
  }
  if (question.max !== undefined && parsed > question.max) {
    return null
  }
  return parsed
}

export function parseDateAnswerValue(raw: string): string | null {
  return isCalendarDate(raw) ? raw : null
}

export function parseConfirmAnswerValue(raw: string): boolean | null {
  const normalized = raw.trim().toLowerCase()
  if (normalized === 'yes' || normalized === 'true') {
    return true
  }
  if (normalized === 'no' || normalized === 'false') {
    return false
  }
  return null
}

function renderAnswerValue(answer: AskAnswer): string {
  if ('values' in answer) {
    return answer.other ? [...answer.labels, answer.other].join(', ') : answer.labels.join(', ')
  }
  if ('label' in answer && answer.label) {
    return answer.label
  }
  if (typeof answer.value === 'boolean') {
    return answer.value ? 'Yes' : 'No'
  }
  return String(answer.value)
}

/** One human-readable line per answered question, in spec order, for the model to quote (logic.md § Answer contract). */
export function buildResultSummary(spec: AskSpec, answers: AskAnswers): string {
  return spec.questions
    .filter((question) => question.id in answers)
    .map(
      (question) =>
        `${question.header ?? question.question}: ${renderAnswerValue(answers[question.id])}`
    )
    .join('\n')
}
