import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { QuirkyClient } from '@quirky/protocol'
import { builtinsDir, makeHomeWithoutAutoHooks, startHarness, waitFor, type Harness } from '../../../packages/daemon/test/helpers'

const EDITOR_OPEN = 'quirky.editor/open'
const NOTES = 'quirky.editor/notes'
const AGENT_ID = 'transport-test'
const READY = '\x1b[?2004h\x1b[?25h'
const SOURCE = '---\ntitle: Notes\n---\n\nalpha\nselected text\nomega\n'

type Fixture = { h: Harness; client: QuirkyClient; root: string; worktree: string; sessionIds: string[] }
type Note = { id: string; body: string }
type SendResult = { delivery: string; deletedNoteIds: string[]; retainedNoteIds: string[]; sessionId?: string }
type PendingSend = {
  response: Promise<{ value: unknown } | { error: unknown }>
  subscribed: Promise<unknown>
}

let fixture: Fixture | null = null

beforeEach(async () => {
  const home = makeHomeWithoutAutoHooks('m2-markdown-acceptance-')
  const h = await startHarness({ home, builtinPluginsDir: builtinsDir() })
  try {
    const client = await h.connect('cli')
    const root = join(home, 'workspace')
    mkdirSync(root, { recursive: true })
    const repo = (await client.callAny('quirky.repo/add', { path: root, folder: true })) as { id: string }
    const worktree = (await client.callAny('quirky.worktree/resolve', { selector: `id:${repo.id}` })) as { id: string }

    const agentSource = join(home, 'transport-agent-source')
    mkdirSync(agentSource, { recursive: true })
    writeFileSync(
      join(agentSource, 'quirky-plugin.json'),
      JSON.stringify({
        id: 'quirky.transport-test',
        name: 'Transport test agent',
        version: '1.0.0',
        description: 'Temporary fake-PTY transport recipient',
        contributes: {
          agent: [
            {
              id: AGENT_ID,
              label: 'Transport test',
              detect: '/bin/cat',
              launch: '/bin/cat',
              prompt: 'flag-prompt',
              readySignal: 'render-cursor-after-bracketed-paste',
              submitSignal: 'render-cursor-after-bracketed-paste',
              readyTimeoutMs: 5000,
              blindPaste: false
            }
          ]
        }
      })
    )
    const installed = (await client.callAny('plugin.install', { path: agentSource, yes: true })) as { id: string; version: string }
    expect(installed).toMatchObject({ id: 'quirky.transport-test', version: '1.0.0' })

    fixture = { h, client, root, worktree: `id:${worktree.id}`, sessionIds: [] }
  } catch (error) {
    await h.cleanup()
    throw error
  }
})

afterEach(async () => {
  const f = fixture
  fixture = null
  if (!f) return
  try {
    for (const sessionId of f.sessionIds) {
      await f.client.callAny('quirky.session/close', { session: sessionId }).catch(() => undefined)
    }
  } finally {
    await f.h.cleanup()
  }
})

function current(): Fixture {
  if (!fixture) throw new Error('Markdown notes daemon fixture was not started')
  return fixture
}

async function notes(action: string, fields: Record<string, unknown> = {}): Promise<any> {
  return current().client.callAny(NOTES, { action, ...fields })
}

async function openWithNotes(): Promise<{ bufferId: string; selected: Note; unselected: Note }> {
  const f = current()
  writeFileSync(join(f.root, 'notes.md'), SOURCE)
  const buffer = (await f.client.callAny(EDITOR_OPEN, {
    worktree: f.worktree,
    path: 'notes.md',
    mode: 'rich',
    focus: false
  })) as { id: string }
  const bodyStart = SOURCE.indexOf('alpha')
  const add = async (selectedText: string, body: string): Promise<Note> => {
    const from = SOURCE.indexOf(selectedText) - bodyStart
    const result = (await notes('add', {
      bufferId: buffer.id,
      selection: { from, to: from + selectedText.length, mode: 'rich' },
      text: body
    })) as { note: Note }
    return result.note
  }
  const selected = await add('selected text', 'selected review comment')
  const unselected = await add('alpha', 'unselected review comment')
  return { bufferId: buffer.id, selected, unselected }
}

