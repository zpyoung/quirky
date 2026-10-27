import { describe, expect, test } from 'bun:test'
import {
  MAX_ASK_OPTIONS,
  MAX_ASK_QUESTIONS,
  formatSpecErrors,
  validateAskSpec
} from '../../src/core/spec'

const REFUSE = { checkCredentialText: true }
const SKIP_TEXT_CHECK = { checkCredentialText: false }

const validate = (raw: unknown) => validateAskSpec(raw, REFUSE)

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

const specOf = (...questions: unknown[]) => ({ questions })

/** The `formatSpecErrors` text of a refused spec, or the string 'ok' when it was accepted. */
function messageOf(raw: unknown, options = REFUSE): string {
  const result = validateAskSpec(raw, options)
  return result.ok ? 'ok' : formatSpecErrors(result.errors)
}

describe('validateAskSpec: malformed input', () => {
  test('never throws and rejects non-objects', () => {
    for (const input of [null, undefined, 42, 'not an object', true, []]) {
      expect(() => validate(input)).not.toThrow()
      expect(validate(input).ok).toBe(false)
    }
  })

  test('rejects a spec whose questions field is not an array', () => {
    expect(validate({ questions: 'nope' })).toEqual({
      ok: false,
      errors: [{ path: 'questions', message: 'questions must be an array' }]
    })
  })

  test('rejects a non-string title next to the question errors', () => {
    expect(messageOf({ title: 3, questions: 'nope' })).toBe(
      'title: title must be a string; questions: questions must be an array'
    )
  })
})

describe('validateAskSpec: limits', () => {
  test('exports the limits', () => {
    expect(MAX_ASK_QUESTIONS).toBe(10)
    expect(MAX_ASK_OPTIONS).toBe(12)
  })

  test('accepts up to 10 questions', () => {
    const questions = Array.from({ length: 10 }, (_, i) => textQuestion({ id: `q${i}` }))
    expect(validate(specOf(...questions)).ok).toBe(true)
  })

  test('rejects more than 10 questions', () => {
    const questions = Array.from({ length: 11 }, (_, i) => textQuestion({ id: `q${i}` }))
    expect(validate(specOf(...questions))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([{ path: 'questions', message: 'at most 10 questions allowed' }])
    })
  })

  test('accepts up to 12 options', () => {
    const options = Array.from({ length: 12 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))
    expect(validate(specOf(selectQuestion({ options }))).ok).toBe(true)
  })

  test('rejects more than 12 options, naming the field path', () => {
    const options = Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))
    expect(validate(specOf(selectQuestion({ options })))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[0].options', message: 'at most 12 options allowed' }
      ])
    })
  })
})

describe('validateAskSpec: reserved ids', () => {
  test.each(['__proto__', 'constructor', 'prototype'])('refuses the question id %s', (id) => {
    expect(validate(specOf(textQuestion({ id })))).toMatchObject({
      ok: false,
      errors: [
        { path: 'questions[0].id', message: 'id must not be __proto__, constructor or prototype' }
      ]
    })
  })

  test('refuses a reserved id even when credential text checks are off', () => {
    expect(validateAskSpec(specOf(textQuestion({ id: '__proto__' })), SKIP_TEXT_CHECK).ok).toBe(false)
  })
})

describe('validateAskSpec: id uniqueness', () => {
  test('rejects a blank id', () => {
    expect(validate(specOf(textQuestion({ id: '' })))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[0].id', message: 'id is required and must be a non-empty string' }
      ])
    })
  })

  test('rejects duplicate ids and names the second occurrence', () => {
    expect(validate(specOf(textQuestion({ id: 'dup' }), numberQuestion({ id: 'dup' })))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        { path: 'questions[1].id', message: "duplicate question id 'dup'" }
      ])
    })
  })
})

