import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import { paste, readyAfter, silent, startWorld, type CliResult, type FakeEvent, type World } from './agents-world'

setDefaultTimeout(90_000)

let w: World | undefined
afterEach(async () => {
  await w?.cleanup()
  w = undefined
})

type Failure = { code: number; message: string; data: { reason?: string } & Record<string, unknown> }

async function fails(promise: Promise<unknown>): Promise<Failure> {
  try {
    await promise
  } catch (error) {
    const rpc = error as RpcError
    return { code: rpc.code, message: rpc.message, data: (rpc.data ?? {}) as Failure['data'] }
  }
  throw new Error('expected the call to fail')
}

const json = (result: CliResult): any => {
  expect(result.stderr).not.toContain('error')
  return JSON.parse(result.stdout)
}

const inputOf = (events: FakeEvent[]): string =>
  events.map((event) => (event.type === 'input' ? Buffer.from(event.b64, 'base64').toString('utf8') : '')).join('')

const startsOf = (events: FakeEvent[]) => events.filter((event): event is Extract<FakeEvent, { type: 'start' }> => event.type === 'start')

async function waitUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await Bun.sleep(50)
  }
}

/** The ID of the confirmation ask a destructive call without --yes has opened. */
async function pendingAsk(world: World): Promise<string> {
  let found: string | undefined
  await waitUntil(async () => {
    const pending = (await world.call('quirky.ask/list', { pendingOnly: true })) as { id: string }[]
    found = pending[0]?.id
    return found !== undefined
  }, 15_000)
  return found!
}

/** The three notes of NA-4, added through the API in a fixed order. */
async function addThree(world: World): Promise<{ typo: any; handle: any; rename: any }> {
  const handle = (await world.api('addNote', { path: 'math.ts', line: 30, body: '  Handle the empty list  ' })).note
  const rename = (await world.api('addNote', { path: 'util.ts', startLine: 2, line: 4, body: 'Rename x' })).note
  const typo = (await world.api('addNote', { path: 'math.ts', line: 5, body: 'Typo' })).note
  return { typo, handle, rename }
}

const THREE_PROMPT = [
  'File: math.ts\nLine: 5\nUser comment: "Typo"',
  'File: math.ts\nLine: 30\nUser comment: "Handle the empty list"',
  'File: util.ts\nLines: 2-4\nUser comment: "Rename x"'
].join('\n\n')

