import { describe, expect, test } from 'bun:test'
import { parseLaunchOptions } from '../../src/core/launch-options'
import type { LaunchCatalog } from '../../src/core/types'

const base = { model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }] } }

const effort = {
  id: 'effort',
  label: 'Effort',
  type: 'select',
  choices: [
    { value: 'low', label: 'Low' },
    { value: 'high', label: 'High' }
  ],
  flag: ['--effort', '{value}']
}

const full: Record<string, any> = {
  model: {
    flag: ['-m', '{value}'],
    conflicts: [{ flags: ['-m', '--model'] }, { flags: ['-c', '--config'], valuePrefix: 'model=' }],
    structured: 'model'
  },
  options: [effort, { id: 'fast', label: 'Fast', type: 'boolean', structured: 'fast' }],
  models: [
    { id: 'big', label: 'Big', description: 'The big one', options: [{ id: 'effort', choices: ['low', 'high'] }, { id: 'fast' }] },
    { id: 'small', label: 'Small', options: [] }
  ],
  unlisted: 'refuse',
  composeModel: 'cursor',
  valueFlags: ['--add-dir'],
  extraArgs: {
    allowed: [
      { kind: 'model', flags: ['--model'] },
      { kind: 'repeatable', flags: ['--add-dir'], valuePrefix: 'x' }
    ],
    placeholder: '--add-dir docs'
  }
}

const withOptions = (extra: Record<string, unknown>) => ({ ...base, ...extra })
const problem = (value: unknown): string => {
  try {
    parseLaunchOptions(value)
  } catch (error) {
    return (error as Error).message
  }
  throw new Error('expected parseLaunchOptions to throw')
}

describe('parseLaunchOptions defaults', () => {
  test('a model-only block gets every default', () => {
    expect(parseLaunchOptions(base)).toEqual({
      model: { flag: ['--model', '{value}'], conflicts: [{ flags: ['--model'] }], structured: null },
      options: [],
      models: [],
      unlisted: 'accept',
      unlistedOptions: [],
      composeModel: null,
      valueFlags: [],
      extraArgs: null
    } satisfies LaunchCatalog)
  })

  test('unlisted defaults to refuse once models are listed', () => {
    const catalog = parseLaunchOptions(withOptions({ models: [{ id: 'a', label: 'A', options: [] }] }))
    expect(catalog.unlisted).toBe('refuse')
    expect(catalog.models).toEqual([{ id: 'a', label: 'A', description: null, options: [] }])
  })

  test('option and use defaults', () => {
    const catalog = parseLaunchOptions(
      withOptions({
        options: [
          { id: 'b', label: 'B', type: 'boolean', structured: 'b' },
          { id: 's', label: 'S', type: 'select', choices: [{ value: 'v', label: 'V' }], flag: ['--s', '{value}'] }
        ],
        models: [{ id: 'a', label: 'A', options: [{ id: 'b' }, { id: 's' }] }]
      })
    )
    expect(catalog.options[0]).toEqual({
      id: 'b',
      label: 'B',
      type: 'boolean',
      choices: null,
      flag: null,
      conflicts: [],
      composed: false,
      structured: 'b'
    })
    expect(catalog.options[1]).toMatchObject({ composed: false, structured: null, conflicts: [] })
    expect(catalog.models[0]!.options).toEqual([
      { id: 'b', choices: null },
      { id: 's', choices: null }
    ])
  })
})

