import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, modS, primary, q, qa, rowOf, text, toasts } from './dom'
import { boot, DIFF_VIEW, openView, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const editorIn = (root: ParentNode = document) => EditorView.findFromDOM(q('.cm-editor', root)!)!

test('SC-41: a sync that stops on a conflict leads, in the window, to Continue merge and Push', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'a\nb\nOURS\nd\ne\n' }, 'ours')
  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'math.ts': 'a\nb\nTHEIRS\nd\ne\n' }, 'theirs')
  peer.push('zoe/feat')
  w.git('fetch', '-q')
  await w.win.waitFor(() => text(primary()) === 'Sync')

  await click(primary())
  const conflict = await w.win.waitFor(() => q('.scm-card-conflict'))
  expect(text(q('strong', conflict))).toBe('Merge conflicts: 1 unresolved')
  expect(buttonText('Review conflicts', conflict)).toBeDefined()
  expect(buttonText('Abort merge', conflict)).toBeDefined()
  expect(toasts()).toContainEqual({
    title: 'Pull stopped with merge conflicts',
    body: 'Resolve them in Source Control, then continue the merge.'
  })
  expect(q('textarea[aria-label="Commit message"]')).toBeNull()
  await w.win.waitFor(async () => (await w.report())?.operation === 'merge')

  await click(rowOf('math.ts', 'conflicts'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'conflict-file', path: 'math.ts' })
  await w.win.waitFor(() => q('.cm-editor') && q('.qgv-banner'))
  expect(text(q('.qgv-banner'))).toContain('Unresolved conflict · Both modified')
  await w.win.waitFor(() => text(q('.qgv-counter')) === '1 / 1')
  expect(rowOf('math.ts', 'conflicts')).not.toBeNull()
  expect(byLabel('Stage math.ts', q('[data-section="conflicts"]')!)).toBeNull()

  const editor = editorIn()
  editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: 'a\nb\nBOTH\nd\ne\n' } })
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
  await modS(editor)
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === false)
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('a\nb\nBOTH\nd\ne\n')
  expect(w.git('status', '--porcelain')).toBe('UU math.ts')

  const stage = await w.win.waitFor(() => byLabel('Stage math.ts', q('[data-section="conflicts"]') ?? document))
  await click(stage)
  const banner = await w.win.waitFor(() => (text(q('.scm-card strong')) === 'Merge in progress' ? q('.scm-card') : undefined))
  expect(buttonText('Continue merge', banner)).toBeDefined()
  expect(text(q('.scm-badge-resolved'))).toBe('Resolved locally')

  await click(buttonText('Continue merge', banner))
  await w.win.waitFor(() => !q('.scm-card') && text(primary()) === 'Push')
  expect(primary().title).toBe('Push 2 commit(s)')
  expect(w.git('rev-list', '--count', 'origin/zoe/feat..HEAD')).toBe('2')
  expect(w.git('log', '-1', '--format=%p').split(' ')).toHaveLength(2)
  await w.win.waitFor(async () => (await w.report()).operation === 'none')
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
  await w.win.waitFor(() => text(primary()) === 'Sync')
  await click(primary())
  const conflict = await w.win.waitFor(() => q('.scm-card-conflict'))

  await click(buttonText('Abort merge', conflict))
  const dialog = await w.win.waitFor(() => qa('[role="dialog"]').find((d) => d.getAttribute('aria-label') === 'Abort merge?'))
  expect(text(q('.dialog-message', dialog))).toBe('This cancels the merge in progress and can discard conflict resolutions made during this merge.')
  await click(buttonText('Abort merge', dialog))
  await w.win.waitFor(() => !q('.scm-card'))
  expect(w.git('rev-parse', 'HEAD')).toBe(before)
  expect(w.git('status', '--porcelain')).toBe('')
}, SLOW)
