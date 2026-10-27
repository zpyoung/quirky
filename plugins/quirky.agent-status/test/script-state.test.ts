import { describe, expect, test } from 'bun:test'
import type { Session } from '@quirky/protocol'
import { newRow } from '../src/apply'
import { STALE_AFTER_MS } from '../src/model'
import { scriptState } from '../src/script-state'
import type { AgentRow, EvidenceSource } from '../src/types'
import type { Verdict } from '../src/rules/types'
import { claudeSession } from './support'

const NOW = 10_000_000
const origin = { kind: 'built-in', path: '/rules/claude.json' } as const

const running: Session = claudeSession
const exited: Session = { ...claudeSession, status: 'exited', exitCode: 0 }

function row(state: AgentRow['state'], source: EvidenceSource = 'hook', extra: Partial<AgentRow> = {}): AgentRow {
  const base = newRow({ sessionId: 's1', source: 'claude', at: NOW - 1000, replay: false })
  return { ...base, state, source, lead: { ...base.lead, state }, ...extra }
}

const verdict = (state: Verdict['state'], kind?: Verdict['kind']): Verdict => ({ rule: `${state}-rule`, state, ...(kind ? { kind } : {}), origin })

describe('script state precedence', () => {
  test('an exited session is exited whatever else is known', () => {
    expect(scriptState({ session: exited, row: row('working'), verdict: verdict('blocked', 'approval'), now: NOW })).toEqual({ state: 'exited', decidedBy: 'session' })
  })

  test('a blocked rule outranks a fresh hook row that says working', () => {
    expect(scriptState({ session: running, row: row('working'), verdict: verdict('blocked', 'approval'), now: NOW })).toEqual({
      state: 'blocked',
      kind: 'approval',
      decidedBy: 'rule'
    })
  })

  test('a blocked rule carries its kind, and defaults to approval', () => {
    expect(scriptState({ session: running, row: null, verdict: verdict('blocked', 'question'), now: NOW })).toMatchObject({ state: 'blocked', kind: 'question' })
    expect(scriptState({ session: running, row: null, verdict: verdict('blocked'), now: NOW })).toMatchObject({ state: 'blocked', kind: 'approval' })
  })

  test.each([
    ['working', 'working', undefined],
    ['waiting', 'blocked', 'approval'],
    ['blocked', 'blocked', 'approval'],
    ['done', 'idle', undefined]
  ] as const)('a fresh hook row in %s reads %s', (rowState, expected, kind) => {
    const result = scriptState({ session: running, row: row(rowState), verdict: null, now: NOW })
    expect(result).toEqual({ state: expected, ...(kind ? { kind } : {}), decidedBy: 'row' })
  })

  test('a replayed row counts as a hook row', () => {
    expect(scriptState({ session: running, row: row('working', 'replay'), verdict: verdict('idle'), now: NOW })).toEqual({ state: 'working', decidedBy: 'row' })
  })

  test('a waiting row with a question reads as a question', () => {
    const asking = row('waiting', 'hook', { question: '{"questions":[{"question":"Which branch?"}]}' })
    expect(scriptState({ session: running, row: asking, verdict: null, now: NOW })).toEqual({ state: 'blocked', kind: 'question', decidedBy: 'row' })
  })

  test('a fresh hook row outranks a working or idle rule', () => {
    expect(scriptState({ session: running, row: row('done'), verdict: verdict('working'), now: NOW })).toMatchObject({ state: 'idle', decidedBy: 'row' })
    expect(scriptState({ session: running, row: row('working'), verdict: verdict('idle'), now: NOW })).toMatchObject({ state: 'working', decidedBy: 'row' })
  })

  test.each(['working', 'idle'] as const)('with no fresh hook row a %s rule decides', (state) => {
    expect(scriptState({ session: running, row: null, verdict: verdict(state), now: NOW })).toEqual({ state, decidedBy: 'rule' })
  })

  test('a stale hook row yields to a working or idle rule', () => {
    const stale = row('working', 'hook', { evidenceAt: NOW - STALE_AFTER_MS - 1 })
    expect(scriptState({ session: running, row: stale, verdict: verdict('idle'), now: NOW })).toEqual({ state: 'idle', decidedBy: 'rule' })
  })

  test.each(['title', 'program-status', 'inference'] as const)('a fresh %s row decides when no rule does', (source) => {
    expect(scriptState({ session: running, row: row('done', source), verdict: null, now: NOW })).toEqual({ state: 'idle', decidedBy: 'row' })
  })

  test('a rule outranks a title row', () => {
    expect(scriptState({ session: running, row: row('working', 'title'), verdict: verdict('idle'), now: NOW })).toEqual({ state: 'idle', decidedBy: 'rule' })
  })

  test('no row and no verdict is unknown', () => {
    expect(scriptState({ session: running, row: null, verdict: null, now: NOW })).toEqual({ state: 'unknown', decidedBy: 'none' })
  })

  test('a working row 31 minutes old with no verdict is unknown, not working', () => {
    const stale = row('working', 'hook', { evidenceAt: NOW - 31 * 60_000 })
    expect(scriptState({ session: running, row: stale, verdict: null, now: NOW })).toEqual({ state: 'unknown', decidedBy: 'none' })
  })

  test.each(['hook', 'replay', 'title', 'program-status', 'inference'] as const)('a done %s row two hours old still reads idle', (source) => {
    const old = row('done', source, { evidenceAt: NOW - 2 * 60 * 60_000 })
    expect(scriptState({ session: running, row: old, verdict: null, now: NOW })).toEqual({ state: 'idle', decidedBy: 'row' })
  })

  test('a row is fresh at exactly 30 minutes and stale one millisecond later', () => {
    const edge = row('working', 'hook', { evidenceAt: NOW - STALE_AFTER_MS })
    expect(scriptState({ session: running, row: edge, verdict: null, now: NOW })).toMatchObject({ state: 'working', decidedBy: 'row' })
    expect(scriptState({ session: running, row: edge, verdict: null, now: NOW + 1 })).toMatchObject({ state: 'unknown' })
  })

  test('a row restored after a restart is unconfirmed, so not trusted', () => {
    const restored = row('working', 'hook', { restoredUnconfirmed: true })
    expect(scriptState({ session: running, row: restored, verdict: null, now: NOW })).toEqual({ state: 'unknown', decidedBy: 'none' })
    expect(scriptState({ session: running, row: restored, verdict: verdict('idle'), now: NOW })).toEqual({ state: 'idle', decidedBy: 'rule' })
  })
})
