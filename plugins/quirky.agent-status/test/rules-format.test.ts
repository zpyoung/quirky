import { describe, expect, test } from 'bun:test'
import { parseRuleData, parseRuleFile } from '../src/rules/format'
import { unsafePatternReason } from '../src/rules/safety'

const approval = {
  id: 'approval',
  state: 'blocked',
  kind: 'approval',
  region: 'screen',
  lastLines: 6,
  all: [{ contains: 'allow this?' }, { regex: '\\(y/n\\)\\s*$' }],
}
const busy = { id: 'busy', state: 'working', region: 'screen', all: [{ regex: 'esc to interrupt' }] }
const ready = { id: 'ready', state: 'idle', region: 'title', all: [{ regex: '^✳' }], quietMs: 1000 }

const file = (rules: unknown[], extra: Record<string, unknown> = {}) => JSON.stringify({ agent: 'fake', rules, ...extra })

function reasonOf(text: string, agent = 'fake'): string {
  const result = parseRuleFile(text, agent)
  if (result.ok) throw new Error('expected the file to be rejected')
  return result.reason
}

describe('rule file format', () => {
  test('SC-7: a file of ordered rules over the title or the screen is accepted', () => {
    const result = parseRuleFile(file([approval, busy, ready], { description: 'a fake agent' }), 'fake')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.file.agent).toBe('fake')
    expect(result.file.description).toBe('a fake agent')
    expect(result.file.rules.map((rule) => rule.id)).toEqual(['approval', 'busy', 'ready'])
    expect(result.file.rules[0]!.lastLines).toBe(6)
    expect(result.file.rules[2]!.quietMs).toBe(1000)
  })

  test('an empty rule list is a valid file', () => {
    expect(parseRuleFile(file([]), 'fake').ok).toBe(true)
  })

  test('a rule with only a none matcher is accepted', () => {
    expect(parseRuleFile(file([{ id: 'x', state: 'idle', region: 'screen', none: [{ contains: 'busy' }] }]), 'fake').ok).toBe(true)
  })

  test('SC-10 (a): text that is not JSON is rejected', () => {
    expect(reasonOf('{ nope')).toMatch(/not valid JSON/)
  })

  test('SC-10 (a): a JSON value that is not an object is rejected', () => {
    expect(reasonOf('[]')).toMatch(/must be an object/)
  })

  test('SC-10 (b): a file with no rules is rejected naming the field', () => {
    expect(reasonOf(JSON.stringify({ agent: 'fake' }))).toMatch(/rules/)
    expect(reasonOf(JSON.stringify({ agent: 'fake', rules: 'x' }))).toMatch(/rules.*array/)
  })

  test('SC-10 (c): a repeated variable group names the rule, the matcher and the reason', () => {
    const reason = reasonOf(file([{ id: 'loop', state: 'working', region: 'screen', all: [{ regex: '(a+)+$' }] }]))
    expect(reason).toContain('"loop"')
    expect(reason).toContain('all[0].regex')
    expect(reason).toContain('repeats a group that can match in more than one way')
  })

  test('SC-10 (d): a backreference is rejected', () => {
    const reason = reasonOf(file([{ id: 'ref', state: 'working', region: 'screen', all: [{ regex: '(x)\\1' }] }]))
    expect(reason).toContain('"ref"')
    expect(reason).toContain('uses a backreference')
  })

  test('SC-10 (e): an unknown state names the rule and the field', () => {
    const reason = reasonOf(file([{ id: 'nap', state: 'asleep', region: 'screen', all: [{ contains: 'z' }] }]))
    expect(reason).toContain('"nap"')
    expect(reason).toContain('state')
    expect(reason).toContain('asleep')
  })

  test('the none matchers are checked for unsafe patterns too', () => {
    const reason = reasonOf(file([{ id: 'n', state: 'idle', region: 'screen', all: [{ contains: 'a' }], none: [{ regex: '(a|aa)+' }] }]))
    expect(reason).toContain('none[0].regex')
  })

  test('an uncompilable regex is rejected', () => {
    expect(reasonOf(file([{ id: 'bad', state: 'idle', region: 'screen', all: [{ regex: '([a-z' }] }]))).toContain('does not compile')
  })

  const invalid: [string, Record<string, unknown>, RegExp][] = [
    ['an unknown rule field', { ...busy, colour: 'red' }, /"busy".*colour/],
    ['a non-string id', { ...busy, id: 7 }, /rules\[0\]\.id/],
    ['an id with a capital letter', { ...busy, id: 'Busy' }, /rules\[0\]\.id/],
    ['an id that is too long', { ...busy, id: 'a'.repeat(65) }, /rules\[0\]\.id/],
    ['a non-string why', { ...busy, why: 3 }, /"busy".*why/],
    ['a missing state', { id: 'busy', region: 'screen', all: [{ contains: 'x' }] }, /"busy".*state/],
    ['a missing region', { id: 'busy', state: 'working', all: [{ contains: 'x' }] }, /"busy".*region/],
    ['an unknown region', { ...busy, region: 'cursor' }, /"busy".*region/],
    ['a kind on a working rule', { ...busy, kind: 'approval' }, /"busy".*kind.*blocked/],
    ['an unknown kind', { ...approval, kind: 'dread' }, /"approval".*kind/],
    ['lastLines on a title rule', { ...ready, lastLines: 3 }, /"ready".*lastLines.*screen/],
    ['lastLines of zero', { ...approval, lastLines: 0 }, /"approval".*lastLines/],
    ['lastLines of 201', { ...approval, lastLines: 201 }, /"approval".*lastLines/],
    ['a fractional lastLines', { ...approval, lastLines: 2.5 }, /"approval".*lastLines/],
    ['a negative quietMs', { ...ready, quietMs: -1 }, /"ready".*quietMs/],
    ['a quietMs above 10000', { ...ready, quietMs: 10001 }, /"ready".*quietMs/],
    ['a string quietMs', { ...ready, quietMs: '10' }, /"ready".*quietMs/],
    ['no all or none', { id: 'busy', state: 'working', region: 'screen' }, /"busy".*all.*none/],
    ['empty all and none', { ...busy, all: [], none: [] }, /"busy".*all.*none/],
    ['an all that is not an array', { ...busy, all: { contains: 'x' } }, /"busy".*all/],
    ['a matcher with both regex and contains', { ...busy, all: [{ regex: 'a', contains: 'a' }] }, /all\[0\]/],
    ['a matcher with neither', { ...busy, all: [{}] }, /all\[0\]/],
    ['a matcher with an unknown field', { ...busy, all: [{ regex: 'a', flags: 'g' }] }, /all\[0\].*flags/],
    ['an ignoreCase on contains', { ...busy, all: [{ contains: 'a', ignoreCase: true }] }, /all\[0\]/],
    ['a non-boolean ignoreCase', { ...busy, all: [{ regex: 'a', ignoreCase: 'yes' }] }, /all\[0\]\.ignoreCase/],
    ['an empty contains', { ...busy, all: [{ contains: '' }] }, /all\[0\]\.contains/],
    ['an empty regex', { ...busy, all: [{ regex: '' }] }, /all\[0\]\.regex/],
    ['a lookbehind', { ...busy, all: [{ regex: '(?<=a)b' }] }, /uses a lookbehind/],
    ['a negative lookbehind', { ...busy, none: [{ regex: '(?<!a)b' }] }, /uses a lookbehind/],
    ['a named backreference', { ...busy, all: [{ regex: '(?<n>a)\\k<n>' }] }, /uses a backreference/],
    ['an over-long pattern', { ...busy, all: [{ regex: 'a'.repeat(513) }] }, /512/],
  ]
  for (const [name, rule, expected] of invalid) {
    test(`SC-10: ${name} invalidates the whole file`, () => {
      expect(reasonOf(file([rule]))).toMatch(expected)
    })
  }

  test('SC-10: a duplicate id names the second rule', () => {
    expect(reasonOf(file([busy, { ...ready, id: 'busy' }]))).toMatch(/"busy".*duplicate/)
  })

  test('SC-10: an unknown top-level field is rejected', () => {
    expect(reasonOf(file([busy], { version: 2 }))).toMatch(/version/)
  })

  test('SC-10: an agent that differs from the expected one is rejected', () => {
    expect(reasonOf(file([busy]), 'other')).toMatch(/agent.*"fake".*"other"/)
  })

  test('SC-10: a missing agent is rejected', () => {
    expect(reasonOf(JSON.stringify({ rules: [] }))).toMatch(/agent/)
  })

  test('the first problem is reported, not a list', () => {
    expect(reasonOf(file([{ ...busy, state: 'asleep' }, { ...busy, id: 'other', state: 'asleep' }])).split('\n')).toHaveLength(1)
  })
})

