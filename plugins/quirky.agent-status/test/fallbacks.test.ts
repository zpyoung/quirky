import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { facetOf, programEvidence, titleEvidence } from '../src/fallbacks'
import { newRow } from '../src/apply'
import type { AgentRow } from '../src/types'
import { Rig, waitForAsync } from './support'

let rig: Rig

afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
})

const b64 = (text: string) => Buffer.from(text).toString('base64')
const prompt = (session = 's1') => rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { session })

describe('SC-21: terminal titles fill in where hooks are silent', () => {
  test('a session with no hook row reads working, then permission, then done', async () => {
    rig = await Rig.start()
    await rig.title('~/src/app')
    expect(await rig.row()).toBeNull()

    await rig.title('⠋ Working on it')
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'working', source: 'title', lastHookAt: null })
    expect((await rig.session()).status).toBe('working')

    await rig.title('✋ gemini')
    expect(await rig.row()).toMatchObject({ state: 'waiting', display: 'permission', label: 'Needs attention' })
    expect((await rig.session()).status).toBe('waiting')

    await rig.title('✳ Claude Code')
    expect(await rig.row()).toMatchObject({ state: 'done', display: 'done', lastHookAt: null })
    expect((await rig.session()).status).toBe('done')

    await rig.title('~/src/app')
    expect(await rig.row()).toMatchObject({ state: 'done' })
    expect(rig.notifies()).toEqual([])
  })

  test('a title that moves a row into waiting or done settles it; the row a title starts and a repeated title do not', async () => {
    rig = await Rig.start()
    await rig.title('✳ Claude Code')
    expect(await rig.row()).toMatchObject({ state: 'done', source: 'title' })
    await rig.title('⠋ Working on it')
    await rig.title('✋ gemini')
    await rig.title('✋ gemini')
    await rig.title('✳ Claude Code')
    expect(rig.settles()).toMatchObject([
      { sessionId: 's1', worktreeId: 'wt1', agent: 'claude', state: 'waiting', outcome: null, interrupted: false },
      { sessionId: 's1', worktreeId: 'wt1', agent: 'claude', state: 'done' }
    ])
    expect(rig.notifies()).toEqual([])
  })

  test('a fresh hook row ignores the same titles', async () => {
    rig = await Rig.start()
    await prompt()
    const before = await rig.row()
    for (const title of ['✳ Claude Code', '✋ gemini', '⠋ Working on it']) await rig.title(title)
    expect(await rig.row()).toEqual(before)
  })

  test('a hook takes over a title row without being mistaken for a nested agent', async () => {
    rig = await Rig.start()
    await rig.title('⠋ Working on it')
    await prompt()
    expect(await rig.row()).toMatchObject({ state: 'working', agent: 'claude', source: 'hook' })
  })

  test('titles of a session that is gone change nothing', async () => {
    rig = await Rig.start()
    await rig.title('⠋ Working on it', 'nope')
    expect(await rig.row('nope')).toBeNull()
  })
})

