import type { AskAnswer, AskQuestion, AskSpec } from '@quirky/protocol'

export const OTHER = '__other__'

export type Draft =
  | { type: 'select'; choice: string | null; other: string }
  | { type: 'multiselect'; values: string[] }
  | { type: 'text'; text: string }
  | { type: 'confirm'; value: boolean | null }

export type Drafts = Record<string, Draft>

export function emptyDraft(question: AskQuestion): Draft {
  switch (question.type) {
    case 'select':
      return { type: 'select', choice: null, other: '' }
    case 'multiselect':
      return { type: 'multiselect', values: [] }
    case 'text':
      return { type: 'text', text: '' }
    case 'confirm':
      return { type: 'confirm', value: null }
  }
}

export function emptyDrafts(spec: AskSpec): Drafts {
  return Object.fromEntries(spec.questions.map((q) => [q.id, emptyDraft(q)]))
}

/** Turns the form state into `ask.answer` params; questions without an answer go in `skipped`. */
export function buildAnswers(
  spec: AskSpec,
  drafts: Drafts
): { answers: Record<string, AskAnswer>; skipped: string[] } {
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  for (const question of spec.questions) {
    const answer = answerFor(question, drafts[question.id])
    if (answer) answers[question.id] = answer
    else skipped.push(question.id)
  }
  return { answers, skipped }
}

function answerFor(question: AskQuestion, draft: Draft | undefined): AskAnswer | null {
  if (!draft) return null
  if (question.type === 'select' && draft.type === 'select') {
    if (draft.choice === OTHER) {
      const text = draft.other.trim()
      return text ? { value: text, source: 'other' } : null
    }
    const option = question.options.find((o) => o.value === draft.choice)
    return option ? { value: option.value, label: option.label, source: 'option' } : null
  }
  if (question.type === 'multiselect' && draft.type === 'multiselect') {
    const chosen = question.options.filter((o) => draft.values.includes(o.value))
    if (chosen.length === 0) return null
    return {
      values: chosen.map((o) => o.value),
      labels: chosen.map((o) => o.label),
      source: 'options'
    }
  }
  if (question.type === 'text' && draft.type === 'text') {
    const text = draft.text.trim()
    return text ? { value: text, source: 'input' } : null
  }
  if (question.type === 'confirm' && draft.type === 'confirm') {
    return draft.value === null ? null : { value: draft.value, source: 'input' }
  }
  return null
}
