import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode, type QuirkyClient, type QuirkyEvent } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'

const OPEN = 'quirky.editor/open'
const NOTES = 'quirky.editor/notes'
const WORKSPACE_NOTES = 'quirky.editor/workspaceNotes'
const SOURCE = 'first line\nselected source line\nlast line\n'

type Fixture = { harness: Harness; client: QuirkyClient; root: string; worktree: string; events: QuirkyEvent[] }
let fixture: Fixture | null = null
let activeHarness: Harness | null = null

beforeEach(async () => {
  const home = makeHomeWithoutAutoHooks('workspace-notes-')
  const harness = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  activeHarness = harness
  const client = await harness.connect('cli')
  const root = join(home, 'workspace')
  mkdirSync(root, { recursive: true })
  await client.callAny('quirky.repo/add', { path: root, folder: true })
  const worktree = (await client.callAny('quirky.worktree/resolve', { selector: `path:${root}` })) as { id: string }
  const subscribed = await harness.connectWithEvents('ui')
  fixture = { harness, client, root, worktree: `id:${worktree.id}`, events: subscribed.events }
})

afterEach(async () => {
  await activeHarness?.cleanup()
  activeHarness = null
  fixture = null
})

function current(): Fixture {
  if (!fixture) throw new Error('workspace note fixture was not started')
  return fixture
}

async function call(method: string, params: Record<string, unknown> = {}): Promise<any> {
  return current().client.callAny(method, params)
}

async function addNote(): Promise<{ note: Record<string, any>; bufferId: string; tabId: string }> {
  const f = current()
  const path = 'nested/readme.md'
  const absolute = join(f.root, path)
  mkdirSync(join(f.root, 'nested'), { recursive: true })
  writeFileSync(absolute, SOURCE)
  const opened = (await call(OPEN, { worktree: f.worktree, path, mode: 'source', focus: false })) as { id: string; openedTabId: string }
  const from = SOURCE.indexOf('selected source line')
  const result = (await call(NOTES, {
    action: 'add',
    bufferId: opened.id,
    selection: { from, to: from + 'selected source line'.length, mode: 'source' },
    text: 'Review this line'
  })) as { note: Record<string, any> }
  return { note: result.note, bufferId: opened.id, tabId: opened.openedTabId }
}

describe('editor workspace Markdown notes', () => {
  test('lists persisted notes after their buffer closes and settles only an exact full snapshot in its worktree', async () => {
    const f = current()
    const added = await addNote()
    await call('quirky.editor/close', { bufferId: added.bufferId, tabId: added.tabId, choice: 'discard' })

    const listed = (await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list' })) as { notes: Array<Record<string, any>> }
    expect(listed.notes).toEqual([added.note])
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list', path: 'nested/readme.md' })).notes).toEqual([added.note])
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list', path: 'missing.md' })).notes).toEqual([])

    f.events.length = 0
    const altered = { ...added.note, body: 'A different persisted snapshot' }
    expect(await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'settle', snapshots: [altered] })).toEqual({
      deletedNoteIds: [],
      retainedNoteIds: [added.note.id]
    })
    expect(await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'settle', snapshots: [added.note] })).toEqual({
      deletedNoteIds: [added.note.id],
      retainedNoteIds: []
    })
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list' })).notes).toEqual([])
    await waitFor(() => f.events.some((event) => event.type === 'quirky.editor/changed') || undefined)
  })

  test('reopened Markdown files can list, edit and delete their persisted rail notes', async () => {
    const f = current()
    const added = await addNote()
    await call('quirky.editor/close', { bufferId: added.bufferId, tabId: added.tabId, choice: 'discard' })
    const reopened = (await call(OPEN, {
      worktree: f.worktree,
      path: 'nested/readme.md',
      mode: 'source',
      focus: false
    })) as { id: string }
    expect(reopened.id).not.toBe(added.bufferId)
    expect((await call(NOTES, { action: 'list', bufferId: reopened.id })).notes).toEqual([added.note])

    const edited = (await call(NOTES, {
      action: 'edit',
      bufferId: reopened.id,
      noteId: added.note.id,
      text: 'Updated after reopening'
    })).note
    expect(edited).toMatchObject({ id: added.note.id, bufferId: reopened.id, body: 'Updated after reopening' })
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list' })).notes).toEqual([edited])
    expect(await call(NOTES, { action: 'delete', bufferId: reopened.id, noteId: added.note.id })).toEqual({
      deleted: true,
      noteId: added.note.id
    })
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list' })).notes).toEqual([])
  })

  test('does not settle a snapshot under another worktree selector', async () => {
    const f = current()
    const added = await addNote()
    const otherRoot = join(f.harness.home, 'other-workspace')
    mkdirSync(otherRoot, { recursive: true })
    await call('quirky.repo/add', { path: otherRoot, folder: true })
    const other = (await call('quirky.worktree/resolve', { selector: `path:${otherRoot}` })) as { id: string }

    await expect(call(WORKSPACE_NOTES, {
      worktree: `id:${other.id}`,
      action: 'settle',
      snapshots: [added.note]
    })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
    expect((await call(WORKSPACE_NOTES, { worktree: f.worktree, action: 'list' })).notes).toEqual([added.note])
  })
})