describe('validateAskSpec: per-type default domain', () => {
  test.each([
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
    ['number: non-integer when integer required', numberQuestion({ integer: true, default: 1.5 }), false],
    ['date: valid ISO date', dateQuestion({ default: '2026-01-01' }), true],
    ['date: non-ISO date', dateQuestion({ default: '01/01/2026' }), false],
    ['date: last day of a short month', dateQuestion({ default: '2026-02-28' }), true],
    ['date: impossible calendar date', dateQuestion({ default: '2026-02-30' }), false],
    ['date: day rolls into a different month', dateQuestion({ default: '2026-04-31' }), false],
    ['date: month out of range', dateQuestion({ default: '2026-13-01' }), false],
    ['confirm: boolean default', confirmQuestion({ default: true }), true],
    ['confirm: non-boolean default', confirmQuestion({ default: 'yes' }), false]
  ])('%s', (_label, question, expectOk) => {
    const result = validate(specOf(question))
    expect(result.ok).toBe(expectOk)
    if (!expectOk) {
      expect(result).toMatchObject({
        errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].default' })])
      })
    }
  })

  test('names a default error at a non-zero index', () => {
    expect(validate(specOf(textQuestion(), numberQuestion({ default: 500 })))).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[1].default' })])
    })
  })

  test('refuses a default below min, a url default that is not a url and a long default under a pattern', () => {
    expect(messageOf(specOf(numberQuestion({ default: 0 })))).toBe('questions[0].default: default is below min')
    expect(messageOf(specOf(textQuestion({ format: 'url', default: 'nope' })))).toBe(
      'questions[0].default: default is not a valid url'
    )
    expect(messageOf(specOf(textQuestion({ pattern: '^a+$', default: 'a'.repeat(201) })))).toBe(
      'questions[0].default: default must be at most 200 characters when pattern is set'
    )
  })
})

describe('validateAskSpec: pattern safety', () => {
  test('rejects a nested-quantifier pattern promptly instead of hanging', () => {
    const start = performance.now()
    const result = validate(specOf(textQuestion({ pattern: '^(a+)+$', default: `${'a'.repeat(29)}!` })))
    expect(performance.now() - start).toBeLessThan(1000)
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].pattern' })])
    })
  })

  test.each(['^(a|a?)+$', '^(a|a)+$'])('rejects the overlapping-alternation pattern %s promptly', (pattern) => {
    const start = performance.now()
    const result = validate(specOf(textQuestion({ pattern })))
    expect(performance.now() - start).toBeLessThan(1000)
    expect(result).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.objectContaining({ path: 'questions[0].pattern' })])
    })
  })

  test('rejects a pattern longer than the length cap', () => {
    expect(messageOf(specOf(textQuestion({ pattern: `^${'a'.repeat(201)}$` })))).toBe(
      'questions[0].pattern: pattern must be at most 200 characters'
    )
  })

  test('rejects a pattern with more than 3 variable quantifiers', () => {
    expect(validate(specOf(textQuestion({ pattern: 'a?'.repeat(4) }))).ok).toBe(false)
    expect(messageOf(specOf(textQuestion({ pattern: '^a*a*a*a*a*a*a*a*a*b$' })))).toBe(
      'questions[0].pattern: pattern must have at most 3 variable quantifiers; it can hang the regex engine'
    )
  })

  test.each(['a?a?a?', '^a{1,}b{2,3}c+$', '^\\d{4}-\\d{2}-\\d{2}$', '^a{2}b{3}c{4}d{5}e{6}$'])(
    'counts only variable quantifiers: accepts %s',
    (pattern) => {
      expect(validate(specOf(textQuestion({ pattern }))).ok).toBe(true)
    }
  )

  test('does not count a lazy modifier or a group prefix as a quantifier', () => {
    expect(validate(specOf(textQuestion({ pattern: '^(?:a+?)(?=b*)c*$' }))).ok).toBe(true)
  })

  test.each(['(a|aa)+b', '^(a|ab){2}$', '^((a|b)c)*$'])(
    'rejects a quantified group with alternatives: %s',
    (pattern) => {
      expect(messageOf(specOf(textQuestion({ pattern })))).toBe(
        'questions[0].pattern: pattern must not repeat a group with alternatives (e.g. (a|ab)+); it can hang the regex engine'
      )
    }
  )

  test.each(['^(https?|ftp)://', '^(a|b)?c$'])('still accepts alternation that is not repeated: %s', (pattern) => {
    expect(validate(specOf(textQuestion({ pattern }))).ok).toBe(true)
  })

  test.each(['^a*a*a*b$', '^a*a*a*$', 'a*a*a*b', '^(a?){3}b$', '^a?a?a?aaa$', '^[a-z]*[a-z]*[a-z]*!$'])(
    'validates the worst accepted pattern %s against a 200-character default in well under 100 ms',
    (pattern) => {
      const start = performance.now()
      const result = validate(specOf(textQuestion({ pattern, default: `${'a'.repeat(199)}c` })))
      expect(performance.now() - start).toBeLessThan(100)
      expect(result.ok).toBe(false)
      if (pattern === 'a*a*a*b') {
        if (result.ok) throw new Error('the default should not match')
        expect(result.errors).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              path: 'questions[0].default',
              message: 'default does not match pattern'
            })
          ])
        )
        expect(result.errors.some((error) => error.path === 'questions[0].pattern')).toBe(false)
        expect(validate(specOf(textQuestion({ pattern }))).ok).toBe(true)
      }
    }
  )

  test('counts backreferences against the quantifier budget', () => {
    const start = performance.now()
    const result = validate(
      specOf(textQuestion({ pattern: '(a*)(a*)(a*)\\1\\2\\3b', default: 'a'.repeat(200) }))
    )
    expect(performance.now() - start).toBeLessThan(100)
    expect(result.ok).toBe(false)
    expect(messageOf(specOf(textQuestion({ pattern: '(a*)(a*)(a*)\\1\\2\\3b' })))).toContain(
      'at most 3 variable quantifiers'
    )
    expect(validate(specOf(textQuestion({ pattern: '^(a*)\\1$' }))).ok).toBe(true)
  })

  test('keeps common patterns accepted', () => {
    for (const [pattern, def] of [
      ['^[a-z0-9-]+$', 'my-slug-1'],
      ['^\\d{4}-\\d{2}-\\d{2}$', '2026-10-26']
    ] as const) {
      expect(validate(specOf(textQuestion({ pattern, default: def }))).ok).toBe(true)
    }
  })

  test('rejects a pattern that is not a valid regular expression', () => {
    expect(messageOf(specOf(textQuestion({ pattern: '[' })))).toBe(
      'questions[0].pattern: pattern must be a valid regular expression'
    )
  })

  test('still accepts an ordinary, non-nested pattern', () => {
    expect(validate(specOf(textQuestion({ pattern: '^[a-z]+$', default: 'ok' }))).ok).toBe(true)
  })
})

