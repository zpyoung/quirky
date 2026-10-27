import { describe, expect, test } from 'bun:test'
import type { AgentDisplayState, AgentStatusSummary, Session } from '@quirky/protocol'
import { mostUrgent, ringPercent, windowDisplay, worktreeGlyph, worktreeStatus } from '../src/status'

const session = (id: string, worktreeId: string, status: Session['status']): Session => ({
  id,
  kind: 'terminal',
  agent: 'shell',
  worktreeId,
  cwd: '/x',
  title: id,
  status,
  createdAt: 0,
  lastActivityAt: 0,
  exitCode: null,
  exitSignal: null,
  exitCause: null,
  restorable: false
})

test('picks the most urgent status', () => {
  expect(mostUrgent(['exited', 'running', 'done'])).toBe('done')
  expect(mostUrgent(['done', 'working', 'running'])).toBe('working')
  expect(mostUrgent(['working', 'waiting', 'done'])).toBe('waiting')
  expect(mostUrgent(['exited', 'running'])).toBe('running')
  expect(mostUrgent(['exited'])).toBe('exited')
})

test('treats starting as running and empty as null', () => {
  expect(mostUrgent(['starting', 'exited'])).toBe('running')
  expect(mostUrgent([])).toBeNull()
})

test('aggregates per worktree', () => {
  const sessions = [session('a', 'w1', 'done'), session('b', 'w1', 'waiting'), session('c', 'w2', 'running')]
  expect(worktreeStatus(sessions, 'w1')).toBe('waiting')
  expect(worktreeStatus(sessions, 'w2')).toBe('running')
  expect(worktreeStatus(sessions, 'w3')).toBeNull()
})

describe('windowDisplay', () => {
  const MIN = 60_000
  const NOW = 100 * MIN
  const row = (over: Partial<AgentStatusSummary>): AgentStatusSummary => ({
    state: 'working',
    display: 'working',
    label: 'Working',
    detail: '',
    progress: null,
    stateStartedAt: 0,
    evidenceAt: NOW,
    restoredUnconfirmed: false,
    ...over
  })

  // shared with plugins/quirky.session/test/ui-helpers.test.ts
  const table: [string, Partial<AgentStatusSummary>, boolean, string, string][] = [
    ['fresh working', {}, true, 'working', 'Working'],
    ['working at exactly 30 minutes', { evidenceAt: NOW - 30 * MIN }, true, 'working', 'Working'],
    ['working past 30 minutes, running', { evidenceAt: NOW - 30 * MIN - 1 }, true, 'unverifiable', 'No recent update'],
    ['working past 30 minutes, not running', { evidenceAt: NOW - 31 * MIN }, false, 'idle', 'Idle'],
    ['waiting past 30 minutes', { state: 'waiting', display: 'waiting', label: 'Waiting for input', evidenceAt: NOW - 40 * MIN }, true, 'unverifiable', 'No recent update'],
    ['blocked past 30 minutes', { state: 'blocked', display: 'blocked', label: 'Blocked', evidenceAt: NOW - 40 * MIN }, false, 'idle', 'Idle'],
    ['done never decays', { state: 'done', display: 'done', label: 'Done', evidenceAt: 0 }, true, 'done', 'Done'],
    ['failed never decays', { state: 'done', display: 'failed', label: 'Failed', evidenceAt: 0 }, false, 'failed', 'Failed'],
    ['unconfirmed fresh keeps its label', { display: 'unconfirmed', label: "Couldn't confirm" }, true, 'unconfirmed', "Couldn't confirm"]
  ]
  for (const [name, over, running, display, label] of table) {
    test(name, () => expect(windowDisplay(row(over), NOW, running)).toEqual({ display, label } as never))
  }

  test('ringPercent rounds a 0-100 progress on live states and ignores the rest', () => {
    expect(ringPercent(row({ progress: 60.4 }), 'working')).toBe(60)
    expect(ringPercent(row({ progress: 250 }), 'waiting')).toBe(100)
    expect(ringPercent(row({ progress: -5 }), 'permission')).toBe(0)
    expect(ringPercent(row({ progress: null }), 'working')).toBeNull()
    expect(ringPercent(row({ progress: Number.NaN }), 'working')).toBeNull()
    expect(ringPercent(row({ progress: Number.POSITIVE_INFINITY }), 'working')).toBeNull()
    expect(ringPercent(row({ progress: 50 }), 'monitoring')).toBeNull()
    expect(ringPercent(row({ progress: 50 }), 'unverifiable')).toBeNull()
  })
})

describe('worktreeGlyph', () => {
  const NOW = 1_000_000
  const withSummary = (id: string, display: AgentDisplayState, over: Partial<AgentStatusSummary> = {}): Session => ({
    ...session(id, 'w1', 'working'),
    agentStatus: {
      state: display === 'done' || display === 'failed' || display === 'interrupted' ? 'done' : 'working',
      display,
      label: display,
      detail: '',
      progress: null,
      stateStartedAt: NOW,
      evidenceAt: NOW,
      restoredUnconfirmed: false,
      ...over
    }
  })
  const shown = (sessions: Session[]) => {
    const glyph = worktreeGlyph(sessions, 'w1', NOW)
    return glyph === null ? null : glyph.kind === 'agent' ? glyph.display : glyph.status
  }

  test('SC-35: ranks waiting, permission, blocked, failed, working, monitoring, unconfirmed, unverifiable, interrupted, done, idle, running, exited', () => {
    const order: (AgentDisplayState | 'running' | 'exited')[] = [
      'waiting',
      'permission',
      'blocked',
      'failed',
      'working',
      'monitoring',
      'unconfirmed',
      'unverifiable',
      'interrupted',
      'done',
      'idle',
      'running',
      'exited'
    ]
    const sessionFor = (key: (typeof order)[number], id: string): Session =>
      key === 'running' || key === 'exited' ? session(id, 'w1', key) : withSummary(id, key)
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        expect(shown([sessionFor(order[j]!, 'lo'), sessionFor(order[i]!, 'hi')])).toBe(order[i]!)
      }
    }
  })

  test('a waiting session beats a working one; when it finishes working shows, then done', () => {
    expect(shown([withSummary('a', 'waiting'), withSummary('b', 'working')])).toBe('waiting')
    expect(shown([withSummary('a', 'done'), withSummary('b', 'working')])).toBe('working')
    expect(shown([withSummary('a', 'done'), withSummary('b', 'done')])).toBe('done')
  })

  test('a stale unfinished summary ranks as its decayed state', () => {
    const stale = withSummary('a', 'working', { evidenceAt: NOW - 31 * 60_000 })
    expect(shown([stale, session('b', 'w1', 'running')])).toBe('unverifiable')
    expect(shown([stale, withSummary('c', 'done')])).toBe('unverifiable')
  })

  test('sessions with no summary rank by coarse status, and a summary wins a tie with its own progress', () => {
    expect(worktreeGlyph([session('a', 'w1', 'waiting')], 'w1', NOW)).toEqual({ kind: 'coarse', status: 'waiting' })
    expect(worktreeGlyph([session('a', 'w1', 'working'), withSummary('b', 'working', { progress: 50 })], 'w1', NOW)).toEqual({
      kind: 'agent',
      display: 'working',
      label: 'working',
      percent: 50
    })
  })

  test('ignores other worktrees and is null with no sessions', () => {
    expect(worktreeGlyph([{ ...withSummary('a', 'waiting'), worktreeId: 'w2' }], 'w1', NOW)).toBeNull()
    expect(worktreeGlyph([], 'w1', NOW)).toBeNull()
  })
})
