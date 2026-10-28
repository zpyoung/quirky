import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { RpcError, RpcErrorCode } from '@quirky/protocol'
import { paste, readyAfter, silent, startWorld, type FakeEvent, type World } from './agents-world'

setDefaultTimeout(90_000)

let world: World | undefined
afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const inputOf = (events: FakeEvent[]): string =>
  events.map((event) => (event.type === 'input' ? Buffer.from(event.b64, 'base64').toString('utf8') : '')).join('')

async function addMarkdownNote(
  target: World,
  worktree: { id: string; path: string },
  path: string,
  body: string
): Promise<{ note: Record<string, any>; bufferId: string; tabId: string }> {
  const content = 'first line\nselected source line\nlast line\n'
  const absolute = join(worktree.path, path)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, content)
  const opened = (await target.call('quirky.editor/open', {
    worktree: `id:${worktree.id}`,
    path,
    mode: 'source',
    focus: false
  })) as { id: string; openedTabId: string }
  const from = content.indexOf('selected source line')
  const result = (await target.call('quirky.editor/notes', {
    action: 'add',
    bufferId: opened.id,
    selection: { from, to: from + 'selected source line'.length, mode: 'source' },
    text: body
  })) as { note: Record<string, any> }
  return { note: result.note, bufferId: opened.id, tabId: opened.openedTabId }
}

async function closeMarkdownNote(target: World, item: { bufferId: string; tabId: string }): Promise<void> {
  await target.call('quirky.editor/close', { bufferId: item.bufferId, tabId: item.tabId, choice: 'discard' })
}

async function addGitNote(target: World, worktree: string, path: string, line: number, body: string): Promise<Record<string, any>> {
  return (await target.call('quirky.git/addNote', { worktree, path, line, body })).note
}

function createdWorktree(value: unknown): { id: string; path: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !('worktree' in value)) {
    throw new Error('worktree was not created')
  }
  const entry = value.worktree
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry) ||
    !('id' in entry) || typeof entry.id !== 'string' || !('path' in entry) || typeof entry.path !== 'string') {
    throw new Error('worktree was not created')
  }
  return { id: entry.id, path: entry.path }
}


async function fails(promise: Promise<unknown>): Promise<RpcError> {
  try {
    await promise
  } catch (error) {
    return error as RpcError
  }
  throw new Error('expected the call to fail')
}