async function createRecipient(): Promise<{ id: string; agent: string }> {
  const session = (await current().client.callAny('quirky.session/create', {
    worktree: current().worktree,
    agent: AGENT_ID
  })) as { id: string; agent: string }
  current().sessionIds.push(session.id)
  return session
}

function startSelectedSend(bufferId: string, sessionId: string, noteId: string): PendingSend {
  const f = current()
  const requestOffset = f.h.pty.requests.length
  const response = f.client
    .callAny(NOTES, {
      action: 'send',
      bufferId,
      target: 'existing',
      sessionId,
      agent: AGENT_ID,
      noteIds: [noteId]
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error })
    )
  const subscribed = waitFor(
    () =>
      f.h.pty.requests.slice(requestOffset).find((request) => request.type === 'subscribe' && request.sessionId === sessionId),
    5000
  )
  return { response, subscribed }
}

async function finishSend(pending: PendingSend): Promise<SendResult> {
  const response = await pending.response
  if ('error' in response) throw response.error
  return response.value as SendResult
}

async function sentInputs(sessionId: string): Promise<{ sessionId: string; text: string }[]> {
  return waitFor(() => {
    const inputs = current().h.pty.inputs.filter((input) => input.sessionId === sessionId)
    return inputs.length >= 2 ? inputs : undefined
  }, 5000)
}

function expectedPaste(comment: string): string {
  return `\x1b[200~File: notes.md\rSource: markdown\r\rLine 6\rExcerpt:\r> selected text\rUser comment: "${comment}"\x1b[201~`
}

test('SC-15: sending selected review notes pastes and submits only those notes, then removes only the delivered note', async () => {
  const { bufferId, selected, unselected } = await openWithNotes()
  const session = await createRecipient()
  const pending = startSelectedSend(bufferId, session.id, selected.id)

  await pending.subscribed
  current().h.pty.emit(session.id, READY)

  const result = await finishSend(pending)
  expect(result).toMatchObject({
    delivery: 'pasted',
    deletedNoteIds: [selected.id],
    retainedNoteIds: [],
    sessionId: session.id
  })
  expect(await sentInputs(session.id)).toEqual([
    { sessionId: session.id, text: expectedPaste('selected review comment') },
    { sessionId: session.id, text: '\r' }
  ])
  const remaining = (await notes('list', { bufferId })) as { notes: Note[]; count: number }
  expect(remaining.count).toBe(1)
  expect(remaining.notes.map(({ id, body }) => ({ id, body }))).toEqual([
    { id: unselected.id, body: 'unselected review comment' }
  ])
})

test('SC-15: editing a selected note while delivery waits retains the newer undelivered text', async () => {
  const { bufferId, selected, unselected } = await openWithNotes()
  const session = await createRecipient()
  const pending = startSelectedSend(bufferId, session.id, selected.id)

  await pending.subscribed
  await notes('edit', { bufferId, noteId: selected.id, text: 'newer edited review comment' })
  current().h.pty.emit(session.id, READY)

  const result = await finishSend(pending)
  expect(result).toMatchObject({
    delivery: 'pasted',
    deletedNoteIds: [],
    retainedNoteIds: [selected.id],
    sessionId: session.id
  })
  expect(await sentInputs(session.id)).toEqual([
    { sessionId: session.id, text: expectedPaste('selected review comment') },
    { sessionId: session.id, text: '\r' }
  ])
  const remaining = (await notes('list', { bufferId })) as { notes: Note[]; count: number }
  expect(remaining.count).toBe(2)
  expect(remaining.notes.map(({ id, body }) => ({ id, body }))).toEqual([
    { id: unselected.id, body: 'unselected review comment' },
    { id: selected.id, body: 'newer edited review comment' }
  ])
})
