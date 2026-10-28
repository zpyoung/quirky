import { describe, expect, test } from 'bun:test'
import { loopSummaryLabel, parseLoopSummaries, selectLoopSummaries } from '../src/pages/loop-summaries'
import type { LoopSummary } from '../src/pages/loop-summaries'

const summary = (id: string, worktreeId: string, state: LoopSummary['state'], extra: Partial<LoopSummary> = {}): LoopSummary => ({
  id,
  worktreeId,
  state,
  pauseReason: null,
  iterationsCompleted: 3,
  maxIterations: null,
  updatedAt: 1,
  ...extra
})

describe('mobile loop summaries', () => {
  test('accepts only compact summary fields and rejects malformed responses as unavailable', () => {
    const parsed = parseLoopSummaries([{
      ...summary('loop-a', 'wt-a', 'running'),
      prompt: 'never retain this',
      cwd: '/private/path',
      output: 'private output'
    }])
    expect(parsed).toEqual([summary('loop-a', 'wt-a', 'running')])
    expect(parseLoopSummaries({ summaries: [] })).toBeNull()
    expect(parseLoopSummaries([{ ...summary('loop-a', 'wt-a', 'running'), state: 'finished' }])).toBeNull()
    expect(parseLoopSummaries([{ ...summary('loop-a', 'wt-a', 'running'), iterationsCompleted: -1 }])).toBeNull()
  })

  test('selects needs-you before running and paused, then newest timestamp and stable ID', () => {
    const selected = selectLoopSummaries([
      summary('z-running', 'wt-priority', 'running', { updatedAt: 100 }),
      summary('needs-old', 'wt-priority', 'needs-you', { updatedAt: 10 }),
      summary('needs-newer', 'wt-priority', 'needs-you', { updatedAt: 11 }),
      summary('needs-z', 'wt-tie', 'needs-you', { updatedAt: 20 }),
      summary('needs-b', 'wt-tie', 'needs-you', { updatedAt: 20 }),
      summary('paused', 'wt-priority', 'paused', { updatedAt: 200 })
    ])

    expect(selected.get('wt-priority')?.id).toBe('needs-newer')
    expect(selected.get('wt-tie')?.id).toBe('needs-b')
  })

  test('labels translate cap reasons while preserving other pause reasons', () => {
    expect(loopSummaryLabel(summary('running', 'wt-a', 'running'))).toBe('Loop 3 · running')
    expect(loopSummaryLabel(summary('paused', 'wt-b', 'paused', {
      iterationsCompleted: 2,
      maxIterations: 2,
      pauseReason: 'cap-iterations'
    }))).toBe('Loop 2/2 · paused: iteration cap reached')
    expect(loopSummaryLabel(summary('paused-time', 'wt-c', 'paused', {
      pauseReason: 'cap-time'
    }))).toBe('Loop 3 · paused: time cap reached')
    expect(loopSummaryLabel(summary('paused-cost', 'wt-d', 'paused', {
      pauseReason: 'cap-cost'
    }))).toBe('Loop 3 · paused: cost cap reached')
    expect(loopSummaryLabel(summary('paused-other', 'wt-e', 'paused', {
      pauseReason: 'no-progress'
    }))).toBe('Loop 3 · paused: no-progress')
    expect(loopSummaryLabel(summary('needs-you', 'wt-f', 'needs-you', {
      iterationsCompleted: 5,
      maxIterations: 8
    }), false)).toBe('Loop 5/8 · unverifiable')

  })
})
