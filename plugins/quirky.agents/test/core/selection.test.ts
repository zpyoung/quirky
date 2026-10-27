import { describe, expect, test } from 'bun:test'
import { SelectionError, validateSelection } from '../../src/core/selection'
import type { AgentEntry, LaunchCatalog, OptionDecl } from '../../src/core/types'

const levels = (...values: string[]): { value: string; label: string }[] =>
  values.map((value) => ({ value, label: value }))

const effortOption = (id: string, ...values: string[]): OptionDecl => ({
  id,
  label: id,
  type: 'select',
  choices: levels(...values),
  flag: null,
  conflicts: [],
  composed: false,
  structured: null
})

const booleanOption = (id: string): OptionDecl => ({ ...effortOption(id), type: 'boolean', choices: null })

const catalog = (parts: Partial<LaunchCatalog>): LaunchCatalog => ({
  model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: null },
  options: [],
  models: [],
  unlisted: 'accept',
  unlistedOptions: [],
  composeModel: null,
  valueFlags: [],
  extraArgs: null,
  ...parts
})

const model = (id: string, options: { id: string; choices?: string[] }[] = []) => ({
  id,
  label: id,
  description: null,
  options: options.map((option) => ({ id: option.id, choices: option.choices ?? null }))
})

const agent = (id: string, launchOptions: LaunchCatalog | null): AgentEntry => ({ id, launchOptions }) as AgentEntry

const claude = agent(
  'claude',
  catalog({
    options: [effortOption('effort', 'low', 'medium', 'high', 'xhigh', 'max')],
    models: [model('fable', [{ id: 'effort' }]), model('opus', [{ id: 'effort' }]), model('haiku')],
    unlisted: 'accept',
    unlistedOptions: [{ id: 'effort', choices: null }]
  })
)