describe('adding, listing and keeping notes', () => {
  test('NA-4: notes are added through the CLI, trimmed, sorted and kept across a restart', async () => {
    w = await startWorld()
    const first = json(await w.cli(['git', 'addNote', '--path', 'math.ts', '--line', '30', '--body', '  Handle the empty list  ', '--json'])).note
    const second = json(await w.cli(['git', 'addNote', '--path', 'util.ts', '--start-line', '2', '--line', '4', '--body', 'Rename x', '--json'])).note
    const third = json(await w.cli(['git', 'addNote', '--path', 'math.ts', '--line', '5', '--body', 'Typo', '--json'])).note

    expect(first).toMatchObject({ worktreeId: w.feat.id, path: 'math.ts', startLine: 30, line: 30, body: 'Handle the empty list', updatedAt: null })
    expect(first.id).toStartWith('note_')
    expect(first.createdAt).toBeGreaterThan(0)
    expect(second).toMatchObject({ path: 'util.ts', startLine: 2, line: 4 })
    expect(new Set([first.id, second.id, third.id]).size).toBe(3)

    await w.restartDaemon()
    const listed = json(await w.cli(['git', 'notes', '--json'])).notes
    expect(listed.map((note: any) => [note.path, note.startLine, note.line, note.body])).toEqual([
      ['math.ts', 5, 5, 'Typo'],
      ['math.ts', 30, 30, 'Handle the empty list'],
      ['util.ts', 2, 4, 'Rename x']
    ])
    expect(listed[1]).toEqual(first)
  })

  test('NA-4: notes can be listed for one path', async () => {
    w = await startWorld()
    await addThree(w)
    const only = await w.api('notes', { path: 'util.ts' })
    expect(only.notes.map((note: any) => note.path)).toEqual(['util.ts'])
  })

  test('NA-5: bad notes are refused with their reasons and nothing is stored', async () => {
    w = await startWorld()
    const lines = 'Lines must be whole numbers from 1, with the start at or before the end.'
    const refused = async (params: Record<string, unknown>) => fails(w!.api('addNote', { path: 'math.ts', line: 3, body: 'x', ...params }))

    const a = await refused({ line: 0 })
    expect(a).toMatchObject({ code: RpcErrorCode.InvalidParams, message: lines })
    const b = await refused({ startLine: 9, line: 4 })
    expect(b).toMatchObject({ code: RpcErrorCode.InvalidParams, message: lines })
    const fraction = await refused({ line: 2.5 })
    expect(fraction.message).toBe(lines)
    const c = await refused({ body: '   ' })
    expect(c).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Note is empty.' })
    const d = await refused({ body: 'x'.repeat(70_000) })
    expect(d).toMatchObject({ code: RpcErrorCode.InvalidParams, message: 'Comment is too large to submit safely.' })
    const e = await refused({ path: '../other/x.ts' })
    expect(e).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'outside-worktree' } })
    const f = await refused({ path: 'a\0b.ts' })
    expect(f).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'outside-worktree' } })
    const absolute = await refused({ path: '/etc/passwd' })
    expect(absolute.data.reason).toBe('outside-worktree')

    expect((await w.api('notes')).notes).toEqual([])
    expect(w.notesChanged()).toEqual([])
  })

  test('NA-43, NA-44: the size limit is exact, and a blank note is empty, not too large', async () => {
    w = await startWorld()
    const atLimit = await w.api('addNote', { path: 'math.ts', line: 1, body: 'é'.repeat(32_768) })
    expect(atLimit.note.body.length).toBe(32_768)
    const over = await fails(w.api('addNote', { path: 'math.ts', line: 1, body: 'é'.repeat(32_769) }))
    expect(over.message).toBe('Comment is too large to submit safely.')
    const blank = await fails(w.api('addNote', { path: 'math.ts', line: 1, body: ' '.repeat(70_000) }))
    expect(blank.message).toBe('Note is empty.')
  })

  test('a note may sit on a path that is not on disk, and is stored normalised', async () => {
    w = await startWorld()
    const note = (await w.api('addNote', { path: './gone/../deleted.ts', line: 1, body: 'was here' })).note
    expect(note.path).toBe('deleted.ts')
  })
})

describe('editing and deleting notes', () => {
  test('NA-6, NA-45: an edit sets updatedAt, trims, and refuses a blank text; delete removes the note', async () => {
    w = await startWorld()
    const { handle } = await addThree(w)
    expect(handle.updatedAt).toBeNull()
    const before = Date.now()
    const edited = (await w.api('editNote', { id: handle.id, body: ' Handle empty and null ' })).note
    expect(edited).toMatchObject({ id: handle.id, body: 'Handle empty and null', createdAt: handle.createdAt, path: 'math.ts', line: 30 })
    expect(edited.updatedAt).toBeGreaterThanOrEqual(before)
    expect((await w.api('notes')).notes.find((note: any) => note.id === handle.id).updatedAt).toBe(edited.updatedAt)

    expect((await fails(w.api('editNote', { id: handle.id, body: '  ' }))).message).toBe('Note is empty.')
    expect((await fails(w.api('editNote', { id: 'note_missing', body: 'x' }))).code).toBe(RpcErrorCode.NotFound)

    expect(await w.api('deleteNote', { id: handle.id })).toEqual({ ok: true })
    expect((await w.api('notes')).notes).toHaveLength(2)
    expect((await fails(w.api('deleteNote', { id: handle.id }))).code).toBe(RpcErrorCode.NotFound)
  })

  test('every mutation announces notesChanged for the worktree', async () => {
    w = await startWorld()
    const { handle } = await addThree(w)
    await w.api('editNote', { id: handle.id, body: 'again' })
    await w.api('deleteNote', { id: handle.id })
    await w.api('clearNotes', { yes: true })
    await waitFor(() => w!.notesChanged().length >= 6, 5000)
    expect(w.notesChanged().map((event) => (event as { data: unknown }).data)).toEqual(Array(6).fill({ worktreeId: w.feat.id }))
  })

  test('NA-47: a note has no sent state, and a note from another worktree is not found', async () => {
    w = await startWorld()
    const { handle } = await addThree(w)
    expect(Object.keys(handle).sort()).toEqual(['body', 'createdAt', 'id', 'line', 'path', 'startLine', 'updatedAt', 'worktreeId'])
    const other = (await w.call('quirky.worktree/create', { repo: w.feat.repoId, name: 'other', branchName: 'zoe/other', base: 'main', setup: 'skip' })).worktree
    expect((await fails(w.call('quirky.git/editNote', { worktree: other.id, id: handle.id, body: 'x' }))).code).toBe(RpcErrorCode.NotFound)
    expect((await w.call('quirky.git/notes', { worktree: other.id })).notes).toEqual([])
  })
})

