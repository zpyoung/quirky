import { expect, test } from 'bun:test'
import { nativeQuestionPlan, nativeQuestionAnswers } from '../native-questions'

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
