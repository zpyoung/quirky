import type { AskAnswer, AskPartial, AskPartialQuestionDraft, AskQuestion, AskSpec } from '@quirky/protocol'
import { FORMAT_PATTERNS, isValidIsoDate, nonBlank } from './values'

// mirrors the daemon's bound in answers.ts, which refuses longer text when a pattern applies
const MAX_PATTERN_TEST_LENGTH = 200

/** The window's working state for one question, before it is parsed against the question's type. */
export type QuestionDraft = {
  /** Option values picked: 0 or 1 for a select, any number for a multiselect. */
  selected: string[]
  /** The "Add your own answer" input: a note beside a pick, else the answer itself. */
  freeText: string
  /** Raw input for text, number and date questions. */
  text: string
  confirm: boolean | null
}

/** The window state for a question, restored from its saved draft when there is one. */
export function initialDraftFor(partial?: AskPartialQuestionDraft): QuestionDraft {
  return {
    selected: partial?.selected ? [...partial.selected] : [],
    freeText: (partial?.selected?.length ? (partial.note ?? partial.other) : partial?.other) ?? '',
    text: partial?.draft ?? '',
    confirm: partial?.confirm ?? null
  }
}

function draftToPartial(draft: QuestionDraft, multiselect: boolean): AskPartialQuestionDraft | undefined {
  const partial: AskPartialQuestionDraft = {}
  if (draft.selected.length > 0) {
    partial.selected = [...draft.selected]
    // the answer and the timeout builder read a multiselect's free text only from `other`
    if (draft.freeText) partial[multiselect ? 'other' : 'note'] = draft.freeText
  } else if (draft.freeText) {
    partial.other = draft.freeText
  }
  if (draft.text) partial.draft = draft.text
  if (draft.confirm !== null) partial.confirm = draft.confirm
  return Object.keys(partial).length > 0 ? partial : undefined
}

/**
 * The saved-draft form of the window state, leaving out questions with nothing entered. Pass the
 * spec so a multiselect's free text is saved as `other`; without it every question is treated as a
 * select and picks with free text save as `note`.
 */
export function draftsToPartial(drafts: Record<string, QuestionDraft>, spec?: AskSpec): AskPartial {
  const multiselects = new Set(spec?.questions.filter((q) => q.type === 'multiselect').map((q) => q.id))
  const partial: AskPartial = {}
  for (const [questionId, draft] of Object.entries(drafts)) {
    const entry = draftToPartial(draft, multiselects.has(questionId))
    if (entry) partial[questionId] = entry
  }
  return partial
}

type Outcome = { kind: 'answer'; answer: AskAnswer } | { kind: 'skipped' } | { kind: 'error'; message: string }

const error = (message: string): Outcome => ({ kind: 'error', message })
const answer = (value: AskAnswer): Outcome => ({ kind: 'answer', answer: value })

function requiredOrSkipped(question: AskQuestion): Outcome {
  return question.required ? error('This question is required.') : { kind: 'skipped' }
}

function resolveSelect(question: AskQuestion & { type: 'select' }, draft: QuestionDraft): Outcome {
  const note = nonBlank(draft.freeText)?.trim()
  const picked = question.options.find((option) => option.value === draft.selected[0])
  if (picked) {
    return answer({ value: picked.value, label: picked.label, ...(note ? { note } : {}), source: 'option' })
  }
  if (note) return answer({ value: note, source: 'other' })
  return requiredOrSkipped(question)
}

function resolveMultiselect(question: AskQuestion & { type: 'multiselect' }, draft: QuestionDraft): Outcome {
  const other = nonBlank(draft.freeText)?.trim()
  // spec order, not click order: readers scan the record positionally
  const picked = question.options.filter((option) => draft.selected.includes(option.value))
  if (picked.length === 0 && !other) return requiredOrSkipped(question)
  return answer({
    values: picked.map((option) => option.value),
    labels: picked.map((option) => option.label),
    ...(other ? { other } : {}),
    source: 'options'
  })
}

function resolveText(question: AskQuestion & { type: 'text' }, draft: QuestionDraft): Outcome {
  const value = draft.text
  if (!nonBlank(value)) return requiredOrSkipped(question)
  if (question.format === 'email' && !FORMAT_PATTERNS.email.test(value)) return error('Enter a valid email address.')
  if (question.format === 'url' && !FORMAT_PATTERNS.url.test(value)) return error('Enter a valid URL.')
  if (question.pattern) {
    if (value.length > MAX_PATTERN_TEST_LENGTH) return error("Doesn't match the expected format.")
    let matches = true
    try {
      matches = new RegExp(question.pattern).test(value)
    } catch {
      // an unparseable pattern is rejected when the ask is created, so it must not block a submit here
    }
    if (!matches) return error("Doesn't match the expected format.")
  }
  return answer({ value, source: 'input' })
}

function resolveNumber(question: AskQuestion & { type: 'number' }, draft: QuestionDraft): Outcome {
  const raw = draft.text.trim()
  if (!raw) return requiredOrSkipped(question)
  const value = Number(raw)
  if (!Number.isFinite(value)) return error('Enter a number.')
  if (question.integer && !Number.isInteger(value)) return error('Enter a whole number.')
  if (question.min !== undefined && value < question.min) return error(`Enter a number of at least ${question.min}.`)
  if (question.max !== undefined && value > question.max) return error(`Enter a number of at most ${question.max}.`)
  return answer({ value, source: 'input' })
}

function resolveDate(question: AskQuestion & { type: 'date' }, draft: QuestionDraft): Outcome {
  const raw = draft.text.trim()
  if (!raw) return requiredOrSkipped(question)
  if (!isValidIsoDate(raw)) return error('Enter a valid date.')
  return answer({ value: raw, source: 'input' })
}

function resolveQuestion(question: AskQuestion, draft: QuestionDraft): Outcome {
  switch (question.type) {
    case 'select':
      return resolveSelect(question, draft)
    case 'multiselect':
      return resolveMultiselect(question, draft)
    case 'text':
      return resolveText(question, draft)
    case 'number':
      return resolveNumber(question, draft)
    case 'date':
      return resolveDate(question, draft)
    case 'confirm':
      return draft.confirm === null ? requiredOrSkipped(question) : answer({ value: draft.confirm, source: 'input' })
  }
}

/**
 * Checks every question and builds what `ask.answer` takes. Any error blocks the whole submission,
 * and all failing questions are reported together. A question with no draft counts as blank.
 */
export function buildSubmission(
  spec: AskSpec,
  drafts: Record<string, QuestionDraft>
): { ok: true; answers: Record<string, AskAnswer>; skipped: string[] } | { ok: false; errors: Record<string, string> } {
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  const errors: Record<string, string> = {}
  for (const question of spec.questions) {
    const outcome = resolveQuestion(question, drafts[question.id] ?? initialDraftFor())
    if (outcome.kind === 'answer') answers[question.id] = outcome.answer
    else if (outcome.kind === 'skipped') skipped.push(question.id)
    else errors[question.id] = outcome.message
  }
  return Object.keys(errors).length > 0 ? { ok: false, errors } : { ok: true, answers, skipped }
}
