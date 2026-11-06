import { describe, expect, test } from 'bun:test'
import type { HostPowerListener } from '@quirky/protocol'
import type { WorktreeState } from '../src/contracts'
import { register } from '../src/keepawake'
import { makeTestApp, sampleMandate } from './support'

function setup(initial: Record<string, WorktreeState> = {}, now = { t: 1_000 }) {
  const test = makeTestApp()
  const states = { ...initial }
  test.app.services.handoff.active = () => Object.entries(states).map(([worktreeId, state]) => ({ worktreeId, sessionId: null, state, mandate: sampleMandate({ worktreeId }) }))
  let listener: HostPowerListener | null = null
  let unsubscribed = 0
  test.hostPower.subscribe = ((next: HostPowerListener) => {
    listener = next
    return () => void unsubscribed++
  }) as never
  test.app.now = () => now.t
  const dispose = register(test.app)
  const change = (worktreeId: string, state: WorktreeState) => {
    states[worktreeId] = state
    test.app.emit({ type: 'state-changed', worktreeId, state })
  }
  return { ...test, states, change, dispose: dispose as () => void, power: () => listener!, unsubscribed: () => unsubscribed, now }
}

const holdsActive = (holds: { active: boolean }[]) => holds.filter((hold) => hold.active).length

describe('keep-awake', () => {
  test('holds one named assertion while any hand-off is in an active state', () => {
    const t = setup({ a: 'working', b: 'working' })
    expect(t.hostPower.holds).toEqual([{ reason: 'avatar: handed-off work', active: true }])

    t.change('a', 'merged')
    expect(holdsActive(t.hostPower.holds)).toBe(1)
    t.change('b', 'parked')
    expect(holdsActive(t.hostPower.holds)).toBe(0)
  })

  test.each(['parked', 'done', 'merged', 'pr-ready', 'committed', 'gate-failed'] as const)('%s does not hold', (state) => {
    expect(holdsActive(setup({ a: state }).hostPower.holds)).toBe(0)
  })

  test.each(['checking', 'briefing', 'working', 'waiting-on-you', 'checking-done', 'in-review', 'merge-ready'] as const)('%s holds', (state) => {
    expect(holdsActive(setup({ a: state }).hostPower.holds)).toBe(1)
  })

  test('takes a new hold when work resumes and never stacks holds', () => {
    const t = setup({})
    expect(t.hostPower.holds).toEqual([])
    t.change('a', 'working')
    t.change('b', 'checking')
    t.app.emit({ type: 'handoffs-changed' })
    expect(t.hostPower.holds).toHaveLength(1)
    t.change('a', 'done')
    t.change('b', 'done')
    t.change('a', 'working')
    expect(t.hostPower.holds.map((hold) => hold.active)).toEqual([false, true])
  })

  test('a take-back that empties the active list releases the hold', () => {
    const t = setup({ a: 'working' })
    delete t.states.a
    t.app.emit({ type: 'handoffs-changed' })
    expect(holdsActive(t.hostPower.holds)).toBe(0)
  })

  test('journals a sleep entry with its duration when the host resumes', () => {
    const t = setup({ a: 'working' })
    t.now.t = 10_000
    t.power().suspend()
    expect(t.app.store.journalSince(0)).toEqual([])
    t.now.t = 70_000
    t.power().resume()
    expect(t.app.store.journalSince(0)).toMatchObject([{ worktreeId: null, kind: 'sleep', data: { at: 10_000, durationMs: 60_000, keptAwake: true } }])
  })

  test('does not journal a sleep when nothing was handed off', () => {
    const t = setup({})
    t.power().suspend()
    t.now.t += 5_000
    t.power().resume()
    expect(t.app.store.journalSince(0)).toEqual([])
  })

  test('the disposer releases the hold and stops listening', () => {
    const t = setup({ a: 'working' })
    t.dispose()
    expect(holdsActive(t.hostPower.holds)).toBe(0)
    expect(t.unsubscribed()).toBe(1)
    t.change('b', 'working')
    expect(t.hostPower.holds).toHaveLength(1)
  })
})
