import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
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
