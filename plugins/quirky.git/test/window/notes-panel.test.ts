import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, q, qa, rowContainerOf, rowOf, text, toasts } from './dom'
import { boot, DIFF_VIEW, openView, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
const saved = { QUIRKY_AGENT_SEARCH_DIRS: process.env.QUIRKY_AGENT_SEARCH_DIRS, HOME: process.env.HOME }
afterEach(async () => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await shutdown()
})

/**
 * Makes `claude` and `codex` count as installed for the daemon booted next, whatever the machine
 * has, and points HOME at an empty directory so starting their sessions can't reach real agent configs.
 */
function installFakeAgents(): void {
  const base = scratch()
  const dir = join(base, 'fake-agents')
  mkdirSync(join(base, 'home'), { recursive: true })
  mkdirSync(dir, { recursive: true })
  process.env.HOME = join(base, 'home')
  for (const name of ['claude', 'codex']) {
    writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n')
    chmodSync(join(dir, name), 0o755)
  }
  process.env.QUIRKY_AGENT_SEARCH_DIRS = dir
}

type Added = { id: string }

/** NA-10's notes: two on math.ts (unstaged), util.ts 2-4 (staged), README.md 1 (committed on the branch), gone.ts 3 (nowhere). */
async function setUp(w: World): Promise<Record<string, string>> {
  w.commit({ 'README.md': 'one\ntwo\nthree\n' }, 'readme')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.write('util.ts', 'one\ntwo\nthree\nfour\nfive\n')
  w.git('add', 'util.ts')
  const ids: Record<string, string> = {}
  for (const [key, path, startLine, line] of [
    ['readme', 'README.md', 1, 1],
    ['gone', 'gone.ts', 3, 3],
    ['math5', 'math.ts', 5, 5],
    ['math30', 'math.ts', 30, 30],
    ['util', 'util.ts', 2, 4]
  ] as const) {
    const { note } = (await w.agent.callAny('quirky.git/addNote', { worktree: w.feat.id, path, startLine, line, body: `Note ${key}` })) as { note: Added }
    ids[key] = note.id
  }
  await w.win.waitFor(() => qa('[data-note-row]').length === 5)
  return ids
}

const opened = (w: World, path: string) =>
  w.win.waitFor(async () => {
    const view = await openView(w)
    return view?.id === DIFF_VIEW && view.input?.path === path ? view.input : undefined
  })

test('NA-9, NA-10, NA-13: the shelf, the row counts and the overflow item against a real daemon', async () => {
  const w = await boot(scratch)
  expect(q('section[aria-label="Notes"]')).toBeNull()
  const ids = await setUp(w)

  expect([text(q('section[aria-label="Notes"] .ui-section-header__title')), text(q('section[aria-label="Notes"] [aria-label="5 notes"]'))]).toEqual(['Notes', '5'])
  expect(qa('[data-note-row]').map((row) => [row.getAttribute('data-note-path'), text(q('[data-note-line]', row)), text(q('[data-note-body]', row))])).toEqual([
    ['README.md', 'Line 1', 'Note readme'],
    ['gone.ts', 'Line 3', 'Note gone'],
    ['math.ts', 'Line 5', 'Note math5'],
    ['math.ts', 'Line 30', 'Note math30'],
    ['util.ts', 'Lines 2-4', 'Note util']
  ])
  await w.win.waitFor(() => rowOf('util.ts', 'staged') && rowOf('README.md', 'branch'))
  expect(q(rowContainerOf('math.ts', 'unstaged')!, '[data-note-count]')?.title).toBe('2 notes')
  expect(q(rowContainerOf('util.ts', 'staged')!, '[data-note-count]')?.title).toBe('1 note')
  expect(q(rowContainerOf('README.md', 'branch')!, '[data-note-count]')?.title).toBe('1 note')

  await click(byLabel('More source control actions'))
  expect(qa('[role="menu"] button').map(text)).toContain('Notes 5')
  await click(buttonText('Notes 5'))

  const rows = qa('[data-note-row] .ui-list-row__main')
  const expected = [
    ['README.md', 'branch', ids.readme],
    ['gone.ts', 'unstaged', ids.gone],
    ['math.ts', 'unstaged', ids.math5],
    ['math.ts', 'unstaged', ids.math30],
    ['util.ts', 'staged', ids.util]
  ] as const
  for (const [index, [path, source, noteId]] of expected.entries()) {
    await click(rows[index])
    expect(await opened(w, path)).toMatchObject({ worktree: w.feat.id, mode: 'file', source, path, noteId })
    await w.win.waitFor(() => qa('[data-note-row] .ui-list-row__main').length === 5)
  }

  await w.agent.callAny('quirky.git/clearNotes', { worktree: w.feat.id, yes: true })
  await w.win.waitFor(() => q('section[aria-label="Notes"]') === null)
  expect(q('[data-note-count]')).toBeNull()
  expect(w.problems()).toEqual([])
}, SLOW)

