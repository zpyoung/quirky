import type {
  AskConfirmQuestion,
  AskDateQuestion,
  AskMultiselectQuestion,
  AskNumberQuestion,
  AskOption,
  AskPreview,
  AskQuestionCommon,
  AskSelectQuestion,
  AskTextQuestion,
  AskValidationError
} from './ask-question-schema'

export const MAX_ASK_OPTIONS = 12
const MAX_PATTERN_LENGTH = 200
export const MAX_PATTERN_TEST_LENGTH = 200

// `secret key` joins `api key` and `private key` as a named credential term, not just `secret`
// plus an unrelated word.
const CREDENTIAL_TRIGGER =
  '(password|passphrase|secret\\s?key|secret|token|api\\s?key|credential|private\\s?key)'
const CREDENTIAL_PATTERN = new RegExp(`\\b${CREDENTIAL_TRIGGER}\\b`, 'i')
const CREDENTIAL_SUBSTRING_PATTERN = new RegExp(CREDENTIAL_TRIGGER, 'i')

const TOKEN_QUALIFIERS =
  '(access|auth|authentication|bearer|refresh|api|session|personal\\s+access|id|oauth|jwt|github|gitlab|npm|slack|service|deploy|bot|csrf|login)'
const QUESTION_TEXT_CREDENTIAL_PATTERN = new RegExp(
  [
    '\\b(password|passphrase|credentials?|private\\s?key|secret\\s?key|api\\s?key)\\b',
    `\\b${TOKEN_QUALIFIERS}\\s+tokens?\\b`,
    '\\b(client|app|application|shared|webhook|oauth|aws|api)\\s+secrets?\\b',
    '\\bsecret\\s+(value|access)\\b',
    '\\b(your|my|the)\\s+(secret|token)\\s*[?.!]?$'
  ].join('|'),
  'i'
)

// `\b` cannot fire across `_`/`-` (word characters to regex) or inside a run of
// capitals, so snake_case, camelCase, and ACRONYMCase credential-shaped values would
// otherwise slip the check; split all three into real word boundaries before matching
// (tech.md C1 REGEX: credential refusal).
//
// A capital run directly against a lowercase run (`DBpassword`) has no second capital to mark
// where the trailing word starts, so there is no single correct split point without a
// dictionary: keeping the last capital with the acronym reads it as `D Bpassword`, keeping it
// with the word reads it as `DB password`. Return both candidates and let the caller check
// either, rather than betting on one.
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
    if (CREDENTIAL_PATTERN.test(normalized)) {
      return true
    }
    // an unbroken capital run (MYSECRET) has no internal boundary for \b to land
    // on and reads as one opaque token; fall back to a plain substring match.
    return normalized
      .split(' ')
      .some((word) => /^[A-Z0-9]+$/.test(word) && CREDENTIAL_SUBSTRING_PATTERN.test(word))
  })
}

const IDENTIFIER_SHAPED_WORD = /[_-]|[a-z][A-Z]|^[A-Z0-9]{4,}$/

function mentionsCredentialInQuestionText(value: string): boolean {
  if (QUESTION_TEXT_CREDENTIAL_PATTERN.test(value)) {
    return true
  }
  return value
    .split(/\s+/)
    .map((word) => word.replace(/^[^\w]+|[^\w]+$/g, ''))
    .some((word) => IDENTIFIER_SHAPED_WORD.test(word) && mentionsCredential(word))
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const FORMAT_PATTERNS: Record<'email' | 'url', RegExp> = {
  email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
  url: /^[a-z][a-z0-9+.-]*:\/\/\S+$/i
}

/** True only for a real calendar date: `Date` silently rolls `2026-02-30` into March, so the parsed value must round-trip back to the input string. */
function isValidIsoDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false
  }
  const date = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

const MAX_PATTERN_QUANTIFIERS = 10

function isQuantifierChar(char: string | undefined): boolean {
  return char === '+' || char === '*' || char === '{' || char === '?'
}

// only `+`, `*`, `{` repeat their subject an unbounded number of times; a trailing `?` repeats
// its subject at most once, so it can never itself compound an inner quantifier into exponential
// backtracking (`(a+)?` is linear; only wrapping it in `+`/`*`/`{` makes it dangerous).
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
      if (char === ']') {
        inClass = false
      }
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
    if (seen.has(alternative)) {
      return true
    }
    seen.add(alternative)
  }
  return false
}

