import { describe, expect, it } from 'vitest'
import { validateAskSpec } from './ask-question-schema'
import {
  isTerminalAskEnvelope,
  isTerminalAskStatus,
  type AskPendingEnvelope,
  type AskStatus
} from './ask-answer-envelope'

function selectQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'db_engine',
    type: 'select',
    question: 'Which database?',
    options: [
      { value: 'postgres', label: 'PostgreSQL' },
      { value: 'mysql', label: 'MySQL' }
    ],
    ...overrides
  }
}

function multiselectQuestion(overrides: Record<string, unknown> = {}) {
  return {
    id: 'features',
    type: 'multiselect',
    question: 'Which features?',
    options: [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B' }
    ],
    ...overrides
  }
}

function textQuestion(overrides: Record<string, unknown> = {}) {
  return { id: 'notes', type: 'text', question: 'Any notes?', ...overrides }
}

function numberQuestion(overrides: Record<string, unknown> = {}) {
  return { id: 'pool_size', type: 'number', question: 'Pool size?', min: 1, max: 100, ...overrides }
}

function dateQuestion(overrides: Record<string, unknown> = {}) {
  return { id: 'start_date', type: 'date', question: 'Start date?', ...overrides }
}

function confirmQuestion(overrides: Record<string, unknown> = {}) {
  return { id: 'confirmed', type: 'confirm', question: 'Confirm?', ...overrides }
}

function specOf(...questions: unknown[]) {
  return { questions }
}

describe('validateAskSpec — malformed input', () => {
  it.each([null, undefined, 42, 'not an object', true, []])(
    'never throws and rejects %p',
    (input) => {
      expect(() => validateAskSpec(input)).not.toThrow()
      expect(validateAskSpec(input).ok).toBe(false)
    }
  )

  it('rejects a spec whose questions field is not an array', () => {
    const result = validateAskSpec({ questions: 'nope' })
    expect(result).toEqual({
      ok: false,
      errors: [{ path: 'questions', message: 'questions must be an array' }]
    })
  })
})

describe('validateAskSpec — limits', () => {
  it('accepts up to 10 questions', () => {
    const questions = Array.from({ length: 10 }, (_, i) => textQuestion({ id: `q${i}` }))
    expect(validateAskSpec(specOf(...questions)).ok).toBe(true)
  })

  it('rejects more than 10 questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => textQuestion({ id: `q${i}` }))
    const result = validateAskSpec(specOf(...questions))
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({
      errors: expect.arrayContaining([
        { path: 'questions', message: 'at most 10 questions allowed' }
      ])
    })
  })

  it('accepts up to 12 options', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))
    expect(validateAskSpec(specOf(selectQuestion({ options }))).ok).toBe(true)
  })

  it('rejects more than 12 options, naming the field path', () => {
    const options = Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))
    const result = validateAskSpec(specOf(selectQuestion({ options })))
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[0].options', message: 'at most 12 options allowed' }
      ])
    })
  })
})

describe('validateAskSpec — id uniqueness', () => {
  it('rejects a blank or missing id', () => {
    const result = validateAskSpec(specOf(textQuestion({ id: '' })))
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[0].id', message: 'id is required and must be a non-empty string' }
      ])
    })
  })

  it('rejects duplicate ids and names the second occurrence', () => {
    const result = validateAskSpec(
      specOf(textQuestion({ id: 'dup' }), numberQuestion({ id: 'dup' }))
    )
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[1].id', message: "duplicate question id 'dup'" }
      ])
    })
  })
})

