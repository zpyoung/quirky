import { afterEach, describe, expect, test } from 'bun:test'
import type { AvatarApp, HandoffRow, Level, Mandate, NeedsYouItem, SheetRow, WorktreeState } from '../src/contracts'
import { register } from '../src/report'
import { makeTestApp, sampleMandate } from './support'

const T0 = 1_000_000
const HOUR = 3_600_000

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
})

type Active = { worktreeId: string; sessionId: string | null; state: WorktreeState; mandate: Mandate }

function setup(active: Active[] = [], names: Record<string, string> = {}) {
  const test = makeTestApp()
  const { app } = test
  app.now = () => T0
  app.services.handoff = {
    ...app.services.handoff,
    active: () => active,
    eligibility: async () => Object.entries(names).map(([worktreeId, name]) => ({ worktreeId, name }) as SheetRow)
  }
  for (const entry of active) {
    app.store.mandates.put(entry.mandate)
    app.store.handoffs.put({ worktreeId: entry.worktreeId, state: entry.state, sessionId: entry.sessionId, active: true, handedOffAt: T0 - 8 * HOUR, takenBackAt: null })
  }
  disposers.push(register(app))
  return test
}

function worker(worktreeId: string, state: WorktreeState, level: Level = 'own-branch', mandate: Partial<Mandate> = {}): Active {
  return { worktreeId, sessionId: `s-${worktreeId}`, state, mandate: sampleMandate({ worktreeId, level, ...mandate }) }
}

function addNeed(app: AvatarApp, worktreeId: string, kind: NeedsYouItem['kind'], title: string, detail: Record<string, unknown> = {}) {
  return app.needs.add({ worktreeId, kind, title, detail, actions: ['confirm'] })
}

describe('status and sidebarStatus', () => {
  test('list active handoffs with their level and the open needs count', async () => {
    const { app } = setup([worker('wt-1', 'working', 'full'), worker('wt-2', 'waiting-on-you')], { 'wt-1': 'provider-host' })
    await Bun.sleep(0)
    addNeed(app, 'wt-2', 'guess', 'Confirm a guess?')
    const closed = addNeed(app, 'wt-2', 'question', 'Old question')
    app.needs.close(closed.id, 'answered')

    expect(app.services.report.status()).toEqual({
      handoffs: [
        { worktreeId: 'wt-1', name: 'provider-host', state: 'working', level: 'full' },
        { worktreeId: 'wt-2', name: 'wt-2', state: 'waiting-on-you', level: 'own-branch' }
      ],
      needsYouCount: 1
    })
    expect(app.services.report.sidebarStatus()).toEqual({
      'wt-1': { state: 'working', level: 'full', needsYou: 0 },
      'wt-2': { state: 'waiting-on-you', level: 'own-branch', needsYou: 1 }
    })
  })
})

