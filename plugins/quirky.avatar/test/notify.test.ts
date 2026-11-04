import { afterEach, describe, expect, test } from 'bun:test'
import type { Mandate, WorktreeState } from '../src/contracts'
import { register } from '../src/notify'
import { makeTestApp, sampleMandate } from './support'

type Active = { worktreeId: string; sessionId: string | null; state: WorktreeState; mandate: Mandate }

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

function setup(initial: Record<string, WorktreeState>) {
  const test = makeTestApp()
  const states = new Map(Object.entries(initial))
  const active = (): Active[] =>
    [...states].map(([worktreeId, state]) => ({ worktreeId, sessionId: null, state, mandate: sampleMandate({ worktreeId }) }))
  test.app.services.handoff = { ...test.app.services.handoff, active }
  disposers.push(register(test.app))
  return {
    ...test,
    setState(worktreeId: string, state: WorktreeState) {
      states.set(worktreeId, state)
      test.app.emit({ type: 'state-changed', worktreeId, state })
    }
  }
}

describe('needs-you notification', () => {
  test('sends one notification when every handed-off worktree waits on you', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'working' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'Allow a force-push?', detail: {}, actions: ['allow-once', 'deny'] })
    expect(notifications).toEqual([])

    setState('wt-1', 'parked')
    expect(notifications).toEqual([])
    setState('wt-2', 'waiting-on-you')

    expect(notifications).toEqual([
      {
        title: 'Avatar needs you',
        body: 'All 2 handed-off worktrees are waiting on you: 1 held call.',
        actions: [{ label: 'Open report', command: 'command:quirky.avatar/open-report' }],
        key: 'quirky.avatar/needs-you'
      }
    ])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(1)
  })

  test('counts each kind of open need in the body', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'working', 'wt-3': 'working' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })
    app.needs.add({ worktreeId: 'wt-2', kind: 'mandate-edit', title: 'm', detail: {}, actions: ['review-accept'] })
    expect(notifications).toEqual([])
    app.needs.add({ worktreeId: 'wt-3', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })

    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.body).toBe('All 3 handed-off worktrees are waiting on you: 1 held call, 1 guess to confirm, 1 mandate edit.')
  })

  test('falls back to a state count when nothing is queued', () => {
    const { notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'parked' })
    setState('wt-1', 'waiting-on-you')
    expect(notifications[0]?.body).toBe('All 2 handed-off worktrees are waiting on you: 2 waiting on you.')
  })

  test('stays quiet while any worktree still has work in flight', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'parked' })
    app.needs.add({ worktreeId: 'wt-2', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })
    setState('wt-2', 'parked')
    expect(notifications).toEqual([])
  })

  test('sends again only after the condition has turned false and true again', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'parked', 'wt-2': 'parked' })
    setState('wt-1', 'parked')
    setState('wt-2', 'parked')
    app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })
    expect(notifications).toHaveLength(1)

    setState('wt-1', 'waiting-on-you')
    app.emit({ type: 'needs-changed' })
    expect(notifications).toHaveLength(1)

    setState('wt-1', 'working')
    setState('wt-2', 'working')
    setState('wt-1', 'parked')
    expect(notifications).toHaveLength(1)
    setState('wt-2', 'parked')
    expect(notifications).toHaveLength(2)
  })

  test('sends when an open held call is the only way forward and the rest is finished', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'merged' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })
    expect(notifications).toHaveLength(1)
    setState('wt-2', 'merged')
    expect(notifications).toHaveLength(1)
  })

  test('does not treat a held call as the only way forward while another worktree is working', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'working' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })
    expect(notifications).toEqual([])
  })

  test('is silent without handed-off worktrees and ignores journal events', () => {
    const { app, notifications } = setup({})
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })
    app.journal('wt-1', 'event', {})
    expect(notifications).toEqual([])
  })

  test('stops listening after the disposer runs', () => {
    const { app, notifications } = setup({ 'wt-1': 'parked' })
    for (const dispose of disposers.splice(0)) dispose()
    app.emit({ type: 'needs-changed' })
    expect(notifications).toEqual([])
  })
})
