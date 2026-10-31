import { describe, expect, test } from 'bun:test'
import { applyIssueActions, planIssues, readOpenIssues } from './issues'
import type { Baseline, GhRunner, IssueAction, OpenIssue, Selection, TestStatus } from './types'

const NOW = new Date('2026-10-30T12:00:00Z')
const PREV = 'a'.repeat(40)
const CUR = 'b'.repeat(40)

function key(file: string, name: string) {
  return `${file}\0Suite\0${name}`
}

function baseline(commit: string, over: Partial<Baseline> & { failed?: string[] } = {}): Baseline {
  const tests: Record<string, TestStatus> = { ...over.tests }
  for (const k of over.failed ?? []) tests[k] = 'failed'
  return { version: 1, commit, createdAt: '2026-10-30T00:00:00Z', runId: '1', files: {}, flakeHistory: {}, ...over, tests }
}

function selection(files: string[]): Selection {
  return { mode: 'some', files, reasons: [] }
}

function plan(over: Partial<Parameters<typeof planIssues>[0]> = {}) {
  return planIssues({
    previous: baseline(PREV),
    current: baseline(CUR),
    openIssues: [],
    rangeSelection: null,
    now: NOW,
    ...over,
  })
}

function hidden(body: string) {
  const m = body.match(/<!-- test-baseline:(.*) -->\s*$/s)
  return m ? JSON.parse(m[1]) : null
}

describe('planIssues failures', () => {
  test('first baseline files nothing even with failures and open issues', () => {
    const current = baseline(CUR, { failed: [key('a.test.ts', 'x')], flakeHistory: { 'a.test.ts': ['2026-10-29', '2026-10-28', '2026-10-27'] } })
    const open: OpenIssue[] = [{ number: 4, label: 'test-failure', tests: [key('z.test.ts', 'gone')] }]
    expect(plan({ previous: null, current, openIssues: open })).toEqual([])
  })

  test('new failures open one issue naming the range', () => {
    const a = key('a.test.ts', 'one')
    const b = key('b.test.ts', 'two')
    const actions = plan({ current: baseline(CUR, { failed: [a, b] }) })
    expect(actions).toHaveLength(1)
    const action = actions[0] as Extract<IssueAction, { label: 'test-failure' }>
    expect(action.kind).toBe('open')
    expect(action.label).toBe('test-failure')
    expect(action.title).toContain(`${PREV}..${CUR}`)
    expect(action.tests.sort()).toEqual([a, b].sort())
    expect(action.body).toContain(`${PREV}..${CUR}`)
    expect(action.body).toContain('a.test.ts')
    expect(action.body).toContain('two')
    expect(hidden(action.body)).toEqual({ tests: action.tests })
  })

  test('a failure already failing in the previous baseline is not new', () => {
    const a = key('a.test.ts', 'one')
    expect(plan({ previous: baseline(PREV, { failed: [a] }), current: baseline(CUR, { failed: [a] }) })).toEqual([])
  })

  test('failures covered by an open failure issue open nothing', () => {
    const a = key('a.test.ts', 'one')
    const open: OpenIssue[] = [{ number: 9, label: 'test-failure', tests: [a] }]
    expect(plan({ current: baseline(CUR, { failed: [a] }), openIssues: open })).toEqual([])
  })

  test('only the uncovered failures go into the new issue', () => {
    const a = key('a.test.ts', 'one')
    const b = key('b.test.ts', 'two')
    const open: OpenIssue[] = [{ number: 9, label: 'test-failure', tests: [a] }]
    const actions = plan({ current: baseline(CUR, { failed: [a, b] }), openIssues: open })
    expect(actions).toHaveLength(1)
    expect((actions[0] as { tests: string[] }).tests).toEqual([b])
  })

  test('a file error is a failure keyed by the bare file path', () => {
    const current = baseline(CUR, { files: { 'c.test.ts': { platform: 'linux', durationMs: 1, fileError: 'timeout', flaky: false } } })
    const actions = plan({ current })
    expect(actions).toHaveLength(1)
    expect((actions[0] as { tests: string[] }).tests).toEqual(['c.test.ts'])
  })

  test('a file error that was already there is not new', () => {
    const files = { 'c.test.ts': { platform: 'linux' as const, durationMs: 1, fileError: 'timeout' as const, flaky: false } }
    expect(plan({ previous: baseline(PREV, { files }), current: baseline(CUR, { files }) })).toEqual([])
  })

  test('skipped and passed tests are not failures', () => {
    const current = baseline(CUR, { tests: { [key('a.test.ts', 'p')]: 'passed', [key('a.test.ts', 's')]: 'skipped' } })
    expect(plan({ current })).toEqual([])
  })
})

