import { describe, expect, test } from 'bun:test'
import type { AskAnswer, AskQuestion, AskSpec } from '@quirky/protocol'
import {
  buildSummary,
  parseDateAnswerValue,
  parseNumberAnswerValue,
  parseTextAnswerValue,
  validateAnswerSubmission
} from '../../src/core/answers'

type TextQuestion = Extract<AskQuestion, { type: 'text' }>
type NumberQuestion = Extract<AskQuestion, { type: 'number' }>

const deploy: AskSpec = {
  title: 'Deploy',
  questions: [
    {
      id: 'env',
      type: 'select',
      question: 'Which environment?',
      required: true,
      options: [
        { value: 'prod', label: 'Prod' },
        { value: 'dev', label: 'Dev' }
      ],
      default: 'dev'
    },
    { id: 'replicas', type: 'number', question: 'How many replicas?', integer: true, min: 1, max: 10 },
    { id: 'ship', type: 'date', question: 'Ship date?', header: 'Ship' },
    { id: 'go', type: 'confirm', question: 'Go ahead?', default: true }
  ]
}

const frameworks: AskSpec = {
  questions: [
    {
      id: 'framework',
      type: 'select',
      question: 'Framework?',
      options: [
        { value: 'react', label: 'React' },
        { value: 'vue', label: 'Vue' }
      ]
    },
    {
      id: 'features',
      type: 'multiselect',
      question: 'Features?',
      options: [
        { value: 'auth', label: 'Auth' },
        { value: 'search', label: 'Search' },
        { value: 'billing', label: 'Billing' }
      ]
    }
  ]
}

function expectRefused(spec: AskSpec, answers: unknown, skipped: unknown, fragment: string) {
  const result = validateAnswerSubmission(spec, answers, skipped)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.message).toContain(fragment)
}

describe('parseTextAnswerValue', () => {
  const base: TextQuestion = { id: 'q', type: 'text', question: 'Q?' }

  test('accepts any text when no pattern or format is set', () => {
    expect(parseTextAnswerValue(base, 'anything')).toBe('anything')
  })

  test('rejects text that fails the pattern', () => {
    const question: TextQuestion = { ...base, pattern: '^[a-z]+$' }
    expect(parseTextAnswerValue(question, 'ABC')).toBeNull()
    expect(parseTextAnswerValue(question, 'abc')).toBe('abc')
  })

  test('rejects an answer missing a required literal in a long pattern input', () => {
    const question: TextQuestion = { ...base, pattern: '^a*a*a*b$' }
    expect(parseTextAnswerValue(question, `${'a'.repeat(199)}c`)).toBeNull()
  })


  test('rejects text that fails the format', () => {
    const question: TextQuestion = { ...base, format: 'email' }
    expect(parseTextAnswerValue(question, 'not-an-email')).toBeNull()
    expect(parseTextAnswerValue(question, 'a@b.com')).toBe('a@b.com')
  })

  test('rejects an answer longer than the pattern test-input bound without running the regex', () => {
    const question: TextQuestion = { ...base, pattern: '^[a-z]+$' }
    expect(parseTextAnswerValue(question, 'a'.repeat(201))).toBeNull()
    expect(parseTextAnswerValue(question, 'a'.repeat(200))).toBe('a'.repeat(200))
  })

  test('rejects text when the stored pattern does not compile', () => {
    expect(parseTextAnswerValue({ ...base, pattern: '(' }, 'x')).toBeNull()
  })
})

describe('parseNumberAnswerValue', () => {
  const base: NumberQuestion = { id: 'q', type: 'number', question: 'Q?' }

  test('rejects non-numeric text', () => {
    expect(parseNumberAnswerValue(base, 'abc')).toBeNull()
    expect(parseNumberAnswerValue(base, 'Infinity')).toBeNull()
  })

  test('enforces integer', () => {
    const question: NumberQuestion = { ...base, integer: true }
    expect(parseNumberAnswerValue(question, '1.5')).toBeNull()
    expect(parseNumberAnswerValue(question, '2')).toBe(2)
  })

  test('enforces min and max', () => {
    const question: NumberQuestion = { ...base, min: 1, max: 10 }
    expect(parseNumberAnswerValue(question, '0')).toBeNull()
    expect(parseNumberAnswerValue(question, '11')).toBeNull()
    expect(parseNumberAnswerValue(question, '5')).toBe(5)
  })
})

