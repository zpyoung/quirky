import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Session } from '@quirky/protocol'
import { removeTempDirs } from '../../../packages/daemon/test/plugins/fixtures'
import { parseSpoolLine } from '../src/spool'
import { claudeSession, makeTempHome, Rig, startOf } from './support'

let rig: Rig

afterEach(async () => {
  await rig?.cleanup()
  removeTempDirs()
})

const b64 = (text: string) => Buffer.from(text).toString('base64')
const claude = (name: string, payload: Record<string, unknown> = {}) => JSON.stringify({ hook_event_name: name, ...payload })

/** One line as the shim writes it; `-` stands for an empty field. */
const line = (source: string, payload: string, fields: { pid?: number; pstart?: string; event?: string } = {}) =>
  [source, fields.pid ?? '-', fields.pstart ? b64(fields.pstart) : '-', fields.event ?? '-', b64(payload)].join(' ')

/** A home holding spool files and a session store the fake session plugin will find at activation. */
function homeWith(sessions: string[], files: Record<string, string[]>): { home: string; spool: string } {
  const home = makeTempHome('qas-spool-')
  const sessionDir = join(home, 'plugin-data', 'quirky.session')
  mkdirSync(sessionDir, { recursive: true })
  const seeded: Session[] = sessions.map((id) => ({ ...claudeSession, id }))
  writeFileSync(join(sessionDir, 'sessions.json'), JSON.stringify(seeded))
  const spool = join(home, 'hook-spool')
  mkdirSync(spool, { mode: 0o700 })
  for (const [name, lines] of Object.entries(files)) writeFileSync(join(spool, name), `${lines.join('\n')}\n`, { mode: 0o600 })
  return { home, spool }
}

describe('SC-18: a hook while the daemon is down is replayed at start', () => {
  test('a spooled turn gives a done row without a notification, and the file is deleted', async () => {
    const { home, spool } = homeWith(['s1'], {
      's1.jsonl': [line('claude', claude('UserPromptSubmit', { prompt: 'go' })), line('claude', claude('Stop', { last_assistant_message: 'finished' }))]
    })
    rig = await Rig.start({ home, sessions: [] })

    expect(await rig.row()).toMatchObject({ state: 'done', source: 'replay', detail: 'finished' })
    expect((await rig.session()).status).toBe('done')
    expect(readdirSync(spool)).toEqual([])
    await rig.settle()
    expect(rig.h.notifications).toEqual([])
    expect(rig.notifies()).toEqual([])

    await rig.hook('claude', { hook_event_name: 'UserPromptSubmit', prompt: 'next' })
    await rig.hook('claude', { hook_event_name: 'Stop', last_assistant_message: 'again' })
    await rig.waitForNotifies(1)
    expect(rig.h.notifications).toHaveLength(1)
  })

  test('a record carries its process identity and event name', async () => {
    const pstart = startOf(process.pid)
    const { home } = homeWith(['s1', 's2'], {
      's1.jsonl': [line('claude', claude('UserPromptSubmit', { prompt: 'go' }), { pid: process.pid, pstart })],
      's2.jsonl': [line('antigravity', '{}', { event: 'PreInvocation' })]
    })
    rig = await Rig.start({ home, sessions: [] })
    expect(await rig.row('s1')).toMatchObject({ state: 'working', lead: { agentPid: process.pid, agentStart: pstart } })
    expect(await rig.row('s2')).toMatchObject({ state: 'working', agent: 'antigravity' })
  })

  test('files older than seven days and malformed lines are skipped, and every file goes', async () => {
    const { home, spool } = homeWith(['s1', 's2', 's3'], {
      's1.jsonl': [line('claude', claude('UserPromptSubmit', { prompt: 'old' }))],
      's2.jsonl': [
        'garbage',
        'claude - - - !!!not-base64!!!',
        `claude - - - ${b64('not json')}`,
        'claude x - - e30=',
        'a b c',
        line('claude', claude('UserPromptSubmit', { prompt: 'kept' }))
      ],
      's3.jsonl': ['nonsense only']
    })
    const eightDays = (Date.now() - 8 * 24 * 3_600_000) / 1000
    utimesSync(join(spool, 's1.jsonl'), eightDays, eightDays)
    writeFileSync(join(spool, 'notes.txt'), 'not a spool file')

    rig = await Rig.start({ home, sessions: [] })
    expect(await rig.row('s1')).toBeNull()
    expect(await rig.row('s2')).toMatchObject({ state: 'working', prompt: 'kept' })
    expect(await rig.row('s3')).toBeNull()
    expect(readdirSync(spool)).toEqual(['notes.txt'])
  })

  test('a record for a session that is gone is dropped with its file', async () => {
    const { home, spool } = homeWith([], { 'ghost.jsonl': [line('claude', claude('UserPromptSubmit', { prompt: 'go' }))] })
    rig = await Rig.start({ home, sessions: [] })
    expect(await rig.row('ghost')).toBeNull()
    expect(existsSync(join(spool, 'ghost.jsonl'))).toBe(false)
  })

  test('a start without a spool directory is fine', async () => {
    rig = await Rig.start()
    expect(await rig.row()).toBeNull()
  })
})

describe('parseSpoolLine', () => {
  test('reads the five fields and treats - as empty', () => {
    expect(parseSpoolLine(line('codex', '{"a":1}', { pid: 42, pstart: 'Mon Oct 26 10:00:00 2026' }), 's1', 7)).toEqual({
      source: 'codex',
      sessionId: 's1',
      payload: { a: 1 },
      agentPid: 42,
      agentStart: 'Mon Oct 26 10:00:00 2026',
      at: 7,
      replay: true
    })
    expect(parseSpoolLine(line('cursor', '{}', { event: 'stop' }), 's1', 7)).toMatchObject({ event: 'stop' })
  })

  test('refuses a line that is not five fields, has a bad pid or has an empty payload', () => {
    expect(parseSpoolLine('claude - - -', 's1', 1)).toBeNull()
    expect(parseSpoolLine(`claude 12x - - ${b64('{}')}`, 's1', 1)).toBeNull()
    expect(parseSpoolLine('claude - - - -', 's1', 1)).toBeNull()
  })
})
