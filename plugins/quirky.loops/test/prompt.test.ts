import { describe, expect, test } from 'bun:test'
import type { CheckResult } from '../src/types'
import { buildIterationPrompt } from '../src/prompt'

const failedCheck: CheckResult = {
  ran: true,
  pass: false,
  exitCode: 1,
  timedOut: false,
  stdoutTail: Array.from({ length: 45 }, (_, index) => `out-${index + 1}`).join('\n'),
  stderrTail: 'stderr-last',
  durationMs: 12
}

describe('buildIterationPrompt', () => {
  test('puts the session preamble once, iteration bounds, last 40 check lines and queued steer in order', () => {
    const prompt = buildIterationPrompt({
      body: 'Implement the requested work.',
      n: 3,
      maxIterations: 5,
      notesPath: '/tmp/project/.quirky/loops/feature-a/notes.md',
      newSession: true,
      previousCheck: failedCheck,
      steerNotes: ['keep the API stable', 'use banana']
    })

    expect(prompt).toContain('automated background loop')
    expect(prompt).toContain('/tmp/project/.quirky/loops/feature-a/notes.md')
    expect(prompt).toContain('This is iteration 3 of 5.')
    expect(prompt).toContain('The previous check failed. Its last output:')
    expect(prompt.split('\n')).not.toContain('out-6')
    expect(prompt.split('\n')).toContain('out-7')
    expect(prompt).toContain('out-45\nstderr-last')
    expect(prompt).toContain('Notes from the user for this iteration:\n- keep the API stable\n- use banana')
    expect(prompt.indexOf('Notes from the user')).toBeLessThan(prompt.indexOf('Implement the requested work.'))
  })

  test('omits the preamble for an existing session and preserves an unbounded iteration header', () => {
    const prompt = buildIterationPrompt({
      body: 'Keep going.',
      n: 7,
      notesPath: '/tmp/project/.quirky/loops/name/notes.md',
      newSession: false,
      previousCheck: null,
      steerNotes: []
    })

    expect(prompt).toBe('This is iteration 7.\n\nKeep going.')
    expect(prompt).not.toContain('automated background loop')
    expect(prompt).not.toContain('Notes from the user')
  })
})
