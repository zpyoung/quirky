import { describe, expect, test } from 'bun:test'
import { dispatchActions } from '../src/brain/dispatch'
import type { BrainAction, Finding, Level, Mandate, OutboxRow } from '../src/contracts'
import { makeTestApp, sampleMandate, type FakeCalls } from './support'

type Recorded = { name: string; args: unknown[] }

/** An app with the given mandates handed off and every service replaced by a recorder that answers success. */
function setup(mandates: Mandate[], fakeCalls: FakeCalls = {}, settings: Record<string, unknown> = {}) {
  const test = makeTestApp({ fakeCalls, settings })
  const { app } = test
  const recorded: Recorded[] = []
  const record = <T>(name: string, result: T) => (...args: unknown[]): T => {
    recorded.push({ name, args })
    return result
  }
  for (const mandate of mandates) app.store.mandates.put(mandate)
  app.services.handoff.mandate = (id) => mandates.find((m) => m.worktreeId === id) ?? null
  app.services.handoff.active = () => mandates.map((mandate) => ({ worktreeId: mandate.worktreeId, sessionId: null, state: 'working', mandate }))
  app.services.handoff.handoff = (async (items: unknown) => {
    recorded.push({ name: 'handoff.handoff', args: [items] })
    return (items as { worktreeId: string }[]).map((item) => ({ worktreeId: item.worktreeId, ok: true }))
  }) as never
  const s = app.services
  s.supervisor.send = record('send', Promise.resolve({ sent: true })) as never
  s.supervisor.stepIn = record('stepIn', Promise.resolve({ sent: true })) as never
  s.supervisor.startSession = record('startSession', Promise.resolve({ sessionId: 'x' })) as never
  s.supervisor.restartWorker = record('restartWorker', Promise.resolve({ sessionId: 'x' })) as never
  s.supervisor.park = record('park', undefined) as never
  s.supervisor.recordDenial = record('recordDenial', undefined) as never
  s.shipping.runDoneWhen = record('runDoneWhen', Promise.resolve({ pass: true, output: '' })) as never
  s.shipping.startReview = record('startReview', Promise.resolve({ started: true })) as never
  s.shipping.judgeFinding = record('judgeFinding', Promise.resolve()) as never
  s.shipping.openPr = record('openPr', Promise.resolve({ ok: true })) as never
  s.shipping.merge = record('merge', Promise.resolve({ ok: true })) as never
  s.shipping.mergeMainIn = record('mergeMainIn', Promise.resolve({ ok: true })) as never
  return { ...test, recorded, names: () => recorded.map((r) => r.name) }
}

const wt = (level: Level, id = 'wt-1', extra: Partial<Mandate> = {}) => sampleMandate({ worktreeId: id, level, ...extra })
const journal = (app: ReturnType<typeof setup>['app']) => app.store.journalSince(0).filter((e) => e.kind === 'brain-action')

