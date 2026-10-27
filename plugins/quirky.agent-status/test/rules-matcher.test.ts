import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { budgetFrom, evaluateForAgent, Matcher } from '../src/rules/matcher'
import { RuleSources, TIMED_OUT_REASON } from '../src/rules/sources'
import type { Origin, Rule, RuleFile } from '../src/rules/types'

const origin: Origin = { kind: 'built-in', path: '/rules/fake.json' }
const slowRule: Rule = { id: 'slow', state: 'working', region: 'screen', all: [{ regex: 'a+a+a+a+$' }] }
const busy: Rule = { id: 'busy', state: 'working', region: 'screen', all: [{ regex: 'esc to interrupt' }] }
const poison = [`${'a'.repeat(30_000)}!`]

let matcher: Matcher
beforeAll(() => {
  matcher = new Matcher()
})
afterAll(() => matcher.dispose())

describe('matcher budget', () => {
  test('the budget is 250 ms, scaled by a positive QUIRKY_TEST_AGENT_STATUS_TIME_SCALE', () => {
    expect(budgetFrom({})).toBe(250)
    expect(budgetFrom({ QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.1' })).toBeCloseTo(25)
    expect(budgetFrom({ QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0' })).toBe(250)
    expect(budgetFrom({ QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: 'x' })).toBe(250)
    expect(budgetFrom({ QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '-2' })).toBe(250)
  })
})

describe('matcher process', () => {
  test('a normal evaluation answers in well under the budget', async () => {
    await matcher.evaluate({ agent: 'fake', rules: [busy] }, { title: '', lines: [], quietForMs: null }, origin)
    const started = performance.now()
    const result = await matcher.evaluate({ agent: 'fake', rules: [busy] }, { title: '', lines: ['esc to interrupt'], quietForMs: null }, origin)
    expect(performance.now() - started).toBeLessThan(100)
    expect(result).toEqual({ verdict: { rule: 'busy', state: 'working', origin } })
  })

  test('SC-41: a pattern that runs too long times out, and the next evaluation still answers', async () => {
    const file: RuleFile = { agent: 'fake', rules: [slowRule] }
    const started = performance.now()
    const result = await matcher.evaluate(file, { title: '', lines: poison, quietForMs: null }, origin)
    const took = performance.now() - started
    expect(result).toEqual({ timedOut: true })
    expect(took).toBeGreaterThanOrEqual(200)
    expect(took).toBeLessThan(2000)

    const next = await matcher.evaluate({ agent: 'fake', rules: [busy] }, { title: '', lines: ['esc to interrupt'], quietForMs: null }, origin)
    expect(next).toEqual({ verdict: { rule: 'busy', state: 'working', origin } })
  }, 10_000)

  test('SC-41: a single wait pattern is cut off the same way', async () => {
    expect(await matcher.matchLines('a+a+a+a+$', false, poison)).toEqual({ timedOut: true })
    expect(await matcher.matchLines('All (\\d+) passed', false, ['x', 'All 12 passed'])).toEqual({ line: 'All 12 passed', match: 'All 12 passed', groups: ['12'] })
    expect(await matcher.matchLines('zzz', false, ['x'])).toBeNull()
  }, 10_000)

  test('requests queued behind a slow one still get their own answers', async () => {
    const file: RuleFile = { agent: 'fake', rules: [slowRule] }
    const [slow, fast] = await Promise.all([
      matcher.evaluate(file, { title: '', lines: poison, quietForMs: null }, origin),
      matcher.matchLines('tests', false, ['build: 3 tests']),
    ])
    expect(slow).toEqual({ timedOut: true })
    expect(fast).toEqual({ line: 'build: 3 tests', match: 'tests', groups: [] })
  }, 10_000)

  test('a request still queued when its deadline passes expires without running', async () => {
    const queue = new Matcher({ env: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.4' } })
    try {
      const file: RuleFile = { agent: 'fake', rules: [slowRule] }
      const slow = [0, 1, 2, 3].map(() => queue.evaluate(file, { title: '', lines: poison, quietForMs: null }, origin))
      const started = performance.now()
      const waiting = await queue.matchLines('tests', false, ['build: 3 tests'], Date.now() + 10)
      const evaluating = await queue.evaluate({ agent: 'fake', rules: [busy] }, { title: '', lines: ['esc to interrupt'], quietForMs: null }, origin, Date.now() + 10)

      expect(waiting).toEqual({ expired: true })
      expect(evaluating).toEqual({ expired: true })
      expect(performance.now() - started).toBeLessThan(150)
      expect(await Promise.all(slow)).toEqual([{ timedOut: true }, { timedOut: true }, { timedOut: true }, { timedOut: true }])
      expect(await queue.matchLines('tests', false, ['build: 3 tests'])).toEqual({ line: 'build: 3 tests', match: 'tests', groups: [] })
    } finally {
      queue.dispose()
    }
  }, 10_000)

  test('a request that is first in line runs even with a deadline close by', async () => {
    expect(await matcher.matchLines('tests', false, ['build: 3 tests'], Date.now() + 5000)).toEqual({ line: 'build: 3 tests', match: 'tests', groups: [] })
  })

  test('a time scale shortens the budget', async () => {
    const quick = new Matcher({ env: { QUIRKY_TEST_AGENT_STATUS_TIME_SCALE: '0.2' } })
    try {
      const started = performance.now()
      expect(await quick.matchLines('a+a+a+a+$', false, poison)).toEqual({ timedOut: true })
      expect(performance.now() - started).toBeLessThan(1500)
    } finally {
      quick.dispose()
    }
  }, 10_000)

  test('after dispose every call reports the matcher unavailable', async () => {
    const gone = new Matcher()
    expect(await gone.matchLines('a', false, ['a'])).toMatchObject({ line: 'a' })
    gone.dispose()
    const result = await gone.matchLines('a', false, ['a'])
    expect(result).toHaveProperty('unavailable')
  })

  test('disposing while the process is starting kills it and answers every request unavailable', async () => {
    const gone = new Matcher()
    const first = gone.matchLines('a', false, ['a'])
    const second = gone.matchLines('a', false, ['a'])
    await Bun.sleep(1)
    const internals = gone as unknown as { spawning: { exited: Promise<number>; killed: boolean } | null; child: unknown }
    const starting = internals.spawning
    expect(starting).not.toBeNull()
    gone.dispose()
    expect(await first).toEqual({ unavailable: 'the matcher was shut down' })
    expect(await second).toEqual({ unavailable: 'the matcher was shut down' })
    expect(await gone.matchLines('a', false, ['a'])).toEqual({ unavailable: 'the matcher was shut down' })
    await starting!.exited
    expect(starting!.killed).toBe(true)
    expect(internals.child).toBeNull()
    expect(internals.spawning).toBeNull()
  })

  test('a matcher that cannot start reports why and gives no verdict', async () => {
    const broken = new Matcher({ command: ['/nonexistent/binary-for-test'] })
    try {
      const result = await broken.evaluate({ agent: 'fake', rules: [busy] }, { title: '', lines: ['esc to interrupt'], quietForMs: null }, origin)
      expect(result).toHaveProperty('unavailable')
    } finally {
      broken.dispose()
    }
  })
})

describe('slow rule sources', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'rm-'))
    mkdirSync(join(root, 'user'))
    mkdirSync(join(root, 'builtin'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  const write = (path: string, rules: Rule[], seconds: number) => {
    writeFileSync(path, JSON.stringify({ agent: 'fake', rules }))
    utimesSync(path, seconds, seconds)
  }

  test('SC-41: a source that times out is ignored with the reason and the next one answers', async () => {
    const user = join(root, 'user', 'fake.json')
    write(join(root, 'builtin', 'fake.json'), [busy], 1_000_000)
    write(user, [slowRule], 1_000_000)
    const logs: string[] = []
    const sources = new RuleSources({ userDir: join(root, 'user'), builtinDir: join(root, 'builtin'), contributions: async () => [], log: (line) => logs.push(line) })

    const first = await evaluateForAgent(sources, matcher, 'fake', { title: '', lines: [...poison, 'esc to interrupt'], quietForMs: null })
    expect(first.source?.origin.kind).toBe('built-in')
    expect(first.verdict?.rule).toBe('busy')
    expect((await sources.listing('fake'))?.ignored).toEqual([{ origin: { kind: 'user', path: user }, reason: TIMED_OUT_REASON }])
    expect(logs.filter((line) => line.includes(TIMED_OUT_REASON))).toHaveLength(1)

    const again = await evaluateForAgent(sources, matcher, 'fake', { title: '', lines: poison, quietForMs: null })
    expect(again.source?.origin.kind).toBe('built-in')

    write(user, [busy], 1_000_100)
    const fixed = await evaluateForAgent(sources, matcher, 'fake', { title: '', lines: ['esc to interrupt'], quietForMs: null })
    expect(fixed.source?.origin.kind).toBe('user')
    expect((await sources.listing('fake'))?.ignored).toEqual([])
  }, 15_000)

  test('a timeout for a file that was replaced while it ran does not ignore the replacement', async () => {
    const user = join(root, 'user', 'fake.json')
    write(join(root, 'builtin', 'fake.json'), [busy], 2_000_000)
    write(user, [slowRule], 2_000_000)
    const sources = new RuleSources({ userDir: join(root, 'user'), builtinDir: join(root, 'builtin'), contributions: async () => [], log: () => {} })
    let replaced = false
    // the corrected file is picked up by another look before the slow evaluation's timeout is reported
    const replacing = {
      async evaluate(...args: Parameters<Matcher['evaluate']>) {
        const result = await matcher.evaluate(...args)
        if (!replaced) {
          replaced = true
          write(user, [busy], 2_000_100)
          await sources.effective('fake')
        }
        return result
      }
    } as Matcher

    const result = await evaluateForAgent(sources, replacing, 'fake', { title: '', lines: [...poison, 'esc to interrupt'], quietForMs: null })

    expect(result.source?.origin.kind).toBe('user')
    expect(result.verdict?.rule).toBe('busy')
    expect((await sources.listing('fake'))?.ignored).toEqual([])
  }, 10_000)

  test('an agent with no source evaluates to no source and no verdict', async () => {
    const sources = new RuleSources({ userDir: join(root, 'user'), builtinDir: join(root, 'builtin'), contributions: async () => [], log: () => {} })
    expect(await evaluateForAgent(sources, matcher, 'nosuch', { title: '', lines: [], quietForMs: null })).toEqual({ source: null, verdict: null })
  })

  test('an unavailable matcher is reported with the source it could not run', async () => {
    const sources = new RuleSources({ userDir: join(root, 'user'), builtinDir: join(root, 'builtin'), contributions: async () => [], log: () => {} })
    const broken = new Matcher({ command: ['/nonexistent/binary-for-test'] })
    try {
      const result = await evaluateForAgent(sources, broken, 'fake', { title: '', lines: [], quietForMs: null })
      expect(result.verdict).toBeNull()
      expect(result.unavailable).toBeString()
      expect(result.source?.origin.kind).toBeDefined()
    } finally {
      broken.dispose()
    }
  })
})
