import { Buffer } from 'node:buffer'
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isJsonValue, isRecord as record } from './json'
import type { JudgmentQuestion, JudgmentQuestionRequest } from './contracts'

export const MAX_JUDGMENT_STATE_BYTES = 32 * 1024
export const MAX_JUDGMENT_REQUEST_BYTES = 256 * 1024
export const MAX_JUDGMENT_RESPONSE_BYTES = 1024 * 1024
export const JUDGMENT_ATTEMPT_TIMEOUT_MS = 5_000
const CONFIG_FILE_MODE = 0o600
const MAX_CONFIG_BYTES = 8 * 1024
const MAX_ATTEMPTS = 3
const RETRY_BASE_DELAY_MS = 100
const DISTRIBUTION_TOLERANCE = 1e-6
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

type Provider = 'typesafe' | 'openrouter'
type JudgmentConfig = { provider: Provider; apiKey: string }
type ConfigRead = { kind: 'disabled' } | { kind: 'enabled'; config: JudgmentConfig } | { kind: 'unavailable' }
type JudgmentUnavailableReason =
  | 'missing-answer' | 'answer-shape' | 'answer-type' | 'missing-confidence' | 'missing-probabilities'
  | 'score-weight-mismatch' | 'score-legend' | 'score-range' | 'probability-keys'
  | 'probability-distribution' | 'choice-invalid' | 'choice-not-max'
type JudgmentAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number }
export type JudgmentResponse = {
  model: string
  answers: Record<string, JudgmentAnswer>
  unavailable?: Record<string, JudgmentUnavailableReason>
}
export type ShadowJudgment =
  | { status: 'disabled' }
  | { status: 'skipped' }
  | { status: 'observed'; provider: Provider; result: JudgmentResponse }
  | {
      status: 'failed'
      provider?: Provider
      reason: 'configuration-unavailable' | 'state-invalid' | 'state-too-large' | 'questions-unavailable' |
        'questions-invalid' | 'request-too-large' | 'timeout' | 'request-failed' | 'http-error' |
        'response-too-large' | 'malformed-response'
      statusCode?: number
      detail?: string
    }

type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>
type ParsedAnswer = { answer: JudgmentAnswer } | { unavailable: JudgmentUnavailableReason }
type ResponseProblem = 'invalid-utf8' | 'invalid-json' | 'invalid-envelope' | 'unexpected-answer'
type BoundedResponse = { kind: 'body'; text: string } | { kind: 'too-large' } | { kind: 'malformed' }

class JudgmentSizeError extends Error {
  constructor(readonly limit: 'state' | 'request') {
    super(`judgment ${limit} exceeds its size limit`)
  }
}

function privateConfig(dataDir: string): ConfigRead {
  const path = join(dataDir, 'judgment-access.json')
  let fd: number
  try {
    const pathInfo = lstatSync(path)
    if (pathInfo.isSymbolicLink() || !pathInfo.isFile() || pathInfo.size > MAX_CONFIG_BYTES) {
      return { kind: 'unavailable' }
    }
    fd = openSync(path, constants.O_RDONLY | NOFOLLOW)
  } catch (error) {
    if (record(error) && error.code === 'ENOENT') return { kind: 'disabled' }
    return { kind: 'unavailable' }
  }
  try {
    const info = fstatSync(fd)
    const pathInfo = lstatSync(path)
    if (!info.isFile() || info.size > MAX_CONFIG_BYTES || (info.mode & 0o777) !== CONFIG_FILE_MODE ||
      pathInfo.isSymbolicLink() || pathInfo.dev !== info.dev || pathInfo.ino !== info.ino) return { kind: 'unavailable' }
    const parsed: unknown = JSON.parse(readFileSync(fd, { encoding: 'utf8' }))
    if (!record(parsed)) return { kind: 'unavailable' }
    if (parsed.enabled === false) {
      return Object.keys(parsed).length === 1 ? { kind: 'disabled' } : { kind: 'unavailable' }
    }
    if (parsed.enabled !== true || Object.keys(parsed).some((key) => !['enabled', 'provider', 'apiKey'].includes(key)) ||
      (parsed.provider !== undefined && parsed.provider !== 'typesafe' && parsed.provider !== 'openrouter') ||
      typeof parsed.apiKey !== 'string' || parsed.apiKey.trim().length === 0 || parsed.apiKey.trim().length > 4096) {
      return { kind: 'unavailable' }
    }
    return {
      kind: 'enabled',
      config: { provider: parsed.provider === 'openrouter' ? 'openrouter' : 'typesafe', apiKey: parsed.apiKey.trim() }
    }
  } catch {
    return { kind: 'unavailable' }
  } finally {
    closeSync(fd)
  }
}

