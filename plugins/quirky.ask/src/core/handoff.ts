import type { AskAnswer, AskQuestion, AskSpec } from '@quirky/protocol'

const MAX_HANDOFF_TEXT = 64 * 1024
const MAX_REPLY_TEXT = 32 * 1024

export type MappedCoordinatorReply = { answers: Record<string, AskAnswer>; skipped: string[] }

/** Renders the validated typed spec for the coordinator while retaining every question and option ID. */
export function flattenAskSpec(spec: AskSpec): string {
  const lines: string[] = []
  if (spec.title) lines.push(spec.title)
  for (const [index, question] of spec.questions.entries()) {
    lines.push(`${index + 1}. [${question.id}] ${question.question}`)
    if (question.type === 'select' || question.type === 'multiselect') {
      for (const option of question.options) lines.push(`- ${option.value} — ${option.label}`)
    }
  }
  lines.push('Answer with one line per question: <id>: <answer>')
  const result = lines.join('\n')
  if (result.length > MAX_HANDOFF_TEXT) throw new Error(`handoff question exceeds ${MAX_HANDOFF_TEXT} characters`)
  return result
}

function answersByQuestion(spec: AskSpec, text: string): Map<string, string> {
  const questions = new Map(spec.questions.map((question, index) => [question.id, index]))
  const answers = new Map<string, string>()
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([^:]+):\s*(.*)$/.exec(line)
    if (!match) continue
    const key = match[1]!.trim()
    const index = /^\d+$/.test(key) ? Number(key) - 1 : questions.get(key)
    const question = typeof index === 'number' && index >= 0 ? spec.questions[index] : undefined
    if (question) answers.set(question.id, match[2]!.trim())
  }
  if (answers.size === 0 && text.trim() !== '' && spec.questions[0]) answers.set(spec.questions[0].id, text.trim())
  return answers
}

function optionFor(question: Extract<AskQuestion, { type: 'select' | 'multiselect' }>, value: string) {
  const folded = value.toLocaleLowerCase()
  return question.options.find((option) => option.value.toLocaleLowerCase() === folded || option.label.toLocaleLowerCase() === folded)
}

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00.000Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function answerOf(question: AskQuestion, raw: string): AskAnswer | null {
  const value = raw.trim()
  if (!value) return null
  switch (question.type) {
    case 'select': {
      const option = optionFor(question, value)
      return option
        ? { value: option.value, label: option.label, source: 'option' }
        : { value, source: 'other' }
    }
    case 'multiselect': {
      const values: string[] = []
      const labels: string[] = []
      const unmatched: string[] = []
      for (const item of value.split(',').map((part) => part.trim()).filter(Boolean)) {
        const option = optionFor(question, item)
        if (!option) unmatched.push(item)
        else if (!values.includes(option.value)) {
          values.push(option.value)
          labels.push(option.label)
        }
      }
      const other = unmatched.join(', ')
      if (values.length === 0 && other === '') return null
      return { values, labels, ...(other ? { other } : {}), source: 'options' }
    }
    case 'text':
      if (question.pattern && !new RegExp(question.pattern).test(value)) return null
      if (question.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return null
      if (question.format === 'url') {
        try {
          const url = new URL(value)
          if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
        } catch {
          return null
        }
      }
      return { value, source: 'input' }
    case 'number': {
      const number = Number(value)
      if (!Number.isFinite(number) || question.integer && !Number.isInteger(number)) return null
      if (question.min !== undefined && number < question.min || question.max !== undefined && number > question.max) return null
      return { value: number, source: 'input' }
    }
    case 'date':
      return validDate(value) ? { value, source: 'input' } : null
    case 'confirm': {
      const normalized = value.toLowerCase()
      if (['yes', 'y', 'true', '1'].includes(normalized)) return { value: true, source: 'input' }
      if (['no', 'n', 'false', '0'].includes(normalized)) return { value: false, source: 'input' }
      return null
    }
  }
}

/** Converts coordinator free text back to validated typed answers; absent or malformed values are skipped. */
export function mapCoordinatorReply(spec: AskSpec, reply: string): MappedCoordinatorReply {
  if (reply.length > MAX_REPLY_TEXT) throw new Error(`handoff answer exceeds ${MAX_REPLY_TEXT} characters`)
  const values = answersByQuestion(spec, reply)
  const answers: Record<string, AskAnswer> = {}
  const skipped: string[] = []
  for (const question of spec.questions) {
    const raw = values.get(question.id)
    const answer = raw === undefined ? null : answerOf(question, raw)
    if (answer === null) skipped.push(question.id)
    else answers[question.id] = answer
  }
  return { answers, skipped }
}