describe('contribution data', () => {
  test('SC-11: rules and an optional description are accepted without an agent field', () => {
    const result = parseRuleData({ rules: [busy], description: 'aider' }, 'aider')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.file).toEqual({ agent: 'aider', description: 'aider', rules: [busy] as never })
  })

  test('an agent field must equal the contribution name', () => {
    expect(parseRuleData({ agent: 'aider', rules: [] }, 'aider').ok).toBe(true)
    const result = parseRuleData({ agent: 'other', rules: [] }, 'aider')
    expect(result.ok).toBe(false)
  })

  test('an invalid rule is rejected with the same reasons as a file', () => {
    const result = parseRuleData({ rules: [{ ...busy, all: [{ regex: '(a+)+$' }] }] }, 'aider')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain('repeats a group')
  })

  test('missing rules is rejected', () => {
    expect(parseRuleData({}, 'aider').ok).toBe(false)
  })
})

describe('pattern safety', () => {
  const unsafe: [string, string][] = [
    ['(a+)+$', 'repeats a group'],
    ['(a*)*', 'repeats a group'],
    ['(a|aa)+', 'repeats a group'],
    ['(a?){2,}', 'repeats a group'],
    ['((a+))*b', 'repeats a group'],
    ['(x)\\1', 'backreference'],
    ['(?<n>x)\\k<n>', 'backreference'],
    ['(?<=a)b', 'lookbehind'],
    ['(?<!a)b', 'lookbehind'],
    ['([a-z', 'does not compile'],
    ['a'.repeat(513), '512'],
  ]
  for (const [pattern, expected] of unsafe) {
    test(`rejects ${pattern.length > 40 ? 'an over-long pattern' : pattern}`, () => {
      expect(unsafePatternReason(pattern)).toContain(expected)
    })
  }

  const safe = ['\\(y/n\\)\\s*$', 'esc to interrupt', '^\\s*[>❯]\\s', '(yes|no)', '(a+)', '(?:a|b)c', '[(a+)+]', '\\(a+\\)+', 'a+a+', '(foo)?bar', 'a'.repeat(512)]
  for (const pattern of safe) {
    test(`accepts ${pattern.length > 40 ? 'a pattern of exactly 512 characters' : pattern}`, () => {
      expect(unsafePatternReason(pattern)).toBeNull()
    })
  }

  test('a lookahead is not a lookbehind', () => {
    expect(unsafePatternReason('a(?=b)')).toBeNull()
    expect(unsafePatternReason('a(?!b)')).toBeNull()
  })
})