describe('planIssues selection misses', () => {
  const missed = key('m.test.ts', 'missed')
  const covered = key('c.test.ts', 'covered')
  const current = baseline(CUR, { failed: [missed, covered] })

  test('a failure whose file is outside the range selection is a miss', () => {
    const [action] = plan({ current, rangeSelection: selection(['c.test.ts']) }) as Extract<IssueAction, { kind: 'open' }>[]
    expect(action.body.toLowerCase()).toContain('selection miss')
    const missSection = action.body.slice(action.body.toLowerCase().indexOf('selection miss'), action.body.indexOf('<!--'))
    expect(missSection).toContain('m.test.ts')
    expect(missSection).not.toContain('c.test.ts')
  })

  test('a null range selection marks no misses', () => {
    const [action] = plan({ current, rangeSelection: null }) as Extract<IssueAction, { kind: 'open' }>[]
    expect(action.body.toLowerCase()).not.toContain('selection miss')
  })

  test('failures all inside the range selection mark no misses', () => {
    const [action] = plan({ current, rangeSelection: selection(['m.test.ts', 'c.test.ts']) }) as Extract<IssueAction, { kind: 'open' }>[]
    expect(action.body.toLowerCase()).not.toContain('selection miss')
  })

  test('a file error is checked against the selection by its path', () => {
    const files = { 'e.test.ts': { platform: 'linux' as const, durationMs: 1, fileError: 'no-report' as const, flaky: false } }
    const [action] = plan({ current: baseline(CUR, { files }), rangeSelection: selection([]) }) as Extract<IssueAction, { kind: 'open' }>[]
    expect(action.body.toLowerCase()).toContain('selection miss')
  })
})

describe('planIssues failure closes', () => {
  const a = key('a.test.ts', 'one')
  const b = key('b.test.ts', 'two')

  test('closes an issue whose tests have all stopped failing', () => {
    const open: OpenIssue[] = [{ number: 7, label: 'test-failure', tests: [a, b] }]
    const actions = plan({ openIssues: open })
    expect(actions).toHaveLength(1)
    expect(actions[0]).toMatchObject({ kind: 'close', number: 7 })
    expect((actions[0] as { comment: string }).comment.length).toBeGreaterThan(0)
  })

  test('keeps an issue open while any of its tests still fails', () => {
    const open: OpenIssue[] = [{ number: 7, label: 'test-failure', tests: [a, b] }]
    expect(plan({ previous: baseline(PREV, { failed: [a] }), current: baseline(CUR, { failed: [a] }), openIssues: open })).toEqual([])
  })

  test('a file error clearing counts as the failure going away', () => {
    const open: OpenIssue[] = [{ number: 8, label: 'test-failure', tests: ['c.test.ts'] }]
    expect(plan({ openIssues: open })).toEqual([{ kind: 'close', number: 8, comment: expect.any(String) }])
  })

  test('opens a new issue and closes an old one in the same run', () => {
    const open: OpenIssue[] = [{ number: 7, label: 'test-failure', tests: [a] }]
    const actions = plan({ current: baseline(CUR, { failed: [b] }), openIssues: open })
    expect(actions.map((x) => x.kind).sort()).toEqual(['close', 'open'])
  })
})