describe('parseDateAnswerValue', () => {
  test('accepts a real calendar date', () => {
    expect(parseDateAnswerValue('2026-08-23')).toBe('2026-08-23')
  })

  test('rejects a malformed or non-existent date', () => {
    expect(parseDateAnswerValue('2026/08/23')).toBeNull()
    expect(parseDateAnswerValue('2026-02-30')).toBeNull()
  })
})

describe('buildSummary', () => {
  const spec: AskSpec = {
    questions: [
      { id: 'db', type: 'select', question: 'Which database?', header: 'Database', options: [{ value: 'pg', label: 'Postgres' }] },
      { id: 'pool', type: 'number', question: 'Pool size?' },
      {
        id: 'tags',
        type: 'multiselect',
        question: 'Tags?',
        options: [
          { value: 'a', label: 'A' },
          { value: 'b', label: 'B' }
        ]
      },
      { id: 'ready', type: 'confirm', question: 'Ready?' }
    ]
  }

  test('renders one line per answered question in spec order and skips unanswered ones', () => {
    const answers: Record<string, AskAnswer> = {
      ready: { value: true, source: 'input' },
      db: { value: 'pg', label: 'Postgres', source: 'option' },
      pool: { value: 20, source: 'input' }
    }
    expect(buildSummary(spec, answers)).toBe('Database: Postgres\nPool size?: 20\nReady?: Yes')
  })

  test('renders a select other answer by its text and a multiselect with its other remainder', () => {
    const answers: Record<string, AskAnswer> = {
      db: { value: 'sqlite', source: 'other' },
      tags: { values: ['a'], labels: ['A'], other: 'c', source: 'options' }
    }
    expect(buildSummary(spec, answers)).toBe('Database: sqlite\nTags?: A, c')
  })

  test('renders No for false and an empty string when nothing was answered', () => {
    expect(buildSummary(spec, { ready: { value: false, source: 'input' } })).toBe('Ready?: No')
    expect(buildSummary(spec, {})).toBe('')
  })
})