describe('parseLaunchOptions full block', () => {
  test('a full valid block keeps every field', () => {
    const catalog = parseLaunchOptions(full)
    expect<unknown>(catalog).toEqual({
      model: full.model,
      options: [
        { ...effort, conflicts: [], composed: false, structured: null },
        { id: 'fast', label: 'Fast', type: 'boolean', choices: null, flag: null, conflicts: [], composed: false, structured: 'fast' }
      ],
      models: [
        { id: 'big', label: 'Big', description: 'The big one', options: [{ id: 'effort', choices: ['low', 'high'] }, { id: 'fast', choices: null }] },
        { id: 'small', label: 'Small', description: null, options: [] }
      ],
      unlisted: 'refuse',
      unlistedOptions: [],
      composeModel: 'cursor',
      valueFlags: ['--add-dir'],
      extraArgs: full.extraArgs
    })
  })

  test('unlistedOptions are kept with unlisted accept', () => {
    const catalog = parseLaunchOptions(
      withOptions({ options: [effort], unlisted: 'accept', unlistedOptions: [{ id: 'effort', choices: ['low'] }], models: [{ id: 'a', label: 'A', options: [] }] })
    )
    expect(catalog.unlistedOptions).toEqual([{ id: 'effort', choices: ['low'] }])
  })

  test('a composed option needs no flag when composeModel is set', () => {
    const catalog = parseLaunchOptions(
      withOptions({ composeModel: 'cursor', options: [{ id: 'thinking', label: 'Thinking', type: 'boolean', composed: true }] })
    )
    expect(catalog.options[0]).toMatchObject({ composed: true, flag: null })
  })

  test('a model use narrows choices into declared order', () => {
    const catalog = parseLaunchOptions(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'effort', choices: ['high', 'low'] }] }] }))
    expect(catalog.models[0]!.options[0]!.choices).toEqual(['low', 'high'])
  })

  test('the result never aliases the input', () => {
    const input = structuredClone(full)
    const catalog = parseLaunchOptions(input)
    input.model.flag.push('x')
    input.model.conflicts[0]!.flags.push('x')
    input.options[0]!.choices!.push({ value: 'x', label: 'X' })
    input.models[0]!.options[0]!.choices!.push('x')
    input.valueFlags.push('x')
    input.extraArgs.allowed[0]!.flags.push('x')
    input.extraArgs.allowed.push({ kind: 'effort', flags: ['--e'] })
    expect(catalog.model.flag).toEqual(['-m', '{value}'])
    expect(catalog.model.conflicts[0]!.flags).toEqual(['-m', '--model'])
    expect(catalog.options[0]!.choices).toHaveLength(2)
    expect(catalog.models[0]!.options[0]!.choices).toEqual(['low', 'high'])
    expect(catalog.valueFlags).toEqual(['--add-dir'])
    expect(catalog.extraArgs!.allowed).toHaveLength(2)
    expect(catalog.extraArgs!.allowed[0]!.flags).toEqual(['--model'])
  })
})

