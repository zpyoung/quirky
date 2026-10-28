import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { JudgmentQuestionRequest } from '../src/contracts'
import {
  JUDGMENT_ATTEMPT_TIMEOUT_MS,
  MAX_JUDGMENT_REQUEST_BYTES,
  MAX_JUDGMENT_RESPONSE_BYTES,
  MAX_JUDGMENT_STATE_BYTES,
  normalizeJudgmentQuestions,
  serializeJudgmentRequest,
  shadowJudgment
} from '../src/judgment'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function configDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'heimdall-judgment-'))
  roots.push(root)
  const dir = join(root, 'data')
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

function enable(dir: string, apiKey = 'test-secret'): void {
  const path = join(dir, 'judgment-access.json')
  writeFileSync(path, JSON.stringify({ enabled: true, provider: 'typesafe', apiKey }), { mode: 0o600 })
  chmodSync(path, 0o600)
}

const question: JudgmentQuestionRequest = {
  id: 'stall-cause',
  questionId: 'heimdall.stall-cause',
  subjectId: 'dispatch-1',
  question: {
    type: 'choice',
    instructions: 'Classify why the worker stopped.',
    criteria: { 'asked-question-in-prose': 'Waits for an answer.', 'idle-no-reason': 'No reason is evident.' }
  }
}
const state = { worker: { phase: 'waiting', lastMessage: 'Can you review this?' } }
function typeSafeResponse(model = 'jev-1.13'): string {
  return JSON.stringify({
    model,
    answers: {
      'stall-cause': {
        type: 'choice',
        choice: 'asked-question-in-prose',
        probabilities: { 'asked-question-in-prose': 0.97, 'idle-no-reason': 0.03 },
        confidence: 0.97
      }
    },
    usage: { input_tokens: 12, output_tokens: 4 }
  })
}

test('absent and disabled configuration make zero provider and question-provider calls', async () => {
  const dir = configDir()
  let calls = 0
  let questionCalls = 0
  const fetcher = async () => { calls++; return new Response('{}') }
  const questions = async () => { questionCalls++; return [question] }
  await expect(shadowJudgment({ dataDir: dir, state, questions, fetch: fetcher })).resolves.toMatchObject({ status: 'disabled' })
  writeFileSync(join(dir, 'judgment-access.json'), JSON.stringify({ enabled: false }), { mode: 0o600 })
  chmodSync(join(dir, 'judgment-access.json'), 0o600)
  await expect(shadowJudgment({ dataDir: dir, state, questions, fetch: fetcher })).resolves.toMatchObject({ status: 'disabled' })
  expect(calls).toBe(0)
  expect(questionCalls).toBe(0)
})

test('configuration must be a private regular file without symlink indirection', async () => {
  const dir = configDir()
  const path = join(dir, 'judgment-access.json')
  writeFileSync(path, JSON.stringify({ enabled: true, provider: 'typesafe', apiKey: 'test-secret' }), { mode: 0o644 })
  chmodSync(path, 0o644)
  let calls = 0
  const fetcher = async () => { calls++; return new Response('{}') }
  await expect(shadowJudgment({ dataDir: dir, state, questions: async () => [question], fetch: fetcher })).resolves.toMatchObject({ status: 'failed', reason: 'configuration-unavailable' })
  rmSync(path)
  const target = join(dir, 'target.json')
  writeFileSync(target, JSON.stringify({ enabled: true, provider: 'typesafe', apiKey: 'test-secret' }), { mode: 0o600 })
  symlinkSync(target, path)
  await expect(shadowJudgment({ dataDir: dir, state, questions: async () => [question], fetch: fetcher })).resolves.toMatchObject({ status: 'failed', reason: 'configuration-unavailable' })
  expect(calls).toBe(0)
})

test('state and complete wire requests are rejected before network I/O when oversized', async () => {
  const dir = configDir()
  enable(dir)
  let calls = 0
  const fetcher = async () => { calls++; return new Response(typeSafeResponse()) }
  const largeState = 'x'.repeat(MAX_JUDGMENT_STATE_BYTES + 1)
  await expect(shadowJudgment({
    dataDir: dir,
    state: largeState,
    questions: async () => [question],
    fetch: fetcher
  })).resolves.toMatchObject({ status: 'failed', reason: 'state-too-large' })
  const oversizedQuestion = {
    ...question,
    question: { ...question.question, instructions: 'x'.repeat(MAX_JUDGMENT_REQUEST_BYTES + 1) }
  }
  expect(() => serializeJudgmentRequest('typesafe', state, [oversizedQuestion])).toThrow(/request/i)
  expect(calls).toBe(0)
})

