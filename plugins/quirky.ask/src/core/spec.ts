import type { AskOption, AskPreview, AskQuestion, AskSpec } from '@quirky/protocol'
import { FORMAT_PATTERNS, isPlainObject, isValidIsoDate } from './values'

export const MAX_ASK_QUESTIONS = 10
export const MAX_ASK_OPTIONS = 12
const MAX_PATTERN_LENGTH = 200
const MAX_PATTERN_TEST_LENGTH = 200
const MAX_PATTERN_QUANTIFIERS = 10
const QUESTION_TYPES = new Set(['select', 'multiselect', 'text', 'number', 'date', 'confirm'])

export type AskValidationError = { path: string; message: string }
export type AskSpecValidationResult =
  | { ok: true; spec: AskSpec }
  | { ok: false; errors: AskValidationError[] }

export type ValidateAskSpecOptions = {
  /** False for specs a plugin registers: its ids, question text and option values may name credentials. */
  checkCredentialText: boolean
}

type Common = { id: string; question: string; header?: string; required?: boolean }
type Select = Extract<AskQuestion, { type: 'select' }>
type Multiselect = Extract<AskQuestion, { type: 'multiselect' }>
type Text = Extract<AskQuestion, { type: 'text' }>
type NumberQuestion = Extract<AskQuestion, { type: 'number' }>
type DateQuestion = Extract<AskQuestion, { type: 'date' }>
type Confirm = Extract<AskQuestion, { type: 'confirm' }>

type Context = {
  errors: AskValidationError[]
  seenIds: Set<string>
  checkCredentialText: boolean
}

const CREDENTIAL_TRIGGER =
  '(pass(word|phrase)?|secret\\s?key|secret|token|api\\s?key|credential|private\\s?key)'
const CREDENTIAL_PATTERN = new RegExp(`\\b${CREDENTIAL_TRIGGER}\\b`, 'i')
const CREDENTIAL_SUBSTRING_PATTERN = new RegExp(CREDENTIAL_TRIGGER, 'i')

// a capital run against a lowercase run (`DBpassword`) has no marker for where the trailing word
// starts, so both splits are returned and the caller checks either
function normalizeCredentialCandidates(value: string): string[] {
  const withoutSeparators = value.replace(/[_-]+/g, ' ')
  const finishSplit = (candidate: string): string =>
    candidate
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/([A-Za-z])(\d)/g, '$1 $2')
      .replace(/(\d)([A-Za-z])/g, '$1 $2')
  return [
    finishSplit(withoutSeparators.replace(/([A-Z]+)(?=[A-Z][a-z])/g, '$1 ')),
    finishSplit(withoutSeparators.replace(/([A-Z]+)([a-z])/g, '$1 $2'))
  ]
}

function mentionsCredential(value: string): boolean {
  return normalizeCredentialCandidates(value).some((normalized) => {
    if (CREDENTIAL_PATTERN.test(normalized)) return true
    // an unbroken capital run (MYSECRET) has no internal boundary for \b, so match it as a substring
    return normalized
      .split(' ')
      .some((word) => /^[A-Z0-9]+$/.test(word) && CREDENTIAL_SUBSTRING_PATTERN.test(word))
  })
}

function isQuantifierChar(char: string | undefined): boolean {
  return char === '+' || char === '*' || char === '{' || char === '?'
}

// a trailing `?` repeats its subject at most once, so it can't compound an inner quantifier
// into exponential backtracking; only `+`, `*` and `{` do
function isCompoundingQuantifierChar(char: string | undefined): boolean {
  return char === '+' || char === '*' || char === '{'
}

function splitTopLevelAlternatives(body: string): string[] {
  const alternatives: string[] = []
  let depth = 0
  let inClass = false
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const char = body[i]
    if (char === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
    } else if (char === '|' && depth === 0) {
      alternatives.push(body.slice(start, i))
      start = i + 1
    }
  }
  alternatives.push(body.slice(start))
  return alternatives
}

function hasIdenticalAlternationBranch(body: string): boolean {
  const seen = new Set<string>()
  for (const alternative of splitTopLevelAlternatives(body)) {
    if (seen.has(alternative)) return true
    seen.add(alternative)
  }
  return false
}

