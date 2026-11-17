import { expect, test } from 'bun:test'
import type { AskEnvelope } from '@quirky/protocol'
import { approvalOutcome, approvalSpec, nativeQuestionPlan, nativeQuestionAnswers } from '../native-questions'

test('Codex question IDs and literal labels survive typed owner answers including free text', () => {
  const plan = nativeQuestionPlan({ questions: [{ id: 'destination', header: 'Target', question: 'Where next?', options: [{ label: 'Local' }, { label: 'Remote' }] }] }, 'codex')
  expect(plan.spec.questions[0]).toMatchObject({ id: 'destination', type: 'select', options: [{ value: 'o1', label: 'Local' }, { value: 'o2', label: 'Remote' }] })
  expect(nativeQuestionAnswers(plan, { status: 'answered', askId: 'ask_1', answers: { destination: { value: 'o2', label: 'Remote', source: 'option', note: 'paired server' } }, skipped: [], summary: 'Target: Remote' })).toEqual({ destination: ['Remote', 'paired server'] })
})

test('native secret questions and duplicate identities refuse before producing an Ask', () => {
  expect(() => nativeQuestionPlan({ questions: [{ id: 'q', question: 'Which account?', isSecret: true }] }, 'codex')).toThrow('Secret')
  expect(() => nativeQuestionPlan({ questions: [{ id: 'q', question: 'First?' }, { id: 'q', question: 'Second?' }] }, 'codex')).toThrow('duplicate')
})

test('Claude multi-select uses its original question key and unavailable is explicit non-answer text', () => {
  const plan = nativeQuestionPlan({ questions: [{ question: 'Choose destinations', multiSelect: true, options: [{ label: 'One' }, { label: 'Two' }] }] }, 'claude')
  expect(nativeQuestionAnswers(plan, { status: 'answered', askId: 'ask_2', answers: { q1: { values: ['o2'], labels: ['Two'], source: 'options', other: 'Three' } }, skipped: [], summary: '' })).toEqual({ 'Choose destinations': ['Two', 'Three'] })
  expect(nativeQuestionAnswers(plan, { status: 'unavailable', askId: 'ask_2', answers: {}, skipped: ['q1'], summary: 'Owner unavailable', reason: 'Owner unavailable' })).toEqual({ 'Choose destinations': ['No answer from the watcher owner; proceed with your best judgment.'] })
})

const answered = (answers: AskEnvelope['answers']): AskEnvelope => ({ status: 'answered', askId: 'a', answers, skipped: [], summary: '' })

test('the approval ask has the decision select and an optional reason', () => {
  const [decision, reason] = approvalSpec('Allow Bash? ls').questions
  expect(decision).toMatchObject({ id: 'decision', type: 'select', question: 'Allow Bash? ls' })
  expect((decision as { options: { value: string; label: string }[] }).options).toEqual([
    { value: 'allow', label: 'Allow once' },
    { value: 'always', label: 'Allow for this session' },
    { value: 'deny', label: 'Deny' }
  ])
  expect(reason).toEqual({ id: 'reason', type: 'text', question: 'Reason, if you deny', required: false })
})

test('an approval outcome reads the decision and reason, and fails closed', () => {
  expect(approvalOutcome(answered({ decision: { value: 'allow', label: 'Allow once', source: 'option' } }), true)).toEqual({ decision: 'allow' })
  expect(approvalOutcome(answered({ decision: { value: 'always', source: 'option' } }), true)).toEqual({ decision: 'always' })
  expect(approvalOutcome(answered({ decision: { value: 'deny', source: 'option' }, reason: { value: '  too risky ', source: 'input' } }), true)).toEqual({ decision: 'deny', reason: 'too risky' })
  expect(approvalOutcome(answered({ decision: { value: 'deny', source: 'option' }, reason: { value: ' ', source: 'input' } }), true)).toEqual({ decision: 'deny' })
  expect(approvalOutcome(answered({ decision: { value: 'allow', source: 'option' }, reason: { value: 'ignored', source: 'input' } }), true)).toEqual({ decision: 'allow' })
  expect(approvalOutcome(answered({ decision: { value: 'maybe', source: 'option' } }), true)).toEqual({ decision: 'deny' })
  expect(approvalOutcome(null, true)).toEqual({ decision: 'deny' })
  expect(approvalOutcome({ status: 'timed_out', askId: 'a', answers: {}, skipped: ['decision'], summary: '' }, true)).toEqual({ decision: 'deny' })
})

test('a stale always on an agent without session approval is an allow', () => {
  expect(approvalOutcome(answered({ decision: { value: 'always', source: 'option' } }), false)).toEqual({ decision: 'allow' })
})

test('a partial approval envelope with the decision answered is honored', () => {
  const partial = (answers: AskEnvelope['answers'], status: 'partial' | 'declined' | 'timed_out' = 'partial'): AskEnvelope => ({ status, askId: 'a', answers, skipped: ['reason'], summary: '' })
  expect(approvalOutcome(partial({ decision: { value: 'allow', label: 'Allow once', source: 'option' } }), true)).toEqual({ decision: 'allow' })
  expect(approvalOutcome(partial({ decision: { value: 'always', source: 'option' } }), true)).toEqual({ decision: 'always' })
  expect(approvalOutcome(partial({ decision: { value: 'always', source: 'option' } }), false)).toEqual({ decision: 'allow' })
  expect(approvalOutcome(partial({ decision: { value: 'deny', source: 'option' }, reason: { value: ' nope ', source: 'input' } }), true)).toEqual({ decision: 'deny', reason: 'nope' })
  expect(approvalOutcome(partial({}), true)).toEqual({ decision: 'deny' })
  expect(approvalOutcome(partial({ decision: { value: 'allow', source: 'option' } }, 'declined'), true)).toEqual({ decision: 'deny' })
  expect(approvalOutcome(partial({ decision: { value: 'allow', source: 'option' } }, 'timed_out'), true)).toEqual({ decision: 'deny' })
})
