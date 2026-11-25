import { mentionsCredential } from './view-spec-credential-text'
import {
  addError,
  checkKeys,
  isFiniteNumber,
  isPlainObject,
  type Check
} from './view-spec-check-state'
import {
  MAX_PATTERN_LENGTH,
  MAX_PATTERN_TEST_LENGTH,
  UNSAFE_PATTERN_MESSAGES,
  findUnsafePatternShape
} from './view-spec-regex-safety'
import { ACTION_NAME_PATTERN, FORMAT_PATTERNS, MAX_OPTIONS } from './view-spec-types'

const FIELD_TYPES = ['select', 'multiselect', 'text', 'number', 'confirm'] as const
function isFieldType(value: unknown): value is (typeof FIELD_TYPES)[number] {
  return typeof value === 'string' && FIELD_TYPES.some((type) => type === value)
}

const RESERVED_IDS = new Set(['__proto__', 'constructor', 'prototype'])

/** Checks one `field` question and returns its canonical form; problems are added to `check`. */
export function readQuestion(
  raw: unknown,
  path: string,
  check: Check
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    return void addError(check, path, 'must be an ask question object')
  }
  if ('masked' in raw || 'sensitive' in raw) {
    addError(
      check,
      path,
      'masked/sensitive input is not permitted; collect credentials out of band'
    )
  }
  checkKeys(
    raw,
    [
      'id',
      'type',
      'question',
      'header',
      'required',
      'options',
      'default',
      'multiline',
      'pattern',
      'format',
      'integer',
      'min',
      'max'
    ],
    path,
    check
  )
  const out: Record<string, unknown> = {}

  const id = raw.id
  if (typeof id !== 'string' || !ACTION_NAME_PATTERN.test(id)) {
    addError(
      check,
      `${path}.id`,
      'id is required: lowercase letters, digits and dashes, 1 to 40 characters'
    )
  } else {
    if (check.fieldIds.has(id)) {
      addError(check, `${path}.id`, `duplicate field id '${id}'`)
    }
    check.fieldIds.add(id)
    if (RESERVED_IDS.has(id)) {
      addError(check, `${path}.id`, 'id must not be __proto__, constructor or prototype')
    }
    if (mentionsCredential(id)) {
      addError(check, `${path}.id`, 'credential-shaped id is not permitted')
    }
    out.id = id
  }

  if (typeof raw.question !== 'string' || raw.question.length === 0) {
    addError(check, `${path}.question`, 'question text is required')
  } else {
    if (mentionsCredential(raw.question)) {
      addError(check, `${path}.question`, 'credential-shaped question text is not permitted')
    }
    out.question = raw.question
  }
  for (const key of ['header'] as const) {
    if (raw[key] === undefined) {
      continue
    }
    if (typeof raw[key] === 'string') {
      out[key] = raw[key]
    } else {
      addError(check, `${path}.${key}`, `${key} must be a string`)
    }
  }
  if (raw.required !== undefined) {
    if (typeof raw.required === 'boolean') {
      out.required = raw.required
    } else {
      addError(check, `${path}.required`, 'required must be a boolean')
    }
  }

  const type = raw.type
  if (!isFieldType(type)) {
    addError(check, `${path}.type`, `type must be one of ${FIELD_TYPES.join(' | ')}`)
    return out
  }
  out.type = type
  if (type === 'select' || type === 'multiselect') {
    readOptionsQuestion(raw, type, out, path, check)
  } else if (type === 'text') {
    readTextQuestion(raw, out, path, check)
  } else if (type === 'number') {
    readNumberQuestion(raw, out, path, check)
  } else if (raw.default !== undefined) {
    if (typeof raw.default === 'boolean') {
      out.default = raw.default
    } else {
      addError(check, `${path}.default`, 'default must be a boolean')
    }
  }
  const stray =
    {
      select: ['multiline', 'pattern', 'format', 'integer', 'min', 'max'],
      multiselect: ['multiline', 'pattern', 'format', 'integer', 'min', 'max'],
      text: ['options', 'integer', 'min', 'max'],
      number: ['options', 'multiline', 'pattern', 'format'],
      confirm: ['options', 'multiline', 'pattern', 'format', 'integer', 'min', 'max']
    }[type] ?? []
  for (const key of stray) {
    if (raw[key] !== undefined) {
      addError(check, `${path}.${key}`, `${key} does not apply to ${type}`)
    }
  }
  return out
}