/**
 * Rejects the regex shapes most likely to cause catastrophic backtracking, since a synchronous
 * regex can't be interrupted once matching starts: "star height >= 2" (a quantified group whose
 * body itself contains a quantifier, e.g. `(a+)+` or `(a|a?)+`), a quantified group whose
 * top-level alternation branches are literally identical (e.g. `(a|a)+`), and — as a blunt
 * fallback for shapes those two miss — a cap on the total number of quantifiers in the pattern.
 * It does not detect alternation overlap in general (`(a|ab)+` still passes); that needs a real
 * regex-complexity analyzer, not a single-pass scan.
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
      if (char === ']') {
        inClass = false
      }
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
      if (compounds && bodyHadQuantifier) {
        return true
      }
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

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export const isString = (value: unknown): value is string => typeof value === 'string'
export const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean'
export const isFiniteNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

export function checkOptional<T>(
  raw: unknown,
  isValid: (value: unknown) => value is T,
  path: string,
  message: string,
  errors: AskValidationError[]
): T | undefined {
  if (raw === undefined) {
    return undefined
  }
  if (!isValid(raw)) {
    errors.push({ path, message })
    return undefined
  }
  return raw
}

export function validateId(
  raw: unknown,
  path: string,
  errors: AskValidationError[],
  seenIds: Set<string>
): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push({ path: `${path}.id`, message: 'id is required and must be a non-empty string' })
    return ''
  }
  if (seenIds.has(raw)) {
    errors.push({ path: `${path}.id`, message: `duplicate question id '${raw}'` })
  }
  seenIds.add(raw)
  if (raw in Object.prototype) {
    errors.push({ path: `${path}.id`, message: `'${raw}' is a reserved id` })
  }
  if (mentionsCredential(raw)) {
    errors.push({ path: `${path}.id`, message: 'credential-shaped id is not permitted' })
  }
  return raw
}

export function validateQuestionText(
  raw: unknown,
  path: string,
  errors: AskValidationError[]
): string {
  if (typeof raw !== 'string' || raw.length === 0) {
    errors.push({ path: `${path}.question`, message: 'question text is required' })
    return ''
  }
  if (mentionsCredentialInQuestionText(raw)) {
    errors.push({
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

function validateOption(raw: unknown, path: string, errors: AskValidationError[]): AskOption {
  if (!isPlainObject(raw)) {
    errors.push({ path, message: 'option must be an object' })
    return { value: '', label: '' }
  }
  const value = raw.value
  if (typeof value !== 'string' || value.length === 0) {
    errors.push({ path: `${path}.value`, message: 'option value is required' })
  } else if (mentionsCredential(value)) {
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
  if (raw.preview !== undefined) {
    validatePreview(raw.preview, `${path}.preview`, errors)
  }
  return {
    value: typeof value === 'string' ? value : '',
    label: typeof label === 'string' ? label : '',
    description: isString(raw.description) ? raw.description : undefined,
    preview: readPreview(raw.preview)
  }
}

export function validateOptionsQuestion(
  raw: Record<string, unknown>,
  path: string,
  type: 'select' | 'multiselect',
  common: AskQuestionCommon,
  errors: AskValidationError[]
): AskSelectQuestion | AskMultiselectQuestion {
  const optionsRaw = Array.isArray(raw.options) ? raw.options : []
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    errors.push({ path: `${path}.options`, message: 'options must be a non-empty array' })
  } else if (raw.options.length > MAX_ASK_OPTIONS) {
    errors.push({ path: `${path}.options`, message: `at most ${MAX_ASK_OPTIONS} options allowed` })
  }

  const values = new Set<string>()
  const options = optionsRaw.map((rawOption, index) => {
    const option = validateOption(rawOption, `${path}.options[${index}]`, errors)
    if (option.value !== '' && values.has(option.value)) {
      errors.push({
        path: `${path}.options[${index}].value`,
        message: `duplicate option value '${option.value}'`
      })
    }
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
    const message =
      type === 'select'
        ? 'default must match one option value'
        : 'default must be an array of option values'
    errors.push({ path: `${path}.default`, message })
  }
  return type === 'select'
    ? { ...common, type, options, default: isString(defaultValue) ? defaultValue : undefined }
    : {
        ...common,
        type,
        options,
        default: Array.isArray(defaultValue) ? defaultValue.filter(isString) : undefined
      }
}

export function validateTextQuestion(
  raw: Record<string, unknown>,
  path: string,
  common: AskQuestionCommon,
  errors: AskValidationError[]
): AskTextQuestion {
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
  return {
    ...common,
    type: 'text',
    multiline: isBoolean(raw.multiline) ? raw.multiline : undefined,
    pattern: isString(raw.pattern) ? raw.pattern : undefined,
    format: format === 'email' || format === 'url' ? format : undefined,
    default: isString(defaultValue) ? defaultValue : undefined
  }
}

export function validateNumberQuestion(
  raw: Record<string, unknown>,
  path: string,
  common: AskQuestionCommon,
  errors: AskValidationError[]
): AskNumberQuestion {
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
    if (message) {
      errors.push({ path: `${path}.default`, message })
    }
  }
  return {
    ...common,
    type: 'number',
    integer: isBoolean(raw.integer) ? raw.integer : undefined,
    min,
    max,
    default: isFiniteNumber(defaultValue) ? defaultValue : undefined
  }
}

export function validateDateOrConfirmQuestion(
  type: 'date' | 'confirm',
  raw: Record<string, unknown>,
  path: string,
  common: AskQuestionCommon,
  errors: AskValidationError[]
): AskDateQuestion | AskConfirmQuestion {
  const defaultValue = raw.default
  const isValidDefault =
    type === 'date'
      ? typeof defaultValue === 'string' && isValidIsoDate(defaultValue)
      : isBoolean(defaultValue)
  if (defaultValue !== undefined && !isValidDefault) {
    const message =
      type === 'date'
        ? 'default must be an ISO 8601 date (YYYY-MM-DD)'
        : 'default must be a boolean'
    errors.push({ path: `${path}.default`, message })
  }
  return { ...common, type, default: defaultValue } as AskDateQuestion | AskConfirmQuestion
}