describe('level and Shadow', () => {
  test('at Shadow every executing action is journaled as wouldHave and nothing runs', async () => {
    const t = setup([wt('shadow')])
    const actions: BrainAction[] = [
      { type: 'send', worktreeId: 'wt-1', text: 'hi' },
      { type: 'stepIn', worktreeId: 'wt-1', text: 'stop' },
      { type: 'startSession', worktreeId: 'wt-1', note: 'n' },
      { type: 'restartWorker', worktreeId: 'wt-1', note: 'n' },
      { type: 'runDoneWhen', worktreeId: 'wt-1' },
      { type: 'startReview', worktreeId: 'wt-1' },
      { type: 'openPr', worktreeId: 'wt-1' },
      { type: 'merge', worktreeId: 'wt-1' },
      { type: 'mergeMainIn', worktreeId: 'wt-1' },
      { type: 'park', worktreeId: 'wt-1', story: 's' },
      { type: 'guess', worktreeId: 'wt-1', question: 'q', choice: 'c', reversible: true },
      { type: 'judgeFinding', worktreeId: 'wt-1', findingId: 'f', valid: true, reason: 'r' },
      { type: 'answerAsk', askId: 'a1', answers: {} }
    ]
    t.fakeCalls['quirky.ask/list'] = () => [{ id: 'a1', worktreeId: 'wt-1' }]
    await dispatchActions(t.app, actions)
    expect(t.recorded).toEqual([])
    expect(t.calls.filter((c) => c.method !== 'quirky.ask/list')).toEqual([])
    const entries = journal(t.app)
    expect(entries).toHaveLength(actions.length)
    for (const entry of entries) expect(entry.data.wouldHave).toBe(true)
    expect(t.app.store.guesses.list()).toEqual([])
  })

  test('noop, judge, askUser and proposeMandateEdit still run at Shadow', async () => {
    const t = setup([wt('shadow')], { 'quirky.ask/create': () => ({ askId: 'ask-1' }) })
    const judged: string[] = []
    await dispatchActions(
      t.app,
      [
        { type: 'noop', reason: 'nothing' },
        { type: 'judge', requestId: 'r1', decision: 'allow', reliedOn: 'x', reason: 'y' },
        { type: 'askUser', worktreeId: 'wt-1', questions: [{ id: 'q', text: 'which?' }], blocks: 'the rename' },
        { type: 'proposeMandateEdit', worktreeId: 'wt-1', patch: { goal: 'new' }, why: 'because' }
      ],
      { onJudge: (action) => judged.push(action.requestId) }
    )
    expect(judged).toEqual(['r1'])
    expect(t.calls.map((c) => c.method)).toEqual(['quirky.ask/create'])
    expect(t.names()).toEqual([])
    expect(t.app.needs.list({ open: true }).map((n) => n.kind).sort()).toEqual(['mandate-edit', 'question'])
    expect(journal(t.app).some((e) => e.data.wouldHave === true)).toBe(false)
  })

  test('actions above the worktree level are refused, not run', async () => {
    const t = setup([wt('local'), wt('own-branch', 'wt-2')])
    await dispatchActions(t.app, [
      { type: 'openPr', worktreeId: 'wt-1' },
      { type: 'merge', worktreeId: 'wt-2' },
      { type: 'send', worktreeId: 'wt-1', text: 'ok at local' }
    ])
    expect(t.names()).toEqual(['send'])
    const entries = journal(t.app)
    expect(entries[0]?.data).toMatchObject({ outcome: 'refused', reason: expect.stringContaining('level') })
    expect(entries[1]?.data).toMatchObject({ outcome: 'refused' })
  })

  test('an action for a worktree that is not handed off is refused', async () => {
    const t = setup([wt('full')])
    await dispatchActions(t.app, [{ type: 'send', worktreeId: 'wt-9', text: 'hi' }])
    expect(t.names()).toEqual([])
    expect(journal(t.app)[0]?.data).toMatchObject({ outcome: 'refused' })
  })

  test('every executed action is journaled as brain-action with its result', async () => {
    const t = setup([wt('full')])
    await dispatchActions(t.app, [{ type: 'send', worktreeId: 'wt-1', text: 'hi' }, { type: 'noop', reason: 'idle' }])
    const entries = journal(t.app)
    expect(entries.map((e) => e.data.action)).toEqual([{ type: 'send', worktreeId: 'wt-1', text: 'hi' }, { type: 'noop', reason: 'idle' }])
    expect(entries[0]?.worktreeId).toBe('wt-1')
    expect(entries[0]?.data.outcome).toBe('done')
  })

  test('a service that throws is journaled as failed and does not stop the next action', async () => {
    const t = setup([wt('full')])
    t.app.services.supervisor.send = (async () => {
      throw new Error('pane gone')
    }) as never
    await dispatchActions(t.app, [{ type: 'send', worktreeId: 'wt-1', text: 'hi' }, { type: 'park', worktreeId: 'wt-1', story: 's' }])
    expect(journal(t.app)[0]?.data).toMatchObject({ outcome: 'failed', error: 'pane gone' })
    expect(t.names()).toEqual(['park'])
  })
})