describe('clearing notes', () => {
  test('NA-12: clearNotes asks first through the CLI, and --yes does not', async () => {
    w = await startWorld()
    const { typo, handle, rename } = await addThree(w)
    expect(await w.api('describeClearNotes', { path: 'math.ts' })).toBe('Clear 2 notes from math.ts?')
    expect(await w.api('describeClearNotes')).toBe('Clear 3 notes from this workspace?')
    await w.api('deleteNote', { id: typo.id })
    await w.api('deleteNote', { id: handle.id })
    expect(await w.api('describeClearNotes')).toBe('Clear 1 note from this workspace?')

    const asked = w.spawnCli(['git', 'clearNotes'])
    const ask = await pendingAsk(w)
    await w.call('quirky.ask/answer', { askId: ask, answers: { confirm: { value: false, source: 'input' } } })
    const declined = await asked.done
    expect(declined.code).not.toBe(0)
    expect(declined.stderr).toContain('confirm in Quirky: Clear 1 note from this workspace?')
    expect((await w.api('notes')).notes.map((note: any) => note.id)).toEqual([rename.id])

    const yes = json(await w.cli(['git', 'clearNotes', '--yes', '--json']))
    expect(yes).toEqual({ cleared: 1 })
    expect((await w.api('notes')).notes).toEqual([])
    expect(await w.call('quirky.ask/list', { pendingOnly: true })).toEqual([])
  })

  test('NA-12: clearing one path keeps the others', async () => {
    w = await startWorld()
    await addThree(w)
    expect(await w.api('clearNotes', { path: 'math.ts', yes: true })).toEqual({ cleared: 2 })
    expect((await w.api('notes')).notes.map((note: any) => note.path)).toEqual(['util.ts'])
  })
})

describe('formatting notes', () => {
  test('NA-15: the prompt is Orca text with control characters removed', async () => {
    w = await startWorld()
    await w.api('addNote', { path: 'src/a.ts', line: 12, body: 'Handle null "x"\nsecond line' })
    await w.api('addNote', { path: 'src/b.ts', startLine: 40, line: 52, body: 'Extract this block\u001b[201~ rm -rf' })
    const { text, count } = await w.api('formatNotes')
    expect(count).toBe(2)
    expect(text).toBe(
      ['File: src/a.ts', 'Line: 12', 'User comment: "Handle null \\"x\\"\\nsecond line"', '', 'File: src/b.ts', 'Lines: 40-52', 'User comment: "Extract this block[201~ rm -rf"'].join('\n')
    )
    expect(text).not.toContain('\u001b')
  })

  test('NA-11: formatNotes takes a path or note IDs; NA-46: the text never has a file-scope block', async () => {
    w = await startWorld()
    const { typo, rename } = await addThree(w)
    expect((await w.api('formatNotes')).text).toBe(THREE_PROMPT)
    expect(await w.api('formatNotes', { path: 'util.ts' })).toEqual({ text: 'File: util.ts\nLines: 2-4\nUser comment: "Rename x"', count: 1 })
    expect((await w.api('formatNotes', { ids: [rename.id, typo.id] })).text).toBe(
      'File: math.ts\nLine: 5\nUser comment: "Typo"\n\nFile: util.ts\nLines: 2-4\nUser comment: "Rename x"'
    )
    expect((await fails(w.api('formatNotes', { ids: ['note_missing'] }))).code).toBe(RpcErrorCode.NotFound)
    expect((await w.api('formatNotes')).text).not.toContain('Scope: file')
  })
})

