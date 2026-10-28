import { validateValue, type AskEnvelope, type AskQuestion, type AskSpec, type Schema } from '@quirky/protocol'

export type NativeQuestionPlan = { spec: AskSpec; keys: { id: string; key: string }[] }
const NO_ANSWER = 'No answer from the watcher owner; proceed with your best judgment.'

type NativeQuestionInput = {
  questions: { id?: string; question: string; header?: string; multiSelect?: boolean; isSecret?: boolean; secret?: boolean; sensitive?: boolean; masked?: boolean; options?: { label: string; description?: string }[] }[]
}
const NATIVE_QUESTIONS: Schema = {
  type: 'object',
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' }, question: { type: 'string' }, header: { type: 'string' },
          multiSelect: { type: 'boolean' }, isSecret: { type: 'boolean' }, secret: { type: 'boolean' },
          sensitive: { type: 'boolean' }, masked: { type: 'boolean' },
          options: { type: 'array', items: { type: 'object', properties: { label: { type: 'string' }, description: { type: 'string' } }, required: ['label'], additionalProperties: true } }
        },
        required: ['question'],
        additionalProperties: true
      }
    }
  },
  required: ['questions'],
  additionalProperties: true
}

/** Native question tools are decisions, never tool permissions; secret requests cannot become cards. */
export function nativeQuestionPlan(input: unknown, provider: 'claude' | 'codex'): NativeQuestionPlan {
  const problem = validateValue(NATIVE_QUESTIONS, input)
  if (problem !== null) throw new Error(`Invalid native questions: ${problem}`)
  // The public schema above validates every field consumed below.
  const parsed = input as NativeQuestionInput
  if (parsed.questions.length < 1 || parsed.questions.length > 10) throw new Error('Native questions require between one and ten questions')
  const questions: AskQuestion[] = []
  const keys: NativeQuestionPlan['keys'] = []
  const ids = new Set<string>()
  for (const [index, raw] of parsed.questions.entries()) {
    if (!raw.question.trim()) throw new Error('Native question text is missing')
    if (raw.isSecret === true || raw.secret === true || raw.sensitive === true || raw.masked === true) throw new Error('Secret native questions must be collected out of band')
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `q${index + 1}`
    if (ids.has(id)) throw new Error(`Native questions contain duplicate identity ${id}`)
    ids.add(id)
    keys.push({ id, key: provider === 'claude' ? raw.question : id })
    const base = { id, question: raw.question, ...(typeof raw.header === 'string' ? { header: raw.header } : {}) }
    const options = (raw.options ?? []).map((option, optionIndex) => {
      if (!option.label.trim()) throw new Error('Native question option label is missing')
      return { value: `o${optionIndex + 1}`, label: option.label, ...(option.description === undefined ? {} : { description: option.description }) }
    })
    if (options.length > 12) {
      questions.push({ ...base, type: 'text', multiline: true, question: `${raw.question}\n${options.map((option) => `- ${option.label}${option.description ? ` — ${option.description}` : ''}`).join('\n')}` })
    } else if (options.length > 0) {
      questions.push({ ...base, type: raw.multiSelect === true ? 'multiselect' : 'select', options })
    } else questions.push({ ...base, type: 'text', multiline: true })
  }
  return { spec: { questions }, keys }
}

/** Builds only the provider's question-answer value, never an approval decision. */
export function nativeQuestionAnswers(plan: NativeQuestionPlan, envelope: AskEnvelope | null): Record<string, string[]> {
  const answers: Record<string, string[]> = Object.create(null)
  for (const { id, key } of plan.keys) {
    const answer = envelope && (envelope.status === 'answered' || envelope.status === 'partial') ? envelope.answers[id] : undefined
    if (!answer) { answers[key] = [NO_ANSWER]; continue }
    if ('values' in answer) {
      answers[key] = [...(answer.labels ?? answer.values), ...(answer.other ? [answer.other] : [])]
    } else {
      const value = 'label' in answer && typeof answer.label === 'string' ? answer.label : String(answer.value)
      answers[key] = [value, ...('note' in answer && typeof answer.note === 'string' && answer.note ? [answer.note] : [])]
    }
  }
  return answers
}