describe('planIssues flakes', () => {
  const file = 'f.test.ts'
  const flaky = (dates: string[]) => baseline(CUR, { flakeHistory: { [file]: dates } })

  test('three flakes inside 7 days open one flake issue with the dates', () => {
    const dates = ['2026-10-30', '2026-10-28', '2026-10-25']
    const actions = plan({ current: flaky(dates) })
    expect(actions).toHaveLength(1)
    const action = actions[0] as Extract<IssueAction, { label: 'test-flake' }>
    expect(action).toMatchObject({ kind: 'open', label: 'test-flake', file, title: `Flaky test file: ${file}` })
    for (const d of dates) expect(action.body).toContain(d)
    expect(hidden(action.body)).toEqual({ file })
  })

  test('two flakes is below the threshold', () => {
    expect(plan({ current: flaky(['2026-10-30', '2026-10-29']) })).toEqual([])
  })

  test('dates older than 7 days do not count', () => {
    expect(plan({ current: flaky(['2026-10-30', '2026-10-29', '2026-10-20']) })).toEqual([])
  })

  test('a date exactly 7 days back still counts', () => {
    const actions = plan({ current: flaky(['2026-10-30', '2026-10-29', '2026-10-23T12:00:00Z']) })
    expect(actions).toHaveLength(1)
  })

  test('old dates are left out of the issue body', () => {
    const actions = plan({ current: flaky(['2026-10-30', '2026-10-29', '2026-10-28', '2026-09-01']) })
    expect((actions[0] as { body: string }).body).not.toContain('2026-09-01')
  })

  test('an open flake issue for the file blocks a second one', () => {
    const open: OpenIssue[] = [{ number: 3, label: 'test-flake', tests: [], file }]
    expect(plan({ current: flaky(['2026-10-30', '2026-10-29', '2026-10-28']), openIssues: open })).toEqual([])
  })

  test('closes a flake issue once the file has no recent history', () => {
    const open: OpenIssue[] = [{ number: 3, label: 'test-flake', tests: [], file }]
    expect(plan({ openIssues: open })).toEqual([{ kind: 'close', number: 3, comment: expect.any(String) }])
  })

  test('history that has all aged out also closes the issue', () => {
    const open: OpenIssue[] = [{ number: 3, label: 'test-flake', tests: [], file }]
    expect(plan({ current: flaky(['2026-10-01']), openIssues: open })[0]).toMatchObject({ kind: 'close', number: 3 })
  })

  test('a flake issue stays open while the file still has recent history', () => {
    const open: OpenIssue[] = [{ number: 3, label: 'test-flake', tests: [], file }]
    expect(plan({ current: flaky(['2026-10-29']), openIssues: open })).toEqual([])
  })
})

function fakeGh(handlers: Record<string, (args: string[]) => string | Error> = {}) {
  const calls: string[][] = []
  const gh: GhRunner = async (args) => {
    calls.push(args)
    const name = args.slice(0, 2).join(' ')
    const result = (handlers[name] ?? (() => ''))(args)
    if (result instanceof Error) throw result
    return result
  }
  return { gh, calls }
}

function flagValue(args: string[], flag: string) {
  return args[args.indexOf(flag) + 1]
}

describe('readOpenIssues', () => {
  const body = (json: unknown) => `Some text\n\n<!-- test-baseline:${JSON.stringify(json)} -->`

  test('lists each label and parses the hidden comment', async () => {
    const { gh, calls } = fakeGh({
      'issue list': (args) =>
        flagValue(args, '--label') === 'test-failure'
          ? JSON.stringify([{ number: 1, body: body({ tests: ['a\u0000b\u0000c'] }) }])
          : JSON.stringify([{ number: 2, body: body({ file: 'f.test.ts' }) }]),
    })
    const issues = await readOpenIssues(gh, 'o/r')
    expect(issues).toEqual([
      { number: 1, label: 'test-failure', tests: ['a\0b\0c'] },
      { number: 2, label: 'test-flake', tests: [], file: 'f.test.ts' },
    ])
    for (const call of calls) {
      expect(call).toContain('--repo')
      expect(flagValue(call, '--repo')).toBe('o/r')
      expect(flagValue(call, '--state')).toBe('open')
    }
  })

  test('ignores issues with no parsable comment', async () => {
    const { gh } = fakeGh({
      'issue list': (args) =>
        flagValue(args, '--label') === 'test-failure'
          ? JSON.stringify([
              { number: 1, body: 'no comment here' },
              { number: 2, body: '<!-- test-baseline:{not json} -->' },
              { number: 3, body: body({ tests: 'not a list' }) },
              { number: 4, body: null },
              { number: 5, body: body({ tests: ['x'] }) },
            ])
          : '[]',
    })
    expect(await readOpenIssues(gh, 'o/r')).toEqual([{ number: 5, label: 'test-failure', tests: ['x'] }])
  })

  test('an issue in the flake list without a file is ignored', async () => {
    const { gh } = fakeGh({
      'issue list': (args) => (flagValue(args, '--label') === 'test-flake' ? JSON.stringify([{ number: 1, body: body({ tests: ['x'] }) }]) : '[]'),
    })
    expect(await readOpenIssues(gh, 'o/r')).toEqual([])
  })

  test('round-trips the comment planIssues writes', async () => {
    const tricky = `a.test.ts\0S\0name --> with <!-- markers`
    const [action] = plan({ current: baseline(CUR, { failed: [tricky] }) }) as Extract<IssueAction, { kind: 'open' }>[]
    const { gh } = fakeGh({
      'issue list': (args) => (flagValue(args, '--label') === 'test-failure' ? JSON.stringify([{ number: 1, body: action.body }]) : '[]'),
    })
    expect(await readOpenIssues(gh, 'o/r')).toEqual([{ number: 1, label: 'test-failure', tests: [tricky] }])
  })
})