function readOptionsQuestion(
  raw: Record<string, unknown>,
  type: 'select' | 'multiselect',
  out: Record<string, unknown>,
  path: string,
  check: Check
): void {
  const values = new Set<string>()
  if (!Array.isArray(raw.options) || raw.options.length === 0) {
    addError(check, `${path}.options`, 'options must be a non-empty array')
  } else if (raw.options.length > MAX_OPTIONS) {
    addError(check, `${path}.options`, `at most ${MAX_OPTIONS} options allowed`)
  } else {
    out.options = raw.options.map((option, index) => {
      const optionPath = `${path}.options[${index}]`
      if (!isPlainObject(option)) {
        addError(check, optionPath, 'option must be an object')
        return {}
      }
      checkKeys(option, ['value', 'label', 'description'], optionPath, check)
      const read: Record<string, unknown> = {}
      if (typeof option.value !== 'string' || option.value.length === 0) {
        addError(check, `${optionPath}.value`, 'option value is required')
      } else {
        if (mentionsCredential(option.value)) {
          addError(check, `${optionPath}.value`, 'credential-shaped option value is not permitted')
        }
        values.add(option.value)
        read.value = option.value
      }
      if (typeof option.label !== 'string' || option.label.length === 0) {
        addError(check, `${optionPath}.label`, 'option label is required')
      } else {
        read.label = option.label
      }
      if (option.description !== undefined) {
        if (typeof option.description === 'string') {
          read.description = option.description
        } else {
          addError(check, `${optionPath}.description`, 'description must be a string')
        }
      }
      return read
    })
  }
  const value = raw.default
  if (value === undefined) {
    return
  }
  const valid =
    type === 'select'
      ? typeof value === 'string' && values.has(value)
      : Array.isArray(value) &&
        value.every((entry) => typeof entry === 'string' && values.has(entry))
  if (valid) {
    out.default = value
  } else {
    addError(
      check,
      `${path}.default`,
      type === 'select'
        ? 'default must match one option value'
        : 'default must be an array of option values'
    )
  }
}

function readTextQuestion(
  raw: Record<string, unknown>,
  out: Record<string, unknown>,
  path: string,
  check: Check
): void {
  if (raw.multiline !== undefined) {
    if (typeof raw.multiline === 'boolean') {
      out.multiline = raw.multiline
    } else {
      addError(check, `${path}.multiline`, 'multiline must be a boolean')
    }
  }
  let patternRegex: RegExp | undefined
  if (raw.pattern !== undefined) {
    const unsafe =
      typeof raw.pattern === 'string' && raw.pattern.length <= MAX_PATTERN_LENGTH
        ? findUnsafePatternShape(raw.pattern)
        : undefined
    if (typeof raw.pattern !== 'string') {
      addError(check, `${path}.pattern`, 'pattern must be a string')
    } else if (raw.pattern.length > MAX_PATTERN_LENGTH) {
      addError(check, `${path}.pattern`, `pattern must be at most ${MAX_PATTERN_LENGTH} characters`)
    } else if (unsafe) {
      addError(check, `${path}.pattern`, UNSAFE_PATTERN_MESSAGES[unsafe])
    } else {
      try {
        patternRegex = new RegExp(raw.pattern)
        out.pattern = raw.pattern
      } catch {
        addError(check, `${path}.pattern`, 'pattern must be a valid regular expression')
      }
    }
  }
  const format = raw.format
  if (format !== undefined) {
    if (format === 'email' || format === 'url') {
      out.format = format
    } else {
      addError(check, `${path}.format`, "format must be 'email' or 'url'")
    }
  }
  if (raw.default === undefined) {
    return
  }
  if (typeof raw.default !== 'string') {
    return addError(check, `${path}.default`, 'default must be a string')
  }
  if (patternRegex) {
    if (raw.default.length > MAX_PATTERN_TEST_LENGTH) {
      addError(
        check,
        `${path}.default`,
        `default must be at most ${MAX_PATTERN_TEST_LENGTH} characters when pattern is set`
      )
    } else if (!patternRegex.test(raw.default)) {
      addError(check, `${path}.default`, 'default does not match pattern')
    }
  }
  if ((format === 'email' || format === 'url') && !FORMAT_PATTERNS[format].test(raw.default)) {
    addError(check, `${path}.default`, `default is not a valid ${format}`)
  }
  out.default = raw.default
}

function readNumberQuestion(
  raw: Record<string, unknown>,
  out: Record<string, unknown>,
  path: string,
  check: Check
): void {
  if (raw.integer !== undefined) {
    if (typeof raw.integer === 'boolean') {
      out.integer = raw.integer
    } else {
      addError(check, `${path}.integer`, 'integer must be a boolean')
    }
  }
  for (const key of ['min', 'max'] as const) {
    if (raw[key] === undefined) {
      continue
    }
    if (isFiniteNumber(raw[key])) {
      out[key] = raw[key]
    } else {
      addError(check, `${path}.${key}`, `${key} must be a number`)
    }
  }
  const min = typeof out.min === 'number' ? out.min : undefined
  const max = typeof out.max === 'number' ? out.max : undefined
  if (min !== undefined && max !== undefined && min > max) {
    addError(check, `${path}.min`, 'min must not exceed max')
  }
  const value = raw.default
  if (value === undefined) {
    return
  }
  if (!isFiniteNumber(value)) {
    return addError(check, `${path}.default`, 'default must be a number')
  }
  const problem =
    (raw.integer === true && !Number.isInteger(value) && 'default must be an integer') ||
    (min !== undefined && value < min && 'default is below min') ||
    (max !== undefined && value > max && 'default is above max')
  if (problem) {
    addError(check, `${path}.default`, problem)
  } else {
    out.default = value
  }
}
