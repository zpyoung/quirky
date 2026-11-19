import { describe, expect, test } from 'bun:test'
import { createLadder } from '../src/supervisor/ladder'
import type { StuckSignal } from '../src/supervisor/stuck'
import { makeTestApp, sampleMandate } from './support'

const signal: StuckSignal = { kind: 'done-when-repeat', detail: 'done when failed the same way 3 times in a row' }

function setup() {
  const t = makeTestApp()
  t.app.store.mandates.put(sampleMandate({ goal: 'Fix the two failing checks', doneWhen: 'bun test packages/x' }))
  t.app.now = () => 50_000
  t.fakeCalls['quirky.checks/run'] = () => ({ ran: true, pass: true, stdoutTail: ' src/a.ts | 4 ++--\n 1 file changed', stderrTail: '' })
  const sent: string[] = []
  const restarts: string[] = []
  const parks: string[] = []
  let sendResult: { sent: boolean; reason?: string } = { sent: true }
  let restartResult: { sessionId: string | null; error?: string } = { sessionId: 's-2' }
  const ladder = createLadder(t.app, {
    send: async (_worktreeId, text) => {
      sent.push(text)
      return sendResult
    },
    restartWorker: async (_worktreeId, note) => {
      restarts.push(note)
      return restartResult
    },
    park: (_worktreeId, story) => void parks.push(story)
  })
  return {
    ...t,
    ladder,
    sent,
    restarts,
    parks,
    setSend: (result: typeof sendResult) => void (sendResult = result),
    setRestart: (result: typeof restartResult) => void (restartResult = result),
    ladderEntries: () => t.app.store.journalSince(0).filter((entry) => entry.kind === 'ladder').map((entry) => entry.data)
  }
}

describe('ladder', () => {
  test('climbs nudge, restart, restart, park one step at a time', async () => {
    const t = setup()
    await t.ladder.climb('wt-1', signal)
    expect(t.sent).toHaveLength(1)
    expect([t.restarts.length, t.parks.length]).toEqual([0, 0])

    await t.ladder.climb('wt-1', signal)
    await t.ladder.climb('wt-1', signal)
    expect([t.sent.length, t.restarts.length, t.parks.length]).toEqual([1, 2, 0])

    await t.ladder.climb('wt-1', signal)
    expect([t.sent.length, t.restarts.length, t.parks.length]).toEqual([1, 2, 1])
    expect(t.ladderEntries().map((entry) => entry.rung)).toEqual([0, 1, 2, 3])
  })

  test('journals every step with the signal that triggered it', async () => {
    const t = setup()
    await t.ladder.climb('wt-1', signal)
    expect(t.ladderEntries()).toMatchObject([{ rung: 0, signal: 'done-when-repeat' }])
    const stuck = t.app.store.journalSince(0).filter((entry) => entry.kind === 'stuck')
    expect(stuck).toMatchObject([{ worktreeId: 'wt-1', data: { rung: 0, signal: 'done-when-repeat' } }])
  })

  test('the nudge names what the avatar sees', async () => {
    const t = setup()
    await t.ladder.climb('wt-1', { kind: 'call-loop', detail: 'the same Bash call with the same arguments 3 times in a row' })
    expect(t.sent[0]).toContain('the same Bash call with the same arguments 3 times in a row')
  })

  test('a restart carries a recovery note with goal, done when, attempts, diff and guesses', async () => {
    const t = setup()
    t.app.store.guesses.put({ id: 'g1', worktreeId: 'wt-1', question: 'Which fixture dir?', choice: 'test/fixtures', confirmedAt: null, redoneAt: null, commitsSince: [] })
    t.app.store.guesses.put({ id: 'g2', worktreeId: 'wt-1', question: 'Old question?', choice: 'old', confirmedAt: 10, redoneAt: null, commitsSince: [] })
    t.app.journal('wt-1', 'done-check', { kind: 'command', pass: false, output: 'FAIL missing fixture browser-pane.json', signature: 'abc' })
    await t.ladder.climb('wt-1', signal)
    await t.ladder.climb('wt-1', signal)

    const note = t.restarts[0]
    expect(note).toContain('Fix the two failing checks')
    expect(note).toContain('bun test packages/x')
    expect(note).toContain('FAIL missing fixture browser-pane.json')
    expect(note).toContain('1 file changed')
    expect(note).toContain('Which fixture dir?')
    expect(note).toContain('test/fixtures')
    expect(note).not.toContain('Old question?')
    expect(t.calls.find((call) => call.method === 'quirky.checks/run')?.params).toMatchObject({ command: 'git diff --stat', worktree: 'wt-1' })
  })

  test('a nudge the user is blocking does not use up the rung', async () => {
    const t = setup()
    t.setSend({ sent: false, reason: 'user-typing' })
    expect(await t.ladder.climb('wt-1', signal)).toEqual({ acted: false, reason: 'user-typing' })
    expect(t.ladderEntries()).toEqual([])
    expect(t.app.store.stuck.get('wt-1')?.rung ?? 0).toBe(0)

    t.setSend({ sent: true })
    await t.ladder.climb('wt-1', signal)
    expect(t.ladderEntries()).toMatchObject([{ rung: 0 }])
  })

  test('a failed restart is logged and the ladder still moves on', async () => {
    const t = setup()
    t.setRestart({ sessionId: null, error: 'no pty' })
    await t.ladder.climb('wt-1', signal)
    await t.ladder.climb('wt-1', signal)
    expect(t.app.store.journalSince(0).some((entry) => entry.kind === 'event' && entry.data.type === 'restart-failed' && entry.data.error === 'no pty')).toBe(true)
    expect(t.app.store.stuck.get('wt-1')?.rung).toBe(2)
  })

  test('the park story says what was tried', async () => {
    const t = setup()
    for (let step = 0; step < 4; step++) await t.ladder.climb('wt-1', signal)
    expect(t.parks[0]).toContain('2 restarts')
    expect(t.parks[0]).toContain('done when failed the same way')
  })

  test('progress resets the rung and the counters', async () => {
    const t = setup()
    await t.ladder.climb('wt-1', signal)
    await t.ladder.climb('wt-1', signal)
    t.ladder.patchCounters('wt-1', { denialsConsecutive: 2, denialsTotal: 7 })
    t.ladder.reset('wt-1')
    expect(t.app.store.stuck.get('wt-1')).toMatchObject({ rung: 0, counters: { denialsConsecutive: 0, denialsTotal: 0 } })

    await t.ladder.climb('wt-1', signal)
    expect(t.ladderEntries().map((entry) => entry.rung)).toEqual([0, 1, 0])
  })

  test('a step zeroes the denial counters so one burst does not climb twice', async () => {
    const t = setup()
    t.ladder.patchCounters('wt-1', { denialsConsecutive: 3, denialsTotal: 3 })
    await t.ladder.climb('wt-1', { kind: 'denials', detail: '3 denials in a row' })
    expect(t.ladder.row('wt-1').counters).toMatchObject({ denialsConsecutive: 0, denialsTotal: 0, stepAt: 50_000 })
  })
})