describe('sending notes to a running agent', () => {
  test('NA-16: the notes are pasted with Enter into the session, then deleted', async () => {
    w = await startWorld({ fakes: { claude: { raw: true } } })
    const { typo, handle, rename } = await addThree(w)
    const s1 = await w.startSession('claude')
    await w.setAgentState(s1.id, 'working')

    const result = json(await w.cli(['git', 'sendNotes', '--scope', 'all', '--session', s1.id, '--json']))
    expect(result).toEqual({ sent: [typo.id, handle.id, rename.id], kept: [], target: { session: s1.id }, delivery: 'pasted' })
    expect((await w.api('notes')).notes).toEqual([])
    expect(w.storedNotes()).toEqual([])
    expect(w.notesChanged().length).toBeGreaterThan(0)

    const events = await w.e2e.waitForFakeLog('claude', (log) => inputOf(log).endsWith(`${paste(THREE_PROMPT)}\r`), 15_000)
    expect(inputOf(events)).toBe(`${paste(THREE_PROMPT)}\r`)
  })

  test('a send of one note or one file takes only those', async () => {
    w = await startWorld({ fakes: { claude: { raw: true } } })
    const { handle, rename } = await addThree(w)
    const s1 = await w.startSession('claude')
    const one = await w.api('sendNotes', { scope: 'note', id: handle.id, session: s1.id })
    expect(one.sent).toEqual([handle.id])
    const file = await w.api('sendNotes', { scope: 'file', path: 'util.ts', session: s1.id })
    expect(file.sent).toEqual([rename.id])
    expect((await w.api('notes')).notes.map((note: any) => note.body)).toEqual(['Typo'])
    const events = await w.e2e.waitForFakeLog('claude', (log) => inputOf(log).endsWith(`${paste('File: util.ts\nLines: 2-4\nUser comment: "Rename x"')}\r`), 15_000)
    expect(inputOf(events)).toBe(
      `${paste('File: math.ts\nLine: 30\nUser comment: "Handle the empty list"')}\r${paste('File: util.ts\nLines: 2-4\nUser comment: "Rename x"')}\r`
    )
  })

  test('the send arguments are checked', async () => {
    w = await startWorld({ fakes: { claude: { raw: true } } })
    await addThree(w)
    const s1 = await w.startSession('claude')
    expect((await fails(w.api('sendNotes', { scope: 'all' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await fails(w.api('sendNotes', { scope: 'all', session: s1.id, agent: 'claude' }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await fails(w.api('sendNotes', { scope: 'note', session: s1.id }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await fails(w.api('sendNotes', { scope: 'file', session: s1.id }))).code).toBe(RpcErrorCode.InvalidParams)
    expect((await fails(w.api('sendNotes', { scope: 'note', id: 'note_missing', session: s1.id }))).code).toBe(RpcErrorCode.NotFound)
    expect((await w.api('notes')).notes).toHaveLength(3)
  })
})

describe('sending notes to a new agent tab', () => {
  test('NA-18: a new Claude tab gets the notes on its command line and the notes are deleted', async () => {
    w = await startWorld({ fakes: { claude: { raw: true } } })
    const { handle, rename } = await addThree(w)

    const result = json(await w.cli(['git', 'sendNotes', '--scope', 'file', '--path', 'util.ts', '--agent', 'claude', '--json']))
    expect(result).toMatchObject({ sent: [rename.id], kept: [], delivery: 'command-line' })
    const session = (await w.call('quirky.session/get', { session: result.target.session })) as { agent: string; worktreeId: string; promptDelivery: string }
    expect(session).toMatchObject({ agent: 'claude', worktreeId: w.feat.id, promptDelivery: 'command-line' })
    const starts = startsOf(await w.e2e.waitForFakeLog('claude', (log) => startsOf(log).length === 1, 15_000))
    expect(starts[0]!.argv.join('\n')).toContain('File: util.ts\nLines: 2-4\nUser comment: "Rename x"')
    expect((await w.api('notes')).notes.map((note: any) => note.id)).not.toContain(rename.id)

    const second = await w.api('sendNotes', { scope: 'note', id: handle.id, agent: 'claude' })
    expect(second).toMatchObject({ sent: [handle.id], delivery: 'command-line' })
    expect(second.target.session).not.toBe(result.target.session)
    expect((await w.api('notes')).notes.map((note: any) => note.body)).toEqual(['Typo'])
  })

  test('NA-18: an agent that is pasted to once ready gets the notes and they are deleted', async () => {
    w = await startWorld({ fakes: { goose: readyAfter(200) } })
    const { typo } = await addThree(w)
    const result = await w.api('sendNotes', { scope: 'note', id: typo.id, agent: 'goose' })
    expect(result).toMatchObject({ sent: [typo.id], delivery: 'pasted' })
    const events = await w.e2e.waitForFakeLog('goose', (log) => inputOf(log).endsWith('\r'), 15_000)
    expect(inputOf(events)).toBe(`${paste('File: math.ts\rLine: 5\rUser comment: "Typo"')}\r`)
  })

  test('NA-18: an agent that never reports ready is pasted blind; the send fails and the notes stay', async () => {
    w = await startWorld({ fakes: { aider: silent }, timeScale: 0.1 })
    const { typo } = await addThree(w)
    const failure = await fails(w.api('sendNotes', { scope: 'note', id: typo.id, agent: 'aider' }))
    expect(failure).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'The agent may not have received the notes. They were kept.',
      data: { reason: 'unconfirmed' }
    })
    expect((await w.api('notes')).notes).toHaveLength(3)

    const viaCli = await w.cli(['git', 'sendNotes', '--scope', 'all', '--agent', 'aider', '--json'])
    expect(viaCli.code).not.toBe(0)
    expect(JSON.parse(viaCli.stdout).error.message).toBe('The agent may not have received the notes. They were kept.')
    expect((await w.api('notes')).notes).toHaveLength(3)
  })

  test('NA-18: an agent that exits before it is ready is not delivered to; the send fails and the notes stay', async () => {
    w = await startWorld({ fakes: { amp: { raw: true, exitAfterMs: 100 } }, timeScale: 0.1 })
    await addThree(w)
    const failure = await fails(w.api('sendNotes', { scope: 'all', agent: 'amp' }))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'The agent did not receive the notes.', data: { reason: 'not-delivered' } })
    expect((await w.api('notes')).notes).toHaveLength(3)
  })

  test('an agent that is not installed is refused', async () => {
    w = await startWorld({ fakes: { claude: { raw: true } } })
    await addThree(w)
    const failure = await fails(w.api('sendNotes', { scope: 'all', agent: 'goose' }))
    expect(failure).toMatchObject({ code: RpcErrorCode.InvalidParams, data: { reason: 'agent-unavailable' } })
    expect((await w.api('notes')).notes).toHaveLength(3)
  })
})

describe('notes in flight', () => {
  test('NA-19: a note edited during its send survives; the delivered text is the old one', async () => {
    w = await startWorld({ fakes: { goose: readyAfter(1500) } })
    const { typo, handle } = await addThree(w)
    await w.api('deleteNote', { id: (await w.api('notes', { path: 'util.ts' })).notes[0].id })

    const sending = w.api('sendNotes', { scope: 'all', agent: 'goose' })
    await Bun.sleep(400)
    await w.api('editNote', { id: handle.id, body: 'Handle empty and null' })
    const result = await sending

    expect(result.sent).toEqual([typo.id])
    expect(result.kept).toEqual([handle.id])
    const left = (await w.api('notes')).notes
    expect(left.map((note: any) => [note.id, note.body])).toEqual([[handle.id, 'Handle empty and null']])
    const events = await w.e2e.waitForFakeLog('goose', (log) => inputOf(log).endsWith('\r'), 15_000)
    const received = inputOf(events)
    expect(received).toContain('User comment: "Handle the empty list"')
    expect(received).not.toContain('Handle empty and null')
  })

  test('NA-20: notes in a running send are held out of other sends', async () => {
    w = await startWorld({ fakes: { goose: readyAfter(2500), claude: { raw: true } }, enterDelayMs: 1500 })
    const { typo, handle } = await addThree(w)
    await w.api('deleteNote', { id: (await w.api('notes', { path: 'util.ts' })).notes[0].id })
    const s1 = await w.startSession('claude')
    await w.setAgentState(s1.id, 'working')

    const first = w.api('sendNotes', { scope: 'all', agent: 'goose' })
    await Bun.sleep(400)
    const third = (await w.api('addNote', { path: 'util.ts', line: 1, body: 'Third' })).note
    const second = w.api('sendNotes', { scope: 'all', session: s1.id })
    await Bun.sleep(400)
    const refused = await fails(w.api('sendNotes', { scope: 'all', session: s1.id }))
    expect(refused).toMatchObject({ code: RpcErrorCode.Conflict, message: 'All notes are already being sent.', data: { reason: 'all-held' } })

    expect((await second).sent).toEqual([third.id])
    expect((await first).sent).toEqual([typo.id, handle.id])
    expect((await w.api('notes')).notes).toEqual([])
    const events = await w.e2e.waitForFakeLog('claude', (log) => inputOf(log).endsWith('\r'), 15_000)
    expect(inputOf(events)).toBe(`${paste('File: util.ts\nLine: 1\nUser comment: "Third"')}\r`)
  })

  test('NA-20: a held note can still be deleted, and the send then reports it as sent', async () => {
    w = await startWorld({ fakes: { goose: readyAfter(1200) } })
    const { typo, handle } = await addThree(w)
    const sending = w.api('sendNotes', { scope: 'file', path: 'math.ts', agent: 'goose' })
    await Bun.sleep(300)
    await w.api('deleteNote', { id: typo.id })
    const result = await sending
    expect(result.sent.sort()).toEqual([typo.id, handle.id].sort())
    expect((await w.api('notes')).notes.map((note: any) => note.path)).toEqual(['util.ts'])
  })
})

describe('refusing a send', () => {
  test('NA-21: a target that is not ready is refused and the notes stay', async () => {
    w = await startWorld({ fakes: { claude: { raw: true }, codex: { raw: true }, amp: { raw: true, exitAfterMs: 100 } } })
    await w.api('addNote', { path: 'math.ts', line: 3, body: 'one' })
    const other = (await w.call('quirky.worktree/create', { repo: w.feat.repoId, name: 'other', branchName: 'zoe/other', base: 'main', setup: 'skip' })).worktree

    const s2 = await w.startSession('codex')
    await w.setAgentState(s2.id, 'waiting')
    const s3 = await w.startSession('claude')
    await w.call('quirky.session/setStatus', { session: s3.id, status: 'starting' })
    const s4 = await w.startSession('amp')
    await waitUntil(async () => ((await w!.call('quirky.session/get', { session: s4.id })) as { status: string }).status === 'exited', 15_000)
    const s5 = await w.startSession('shell')
    const s6 = (await w.call('quirky.session/create', { worktree: other.id, agent: 'claude' })) as { id: string }

    const refused = (session: string) => fails(w!.api('sendNotes', { scope: 'all', session }))
    expect(await refused(s2.id)).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Codex is waiting for approval.', data: { reason: 'waiting' } })
    expect(await refused(s3.id)).toMatchObject({ code: RpcErrorCode.Conflict, message: 'Claude is still starting.', data: { reason: 'starting' } })
    expect(await refused(s4.id)).toMatchObject({ code: RpcErrorCode.Conflict, message: 'The session has exited.', data: { reason: 'exited' } })
    const notATarget = { code: RpcErrorCode.InvalidParams, message: 'Notes go to an agent session in this worktree.', data: { reason: 'not-a-target' } }
    expect(await refused(s5.id)).toMatchObject(notATarget)
    expect(await refused(s6.id)).toMatchObject(notATarget)
    expect((await fails(w.api('sendNotes', { scope: 'all', session: 'no-such-session' }))).code).toBe(RpcErrorCode.NotFound)
    expect((await w.api('notes')).notes).toHaveLength(1)

    await w.api('clearNotes', { yes: true })
    expect(await fails(w.api('sendNotes', { scope: 'all', session: s2.id }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'There are no unsent notes.',
      data: { reason: 'no-unsent-notes' }
    })
    expect(await fails(w.api('sendNotes', { scope: 'file', path: 'util.ts', session: s2.id }))).toMatchObject({ data: { reason: 'no-unsent-notes' } })
  })

  test('noteTargets lists live agent sessions of the worktree with why one cannot take notes, and the agents for a new tab', async () => {
    w = await startWorld({ fakes: { claude: { raw: true }, codex: { raw: true } } })
    const s1 = await w.startSession('claude', { title: 'fix tests' })
    await w.setAgentState(s1.id, 'working')
    const s2 = await w.startSession('codex')
    await w.setAgentState(s2.id, 'blocked')
    await w.startSession('shell')

    const targets = await w.api('noteTargets')
    expect(targets.sessions.map((target: any) => [target.session, target.agent, target.label, target.state, target.sendable, target.reason])).toEqual([
      [s1.id, 'claude', 'Claude', 'working', true, undefined],
      [s2.id, 'codex', 'Codex', 'blocked', false, 'Codex is waiting for approval.']
    ])
    expect(targets.sessions[0]).toMatchObject({ title: 'fix tests', status: 'working' })
    expect(typeof targets.sessions[0].lastActivityAt).toBe('number')
    expect(targets.agents.map((agent: any) => agent.id)).toEqual(expect.arrayContaining(['claude', 'codex']))
    expect(targets.agents.map((agent: any) => agent.id)).not.toContain('goose')
    expect(targets.agents.find((agent: any) => agent.id === 'claude')).toEqual({ id: 'claude', label: 'Claude' })
  })
})

describe('removed worktrees', () => {
  test('NA-23: a removed worktree is not found, and its notes are dropped when notes are read', async () => {
    w = await startWorld()
    await addThree(w)
    const keeper = (await w.call('quirky.worktree/create', { repo: w.feat.repoId, name: 'keeper', branchName: 'zoe/keeper', base: 'main', setup: 'skip' })).worktree
    await w.call('quirky.git/addNote', { worktree: keeper.id, path: 'math.ts', line: 1, body: 'stays' })
    expect(w.storedNotes()).toHaveLength(4)

    await w.call('quirky.worktree/remove', { worktree: w.feat.id, yes: true })
    const failure = await fails(w.api('notes'))
    expect(failure.code).toBe(RpcErrorCode.NotFound)
    expect(w.storedNotes().map((note) => note.worktree_id)).toEqual([keeper.id])
    expect((await w.call('quirky.git/notes', { worktree: keeper.id })).notes).toHaveLength(1)
  })

  test('NA-23: activation keeps notes of a worktree that went away while the daemon was down, and a read of it drops them', async () => {
    w = await startWorld()
    const keeper = (await w.call('quirky.worktree/create', { repo: w.feat.repoId, name: 'keeper', branchName: 'zoe/keeper', base: 'main', setup: 'skip' })).worktree
    await addThree(w)
    await w.call('quirky.git/addNote', { worktree: keeper.id, path: 'math.ts', line: 1, body: 'stays' })
    expect(w.storedNotes()).toHaveLength(4)

    Bun.spawnSync(['git', 'worktree', 'remove', '--force', w.feat.path], { cwd: w.e2e.repo, env: { PATH: '/usr/bin:/bin', HOME: w.e2e.userHome, GIT_CONFIG_GLOBAL: '/dev/null' } })
    await w.restartDaemon()
    await w.call('quirky.git/notes', { worktree: keeper.id })
    await Bun.sleep(1_500)
    expect(w.storedNotes()).toHaveLength(4)

    const failure = await fails(w.call('quirky.git/notes', { worktree: w.feat.id }))
    expect(failure.code).toBe(RpcErrorCode.NotFound)
    expect(w.storedNotes().map((note) => note.worktree_id)).toEqual([keeper.id])
  })
})
