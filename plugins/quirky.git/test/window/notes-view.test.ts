import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { byLabel, click, modifiedEditor, press, q, qa, rowContainerOf, rowOf, text, type } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const numbered = (n: number, change: Record<number, string> = {}) => Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

type StoredNote = { id: string; path: string; startLine: number; line: number; body: string }
const stored = async (w: Awaited<ReturnType<typeof boot>>) => ((await w.agent.callAny('quirky.git/notes', { worktree: w.feat.id })) as { notes: StoredNote[] }).notes

/** The `.cm-line` element of line `n` of the modified editor. */
function lineEl(view: InstanceType<typeof EditorView>, n: number): HTMLElement {
  const { node } = view.domAtPos(view.state.doc.line(n).from)
  return (node instanceof Element ? node : node.parentElement!).closest('.cm-line') as HTMLElement
}

test('NA-1: the "+" beside line 12 adds a note that every part of the window shows', async () => {
  const w = await boot(scratch, { files: { ...BASE_FILES, 'math.ts': numbered(30) } })
  w.write('math.ts', numbered(30, { 3: 'line three' }))
  await w.win.waitFor(() => rowOf('math.ts'))
  expect(q('section[aria-label="Notes"]')).toBeNull()
  await click(rowOf('math.ts'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  await w.win.waitFor(() => q('.cm-editor'))
  const view = modifiedEditor(EditorView)
  expect(q('button[aria-label^="Show "]')).toBeNull()

  lineEl(view, 12).dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
  const plus = await w.win.waitFor(() => byLabel('Add note for the AI'))
  expect(plus.title).toBe('Add note for the AI')
  await click(plus)
  const draft = await w.win.waitFor(() => q('[data-note-card="draft"]'))
  expect(text(q('.ui-tool-panel-frame__title', draft))).toBe('Line 12')
  expect(qa('button', draft).map(text)).toEqual(['Cancel', 'Add note'])
  const area = q('textarea', draft) as HTMLTextAreaElement
  expect(area.placeholder).toBe('Add note for the AI')

  await type(area, 'Handle the empty list')
  await press(area, 'Enter')
  const card = await w.win.waitFor(() => q('[data-note-card="saved"]'))
  expect(text(q('.ui-tool-panel-frame__title', card))).toBe('Note line 12')
  expect(text(q('p', card))).toBe('Handle the empty list')
  expect(q('[data-note-card="draft"]')).toBeNull()
  expect(qa('button', card).map((b) => b.getAttribute('aria-label'))).toEqual(['Send notes to an agent', 'Edit note', 'Delete note'])
  expect(lineEl(view, 12).nextElementSibling?.contains(card)).toBe(true)

  expect(await stored(w)).toMatchObject([{ path: 'math.ts', startLine: 12, line: 12, body: 'Handle the empty list' }])
  expect(text(q('button[aria-label="Show 1 AI note"]'))).toBe('AI notes 1')
  await w.win.waitFor(() => q('[data-note-count]', rowContainerOf('math.ts')!)?.title === '1 note')
  expect(text(q('.ui-section-header__title', q('section[aria-label="Notes"]')))).toBe('Notes')
  expect(text(q('section[aria-label="Notes"] [aria-label="1 note"]'))).toBe('1')

  await click(byLabel('Edit note', card))
  const editor = q('textarea', card) as HTMLTextAreaElement
  await type(editor, 'Handle empty and null')
  await press(editor, 'Enter')
  await w.win.waitFor(async () => (await stored(w))[0]?.body === 'Handle empty and null')
  await w.win.waitFor(() => text(q('p', q('[data-note-card="saved"]'))) === 'Handle empty and null')

  await click(byLabel('Delete note', q('[data-note-card="saved"]')!))
  await w.win.waitFor(async () => (await stored(w)).length === 0)
  await w.win.waitFor(() => q('[data-note-card="saved"]') === null && q('button[aria-label^="Show "]') === null && q('section[aria-label="Notes"]') === null)
  expect(w.problems()).toEqual([])
}, SLOW)

test('NA-2, NA-14: a command-opened draft and the combined view over a real daemon', async () => {
  const w = await boot(scratch, { files: { ...BASE_FILES, 'math.ts': numbered(30) } })
  w.write('math.ts', numbered(30, { 3: 'line three' }))
  await w.agent.callAny('quirky.git/addNote', { worktree: w.feat.id, path: 'math.ts', line: 5, body: 'Existing' })
  await w.win.waitFor(() => rowOf('math.ts'))
  await w.run('open-changes', { area: 'unstaged' })
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  const card = await w.win.waitFor(() => q('[data-note-card="saved"]'))
  expect(text(q('.ui-tool-panel-frame__title', card))).toBe('Note line 5')
  expect(text(byLabel('Show 1 AI note'))).toBe('AI notes 1')
  const view = modifiedEditor(EditorView)
  view.dispatch({ selection: { anchor: view.state.doc.line(7).from, head: view.state.doc.line(9).to } })
  await w.run('add-review-note')
  const draft = await w.win.waitFor(() => q('[data-note-card="draft"]'))
  expect(text(q('.ui-tool-panel-frame__title', draft))).toBe('Lines 7-9')
  expect(w.problems()).toEqual([])
}, SLOW)