describe('askUser', () => {
  test('creates one ask per worktree batch with no timeout, adds a question need and tells the worker what not to start', async () => {
    const t = setup([wt('full'), wt('full', 'wt-2')], { 'quirky.ask/create': () => ({ askId: `ask-${t.calls.length}` }) })
    await dispatchActions(t.app, [
      { type: 'askUser', worktreeId: 'wt-1', questions: [{ id: 'q1', text: 'A?' }], blocks: 'the rename' },
      { type: 'askUser', worktreeId: 'wt-1', questions: [{ id: 'q2', text: 'B?' }], blocks: 'the migration' },
      { type: 'askUser', worktreeId: 'wt-2', questions: [{ id: 'q3', text: 'C?' }], blocks: 'docs' }
    ])
    const creates = t.calls.filter((c) => c.method === 'quirky.ask/create')
    expect(creates).toHaveLength(2)
    expect(creates[0]?.params.worktree).toBe('wt-1')
    expect(creates[0]?.params).not.toHaveProperty('timeoutMs')
    const spec = creates[0]?.params.spec as { questions: { id: string }[] }
    expect(spec.questions.map((q) => q.id)).toEqual(['q1', 'q2'])
    const needs = t.app.needs.list({ open: true })
    expect(needs.map((n) => [n.worktreeId, n.kind])).toEqual([['wt-1', 'question'], ['wt-2', 'question']])
    expect(needs[0]?.detail.askId).toBeDefined()
    const sends = t.recorded.filter((r) => r.name === 'send')
    expect(sends).toHaveLength(2)
    expect(sends[0]?.args[0]).toBe('wt-1')
    expect(sends[0]?.args[1]).toContain("don't start")
    expect(sends[0]?.args[1]).toContain('the rename')
    expect(sends[0]?.args[1]).toContain('the migration')
    expect(sends[0]?.args[1]).toContain('until answered')
  })
})

describe('judgeFinding', () => {
  const finding = (over: Partial<Finding> = {}): Finding => ({
    id: 'f1', worktreeId: 'wt-1', source: 'bot', summary: 'rename tmp to pending', detail: { number: 7 }, valid: null, reason: null, threadId: 'th-1', commitSha: 'abc', createdAt: 1, ...over
  })

  const judge = (valid: boolean, reason = 'r', findingId = 'f1'): BrainAction => ({ type: 'judgeFinding', worktreeId: 'wt-1', findingId, valid, reason })

  test('valid: delegates once to shipping and sends nothing itself', async () => {
    const t = setup([wt('full')])
    t.app.store.findings.put(finding())
    await dispatchActions(t.app, [judge(true, 'real')])
    expect(t.recorded).toEqual([{ name: 'judgeFinding', args: ['wt-1', 'f1', true, 'real'] }])
    expect(journal(t.app)[0]?.data).toMatchObject({ outcome: 'done' })
  })

  test('invalid: delegates once to shipping with no outbox row and no thread resolution from dispatch', async () => {
    const t = setup([wt('full')], { 'quirky.hosting/resolveThread': () => ({ resolved: true }) })
    t.app.store.findings.put(finding())
    await dispatchActions(t.app, [judge(false, 'tmp is intentional')])
    expect(t.recorded).toEqual([{ name: 'judgeFinding', args: ['wt-1', 'f1', false, 'tmp is intentional'] }])
    expect(t.app.store.outbox.list()).toEqual([])
    expect(t.calls.some((c) => c.method === 'quirky.hosting/resolveThread')).toBe(false)
  })

  test('a human finding is delegated unchanged: the messaging-switch rule lives in shipping', async () => {
    const t = setup([wt('full')])
    t.app.store.findings.put(finding({ source: 'reviewer', detail: { number: 7, human: true } }))
    await dispatchActions(t.app, [judge(false, 'disagree')])
    expect(t.names()).toEqual(['judgeFinding'])
    expect(t.app.needs.list({ open: true })).toEqual([])
    expect(t.app.store.outbox.list()).toEqual([])
  })

  test('repeated valid verdicts never record a denial from dispatch', async () => {
    const t = setup([wt('full')])
    t.app.store.findings.put(finding())
    for (let i = 0; i < 3; i++) await dispatchActions(t.app, [judge(true, 'real')])
    expect(t.names()).toEqual(['judgeFinding', 'judgeFinding', 'judgeFinding'])
  })

  test('an unknown finding or one from another worktree is refused without delegating', async () => {
    const t = setup([wt('full')])
    t.app.store.findings.put(finding({ worktreeId: 'wt-2' }))
    await dispatchActions(t.app, [judge(true), judge(true, 'r', 'missing')])
    expect(t.recorded).toEqual([])
    expect(journal(t.app).map((e) => e.data.outcome)).toEqual(['refused', 'refused'])
  })
})