test('NA-17, NA-22: the shelf menu lists the agent sessions, sends to one, and the command opens it', async () => {
  installFakeAgents()
  const w = await boot(scratch)
  const note = (path: string, line: number, body: string) => w.agent.callAny('quirky.git/addNote', { worktree: w.feat.id, path, line, body })
  await note('math.ts', 5, 'First')
  await note('math.ts', 30, 'Second')
  await note('util.ts', 2, 'Third')
  const session = async (agent: string, title: string, state?: 'working' | 'waiting') => {
    const made = (await w.agent.callAny('quirky.session/create', { worktree: w.feat.id, agent, title })) as { id: string }
    if (state) {
      const at = Date.now()
      const agentStatus = { state, display: state, label: state, detail: '', progress: null, stateStartedAt: at, evidenceAt: at, restoredUnconfirmed: false }
      await w.agent.callAny('quirky.session/setStatus', { session: made.id, status: state, agentStatus })
    }
    return made.id
  }
  const s1 = await session('claude', 'fix tests', 'working')
  await session('codex', 'review', 'waiting')
  await session('shell', 'zsh')
  await w.win.waitFor(() => qa('[data-note-row]').length === 3)

  await click(q('section[aria-label="Notes"] [aria-label="Send notes to an agent"]'))
  const menu = await w.win.waitFor(() => q('[role="menu"][aria-label="Send notes"]'))
  const rows = qa(':scope > li', menu)
  const labels = rows.map((row) => text(q('[role="menuitem"]', row) ?? row))
  expect(labels.some((label) => label.startsWith('Send notes to'))).toBe(true)
  expect(labels.some((label) => label.startsWith('Claude'))).toBe(true)
  expect(labels.some((label) => label.startsWith('Codex'))).toBe(true)
  expect(labels.some((label) => label.startsWith('New agent'))).toBe(true)
  const buttons = qa(':scope > li > button[role="menuitem"]', menu) as HTMLButtonElement[]
  const [first, second] = buttons
  expect(text(first)).toContain('Working ·')
  expect(first!.disabled).toBe(false)
  expect(second!.disabled).toBe(true)
  expect(second!.title).toBe('Codex is waiting for approval.')

  await click(first)
  await w.win.waitFor(() => toasts().some((toast) => toast.title === 'Notes sent.'))
  expect(toasts().map((toast) => toast.title)).toEqual(['Sending notes...', 'Notes sent.'])
  expect(((await w.agent.callAny('quirky.git/notes', { worktree: w.feat.id })) as { notes: unknown[] }).notes).toEqual([])
  const pasted = w.harness.pty.inputs.filter((input) => input.sessionId === s1).map((input) => input.text).join('')
  expect(pasted).toContain('File: math.ts\nLine: 5\nUser comment: "First"')
  await w.win.waitFor(() => q('section[aria-label="Notes"]') === null)

  await note('math.ts', 1, 'Again')
  await w.win.waitFor(() => q('section[aria-label="Notes"]'))
  await w.agent.callAny('ui.panel.close', {})
  await w.win.waitFor(() => q('section[aria-label="Notes"]') === null)
  await w.run('send-review-notes')
  await w.win.waitFor(() => q('[role="menu"][aria-label="Send notes"]'))
  expect(w.problems()).toEqual([])
}, SLOW)