/**
 * Rejects the regex shapes most likely to backtrack catastrophically, since a synchronous regex
 * can't be interrupted once matching starts: a quantified group whose body has a quantifier
 * (`(a+)+`), a quantified group with literally identical alternation branches (`(a|a)+`), and,
 * as a blunt fallback, more than `MAX_PATTERN_QUANTIFIERS` quantifiers. Overlapping alternation
 * in general (`(a|ab)+`) still passes.
 */
function hasNestedQuantifier(pattern: string): boolean {
  const groupStarts: number[] = []
  const groupHasQuantifier: boolean[] = []
  let inClass = false
  let quantifierCount = 0
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === '\\') {
      i++
      continue
    }
    if (inClass) {
      if (char === ']') inClass = false
      continue
    }
    if (char === '[') {
      inClass = true
    } else if (char === '(') {
      groupStarts.push(i)
      groupHasQuantifier.push(false)
    } else if (char === ')') {
      const start = groupStarts.pop()
      const bodyHadQuantifier = groupHasQuantifier.pop() ?? false
      const compounds = isCompoundingQuantifierChar(pattern[i + 1])
      if (compounds && bodyHadQuantifier) return true
      if (
        compounds &&
        start !== undefined &&
        hasIdenticalAlternationBranch(pattern.slice(start + 1, i))
      ) {
        return true
      }
      if (groupHasQuantifier.length > 0 && (bodyHadQuantifier || compounds)) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
    } else if (isQuantifierChar(char)) {
      quantifierCount++
      if (groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true
      }
    }
  }
  return quantifierCount > MAX_PATTERN_QUANTIFIERS
}

const isString = (value: unknown): value is string => typeof value === 'string'
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

function checkOptional<T>(
  raw: unknown,
  isValid: (value: unknown) => value is T,
  path: string,
  message: string,
  errors: AskValidationError[]
): T | undefined {
  if (raw === undefined) return undefined
  if (!isValid(raw)) {
    errors.push({ path, message })
    return undefined
  }
  return raw
}

/** Drops undefined entries so the canonical spec carries only fields the caller gave. */
function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function validateId(raw: unknown, path: string, context: Context): string {
  const { errors, seenIds } = context
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push({ path: `${path}.id`, message: 'id is required and must be a non-empty string' })
    return ''
  }
  if (seenIds.has(raw)) {
    errors.push({ path: `${path}.id`, message: `duplicate question id '${raw}'` })
  }
  seenIds.add(raw)
  if (context.checkCredentialText && mentionsCredential(raw)) {
    errors.push({ path: `${path}.id`, message: 'credential-shaped id is not permitted' })
  }
  return raw
}

function validateQuestionText(raw: unknown, path: string, context: Context): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    context.errors.push({ path: `${path}.question`, message: 'question text is required' })
    return ''
  }
  if (context.checkCredentialText && mentionsCredential(raw)) {
    context.errors.push({
      path: `${path}.question`,
      message: 'credential-shaped question text is not permitted'
    })
  }
  return raw
}

function validatePreview(raw: unknown, path: string, errors: AskValidationError[]): void {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'preview must be an object' })
    return
  }
  if (raw.format !== 'markdown' && raw.format !== 'html') {
    errors.push({ path: `${path}.format`, message: "preview format must be 'markdown' or 'html'" })
  }
  if (typeof raw.content !== 'string') {
    errors.push({ path: `${path}.content`, message: 'preview content must be a string' })
  }
}

function readPreview(raw: unknown): AskPreview | undefined {
  return isPlainObject(raw) &&
    (raw.format === 'markdown' || raw.format === 'html') &&
    isString(raw.content)
    ? { format: raw.format, content: raw.content }
    : undefined
}

function validateOption(raw: unknown, path: string, context: Context): AskOption {
  const { errors } = context
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'option must be an object' })
    return { value: '', label: '' }
  }
  const value = raw.value
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({ path: `${path}.value`, message: 'option value is required' })
  } else if (context.checkCredentialText && mentionsCredential(value)) {
    errors.push({
      path: `${path}.value`,
      message: 'credential-shaped option value is not permitted'
    })
  }
  const label = raw.label
  if (typeof label !== 'string' || label.length === 0) {
    errors.push({ path: `${path}.label`, message: 'option label is required' })
  }
  checkOptional(
    raw.description,
    isString,
    `${path}.description`,
    'description must be a string',
    errors
  )
  if (raw.preview !== undefined) validatePreview(raw.preview, `${path}.preview`, errors)
  return compact({
    value: typeof value === 'string' ? value : '',
    label: typeof label === 'string' ? label : '',
    description: isString(raw.description) ? raw.description : undefined,
    preview: readPreview(raw.preview)
  })
}

