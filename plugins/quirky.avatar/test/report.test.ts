import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test'
import type { AvatarApp, HandoffRow, Level, Mandate, NeedsYouItem, SheetRow, WorktreeState } from '../src/contracts'
import { register } from '../src/report'
import { makeTestApp, sampleMandate } from './support'
import { PluginEvents } from '../../../packages/daemon/src/plugins/events'
import type { PluginHost } from '../../../packages/daemon/src/plugins/host'
import manifest from '../quirky-plugin.json'

const T0 = 1_000_000
const HOUR = 3_600_000

const disposers: (() => void)[] = []
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose()
  jest.useRealTimers()
})

type Active = { worktreeId: string; sessionId: string | null; state: WorktreeState; mandate: Mandate }

function setup(active: Active[] = [], names: Record<string, string> = {}, projects: Record<string, string> = {}) {
  const test = makeTestApp()
  const { app } = test
  app.now = () => T0
  app.services.handoff = {
    ...app.services.handoff,
    active: () => active,
    eligibility: async () => Object.entries(names).map(([worktreeId, name]) => ({ worktreeId, name, projectName: projects[worktreeId] ?? '' }) as SheetRow)
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
        { worktreeId: 'wt-1', name: 'provider-host', projectName: '', state: 'working', level: 'full' },
        { worktreeId: 'wt-2', name: 'wt-2', projectName: '', state: 'waiting-on-you', level: 'own-branch' }
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

  test('does not claim the agent is still running after a take-back', () => {
    const { app } = setup()
    app.store.mandates.put(sampleMandate({ worktreeId: 'wt-2', goal: 'Fix restart' }))
    app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: null, active: false, handedOffAt: T0 - 6 * HOUR, takenBackAt: T0 - HOUR })

    const story = app.services.report.report().stories[0]?.story
    expect(story).toBe('Fix restart. Handed back to you. The avatar no longer decides for it.')
    expect(story).not.toContain('still running')
  })

  test('carries the project name on stories, needs and status', async () => {
    const { app } = setup([worker('wt-1', 'working')], { 'wt-1': 'main' }, { 'wt-1': 'harbor-api' })
    await Bun.sleep(0)
    addNeed(app, 'wt-1', 'guess', 'Confirm a guess?')

    const model = app.services.report.report()
    expect(model.stories[0]).toMatchObject({ name: 'main', projectName: 'harbor-api' })
    expect(model.needsYou[0]).toMatchObject({ worktreeName: 'main', projectName: 'harbor-api' })
    expect(app.services.report.status().handoffs[0]).toMatchObject({ name: 'main', projectName: 'harbor-api' })
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

function recordReads(app: AvatarApp): number[] {
  const reads: number[] = []
  const journalSince = app.store.journalSince.bind(app.store)
  app.store.journalSince = (...args) => {
    const rows = journalSince(...args)
    reads.push(rows.length)
    return rows
  }
  return reads
}

describe('summary reads', () => {
  test('reads each journal row once however often the report is asked for', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - 10 * HOUR
    for (let i = 0; i < 1000; i++) app.journal('wt-1', 'gate', { outcome: 'allow' })
    app.now = () => T0 - HOUR
    const reads = recordReads(app)
    expect(app.services.report.report().summary.allowed).toBe(0)
    for (let i = 0; i < 100; i++) app.journal('wt-1', 'gate', { outcome: 'allow' })
    expect(app.services.report.report().summary.allowed).toBe(100)
    expect(app.services.report.report().summary.allowed).toBe(100)
    expect(reads).toEqual([0, 100, 0])
  })

  test('reads rows of other kinds only as they arrive', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - HOUR
    for (let i = 0; i < 50; i++) app.journal('wt-1', 'event', {})
    app.journal('wt-1', 'gate', { outcome: 'deny' })
    const reads = recordReads(app)
    expect(app.services.report.report().summary).toMatchObject({ decisions: 1, denied: 1 })
    for (let i = 0; i < 20; i++) app.journal('wt-1', 'event', {})
    expect(app.services.report.report().summary).toMatchObject({ decisions: 1, denied: 1 })
    expect(app.services.report.report().summary).toMatchObject({ decisions: 1, denied: 1 })
    expect(reads).toEqual([1, 20, 0])
  })

  test('counts again from the journal when the set of hand-offs changes', () => {
    const active = [worker('wt-1', 'working')]
    const { app } = setup(active)
    app.now = () => T0 - 10 * HOUR
    app.journal('wt-1', 'gate', { outcome: 'held' })
    const earlier = app.journal('wt-2', 'skipped-call', { outcome: 'deny' })
    app.now = () => T0 - HOUR
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    const later = app.journal('wt-2', 'skipped-call', { outcome: 'deny' })
    expect(app.services.report.report()).toMatchObject({ summary: { allowed: 1, held: 0 }, topSkippedCalls: [] })
    active.push(worker('wt-2', 'working'))
    app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: 's-wt-2', active: true, handedOffAt: T0 - 12 * HOUR, takenBackAt: null })
    expect(app.services.report.report()).toMatchObject({ summary: { allowed: 1, held: 1 }, topSkippedCalls: [later, earlier] })
  })

  test('counts again when a hand-off joins without moving the start time', () => {
    const active = [worker('wt-1', 'working')]
    const { app } = setup(active)
    app.now = () => T0 - HOUR
    const skipped = app.journal('wt-2', 'skipped-call', { outcome: 'deny' })
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    expect(app.services.report.report()).toMatchObject({ summary: { allowed: 1 }, topSkippedCalls: [] })
    active.push(worker('wt-2', 'working'))
    app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: 's-wt-2', active: true, handedOffAt: T0 - 2 * HOUR, takenBackAt: null })
    expect(app.services.report.report()).toMatchObject({ summary: { allowed: 1 }, topSkippedCalls: [skipped] })
  })

  test('counts again when a handed-back worktree moves the start time and the hand-offs stay the same', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - 10 * HOUR
    app.journal('wt-1', 'gate', { outcome: 'held' })
    app.now = () => T0
    expect(app.services.report.report().summary.decisions).toBe(0)
    app.store.handoffs.put({ worktreeId: 'wt-2', state: 'working', sessionId: null, active: false, handedOffAt: T0 - 12 * HOUR, takenBackAt: T0 - HOUR })
    expect(app.services.report.report().summary).toMatchObject({ decisions: 1, held: 1 })
  })

  test('leaves out a new row whose time is before the hand-off', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - HOUR
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    expect(app.services.report.report().summary.allowed).toBe(1)
    app.now = () => T0 - 9 * HOUR
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    app.journal('wt-1', 'skipped-call', { outcome: 'deny' })
    app.now = () => T0
    expect(app.services.report.report()).toMatchObject({ summary: { allowed: 1 }, topSkippedCalls: [] })
  })

  test('is zero with nothing handed off and counts from the journal on the next hand-off', () => {
    const active = [worker('wt-1', 'working')]
    const { app } = setup(active)
    app.now = () => T0 - HOUR
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    app.now = () => T0
    expect(app.services.report.report().summary.allowed).toBe(1)
    const handoff = app.store.handoffs.get('wt-1')!
    active.pop()
    app.store.handoffs.put({ ...handoff, active: false, takenBackAt: T0 - 30 * HOUR })
    const reads = recordReads(app)
    expect(app.services.report.report().summary).toEqual({ decisions: 0, allowed: 0, denied: 0, held: 0, guesses: 0, sleeps: [], keptAwake: false })
    expect(reads).toEqual([])
    app.journal('wt-1', 'gate', { outcome: 'allow' })
    active.push(worker('wt-1', 'working'))
    app.store.handoffs.put({ ...handoff, active: true, takenBackAt: null })
    expect(app.services.report.report().summary.allowed).toBe(2)
  })

  test('keeps the ten newest skipped calls as more arrive', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - HOUR
    const skipped = Array.from({ length: 12 }, () => app.journal('wt-1', 'skipped-call', { outcome: 'deny' }))
    expect(app.services.report.report().topSkippedCalls).toEqual(skipped.slice(-10).reverse())
    for (let i = 0; i < 3; i++) skipped.push(app.journal('wt-1', 'skipped-call', { wouldHaveStopped: true }))
    expect(app.services.report.report().topSkippedCalls).toEqual(skipped.slice(-10).reverse())
  })

  test('gives each caller its own lists', () => {
    const { app } = setup([worker('wt-1', 'working')])
    app.now = () => T0 - HOUR
    app.journal('wt-1', 'sleep', { durationMs: 50 })
    app.journal('wt-1', 'skipped-call', { outcome: 'deny' })
    const first = app.services.report.report()
    first.summary.sleeps.length = 0
    first.topSkippedCalls.length = 0
    const next = app.services.report.report()
    expect(next.summary.sleeps).toEqual([{ at: T0 - HOUR, durationMs: 50 }])
    expect(next.topSkippedCalls).toHaveLength(1)
  })
})

