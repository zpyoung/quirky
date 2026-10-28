import { describe, expect, test } from 'bun:test'
import type { AskSpec } from '@quirky/protocol'
import { flattenAskSpec, mapCoordinatorReply } from '../../src/core/handoff'

const spec: AskSpec = {
  title: 'Deployment details',
  questions: [
    {
      id: 'environment',
      type: 'select',
      question: 'Which environment?',
      options: [
        { value: 'staging', label: 'Staging' },
        { value: 'production', label: 'Production' }
      ]
    },
    { id: 'note', type: 'text', question: 'What should be verified?' },
    { id: 'approved', type: 'confirm', question: 'Ready to deploy?' }
  ]
}

describe('orchestration Ask handoff conversion', () => {
  test('flattens question IDs and provider-visible option values and labels for the coordinator', () => {
    expect(flattenAskSpec(spec)).toBe([
      'Deployment details',
      '1. [environment] Which environment?',
      '- staging — Staging',
      '- production — Production',
      '2. [note] What should be verified?',
      '3. [approved] Ready to deploy?',
      'Answer with one line per question: <id>: <answer>'
    ].join('\n'))
  })

  test('maps option labels, free text and confirmation back to their original typed question IDs', () => {
    expect(mapCoordinatorReply(spec, 'environment: Production\nnote: verify the migration\napproved: yes')).toEqual({
      answers: {
        environment: { value: 'production', label: 'Production', source: 'option' },
        note: { value: 'verify the migration', source: 'input' },
        approved: { value: true, source: 'input' }
      },
      skipped: []
    })
  })

  test('keeps unmatched select text as free text and skips unparseable typed answers', () => {
    expect(mapCoordinatorReply(spec, 'environment: ephemeral\napproved: maybe')).toEqual({
      answers: { environment: { value: 'ephemeral', source: 'other' } },
      skipped: ['note', 'approved']
    })
  })

  test('maps positional replies and applies a reply without recognized lines to the first question only', () => {
    expect(mapCoordinatorReply(spec, '1: staging\n2: skip for now')).toEqual({
      answers: {
        environment: { value: 'staging', label: 'Staging', source: 'option' },
        note: { value: 'skip for now', source: 'input' }
      },
      skipped: ['approved']
    })
    expect(mapCoordinatorReply(spec, 'production')).toEqual({
      answers: { environment: { value: 'production', label: 'Production', source: 'option' } },
      skipped: ['note', 'approved']
    })
  })
})