function transport(provider: Provider): { endpoint: string; model: string } {
  return provider === 'typesafe'
    ? { endpoint: 'https://api.typesafe.ai/v1/systemone', model: 'jev-latest' }
    : { endpoint: 'https://openrouter.ai/api/alpha/decisions', model: '~typesafe/jev-latest' }
}

function normalizedText(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function normalizedStringRecord(value: unknown, nullableValues: boolean): Record<string, string | null> | null {
  if (!record(value) || !isJsonValue(value)) return null
  const result: Record<string, string | null> = Object.create(null)
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = normalizedText(rawKey)
    if (!key || Object.hasOwn(result, key)) return null
    let normalizedValue: string | null
    if (rawValue === null && nullableValues) normalizedValue = null
    else if (typeof rawValue === 'string') normalizedValue = rawValue
    else return null
    Object.defineProperty(result, key, {
      value: normalizedValue,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return result
}

function normalizeQuestion(value: unknown): JudgmentQuestion | null {
  if (!record(value) || !isJsonValue(value) || typeof value.type !== 'string') return null
  const instructions = normalizedText(value.instructions)
  if (!instructions) return null
  if (value.type === 'choice') {
    if (!exactKeys(value, ['type', 'instructions', 'criteria'])) return null
    const criteria = normalizedStringRecord(value.criteria, true)
    if (!criteria || Object.keys(criteria).length < 2 || Object.keys(criteria).length > 255) return null
    return { type: 'choice', instructions, criteria }
  }
  if (value.type === 'score') {
    if (!exactKeys(value, ['type', 'instructions', 'criteria']) || !Array.isArray(value.criteria) ||
      value.criteria.length < 2 || value.criteria.length > 10) return null
    const criteria = value.criteria.map(normalizedText)
    if (criteria.some((item) => item === null)) return null
    return { type: 'score', instructions, criteria: criteria as string[] }
  }
  if (value.type === 'noul') {
    if (!exactKeys(value, ['type', 'instructions'], ['criteria'])) return null
    if (value.criteria === undefined) return { type: 'noul', instructions }
    if (!record(value.criteria) || !isJsonValue(value.criteria) ||
      Object.keys(value.criteria).some((key) => key !== 'true' && key !== 'false')) return null
    const criteria: { true?: string; false?: string } = {}
    for (const key of ['true', 'false'] as const) {
      if (Object.hasOwn(value.criteria, key)) {
        const text = normalizedText(value.criteria[key])
        if (!text) return null
        criteria[key] = text
      }
    }
    return { type: 'noul', instructions, criteria }
  }
  return null
}

/** Normalizes the original service's request schema before any provider call. */
export function normalizeJudgmentQuestions(value: unknown): JudgmentQuestionRequest[] | null {
  if (!Array.isArray(value) || !isJsonValue(value)) return null
  const requests: JudgmentQuestionRequest[] = []
  const ids = new Set<string>()
  for (const raw of value) {
    if (!record(raw) || !exactKeys(raw, ['id', 'questionId', 'subjectId', 'question'])) return null
    const id = normalizedText(raw.id)
    const questionId = normalizedText(raw.questionId)
    const subjectId = normalizedText(raw.subjectId)
    const question = normalizeQuestion(raw.question)
    if (!id || !questionId || !subjectId || !question || ids.has(id)) return null
    ids.add(id)
    requests.push({ id, questionId, subjectId, question })
  }
  return requests
}

function serializeState(state: unknown): string {
  if (state === null || (typeof state !== 'string' && typeof state !== 'object')) {
    throw new Error('judgment state is invalid')
  }
  let serialized: string | undefined
  try { serialized = JSON.stringify(state) } catch { throw new Error('judgment state is invalid') }
  if (serialized === undefined) throw new Error('judgment state is invalid')
  if (Buffer.byteLength(serialized, 'utf8') > MAX_JUDGMENT_STATE_BYTES) throw new JudgmentSizeError('state')
  return serialized
}

function questionMap(requests: readonly JudgmentQuestionRequest[]): Record<string, JudgmentQuestion> {
  const questions: Record<string, JudgmentQuestion> = Object.create(null)
  for (const request of requests) {
    Object.defineProperty(questions, request.id, {
      value: request.question,
      enumerable: true,
      configurable: true,
      writable: true
    })
  }
  return questions
}

function serializeRequestBody(provider: Provider, stateJson: string, questions: readonly JudgmentQuestionRequest[]): string {
  const model = JSON.stringify(transport(provider).model)
  const questionJson = JSON.stringify(questionMap(questions))
  const body = `{"model":${model},"state":${stateJson},"questions":${questionJson}}`
  if (Buffer.byteLength(body, 'utf8') > MAX_JUDGMENT_REQUEST_BYTES) throw new JudgmentSizeError('request')
  return body
}

export function serializeJudgmentRequest(provider: Provider, state: unknown, questions: unknown): string {
  const stateJson = serializeState(state)
  const requests = normalizeJudgmentQuestions(questions)
  if (!requests || requests.length === 0) throw new Error('judgment questions are invalid or empty')
  return serializeRequestBody(provider, stateJson, requests)
}

function redactResult(value: unknown, apiKey: string): unknown {
  if (typeof value === 'string') return value.replaceAll(apiKey, '[redacted]')
  if (Array.isArray(value)) return value.map((item) => redactResult(item, apiKey))
  if (!record(value)) return value
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    const safeKey = key.replaceAll(apiKey, '[redacted]')
    if (/api.?key|authorization|secret|token/i.test(safeKey)) sanitized[safeKey] = '[redacted]'
    else sanitized[safeKey] = redactResult(item, apiKey)
  }
  return sanitized
}

async function cancelResponse(response: Response): Promise<void> {
  try { await response.body?.cancel() } catch { /* The body is never evidence of a judgment. */ }
}

async function readBoundedResponse(response: Response): Promise<BoundedResponse> {
  const declaredBytes = Number(response.headers.get('content-length') ?? '0')
  if (Number.isFinite(declaredBytes) && declaredBytes > MAX_JUDGMENT_RESPONSE_BYTES) {
    await cancelResponse(response)
    return { kind: 'too-large' }
  }
  if (!response.body) return { kind: 'body', text: '' }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let totalBytes = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      totalBytes += chunk.value.byteLength
      if (totalBytes > MAX_JUDGMENT_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        return { kind: 'too-large' }
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(totalBytes)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return { kind: 'body', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  } catch {
    return { kind: 'malformed' }
  }
}

function validModel(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || value.trim().length === 0) return false
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit <= 0x1f || (codeUnit >= 0x7f && codeUnit <= 0x9f)) return false
  }
  return true
}