// bun 1.4 supports advancing timers, but the locked 1.3 typings omit it.
const testClock = jest as unknown as { advanceTimersByTime(ms: number): void }

async function advanceRefreshTimer(): Promise<void> {
  testClock.advanceTimersByTime(320)
  await Promise.resolve()
}

describe('changed events', () => {
  beforeEach(() => { jest.useFakeTimers() })

  test('announce every bus event at once, in order, and nothing later', async () => {
    const { app, emitted } = setup()
    app.emit({ type: 'needs-changed' })
    app.emit({ type: 'handoffs-changed' })
    app.journal(null, 'event', {})
    const expected = ['needs-changed', 'handoffs-changed', 'journal'].map((type) => ({ event: 'changed', data: { type } }))
    expect(emitted).toEqual(expected)
    await advanceRefreshTimer()
    expect(emitted).toEqual(expected)
  })

  test('a burst of 100 journal entries is 100 emits and one more name refresh', async () => {
    const { app, emitted } = setup()
    let refreshes = 0
    app.services.handoff.eligibility = async () => { refreshes++; return [] }
    for (let i = 0; i < 100; i++) app.journal(null, 'event', {})
    expect(emitted).toHaveLength(100)
    await advanceRefreshTimer()
    expect(emitted).toHaveLength(100)
    expect(refreshes).toBe(1)
  })

  test('the daemon sends a burst of 100 journal entries as two events, as the manifest declares', async () => {
    // real time verifies the daemon coalescer's platform timers rather than a mocked clock.
    jest.useRealTimers()
    const { app, context } = setup()
    const contributions = manifest.contributes.event.map((data) => ({ id: `event:quirky.avatar/${data.id}`, plugin: 'quirky.avatar', data }))
    const sent: unknown[] = []
    const events = new PluginEvents({ contributions: () => contributions } as unknown as PluginHost, (event) => sent.push(event), () => {})
    disposers.push(() => events.removeAll('quirky.avatar'))
    context.emit = (event, data) => events.emit('quirky.avatar', event, data)
    for (let i = 0; i < 100; i++) app.journal(null, 'event', {})
    const expected = { type: 'quirky.avatar/changed', data: { type: 'journal' } }
    expect(sent).toEqual([expected])
    await Bun.sleep(320)
    expect(sent).toEqual([expected, expected])
    await Bun.sleep(320)
    expect(sent).toEqual([expected, expected])
  })

  test('stop after the disposer runs', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')])
    app.services.handoff.eligibility = async () => [{ worktreeId: 'wt-1', name: 'late-name' } as SheetRow]
    app.emit({ type: 'handoffs-changed' })
    const before = emitted.length
    for (const dispose of disposers.splice(0)) dispose()
    app.emit({ type: 'needs-changed' })
    await advanceRefreshTimer()
    expect(emitted).toHaveLength(before)
  })

  test('announce again once a refresh has changed a worktree name', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')])
    await Promise.resolve()
    expect(emitted).toEqual([])
    app.services.handoff.eligibility = async () => [{ worktreeId: 'wt-1', name: 'late-name' } as SheetRow]
    app.emit({ type: 'handoffs-changed' })
    await Promise.resolve()
    const expected = ['handoffs-changed', 'names-changed'].map((type) => ({ event: 'changed', data: { type } }))
    expect(emitted).toEqual(expected)
    expect(app.services.report.status().handoffs[0]?.name).toBe('late-name')
    await advanceRefreshTimer()
    expect(emitted).toEqual(expected)
  })

  test('announce the names found at start, and nothing when a refresh finds the same names', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')], { 'wt-1': 'provider-host' }, { 'wt-1': 'harbor-api' })
    await Promise.resolve()
    expect(emitted).toEqual([{ event: 'changed', data: { type: 'names-changed' } }])
    app.emit({ type: 'state-changed', worktreeId: 'wt-1', state: 'working' })
    await advanceRefreshTimer()
    expect(emitted).toEqual(['names-changed', 'state-changed'].map((type) => ({ event: 'changed', data: { type } })))
  })

  test('announce a changed worktree name after journal traffic alone', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')], { 'wt-1': 'old-name' }, { 'wt-1': 'harbor-api' })
    await Promise.resolve()
    app.services.handoff.eligibility = async () => [{ worktreeId: 'wt-1', name: 'new-name', projectName: 'harbor-api' } as SheetRow]
    app.journal(null, 'event', {})
    await advanceRefreshTimer()
    expect(emitted).toEqual(['names-changed', 'journal', 'names-changed'].map((type) => ({ event: 'changed', data: { type } })))
    expect(app.services.report.status().handoffs[0]?.name).toBe('new-name')
  })

  test('announce a changed project name', async () => {
    const { app, emitted } = setup([worker('wt-1', 'working')], { 'wt-1': 'main' }, { 'wt-1': 'harbor-api' })
    await Promise.resolve()
    app.services.handoff.eligibility = async () => [{ worktreeId: 'wt-1', name: 'main', projectName: 'harbor-web' } as SheetRow]
    app.journal(null, 'event', {})
    await advanceRefreshTimer()
    expect(emitted).toEqual(['names-changed', 'journal', 'names-changed'].map((type) => ({ event: 'changed', data: { type } })))
    expect(app.services.report.status().handoffs[0]?.projectName).toBe('harbor-web')
  })

  test('a failed name refresh is logged and announces nothing', async () => {
    const { app, context, emitted } = setup([worker('wt-1', 'working')])
    const logs: string[] = []
    context.log = (message) => { logs.push(message) }
    app.services.handoff.eligibility = async () => { throw new Error('offline') }
    app.emit({ type: 'handoffs-changed' })
    await advanceRefreshTimer()
    expect(emitted).toEqual([{ event: 'changed', data: { type: 'handoffs-changed' } }])
    expect(logs).toEqual(Array(2).fill('avatar report could not refresh worktree names: offline'))
  })
})
