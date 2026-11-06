import { describe, expect, test } from 'bun:test'
import { parseActions } from '../src/brain/actions'
import type { BrainAction } from '../src/contracts'

const block = (value: unknown) => `Here you go.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`

describe('parseActions', () => {
  test('accepts every action type with its required fields', () => {
    const actions: BrainAction[] = [
      { type: 'judge', requestId: 'r1', decision: 'deny', reliedOn: 'guideline 1', reason: 'updates snapshots' },
      { type: 'send', worktreeId: 'w', text: 'hi' },
      { type: 'answerAsk', askId: 'a', answers: { q1: 'yes' } },
      { type: 'askUser', worktreeId: 'w', questions: [{ id: 'q', text: 'which?' }], blocks: 'the rename' },
      { type: 'guess', worktreeId: 'w', question: 'q', choice: 'c', reversible: true },
      { type: 'proposeMandateEdit', worktreeId: 'w', patch: { goal: 'g', guidelines: ['x'] }, why: 'because' },
      { type: 'judgeFinding', worktreeId: 'w', findingId: 'f', valid: false, reason: 'nit' },
      { type: 'stepIn', worktreeId: 'w', text: 'stop' },
      { type: 'startSession', worktreeId: 'w', note: 'n' },
      { type: 'restartWorker', worktreeId: 'w', note: 'n' },
      { type: 'runDoneWhen', worktreeId: 'w' },
      { type: 'startReview', worktreeId: 'w' },
      { type: 'openPr', worktreeId: 'w' },
      { type: 'merge', worktreeId: 'w' },
      { type: 'mergeMainIn', worktreeId: 'w' },
      { type: 'park', worktreeId: 'w', story: 's' },
      { type: 'splitWorktree', worktreeId: 'w', branch: 'b', goal: 'g' },
      { type: 'setMergeOrder', sharedGoalId: 'sg', order: ['a', 'b'] },
      { type: 'noop', reason: 'nothing to do' }
    ]
    expect(parseActions(block(actions))).toEqual({ ok: true, actions })
  })

  test('an empty array is a valid answer', () => {
    expect(parseActions(block([]))).toEqual({ ok: true, actions: [] })
  })

  test('requires exactly one fenced json block', () => {
    expect(parseActions('no block here')).toMatchObject({ ok: false })
    expect(parseActions(`${block([])}${block([])}`)).toMatchObject({ ok: false })
    expect(parseActions('```json\n{not json}\n```')).toMatchObject({ ok: false })
    expect(parseActions('```json\n{"type":"noop","reason":"x"}\n```')).toMatchObject({ ok: false })
  })

  test('rejects unknown types and missing or mistyped fields, naming the action index', () => {
    expect(parseActions(block([{ type: 'deleteEverything' }]))).toMatchObject({ ok: false, error: expect.stringContaining('unknown action type') })
    expect(parseActions(block([{ type: 'noop', reason: 'x' }, { type: 'send', worktreeId: 'w' }]))).toMatchObject({
      ok: false,
      error: expect.stringContaining('actions[1]')
    })
    expect(parseActions(block([{ type: 'guess', worktreeId: 'w', question: 'q', choice: 'c', reversible: 'yes' }]))).toMatchObject({ ok: false })
    expect(parseActions(block([{ type: 'judge', requestId: 'r', decision: 'maybe', reliedOn: '', reason: '' }]))).toMatchObject({ ok: false })
    expect(parseActions(block([{ type: 'setMergeOrder', sharedGoalId: 's', order: [1] }]))).toMatchObject({ ok: false })
  })

  test('a mandate edit can never carry level or switches', () => {
    for (const key of ['level', 'switches']) {
      const result = parseActions(block([{ type: 'proposeMandateEdit', worktreeId: 'w', patch: { goal: 'g', [key]: 'full' }, why: 'w' }]))
      expect(result).toMatchObject({ ok: false, error: expect.stringContaining(key) })
    }
    expect(parseActions(block([{ type: 'proposeMandateEdit', worktreeId: 'w', patch: { agent: 'codex' }, why: 'w' }]))).toMatchObject({ ok: false })
  })

  test('drops fields an action does not declare', () => {
    const parsed = parseActions(block([{ type: 'send', worktreeId: 'w', text: 't', level: 'full' }]))
    expect(parsed).toEqual({ ok: true, actions: [{ type: 'send', worktreeId: 'w', text: 't' }] })
  })
})