function numberInProbabilityRange(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function numberRecord(value: unknown): Record<string, number> | null {
  if (!record(value)) return null
  const result: Record<string, number> = Object.create(null)
  for (const [key, probability] of Object.entries(value)) {
    const id = normalizedText(key)
    if (!id || Object.hasOwn(result, id) || typeof probability !== 'number' || !Number.isFinite(probability)) return null
    Object.defineProperty(result, id, { value: probability, enumerable: true, configurable: true, writable: true })
  }
  return result
}

function stringRecord(value: unknown): Record<string, string> | null {
  if (!record(value)) return null
  const result: Record<string, string> = Object.create(null)
  for (const [rawKey, text] of Object.entries(value)) {
    const key = normalizedText(rawKey)
    if (!key || Object.hasOwn(result, key) || typeof text !== 'string') return null
    Object.defineProperty(result, key, { value: text, enumerable: true, configurable: true, writable: true })
  }
  return result
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
}

function parseUsage(value: unknown, provider: Provider): boolean {
  if (!record(value)) return false
  const allowed = provider === 'typesafe'
    ? hasExactKeys(value, ['input_tokens', 'output_tokens'])
    : hasExactKeys(value, ['input_tokens', 'output_tokens'], ['cost'])
  const inputTokens = value.input_tokens
  const outputTokens = value.output_tokens
  return allowed && typeof inputTokens === 'number' && Number.isInteger(inputTokens) && inputTokens >= 0 &&
    typeof outputTokens === 'number' && Number.isInteger(outputTokens) && outputTokens >= 0 &&
    (value.cost === undefined || (typeof value.cost === 'number' && Number.isFinite(value.cost) && value.cost >= 0))
}

function parseEnvelope(value: unknown, provider: Provider): { model: string; answers: Record<string, unknown> } | null {
  if (!record(value)) return null
  const allowed = provider === 'typesafe'
    ? hasExactKeys(value, ['model', 'answers', 'usage'])
    : hasExactKeys(value, ['model', 'answers', 'usage'], ['id', 'provider'])
  if (!allowed || !validModel(value.model) || !record(value.answers) || !parseUsage(value.usage, provider)) return null
  if (provider === 'openrouter' &&
    ((value.id !== undefined && typeof value.id !== 'string') ||
      (value.provider !== undefined && typeof value.provider !== 'string'))) return null
  return { model: value.model, answers: value.answers }
}

function isDistribution(probabilities: Record<string, number>): boolean {
  const values = Object.values(probabilities)
  if (values.length === 0) return false
  const total = values.reduce((sum, probability) => sum + probability, 0)
  return Math.abs(total - 1) <= DISTRIBUTION_TOLERANCE
}

function sameKeys(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  const leftKeys = Object.keys(left)
  const rightKeys = Object.keys(right)
  return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.hasOwn(right, key))
}

