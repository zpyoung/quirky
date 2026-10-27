import { describe, expect, test } from 'bun:test'
import { parseRuleFile } from '../src/rules/format'
import { evaluate, findLine } from '../src/rules/match'
import type { Origin, Rule, RuleFile } from '../src/rules/types'

const origin: Origin = { kind: 'built-in', path: '/rules/fake.json' }

const approval: Rule = {
  id: 'approval',
  state: 'blocked',
  kind: 'approval',
  region: 'screen',
  lastLines: 6,
  all: [{ contains: 'allow this?' }, { regex: '\\(y/n\\)\\s*$' }],
}
const busy: Rule = { id: 'busy', state: 'working', region: 'screen', all: [{ regex: 'esc to interrupt' }] }
const ready: Rule = { id: 'ready', state: 'idle', region: 'title', all: [{ regex: '^✳' }], quietMs: 1000 }

const fileOf = (...rules: Rule[]): RuleFile => ({ agent: 'fake', rules })
const run = (file: RuleFile, input: { title?: string; lines?: string[]; quietForMs?: number | null }) =>
  evaluate(file, { title: input.title ?? '', lines: input.lines ?? [], quietForMs: input.quietForMs ?? null }, origin)

describe('evaluate: the SC-7 file', () => {
  const file = fileOf(approval, busy, ready)

  test('SC-7 (a): an approval on the last line beats working text above it', () => {
    const { verdict } = run(file, { lines: ['esc to interrupt', 'Allow this? (y/n)'] })
    expect(verdict).toEqual({ rule: 'approval', state: 'blocked', kind: 'approval', origin })
  })

  test('SC-7 (b): working text alone is working', () => {
    expect(run(file, { lines: ['thinking... esc to interrupt'] }).verdict).toEqual({ rule: 'busy', state: 'working', origin })
  })

  test('SC-7 (c): a rest title with a screen quiet for 2 s is idle', () => {
    expect(run(file, { title: '✳ fake', lines: ['>'], quietForMs: 2000 }).verdict).toEqual({ rule: 'ready', state: 'idle', origin })
  })

  test('SC-7 (d): a rest title over a screen that keeps changing gives no verdict', () => {
    for (const quietForMs of [0, 200, null]) {
      expect(run(file, { title: '✳ fake', lines: ['>'], quietForMs }).verdict).toBeNull()
    }
  })

  test('SC-7 (e): "allow this?" ten lines above the bottom is outside the last 6 lines', () => {
    const lines = ['allow this? (y/n)', ...Array.from({ length: 10 }, (_, i) => `line ${i}`)]
    expect(run(file, { lines }).verdict).toBeNull()
  })

  test('SC-7 (f): reordering the file does not let a working rule hide the approval', () => {
    const reordered = fileOf(busy, approval, ready)
    const { verdict } = run(reordered, { lines: ['esc to interrupt', 'Allow this? (y/n)'] })
    expect(verdict?.rule).toBe('approval')
    expect(verdict?.state).toBe('blocked')
  })
})