function validateOptionsQuestion(
  raw: Record<string, unknown>,
  path: string,
  type: 'select' | 'multiselect',
  common: Common,
  context: Context
): Select | Multiselect {
  const { errors } = context
  const optionsRaw = Array.isArray(raw.options) ? raw.options : []
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    errors.push({ path: `${path}.options`, message: 'options must be a non-empty array' })
  } else if (raw.options.length > MAX_ASK_OPTIONS) {
    errors.push({ path: `${path}.options`, message: `at most ${MAX_ASK_OPTIONS} options allowed` })
  }

  const values = new Set<string>()
  const options = optionsRaw.map((rawOption, index) => {
    const option = validateOption(rawOption, `${path}.options[${index}]`, context)
    values.add(option.value)
    return option
  })

  const defaultValue = raw.default
  const validDefault =
    type === 'select'
      ? typeof defaultValue === 'string' && values.has(defaultValue)
      : Array.isArray(defaultValue) &&
        defaultValue.every((value) => typeof value === 'string' && values.has(value))
  if (defaultValue !== undefined && !validDefault) {
    errors.push({
      path: `${path}.default`,
      message:
        type === 'select'
          ? 'default must match one option value'
          : 'default must be an array of option values'
    })
  }
  return type === 'select'
    ? compact({
        ...common,
        type,
        options,
        default: isString(defaultValue) ? defaultValue : undefined
      })
    : compact({
        ...common,
        type,
        options,
        default: Array.isArray(defaultValue) ? defaultValue.filter(isString) : undefined
      })
}

function validateTextQuestion(
  raw: Record<string, unknown>,
  path: string,
  common: Common,
  errors: AskValidationError[]
): Text {
  checkOptional(
    raw.multiline,
    isBoolean,
    `${path}.multiline`,
    'multiline must be a boolean',
    errors
  )
  let patternRegex: RegExp | undefined
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== 'string') {
      errors.push({ path: `${path}.pattern`, message: 'pattern must be a string' })
    } else if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      errors.push({
        path: `${path}.pattern`,
        message: `pattern must be at most ${MAX_PATTERN_LENGTH} characters`
      })
    } else if (hasNestedQuantifier(raw.pattern)) {
      errors.push({
        path: `${path}.pattern`,
        message: 'pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine'
      })
    } else {
      try {
        patternRegex = new RegExp(raw.pattern)
      } catch {
        errors.push({
          path: `${path}.pattern`,
          message: 'pattern must be a valid regular expression'
        })
      }
    }
  }
  const format = raw.format
  if (format !== undefined && format !== 'email' && format !== 'url') {
    errors.push({ path: `${path}.format`, message: "format must be 'email' or 'url'" })
  }

  const defaultValue = raw.default
  if (defaultValue !== undefined) {
    if (typeof defaultValue !== 'string') {
      errors.push({ path: `${path}.default`, message: 'default must be a string' })
    } else {
      if (patternRegex) {
        if (defaultValue.length > MAX_PATTERN_TEST_LENGTH) {
          errors.push({
            path: `${path}.default`,
            message: `default must be at most ${MAX_PATTERN_TEST_LENGTH} characters when pattern is set`
          })
        } else if (!patternRegex.test(defaultValue)) {
          errors.push({ path: `${path}.default`, message: 'default does not match pattern' })
        }
      }
      if ((format === 'email' || format === 'url') && !FORMAT_PATTERNS[format].test(defaultValue)) {
        errors.push({ path: `${path}.default`, message: `default is not a valid ${format}` })
      }
    }
  }
  return compact({
    ...common,
    type: 'text' as const,
    multiline: isBoolean(raw.multiline) ? raw.multiline : undefined,
    pattern: isString(raw.pattern) ? raw.pattern : undefined,
    format: format === 'email' || format === 'url' ? format : undefined,
    default: isString(defaultValue) ? defaultValue : undefined
  })
}