describe('applyIssueActions', () => {
  const failureOpen: IssueAction = { kind: 'open', label: 'test-failure', title: 'T1', body: 'B1', tests: ['x'] }
  const flakeOpen: IssueAction = { kind: 'open', label: 'test-flake', title: 'T2', body: 'B2', file: 'f' }
  const close: IssueAction = { kind: 'close', number: 12, comment: 'gone' }
  const names = (calls: string[][]) => calls.map((c) => c.slice(0, 2).join(' '))

  test('creates a missing label before opening the issue', async () => {
    const { gh, calls } = fakeGh({ 'label list': () => '[]' })
    await applyIssueActions([failureOpen], gh, 'o/r')
    expect(names(calls)).toEqual(['label list', 'label create', 'issue create'])
    expect(calls[1]).toContain('test-failure')
    const create = calls[2]
    expect(flagValue(create, '--title')).toBe('T1')
    expect(flagValue(create, '--body')).toBe('B1')
    expect(flagValue(create, '--label')).toBe('test-failure')
    expect(flagValue(create, '--repo')).toBe('o/r')
  })

  test('does not create a label that exists', async () => {
    const { gh, calls } = fakeGh({ 'label list': () => JSON.stringify([{ name: 'test-failure' }]) })
    await applyIssueActions([failureOpen], gh, 'o/r')
    expect(names(calls)).toEqual(['label list', 'issue create'])
  })

  test('creates each missing label once', async () => {
    const { gh, calls } = fakeGh({ 'label list': () => '[]' })
    await applyIssueActions([failureOpen, { ...failureOpen, title: 'again' }, flakeOpen], gh, 'o/r')
    expect(names(calls).filter((n) => n === 'label create')).toHaveLength(2)
    expect(names(calls).filter((n) => n === 'issue create')).toHaveLength(3)
  })

  test('closing posts the comment first, then closes', async () => {
    const { gh, calls } = fakeGh()
    await applyIssueActions([close], gh, 'o/r')
    expect(names(calls)).toEqual(['issue comment', 'issue close'])
    expect(calls[0]).toContain('12')
    expect(flagValue(calls[0], '--body')).toBe('gone')
    expect(calls[1]).toContain('12')
  })

  test('closing needs no label lookup', async () => {
    const { gh, calls } = fakeGh()
    await applyIssueActions([close], gh, 'o/r')
    expect(names(calls)).not.toContain('label list')
  })

  test('does not close when the comment fails', async () => {
    const { gh, calls } = fakeGh({ 'issue comment': () => new Error('boom') })
    await expect(applyIssueActions([close], gh, 'o/r')).rejects.toThrow()
    expect(names(calls)).toEqual(['issue comment'])
  })

  test('keeps going past a failed action and rejects at the end listing it', async () => {
    const { gh, calls } = fakeGh({
      'label list': () => JSON.stringify([{ name: 'test-failure' }, { name: 'test-flake' }]),
      'issue create': (args) => (flagValue(args, '--title') === 'T1' ? new Error('rate limited') : ''),
    })
    const promise = applyIssueActions([failureOpen, flakeOpen, close], gh, 'o/r')
    await expect(promise).rejects.toThrow(/T1/)
    await expect(promise).rejects.toThrow(/rate limited/)
    const ran = names(calls)
    expect(ran.filter((n) => n === 'issue create')).toHaveLength(2)
    expect(ran).toContain('issue close')
  })

  test('a failed label lookup fails the open actions but not the closes', async () => {
    const { gh, calls } = fakeGh({ 'label list': () => new Error('no network') })
    await expect(applyIssueActions([failureOpen, close], gh, 'o/r')).rejects.toThrow(/T1/)
    expect(names(calls)).toContain('issue close')
    expect(names(calls)).not.toContain('issue create')
  })

  test('resolves with nothing to do and makes no calls', async () => {
    const { gh, calls } = fakeGh()
    await applyIssueActions([], gh, 'o/r')
    expect(calls).toEqual([])
  })
})
