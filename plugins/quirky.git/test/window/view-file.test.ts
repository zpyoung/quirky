import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, modS, modifiedEditor, q, qa, rowOf, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, SESSION_VIEW, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const FILES = { ...BASE_FILES, 'math.ts': numbered(60) }
const selectedLine = (editor: EditorView) => editor.state.doc.lineAt(editor.state.selection.main.head).text
const settingValue = async (w: World, name: string) => ((await w.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value

/** F7 and Shift+F7 reach the plugin through the shell's keybinding handler on window. */
async function key(name: string, init: KeyboardEventInit = {}): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true, ...init }))
  await Bun.sleep(40)
}

async function openRow(w: World, path: string): Promise<void> {
  await click(rowOf(path))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
}

test('SC-60: the file diff opens titled, scrolled to the first change, moves with F7 and the arrows, and Close returns to the sessions', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  await w.win.waitFor(() => rowOf('math.ts'))
  await openRow(w, 'math.ts')
  expect((await openView(w))!.input).toMatchObject({ mode: 'file', source: 'unstaged', path: 'math.ts' })

  expect(text(q('[data-git-view-root] h2'))).toBe('math.ts (diff)')
  const editor = modifiedEditor(EditorView)
  await w.win.waitFor(() => selectedLine(editor) === 'line three' && !(byLabel('Previous change') as HTMLButtonElement).disabled && !(byLabel('Next change') as HTMLButtonElement).disabled)
  expect((byLabel('Previous change') as HTMLButtonElement).disabled).toBe(false)
  expect((byLabel('Next change') as HTMLButtonElement).disabled).toBe(false)
  expect(text(q('[data-branch-name]'))).toBe('zoe/feat')
  expect((await w.report()).worktree).toBe(w.feat.id)

  await key('F7')
  await w.win.waitFor(() => selectedLine(editor) === 'line fifty')
  await key('F7', { shiftKey: true })
  await w.win.waitFor(() => selectedLine(editor) === 'line three')
  await click(byLabel('Next change'))
  await w.win.waitFor(() => selectedLine(editor) === 'line fifty')
  await click(byLabel('Previous change'))
  await w.win.waitFor(() => selectedLine(editor) === 'line three')

  await click(byLabel('Switch to side-by-side diff'))
  await w.win.waitFor(() => qa('[data-git-view-root] [role="textbox"][contenteditable]').length === 2)
  expect(qa('[data-git-view-root] [role="textbox"][contenteditable]')).toHaveLength(2)
  expect(await settingValue(w, 'diffDefaultView')).toBe('side-by-side')
  expect(byLabel('Switch to inline diff')).not.toBeNull()

  await click(byLabel('More actions'))
  await click(qa('[role="menuitemcheckbox"]').find((i) => text(i).endsWith('Word Wrap')))
  expect(await settingValue(w, 'diffWordWrap')).toBe(true)
  await click(byLabel('More actions'))
  await click(qa('[role="menuitemcheckbox"]').find((i) => text(i).endsWith('Show Whitespace')))
  expect(await settingValue(w, 'diffShowWhitespace')).toBe(true)

  await w.agent.callAny('setting.set', { id: 'setting:quirky.git/diffCollapseUnchanged', value: true })

  await click(byLabel('Close'))
  await w.win.waitFor(async () => (await openView(w))?.id === SESSION_VIEW)
  expect((await openView(w))!.input).toEqual({ worktree: w.feat.id })
  expect(text(q('[data-branch-name]'))).toBe('zoe/feat')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-60: a file without changes disables both arrows', async () => {
  const w = await boot(scratch)
  await w.run('open-diff', { path: 'a.ts', source: 'unstaged' })
  await w.win.waitFor(() => q('[data-git-view-root] h2'))
  await w.win.waitFor(() => (byLabel('Next change') as HTMLButtonElement | null)?.disabled === true)
  expect((byLabel('Previous change') as HTMLButtonElement).disabled).toBe(true)
}, SLOW)