describe('SC-22: OSC 7501 reports and the probe', () => {
  test('reports show as working with progress, waiting, blocked, done, failed and then no row', async () => {
    rig = await Rig.start()
    await rig.osc('?')
    expect(rig.h.pty.inputs).toEqual([])
    expect(await rig.row()).toBeNull()

    await rig.osc(`state=working:progress=40:msg=${b64('Indexing')}`)
    expect(await rig.row()).toMatchObject({
      state: 'working',
      display: 'working',
      detail: 'Indexing',
      source: 'program-status',
      lastHookAt: null,
      programStatus: { state: 'working', progress: 40, msg: 'Indexing' }
    })
    expect(await rig.list()).toMatchObject([{ sessionId: 's1', progress: 40, detail: 'Indexing' }])

    await rig.osc('state=blocked:kind=permission')
    expect(await rig.row()).toMatchObject({ state: 'waiting', display: 'waiting' })
    await rig.osc('state=blocked:kind=auth')
    expect(await rig.row()).toMatchObject({ state: 'blocked', display: 'blocked' })
    await rig.osc('state=done')
    expect(await rig.row()).toMatchObject({ state: 'done', display: 'done', outcome: 'success' })
    await rig.osc('state=error')
    expect(await rig.row()).toMatchObject({ state: 'done', display: 'failed', outcome: 'failure' })
    await rig.osc('state=clear')
    expect(await rig.row()).toBeNull()
    expect((await rig.session()).status).toBe('running')
    expect(rig.notifies()).toEqual([])
    expect(rig.settles().map((s) => [s.state, s.outcome])).toEqual([
      ['waiting', null],
      ['blocked', null],
      ['done', 'success']
    ])
  })

  test('a report with a bad state, bad base64 in msg, or over 4096 bytes is ignored', async () => {
    rig = await Rig.start()
    await rig.osc('state=working')
    const before = await rig.row()
    await rig.osc('state=sleeping')
    await rig.osc('state=done:msg=abcde')
    await rig.osc(`state=done:msg=${'A'.repeat(4096)}`)
    expect(await rig.row()).toEqual(before)
  })

  test('a shell prompt mark drops working and blocked records and keeps done and error ones', async () => {
    rig = await Rig.start({ sessions: [{}, { id: 's2' }, { id: 's3' }] })
    await rig.osc('state=working', 's1')
    await rig.osc('state=blocked:kind=question', 's2')
    await rig.osc('state=done', 's3')
    for (const session of ['s1', 's2', 's3']) await rig.fact({ kind: 'prompt' }, session)
    expect(await rig.row('s1')).toBeNull()
    expect(await rig.row('s2')).toBeNull()
    expect(await rig.row('s3')).toMatchObject({ state: 'done' })
  })

  test('the facet rides on a hook row without deciding its state', async () => {
    rig = await Rig.start()
    await prompt()
    const hooked = (await rig.row())!
    await rig.osc(`state=working:progress=25:msg=${b64('Compiling')}`)
    expect(await rig.row()).toMatchObject({ state: 'working', source: 'hook', lastHookAt: hooked.lastHookAt, programStatus: { progress: 25, msg: 'Compiling' } })
    await rig.osc('state=clear')
    expect((await rig.row())!.programStatus).toBeUndefined()
    expect((await rig.row())!.state).toBe('working')
  })

  test('records survive a daemon restart and are dropped with the session', async () => {
    rig = await Rig.start()
    await rig.osc('state=working')
    rig = await rig.restart()
    expect(await rig.row()).toMatchObject({ state: 'working', display: 'unconfirmed' })
    await rig.fact({ kind: 'prompt' })
    expect(await rig.row()).toBeNull()

    await rig.osc('state=done')
    await rig.client.callAny('quirky.session/remove', { session: 's1' })
    await Bun.sleep(40)
    const { Database } = await import('bun:sqlite')
    const db = new Database(rig.storeFile())
    expect(db.query('SELECT count(*) AS n FROM program_status').get()).toEqual({ n: 0 })
    db.close()
  })
})

