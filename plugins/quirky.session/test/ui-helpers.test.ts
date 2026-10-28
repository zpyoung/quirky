import { describe, expect, test } from 'bun:test'
import type { AgentStatusSummary, StructuredMessage } from '@quirky/protocol'
import { pickActive } from '../src/window/model'
import { sessionForDigit } from '../src/window/shortcuts'
import { displayStatus, ringPercent, windowDisplay } from '../src/window/status'
import { mergeMessages } from '../src/window/transcript'
import { session } from './ui-fake'

test('Cmd+digit picks the session at that position and nothing else', () => {
  const sessions = ['a', 'b', 'c']
  expect(sessionForDigit(sessions, '1')).toBe('a')
  expect(sessionForDigit(sessions, '3')).toBe('c')
  expect(sessionForDigit(sessions, '4')).toBeUndefined()
  expect(sessionForDigit(sessions, '0')).toBeUndefined()
  expect(sessionForDigit(sessions, 'a')).toBeUndefined()
})

test('a starting session displays as running', () => {
  expect(displayStatus('starting')).toBe('running')
  expect(displayStatus('waiting')).toBe('waiting')
})

test('the active tab is the requested session, else the remembered one, else the first', () => {
  const sessions = [session({ id: 'a' }), session({ id: 'b' }), session({ id: 'c' })]
  expect(pickActive(sessions, 'c', 'b')?.id).toBe('c')
  expect(pickActive(sessions, undefined, 'b')?.id).toBe('b')
  expect(pickActive(sessions, 'gone', 'also-gone')?.id).toBe('a')
  expect(pickActive([], 'a', 'b')).toBeNull()
})

const message = (seq: number, text: string): StructuredMessage => ({ sessionId: 's', seq, role: 'assistant', text, at: 0 })

test('merging messages keeps one per seq, the incoming one, in order', () => {
  const merged = mergeMessages([message(1, 'a'), message(3, 'c')], [message(2, 'b'), message(3, 'c2')])
  expect(merged.map((m) => [m.seq, m.text])).toEqual([
    [1, 'a'],
    [2, 'b'],
    [3, 'c2']
  ])
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

  // shared with plugins/quirky.worktree/test/status.test.ts
  const table: [string, Partial<AgentStatusSummary>, boolean, string, string][] = [
    ['fresh working', {}, true, 'working', 'Working'],
    ['working at exactly 30 minutes', { evidenceAt: NOW - 30 * MIN }, true, 'working', 'Working'],
    ['working past 30 minutes, running', { evidenceAt: NOW - 30 * MIN - 1 }, true, 'unverifiable', 'No recent update'],
    ['working past 30 minutes, not running', { evidenceAt: NOW - 31 * MIN }, false, 'idle', 'Idle'],
    ['waiting past 30 minutes', { state: 'waiting', display: 'waiting', label: 'Waiting for input', evidenceAt: NOW - 40 * MIN }, true, 'unverifiable', 'No recent update'],
    ['blocked past 30 minutes', { state: 'blocked', display: 'blocked', label: 'Blocked', evidenceAt: NOW - 40 * MIN }, false, 'idle', 'Idle'],
    ['done never decays', { state: 'done', display: 'done', label: 'Done', evidenceAt: 0 }, true, 'done', 'Done'],
    ['failed never decays', { state: 'done', display: 'failed', label: 'Failed', evidenceAt: 0 }, false, 'failed', 'Failed'],
    ['unconfirmed fresh keeps its label', { display: 'unconfirmed', label: "Couldn't confirm" }, true, 'unconfirmed', "Couldn't confirm"],
    ['restored-unconfirmed past 30 minutes, running, stays unconfirmed', { display: 'unconfirmed', label: "Couldn't confirm", restoredUnconfirmed: true, evidenceAt: NOW - 40 * MIN }, true, 'unconfirmed', "Couldn't confirm"],
    ['restored-unconfirmed past 30 minutes, not running, stays unconfirmed', { display: 'unconfirmed', label: "Couldn't confirm", restoredUnconfirmed: true, evidenceAt: NOW - 40 * MIN }, false, 'unconfirmed', "Couldn't confirm"]
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
