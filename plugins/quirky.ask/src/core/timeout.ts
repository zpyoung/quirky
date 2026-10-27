import type { AskAnswer, AskPartial, AskPartialQuestionDraft, AskQuestion, AskSpec } from '@quirky/protocol'
import { buildSummary, parseDateAnswerValue, parseNumberAnswerValue, parseTextAnswerValue } from './answers'
import { nonBlank } from './values'

type SelectQuestion = Extract<AskQuestion, { type: 'select' }>
type MultiselectQuestion = Extract<AskQuestion, { type: 'multiselect' }>

/**
 * The result of an ask that ran out of time: each question takes its declared default, else the
 * draft the person had typed so far (in the question's answer shape), else it is skipped. A draft
 * that doesn't parse is skipped, never coerced.
 */
export function buildTimeoutResult(
  spec: AskSpec,
  partial: AskPartial
): { answers: Record<string, AskAnswer>; skipped: string[]; summary: string } {
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  for (const question of spec.questions) {
    const answer = defaultAnswer(question) ?? draftAnswer(question, partial[question.id])
    if (answer) answers[question.id] = answer
    else skipped.push(question.id)
  }
  return { answers, skipped, summary: buildSummary(spec, answers) }
}

function defaultAnswer(question: AskQuestion): AskAnswer | null {
  switch (question.type) {
    case 'select': {
      if (question.default === undefined) return null
      const label = question.options.find((option) => option.value === question.default)?.label
      return { value: question.default, ...(label === undefined ? {} : { label }), source: 'default' }
    }
    case 'multiselect':
      if (question.default === undefined) return null
      return {
        values: question.default,
        labels: question.default.map((value) => question.options.find((option) => option.value === value)?.label ?? value),
        source: 'default'
      }
    case 'text':
    case 'date':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
    case 'number':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
    case 'confirm':
      return question.default === undefined ? null : { value: question.default, source: 'default' }
  }
}

function draftAnswer(question: AskQuestion, draft: AskPartialQuestionDraft | undefined): AskAnswer | null {
  if (!draft) return null
  switch (question.type) {
    case 'select':
      return selectDraft(question, draft)
    case 'multiselect':
      return multiselectDraft(question, draft)
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

function selectDraft(question: SelectQuestion, draft: AskPartialQuestionDraft): AskAnswer | null {
  const picked = draft.selected?.[0]
  const option = picked === undefined ? undefined : question.options.find((candidate) => candidate.value === picked)
  const note = nonBlank(draft.note)
  const withNote = note === undefined ? {} : { note }
  if (option) return { value: option.value, label: option.label, ...withNote, source: 'option' }
  const other = nonBlank(draft.other)
  return other ? { value: other, ...withNote, source: 'other' } : null
}

function multiselectDraft(question: MultiselectQuestion, draft: AskPartialQuestionDraft): AskAnswer | null {
  const matched = (draft.selected ?? []).flatMap((value) => question.options.find((candidate) => candidate.value === value) ?? [])
  const other = nonBlank(draft.other)
  if (matched.length === 0 && !other) return null
  return {
    values: matched.map((option) => option.value),
    labels: matched.map((option) => option.label),
    ...(other === undefined ? {} : { other }),
    source: 'options'
  }
}
