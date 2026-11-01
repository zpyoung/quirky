import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, modS, primary, q, qa, rowOf, text, toasts } from './dom'
import { boot, DIFF_VIEW, openView, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const editorIn = (root: ParentNode = document) => EditorView.findFromDOM(q('[data-git-view-root] [contenteditable]', root)!)!
const reviewConflictCard = () => qa('[role="status"]').find((card) => buttonText('Review conflicts', card) !== undefined)

test('SC-41: a sync that stops on a conflict leads, in the window, to Continue merge and Push', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'a\nb\nOURS\nd\ne\n' }, 'ours')
  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'math.ts': 'a\nb\nTHEIRS\nd\ne\n' }, 'theirs')
  peer.push('zoe/feat')
  w.git('fetch', '-q')
  await w.win.waitFor(() => text(primary()) === 'Sync' && !primary().disabled)

  await click(primary())
  const conflict = await w.win.waitFor(() => reviewConflictCard())
  expect(buttonText('Review conflicts', conflict)).toBeDefined()
  expect(buttonText('Abort merge', conflict)).toBeDefined()
  expect(toasts()).toHaveLength(1)
  expect(q('textarea[aria-label="Commit message"]')).toBeNull()
  await w.win.waitFor(async () => (await w.report())?.operation === 'merge')

  await click(rowOf('math.ts', 'conflicts'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'conflict-file', path: 'math.ts' })
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]') && q('[data-git-view-root] [role="status"]'))
  expect(text(q('[data-git-view-root] [role="status"]'))).toContain('Unresolved conflict · Both modified')
  await w.win.waitFor(() => text(q('[data-git-view-root] [aria-label="Conflict 1 of 1"]')) === '1 / 1')
  expect(rowOf('math.ts', 'conflicts')).not.toBeNull()
  expect(byLabel('Stage math.ts', q('[data-section="conflicts"]')!)).toBeNull()

  const editor = editorIn()
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'a\nb\nBOTH\nd\ne\n' } })
  expect(editor.state.sliceDoc()).toBe('a\nb\nBOTH\nd\ne\n')
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).not.toBe('a\nb\nBOTH\nd\ne\n')
  await modS(editor)
  await w.win.waitFor(() => readFileSync(join(w.dir, 'math.ts'), 'utf8') === 'a\nb\nBOTH\nd\ne\n')
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('a\nb\nBOTH\nd\ne\n')
  expect(w.git('status', '--porcelain')).toBe('UU math.ts')

  const stage = await w.win.waitFor(() => byLabel('Stage math.ts', q('[data-section="conflicts"]') ?? document))
  await click(stage)
  const banner = await w.win.waitFor(() => qa('[role="status"]').find((card) => buttonText('Continue merge', card) !== undefined))
  expect(buttonText('Continue merge', banner)).toBeDefined()
  expect(q('[role="img"][aria-label^="Resolved locally conflict"]')).not.toBeNull()
  editor.dispatch({ changes: { from: 0, insert: 'unsaved draft: ' } })
  const unsavedDraft = editor.state.sliceDoc()

  await click(buttonText('Continue merge', banner))
  await w.win.waitFor(() => !buttonText('Continue merge') && text(primary()) === 'Push' && !primary().disabled)
  expect(w.git('rev-list', '--count', 'origin/zoe/feat..HEAD')).toBe('2')
  expect(w.git('log', '-1', '--format=%p').split(' ')).toHaveLength(2)
  await w.win.waitFor(async () => (await w.report()).operation === 'none')
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))?.input).toMatchObject({ mode: 'conflict-file', path: 'math.ts' })
  const fileRoot = q('[data-git-view-root]')!
  await w.win.waitFor(() => (fileRoot.querySelector('[role="status"]')?.textContent ?? '').toLowerCase().includes('operation ended'))
  expect(fileRoot.querySelector('h2')?.textContent?.toLowerCase()).not.toContain('conflict')
  expect(fileRoot.querySelector('[role="status"]')?.textContent?.toLowerCase()).toContain('operation ended')
  expect(fileRoot.querySelector('[aria-label^="Conflict "], [aria-label="0 conflicts"]')).toBeNull()
  expect(byLabel('Previous conflict', fileRoot)).toBeNull()
  expect(byLabel('Next conflict', fileRoot)).toBeNull()
  expect(editorIn(fileRoot)).toBe(editor)
  expect(editorIn(fileRoot).state.sliceDoc()).toBe(unsavedDraft)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-43: Abort merge in the window confirms first and returns to the pre-merge commit', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'a\nb\nOURS\nd\ne\n' }, 'ours')
  const before = w.git('rev-parse', 'HEAD')
  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'math.ts': 'a\nb\nTHEIRS\nd\ne\n' }, 'theirs')
  peer.push('zoe/feat')
  w.git('fetch', '-q')
  await w.win.waitFor(() => text(primary()) === 'Sync' && !primary().disabled)
  await click(primary())
  const conflict = await w.win.waitFor(() => reviewConflictCard())

  await click(buttonText('Abort merge', conflict))
  const dialog = await w.win.waitFor(() => dialogNamed('Abort merge?'))
  await click(buttonText('Abort merge', dialog))
  await w.win.waitFor(() => !buttonText('Abort merge'))
  expect(w.git('rev-parse', 'HEAD')).toBe(before)
  expect(w.git('status', '--porcelain')).toBe('')
}, SLOW)
