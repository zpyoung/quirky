import type { AskAnswer, AskAnswers } from '../../shared/fork-ask-question-tool/ask-answer-envelope'
import type {
  AskOption,
  AskQuestion,
  AskRegistryResult,
  AskSpec
} from '../../shared/fork-ask-question-tool/ask-question-schema'
import {
  buildResultSummary,
  nonBlank,
  parseConfirmAnswerValue,
  parseDateAnswerValue,
  parseNumberAnswerValue
} from './ask-answer-value-parsing'

/** Renders an `AskSpec` as the plain-text question C7 hands to the orchestration ask/reply flow (tech.md C7). */
export function flattenAskSpecToQuestion(spec: AskSpec): string {
  const blocks = spec.questions.map((question, index) => renderQuestionBlock(question, index + 1))
  return [...blocks, 'answer with one line per question: <id>: <answer>'].join('\n\n')
}

function renderQuestionBlock(question: AskQuestion, position: number): string {
  const lines = [`${position}. [${question.id}] ${question.question}`]
  if (question.type === 'select' || question.type === 'multiselect') {
    for (const option of question.options) {
      lines.push(`- ${option.value} — ${option.label}`)
    }
  }
  return lines.join('\n')
}

/**
 * Maps a coordinator's plain-text reply back to an answer result (tech.md C7). A reply with no
 * `<id>: <text>` (or positional `<n>:`) line at all is applied whole to the first question
 * through that question's own type rules; every other question is skipped.
 */
export function mapCoordinatorReply(spec: AskSpec, reply: string): AskRegistryResult {
  const matched = matchReplyLines(spec, reply)
  const answers: AskAnswers = {}
  const skipped: string[] = []

  if (matched.size === 0) {
    applyWholeReplyToFirstQuestion(spec, reply, answers, skipped)
  } else {
    for (const question of spec.questions) {
      const text = matched.get(question.id)
      const answer = text === undefined ? null : parseAnswerLine(question, text)
      if (answer) {
        answers[question.id] = answer
      } else {
        skipped.push(question.id)
      }
    }
  }
  return { answers, skipped, summary: buildResultSummary(spec, answers) }
}

function matchReplyLines(spec: AskSpec, reply: string): Map<string, string> {
  const ids = new Set(spec.questions.map((question) => question.id))
  const byId = new Map<string, string>()
  const byPosition = new Map<number, string>()
  for (const rawLine of reply.split('\n')) {
    const line = rawLine.trim()
    const separatorIndex = line.indexOf(':')
    if (separatorIndex === -1) {
      continue
    }
    const key = line.slice(0, separatorIndex).trim()
    const text = line.slice(separatorIndex + 1).trim()
    if (ids.has(key)) {
      byId.set(key, text)
      continue
    }
    const position = Number(key)
    if (Number.isInteger(position)) {
      byPosition.set(position, text)
    }
  }

  const resolved = new Map<string, string>()
  spec.questions.forEach((question, index) => {
    const text = byId.get(question.id) ?? byPosition.get(index + 1)
    if (text !== undefined) {
      resolved.set(question.id, text)
    }
  })
  return resolved
}

function findOptionByValueOrLabel(options: AskOption[], text: string): AskOption | undefined {
  return options.find((option) => option.value === text || option.label === text)
}

// A matched line whose text is empty or whitespace-only counts as absent, mirroring the
// timeout-draft rule, rather than becoming an empty-string "other" answer.
function parseAnswerLine(question: AskQuestion, text: string): AskAnswer | null {
  switch (question.type) {
    case 'select': {
      const raw = nonBlank(text)
      if (raw === undefined) {
        return null
      }
      const option = findOptionByValueOrLabel(question.options, raw)
      return option
        ? { value: option.value, label: option.label, source: 'option' }
        : { value: raw, source: 'other' }
    }
    case 'multiselect': {
      const tokens = text
        .split(',')
        .map((token) => token.trim())
        .filter((token) => token.length > 0)
      const matchedOptions: AskOption[] = []
      const unmatched: string[] = []
      for (const token of tokens) {
        const option = findOptionByValueOrLabel(question.options, token)
        if (option) {
          matchedOptions.push(option)
        } else {
          unmatched.push(token)
        }
      }
      const ordered = question.options.filter((option) => matchedOptions.includes(option))
      const other = unmatched.length > 0 ? unmatched.join(', ') : undefined
      if (ordered.length === 0 && !other) {
        return null
      }
      return {
        values: ordered.map((option) => option.value),
        labels: ordered.map((option) => option.label),
        other,
        source: 'options'
      }
    }
    case 'text': {
      const raw = nonBlank(text)
      return raw === undefined ? null : { value: raw, source: 'input' }
    }
    case 'number': {
      const raw = nonBlank(text)
      const value = raw === undefined ? null : parseNumberAnswerValue(question, raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'date': {
      const raw = nonBlank(text)
      const value = raw === undefined ? null : parseDateAnswerValue(raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'confirm': {
      const raw = nonBlank(text)
      const value = raw === undefined ? null : parseConfirmAnswerValue(raw)
      return value === null ? null : { value, source: 'input' }
    }
  }
}

function applyWholeReplyToFirstQuestion(
  spec: AskSpec,
  reply: string,
  answers: AskAnswers,
  skipped: string[]
): void {
  const [first, ...rest] = spec.questions
  if (first) {
    const answer = buildFallbackAnswer(first, reply)
    if (answer) {
      answers[first.id] = answer
    } else {
      skipped.push(first.id)
    }
  }
  for (const question of rest) {
    skipped.push(question.id)
  }
}

// select/multiselect/text always succeed here (tech.md C7): with no parseable line at all,
// there is nothing to match against, so the whole reply becomes free text rather than a guess.
function buildFallbackAnswer(question: AskQuestion, reply: string): AskAnswer | null {
  switch (question.type) {
    case 'select':
      return { value: reply, source: 'other' }
    case 'multiselect':
      return { values: [], labels: [], other: reply, source: 'options' }
    case 'text':
      return { value: reply, source: 'input' }
    case 'number': {
      const raw = nonBlank(reply)
      const value = raw === undefined ? null : parseNumberAnswerValue(question, raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'date': {
      const raw = nonBlank(reply)
      const value = raw === undefined ? null : parseDateAnswerValue(raw)
      return value === null ? null : { value, source: 'input' }
    }
    case 'confirm': {
      const raw = nonBlank(reply)
      const value = raw === undefined ? null : parseConfirmAnswerValue(raw)
      return value === null ? null : { value, source: 'input' }
    }
  }
}
