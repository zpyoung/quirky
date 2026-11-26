import type { AskAnswer, AskAnswers } from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskMultiselectQuestion,
  AskPartialQuestionDraft,
  AskQuestion,
  AskRegistryResult,
  AskSelectQuestion,
  AskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'
import {
  buildResultSummary,
  nonBlank,
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue
} from '../../shared/fork-ask-question-tool/ask-answer-value-parsing'
import { sanitizeAskPartial } from './ask-partial-draft-sanitizer'

/**
 * Builds the terminal result for a `--timeout-ms` expiry: a declared `default` wins, else the
 * user's partial draft normalized into the question's answer shape, else the question is
 * skipped (tech.md C2). Never coerces an unparseable draft into a typed slot.
 */
export function buildTimeoutResult(spec: AskSpec, rawPartial: unknown): AskRegistryResult {
  const partial = sanitizeAskPartial(spec, rawPartial)
  const answers: AskAnswers = {}
  const skipped: string[] = []
  for (const question of spec.questions) {
    const answer = buildDefaultAnswer(question) ?? buildDraftAnswer(question, partial[question.id])
    if (answer) {
      answers[question.id] = answer
    } else {
      skipped.push(question.id)
    }
  }
  return { answers, skipped, summary: buildResultSummary(spec, answers) }
}

function buildDefaultAnswer(question: AskQuestion): AskAnswer | null {
  switch (question.type) {
    case 'select':
      return question.default === undefined
        ? null
        : {
            value: question.default,
            label: question.options.find((option) => option.value === question.default)?.label,
            source: 'default'
          }
    case 'multiselect':
      return question.default === undefined
        ? null
        : {
            values: question.default,
            labels: question.default.map(
              (value) => question.options.find((option) => option.value === value)?.label ?? value
            ),
            source: 'default'
          }
    case 'text':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
    case 'number':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
    case 'date':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
    case 'confirm':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
  }
}

function buildDraftAnswer(
  question: AskQuestion,
  draft: AskPartialQuestionDraft | undefined
): AskAnswer | null {
  if (!draft) {
    return null
  }
  switch (question.type) {
    case 'select':
      return buildSelectDraftAnswer(question, draft)
    case 'multiselect':
      return buildMultiselectDraftAnswer(question, draft)
    case 'text': {
      const raw = nonBlank(draft.draft)
      const value = raw === undefined ? null : parseTextAnswerValue(question, raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'number': {
      const raw = nonBlank(draft.draft)
      const value = raw === undefined ? null : parseNumberAnswerValue(question, raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'date': {
      const raw = nonBlank(draft.draft)
      const value = raw === undefined ? null : parseDateAnswerValue(raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'confirm':
      return draft.confirm === undefined ? null : { value: draft.confirm, source: 'input' }
  }
}

function buildSelectDraftAnswer(
  question: AskSelectQuestion,
  draft: AskPartialQuestionDraft
): AskAnswer | null {
  const selectedValue = draft.selected?.[0]
  const option =
    selectedValue === undefined
      ? undefined
      : question.options.find((candidate) => candidate.value === selectedValue)
  if (option) {
    return {
      value: option.value,
      label: option.label,
      note: nonBlank(draft.note),
      source: 'option'
    }
  }
  const other = nonBlank(draft.other)
  return other ? { value: other, note: nonBlank(draft.note), source: 'other' } : null
}

function buildMultiselectDraftAnswer(
  question: AskMultiselectQuestion,
  draft: AskPartialQuestionDraft
): AskAnswer | null {
  const matched = (draft.selected ?? [])
    .map((value) => question.options.find((candidate) => candidate.value === value))
    .filter((option) => option !== undefined)
  const other = nonBlank(draft.other)
  if (matched.length === 0 && !other) {
    return null
  }
  return {
    values: matched.map((option) => option.value),
    labels: matched.map((option) => option.label),
    other,
    source: 'options'
  }
}
