import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { applyEvent, newRow, type ApplyEvent } from '../src/apply'
import { programEvidence, titleEvidence } from '../src/fallbacks'
import { answered, interrupted } from '../src/inference'
import type { AgentRow, Normalized } from '../src/types'
import { editStore, Rig } from './support'

const base: ApplyEvent = { sessionId: 's1', source: 'claude', at: 1000, replay: false }

function event(n: Partial<Normalized> = {}): Normalized {
  return { eventName: 'PreToolUse', state: null, newTurn: false, fields: {}, ...n }
}

const promptEvent = (): Partial<Normalized> => ({ eventName: 'UserPromptSubmit', state: 'working', newTurn: true, fields: { prompt: 'go' } })
const toolEvent = (name: string): Partial<Normalized> => ({ state: 'working', fields: { toolName: name } })
const stopEvent = (): Partial<Normalized> => ({ eventName: 'Stop', state: 'done', outcome: 'success' })
const permissionEvent = (): Partial<Normalized> => ({
  eventName: 'PermissionRequest',
  state: 'waiting',
  permissionRequest: true,
  fields: { toolName: 'Bash', toolInput: 'ls' }
})

function apply(prev: AgentRow | null, n: Partial<Normalized>, ev: Partial<ApplyEvent> = {}): AgentRow {
  return applyEvent(prev, event(n), { ...base, ...ev }).row!
}

describe('applyEvent stamps the event that moved the row', () => {
  test('a hook that starts a row and one that moves its state', () => {
    const started = apply(null, promptEvent())
    expect(started.because).toEqual({ source: 'hook', rule: 'claude UserPromptSubmit → working', event: 'UserPromptSubmit', at: 1000 })

    const waiting = apply(started, permissionEvent(), { at: 2000 })
    expect(waiting.because).toEqual({ source: 'hook', rule: 'claude PermissionRequest → waiting', event: 'PermissionRequest', at: 2000 })
  })

  test('a replayed event says so', () => {
    const row = apply(null, promptEvent(), { replay: true })
    expect(row.because).toMatchObject({ source: 'replay', rule: 'claude UserPromptSubmit → working', event: 'UserPromptSubmit' })
  })

  test('a different outcome at the same state is a new reason', () => {
    const done = apply(apply(null, promptEvent()), stopEvent(), { at: 2000 })
    const failed = apply(done, { eventName: 'StopFailure', state: 'done', outcome: 'failure' }, { at: 3000 })
    expect(failed.because).toMatchObject({ rule: 'claude StopFailure → done', event: 'StopFailure', at: 3000 })
  })

  test('a tool ping that changes neither state, outcome nor source keeps the earlier reason', () => {
    const started = apply(null, promptEvent())
    const ping = apply(started, toolEvent('Read'), { at: 5000 })
    expect(ping.evidenceAt).toBe(5000)
    expect(ping.because).toEqual(started.because)
  })

  test('a held-permission evidence refresh keeps the reason', () => {
    const waiting = apply(apply(null, promptEvent()), permissionEvent(), { at: 2000 })
    const refreshed = apply(waiting, toolEvent('Read'), { at: 3000 })
    expect(refreshed.heldPermission).toBeDefined()
    expect(refreshed.because).toEqual(waiting.because)
  })

  test('a hook after a replay moves the source and so the reason', () => {
    const replayed = apply(null, promptEvent(), { replay: true })
    const live = apply(replayed, toolEvent('Read'), { at: 2000 })
    expect(live.because).toMatchObject({ source: 'hook', rule: 'claude PreToolUse → working', event: 'PreToolUse', at: 2000 })
  })

  test('the rule is one line of at most 200 characters', () => {
    const row = apply(null, { ...promptEvent(), eventName: `Weird\nEvent${'x'.repeat(400)}` })
    expect(row.because!.rule).not.toContain('\n')
    expect(row.because!.rule.length).toBeLessThanOrEqual(200)
  })
})

