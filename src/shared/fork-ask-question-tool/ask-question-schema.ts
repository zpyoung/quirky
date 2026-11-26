import type { AskAnswers, AskStatus } from './ask-answer-envelope'
import {
  checkOptional,
  isBoolean,
  isPlainObject,
  isString,
  validateDateOrConfirmQuestion,
  validateId,
  validateNumberQuestion,
  validateOptionsQuestion,
  validateQuestionText,
  validateTextQuestion
} from './ask-question-field-validation'

export type AskPreviewFormat = 'markdown' | 'html'
export type AskPreview = { format: AskPreviewFormat; content: string }
export type AskOption = { value: string; label: string; description?: string; preview?: AskPreview }

export type AskQuestionCommon = {
  id: string
  question: string
  header?: string
  required?: boolean
}

export type AskSelectQuestion = AskQuestionCommon & {
  type: 'select'
  options: AskOption[]
  default?: string
}
export type AskMultiselectQuestion = AskQuestionCommon & {
  type: 'multiselect'
  options: AskOption[]
  default?: string[]
}
export type AskTextQuestion = AskQuestionCommon & {
  type: 'text'
  multiline?: boolean
  pattern?: string
  format?: 'email' | 'url'
  default?: string
}
export type AskNumberQuestion = AskQuestionCommon & {
  type: 'number'
  integer?: boolean
  min?: number
  max?: number
  default?: number
}
/** `default`, when present, is an ISO 8601 calendar date (`YYYY-MM-DD`). */
export type AskDateQuestion = AskQuestionCommon & { type: 'date'; default?: string }
export type AskConfirmQuestion = AskQuestionCommon & { type: 'confirm'; default?: boolean }

export type AskQuestion =
  | AskSelectQuestion
  | AskMultiselectQuestion
  | AskTextQuestion
  | AskNumberQuestion
  | AskDateQuestion
  | AskConfirmQuestion

/** Flat question set for one `quirky ask` invocation; no conditional branching (logic.md § Question schema). */
export type AskSpec = { questions: AskQuestion[] }

export type AskValidationError = { path: string; message: string }
export type AskSpecValidationResult =
  | { ok: true; spec: AskSpec }
  | { ok: false; errors: AskValidationError[] }

/**
 * Per-question normalized drafts, persisted in `partial_json` and carried by
 * `ask.updatePartial` (tech.md § Data models). Never raw widget state.
 */
export type AskPartialQuestionDraft = {
  selected?: string[]
  other?: string
  draft?: string
  confirm?: boolean
  note?: string
}
export type AskPartial = Record<string, AskPartialQuestionDraft>

/** The terminal envelope body embedded in a registry event's `result` (tech.md § Data models). */
export type AskRegistryResult = { answers: AskAnswers; skipped: string[]; summary: string }

/** One row of registry state pushed to clients via `ask.snapshot` / `ask.subscribe` / IPC. */
export type AskRegistryEvent = {
  seq: number
  epoch: string
  askId: string
  paneKey: string | null
  status: AskStatus
  spec?: AskSpec
  partial?: AskPartial
  result?: AskRegistryResult
  worktreeId?: string | null
}

/** `ask.subscribe`'s frame union; `type` is the discriminator (tech.md § Data models). */
export type AskStreamFrame =
  | { type: 'snapshot'; event: AskRegistryEvent }
  | { type: 'watermark'; seq: number; epoch: string }
  | { type: 'event'; event: AskRegistryEvent }
  | { type: 'end'; reason: 'epoch_changed' | 'closed' }

/** Default `ask.wait` chunk size (tech.md § C5: `quirky ask` register → wait loop). */
export const ASK_DEFAULT_CHUNK_MS = 100_000

// New ask-only constant: mirrors resolveOrchestrationAskClientTimeoutMs's chunk+grace shape
// without reusing orchestration-ask-timeout.ts's constants (tech.md C5, DO-NOT-CHANGE #3).
export const ASK_CHUNK_CLIENT_GRACE_MS = 5_000

/** Largest `--chunk-ms` whose client timeout (chunk plus grace) still fits a 32-bit timer. */
export const ASK_MAX_CHUNK_MS = 2 ** 31 - 1 - ASK_CHUNK_CLIENT_GRACE_MS

/** Client-side RPC timeout for one `ask.wait` chunk: the chunk budget plus network/keepalive grace. */
export function resolveAskWaitClientTimeoutMs(chunkMs: number | undefined): number {
  return (chunkMs === undefined ? ASK_DEFAULT_CHUNK_MS : chunkMs) + ASK_CHUNK_CLIENT_GRACE_MS
}

export const MAX_ASK_QUESTIONS = 10
const QUESTION_TYPES = new Set(['select', 'multiselect', 'text', 'number', 'date', 'confirm'])

/**
 * Validates arbitrary parsed JSON against the ask spec contract (tech.md § C1). Pure, no I/O,
 * and never throws — every rejection reason surfaces as a field-path error instead. The
 * returned `spec` is only meaningful when `ok` is true; per-question validators below build it
 * unconditionally and let this top-level check decide whether it is ever surfaced.
 */
export function validateAskSpec(input: unknown): AskSpecValidationResult {
  if (!isPlainObject(input)) {
    return { ok: false, errors: [{ path: '', message: 'ask spec must be an object' }] }
  }
  const questionsRaw = input.questions
  if (!Array.isArray(questionsRaw)) {
    return { ok: false, errors: [{ path: 'questions', message: 'questions must be an array' }] }
  }

  const errors: AskValidationError[] = []
  if (questionsRaw.length === 0) {
    errors.push({ path: 'questions', message: 'at least one question is required' })
  }
  if (questionsRaw.length > MAX_ASK_QUESTIONS) {
    errors.push({ path: 'questions', message: `at most ${MAX_ASK_QUESTIONS} questions allowed` })
  }

  const seenIds = new Set<string>()
  const questions = questionsRaw.map((raw, index) =>
    validateQuestion(raw, `questions[${index}]`, errors, seenIds)
  )
  return errors.length > 0
    ? { ok: false, errors }
    : { ok: true, spec: { questions: questions as AskQuestion[] } }
}

function validateQuestion(
  raw: unknown,
  path: string,
  errors: AskValidationError[],
  seenIds: Set<string>
): AskQuestion | Record<string, never> {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'question must be an object' })
    return {}
  }
  if ('masked' in raw || 'sensitive' in raw) {
    errors.push({
      path,
      message: 'masked/sensitive input is not permitted; collect credentials out of band'
    })
  }

  const common: AskQuestionCommon = {
    id: validateId(raw.id, path, errors, seenIds),
    question: validateQuestionText(raw.question, path, errors),
    header: checkOptional(
      raw.header,
      isString,
      `${path}.header`,
      'header must be a string',
      errors
    ),
    required: checkOptional(
      raw.required,
      isBoolean,
      `${path}.required`,
      'required must be a boolean',
      errors
    )
  }

  const type = raw.type
  if (typeof type !== 'string' || !QUESTION_TYPES.has(type)) {
    errors.push({
      path: `${path}.type`,
      message: 'type must be one of select | multiselect | text | number | date | confirm'
    })
    return {}
  }
  switch (type) {
    case 'select':
    case 'multiselect':
      return validateOptionsQuestion(raw, path, type, common, errors)
    case 'text':
      return validateTextQuestion(raw, path, common, errors)
    case 'number':
      return validateNumberQuestion(raw, path, common, errors)
    default:
      return validateDateOrConfirmQuestion(type as 'date' | 'confirm', raw, path, common, errors)
  }
}