function parsedAnswer(value: unknown, provider: Provider, question: JudgmentQuestion): ParsedAnswer {
  if (!record(value) || typeof value.type !== 'string') return { unavailable: 'answer-shape' }
  if (value.type !== question.type) return { unavailable: 'answer-type' }
  if (question.type === 'choice') {
    if (!hasExactKeys(value, ['type', 'choice'], ['probabilities', 'confidence']) ||
      (provider === 'typesafe' && !hasExactKeys(value, ['type', 'choice', 'probabilities', 'confidence']))) {
      return { unavailable: 'answer-shape' }
    }
    if (value.probabilities === undefined) return { unavailable: 'missing-probabilities' }
    if (value.confidence === undefined) return { unavailable: 'missing-confidence' }
    const choice = normalizedText(value.choice)
    const probabilities = numberRecord(value.probabilities)
    const confidence = value.confidence
    if (!choice || !probabilities || !numberInProbabilityRange(confidence) ||
      !Object.values(probabilities).every(numberInProbabilityRange)) return { unavailable: 'answer-shape' }
    if (!sameKeys(probabilities, question.criteria)) return { unavailable: 'probability-keys' }
    if (!Object.hasOwn(question.criteria, choice)) return { unavailable: 'choice-invalid' }
    if (!isDistribution(probabilities)) return { unavailable: 'probability-distribution' }
    const selected = probabilities[choice]
    if (!Object.values(probabilities).every((probability) => selected >= probability)) return { unavailable: 'choice-not-max' }
    return { answer: { type: 'choice', choice, probabilities, confidence } }
  }
  if (question.type === 'score') {
    if (!hasExactKeys(value, ['type', 'score'], ['legend', 'probabilities', 'confidence']) ||
      (provider === 'typesafe' && !hasExactKeys(value, ['type', 'score', 'legend', 'probabilities', 'confidence']))) {
      return { unavailable: 'answer-shape' }
    }
    if (value.probabilities === undefined) return { unavailable: 'missing-probabilities' }
    if (value.confidence === undefined) return { unavailable: 'missing-confidence' }
    const expectedLegend: Record<string, string> = Object.create(null)
    question.criteria.forEach((description, index) => {
      Object.defineProperty(expectedLegend, String(index), { value: description, enumerable: true, configurable: true, writable: true })
    })
    const probabilities = numberRecord(value.probabilities)
    const confidence = value.confidence
    const score = value.score
    if (!probabilities || !numberInProbabilityRange(confidence) || typeof score !== 'number' ||
      !Number.isFinite(score) || !Object.values(probabilities).every(numberInProbabilityRange)) {
      return { unavailable: 'answer-shape' }
    }
    if (value.legend === undefined && provider === 'typesafe') return { unavailable: 'answer-shape' }
    let legend = stringRecord(value.legend)
    if (legend === null && provider === 'openrouter' && value.legend === undefined) legend = expectedLegend
    if (!legend || !sameKeys(legend, expectedLegend) ||
      Object.entries(expectedLegend).some(([key, description]) => legend?.[key] !== description)) {
      return { unavailable: 'score-legend' }
    }
    if (!sameKeys(probabilities, expectedLegend)) return { unavailable: 'probability-keys' }
    if (!isDistribution(probabilities)) return { unavailable: 'probability-distribution' }
    if (score < 0 || score > question.criteria.length - 1) return { unavailable: 'score-range' }
    const weightedScore = Object.entries(probabilities).reduce((sum, [level, probability]) => sum + Number(level) * probability, 0)
    if (Math.abs(score - weightedScore) > DISTRIBUTION_TOLERANCE) return { unavailable: 'score-weight-mismatch' }
    return { answer: { type: 'score', score, legend, probabilities, confidence } }
  }
  if (!hasExactKeys(value, ['type', 'noul']) || !numberInProbabilityRange(value.noul)) return { unavailable: 'answer-shape' }
  return { answer: { type: 'noul', noul: value.noul } }
}