const codex = agent(
  'codex',
  catalog({
    options: [effortOption('effort', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra')],
    models: [
      model('gpt-5.6-sol', [{ id: 'effort' }]),
      model('gpt-5.5', [{ id: 'effort', choices: ['minimal', 'low', 'medium', 'high', 'xhigh'] }])
    ],
    unlistedOptions: [{ id: 'effort', choices: null }]
  })
)

const gemini = agent('gemini', catalog({ models: [model('gemini-3-pro-preview')], unlisted: 'refuse' }))

const omp = agent('omp', catalog({}))

const cursor = agent(
  'cursor',
  catalog({
    options: [
      effortOption('effort', 'low', 'medium', 'high'),
      booleanOption('fastMode'),
      booleanOption('thinking')
    ],
    models: [
      model('auto'),
      model('gpt-5.3-codex', [{ id: 'effort' }, { id: 'fastMode' }]),
      model('claude-opus-4-8', [{ id: 'effort' }, { id: 'thinking' }])
    ],
    unlisted: 'refuse'
  })
)

const aider = agent('aider', null)

const refusal = (entry: AgentEntry, raw: Parameters<typeof validateSelection>[1]): string => {
  try {
    validateSelection(entry, raw)
  } catch (error) {
    expect(error).toBeInstanceOf(SelectionError)
    return (error as Error).message
  }
  throw new Error('expected validateSelection to throw')
}

describe('validateSelection results', () => {
  test('no model and no options is no selection', () => {
    expect(validateSelection(claude, {})).toBeNull()
    expect(validateSelection(claude, { options: {} })).toBeNull()
    expect(validateSelection(aider, {})).toBeNull()
  })

  test('a listed model keeps its picks and is marked listed', () => {
    expect(validateSelection(claude, { model: 'opus', options: { effort: 'high' } })).toEqual({
      model: 'opus',
      values: { effort: 'high' },
      listed: true
    })
  })

  test('a model alone is valid and has no values', () => {
    expect(validateSelection(claude, { model: 'haiku' })).toEqual({ model: 'haiku', values: {}, listed: true })
  })

  test('the model is trimmed', () => {
    expect(validateSelection(claude, { model: '  opus  ' })?.model).toBe('opus')
  })

  test('values come back in a null-prototype object', () => {
    const picked = validateSelection(claude, { model: 'opus', options: { effort: 'low' } })
    expect(Object.getPrototypeOf(picked?.values)).toBeNull()
  })

  test('the result does not alias the caller options', () => {
    const options = { effort: 'low' }
    const picked = validateSelection(claude, { model: 'opus', options })
    options.effort = 'max'
    expect(picked?.values.effort).toBe('low')
  })
})

describe('SC-9: refusals', () => {
  test('SC-9: options without a model need a model', () => {
    expect(refusal(claude, { options: { effort: 'low' } })).toBe('effort requires a model')
    expect(refusal(claude, { options: { effort: 'low', speed: 'fast' } })).toBe('effort requires a model')
  })

  test('SC-9: a model with no options refuses an option', () => {
    expect(refusal(claude, { model: 'haiku', options: { effort: 'low' } })).toBe(
      'Agent claude model haiku does not support effort low.'
    )
  })

  test('SC-9: a choice above the model ceiling is refused', () => {
    expect(refusal(codex, { model: 'gpt-5.5', options: { effort: 'ultra' } })).toBe(
      'Agent codex model gpt-5.5 does not support effort ultra.'
    )
    expect(validateSelection(codex, { model: 'gpt-5.6-sol', options: { effort: 'ultra' } })?.values).toEqual({
      effort: 'ultra'
    })
  })

  test('SC-9: an agent without a catalog refuses any model', () => {
    expect(refusal(aider, { model: 'gpt-4o' })).toBe('Agent aider does not support launch-time model selection.')
    expect(refusal(aider, { model: 'gpt-4o', options: { effort: 'low' } })).toBe(
      'Agent aider does not support launch-time model selection.'
    )
  })

  test('SC-9: an agent that refuses unlisted models names the model', () => {
    expect(refusal(gemini, { model: 'gemini-9' })).toBe('Agent gemini does not support model gemini-9.')
  })

  test('SC-9: an option the model never declared is refused', () => {
    expect(refusal(claude, { model: 'opus', options: { speed: 'fast' } })).toBe(
      'Agent claude model opus does not support speed fast.'
    )
  })

  test('SC-9: a value that is not a choice is refused', () => {
    expect(refusal(cursor, { model: 'claude-opus-4-8', options: { thinking: 'maybe' } })).toBe(
      'Agent cursor model claude-opus-4-8 does not support thinking maybe.'
    )
  })

  test('SC-9: options without a model are checked before the agent supports models', () => {
    expect(refusal(aider, { options: { effort: 'low' } })).toBe('effort requires a model')
  })
})

describe('SC-10: unlisted models', () => {
  test('SC-10: claude accepts an unlisted model with effort', () => {
    expect(validateSelection(claude, { model: 'claude-opus-5-5', options: { effort: 'max' } })).toEqual({
      model: 'claude-opus-5-5',
      values: { effort: 'max' },
      listed: false
    })
  })

  test('SC-10: codex gives an unlisted model every effort', () => {
    expect(validateSelection(codex, { model: 'gpt-7', options: { effort: 'ultra' } })).toEqual({
      model: 'gpt-7',
      values: { effort: 'ultra' },
      listed: false
    })
  })

  test('SC-10: omp accepts an unlisted model and refuses any option', () => {
    expect(validateSelection(omp, { model: 'anthropic/sonnet' })).toEqual({
      model: 'anthropic/sonnet',
      values: {},
      listed: false
    })
    expect(refusal(omp, { model: 'anthropic/sonnet', options: { effort: 'high' } })).toBe(
      'Agent omp model anthropic/sonnet does not support effort high.'
    )
  })

  test('SC-10: gemini refuses an unlisted model but accepts a listed one', () => {
    expect(refusal(gemini, { model: 'gemini-9' })).toBe('Agent gemini does not support model gemini-9.')
    expect(validateSelection(gemini, { model: 'gemini-3-pro-preview' })?.listed).toBe(true)
  })

  test('an unlisted model only gets the unlisted options', () => {
    expect(refusal(claude, { model: 'claude-opus-5-5', options: { speed: 'fast' } })).toBe(
      'Agent claude model claude-opus-5-5 does not support speed fast.'
    )
  })
})

describe('SC-11: cursor', () => {
  test('SC-11: auto with any option is refused', () => {
    expect(refusal(cursor, { model: 'auto', options: { effort: 'high' } })).toBe(
      'Agent cursor model auto does not support effort high.'
    )
    expect(validateSelection(cursor, { model: 'auto' })).toEqual({ model: 'auto', values: {}, listed: true })
  })

  test('SC-11: booleans and selects validate per model', () => {
    expect(
      validateSelection(cursor, { model: 'claude-opus-4-8', options: { thinking: true, effort: 'high' } })?.values
    ).toEqual({ thinking: true, effort: 'high' })
    expect(
      validateSelection(cursor, { model: 'gpt-5.3-codex', options: { effort: 'low', fastMode: false } })?.values
    ).toEqual({ effort: 'low', fastMode: false })
  })

  test('SC-11: fastMode is not offered to a claude model', () => {
    expect(refusal(cursor, { model: 'claude-opus-4-8', options: { fastMode: true } })).toBe(
      'Agent cursor model claude-opus-4-8 does not support fastMode true.'
    )
  })
})

describe('booleans and selects', () => {
  test('a boolean option needs a boolean value', () => {
    expect(refusal(cursor, { model: 'claude-opus-4-8', options: { thinking: 'true' } })).toBe(
      'Agent cursor model claude-opus-4-8 does not support thinking true.'
    )
  })

  test('a select needs a string value', () => {
    expect(refusal(cursor, { model: 'gpt-5.3-codex', options: { effort: true } })).toBe(
      'Agent cursor model gpt-5.3-codex does not support effort true.'
    )
  })

  test('a non-scalar option value is an invalid selection', () => {
    expect(refusal(claude, { model: 'opus', options: { effort: { deep: 1 } } })).toBe(
      'invalid launch selection: option effort must be a string or a boolean'
    )
    expect(refusal(claude, { model: 'opus', options: { effort: 3 } })).toBe(
      'invalid launch selection: option effort must be a string or a boolean'
    )
  })
})

describe('bounds and reserved keys', () => {
  test('an empty model is invalid', () => {
    expect(refusal(claude, { model: '   ' })).toBe('invalid launch selection: model must not be empty')
    expect(refusal(claude, { model: '' })).toBe('invalid launch selection: model must not be empty')
  })

  test('a model that is not a string is invalid', () => {
    expect(refusal(claude, { model: 5 })).toBe('invalid launch selection: model must be a string')
  })

  test('a model of 128 characters passes and 129 does not', () => {
    expect(validateSelection(claude, { model: 'm'.repeat(128) })?.listed).toBe(false)
    expect(refusal(claude, { model: 'm'.repeat(129) })).toBe(
      'invalid launch selection: model must be 128 characters or fewer'
    )
  })

  test('16 options pass and 17 do not', () => {
    const many = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, i) => [`o${i}`, 'x']))
    expect(refusal(claude, { model: 'opus', options: many(16) })).toBe(
      'Agent claude model opus does not support o0 x.'
    )
    expect(refusal(claude, { model: 'opus', options: many(17) })).toBe(
      'invalid launch selection: at most 16 options'
    )
  })

  test('an option ID of 64 characters passes the bound and 65 does not', () => {
    expect(refusal(claude, { model: 'opus', options: { ['a'.repeat(64)]: 'x' } })).toBe(
      `Agent claude model opus does not support ${'a'.repeat(64)} x.`
    )
    expect(refusal(claude, { model: 'opus', options: { ['a'.repeat(65)]: 'x' } })).toBe(
      'invalid launch selection: option IDs must be 64 characters or fewer'
    )
  })

  test.each(['model', '__proto__', 'constructor', 'prototype'])('the option ID %s is reserved', (id) => {
    const options = JSON.parse(`{${JSON.stringify(id)}: "x"}`) as Record<string, string>
    expect(refusal(claude, { model: 'opus', options })).toBe(`invalid launch selection: option ID ${id} is reserved`)
  })

  test('options that are not an object are invalid', () => {
    expect(refusal(claude, { model: 'opus', options: ['effort'] })).toBe(
      'invalid launch selection: options must be an object'
    )
    expect(refusal(claude, { model: 'opus', options: 'high' })).toBe(
      'invalid launch selection: options must be an object'
    )
  })
})
