import { describe, expect, test } from 'bun:test'
import type { WorktreeState } from '../src/contracts'
import { createDoneWhen } from '../src/shipping/donewhen'
import { makeTestApp, sampleMandate } from './support'

function setup(options: { mandate?: Parameters<typeof sampleMandate>[0]; run?: () => unknown } = {}) {
  const t = makeTestApp({ fakeCalls: { 'quirky.checks/run': options.run ?? (() => ({ ran: true, pass: true, exitCode: 0, stdoutTail: 'ok', stderrTail: '' })) } })
  t.app.store.mandates.put(sampleMandate({ doneWhen: 'bun test', doneWhenKind: 'command', ...options.mandate }))
  const states: { state: WorktreeState; note: string }[] = []
  const sent: string[] = []
  const reviews: string[] = []
  let woke = 0
  t.app.services.handoff.setState = (_id, state, note) => void states.push({ state, note })
  t.app.services.supervisor.send = async (_id, text) => {
    sent.push(text)
    return { sent: true }
  }
  t.app.services.brain.wake = () => void woke++
  const doneWhen = createDoneWhen(t.app, async (id) => {
    reviews.push(id)
    return { started: true }
  })
  return { ...t, doneWhen, states, sent, reviews, woke: () => woke }
}

const doneChecks = (app: ReturnType<typeof setup>['app']) => app.store.journalPage({ worktreeId: 'wt-1' }).filter((entry) => entry.kind === 'done-check')

describe('done when as a command', () => {
  test('runs the command in the worktree with a ten minute timeout', async () => {
    const t = setup()
    await t.doneWhen.runDoneWhen('wt-1')
    expect(t.calls[0]).toEqual({ method: 'quirky.checks/run', params: { command: 'bun test', worktree: 'wt-1', timeoutSeconds: 600 } })
  })

  test('a pass moves the worktree to review and starts the reviewer', async () => {
    const t = setup()
    expect(await t.doneWhen.runDoneWhen('wt-1')).toMatchObject({ pass: true })
    expect(t.states.map((entry) => entry.state)).toEqual(['checking-done', 'in-review'])
    expect(t.reviews).toEqual(['wt-1'])
    expect(t.sent).toEqual([])
    expect(doneChecks(t.app)[0]?.data).toMatchObject({ kind: 'command', pass: true })
  })

  test('a failure goes back to the worker with the output tail and does not start a review', async () => {
    const long = `${'x'.repeat(6000)}\nexpected 1 to be 2`
    const t = setup({ run: () => ({ ran: true, pass: false, exitCode: 1, stdoutTail: long, stderrTail: 'FAIL src/a.test.ts' }) })
    const result = await t.doneWhen.runDoneWhen('wt-1')
    expect(result.pass).toBe(false)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0]).toContain('expected 1 to be 2')
    expect(t.sent[0]).toContain('FAIL src/a.test.ts')
    expect(t.sent[0]?.length).toBeLessThan(5000)
    expect(t.reviews).toEqual([])
    expect(t.states.map((entry) => entry.state)).toEqual(['checking-done', 'working'])
    expect(doneChecks(t.app)[0]?.data).toMatchObject({ kind: 'command', pass: false })
  })

  test('the same failure produces the same signature so a repeat can be seen', async () => {
    const run = () => ({ ran: true, pass: false, exitCode: 1, stdoutTail: 'took 12ms: boom', stderrTail: '' })
    const first = setup({ run })
    await first.doneWhen.runDoneWhen('wt-1')
    await first.doneWhen.runDoneWhen('wt-1')
    const [newer, older] = doneChecks(first.app)
    expect(newer?.data.signature).toBeTruthy()
    expect(newer?.data.signature).toBe(older?.data.signature)
  })

  test('a check that could not run counts as a failure and says why', async () => {
    const t = setup({ run: () => ({ ran: false, pass: false, exitCode: null, stdoutTail: '', stderrTail: '', error: 'no such directory' }) })
    const result = await t.doneWhen.runDoneWhen('wt-1')
    expect(result).toMatchObject({ pass: false })
    expect(result.output).toContain('no such directory')
    expect(t.reviews).toEqual([])
  })

  test('a check call that throws is a failure and is not sent to a reviewer', async () => {
    const t = setup({
      run: () => {
        throw new Error('checks offline')
      }
    })
    const result = await t.doneWhen.runDoneWhen('wt-1')
    expect(result.pass).toBe(false)
    expect(result.output).toContain('checks offline')
    expect(t.reviews).toEqual([])
  })
})

describe('done when as prose', () => {
  test('wakes the brain, runs no command and records that the brain judged it', async () => {
    const t = setup({ mandate: { doneWhenKind: 'prose', doneWhen: 'PR checks green' } })
    const result = await t.doneWhen.runDoneWhen('wt-1')
    expect(t.woke()).toBe(1)
    expect(t.calls).toEqual([])
    expect(t.reviews).toEqual([])
    expect(result.pass).toBe(false)
    expect(result.output).toContain('brain')
    expect(doneChecks(t.app)[0]?.data).toMatchObject({ kind: 'prose', judgedBy: 'brain' })
  })
})

describe('done when without a mandate', () => {
  test('reports a failure and runs nothing', async () => {
    const t = setup()
    t.app.store.mandates.delete('wt-1')
    expect(await t.doneWhen.runDoneWhen('wt-1')).toMatchObject({ pass: false })
    expect(t.calls).toEqual([])
  })
})