describe('mixed canonical Source Control notes', () => {
  test('lists closed Markdown notes after restart, scopes by worktree and formats shared shelf notes', async () => {
    world = await startWorld()
    const a = world.feat
    const b = createdWorktree(await world.call('quirky.worktree/create', {
      repo: a.repoId,
      name: 'mixed-b',
      branchName: 'zoe/mixed-b',
      base: 'main',
      setup: 'skip'
    }))

    const gitA = await addGitNote(world, a.id, 'src/a.ts', 14, 'Git review')
    const markdownA = await addMarkdownNote(world, a, 'README.md', 'Markdown review')
    const markdownB = await addMarkdownNote(world, b, 'README.md', 'Other worktree review')
    await closeMarkdownNote(world, markdownA)
    await closeMarkdownNote(world, markdownB)
    await world.restartDaemon()

    const aNotes = (await world.api('notes')) as { notes: Array<Record<string, any>> }
    expect(aNotes.notes).toHaveLength(2)
    expect(aNotes.notes.map((note) => note.id)).toContain(gitA.id)
    expect(aNotes.notes).toContainEqual(expect.objectContaining({
      id: `markdown:${markdownA.note.id}`,
      worktreeId: a.id,
      path: 'README.md',
      startLine: 2,
      line: 2,
      body: 'Markdown review',
      source: 'markdown',
      markdownSnapshot: markdownA.note
    }))

    const bNotes = (await world.call('quirky.git/notes', { worktree: b.id })) as { notes: Array<Record<string, any>> }
    expect(bNotes.notes).toHaveLength(1)
    expect(bNotes.notes[0]).toMatchObject({ id: `markdown:${markdownB.note.id}`, worktreeId: b.id })

    const fileNotes = (await world.api('notes', { path: 'README.md' })) as { notes: Array<Record<string, any>> }
    expect(fileNotes.notes.map((note) => note.id)).toEqual([`markdown:${markdownA.note.id}`])
    const formatted = (await world.api('formatNotes', { path: 'README.md' })) as { text: string; count: number }
    expect(formatted).toEqual({
      count: 1,
      text: 'File: README.md\nSource: markdown\nLine: 2\nUser comment: "Markdown review"'
    })
    expect(formatted.text).not.toContain('Excerpt:')
    expect(formatted.text).not.toContain('selected source line')
    expect((await world.api('formatNotes')).count).toBe(2)
  })

  test('routes Markdown card edits and deletes through the editor after the file closes', async () => {
    world = await startWorld()
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Original Markdown review')
    await closeMarkdownNote(world, markdown)
    const publicId = `markdown:${markdown.note.id}`

    const edited = await world.api('editNote', { id: publicId, body: 'Updated Markdown review' })
    expect(edited.note).toMatchObject({
      id: publicId,
      path: 'README.md',
      body: 'Updated Markdown review'
    })
    expect((await world.api('notes')).notes).toMatchObject([{ id: publicId, body: 'Updated Markdown review' }])
    expect(await world.api('deleteNote', { id: publicId })).toEqual({ ok: true })
    expect((await world.api('notes')).notes).toEqual([])
  })

  test('sends a mixed file scope and a namespaced Markdown note scope', async () => {
    world = await startWorld({ fakes: { claude: { raw: true } } })
    const git = await addGitNote(world, world.feat.id, 'README.md', 1, 'Git README review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown README review')
    const session = await world.startSession('claude')
    await world.setAgentState(session.id, 'working')

    const fileResult = await world.api('sendNotes', { scope: 'file', path: 'README.md', session: session.id })
    expect(fileResult.sent.sort()).toEqual([git.id, `markdown:${markdown.note.id}`].sort())
    expect(fileResult.kept).toEqual([])
    expect((await world.api('notes')).notes).toEqual([])

    const single = await addMarkdownNote(world, world.feat, 'guide.md', 'Single Markdown review')
    const noteResult = await world.api('sendNotes', {
      scope: 'note',
      id: `markdown:${single.note.id}`,
      session: session.id
    })
    expect(noteResult.sent).toEqual([`markdown:${single.note.id}`])
    expect(noteResult.kept).toEqual([])
    expect((await world.api('notes')).notes).toEqual([])
  })

  test('sends one mixed prompt and settles unchanged snapshots from both owners', async () => {
    world = await startWorld({ fakes: { claude: { raw: true } } })
    const git = await addGitNote(world, world.feat.id, 'src/a.ts', 14, 'Git review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown review')
    const session = await world.startSession('claude')
    await world.setAgentState(session.id, 'working')

    const result = await world.api('sendNotes', { scope: 'all', session: session.id })
    expect(result).toEqual({
      sent: expect.arrayContaining([git.id, `markdown:${markdown.note.id}`]),
      kept: [],
      target: { session: session.id },
      delivery: 'pasted'
    })
    expect(result.sent).toHaveLength(2)
    expect((await world.api('notes')).notes).toEqual([])

    const events = await world.e2e.waitForFakeLog('claude', (log) => inputOf(log).endsWith('\r'), 15_000)
    const prompt = [
      'File: README.md\nSource: markdown\nLine: 2\nUser comment: "Markdown review"',
      'File: src/a.ts\nLine: 14\nUser comment: "Git review"'
    ].join('\n\n')
    expect(inputOf(events)).toBe(`${paste(prompt)}\r`)
  })

  test('retains a Markdown note edited from a reopened file while the mixed prompt is in flight', async () => {
    world = await startWorld({ fakes: { goose: readyAfter(1500) } })
    const git = await addGitNote(world, world.feat.id, 'src/a.ts', 14, 'Git review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown review')
    await closeMarkdownNote(world, markdown)
    await world.restartDaemon()
    const reopened = (await world.call('quirky.editor/open', {
      worktree: `id:${world.feat.id}`,
      path: 'README.md',
      mode: 'source',
      focus: false
    })) as { id: string }
    const sending = world.api('sendNotes', { scope: 'all', agent: 'goose' })
    await world.e2e.waitForFakeLog('goose', (log) => log.some((event) => event.type === 'start'), 15_000)
    await world.call('quirky.editor/notes', {
      action: 'edit',
      bufferId: reopened.id,
      noteId: markdown.note.id,
      text: 'Updated Markdown review'
    })

    const result = await sending
    expect(result.sent).toEqual([git.id])
    expect(result.kept).toEqual([`markdown:${markdown.note.id}`])
    const remaining = (await world.api('notes')).notes as Array<Record<string, any>>
    expect(remaining).toHaveLength(1)
    expect(remaining[0]).toMatchObject({ id: `markdown:${markdown.note.id}`, body: 'Updated Markdown review' })
    const input = await world.e2e.waitForFakeLog('goose', (events) => inputOf(events).endsWith('\r'), 15_000)
    expect(inputOf(input)).toContain('User comment: "Markdown review"')
    expect(inputOf(input)).not.toContain('Updated Markdown review')
    await world.call('quirky.editor/notes', { action: 'delete', bufferId: reopened.id, noteId: markdown.note.id })
    expect((await world.api('notes')).notes).toEqual([])
  })

  test('keeps both owners when a new-agent delivery is unconfirmed', async () => {
    world = await startWorld({ fakes: { aider: silent }, timeScale: 0.1 })
    const git = await addGitNote(world, world.feat.id, 'src/a.ts', 14, 'Git review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown review')

    const failure = await fails(world.api('sendNotes', { scope: 'all', agent: 'aider' }))
    expect(failure).toMatchObject({ code: RpcErrorCode.Conflict, message: 'The agent may not have received the notes. They were kept.' })
    expect((await world.api('notes')).notes.map((note: Record<string, any>) => note.id).sort()).toEqual([git.id, `markdown:${markdown.note.id}`].sort())
    const failed = await fails(world.api('sendNotes', { scope: 'all', session: 'missing-session' }))
    expect(failed.code).toBe(RpcErrorCode.NotFound)
    expect((await world.api('notes')).notes.map((note: Record<string, any>) => note.id).sort()).toEqual([git.id, `markdown:${markdown.note.id}`].sort())
  })

  test('shares the Markdown owner hold between a rail send and a mixed Source Control send', async () => {
    world = await startWorld({ fakes: { aider: silent, claude: { raw: true } }, timeScale: 0.1 })
    const git = await addGitNote(world, world.feat.id, 'src/a.ts', 14, 'Git review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown review')
    const session = await world.startSession('claude')
    await world.setAgentState(session.id, 'working')

    const railSend = world.call('quirky.editor/notes', {
      action: 'send',
      bufferId: markdown.bufferId,
      target: 'new',
      agent: 'aider'
    })
    await world.e2e.waitForFakeLog('aider', (log) => log.some((event) => event.type === 'start'), 15_000)
    expect(await world.call('quirky.editor/workspaceNotes', {
      worktree: `id:${world.feat.id}`,
      action: 'reserve',
      holdId: 'mixed-test-probe',
      snapshots: [markdown.note]
    })).toEqual({ reservedNoteIds: [], unavailableNoteIds: [markdown.note.id] })

    const mixed = await world.api('sendNotes', { scope: 'all', session: session.id })
    expect(mixed).toEqual({
      sent: [git.id],
      kept: [`markdown:${markdown.note.id}`],
      target: { session: session.id },
      delivery: 'pasted'
    })
    expect(await railSend).toMatchObject({
      delivery: 'unconfirmed',
      deletedNoteIds: [],
      retainedNoteIds: [markdown.note.id]
    })
    expect(await world.call('quirky.editor/workspaceNotes', {
      worktree: `id:${world.feat.id}`,
      action: 'reserve',
      holdId: 'mixed-test-after-rail',
      snapshots: [markdown.note]
    })).toEqual({ reservedNoteIds: [markdown.note.id], unavailableNoteIds: [] })
    expect(await world.call('quirky.editor/workspaceNotes', {
      worktree: `id:${world.feat.id}`,
      action: 'release',
      holdId: 'mixed-test-after-rail'
    })).toEqual({ releasedNoteIds: [markdown.note.id] })
    expect((await world.api('notes')).notes.map((note: Record<string, any>) => note.id)).toEqual([`markdown:${markdown.note.id}`])
  })

  test('holds both owners against another concurrent mixed Source Control send', async () => {
    world = await startWorld({ fakes: { goose: readyAfter(1500), claude: { raw: true } } })
    const git = await addGitNote(world, world.feat.id, 'src/a.ts', 14, 'Git review')
    const markdown = await addMarkdownNote(world, world.feat, 'README.md', 'Markdown review')
    const secondSession = await world.startSession('claude')
    await world.setAgentState(secondSession.id, 'working')

    const first = world.api('sendNotes', { scope: 'all', agent: 'goose' })
    await world.e2e.waitForFakeLog('goose', (log) => log.some((event) => event.type === 'start'), 15_000)
    expect(await fails(world.api('sendNotes', { scope: 'all', session: secondSession.id }))).toMatchObject({
      code: RpcErrorCode.Conflict,
      message: 'All notes are already being sent.'
    })
    expect(await first).toMatchObject({
      sent: expect.arrayContaining([git.id, `markdown:${markdown.note.id}`]),
      kept: [],
      delivery: 'pasted'
    })
    expect((await world.api('notes')).notes).toEqual([])
  })

  test('confirmation counts and clear-by-file/all settle both owners without crossing worktrees', async () => {
    world = await startWorld()
    const a = world.feat
    const b = createdWorktree(await world.call('quirky.worktree/create', {
      repo: a.repoId,
      name: 'clear-b',
      branchName: 'zoe/clear-b',
      base: 'main',
      setup: 'skip'
    }))
    await addGitNote(world, a.id, 'README.md', 1, 'Git README')
    await addMarkdownNote(world, a, 'README.md', 'Markdown README')
    const markdownGuide = await addMarkdownNote(world, a, 'guide.md', 'Markdown guide')
    const markdownOther = await addMarkdownNote(world, b, 'README.md', 'Other worktree')

    expect(await world.api('describeClearNotes')).toBe('Clear 3 notes from this workspace?')
    expect(await world.api('clearNotes', { path: 'README.md', yes: true })).toEqual({ cleared: 2 })
    expect((await world.api('notes')).notes.map((note: Record<string, any>) => note.id)).toEqual([`markdown:${markdownGuide.note.id}`])
    expect(await world.api('clearNotes', { yes: true })).toEqual({ cleared: 1 })
    expect((await world.api('notes')).notes).toEqual([])
    expect((await world.call('quirky.git/notes', { worktree: b.id })).notes.map((note: Record<string, any>) => note.id)).toEqual([
      `markdown:${markdownOther.note.id}`
    ])
  })
})