describe('validateAskSpec: credential refusal', () => {
  test.each([
    ['id', textQuestion({ id: 'db-password' })],
    ['question text', textQuestion({ question: "What's the access token?" })],
    ['option value', selectQuestion({ options: [{ value: 'secret-value', label: 'A' }] })]
  ])('rejects a credential-shaped %s', (_label, question) => {
    expect(validate(specOf(question)).ok).toBe(false)
  })

  test.each(['db_password', 'auth_token', 'user_secret', 'my_api_key', 'my_private_key', 'apiKey'])(
    'rejects credential-shaped id %s',
    (id) => {
      expect(validate(specOf(textQuestion({ id }))).ok).toBe(false)
    }
  )

  test.each(['password', 'api_key', 'db-password', 'secret', 'token', 'private_key'])(
    'rejects plain credential id %s',
    (id) => {
      expect(validate(specOf(textQuestion({ id }))).ok).toBe(false)
    }
  )

  test.each(['DBPassword', 'SECRETKey', 'MYSECRET', 'XPassword', 'DBpassword', 'secretkey'])(
    'rejects acronym or all-caps credential-shaped id %s',
    (id) => {
      expect(validate(specOf(textQuestion({ id }))).ok).toBe(false)
    }
  )

  test.each(['tokenize_input', 'db_engine', 'pool_size', 'secretary_name', 'tokens_per_page'])(
    'does not over-refuse id %s',
    (id) => {
      expect(validate(specOf(textQuestion({ id }))).ok).toBe(true)
    }
  )

  test('normalizes question text before matching, catching prefixed snake_case', () => {
    expect(validate(specOf(textQuestion({ question: 'What is the db_password?' }))).ok).toBe(false)
  })

  test('normalizes option values before matching, catching prefixed snake_case', () => {
    expect(validate(specOf(selectQuestion({ options: [{ value: 'my_api_key', label: 'A' }] }))).ok).toBe(false)
  })

  test.each(['masked', 'sensitive'])('rejects any %s attribute regardless of its value', (attribute) => {
    expect(validate(specOf(textQuestion({ [attribute]: true }))).ok).toBe(false)
    expect(validate(specOf(textQuestion({ [attribute]: false }))).ok).toBe(false)
  })
})

