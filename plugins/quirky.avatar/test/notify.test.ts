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

  for (const finishedState of ['done', 'merged', 'pr-ready', 'committed'] as const) {
    test(`notifies for an open guess when a peer is ${finishedState}`, () => {
      const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': finishedState })
      const body = 'Waiting on you: 1 of 2 handed-off worktrees; 1 guess to confirm.'
      const expectedNotification = {
        title: 'Avatar needs you',
        body,
        actions: [{ label: 'Open report', command: 'command:quirky.avatar/open-report' }],
        key: 'quirky.avatar/needs-you'
      }
      app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })

      expect(notifications).toEqual([expectedNotification])
      expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify').map((entry) => entry.data)).toEqual([
        { title: 'Avatar needs you', body }
      ])

      app.emit({ type: 'needs-changed' })
      app.emit({ type: 'handoffs-changed' })
      expect(notifications).toEqual([expectedNotification])
      expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(1)
    })
  }

  test('counts only waiting worktrees in the mixed-group fallback body', () => {
    const { app, notifications } = setup({ 'wt-1': 'parked', 'wt-2': 'merged' })
    app.emit({ type: 'needs-changed' })

    expect(notifications[0]?.body).toBe('Waiting on you: 1 of 2 handed-off worktrees; 1 waiting on you.')
  })

  test('a finished hand-off with its own open need still counts as waiting', () => {
    const { app, notifications } = setup({ 'wt-1': 'done', 'wt-2': 'merged' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'question', title: 'q', detail: {}, actions: ['answer'] })

    expect(notifications).toEqual([
      {
        title: 'Avatar needs you',
        body: 'Waiting on you: 1 of 2 handed-off worktrees; 1 question.',
        actions: [{ label: 'Open report', command: 'command:quirky.avatar/open-report' }],
        key: 'quirky.avatar/needs-you'
      }
    ])
  })

  test('falls back to a state count when nothing is queued', () => {
    const { notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'parked' })
    setState('wt-1', 'waiting-on-you')
    expect(notifications[0]?.body).toBe('All 2 handed-off worktrees are waiting on you: 2 waiting on you.')
  })

  test('does not treat merge-ready as a finished peer for a non-held need', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'merge-ready' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })

    expect(notifications).toEqual([])
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

  test('re-notifies after work resumes, its need clears, and the need is added again', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'done' })
    const guess = app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })
    const expectedNotification = {
      title: 'Avatar needs you',
      body: 'Waiting on you: 1 of 2 handed-off worktrees; 1 guess to confirm.',
      actions: [{ label: 'Open report', command: 'command:quirky.avatar/open-report' }],
      key: 'quirky.avatar/needs-you'
    }
    expect(notifications).toEqual([expectedNotification])

    setState('wt-1', 'waiting-on-you')
    setState('wt-1', 'working')
    app.needs.close(guess.id, 'confirmed')
    expect(notifications).toEqual([expectedNotification])
    app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })

    expect(notifications).toEqual([expectedNotification, expectedNotification])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify').map((entry) => entry.data)).toEqual([
      { title: 'Avatar needs you', body: expectedNotification.body },
      { title: 'Avatar needs you', body: expectedNotification.body }
    ])
  })

  test('stays quiet when all hand-offs finish without open needs', () => {
    const { app, notifications, setState } = setup({ 'wt-1': 'working', 'wt-2': 'working' })
    setState('wt-1', 'done')
    setState('wt-2', 'merged')
    app.emit({ type: 'handoffs-changed' })

    expect(notifications).toEqual([])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(0)
  })

  test('sends when an open held call is the only way forward and the rest is finished', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'merged' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })
    expect(notifications).toHaveLength(1)
    expect(notifications[0]?.body).toBe('Waiting on you: 1 of 2 handed-off worktrees; 1 held call.')
  })

  test('the held-call exception still permits a merge-ready peer', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'merge-ready' })
    app.needs.add({ worktreeId: 'wt-1', kind: 'held-call', title: 'h', detail: {}, actions: ['deny'] })

    expect(notifications[0]?.body).toBe('Waiting on you: 1 of 2 handed-off worktrees; 1 held call.')
  })

  test('orphan held calls from inactive and unknown worktrees do not notify', () => {
    const { app, notifications } = setup({ 'wt-1': 'done' })
    app.store.handoffs.put({
      worktreeId: 'wt-inactive', state: 'working', sessionId: null, active: false, handedOffAt: 1, takenBackAt: 2
    })
    app.needs.add({ worktreeId: 'wt-inactive', kind: 'held-call', title: 'inactive', detail: {}, actions: ['deny'] })
    app.needs.add({ worktreeId: 'wt-unknown', kind: 'held-call', title: 'unknown', detail: {}, actions: ['deny'] })
    app.emit({ type: 'needs-changed' })

    expect(notifications).toEqual([])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(0)
  })

  test('does not count an orphan held call alongside a live guess', () => {
    const { app, notifications } = setup({ 'wt-1': 'working', 'wt-2': 'done' })
    app.store.handoffs.put({
      worktreeId: 'wt-inactive', state: 'working', sessionId: null, active: false, handedOffAt: 1, takenBackAt: 2
    })
    app.needs.add({ worktreeId: 'wt-inactive', kind: 'held-call', title: 'inactive', detail: {}, actions: ['deny'] })
    expect(notifications).toEqual([])
    app.needs.add({ worktreeId: 'wt-1', kind: 'guess', title: 'g', detail: {}, actions: ['confirm'] })

    expect(notifications).toEqual([
      {
        title: 'Avatar needs you',
        body: 'Waiting on you: 1 of 2 handed-off worktrees; 1 guess to confirm.',
        actions: [{ label: 'Open report', command: 'command:quirky.avatar/open-report' }],
        key: 'quirky.avatar/needs-you'
      }
    ])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify').map((entry) => entry.data)).toEqual([
      {
        title: 'Avatar needs you',
        body: 'Waiting on you: 1 of 2 handed-off worktrees; 1 guess to confirm.'
      }
    ])
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
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(0)
  })

  test('stops listening after the disposer runs', () => {
    const { app, notifications } = setup({ 'wt-1': 'parked' })
    for (const dispose of disposers.splice(0)) dispose()
    app.emit({ type: 'needs-changed' })
    expect(notifications).toEqual([])
    expect(app.store.journalSince(0).filter((entry) => entry.kind === 'notify')).toHaveLength(0)
  })
})