describe('SC-23: hooks outrank OSC 7501 until they fall silent', () => {
  const SCALE = 'QUIRKY_TEST_AGENT_STATUS_TIME_SCALE'
  let saved: string | undefined
  beforeAll(() => {
    saved = process.env[SCALE]
    process.env[SCALE] = '0.005'
  })
  afterAll(() => {
    if (saved === undefined) delete process.env[SCALE]
    else process.env[SCALE] = saved
  })

  test('an idle report waits out two (scaled) minutes of hook silence, and a hook takes over again', async () => {
    rig = await Rig.start()
    await prompt()
    await rig.osc('state=idle')
    expect(await rig.state()).toBe('working')

    await waitForAsync(async () => (await rig.state()) === 'done', 2000)
    expect(await rig.row()).toMatchObject({ state: 'done', source: 'program-status', display: 'done' })
    expect(rig.notifies()).toEqual([])
    expect(rig.settles()).toEqual([])

    await prompt()
    expect(await rig.row()).toMatchObject({ state: 'working', source: 'hook' })
  })

  test('a done report that takes over a row with a working child settles nothing', async () => {
    rig = await Rig.start()
    await prompt()
    await rig.hook('claude', { hook_event_name: 'SubagentStart', agent_id: 'a1' })
    await rig.hook('claude', { hook_event_name: 'Stop' })
    expect(await rig.row()).toMatchObject({ state: 'working', lead: { state: 'done' }, children: [{ state: 'working' }] })

    await rig.osc('state=done')
    await waitForAsync(async () => (await rig.row())?.source === 'program-status', 2000)
    await rig.settle()
    expect(rig.settles()).toEqual([])
    expect(await rig.row()).toMatchObject({ state: 'working', source: 'program-status', lead: { state: 'done' } })

    await rig.hook('claude', { hook_event_name: 'SubagentStop', agent_id: 'a1' })
    await rig.waitForSettles(1)
    await rig.settle()
    expect(rig.settles()).toMatchObject([{ state: 'done', agent: 'claude' }])
    expect(await rig.state()).toBe('done')
  })

  test('an idle report is a session boundary, so the row it moves into done settles nothing', async () => {
    rig = await Rig.start()
    await rig.osc('state=working')
    await rig.osc('state=idle')
    expect(await rig.row()).toMatchObject({ state: 'done', sessionBoundary: true })
    expect(rig.settles()).toEqual([])
  })

  test('a done report that follows a hook row into done settles it once', async () => {
    rig = await Rig.start()
    await prompt()
    await rig.osc('state=idle')
    await rig.osc('state=done')
    await waitForAsync(async () => (await rig.row())?.source === 'program-status', 2000)
    await rig.settle()
    expect(rig.settles()).toMatchObject([{ state: 'done', agent: 'claude' }])
  })

  test('a report that agrees with the hook row changes nothing, even after the silence', async () => {
    rig = await Rig.start()
    await prompt()
    const before = (await rig.row())!
    await Bun.sleep(800)
    await rig.osc('state=working')
    expect(await rig.row()).toMatchObject({ state: 'working', source: 'hook', evidenceAt: before.evidenceAt })
  })
})

describe('precedence when the hooks setting is off', () => {
  const at = 1_000_000
  const hooked = (): AgentRow => ({ ...newRow({ sessionId: 's1', source: 'claude', at, replay: false }), state: 'working', lastHookAt: at })
  const ev = (over: object) => ({ sessionId: 's1', agent: 'claude', at: at + 1000, hooksOn: true, silenceMs: 120_000, ...over })

  test('fresh hooks hold the row only while hooks are on', () => {
    const root = { id: null, state: 'done' as const }
    expect(programEvidence(hooked(), root, ev({})).row).toMatchObject({ state: 'working', source: 'hook' })
    expect(programEvidence(hooked(), root, ev({ hooksOn: false })).row).toMatchObject({ state: 'done', source: 'program-status' })
  })

  test('the facet carries only the fields the report named', () => {
    expect(facetOf({ id: null, state: 'working', progress: 5 })).toEqual({ state: 'working', progress: 5 })
  })

  test('a title never replaces a fresh hook row or a program-status row', () => {
    const hook = hooked()
    expect(titleEvidence(hook, 'idle', { sessionId: 's1', agent: 'claude', at: at + 1000, title: '✳ claude' })).toBe(hook)
    const program = programEvidence(null, { id: null, state: 'working' }, ev({})).row!
    expect(titleEvidence(program, 'idle', { sessionId: 's1', agent: 'claude', at: at + 1000, title: '✳ claude' })).toBe(program)
  })
})
