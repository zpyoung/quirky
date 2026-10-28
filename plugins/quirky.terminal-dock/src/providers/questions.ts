import { createHash } from 'node:crypto'
import type { DockQuestion } from '../types'

type RecordValue = Record<string, unknown>

type Identity = {
  agent: string
  providerSession: string
  requestId?: string | null
  turnStartedAt?: number | null
  stateStartedAt?: number | null
  eventAt?: number | null
}

export type AnswerGroup = { indexes: number[]; labels: string[]; text: string | null }

const asRecord = (value: unknown): RecordValue | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as RecordValue) : null

function cleanText(value: unknown, limit = 2_000): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/\u0000/g, '').trim()
  return text ? text.slice(0, limit) : null
}

function stableJson(value: unknown, depth = 0): string {
  if (depth > 12) return 'null'
  if (Array.isArray(value)) return `[${value.slice(0, 100).map((item) => stableJson(item, depth + 1)).join(',')}]`
  const record = asRecord(value)
  if (record) {
    const entries = Object.entries(record).sort(([left], [right]) => left.localeCompare(right)).slice(0, 100)
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item, depth + 1)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function requestIdentity(identity: Identity, payload: unknown): string {
  const actualId = cleanText(identity.requestId, 512)
  const id = actualId ?? createHash('sha256').update(stableJson({
    payload,
    providerSession: identity.providerSession,
    turnStartedAt: identity.turnStartedAt ?? null,
    stateStartedAt: identity.stateStartedAt ?? null,
    eventAt: identity.eventAt ?? null
  })).digest('hex')
  return `${identity.agent}:${identity.providerSession}:${id}`
}

function parsedObject(value: unknown): RecordValue | null {
  if (typeof value === 'string') {
    try {
      return asRecord(JSON.parse(value) as unknown)
    } catch {
      return null
    }
  }
  return asRecord(value)
}

const SECRET_FIELDS = ['isSecret', 'is_secret', 'sensitive', 'masked', 'secret'] as const

function containsSecretInput(record: RecordValue): boolean {
  return SECRET_FIELDS.some((field) =>
    Object.hasOwn(record, field) && record[field] !== false && record[field] !== null
  )
}


function toChoices(value: unknown): { label: string; value: string }[] | null {
  if (!Array.isArray(value) || value.length > 50) return null
  const choices: { label: string; value: string }[] = []
  for (const optionValue of value) {
    const option = asRecord(optionValue)
    const label = typeof optionValue === 'string'
      ? cleanText(optionValue, 300)
      : cleanText(option?.label ?? option?.title, 300)
    if (!label) continue
    const choiceValue = cleanText(option?.value ?? option?.id, 300) ?? label
    if (choices.some((choice) => choice.value === choiceValue)) continue
    choices.push({ label, value: choiceValue })
  }
  return choices
}

function questionGroup(value: unknown, index: number): DockQuestion['questions'][number] | null {
  const item = asRecord(value)
  if (!item || containsSecretInput(item)) return null
  const prompt = cleanText(item.question ?? item.prompt ?? item.text ?? item.message, 2_000)
  const choiceField = item.options ?? item.choices
  if (Array.isArray(choiceField) && choiceField.some((choice) => {
    const option = asRecord(choice)
    return option !== null && containsSecretInput(option)
  })) return null
  const choices = toChoices(choiceField)
  const allowsFreeText = Array.isArray(choiceField) || item.type === 'text' || item.freeform === true || item.allowFreeText === true
  if (!prompt || choices === null && !allowsFreeText) return null
  return {
    id: cleanText(item.id ?? item.questionId ?? item.question_id, 300) ?? `q${index + 1}`,
    prompt,
    choices: choices ?? [],
    multiple: item.multiSelect === true || item.multiple === true
  }
}

export function isQuestionTool(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase()
  return normalized === 'askuserquestion' || normalized === 'requestuserinput' || normalized === 'question'
}

export function questionFromInput(input: unknown, identity: Identity): DockQuestion | null {
  const root = parsedObject(input)
  if (!root || containsSecretInput(root) || !Array.isArray(root.questions) || root.questions.length === 0 || root.questions.length > 20) return null
  const questions = root.questions.map((question, index) => questionGroup(question, index)).filter((question): question is DockQuestion['questions'][number] => question !== null)
  if (questions.length !== root.questions.length) return null
  const first = asRecord(root.questions[0])
  const title = cleanText(root.title ?? root.header ?? first?.header ?? first?.question ?? first?.prompt, 300)
  if (!title) return null
  return {
    id: requestIdentity({
      ...identity,
      requestId: identity.requestId ?? cleanText(root.toolUseId ?? root.tool_use_id ?? root.toolCallId ?? root.tool_call_id ?? root.requestId ?? root.id, 512)
    }, root),
    kind: 'question',
    title,
    questions,
    collapsed: false,
    dismissed: false
  }
}

export function permissionFromHeld(
  held: { toolUseId: string | null; toolName: string; input: string; childId: string | null },
  identity: Identity
): DockQuestion | null {
  const toolName = cleanText(held.toolName, 120)
  if (!toolName) return null
  const input = cleanText(held.input, 2_000) ?? ''
  return {
    id: requestIdentity({ ...identity, requestId: held.toolUseId ?? identity.requestId }, { toolName, input, childId: held.childId }),
    kind: 'permission',
    title: `Allow ${toolName}?`,
    questions: [{
      id: 'permission',
      prompt: input || toolName,
      choices: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' }
      ],
      multiple: false
    }],
    collapsed: false,
    dismissed: false
  }
}