describe('validateAskSpec — per-type default domain', () => {
  it.each([
    ['select: matching option value', selectQuestion({ default: 'postgres' }), true],
    ['select: value outside option set', selectQuestion({ default: 'sqlite' }), false],
    ['multiselect: matching option values', multiselectQuestion({ default: ['a', 'b'] }), true],
    ['multiselect: unknown option value', multiselectQuestion({ default: ['z'] }), false],
    ['multiselect: not an array', multiselectQuestion({ default: 'a' }), false],
    ['text: plain string with no constraints', textQuestion({ default: 'anything' }), true],
    ['text: violates pattern', textQuestion({ pattern: '^[a-z]+$', default: '123' }), false],
    ['text: matches pattern', textQuestion({ pattern: '^[a-z]+$', default: 'ok' }), true],
    ['text: invalid email format', textQuestion({ format: 'email', default: 'nope' }), false],
    ['text: valid email format', textQuestion({ format: 'email', default: 'a@b.com' }), true],
    ['number: within min/max', numberQuestion({ default: 50 }), true],
    ['number: above max', numberQuestion({ default: 500 }), false],
    [
      'number: non-integer when integer required',
      numberQuestion({ integer: true, default: 1.5 }),
      false
    ],
    ['date: valid ISO date', dateQuestion({ default: '2026-01-01' }), true],
    ['date: non-ISO date', dateQuestion({ default: '01/01/2026' }), false],
    ['date: last day of a short month', dateQuestion({ default: '2026-02-28' }), true],
    ['date: impossible calendar date (S2)', dateQuestion({ default: '2026-02-30' }), false],
    ['date: day rolls into a different month', dateQuestion({ default: '2026-04-31' }), false],
    ['date: month out of range', dateQuestion({ default: '2026-13-01' }), false],
    ['confirm: boolean default', confirmQuestion({ default: true }), true],
    ['confirm: non-boolean default', confirmQuestion({ default: 'yes' }), false]
  ])('%s', (_label, question, expectOk) => {
    const result = validateAskSpec(specOf(question))
    expect(result.ok).toBe(expectOk)
    if (!expectOk) {
      expect(result).toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].default' })])
      })
    }
  })

  it('names a default error at a non-zero index like the spec example', () => {
    const result = validateAskSpec(specOf(textQuestion(), numberQuestion({ default: 500 })))
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[1].default' })])
    })
  })
})

describe('validateAskSpec — pattern safety (X2)', () => {
  it('rejects a nested-quantifier pattern promptly instead of hanging', () => {
    const start = performance.now()
    const result = validateAskSpec(
      specOf(textQuestion({ pattern: '^(a+)+$', default: `${'a'.repeat(29)}!` }))
    )
    const elapsedMs = performance.now() - start
    expect(elapsedMs).toBeLessThan(1000)
    expect(result.ok).toBe(false)
    expect(result).toMatchObject({
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].pattern' })])
    })
  })

  it.each(['^(a|a?)+$', '^(a|a)+$'])(
    'rejects the overlapping-alternation pattern %s promptly instead of hanging',
    (pattern) => {
      const start = performance.now()
      const result = validateAskSpec(specOf(textQuestion({ pattern })))
      const elapsedMs = performance.now() - start
      expect(elapsedMs).toBeLessThan(1000)
      expect(result.ok).toBe(false)
      expect(result).toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].pattern' })])
      })
    }
  )

  it('rejects a pattern longer than the length cap', () => {
    const result = validateAskSpec(specOf(textQuestion({ pattern: `^${'a'.repeat(201)}$` })))
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].pattern' })])
    })
  })

  it('still accepts an ordinary, non-nested pattern', () => {
    const result = validateAskSpec(specOf(textQuestion({ pattern: '^[a-z]+$', default: 'ok' })))
    expect(result.ok).toBe(true)
  })
})

describe('validateAskSpec — reserved ids and duplicate options', () => {
  it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
    'rejects question id %s',
    (id) => {
      expect(validateAskSpec(specOf(textQuestion({ id }))).ok).toBe(false)
    }
  )

  it('rejects duplicate option values', () => {
    const result = validateAskSpec(
      specOf(
        selectQuestion({
          options: [
            { value: 'a', label: 'A' },
            { value: 'a', label: 'A again' }
          ]
        })
      )
    )
    expect(result.ok).toBe(false)
  })
})

