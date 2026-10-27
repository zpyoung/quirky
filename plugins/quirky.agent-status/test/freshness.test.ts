import { afterEach, describe, expect, test } from 'bun:test'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { editStore, insertRow, Rig } from './support'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

let rig: Rig

afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
})

const prompt = (session = 's1') => rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go' }, { session })
const stop = (session = 's1') => rig.hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'ok' }, { session })

describe('SC-16: silence decays the display, never the state', () => {
  test('a working row 31 minutes quiet is unverifiable while the session runs and idle after it ended', async () => {
    rig = await Rig.start()
    await prompt()
    const { evidenceAt } = (await rig.row())!

    expect(await rig.rowAt(evidenceAt + 29 * MINUTE)).toMatchObject({ display: 'working' })
    expect(await rig.rowAt(evidenceAt + 31 * MINUTE)).toMatchObject({
      state: 'working',
      display: 'unverifiable',
      label: 'No recent update',
      detail: 'No update in 31m'
    })

    await rig.seed({ status: 'exited' })
    expect(await rig.rowAt(evidenceAt + 31 * MINUTE)).toMatchObject({
      state: 'working',
      display: 'idle',
      label: 'Idle',
      detail: 'No update in 31m'
    })
  })

  test('a done row never decays', async () => {
    rig = await Rig.start()
    await prompt()
    await stop()
    const { evidenceAt } = (await rig.row())!
    expect(await rig.rowAt(evidenceAt + 10 * DAY)).toMatchObject({ state: 'done', display: 'done', label: 'Done' })
  })

  test('the stored row and the session summary are not rewritten by silence', async () => {
    rig = await Rig.start()
    await prompt()
    const before = await rig.statusCalls()
    await rig.rowAt(Date.now() + 40 * MINUTE)
    expect(await rig.statusCalls()).toEqual(before)
    expect((await rig.row())!.state).toBe('working')
  })
})

describe('SC-17: a daemon restart', () => {
  test('live rows come back unconfirmed until their next hook; done rows stay; old rows and rows of gone sessions are dropped', async () => {
    rig = await Rig.start({ sessions: [{ id: 's1' }, { id: 's2' }, { id: 's3' }] })
    await prompt('s1')
    await prompt('s2')
    await stop('s2')
    await prompt('s3')
    const doneBefore = (await rig.row('s2'))!

    const now = Date.now()
    await rig.stop()
    editStore(rig.storeFile(), (row) => {
      if (row.sessionId === 's1') return { row: { ...row, evidenceAt: now - 10 * MINUTE }, updatedAt: now - 10 * MINUTE }
      if (row.sessionId === 's3') return { row: { ...row, evidenceAt: now - 8 * DAY }, updatedAt: now - 8 * DAY }
      return null
    })
    insertRow(rig.storeFile(), { ...doneBefore, sessionId: 's4' }, now)

    rig = await Rig.start({ home: rig.h.home, sessions: [] })
    expect(await rig.row('s1')).toMatchObject({ state: 'working', restoredUnconfirmed: true, display: 'unconfirmed', label: "Couldn't confirm" })
    expect((await rig.session('s1')).agentStatus).toMatchObject({ display: 'unconfirmed', restoredUnconfirmed: true })
    expect((await rig.session('s1')).status).toBe('working')

    const doneAfter = (await rig.row('s2'))!
    expect(doneAfter).toEqual(doneBefore)
    expect((await rig.session('s2')).agentStatus).toMatchObject({ display: 'done' })

    expect(await rig.row('s3')).toBeNull()
    expect(await rig.row('s4')).toBeNull()
    expect((await rig.list()).map((e) => e.sessionId).sort()).toEqual(['s1', 's2'])

    await rig.hook('claude', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { session: 's1' })
    const fresh = (await rig.row('s1'))!
    expect(fresh).toMatchObject({ state: 'working', display: 'working', toolName: 'Bash' })
    expect(fresh.restoredUnconfirmed).toBeUndefined()
    expect((await rig.session('s1')).agentStatus).toMatchObject({ display: 'working', restoredUnconfirmed: false })
  })

  test('a row dropped for age clears the summary and coarse status of the session that survives', async () => {
    rig = await Rig.start()
    await prompt()
    expect(await rig.session()).toMatchObject({ status: 'working', agentStatus: { display: 'working' } })

    await rig.stop()
    editStore(rig.storeFile(), (row) => ({ row, updatedAt: Date.now() - 8 * DAY }))

    rig = await Rig.start({ home: rig.h.home, sessions: [] })
    expect(await rig.row()).toBeNull()
    expect(await rig.session()).toMatchObject({ status: 'running', agentStatus: null })
  })

  test('a restored row yields to a different agent, and its own lead confirms it', async () => {
    rig = await Rig.start()
    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'go', session_id: 'abc' })
    rig = await rig.restart({ sessions: [] })
    await rig.hook('gemini', { hook_event_name: 'BeforeAgent', prompt: 'other' })
    expect(await rig.row()).toMatchObject({ agent: 'gemini', state: 'working' })
  })
})
