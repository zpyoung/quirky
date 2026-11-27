import { translate } from '@/i18n/i18n'
import type {
  AskAnswer,
  AskAnswers
} from '../../../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskNumberQuestion,
  AskQuestion,
  AskTextQuestion
} from '../../../../shared/fork-ask-question-tool/ask-question-schema'
import {
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue
} from '../../../../shared/fork-ask-question-tool/ask-answer-value-parsing'
import type { AskQuestionDraft } from './ask-question-draft'

export type AskFieldOutcome =
  | { kind: 'answer'; answer: AskAnswer }
  | { kind: 'skipped' }
  | { kind: 'error'; message: string }

function requiredOrSkip(question: AskQuestion): AskFieldOutcome {
  return question.required
    ? {
        kind: 'error',
        message: translate(
          'components.fork-ask-question-tool.askCard.requiredError',
          'This question is required.'
        )
      }
    : { kind: 'skipped' }
}

function resolveOptionQuestion(
  question: AskQuestion & { type: 'select' | 'multiselect' },
  draft: AskQuestionDraft
): AskFieldOutcome {
  const freeText = draft.freeText.trim()
  if (question.type === 'select') {
    const picked = question.options.find((option) => option.value === draft.selected[0])
    if (picked) {
      return {
        kind: 'answer',
        answer: {
          value: picked.value,
          label: picked.label,
          note: freeText || undefined,
          source: 'option'
        }
      }
    }
    if (freeText) {
      return { kind: 'answer', answer: { value: freeText, source: 'other' } }
    }
    return requiredOrSkip(question)
  }

  // Emitted in spec option order, not click order — the answer is a record readers
  // scan positionally, and click order isn't a signal worth exposing.
  const pickedOptions = question.options.filter((option) => draft.selected.includes(option.value))
  if (pickedOptions.length === 0 && !freeText) {
    return requiredOrSkip(question)
  }
  return {
    kind: 'answer',
    answer: {
      values: pickedOptions.map((option) => option.value),
      labels: pickedOptions.map((option) => option.label),
      other: freeText || undefined,
      source: 'options'
    }
  }
}

/** The shared parser answers only valid or not; re-parsing without `format` tells a pattern miss from a format miss. */
function textErrorMessage(question: AskTextQuestion, value: string): string {
  if (parseTextAnswerValue({ ...question, format: undefined }, value) === null) {
    return translate(
      'components.fork-ask-question-tool.askCard.textPatternError',
      "Doesn't match the expected format."
    )
  }
  return question.format === 'url'
    ? translate('components.fork-ask-question-tool.askCard.textUrlError', 'Enter a valid URL.')
    : translate(
        'components.fork-ask-question-tool.askCard.textEmailError',
        'Enter a valid email address.'
      )
}

function resolveTextQuestion(
  question: AskQuestion & { type: 'text' },
  draft: AskQuestionDraft
): AskFieldOutcome {
  const value = draft.text
  if (value.trim().length === 0) {
    return requiredOrSkip(question)
  }
  if (parseTextAnswerValue(question, value) === null) {
    return { kind: 'error', message: textErrorMessage(question, value) }
  }
  return { kind: 'answer', answer: { value, source: 'input' } }
}

/** Relaxes one constraint at a time so the first one the shared parser rejects names the message. */
function numberErrorMessage(question: AskNumberQuestion, raw: string): string {
  const unbounded = { ...question, integer: false, min: undefined, max: undefined }
  if (parseNumberAnswerValue(unbounded, raw) === null) {
    return translate(
      'components.fork-ask-question-tool.askCard.numberInvalidError',
      'Enter a number.'
    )
  }
  if (parseNumberAnswerValue({ ...unbounded, integer: question.integer }, raw) === null) {
    return translate(
      'components.fork-ask-question-tool.askCard.numberIntegerError',
      'Enter a whole number.'
    )
  }
  if (parseNumberAnswerValue({ ...unbounded, min: question.min }, raw) === null) {
    return translate(
      'components.fork-ask-question-tool.askCard.numberMinError',
      'Enter a number of at least {{value0}}.',
      { value0: question.min }
    )
  }
  return translate(
    'components.fork-ask-question-tool.askCard.numberMaxError',
    'Enter a number of at most {{value0}}.',
    { value0: question.max }
  )
}

function resolveNumberQuestion(
  question: AskQuestion & { type: 'number' },
  draft: AskQuestionDraft
): AskFieldOutcome {
  const raw = draft.text.trim()
  if (draft.numberBadInput) {
    return {
      kind: 'error',
      message: translate(
        'components.fork-ask-question-tool.askCard.numberInvalidError',
        'Enter a number.'
      )
    }
  }
  if (raw.length === 0) {
    return requiredOrSkip(question)
  }
  const value = parseNumberAnswerValue(question, raw)
  if (value === null) {
    return { kind: 'error', message: numberErrorMessage(question, raw) }
  }
  return { kind: 'answer', answer: { value, source: 'input' } }
}

function resolveDateQuestion(
  question: AskQuestion & { type: 'date' },
  draft: AskQuestionDraft
): AskFieldOutcome {
  const raw = draft.text.trim()
  if (raw.length === 0) {
    return requiredOrSkip(question)
  }
  if (parseDateAnswerValue(raw) === null) {
    return {
      kind: 'error',
      message: translate(
        'components.fork-ask-question-tool.askCard.dateInvalidError',
        'Enter a valid date.'
      )
    }
  }
  return { kind: 'answer', answer: { value: raw, source: 'input' } }
}

function resolveConfirmQuestion(
  question: AskQuestion & { type: 'confirm' },
  draft: AskQuestionDraft
): AskFieldOutcome {
  if (draft.confirm === null) {
    return requiredOrSkip(question)
  }
  return { kind: 'answer', answer: { value: draft.confirm, source: 'input' } }
}

/** Resolves one question's draft into an answer, a skip, or a blocking validation error. */
export function resolveAskFieldOutcome(
  question: AskQuestion,
  draft: AskQuestionDraft
): AskFieldOutcome {
  switch (question.type) {
    case 'select':
    case 'multiselect':
      return resolveOptionQuestion(question, draft)
    case 'text':
      return resolveTextQuestion(question, draft)
    case 'number':
      return resolveNumberQuestion(question, draft)
    case 'date':
      return resolveDateQuestion(question, draft)
    case 'confirm':
      return resolveConfirmQuestion(question, draft)
  }
}

export type AskSubmissionResult =
  | { ok: true; answers: AskAnswers; skipped: string[] }
  | { ok: false; errors: Record<string, string> }

/** Resolves every question's draft; blocks the whole submission on the first pass with any error. */
export function buildAskSubmission(
  questions: AskQuestion[],
  drafts: Record<string, AskQuestionDraft>
): AskSubmissionResult {
  const answers: AskAnswers = {}
  const skipped: string[] = []
  const errors: Record<string, string> = {}

  for (const question of questions) {
    const draft = drafts[question.id]
    if (!draft) {
      continue
    }
    const outcome = resolveAskFieldOutcome(question, draft)
    if (outcome.kind === 'answer') {
      answers[question.id] = outcome.answer
    } else if (outcome.kind === 'skipped') {
      skipped.push(question.id)
    } else {
      errors[question.id] = outcome.message
    }
  }

  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers, skipped }
}