describe('validateAskSpec: escape-hatch invariants', () => {
  test.each([true, false, undefined])('accepts an option question with required=%s', (required) => {
    const question = selectQuestion(required === undefined ? {} : { required })
    expect(validate(specOf(question)).ok).toBe(true)
  })

  test('inert allowOther and skippable fields are dropped, not refused', () => {
    const result = validate(specOf(selectQuestion({ required: true, allowOther: false, skippable: false })))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.spec.questions[0]).not.toHaveProperty('allowOther')
      expect(result.spec.questions[0]).not.toHaveProperty('skippable')
    }
  })
})

describe('validateAskSpec: canonical spec', () => {
  test('keeps known fields only and a string title', () => {
    const result = validate({
      title: 'Deploy',
      extra: 1,
      questions: [
        selectQuestion({
          header: 'DB',
          required: true,
          junk: 1,
          options: [{ value: 'postgres', label: 'PostgreSQL', description: 'fast', preview: { format: 'markdown', content: 'x' }, junk: 1 }]
        }),
        numberQuestion({ integer: true, default: 5 })
      ]
    })
    expect(result).toEqual({
      ok: true,
      spec: {
        title: 'Deploy',
        questions: [
          {
            id: 'db_engine',
            type: 'select',
            question: 'Which database?',
            header: 'DB',
            required: true,
            options: [{ value: 'postgres', label: 'PostgreSQL', description: 'fast', preview: { format: 'markdown', content: 'x' } }]
          },
          { id: 'pool_size', type: 'number', question: 'Pool size?', integer: true, min: 1, max: 100, default: 5 }
        ]
      }
    })
  })

  test('leaves title out when none was given', () => {
    const result = validate(specOf(confirmQuestion({ default: false })))
    expect(result).toEqual({
      ok: true,
      spec: { questions: [{ id: 'confirmed', type: 'confirm', question: 'Confirm?', default: false }] }
    })
    expect(JSON.stringify(result)).not.toContain('title')
  })

  test('reports a non-string title on the title path', () => {
    expect(messageOf({ title: 7, questions: [textQuestion()] })).toBe('title: title must be a string')
  })
})

describe('formatSpecErrors', () => {
  test('prints a root error without a path prefix', () => {
    expect(messageOf('nope')).toBe('ask spec must be an object')
  })
})