describe('validateAskSpec — credential refusal', () => {
  it.each([
    ['id', textQuestion({ id: 'db-password' })],
    ['question text', textQuestion({ question: "What's the access token?" })],
    ['option value', selectQuestion({ options: [{ value: 'secret-value', label: 'A' }] })]
  ])('rejects a credential-shaped %s', (_label, question) => {
    const result = validateAskSpec(specOf(question))
    expect(result.ok).toBe(false)
  })

  it.each(['db_password', 'auth_token', 'user_secret', 'my_api_key', 'my_private_key', 'apiKey'])(
    'rejects previously-missed credential-shaped id %s',
    (id) => {
      const result = validateAskSpec(specOf(textQuestion({ id })))
      expect(result.ok).toBe(false)
    }
  )

  it.each(['password', 'api_key', 'db-password', 'secret', 'token', 'private_key'])(
    'still rejects credential-shaped id %s (no regression)',
    (id) => {
      const result = validateAskSpec(specOf(textQuestion({ id })))
      expect(result.ok).toBe(false)
    }
  )

  it.each(['DBPassword', 'SECRETKey', 'MYSECRET', 'XPassword', 'DBpassword', 'secretkey'])(
    'rejects acronym/all-caps credential-shaped id %s (X1)',
    (id) => {
      const result = validateAskSpec(specOf(textQuestion({ id })))
      expect(result.ok).toBe(false)
    }
  )

  it.each(['tokenize_input', 'db_engine', 'pool_size', 'secretary_name', 'tokens_per_page'])(
    'does not over-refuse id %s (X1)',
    (id) => {
      const result = validateAskSpec(specOf(textQuestion({ id })))
      expect(result.ok).toBe(true)
    }
  )

  it.each([
    'Should the tests pass before merge?',
    'What token budget should we use?',
    'Enable pass-through proxy?'
  ])('accepts ordinary question text: %s', (question) => {
    expect(validateAskSpec(specOf(textQuestion({ question }))).ok).toBe(true)
  })

  it.each(["What's your GitHub token?", 'Paste the bearer token', 'What is the client secret?'])(
    'rejects credential question text: %s',
    (question) => {
      expect(validateAskSpec(specOf(textQuestion({ question }))).ok).toBe(false)
    }
  )

  it.each(['authToken', 'db_password', 'MYAPIKEY'])('still rejects id %s', (id) => {
    expect(validateAskSpec(specOf(textQuestion({ id }))).ok).toBe(false)
  })

  it('does not treat bare pass as a credential in ids or option values', () => {
    expect(validateAskSpec(specOf(textQuestion({ id: 'pass_rate' }))).ok).toBe(true)
    expect(
      validateAskSpec(specOf(selectQuestion({ options: [{ value: 'pass', label: 'Pass' }] }))).ok
    ).toBe(true)
  })

  it('accepts an id where a trigger word is a strict prefix of a longer word', () => {
    const result = validateAskSpec(specOf(textQuestion({ id: 'tokenize_input' })))
    expect(result.ok).toBe(true)
  })

  it('normalizes question text before matching, catching prefixed snake_case', () => {
    const result = validateAskSpec(specOf(textQuestion({ question: 'What is the db_password?' })))
    expect(result.ok).toBe(false)
  })

  it('normalizes option values before matching, catching prefixed snake_case', () => {
    const result = validateAskSpec(
      specOf(selectQuestion({ options: [{ value: 'my_api_key', label: 'A' }] }))
    )
    expect(result.ok).toBe(false)
  })

  it.each(['masked', 'sensitive'])(
    'rejects any %s attribute on a question regardless of its value',
    (attribute) => {
      const withTrue = validateAskSpec(specOf(textQuestion({ [attribute]: true })))
      const withFalse = validateAskSpec(specOf(textQuestion({ [attribute]: false })))
      expect(withTrue.ok).toBe(false)
      expect(withFalse.ok).toBe(false)
    }
  )
})

describe('validateAskSpec — escape-hatch invariants', () => {
  it.each([true, false, undefined])(
    'accepts an option question with required=%s with no opt-in for free text or skip',
    (required) => {
      const question = selectQuestion(required === undefined ? {} : { required })
      const result = validateAskSpec(specOf(question))
      expect(result.ok).toBe(true)
    }
  )

  it('has no schema field capable of disabling the free-text or skip escape hatch', () => {
    // required is the only knob the schema exposes; there is no allowOther/skippable field to
    // strip, so attempting one is inert rather than an error.
    const result = validateAskSpec(
      specOf(selectQuestion({ required: true, allowOther: false, skippable: false }))
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.questions[0]).not.toHaveProperty('allowOther')
      expect(result.spec.questions[0]).not.toHaveProperty('skippable')
    }
  })
})

describe('AskEnvelope — pending variant', () => {
  it('carries only askId and an instruction, never answers/skipped/summary', () => {
    const pending: AskPendingEnvelope = {
      status: 'pending',
      askId: 'ask_01J',
      instruction: 'run `quirky ask wait --id ask_01J`'
    }
    expect(pending).not.toHaveProperty('answers')
    expect(pending).not.toHaveProperty('skipped')
    expect(pending).not.toHaveProperty('summary')
    expect(isTerminalAskEnvelope(pending)).toBe(false)
  })
})

describe('isTerminalAskStatus', () => {
  it.each<[AskStatus, boolean]>([
    ['registered', false],
    ['pending', false],
    ['answered', true],
    ['partial', true],
    ['declined', true],
    ['timed_out', true],
    ['unavailable', true]
  ])('%s is terminal: %s', (status, expected) => {
    expect(isTerminalAskStatus(status)).toBe(expected)
  })
})