test('SC-61: an unstaged diff saves with Cmd+S, flags a file rewritten underneath, and offers Overwrite and Reload from Disk', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three' }))
  await w.win.waitFor(() => rowOf('math.ts'))
  await openRow(w, 'math.ts')

  expect(q('[data-git-view-root] [contenteditable="true"]')).not.toBeNull()

  let editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'mine\n' } })
  expect(editor.state.sliceDoc().startsWith('mine\nline 1\n')).toBe(true)
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe(numbered(60, { 3: 'line three' }))
  await modS(editor)
  await w.win.waitFor(() => readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('mine\nline 1\n'))

  expect(modifiedEditor(EditorView).state.sliceDoc()).toBe(readFileSync(join(w.dir, 'math.ts'), 'utf8'))
  editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'again\n' } })
  expect(editor.state.sliceDoc().startsWith('again\nmine\nline 1\n')).toBe(true)
  writeFileSync(join(w.dir, 'math.ts'), 'agent rewrote this\n')
  await modS(editor)
  const bar = await w.win.waitFor(() => q('[data-git-view-root] [role="alert"]'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('agent rewrote this\n')

  await click(buttonText('Overwrite', bar))
  await w.win.waitFor(() => !q('[data-git-view-root] [role="alert"]'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('again\nmine\n')).toBe(true)

  editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'draft\n' } })
  expect(editor.state.sliceDoc().startsWith('draft\nagain\nmine\n')).toBe(true)
  writeFileSync(join(w.dir, 'math.ts'), 'second rewrite\n')
  await modS(editor)
  const second = await w.win.waitFor(() => q('[data-git-view-root] [role="alert"]'))
  await click(buttonText('Reload from Disk', second))
  await w.win.waitFor(() => !q('[data-git-view-root] [role="alert"]'))
  // the reload rebuilds the editor, so wait for the new one rather than reading the old
  await w.win.waitFor(() => {
    try {
      return modifiedEditor(EditorView).state.sliceDoc() === 'second rewrite\n'
    } catch {
      return false
    }
  })
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('second rewrite\n')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-61: Revert Block and revert-change put a block back in the editor only; staged diffs are read-only', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  w.write('README.md', 'one\ntwo\nthree\n')
  w.git('add', 'README.md')
  await w.win.waitFor(() => rowOf('math.ts') && rowOf('README.md', 'staged'))
  await openRow(w, 'math.ts')
  const editor = modifiedEditor(EditorView)
  await w.win.waitFor(() => selectedLine(editor) === 'line three')
  await w.run('revert-change')
  await w.win.waitFor(() => editor.state.sliceDoc() === numbered(60, { 50: 'line fifty' }))
  expect(editor.state.sliceDoc()).toBe(numbered(60, { 50: 'line fifty' }))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe(numbered(60, { 3: 'line three', 50: 'line fifty' }))
  await w.win.waitFor(async () => {
    const result = await w.agent.callAny('quirky.terminal/workspace', { workspace: w.feat.id }) as {
      workspace: { root: { tabs?: Array<{ input?: { path?: string }; closeParams?: { dirty?: boolean } }> } }
    }
    return result.workspace.root.tabs?.some((tab) => tab.input?.path === 'math.ts' && tab.closeParams?.dirty === true)
  })

  await click(rowOf('README.md', 'staged'))
  await w.win.waitFor(async () => {
    const view = await openView(w)
    return view?.input?.mode === 'file' && view.input.source === 'staged' && view.input.path === 'README.md'
  })
  expect((await openView(w))!.input).toMatchObject({ mode: 'file', source: 'staged', path: 'README.md' })

  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
  expect(q('[data-git-view-root] [contenteditable="true"]')).toBeNull()
  expect(q('[data-git-view-root] [data-diff-source="Staged"]')).not.toBeNull()
}, SLOW)

test('SC-57: a branch diff whose merge base cannot be read says so instead of looking empty', async () => {
  const w = await boot(scratch, { files: FILES })
  w.commit({ 'math.ts': numbered(60, { 3: 'line three' }) }, 'change math')
  await w.win.waitFor(() => rowOf('math.ts', 'branch'))
  const blob = w.git('rev-parse', 'origin/main:math.ts')
  const common = w.git('rev-parse', '--git-common-dir')
  const loose = join(common.startsWith('/') ? common : join(w.dir, common), 'objects', blob.slice(0, 2), blob.slice(2))
  rmSync(loose)

  await click(rowOf('math.ts', 'branch'))
  await w.win.waitFor(() => q('[data-git-view-root] [role="alert"]'))
  expect(q('[data-git-view-root] [contenteditable]')).toBeNull()
}, SLOW)
