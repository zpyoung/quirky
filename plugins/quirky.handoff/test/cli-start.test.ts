import { afterEach, describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runCli, type CliResult } from '../../../packages/cli/test/fixtures/fake-daemon'
import { HandoffRig, PASTE_START } from './support'

let rig: HandoffRig
let stopReady: (() => void) | undefined
afterEach(async () => {
  stopReady?.()
  stopReady = undefined
  await rig?.cleanup()
  rig = undefined as unknown as HandoffRig
})

const cli = (...args: string[]): Promise<CliResult> => runCli(['handoff', ...args], { home: rig.h.home })

async function json(...args: string[]) {
  const result = await cli(...args, '--json')
  expect(result.stderr).toBe('')
  expect(result.code).toBe(0)
  return JSON.parse(result.stdout)
}

async function opened(ready = true) {
  rig = await HandoffRig.start()
  const s = await rig.session('w')
  rig.setHistory(['some output'])
  if (ready) stopReady = rig.autoReady()
  return s
}

const pasted = (id: string) => rig.h.pty.inputs.filter((input) => input.sessionId === id && input.text.startsWith(PASTE_START))

describe('SC-64: the handoff CLI starts, lists, jumps and resends (CLI)', () => {
  test('start --wait prints the child, the lineage and the outcome', async () => {
    const s = await opened()
    const result = await cli('start', s.id, '--agent', 'gemini', '--note', 'Take over the tests', '--wait')
    expect(result.code).toBe(0)
    const lines = result.stdout.trim().split('\n')
    expect(lines[0]).toMatch(/^child: s_\w+ \(tab \S+, worktree wt_\w+\)$/)
    expect(lines[1]).toMatch(/^lineage: [0-9a-f-]{36}$/)
    expect(lines[2]).toBe('delivery: delivered')
    const child = lines[0]!.split(' ')[1]!
    expect(pasted(child)[0]!.text).toContain('Take over the tests')
  })

  test('start --json without --wait reports pending and the flags choose the target and relationship', async () => {
    const s = await opened()
    const w2 = await rig.worktree('w2')
    const started = await json('start', s.id, '--agent', 'gemini', '--worktree', 'w2', '--relationship', 'reviews')
    expect(started).toMatchObject({ delivery: 'pending', worktreeCreated: null, child: { worktreeId: w2.id } })
    const { records } = await json('lineage', '--session', started.child.session)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: started.lineageId, relationship: 'reviews' })
  })

  test('--new-worktree creates the worktree at start', async () => {
    const s = await opened()
    const started = await json('start', s.id, '--agent', 'gemini', '--new-worktree', 'cli-next', '--wait')
    expect(started.worktreeCreated).toBe(started.child.worktreeId)
    expect(started.delivery).toBe('delivered')
  })

  test('--brief sends the text as is, and @file reads it from a file', async () => {
    const s = await opened()
    const inline = await json('start', s.id, '--agent', 'gemini', '--brief', 'Just do the thing', '--wait')
    expect(pasted(inline.child.session)[0]!.text).toContain('Just do the thing')
    expect(pasted(inline.child.session)[0]!.text).not.toContain('Continue work from the prior Quirky session.')

    const file = join(rig.h.home, 'brief.md')
    writeFileSync(file, 'From a file\nsecond line')
    const fromFile = await json('start', s.id, '--agent', 'gemini', '--brief', `@${file}`, '--wait')
    expect(pasted(fromFile.child.session)[0]!.text).toContain('From a file\rsecond line')
  })

  test('lineage lists newest first and jump follows a record', async () => {
    const s = await opened()
    const first = await json('start', s.id, '--agent', 'gemini', '--wait')
    const second = await json('start', s.id, '--agent', 'gemini', '--wait')
    const all = await json('lineage')
    expect(all.records.map((record: { id: string }) => record.id)).toEqual([second.lineageId, first.lineageId])
    const text = await cli('lineage', '--session', s.id)
    expect(text.stdout).toContain(first.lineageId)
    expect(text.stdout).toContain('continues')

    const newest = await json('jump', s.id)
    expect(newest).toMatchObject({ lineageId: second.lineageId, focused: { session: second.child.session } })
    const picked = await json('jump', s.id, '--lineage', first.lineageId)
    expect(picked.focused.session).toBe(first.child.session)
    const text2 = await cli('jump', first.child.session)
    expect(text2.stdout).toMatch(/^focused s_\w+ \(pane \S+\)\n$/)

    const lone = await rig.session('w')
    const refused = await cli('jump', lone.id, '--json')
    expect(refused.code).toBe(1)
    expect(JSON.parse(refused.stdout).error).toMatchObject({ reason: 'no-lineage' })
  })

  test('resend reports the outcome, and a session with no retained brief fails with no-brief', async () => {
    const s = await opened(false)
    const started = await json('start', s.id, '--agent', 'blind-bot', '--wait')
    expect(started.delivery).toBe('unobservable')
    rig.h.pty.emit(started.child.session, '\x1b[?2004h\x1b[?25h')
    const resent = await cli('resend', started.child.session)
    expect(resent.stdout).toBe('delivery: delivered\n')
    const again = await cli('resend', started.child.session, '--json')
    expect(again.code).toBe(1)
    expect(JSON.parse(again.stdout).error).toMatchObject({ reason: 'no-brief' })
    expect((await cli('resend')).code).toBe(2)
  })

  test('start refuses what the daemon refuses', async () => {
    rig = await HandoffRig.start()
    const s = await rig.session('w')
    rig.setHistory([])
    const result = await cli('start', s.id, '--json')
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout).error).toMatchObject({ reason: 'no-context' })
    expect((await cli('start')).code).toBe(2)
    expect((await cli('start', s.id, '--worktree', 'w', '--new-worktree', 'x')).code).toBe(2)
  })

  test('the group lists every command in its help', async () => {
    rig = await HandoffRig.start()
    const help = await cli('--help')
    for (const word of ['preview', 'start', 'resend', 'lineage', 'jump', 'templates list']) expect(help.stdout).toContain(word)
  })
})