describe('other actions', () => {
  test('guess records the flagged guess and a confirmable need; an irreversible guess is refused', async () => {
    const t = setup([wt('full')])
    await dispatchActions(t.app, [
      { type: 'guess', worktreeId: 'wt-1', question: 'tooltip text', choice: 'full command', reversible: true },
      { type: 'guess', worktreeId: 'wt-1', question: 'drop table', choice: 'yes', reversible: false }
    ])
    expect(t.app.store.guesses.list().map((g) => g.choice)).toEqual(['full command'])
    const need = t.app.needs.list({ open: true })[0]
    expect(need).toMatchObject({ kind: 'guess', actions: ['confirm', 'redo'] })
    expect(journal(t.app)[1]?.data).toMatchObject({ outcome: 'refused' })
  })

  test('proposeMandateEdit queues a needs-you item and never touches the stored mandate', async () => {
    const t = setup([wt('full')])
    await dispatchActions(t.app, [{ type: 'proposeMandateEdit', worktreeId: 'wt-1', patch: { goal: 'bigger goal' }, why: 'scope grew' }])
    expect(t.app.needs.list({ open: true })[0]).toMatchObject({ kind: 'mandate-edit' })
    expect(t.app.store.mandates.get('wt-1')?.goal).toBe('Fix the two failing checks')
    expect(t.app.store.journalSince(0).some((e) => e.kind === 'mandate-proposal')).toBe(true)
  })

  test('setMergeOrder stores the order on the shared goal and rejects ids outside it', async () => {
    const t = setup([wt('full'), wt('full', 'wt-2')])
    t.app.store.sharedGoals.put({ id: 'sg', goal: 'g', worktreeIds: ['wt-1', 'wt-2'], mergeOrder: [] })
    await dispatchActions(t.app, [
      { type: 'setMergeOrder', sharedGoalId: 'sg', order: ['wt-2', 'wt-1'] },
      { type: 'setMergeOrder', sharedGoalId: 'sg', order: ['wt-2', 'nope'] },
      { type: 'setMergeOrder', sharedGoalId: 'missing', order: [] }
    ])
    expect(t.app.store.sharedGoals.get('sg')?.mergeOrder).toEqual(['wt-2', 'wt-1'])
    expect(journal(t.app).map((e) => e.data.outcome)).toEqual(['done', 'refused', 'refused'])
  })

  test('answerAsk goes through quirky.ask/answer for an ask of a handed-off worktree only', async () => {
    const t = setup([wt('full')], {
      'quirky.ask/list': (p) => (p.askId === 'a1' ? [{ id: 'a1', worktreeId: 'wt-1' }] : [{ id: 'a2', worktreeId: 'other' }]),
      'quirky.ask/answer': () => ({ status: 'answered' })
    })
    await dispatchActions(t.app, [
      { type: 'answerAsk', askId: 'a1', answers: { q: 'yes' } },
      { type: 'answerAsk', askId: 'a2', answers: { q: 'yes' } }
    ])
    expect(t.calls.filter((c) => c.method === 'quirky.ask/answer').map((c) => c.params)).toEqual([{ askId: 'a1', answers: { q: 'yes' } }])
  })

  test('supervisor and shipping actions call the matching service', async () => {
    const t = setup([wt('full')])
    await dispatchActions(t.app, [
      { type: 'send', worktreeId: 'wt-1', text: 'a' },
      { type: 'stepIn', worktreeId: 'wt-1', text: 'b' },
      { type: 'startSession', worktreeId: 'wt-1', note: 'c' },
      { type: 'restartWorker', worktreeId: 'wt-1', note: 'd' },
      { type: 'park', worktreeId: 'wt-1', story: 'e' },
      { type: 'runDoneWhen', worktreeId: 'wt-1' },
      { type: 'startReview', worktreeId: 'wt-1' },
      { type: 'openPr', worktreeId: 'wt-1' },
      { type: 'merge', worktreeId: 'wt-1' }
    ])
    expect(t.names()).toEqual(['send', 'stepIn', 'startSession', 'restartWorker', 'park', 'runDoneWhen', 'startReview', 'openPr', 'merge'])
  })

  test('splitWorktree needs the mandate to allow it, then creates a child that joins with the parent mandate', async () => {
    const created: Record<string, unknown>[] = []
    const t = setup([wt('full', 'wt-1', { allowSplit: false }), wt('full', 'wt-2', { allowSplit: true, guidelines: ['g1'] })], {
      'quirky.worktree/show': () => ({ id: 'wt-2', repoId: 'repo-1', branch: 'main-work' }),
      'quirky.worktree/create': (p) => {
        created.push(p)
        return { worktree: { id: 'wt-new' } }
      }
    })
    await dispatchActions(t.app, [
      { type: 'splitWorktree', worktreeId: 'wt-1', branch: 'b1', goal: 'part' },
      { type: 'splitWorktree', worktreeId: 'wt-2', branch: 'b2', goal: 'part two' }
    ])
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({ repo: 'repo-1', branchName: 'b2', parent: 'wt-2' })
    const handoff = t.recorded.find((r) => r.name === 'handoff.handoff')?.args[0] as { worktreeId: string; goal: string; guidelines: string[]; level: string }[]
    expect(handoff[0]).toMatchObject({ worktreeId: 'wt-new', goal: 'part two', guidelines: ['g1'], level: 'full' })
  })
})