describe('evaluate: ordering and matching', () => {
  test('among working and idle rules the first in file order wins', () => {
    const first: Rule = { id: 'first', state: 'idle', region: 'screen', all: [{ contains: 'x' }] }
    const second: Rule = { id: 'second', state: 'working', region: 'screen', all: [{ contains: 'x' }] }
    expect(run(fileOf(first, second), { lines: ['x'] }).verdict?.rule).toBe('first')
    expect(run(fileOf(second, first), { lines: ['x'] }).verdict?.rule).toBe('second')
  })

  test('among blocked rules the first in file order wins', () => {
    const a: Rule = { id: 'a', state: 'blocked', region: 'screen', all: [{ contains: 'x' }] }
    const b: Rule = { id: 'b', state: 'blocked', kind: 'question', region: 'screen', all: [{ contains: 'x' }] }
    expect(run(fileOf(b, busy, a), { lines: ['x esc to interrupt'] }).verdict).toEqual({ rule: 'b', state: 'blocked', kind: 'question', origin })
  })

  test('a blocked rule without a kind is an approval', () => {
    const rule: Rule = { id: 'a', state: 'blocked', region: 'screen', all: [{ contains: 'x' }] }
    expect(run(fileOf(rule), { lines: ['x'] }).verdict?.kind).toBe('approval')
  })

  test('working and idle verdicts carry no kind', () => {
    expect('kind' in run(fileOf(busy), { lines: ['esc to interrupt'] }).verdict!).toBe(false)
  })

  test('contains ignores case in both directions', () => {
    const rule: Rule = { id: 'c', state: 'working', region: 'screen', all: [{ contains: 'Do You WANT' }] }
    expect(run(fileOf(rule), { lines: ['do you want to proceed?'] }).verdict?.rule).toBe('c')
  })

  test('a regex is case sensitive unless ignoreCase is set', () => {
    const strict: Rule = { id: 's', state: 'working', region: 'screen', all: [{ regex: 'Busy' }] }
    const loose: Rule = { id: 'l', state: 'working', region: 'screen', all: [{ regex: 'Busy', ignoreCase: true }] }
    expect(run(fileOf(strict), { lines: ['busy'] }).verdict).toBeNull()
    expect(run(fileOf(loose), { lines: ['busy'] }).verdict?.rule).toBe('l')
  })

  test('^ and $ match per line of the region', () => {
    const rule: Rule = { id: 'm', state: 'idle', region: 'screen', all: [{ regex: '^>$' }] }
    expect(run(fileOf(rule), { lines: ['output', '>', 'footer'] }).verdict?.rule).toBe('m')
  })

  test('a regex can span the joined lines with \\n', () => {
    const rule: Rule = { id: 'j', state: 'idle', region: 'screen', all: [{ regex: 'one\\ntwo' }] }
    expect(run(fileOf(rule), { lines: ['one', 'two'] }).verdict?.rule).toBe('j')
  })

  test('all matchers must hold', () => {
    const rule: Rule = { id: 'a', state: 'idle', region: 'screen', all: [{ contains: 'one' }, { contains: 'two' }] }
    expect(run(fileOf(rule), { lines: ['one'] }).verdict).toBeNull()
    expect(run(fileOf(rule), { lines: ['one', 'two'] }).verdict?.rule).toBe('a')
  })

  test('no none matcher may hold', () => {
    const rule: Rule = { id: 'n', state: 'idle', region: 'screen', all: [{ contains: 'ready' }], none: [{ contains: 'busy' }] }
    expect(run(fileOf(rule), { lines: ['ready'] }).verdict?.rule).toBe('n')
    expect(run(fileOf(rule), { lines: ['ready', 'busy'] }).verdict).toBeNull()
  })

  test('a rule with only none holds when nothing matches', () => {
    const rule: Rule = { id: 'n', state: 'idle', region: 'screen', none: [{ contains: 'busy' }] }
    expect(run(fileOf(rule), { lines: ['ready'] }).verdict?.rule).toBe('n')
    expect(run(fileOf(rule), { lines: ['busy'] }).verdict).toBeNull()
  })

  test('a title rule reads the title and ignores the screen', () => {
    const rule: Rule = { id: 't', state: 'working', region: 'title', all: [{ contains: 'working' }] }
    expect(run(fileOf(rule), { title: 'agent working', lines: [] }).verdict?.rule).toBe('t')
    expect(run(fileOf(rule), { title: 'agent', lines: ['working'] }).verdict).toBeNull()
  })

  test('a screen rule ignores the title', () => {
    expect(run(fileOf(busy), { title: 'esc to interrupt', lines: [] }).verdict).toBeNull()
  })

  test('lastLines counts non-blank lines from the bottom', () => {
    const rule: Rule = { id: 'l', state: 'idle', region: 'screen', lastLines: 2, all: [{ contains: 'target' }] }
    const lines = ['target', 'a', '', '', 'b', '   ', '']
    expect(run(fileOf(rule), { lines }).verdict).toBeNull()
    expect(run(fileOf({ ...rule, lastLines: 3 }), { lines: ['target', 'a', '', 'b'] }).verdict?.rule).toBe('l')
  })

  test('a screen of blank lines holds nothing for a contains matcher', () => {
    expect(run(fileOf(busy), { lines: ['', '  '] }).verdict).toBeNull()
  })

  test('a rule whose regex cannot compile does not hold and does not throw', () => {
    const rule: Rule = { id: 'bad', state: 'idle', region: 'screen', all: [{ regex: '([a-z' }] }
    expect(run(fileOf(rule, busy), { lines: ['esc to interrupt'] }).verdict?.rule).toBe('busy')
  })

  test('a file parsed from text evaluates the same way', () => {
    const parsed = parseRuleFile(JSON.stringify(fileOf(approval, busy)), 'fake')
    if (!parsed.ok) throw new Error(parsed.reason)
    expect(run(parsed.file, { lines: ['Allow this? (y/n)'] }).verdict?.rule).toBe('approval')
  })
})