describe('SC-2 and SC-3 messages', () => {
  const options13 = Array.from({ length: 13 }, (_, i) => ({ value: `v${i}`, label: `L${i}` }))

  test('SC-2: every type-rule row is refused with its exact message', () => {
    const rows: [string, unknown, string][] = [
      ['min above max', specOf(numberQuestion({ min: 5, max: 1 })), 'questions[0].min: min must not exceed max'],
      [
        'fractional default for integer',
        specOf(numberQuestion({ integer: true, default: 2.5 })),
        'questions[0].default: default must be an integer'
      ],
      [
        'default above max',
        specOf(numberQuestion({ min: undefined, max: 10, default: 11 })),
        'questions[0].default: default is above max'
      ],
      [
        'impossible date default',
        specOf(dateQuestion({ default: '2026-02-30' })),
        'questions[0].default: default must be an ISO 8601 date (YYYY-MM-DD)'
      ],
      [
        'select default outside the options',
        specOf(selectQuestion({ default: 'staging' })),
        'questions[0].default: default must match one option value'
      ],
      [
        'nested quantifier',
        specOf(textQuestion({ pattern: '(a+)+' })),
        'questions[0].pattern: pattern must not nest repetition (e.g. (a+)+); it can hang the regex engine'
      ],
      [
        'default does not match pattern',
        specOf(textQuestion({ pattern: '^[a-z]+$', default: 'ABC' })),
        'questions[0].default: default does not match pattern'
      ],
      [
        'unknown format',
        specOf(textQuestion({ format: 'phone' })),
        "questions[0].format: format must be 'email' or 'url'"
      ],
      [
        'unknown type',
        specOf(textQuestion({ type: 'slider' })),
        'questions[0].type: type must be one of select | multiselect | text | number | date | confirm'
      ],
      ['no questions', specOf(), 'questions: at least one question is required'],
      [
        'eleven questions',
        specOf(...Array.from({ length: 11 }, (_, i) => textQuestion({ id: `q${i}` }))),
        'questions: at most 10 questions allowed'
      ],
      [
        'thirteen options',
        specOf(selectQuestion({ options: options13 })),
        'questions[0].options: at most 12 options allowed'
      ],
      [
        'duplicate id',
        specOf(textQuestion({ id: 'a' }), textQuestion({ id: 'a' })),
        "questions[1].id: duplicate question id 'a'"
      ]
    ]
    for (const [label, raw, message] of rows) {
      expect({ label, message: messageOf(raw) }).toEqual({ label, message })
    }
  })

  test('SC-2: a spec with two problems reports both, joined with "; ", in spec order', () => {
    expect(
      messageOf(specOf(numberQuestion({ min: 5, max: 1, default: 9 }), dateQuestion({ default: '2026-02-30' })))
    ).toBe(
      'questions[0].min: min must not exceed max; questions[0].default: default is above max; ' +
        'questions[1].default: default must be an ISO 8601 date (YYYY-MM-DD)'
    )
  })

  test('SC-3: every credential row is refused with its exact message', () => {
    const rows: [string, unknown, string][] = [
      [
        'credential id',
        specOf(textQuestion({ id: 'db_password' })),
        'questions[0].id: credential-shaped id is not permitted'
      ],
      [
        'pass in question text',
        specOf(textQuestion({ question: 'Which pass should we use?' })),
        'questions[0].question: credential-shaped question text is not permitted'
      ],
      [
        'API key in question text',
        specOf(textQuestion({ question: 'Paste your API key' })),
        'questions[0].question: credential-shaped question text is not permitted'
      ],
      [
        'credential option value',
        specOf(selectQuestion({ options: [{ value: 'MYSECRET', label: 'A' }] })),
        'questions[0].options[0].value: credential-shaped option value is not permitted'
      ],
      [
        'masked false',
        specOf(textQuestion({ masked: false })),
        'questions[0]: masked/sensitive input is not permitted; collect credentials out of band'
      ]
    ]
    for (const [label, raw, message] of rows) {
      expect({ label, message: messageOf(raw) }).toEqual({ label, message })
    }
  })

  test('SC-3: sensitive plus a credential id reports both messages joined with "; "', () => {
    expect(messageOf(specOf(textQuestion({ id: 'apiToken', sensitive: true })))).toBe(
      'questions[0]: masked/sensitive input is not permitted; collect credentials out of band; ' +
        'questions[0].id: credential-shaped id is not permitted'
    )
  })

  test('SC-3: header, option label, option description and default may say "API token"', () => {
    const result = validate(
      specOf(
        selectQuestion({
          header: 'API token',
          options: [
            { value: 'a', label: 'API token', description: 'The API token to use' },
            { value: 'b', label: 'B' }
          ],
          default: 'a'
        }),
        textQuestion({ default: 'API token' })
      )
    )
    expect(result.ok).toBe(true)
  })
})

describe('SC-4: checkCredentialText false', () => {
  test('SC-4: a plugin-registered confirm naming a token method is accepted', () => {
    const question = confirmQuestion({
      id: 'install_plugin',
      question: 'Install plugin acme.tokens (method acme.tokens/rotateToken)?'
    })
    expect(messageOf(specOf(question), REFUSE)).toBe(
      'questions[0].question: credential-shaped question text is not permitted'
    )
    expect(validateAskSpec(specOf(question), SKIP_TEXT_CHECK).ok).toBe(true)
  })

  test('SC-4: id, question text and option value checks are all skipped', () => {
    const raw = specOf(
      selectQuestion({
        id: 'db_password',
        question: 'Paste your API key',
        options: [{ value: 'MYSECRET', label: 'A' }]
      })
    )
    expect(validate(raw).ok).toBe(false)
    expect(validateAskSpec(raw, SKIP_TEXT_CHECK).ok).toBe(true)
  })

  test.each(['masked', 'sensitive'])('SC-4: %s is refused even when the text check is skipped', (attribute) => {
    expect(messageOf(specOf(confirmQuestion({ [attribute]: true })), SKIP_TEXT_CHECK)).toBe(
      'questions[0]: masked/sensitive input is not permitted; collect credentials out of band'
    )
  })

  test('SC-4: skipping the text check keeps every other rule', () => {
    expect(messageOf(specOf(textQuestion({ id: '' })), SKIP_TEXT_CHECK)).toBe(
      'questions[0].id: id is required and must be a non-empty string'
    )
  })
})
