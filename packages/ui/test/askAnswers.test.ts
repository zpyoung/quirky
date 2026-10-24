import { expect, test } from 'bun:test'
import type { AskSpec } from '@quirky/protocol'
import { OTHER, buildAnswers, emptyDrafts } from '../src/lib/askAnswers'

const spec: AskSpec = {
  questions: [
    { id: 'pick', type: 'select', question: 'Pick', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }] },
    { id: 'many', type: 'multiselect', question: 'Many', options: [{ value: 'x', label: 'X' }, { value: 'y', label: 'Y' }] },
    { id: 'name', type: 'text', question: 'Name' },
    { id: 'ok', type: 'confirm', question: 'OK?' }
  ]
}

test('empty drafts skip every question', () => {
  expect(buildAnswers(spec, emptyDrafts(spec))).toEqual({
    answers: {},
    skipped: ['pick', 'many', 'name', 'ok']
  })
})

test('builds answers for each question type', () => {
  const drafts = emptyDrafts(spec)
  drafts.pick = { type: 'select', choice: 'b', other: '' }
  drafts.many = { type: 'multiselect', values: ['y', 'x'] }
  drafts.name = { type: 'text', text: '  Zed ' }
  drafts.ok = { type: 'confirm', value: false }
  expect(buildAnswers(spec, drafts)).toEqual({
    answers: {
      pick: { value: 'b', label: 'B', source: 'option' },
      many: { values: ['x', 'y'], labels: ['X', 'Y'], source: 'options' },
      name: { value: 'Zed', source: 'input' },
      ok: { value: false, source: 'input' }
    },
    skipped: []
  })
})

test('select with other uses the free text, and empty other is skipped', () => {
  const drafts = emptyDrafts(spec)
  drafts.pick = { type: 'select', choice: OTHER, other: 'custom' }
  expect(buildAnswers(spec, drafts).answers.pick).toEqual({ value: 'custom', source: 'other' })
  drafts.pick = { type: 'select', choice: OTHER, other: '   ' }
  expect(buildAnswers(spec, drafts).skipped).toContain('pick')
})