describe('validateAnswerSubmission', () => {
  test('SC-1: answers come back typed, rebuilt from the spec, with the exact summary', () => {
    const result = validateAnswerSubmission(
      deploy,
      {
        env: { value: 'prod', source: 'option' },
        replicas: { value: 3, source: 'input' },
        ship: { value: '2026-11-02', source: 'input' },
        go: { value: true, source: 'input' }
      },
      []
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.answers).toEqual({
      env: { value: 'prod', label: 'Prod', source: 'option' },
      replicas: { value: 3, source: 'input' },
      ship: { value: '2026-11-02', source: 'input' },
      go: { value: true, source: 'input' }
    })
    expect(result.skipped).toEqual([])
    expect(buildSummary(deploy, result.answers)).toBe(
      'Which environment?: Prod\nHow many replicas?: 3\nShip: 2026-11-02\nGo ahead?: Yes'
    )
  })

  test('SC-1: a caller-supplied label is replaced by the spec label', () => {
    const result = validateAnswerSubmission(
      frameworks,
      { framework: { value: 'vue', label: 'Forged', source: 'option' } },
      []
    )
    expect(result.ok && result.answers.framework).toEqual({ value: 'vue', label: 'Vue', source: 'option' })
  })

  describe('SC-5: refused answers name the question', () => {
    const answered = {
      env: { value: 'prod', source: 'option' },
      replicas: { value: 2, source: 'input' },
      ship: { value: '2026-11-02', source: 'input' },
      go: { value: true, source: 'input' }
    }

    test('a select value that is not an option', () => {
      expectRefused(deploy, { ...answered, env: { value: 'staging', source: 'option' } }, [], 'answers.env: ')
    })

    test('a number below min', () => {
      expectRefused(deploy, { ...answered, replicas: { value: 0, source: 'input' } }, [], 'answers.replicas: value is outside the question domain')
    })

    test('a number above max', () => {
      expectRefused(deploy, { ...answered, replicas: { value: 11, source: 'input' } }, [], 'answers.replicas: value is outside the question domain')
    })

    test('a fractional number for an integer question', () => {
      expectRefused(deploy, { ...answered, replicas: { value: 2.5, source: 'input' } }, [], 'answers.replicas: value is outside the question domain')
    })

    test('a number sent as text', () => {
      expectRefused(deploy, { ...answered, replicas: { value: '3', source: 'input' } }, [], 'answers.replicas: value is outside the question domain')
    })

    test('a date that does not exist', () => {
      expectRefused(
        deploy,
        { ...answered, ship: { value: '2026-02-30', source: 'input' } },
        [],
        'answers.ship: value must be an ISO 8601 calendar date'
      )
    })

    test('a confirm that is not a boolean', () => {
      expectRefused(deploy, { ...answered, go: { value: 'yes', source: 'input' } }, [], 'answers.go: value must be a boolean')
    })

    test('a required question listed in skipped', () => {
      const { env: _env, ...rest } = answered
      expectRefused(deploy, rest, ['env'], 'skipped: env is required and cannot be skipped')
    })

    test('a question both answered and skipped', () => {
      expectRefused(deploy, answered, ['go'], 'skipped: go is both answered and skipped')
    })

    test('an answer for an unknown question', () => {
      expectRefused(deploy, { ...answered, color: { value: 'red', source: 'input' } }, [], 'answers.color: unknown question id')
    })

    test('a skipped id that is not a question', () => {
      expectRefused(deploy, answered, ['color'], 'skipped: color is not a known question id')
    })

    test('an answer that is not an object', () => {
      expectRefused(deploy, { ...answered, go: true }, [], 'answers.go: answer must be an object')
    })

    test('answers that are not an object, and skipped that is not a string list', () => {
      expectRefused(deploy, [], [], 'answers: must be an object')
      expectRefused(deploy, answered, 'go', 'skipped: must be an array of strings')
      expectRefused(deploy, answered, [3], 'skipped: must be an array of strings')
    })

    test('a caller-supplied source of default', () => {
      expectRefused(deploy, { ...answered, go: { value: true, source: 'default' } }, [], 'answers.go: ')
    })

    test('every problem is reported, joined with a semicolon, in one message', () => {
      const result = validateAnswerSubmission(
        deploy,
        { ...answered, env: { value: 'staging', source: 'option' }, replicas: { value: 0, source: 'input' } },
        []
      )
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.message.split('; ')).toHaveLength(2)
        expect(result.message.indexOf('answers.env')).toBeLessThan(result.message.indexOf('answers.replicas'))
      }
    })

    test('accepted: env and go only, with the rest recorded as skipped', () => {
      const result = validateAnswerSubmission(
        deploy,
        { env: { value: 'prod', source: 'option' }, go: { value: false, source: 'input' } },
        []
      )
      expect(result).toEqual({
        ok: true,
        answers: {
          env: { value: 'prod', label: 'Prod', source: 'option' },
          go: { value: false, source: 'input' }
        },
        skipped: ['replicas', 'ship']
      })
    })
  })

  describe('SC-6: select and multiselect shapes', () => {
    test('a picked option keeps its note, and the note is left out of the summary', () => {
      const result = validateAnswerSubmission(
        frameworks,
        {
          framework: { value: 'vue', note: 'small bundle size', source: 'option' },
          features: { values: ['auth', 'search'], other: 'Exports', source: 'options' }
        },
        []
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.answers).toEqual({
        framework: { value: 'vue', label: 'Vue', note: 'small bundle size', source: 'option' },
        features: { values: ['auth', 'search'], labels: ['Auth', 'Search'], other: 'Exports', source: 'options' }
      })
      expect(buildSummary(frameworks, result.answers)).toBe('Framework?: Vue\nFeatures?: Auth, Search, Exports')
    })

    test('free text with nothing picked becomes the answer itself', () => {
      const result = validateAnswerSubmission(frameworks, { framework: { value: 'Svelte', source: 'other' } }, [])
      expect(result.ok && result.answers.framework).toEqual({ value: 'Svelte', source: 'other' })
    })

    test('free text must not be blank', () => {
      expectRefused(frameworks, { framework: { value: '  ', source: 'other' } }, [], 'answers.framework: free-text value must be a non-empty string')
    })

    test('a blank note or other is dropped', () => {
      const result = validateAnswerSubmission(
        frameworks,
        {
          framework: { value: 'react', note: '   ', source: 'option' },
          features: { values: ['auth'], other: '', source: 'options' }
        },
        []
      )
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(result.answers.framework).not.toHaveProperty('note')
      expect(result.answers.features).not.toHaveProperty('other')
    })

    test('multiselect values must be strings that are options', () => {
      expectRefused(frameworks, { features: { values: 'auth', source: 'options' } }, ['framework'], 'answers.features: values must be an array of strings')
      expectRefused(frameworks, { features: { values: ['auth', 'nope'], source: 'options' } }, ['framework'], 'answers.features: nope is not one of the question options')
    })

    test('repeated multiselect values are kept once', () => {
      const result = validateAnswerSubmission(frameworks, { features: { values: ['auth', 'auth'], source: 'options' } }, ['framework'])
      expect(result.ok && result.answers.features).toEqual({ values: ['auth'], labels: ['Auth'], source: 'options' })
    })
  })

  test('SC-7: default never fills a blank answer on submit', () => {
    const result = validateAnswerSubmission(
      deploy,
      { env: { value: 'prod', source: 'option' }, replicas: { value: 2, source: 'input' } },
      ['ship', 'go']
    )
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.skipped).toEqual(['ship', 'go'])
    expect(Object.values(result.answers).some((answer) => answer.source === 'default')).toBe(false)
  })

  describe('omitted questions', () => {
    const textSpec: AskSpec = {
      questions: [
        { id: 'q1', type: 'text', question: 'Q1?' },
        { id: 'q2', type: 'number', question: 'Q2?', min: 0, max: 10 },
        { id: 'q3', type: 'text', question: 'Q3?' }
      ]
    }

    test('are appended to skipped in spec order after the ones the caller listed', () => {
      const result = validateAnswerSubmission(textSpec, { q2: { value: 4, source: 'input' } }, ['q3'])
      expect(result).toEqual({ ok: true, answers: { q2: { value: 4, source: 'input' } }, skipped: ['q3', 'q1'] })
    })

    test('a listed id repeated is kept once', () => {
      const result = validateAnswerSubmission(textSpec, { q1: { value: 'a', source: 'input' }, q2: { value: 1, source: 'input' } }, ['q3', 'q3'])
      expect(result.ok && result.skipped).toEqual(['q3'])
    })

    test('a required one is an error', () => {
      expectRefused(deploy, { go: { value: true, source: 'input' } }, [], 'answers.env: question was neither answered nor skipped')
    })

    test('a missing skipped is the same as an empty one', () => {
      const result = validateAnswerSubmission(textSpec, { q1: { value: 'a', source: 'input' } }, undefined)
      expect(result.ok && result.skipped).toEqual(['q2', 'q3'])
    })
  })

  test('text answers are checked against pattern and format and rebuilt with source input', () => {
    const spec: AskSpec = { questions: [{ id: 'mail', type: 'text', question: 'Mail?', format: 'email' }] }
    expectRefused(spec, { mail: { value: 'nope', source: 'input' } }, [], 'answers.mail: value does not match the question pattern/format')
    expect(validateAnswerSubmission(spec, { mail: { value: 'a@b.co', source: 'input' } }, [])).toEqual({
      ok: true,
      answers: { mail: { value: 'a@b.co', source: 'input' } },
      skipped: []
    })
  })

  test('rejects a select value outside the options unless it is declared other', () => {
    expectRefused(frameworks, { framework: { value: 'z', source: 'option' } }, ['features'], 'answers.framework: value must be one of the question options')
  })
})