function malformedResponse(reason: ResponseProblem): ShadowJudgment {
  return { status: 'failed', reason: 'malformed-response', detail: reason }
}

function normalizeProviderResponse(text: string, provider: Provider, questions: JudgmentQuestionRequest[]): ShadowJudgment {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return malformedResponse('invalid-json') }
  const envelope = parseEnvelope(raw, provider)
  if (!envelope) return malformedResponse('invalid-envelope')
  const questionsById = questionMap(questions)
  for (const id of Object.keys(envelope.answers)) {
    if (!Object.hasOwn(questionsById, id)) return malformedResponse('unexpected-answer')
  }
  const answers: Record<string, JudgmentAnswer> = Object.create(null)
  const unavailable: Record<string, JudgmentUnavailableReason> = Object.create(null)
  for (const id of Object.keys(questionsById)) {
    if (!Object.hasOwn(envelope.answers, id)) {
      Object.defineProperty(unavailable, id, { value: 'missing-answer', enumerable: true, configurable: true, writable: true })
      continue
    }
    const parsed = parsedAnswer(envelope.answers[id], provider, questionsById[id]!)
    if ('answer' in parsed) Object.defineProperty(answers, id, { value: parsed.answer, enumerable: true, configurable: true, writable: true })
    else Object.defineProperty(unavailable, id, { value: parsed.unavailable, enumerable: true, configurable: true, writable: true })
  }
  const result: JudgmentResponse = {
    model: envelope.model,
    answers,
    ...(Object.keys(unavailable).length === 0 ? {} : { unavailable })
  }
  return { status: 'observed', provider, result }
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>()
  setTimeout(resolve, ms)
  return promise
}