describe('mergeMainIn conflicts', () => {
  const conflictRow = (id: string, files: string[]): OutboxRow => ({ id, worktreeId: 'wt-1', kind: 'merge-main-in', payload: {}, idempotencyKey: id, state: 'done', result: { conflict: true, files } })

  test('a conflict goes back to the worker with the files; a second conflict on the same files adds merge-blocked', async () => {
    const t = setup([wt('full')])
    let n = 0
    t.app.services.shipping.mergeMainIn = (async () => {
      t.app.store.outbox.put(conflictRow(`o${++n}`, ['a.ts', 'b.ts']))
      return { ok: false, reason: 'conflict' }
    }) as never
    await dispatchActions(t.app, [{ type: 'mergeMainIn', worktreeId: 'wt-1' }])
    const sends = t.recorded.filter((r) => r.name === 'send')
    expect(sends).toHaveLength(1)
    expect(sends[0]?.args[1]).toContain('a.ts')
    expect(t.app.needs.list({ open: true })).toEqual([])

    await dispatchActions(t.app, [{ type: 'mergeMainIn', worktreeId: 'wt-1' }])
    expect(t.app.needs.list({ open: true }).map((x) => x.kind)).toEqual(['merge-blocked'])
    expect(t.recorded.filter((r) => r.name === 'send')).toHaveLength(1)
  })

  test('a different file set is a fresh conflict, sent back again', async () => {
    const t = setup([wt('full')])
    const sets = [['a.ts'], ['z.ts']]
    t.app.services.shipping.mergeMainIn = (async () => {
      t.app.store.outbox.put(conflictRow(`o${sets.length}`, sets.shift() ?? []))
      return { ok: false }
    }) as never
    await dispatchActions(t.app, [{ type: 'mergeMainIn', worktreeId: 'wt-1' }])
    await dispatchActions(t.app, [{ type: 'mergeMainIn', worktreeId: 'wt-1' }])
    expect(t.recorded.filter((r) => r.name === 'send')).toHaveLength(2)
    expect(t.app.needs.list({ open: true })).toEqual([])
  })
})