describe('report', () => {
  test('is empty when nothing is handed off', () => {
    const { app } = setup()
    expect(app.services.report.report()).toEqual({
      needsYou: [],
      stories: [],
      summary: { decisions: 0, allowed: 0, denied: 0, held: 0, guesses: 0, sleeps: [], keptAwake: false },
      topSkippedCalls: []
    })
  })

  test('lists open needs oldest first and leaves closed ones out', () => {
    const { app } = setup([worker('wt-1', 'waiting-on-you')])
    let clock = T0
    app.now = () => clock++
    const second = addNeed(app, 'wt-1', 'guess', 'Second')
    const first = addNeed(app, 'wt-1', 'question', 'Third')
    const done = addNeed(app, 'wt-1', 'parked', 'Closed')
    app.needs.close(done.id, 'confirmed')

    expect(app.services.report.report().needsYou.map((need) => need.id)).toEqual([second.id, first.id])
  })

  test('tells one story per handed-off worktree with the switches that are on', () => {
    const { app } = setup(
      [
        worker('wt-1', 'working', 'full', { goal: 'Ship badges', switches: { messaging: true, historyRewrite: false, deploys: true } }),
        worker('wt-2', 'parked', 'own-branch', { goal: 'Fix restart' })
      ],
      { 'wt-1': 'agent-tabs', 'wt-2': 'provider-host' }
    )
    addNeed(app, 'wt-2', 'parked', 'Allow a force-push?', { story: 'Parked on the force-push.' })

    const { stories } = app.services.report.report()
    expect(stories.map((story) => story.worktreeId)).toEqual(['wt-1', 'wt-2'])
    expect(stories[0]).toMatchObject({ switchesOn: ['messaging', 'deploys'], story: 'Ship badges. Working.', handedBackWith: [] })
    expect(stories[1]).toMatchObject({ switchesOn: [], story: 'Fix restart. Parked on the force-push. 1 item needs you.' })
  })

  test('adds a recently handed-back worktree with what it was handed back with', () => {
    const { app } = setup([worker('wt-1', 'working')])
    const need = addNeed(app, 'wt-2', 'held-call', '1 held force-push')
    app.needs.close(need.id, 'handed-back')
    app.store.mandates.put(sampleMandate({ worktreeId: 'wt-2', goal: 'Fix restart', switches: { messaging: false, historyRewrite: true, deploys: false } }))
    const row: HandoffRow = { worktreeId: 'wt-2', state: 'working', sessionId: null, active: false, handedOffAt: T0 - 6 * HOUR, takenBackAt: T0 - HOUR }
    app.store.handoffs.put(row)
    app.store.handoffs.put({ ...row, worktreeId: 'wt-3', takenBackAt: T0 - 48 * HOUR })

    const { stories } = app.services.report.report()
    expect(stories.map((story) => story.worktreeId)).toEqual(['wt-1', 'wt-2'])
    expect(stories[1]).toMatchObject({ switchesOn: ['historyRewrite'], handedBackWith: ['1 held force-push'] })
    expect(stories[1]?.story).toContain('Handed back to you')
  })

  test('counts gate decisions, guesses and sleeps from the journal since hand-off', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - 10 * HOUR
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    app.now = () => T0 - HOUR
    for (const outcome of ['allow', 'allow', 'deny', 'held', 'passthrough', 'retry']) app.journal('wt-1', 'gate', { outcome })
    app.journal('wt-1', 'guess', { question: 'q' })
    app.journal(null, 'sleep', { durationMs: 90_000 })
    app.journal('wt-1', 'event', {})

    expect(app.services.report.report().summary).toEqual({
      decisions: 5,
      allowed: 2,
      denied: 1,
      held: 1,
      guesses: 1,
      sleeps: [{ at: T0 - HOUR, durationMs: 90_000 }],
      keptAwake: true
    })
  })

  test('says the Mac is not held awake when every worktree waits on someone', () => {
    const { app } = setup([worker('wt-1', 'waiting-on-you'), worker('wt-2', 'parked')])
    expect(app.services.report.report().summary.keptAwake).toBe(false)
  })

  test('puts skipped calls that would have been stopped at the top, newest first', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - HOUR
    const push = app.journal('wt-1', 'skipped-call', { toolName: 'Bash', outcome: 'deny', summary: 'git push origin main' })
    app.journal('wt-1', 'skipped-call', { toolName: 'Bash', outcome: 'allow', summary: 'bun test' })
    const forced = app.journal('wt-1', 'skipped-call', { toolName: 'Bash', wouldHaveStopped: true })
    app.journal('wt-9', 'skipped-call', { toolName: 'Bash', outcome: 'deny' })
    app.now = () => T0 - 9 * HOUR
    app.journal('wt-1', 'skipped-call', { toolName: 'Bash', outcome: 'deny' })
    app.now = () => T0

    expect(app.services.report.report().topSkippedCalls.map((entry) => entry.seq)).toEqual([forced.seq, push.seq])
  })
})

describe('changed events', () => {
  test('emit once per 250 ms window however many bus events arrive', async () => {
    const { app, emitted } = setup()
    app.emit({ type: 'needs-changed' })
    app.emit({ type: 'handoffs-changed' })
    app.journal(null, 'event', {})
    expect(emitted).toEqual([])

    await Bun.sleep(320)
    expect(emitted).toEqual([{ event: 'changed', data: { type: 'journal' } }])

    app.emit({ type: 'needs-changed' })
    await Bun.sleep(320)
    expect(emitted.length).toBe(2)
  })

  test('stop after the disposer runs', async () => {
    const { app, emitted } = setup()
    for (const dispose of disposers.splice(0)) dispose()
    app.emit({ type: 'needs-changed' })
    await Bun.sleep(320)
    expect(emitted).toEqual([])
  })

  test('refresh worktree names before the view reloads', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')])
    app.services.handoff = { ...app.services.handoff, eligibility: async () => [{ worktreeId: 'wt-1', name: 'late-name' } as SheetRow] }
    app.emit({ type: 'handoffs-changed' })
    await Bun.sleep(320)
    expect(emitted.length).toBe(1)
    expect(app.services.report.status().handoffs[0]?.name).toBe('late-name')
  })
})