/** The provider is a shadow observation; questions are supplied only by the owning kind. */
export async function shadowJudgment(options: {
  dataDir: string
  state: unknown
  questions?: () => Promise<unknown> | unknown
  fetch?: Fetch
  sleep?: (ms: number) => Promise<void>
}): Promise<ShadowJudgment> {
  const configured = privateConfig(options.dataDir)
  if (configured.kind === 'disabled') return { status: 'disabled' }
  if (configured.kind !== 'enabled') return { status: 'failed', reason: 'configuration-unavailable' }

  let stateJson: string
  try { stateJson = serializeState(options.state) } catch (error) {
    return {
      status: 'failed', provider: configured.config.provider,
      reason: error instanceof JudgmentSizeError && error.limit === 'state' ? 'state-too-large' : 'state-invalid'
    }
  }
  if (!options.questions) return { status: 'skipped' }
  let questions: JudgmentQuestionRequest[] | null
  try { questions = normalizeJudgmentQuestions(await options.questions()) } catch {
    return { status: 'failed', provider: configured.config.provider, reason: 'questions-unavailable' }
  }
  if (questions === null) return { status: 'failed', provider: configured.config.provider, reason: 'questions-invalid' }
  if (questions.length === 0) return { status: 'skipped' }

  let body: string
  try { body = serializeRequestBody(configured.config.provider, stateJson, questions) } catch {
    return { status: 'failed', provider: configured.config.provider, reason: 'request-too-large' }
  }
  const endpoint = transport(configured.config.provider).endpoint
  const fetcher = options.fetch ?? fetch
  const delay = options.sleep ?? sleep
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), JUDGMENT_ATTEMPT_TIMEOUT_MS)
    let response: Response
    try {
      response = await fetcher(endpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${configured.config.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: controller.signal
      })
    } catch {
      clearTimeout(deadline)
      return {
        status: 'failed', provider: configured.config.provider,
        reason: controller.signal.aborted ? 'timeout' : 'request-failed'
      }
    }
    if (response.status === 429 || response.status === 529) {
      await cancelResponse(response)
      clearTimeout(deadline)
      if (attempt === MAX_ATTEMPTS - 1) {
        return { status: 'failed', provider: configured.config.provider, reason: 'http-error', statusCode: response.status }
      }
      try {
        await delay(RETRY_BASE_DELAY_MS * 2 ** attempt)
      } catch {
        return { status: 'failed', provider: configured.config.provider, reason: 'request-failed' }
      }
      continue
    }
    if (!response.ok) {
      await cancelResponse(response)
      clearTimeout(deadline)
      return { status: 'failed', provider: configured.config.provider, reason: 'http-error', statusCode: response.status }
    }
    try {
      const bounded = await readBoundedResponse(response)
      clearTimeout(deadline)
      if (bounded.kind === 'too-large') {
        return { status: 'failed', provider: configured.config.provider, reason: 'response-too-large' }
      }
      if (bounded.kind === 'malformed') return malformedResponse('invalid-utf8')
      const parsed = normalizeProviderResponse(bounded.text, configured.config.provider, questions)
      if (parsed.status !== 'observed') return parsed
      return { ...parsed, result: redactResult(parsed.result, configured.config.apiKey) as JudgmentResponse }
    } catch {
      clearTimeout(deadline)
      return {
        status: 'failed', provider: configured.config.provider,
        reason: controller.signal.aborted ? 'timeout' : 'request-failed'
      }
    }
  }
  return { status: 'failed', provider: configured.config.provider, reason: 'request-failed' }
}