export function permissionFromEnvelope(input: unknown, identity: Identity): DockQuestion | null {
  const root = parsedObject(input)
  const approval = asRecord(root?.approval)
  const tool = cleanText(approval?.tool, 120)
  if (!approval || !tool) return null
  const summary = cleanText(approval.summary ?? approval.input ?? approval.description, 2_000)
  const requestId = cleanText(approval.toolUseId ?? approval.tool_use_id ?? approval.id, 512)
  return {
    id: requestIdentity({ ...identity, requestId: requestId ?? identity.requestId }, { approval }),
    kind: 'permission',
    title: `Allow ${tool}?`,
    questions: [{
      prompt: summary ?? tool,
      id: 'permission',
      choices: [
        { label: 'Allow', value: 'allow' },
        { label: 'Deny', value: 'deny' }
      ],
      multiple: false
    }],
    collapsed: false,
    dismissed: false
  }
}

export function normalizeAnswers(question: DockQuestion, answers: string[][]): { groups: AnswerGroup[]; error: string | null } {
  if (!Array.isArray(answers) || answers.length !== question.questions.length) {
    return { groups: [], error: 'Answer groups do not match the active question.' }
  }
  const groups: AnswerGroup[] = []
  for (let index = 0; index < question.questions.length; index++) {
    const prompt = question.questions[index]!
    const values = answers[index]
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
      return { groups: [], error: `Answers for question ${index + 1} are invalid.` }
    }
    if (prompt.choices.length === 0) {
      if (values.length !== 1 || !values[0]!.trim()) return { groups: [], error: `Question ${index + 1} needs a text answer.` }
      groups.push({ indexes: [], labels: [], text: values[0]!.trim() })
      continue
    }
    if ((!prompt.multiple && values.length > 1) || values.length === 0) {
      return { groups: [], error: `Choose an available option for question ${index + 1}.` }
    }
    const indexes: number[] = []
    const labels: string[] = []
    for (const value of values) {
      const choiceIndex = prompt.choices.findIndex((choice) => choice.value === value || choice.label === value)
      if (choiceIndex < 0) return { groups: [], error: `That answer is not an available choice for question ${index + 1}.` }
      if (indexes.includes(choiceIndex)) return { groups: [], error: `Question ${index + 1} contains a duplicate choice.` }
      indexes.push(choiceIndex)
      labels.push(prompt.choices[choiceIndex]!.label)
    }
    groups.push({ indexes, labels, text: null })
  }
  return { groups, error: null }
}

export function safeAnswerText(value: string): string {
  return value.replace(/\r\n|\r/g, '\n').replace(/\u001b/g, '␛').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
}

export function formatAnswerText(groups: AnswerGroup[]): string {
  return groups.map((group) => safeAnswerText(group.text ?? group.labels.join(', '))).join('\n')
}