describe('parseLaunchOptions rejections', () => {
  test('non-objects', () => {
    for (const value of [null, undefined, 'x', 3, [], true]) expect(problem(value)).toStartWith('launchOptions')
  })

  test('the model block is required', () => {
    expect(problem({})).toStartWith('launchOptions')
    expect(problem({ model: 'x' })).toStartWith('launchOptions')
  })

  test('templates need exactly one {value} item', () => {
    for (const flag of [[], ['--model'], ['--model', '{value}', '{value}'], ['--m={value}', '{value}'], 'x', [1, '{value}'], ['--m={value}{value}']]) {
      expect(problem({ model: { ...base.model, flag } })).toStartWith('launchOptions.model.flag')
    }
    expect(problem(withOptions({ options: [{ ...effort, flag: ['--effort'] }] }))).toStartWith('launchOptions.options[0].flag')
    expect(parseLaunchOptions({ model: { ...base.model, flag: ['--model={value}'] } }).model.flag).toEqual(['--model={value}'])
  })

  test('conflicts need non-empty flags and a non-empty valuePrefix', () => {
    expect(problem({ model: { ...base.model, conflicts: [{ flags: [] }] } })).toStartWith('launchOptions.model.conflicts[0].flags')
    expect(problem({ model: { ...base.model, conflicts: [{ flags: [''] }] } })).toStartWith('launchOptions.model.conflicts[0].flags')
    expect(problem({ model: { ...base.model, conflicts: [{}] } })).toStartWith('launchOptions.model.conflicts[0]')
    expect(problem({ model: { ...base.model, conflicts: [{ flags: ['-c'], valuePrefix: '' }] } })).toStartWith('launchOptions.model.conflicts[0].valuePrefix')
    expect(problem({ model: { ...base.model, conflicts: [{ flags: ['-c'], valuePrefix: 3 }] } })).toStartWith('launchOptions.model.conflicts[0].valuePrefix')
    expect(problem({ model: { ...base.model, conflicts: {} } })).toStartWith('launchOptions.model.conflicts')
    expect(problem(withOptions({ options: [{ ...effort, conflicts: [{ flags: [] }] }] }))).toStartWith('launchOptions.options[0].conflicts[0].flags')
  })

  test('duplicate option and model ids', () => {
    expect(problem(withOptions({ options: [effort, effort] }))).toStartWith('launchOptions.options[1].id')
    const model = { id: 'a', label: 'A', options: [] }
    expect(problem(withOptions({ models: [model, model] }))).toStartWith('launchOptions.models[1].id')
  })

  test('reserved and overlong option ids', () => {
    for (const id of ['model', '__proto__', 'constructor', 'prototype']) {
      expect(problem(withOptions({ options: [{ ...effort, id }] }))).toStartWith('launchOptions.options[0].id')
    }
    expect(problem(withOptions({ options: [{ ...effort, id: 'x'.repeat(65) }] }))).toStartWith('launchOptions.options[0].id')
    expect(parseLaunchOptions(withOptions({ options: [{ ...effort, id: 'x'.repeat(64) }] })).options).toHaveLength(1)
    expect(problem(withOptions({ options: [{ ...effort, id: '' }] }))).toStartWith('launchOptions.options[0].id')
  })

  test('selects need non-empty choices and booleans have none', () => {
    const { choices: _omit, ...noChoices } = effort
    expect(problem(withOptions({ options: [noChoices] }))).toStartWith('launchOptions.options[0].choices')
    expect(problem(withOptions({ options: [{ ...effort, choices: [] }] }))).toStartWith('launchOptions.options[0].choices')
    expect(problem(withOptions({ options: [{ ...effort, choices: [{ value: 'a' }] }] }))).toStartWith('launchOptions.options[0].choices[0]')
    expect(problem(withOptions({ options: [{ ...effort, choices: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }] }))).toStartWith(
      'launchOptions.options[0].choices[1]'
    )
    expect(problem(withOptions({ options: [{ id: 'b', label: 'B', type: 'boolean', structured: 'b', choices: [] }] }))).toStartWith('launchOptions.options[0].choices')
    expect(problem(withOptions({ options: [{ ...effort, type: 'range' }] }))).toStartWith('launchOptions.options[0].type')
  })

  test('an option needs flag, composed or structured', () => {
    const { flag: _omit, ...bare } = effort
    expect(problem(withOptions({ options: [bare] }))).toStartWith('launchOptions.options[0]')
    expect(parseLaunchOptions(withOptions({ options: [{ ...bare, structured: 'effort' }] })).options).toHaveLength(1)
  })

  test('composed needs composeModel', () => {
    expect(problem(withOptions({ options: [{ id: 't', label: 'T', type: 'boolean', composed: true }] }))).toStartWith('launchOptions.options[0].composed')
    expect(problem(withOptions({ composeModel: 'other' }))).toStartWith('launchOptions.composeModel')
    expect(problem(withOptions({ composeModel: 'cursor', options: [{ id: 't', label: 'T', type: 'boolean', composed: false }] }))).toStartWith(
      'launchOptions.options[0].composed'
    )
  })

  test('model uses name declared options and declared choices', () => {
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'nope' }] }] }))).toStartWith(
      'launchOptions.models[0].options[0].id'
    )
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'effort', choices: ['max'] }] }] }))).toStartWith(
      'launchOptions.models[0].options[0].choices'
    )
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'effort', choices: [] }] }] }))).toStartWith(
      'launchOptions.models[0].options[0].choices'
    )
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'effort' }, { id: 'effort' }] }] }))).toStartWith(
      'launchOptions.models[0].options[1].id'
    )
    const flagOnly = { id: 'b', label: 'B', type: 'boolean', structured: 'b' }
    expect(problem(withOptions({ options: [flagOnly], models: [{ id: 'a', label: 'A', options: [{ id: 'b', choices: ['x'] }] }] }))).toStartWith(
      'launchOptions.models[0].options[0].choices'
    )
  })

  test('unlistedOptions need unlisted accept and declared options', () => {
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [] }], unlistedOptions: [{ id: 'effort' }] }))).toStartWith(
      'launchOptions.unlistedOptions'
    )
    expect(problem(withOptions({ options: [effort], unlisted: 'refuse', unlistedOptions: [{ id: 'effort' }] }))).toStartWith('launchOptions.unlistedOptions')
    expect(problem(withOptions({ options: [effort], unlistedOptions: [{ id: 'nope' }] }))).toStartWith('launchOptions.unlistedOptions[0].id')
    expect(problem(withOptions({ unlisted: 'maybe' }))).toStartWith('launchOptions.unlisted')
  })

  test('valueFlags is a list of non-empty strings', () => {
    expect(problem(withOptions({ valueFlags: '--x' }))).toStartWith('launchOptions.valueFlags')
    expect(problem(withOptions({ valueFlags: [''] }))).toStartWith('launchOptions.valueFlags')
  })

  test('extraArgs needs rules with flags and a string placeholder', () => {
    const rule = { kind: 'model', flags: ['--model'] }
    expect(problem(withOptions({ extraArgs: { allowed: [], placeholder: 'p' } }))).toStartWith('launchOptions.extraArgs.allowed')
    expect(problem(withOptions({ extraArgs: { allowed: [{ ...rule, flags: [] }], placeholder: 'p' } }))).toStartWith('launchOptions.extraArgs.allowed[0].flags')
    expect(problem(withOptions({ extraArgs: { allowed: [{ ...rule, kind: 'other' }], placeholder: 'p' } }))).toStartWith('launchOptions.extraArgs.allowed[0].kind')
    expect(problem(withOptions({ extraArgs: { allowed: [{ ...rule, valuePrefix: '' }], placeholder: 'p' } }))).toStartWith(
      'launchOptions.extraArgs.allowed[0].valuePrefix'
    )
    expect(problem(withOptions({ extraArgs: { allowed: [rule], placeholder: 3 } }))).toStartWith('launchOptions.extraArgs.placeholder')
    expect(problem(withOptions({ extraArgs: { allowed: [rule] } }))).toStartWith('launchOptions.extraArgs.placeholder')
    expect(problem(withOptions({ extraArgs: 'x' }))).toStartWith('launchOptions.extraArgs')
  })

  test('unknown keys at every level', () => {
    const rule = { kind: 'model', flags: ['--model'] }
    expect(problem(withOptions({ colour: 1 }))).toBe('launchOptions has an unknown field colour')
    expect(problem({ model: { ...base.model, colour: 1 } })).toStartWith('launchOptions.model has an unknown field')
    expect(problem({ model: { ...base.model, conflicts: [{ flags: ['-m'], colour: 1 }] } })).toStartWith('launchOptions.model.conflicts[0] has an unknown field')
    expect(problem(withOptions({ options: [{ ...effort, colour: 1 }] }))).toStartWith('launchOptions.options[0] has an unknown field')
    expect(problem(withOptions({ options: [{ ...effort, choices: [{ value: 'a', label: 'A', colour: 1 }] }] }))).toStartWith(
      'launchOptions.options[0].choices[0] has an unknown field'
    )
    expect(problem(withOptions({ models: [{ id: 'a', label: 'A', options: [], colour: 1 }] }))).toStartWith('launchOptions.models[0] has an unknown field')
    expect(problem(withOptions({ options: [effort], models: [{ id: 'a', label: 'A', options: [{ id: 'effort', colour: 1 }] }] }))).toStartWith(
      'launchOptions.models[0].options[0] has an unknown field'
    )
    expect(problem(withOptions({ extraArgs: { allowed: [rule], placeholder: 'p', colour: 1 } }))).toStartWith('launchOptions.extraArgs has an unknown field')
    expect(problem(withOptions({ extraArgs: { allowed: [{ ...rule, colour: 1 }], placeholder: 'p' } }))).toStartWith(
      'launchOptions.extraArgs.allowed[0] has an unknown field'
    )
  })

  test('a parsed own __proto__ key is an unknown field, not a prototype write', () => {
    const input = JSON.parse('{"model":{"flag":["--m","{value}"],"conflicts":[]},"__proto__":{"x":1}}')
    expect(problem(input)).toBe('launchOptions has an unknown field __proto__')
  })

  test('label and model fields must be strings', () => {
    expect(problem(withOptions({ options: [{ ...effort, label: '' }] }))).toStartWith('launchOptions.options[0].label')
    expect(problem(withOptions({ models: [{ id: 'a', label: 3, options: [] }] }))).toStartWith('launchOptions.models[0].label')
    expect(problem(withOptions({ models: [{ id: 'a', label: 'A', description: 3, options: [] }] }))).toStartWith('launchOptions.models[0].description')
    expect(problem({ model: { ...base.model, structured: '' } })).toStartWith('launchOptions.model.structured')
  })
})