describe('evaluate: quiet', () => {
  const quiet: Rule = { id: 'quiet', state: 'idle', region: 'screen', all: [{ contains: '>' }], quietMs: 1000 }

  test('a rule that matches except for quiet reports pendingQuiet', () => {
    expect(run(fileOf(quiet), { lines: ['>'], quietForMs: 300 })).toEqual({ verdict: null, pendingQuiet: 'quiet' })
    expect(run(fileOf(quiet), { lines: ['>'], quietForMs: null })).toEqual({ verdict: null, pendingQuiet: 'quiet' })
  })

  test('quiet exactly at the limit is met', () => {
    expect(run(fileOf(quiet), { lines: ['>'], quietForMs: 1000 })).toEqual({ verdict: { rule: 'quiet', state: 'idle', origin } })
  })

  test('a rule that does not match is not pending', () => {
    expect(run(fileOf(quiet), { lines: ['nothing'], quietForMs: 0 })).toEqual({ verdict: null })
  })

  test('a later rule can win while an earlier one is pending, and both are reported', () => {
    const later: Rule = { id: 'later', state: 'working', region: 'screen', all: [{ contains: '>' }] }
    const result = run(fileOf(quiet, later), { lines: ['>'], quietForMs: 0 })
    expect(result.verdict?.rule).toBe('later')
    expect(result.pendingQuiet).toBe('quiet')
  })

  test('only the first pending rule is reported', () => {
    const other: Rule = { ...quiet, id: 'other' }
    expect(run(fileOf(quiet, other), { lines: ['>'], quietForMs: 0 }).pendingQuiet).toBe('quiet')
  })

  test('a pending blocked rule does not stop a working rule from winning', () => {
    const blocked: Rule = { id: 'held', state: 'blocked', region: 'screen', all: [{ contains: '>' }], quietMs: 500 }
    const result = run(fileOf(blocked, busy), { lines: ['> esc to interrupt'], quietForMs: 0 })
    expect(result.verdict?.rule).toBe('busy')
    expect(result.pendingQuiet).toBe('held')
  })

  test('a rule without quietMs needs no observation', () => {
    expect(run(fileOf(busy), { lines: ['esc to interrupt'], quietForMs: null }).verdict?.rule).toBe('busy')
  })

  test('quietMs 0 needs no observation either', () => {
    const rule: Rule = { ...quiet, quietMs: 0 }
    expect(run(fileOf(rule), { lines: ['>'], quietForMs: null }).verdict?.rule).toBe('quiet')
  })
})

describe('findLine', () => {
  const lines = ['build: 3 tests', 'All 12 passed', 'done']

  test('returns the newest matching line with its match and groups', () => {
    expect(findLine('(\\d+) passed', false, lines)).toEqual({ line: 'All 12 passed', match: '12 passed', groups: ['12'] })
    expect(findLine('tests', false, ['tests one', 'tests two'])?.line).toBe('tests two')
  })

  test('ignoreCase widens the match', () => {
    expect(findLine('all 12', false, lines)).toBeNull()
    expect(findLine('all 12', true, lines)?.line).toBe('All 12 passed')
  })

  test('an unmatched optional group is an empty string', () => {
    expect(findLine('(x)?done', false, lines)?.groups).toEqual([''])
  })

  test('no match is null', () => {
    expect(findLine('zzz', false, lines)).toBeNull()
  })

  test('a pattern that cannot compile is no match', () => {
    expect(findLine('([a-z', false, lines)).toBeNull()
  })

  test('a global-looking pattern does not carry state between lines', () => {
    expect(findLine('a', false, ['a', 'a'])?.line).toBe('a')
  })
})
