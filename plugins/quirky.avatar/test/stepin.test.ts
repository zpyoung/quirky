import { describe, expect, test } from 'bun:test'
import type { Level, Mandate, WorktreeState } from '../src/contracts'
import { createStepIn, hasUnsentUserText } from '../src/supervisor/stepin'
import { makeTestApp, sampleMandate } from './support'

describe('hasUnsentUserText', () => {
  test('input after the last agent prompt is unsent text', () => {
    expect(hasUnsentUserText(2_000, 1_000)).toBe(true)
  })

  test('input before the last agent prompt was already submitted', () => {
    expect(hasUnsentUserText(1_000, 2_000)).toBe(false)
  })

  test('no user input is never unsent text', () => {
    expect(hasUnsentUserText(null, 1_000)).toBe(false)
    expect(hasUnsentUserText(null, null)).toBe(false)
  })

  test('input with no agent prompt on record counts as unsent', () => {
    expect(hasUnsentUserText(1_000, null)).toBe(true)
  })
})

type Setup = { agent?: string; level?: Level; sessionId?: string | null; stateStartedAt?: number; agentStatus?: boolean }

function setup({ agent = 'claude', level = 'full', sessionId = 's-1', stateStartedAt = 5_000, agentStatus = true }: Setup = {}) {
  const t = makeTestApp()
  const mandate: Mandate = sampleMandate({ level })
  t.app.services.handoff.active = () => [{ worktreeId: 'wt-1', sessionId, state: 'working' as WorktreeState, mandate }]
  t.app.store.mandates.put(mandate)
  t.fakeCalls['quirky.session/get'] = () => ({ id: 's-1', agent, status: 'working', ...(agentStatus ? { agentStatus: { state: 'working', stateStartedAt } } : {}) })
  t.fakeCalls['quirky.terminal/write'] = () => ({ ok: true })
  t.fakeCalls['quirky.agent-status/send'] = () => ({ session: 's-1', state: 'working' })
  const io = createStepIn(t.app, { interruptGapMs: 0 })
  const methods = () => t.calls.map((call) => call.method)
  return { ...t, io, methods }
}

describe('send', () => {
  test('types the text through agent-status', async () => {
    const t = setup()
    expect(await t.io.send('wt-1', 'keep going')).toEqual({ sent: true })
    expect(t.calls.filter((call) => call.method === 'quirky.agent-status/send').map((call) => call.params)).toEqual([{ session: 's-1', text: 'keep going' }])
  })

  test('is refused while the user has unsent text in the pane', async () => {
    const t = setup({ stateStartedAt: 5_000 })
    t.pty.userInput.set('s-1', { session: 's-1', expectedIncarnation: 'i', at: 6_000 })
    expect(await t.io.send('wt-1', 'keep going')).toEqual({ sent: false, reason: 'user-typing' })
    expect(t.methods()).not.toContain('quirky.agent-status/send')
  })

  test('goes through once the agent has prompted since the user typed', async () => {
    const t = setup({ stateStartedAt: 7_000 })
    t.pty.userInput.set('s-1', { session: 's-1', expectedIncarnation: 'i', at: 6_000 })
    expect((await t.io.send('wt-1', 'keep going')).sent).toBe(true)
  })

  test('never sends at Shadow', async () => {
    const t = setup({ level: 'shadow' })
    expect(await t.io.send('wt-1', 'x')).toEqual({ sent: false, reason: 'shadow' })
    expect(t.calls).toEqual([])
  })

  test('reports a worktree with no session', async () => {
    const t = setup({ sessionId: null })
    expect(await t.io.send('wt-1', 'x')).toEqual({ sent: false, reason: 'no-session' })
  })

  test('carries the agent-status refusal reason instead of throwing', async () => {
    const t = setup()
    t.fakeCalls['quirky.agent-status/send'] = () => {
      throw Object.assign(new Error('blocked'), { data: { reason: 'agent-blocked' } })
    }
    expect(await t.io.send('wt-1', 'x')).toEqual({ sent: false, reason: 'agent-blocked' })
  })
})

describe('stepIn', () => {
  const escapes = (t: ReturnType<typeof setup>) => t.calls.filter((call) => call.method === 'quirky.terminal/write').map((call) => call.params)

  test.each(['claude', 'codex'])('%s needs a double Escape before the text', async (agent) => {
    const t = setup({ agent })
    expect(await t.io.stepIn('wt-1', 'stop that')).toEqual({ sent: true })
    expect(escapes(t)).toEqual([{ session: 's-1', data: '\x1b' }, { session: 's-1', data: '\x1b' }])
    expect(t.methods().at(-1)).toBe('quirky.agent-status/send')
  })

  test.each(['pi', 'omp'])('%s gets a single Escape', async (agent) => {
    const t = setup({ agent })
    await t.io.stepIn('wt-1', 'stop that')
    expect(escapes(t)).toEqual([{ session: 's-1', data: '\x1b' }])
  })

  test('writes nothing into a pane with unsent user text', async () => {
    const t = setup()
    t.pty.userInput.set('s-1', { session: 's-1', expectedIncarnation: 'i', at: 6_000 })
    expect(await t.io.stepIn('wt-1', 'stop that')).toEqual({ sent: false, reason: 'user-typing' })
    expect(escapes(t)).toEqual([])
  })

  test('does not send if the user starts typing between the interrupt and the text', async () => {
    const t = setup()
    t.fakeCalls['quirky.terminal/write'] = () => {
      t.pty.userInput.set('s-1', { session: 's-1', expectedIncarnation: 'i', at: 9_000 })
      return { ok: true }
    }
    expect(await t.io.stepIn('wt-1', 'stop that')).toEqual({ sent: false, reason: 'user-typing' })
    expect(t.methods()).not.toContain('quirky.agent-status/send')
  })

  test('never steps in at Shadow', async () => {
    const t = setup({ level: 'shadow' })
    expect(await t.io.stepIn('wt-1', 'x')).toEqual({ sent: false, reason: 'shadow' })
    expect(t.calls).toEqual([])
  })

  test('journals the step-in before acting on it', async () => {
    const t = setup()
    await t.io.stepIn('wt-1', 'stop that')
    expect(t.app.store.journalSince(0)).toMatchObject([{ worktreeId: 'wt-1', kind: 'event', data: { type: 'step-in', text: 'stop that' } }])
  })

  test('a failed interrupt is reported, not thrown', async () => {
    const t = setup()
    t.fakeCalls['quirky.terminal/write'] = () => {
      throw new Error('pty gone')
    }
    expect(await t.io.stepIn('wt-1', 'x')).toEqual({ sent: false, reason: 'pty gone' })
  })
})
