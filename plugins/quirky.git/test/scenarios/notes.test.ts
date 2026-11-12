import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { waitFor } from '../../../../packages/daemon/test/helpers'
import { startWorld, type CliResult, type World } from './agents-world'

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