function validateNumberQuestion(
  raw: Record<string, unknown>,
  path: string,
  common: Common,
  errors: AskValidationError[]
): NumberQuestion {
  checkOptional(raw.integer, isBoolean, `${path}.integer`, 'integer must be a boolean', errors)
  const min = checkOptional(raw.min, isFiniteNumber, `${path}.min`, 'min must be a number', errors)
  const max = checkOptional(raw.max, isFiniteNumber, `${path}.max`, 'max must be a number', errors)
  if (min !== undefined && max !== undefined && min > max) {
    errors.push({ path: `${path}.min`, message: 'min must not exceed max' })
  }

  const defaultValue = raw.default
  if (defaultValue !== undefined && !isFiniteNumber(defaultValue)) {
    errors.push({ path: `${path}.default`, message: 'default must be a number' })
  } else if (isFiniteNumber(defaultValue)) {
    const message =
      (raw.integer === true && !Number.isInteger(defaultValue) && 'default must be an integer') ||
      (min !== undefined && defaultValue < min && 'default is below min') ||
      (max !== undefined && defaultValue > max && 'default is above max')
    if (message) errors.push({ path: `${path}.default`, message })
  }
  return compact({
    ...common,
    type: 'number' as const,
    integer: isBoolean(raw.integer) ? raw.integer : undefined,
    min,
    max,
    default: isFiniteNumber(defaultValue) ? defaultValue : undefined
  })
}

function validateDateOrConfirmQuestion(
  type: 'date' | 'confirm',
  raw: Record<string, unknown>,
  path: string,
  common: Common,
  errors: AskValidationError[]
): DateQuestion | Confirm {
  const defaultValue = raw.default
  const isValidDefault =
    type === 'date'
      ? typeof defaultValue === 'string' && isValidIsoDate(defaultValue)
      : isBoolean(defaultValue)
  if (defaultValue !== undefined && !isValidDefault) {
    errors.push({
      path: `${path}.default`,
      message:
        type === 'date'
          ? 'default must be an ISO 8601 date (YYYY-MM-DD)'
          : 'default must be a boolean'
    })
  }
  return compact({
    ...common,
    type,
    default: isValidDefault ? defaultValue : undefined
  }) as DateQuestion | Confirm
}

function validateQuestion(
  raw: unknown,
  path: string,
  context: Context
): AskQuestion | Record<string, never> {
  const { errors } = context
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

  const common: Common = compact({
    id: validateId(raw.id, path, context),
    question: validateQuestionText(raw.question, path, context),
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
  })

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
      return validateOptionsQuestion(raw, path, type, common, context)
    case 'text':
      return validateTextQuestion(raw, path, common, errors)
    case 'number':
      return validateNumberQuestion(raw, path, common, errors)
    default:
      return validateDateOrConfirmQuestion(type as 'date' | 'confirm', raw, path, common, errors)
  }
}

/**
 * Validates untrusted JSON against the ask spec contract. Pure and never throws: every rejection
 * surfaces as a field-path error, and all errors are collected in spec order. On success `spec`
 * is canonical: known fields only, plus `title` when given.
 */
export function validateAskSpec(
  raw: unknown,
  options: ValidateAskSpecOptions
): AskSpecValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, errors: [{ path: '', message: 'ask spec must be an object' }] }
  }
  const errors: AskValidationError[] = []
  const title = checkOptional(raw.title, isString, 'title', 'title must be a string', errors)

  const questionsRaw = raw.questions
  if (!Array.isArray(questionsRaw)) {
    errors.push({ path: 'questions', message: 'questions must be an array' })
    return { ok: false, errors }
  }
  if (questionsRaw.length === 0) {
    errors.push({ path: 'questions', message: 'at least one question is required' })
  }
  if (questionsRaw.length > MAX_ASK_QUESTIONS) {
    errors.push({ path: 'questions', message: `at most ${MAX_ASK_QUESTIONS} questions allowed` })
  }

  const context: Context = {
    errors,
    seenIds: new Set<string>(),
    checkCredentialText: options.checkCredentialText
  }
  const questions = questionsRaw.map((question, index) =>
    validateQuestion(question, `questions[${index}]`, context)
  )
  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    spec: title === undefined ? { questions: questions as AskQuestion[] } : { title, questions: questions as AskQuestion[] }
  }
}

/** One line for a refusal: `<path>: <message>` per error, joined with `; `. */
export function formatSpecErrors(errors: readonly AskValidationError[]): string {
  return errors.map((error) => (error.path ? `${error.path}: ${error.message}` : error.message)).join('; ')
}