describe('title and OSC 7501 rows stamp what they read', () => {
  const ev = { sessionId: 's1', agent: 'claude', at: 1000 }

  test('a title row quotes the title and the reading', () => {
    const row = titleEvidence(null, 'permission', { ...ev, title: '✋ gemini' })
    expect(row.because).toEqual({ source: 'title', rule: 'title "✋ gemini" → permission', at: 1000 })
  })

  test('a long title is capped at 120 characters inside the quotes', () => {
    const row = titleEvidence(null, 'working', { ...ev, title: `⠋ ${'a'.repeat(300)}` })
    const quoted = row.because!.rule.match(/^title "(.*)" → working$/)![1]!
    expect(quoted.length).toBeLessThanOrEqual(120)
    expect(row.because!.rule.length).toBeLessThanOrEqual(200)
  })

  test('a title refresh and a same-state title keep the earlier reason', () => {
    const first = titleEvidence(null, 'working', { ...ev, title: '⠋ one' })
    const refreshed = titleEvidence(first, 'working', { ...ev, at: 1000 + 61_000, title: '⠙ two' })
    expect(refreshed.evidenceAt).toBe(62_000)
    expect(refreshed.because).toEqual(first.because)
    const moved = titleEvidence(refreshed, 'idle', { ...ev, at: 70_000, title: '✳ Claude' })
    expect(moved.because).toEqual({ source: 'title', rule: 'title "✳ Claude" → idle', at: 70_000 })
  })

  const program = { ...ev, hooksOn: true, silenceMs: 120_000 }

  test('an OSC 7501 row names the state and kind, and the row state it became', () => {
    const blocked = programEvidence(null, { id: null, state: 'blocked', kind: 'permission' }, program).row!
    expect(blocked.because).toEqual({ source: 'program-status', rule: 'OSC 7501 blocked/permission → waiting', at: 1000 })
    const working = programEvidence(null, { id: null, state: 'working' }, program).row!
    expect(working.because!.rule).toBe('OSC 7501 working → working')
  })

  test('a report that moves nothing keeps the reason, even as its facet changes', () => {
    const first = programEvidence(null, { id: null, state: 'working' }, program).row!
    const next = programEvidence(first, { id: null, state: 'working', progress: 40 }, { ...program, at: 9000 }).row!
    expect(next.programStatus).toMatchObject({ progress: 40 })
    expect(next.evidenceAt).toBe(9000)
    expect(next.because).toEqual(first.because)
  })

  test('a facet riding on a hook row leaves the hook reason alone', () => {
    const hooked = apply(null, promptEvent(), { at: 1000 })
    const row = programEvidence(hooked, { id: null, state: 'working', progress: 5 }, { ...program, at: 2000 }).row!
    expect(row.because).toEqual(hooked.because)
  })
})

describe('inference stamps the key or answer that decided the row', () => {
  const working = (): AgentRow => {
    const row = apply(null, promptEvent())
    return { ...row, lastHookAt: 1000 }
  }

  test.each([
    ['ctrl-c', 'Ctrl+C settled with no hook → interrupted'],
    ['plain-escape', 'Esc settled with no hook → interrupted']
  ] as const)('%s', (intent, rule) => {
    const row = interrupted(working(), 2000, intent)
    expect(row.because).toEqual({ source: 'inference', rule, at: 2000 })
  })

  test('an answered question', () => {
    const asking = apply(working(), { eventName: 'PreToolUse', state: 'waiting', fields: { question: '{"questions":[]}' } }, { at: 2000 })
    const row = answered(asking, 3000)
    expect(row.because).toEqual({ source: 'inference', rule: 'Enter answered the question → working', at: 3000 })
  })
})

describe('rows through the service', () => {
  let rig: Rig
  let saved: string | undefined
  const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'

  beforeAll(() => {
    saved = process.env[SCALE]
    process.env[SCALE] = '0.2'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[SCALE]
    else process.env[SCALE] = saved
  })
  afterEach(async () => {
    await rig?.cleanup()
    removeTempDirs()
  })

  test('the service passes the key it saw to the interrupt reason', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await rig.write('\x03')
    await Bun.sleep(220)
    expect((await rig.row())!.because).toMatchObject({ source: 'inference', rule: 'Ctrl+C settled with no hook → interrupted' })
  })

  test('the title text reaches a title row', async () => {
    rig = await Rig.start()
    await rig.title('⠋ Working on it')
    expect((await rig.row())!.because).toMatchObject({ source: 'title', rule: 'title "⠋ Working on it" → working' })
  })

  test('a row stored without because still reads through get', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    await rig.stop()
    editStore(rig.storeFile(), (row) => {
      const { because: _dropped, ...legacy } = row
      return { row: legacy as AgentRow, updatedAt: Date.now() }
    })
    rig = await Rig.start({ home: rig.h.home, sessions: [] })
    const row = await rig.row()
    expect(row).toMatchObject({ state: 'working', prompt: 'go' })
    expect(row!.because).toBeUndefined()
  })

  test('hydrate keeps the stored reason', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' })
    const before = (await rig.row())!.because
    expect(before).toBeDefined()
    rig = await rig.restart({ sessions: [] })
    expect((await rig.row())!.because).toEqual(before)
  })
})

test('newRow carries no reason of its own', () => {
  expect(newRow(base).because).toBeUndefined()
})
