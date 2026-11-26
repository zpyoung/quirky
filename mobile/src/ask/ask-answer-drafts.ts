import type { AskAnswers } from '../../../src/shared/fork-ask-question-tool/ask-answer-envelope'
import { validateAskAnswerSubmission } from '../../../src/shared/fork-ask-question-tool/ask-answer-validation'
import {
  nonBlank,
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue
} from '../../../src/shared/fork-ask-question-tool/ask-answer-value-parsing'
import type {
  AskPartial,
  AskPartialQuestionDraft,
  AskQuestion,
  AskSpec
} from '../../../src/shared/fork-ask-question-tool/ask-question-schema'

/** Widget state for one question; `text` holds the raw input of text, number and date questions. */
export type AskQuestionDraft = {
  selected: string[]
  freeText: string
  text: string
  confirm: boolean | null
}

export type AskDrafts = Record<string, AskQuestionDraft>

export type AskSubmission =
  | { ok: true; answers: AskAnswers; skipped: string[] }
  | { ok: false; errors: Record<string, string>; formError: string | null }

type FieldOutcome =
  | { kind: 'answer'; answer: Record<string, unknown> }
  | { kind: 'skipped' }
  | { kind: 'error'; message: string }

const REQUIRED_MESSAGE = 'This question is required.'

function emptyDraft(): AskQuestionDraft {
  return { selected: [], freeText: '', text: '', confirm: null }
}

function draftFromPartial(partial: AskPartialQuestionDraft): AskQuestionDraft {
  return {
    selected: partial.selected ?? [],
    freeText: (partial.selected?.length ? partial.note : partial.other) ?? '',
    text: partial.draft ?? '',
    confirm: partial.confirm ?? null
  }
}

/** Drafts for every question, seeded only from what the host already holds; spec defaults apply on timeout, never on submit. */
export function initialAskDrafts(spec: AskSpec, partial: AskPartial): AskDrafts {
  const drafts: AskDrafts = {}
  for (const question of spec.questions) {
    const held = partial[question.id]
    drafts[question.id] = held ? draftFromPartial(held) : emptyDraft()
  }
  return drafts
}

function draftToPartial(draft: AskQuestionDraft): AskPartialQuestionDraft | undefined {
  const partial: AskPartialQuestionDraft = {}
  if (draft.selected.length > 0) {
    partial.selected = draft.selected
    if (draft.freeText) {
      partial.note = draft.freeText
    }
  } else if (draft.freeText) {
    partial.other = draft.freeText
  }
  if (draft.text) {
    partial.draft = draft.text
  }
  if (draft.confirm !== null) {
    partial.confirm = draft.confirm
  }
  return Object.keys(partial).length > 0 ? partial : undefined
}

/** The normalized shape `ask.updatePartial` stores; questions with nothing entered are omitted. */
export function askDraftsToPartial(drafts: AskDrafts): AskPartial {
  const partial: AskPartial = {}
  for (const [questionId, draft] of Object.entries(drafts)) {
    const normalized = draftToPartial(draft)
    if (normalized) {
      partial[questionId] = normalized
    }
  }
  return partial
}

function requiredOrSkipped(question: AskQuestion): FieldOutcome {
  return question.required ? { kind: 'error', message: REQUIRED_MESSAGE } : { kind: 'skipped' }
}

function resolveOptionQuestion(
  question: AskQuestion & { type: 'select' | 'multiselect' },
  draft: AskQuestionDraft
): FieldOutcome {
  const freeText = nonBlank(draft.freeText)?.trim()
  if (question.type === 'select') {
    const picked = question.options.find((option) => option.value === draft.selected[0])
    if (picked) {
      return {
        kind: 'answer',
        answer: { value: picked.value, note: freeText, source: 'option' }
      }
    }
    return freeText
      ? { kind: 'answer', answer: { value: freeText, source: 'other' } }
      : requiredOrSkipped(question)
  }
  const pickedValues = question.options
    .filter((option) => draft.selected.includes(option.value))
    .map((option) => option.value)
  if (pickedValues.length === 0 && !freeText) {
    return requiredOrSkipped(question)
  }
  return {
    kind: 'answer',
    answer: { values: pickedValues, other: freeText, source: 'options' }
  }
}

function numberErrorMessage(question: AskQuestion & { type: 'number' }, raw: string): string {
  const value = Number(raw)
  if (!Number.isFinite(value)) {
    return 'Enter a number.'
  }
  if (question.integer && !Number.isInteger(value)) {
    return 'Enter a whole number.'
  }
  if (question.min !== undefined && value < question.min) {
    return `Enter a number of at least ${question.min}.`
  }
  return `Enter a number of at most ${question.max}.`
}

function resolveField(question: AskQuestion, draft: AskQuestionDraft): FieldOutcome {
  switch (question.type) {
    case 'select':
    case 'multiselect':
      return resolveOptionQuestion(question, draft)
    case 'text': {
      if (nonBlank(draft.text) === undefined) {
        return requiredOrSkipped(question)
      }
      if (parseTextAnswerValue(question, draft.text) === null) {
        return {
          kind: 'error',
          message:
            question.format === 'email'
              ? 'Enter a valid email address.'
              : question.format === 'url'
                ? 'Enter a valid URL.'
                : "Doesn't match the expected format."
        }
      }
      return { kind: 'answer', answer: { value: draft.text, source: 'input' } }
    }
    case 'number': {
      const raw = draft.text.trim()
      if (raw.length === 0) {
        return requiredOrSkipped(question)
      }
      const value = parseNumberAnswerValue(question, raw)
      return value === null
        ? { kind: 'error', message: numberErrorMessage(question, raw) }
        : { kind: 'answer', answer: { value, source: 'input' } }
    }
    case 'date': {
      const raw = draft.text.trim()
      if (raw.length === 0) {
        return requiredOrSkipped(question)
      }
      return parseDateAnswerValue(raw) === null
        ? { kind: 'error', message: 'Enter a valid date as YYYY-MM-DD.' }
        : { kind: 'answer', answer: { value: raw, source: 'input' } }
    }
    case 'confirm':
      return draft.confirm === null
        ? requiredOrSkipped(question)
        : { kind: 'answer', answer: { value: draft.confirm, source: 'input' } }
  }
}

/**
 * Resolves every draft into the answer/skip split `ask.answer` takes. The host runs the same shared
 * validator, so a submission this accepts is one the host accepts; per-field messages come first so
 * the card can point at the field that is wrong.
 */
export function buildAskSubmission(spec: AskSpec, drafts: AskDrafts): AskSubmission {
  const rawAnswers: Record<string, unknown> = {}
  const skipped: string[] = []
  const errors: Record<string, string> = {}
  for (const question of spec.questions) {
    const draft = drafts[question.id] ?? emptyDraft()
    const outcome = resolveField(question, draft)
    if (outcome.kind === 'answer') {
      rawAnswers[question.id] = outcome.answer
    } else if (outcome.kind === 'skipped') {
      skipped.push(question.id)
    } else {
      errors[question.id] = outcome.message
    }
  }
  if (Object.keys(errors).length > 0) {
    return { ok: false, errors, formError: null }
  }
  const validation = validateAskAnswerSubmission(spec, rawAnswers, skipped)
  if (!validation.ok) {
    return {
      ok: false,
      errors: {},
      formError: validation.errors.map((error) => error.message).join('; ')
    }
  }
  return { ok: true, answers: validation.answers, skipped: validation.skipped }
}