test('TypeSafe wire shape is exact and successful results redact the access secret', async () => {
  const dir = configDir()
  enable(dir, 'top-secret-token')
  const fetcher = async (url: string | URL | Request, init?: RequestInit) => {
    expect(String(url)).toBe('https://api.typesafe.ai/v1/systemone')
    expect(init?.method).toBe('POST')
    expect(JSON.stringify(init?.headers)).toContain('top-secret-token')
    expect(JSON.parse(String(init?.body))).toEqual({
      model: 'jev-latest',
      state,
      questions: { 'stall-cause': question.question }
    })
    return new Response(typeSafeResponse('top-secret-token'))
  }
  const result = await shadowJudgment({ dataDir: dir, state, questions: async () => [question], fetch: fetcher })
  expect(result).toMatchObject({
    status: 'observed', provider: 'typesafe',
    result: {
      model: '[redacted]',
      answers: {
        'stall-cause': {
          type: 'choice', choice: 'asked-question-in-prose', confidence: 0.97,
          probabilities: { 'asked-question-in-prose': 0.97, 'idle-no-reason': 0.03 }
        }
      }
    }
  })
  expect(JSON.stringify(result)).not.toContain('top-secret-token')
  const httpFailure = await shadowJudgment({
    dataDir: dir, state, questions: async () => [question],
    fetch: async () => new Response('top-secret-token', { status: 500 })
  })
  expect(httpFailure).toEqual({ status: 'failed', provider: 'typesafe', reason: 'http-error', statusCode: 500 })
  expect(JSON.stringify(httpFailure)).not.toContain('top-secret-token')
  expect(JUDGMENT_ATTEMPT_TIMEOUT_MS).toBe(5_000)
})

test('OpenRouter uses its model and answer normalization, and retries 429/529 for three total attempts', async () => {
  const dir = configDir()
  const configPath = join(dir, 'judgment-access.json')
  writeFileSync(configPath, JSON.stringify({ enabled: true, provider: 'openrouter', apiKey: 'test-secret' }), { mode: 0o600 })
  chmodSync(configPath, 0o600)
  const delays: number[] = []
  let calls = 0
  const retrying = await shadowJudgment({
    dataDir: dir,
    state,
    questions: async () => [question],
    fetch: async (url, init) => {
      calls++
      expect(String(url)).toBe('https://openrouter.ai/api/alpha/decisions')
      expect(JSON.parse(String(init?.body))).toMatchObject({ model: '~typesafe/jev-latest' })
      return calls < 3
        ? new Response('', { status: calls === 1 ? 429 : 529 })
        : new Response(JSON.stringify({
            model: '~typesafe/jev-latest',
            id: 'completion-1',
            provider: 'router',
            answers: {
              'stall-cause': {
                type: 'choice', choice: 'asked-question-in-prose',
                probabilities: { 'asked-question-in-prose': 0.97, 'idle-no-reason': 0.03 },
                confidence: 0.97
              }
            },
            usage: { input_tokens: 12, output_tokens: 4, cost: 0.01 }
          }))
    },
    sleep: async (ms) => { delays.push(ms) }
  })
  expect(retrying).toMatchObject({ status: 'observed', provider: 'openrouter', result: { answers: { 'stall-cause': { choice: 'asked-question-in-prose' } } } })
  expect(calls).toBe(3)
  expect(delays).toEqual([100, 200])

  const oversized = await shadowJudgment({
    dataDir: dir,
    state,
    questions: async () => [question],
    fetch: async () => new Response(new Uint8Array(MAX_JUDGMENT_RESPONSE_BYTES + 1))
  })
  expect(oversized).toMatchObject({ status: 'failed', reason: 'response-too-large' })
  const malformed = await shadowJudgment({ dataDir: dir, state, questions: async () => [question], fetch: async () => new Response('not-json') })
  expect(malformed).toMatchObject({ status: 'failed', reason: 'malformed-response', detail: 'invalid-json' })
})

test('an enabled provider with no kind questions makes no network call', async () => {
  const dir = configDir()
  enable(dir)
  let calls = 0
  await expect(shadowJudgment({
    dataDir: dir,
    state,
    questions: async () => [],
    fetch: async () => { calls++; return new Response(typeSafeResponse()) }
  })).resolves.toMatchObject({ status: 'skipped' })
  expect(calls).toBe(0)
})

test('question request normalization matches the original question contract', () => {
  expect(normalizeJudgmentQuestions([question])).toEqual([question])
  expect(normalizeJudgmentQuestions([{ ...question, question: { ...question.question, extra: true } }])).toBeNull()
  expect(normalizeJudgmentQuestions([question, question])).toBeNull()
})
