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
const settingValue = async (w: World, name: string) => ((await w.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value

/** F7 and Shift+F7 reach the plugin through the shell's keybinding handler on window. */
async function key(name: string, init: KeyboardEventInit = {}): Promise<void> {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true, ...init }))
  await Bun.sleep(40)
}

async function openRow(w: World, path: string): Promise<void> {
  await click(rowOf(path))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  await w.win.waitFor(() => q('.cm-editor'))
}

test('SC-60: the file diff opens titled, scrolled to the first change, moves with F7 and the arrows, and Close returns to the sessions', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  await w.win.waitFor(() => rowOf('math.ts'))
  await openRow(w, 'math.ts')

  expect(text(q('[data-git-view-root] h2'))).toBe('math.ts (diff)')
  expect(q('.cm-mergeView')).toBeNull()
  const first = await w.win.waitFor(async () => {
    const r = await w.viewReport()
    return r?.changes === 2 ? r : undefined
  })
  expect(first).toMatchObject({ mode: 'file', source: 'unstaged', path: 'math.ts', changes: 2, currentChange: 1, dirty: false })
  expect(text(q('.scm-branch-name'))).toBe('zoe/feat')
  expect((await w.report()).worktree).toBe(w.feat.id)

  await key('F7')
  await w.win.waitFor(async () => (await w.viewReport())?.currentChange === 2)
  await key('F7', { shiftKey: true })
  await w.win.waitFor(async () => (await w.viewReport())?.currentChange === 1)
  await click(byLabel('Next change'))
  await w.win.waitFor(async () => (await w.viewReport())?.currentChange === 2)
  await click(byLabel('Previous change'))
  await w.win.waitFor(async () => (await w.viewReport())?.currentChange === 1)

  await click(byLabel('Switch to side-by-side diff'))
  await w.win.waitFor(() => q('.cm-mergeView'))
  expect(qa('.cm-editor', q('.cm-mergeView')!)).toHaveLength(2)
  expect(await settingValue(w, 'diffDefaultView')).toBe('side-by-side')
  expect(byLabel('Switch to inline diff')).not.toBeNull()

  await click(byLabel('More actions'))
  await click(qa('[role="menuitemcheckbox"]').find((i) => text(i).endsWith('Word Wrap')))
  expect(await settingValue(w, 'diffWordWrap')).toBe(true)
  await click(byLabel('More actions'))
  await click(qa('[role="menuitemcheckbox"]').find((i) => text(i).endsWith('Show Whitespace')))
  expect(await settingValue(w, 'diffShowWhitespace')).toBe(true)
  expect(q('.cm-lineWrapping')).not.toBeNull()

  await w.agent.callAny('setting.set', { id: 'setting:quirky.git/diffCollapseUnchanged', value: true })
  await w.win.waitFor(() => q('.cm-collapsedLines'))

  await click(byLabel('Close'))
  await w.win.waitFor(async () => (await openView(w))?.id === SESSION_VIEW)
  expect((await openView(w))!.input).toEqual({ worktree: w.feat.id })
  expect(text(q('.scm-branch-name'))).toBe('zoe/feat')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-60: a file without changes disables both arrows', async () => {
  const w = await boot(scratch)
  await w.run('open-diff', { path: 'a.ts', source: 'unstaged' })
  await w.win.waitFor(() => q('[data-git-view-root] h2'))
  await w.win.waitFor(() => (byLabel('Next change') as HTMLButtonElement | null)?.disabled === true)
  expect((byLabel('Previous change') as HTMLButtonElement).disabled).toBe(true)
  await w.win.waitFor(async () => (await w.viewReport())?.changes === 0)
}, SLOW)

test('SC-61: an unstaged diff saves with Cmd+S, flags a file rewritten underneath, and offers Overwrite and Reload from Disk', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three' }))
  await w.win.waitFor(() => rowOf('math.ts'))
  await openRow(w, 'math.ts')
  await w.win.waitFor(async () => (await w.viewReport())?.changes === 1)
  expect(q('.cm-content[contenteditable=true]')).not.toBeNull()

  let editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'mine\n' } })
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
  await modS(editor)
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === false)
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('mine\nline 1\n')).toBe(true)

  editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'again\n' } })
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
  writeFileSync(join(w.dir, 'math.ts'), 'agent rewrote this\n')
  await modS(editor)
  const bar = await w.win.waitFor(() => q('[data-git-view-root] [role="alert"]'))
  expect(text(bar)).toContain('This file changed on disk since your edits. Use the banner to compare, reload, or overwrite.')
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('agent rewrote this\n')
  await w.win.waitFor(async () => (await w.viewReport())?.stale === true)

  await click(buttonText('Overwrite', bar))
  await w.win.waitFor(() => !q('[data-git-view-root] [role="alert"]'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('again\nmine\n')).toBe(true)

  editor = modifiedEditor(EditorView)
  editor.dispatch({ changes: { from: 0, insert: 'draft\n' } })
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
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
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === false)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-61: Revert Block and revert-change put a block back in the editor only; staged diffs are read-only', async () => {
  const w = await boot(scratch, { files: FILES })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  w.write('README.md', 'one\ntwo\nthree\n')
  w.git('add', 'README.md')
  await w.win.waitFor(() => rowOf('math.ts') && rowOf('README.md', 'staged'))
  await openRow(w, 'math.ts')
  await w.win.waitFor(async () => (await w.viewReport())?.changes === 2)
  expect(qa('button[name=reject]').length).toBeGreaterThan(0)

  await w.run('revert-change')
  await w.win.waitFor(async () => (await w.viewReport())?.dirty === true)
  const editor = modifiedEditor(EditorView)
  expect(editor.state.sliceDoc()).toContain('\nline 3\n')
  expect(editor.state.sliceDoc()).not.toContain('line three')
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toContain('line three')
  await w.win.waitFor(async () => (await w.viewReport())?.changes === 1)

  await click(rowOf('README.md', 'staged'))
  await w.win.waitFor(async () => (await openView(w))?.input?.path === 'README.md')
  await w.win.waitFor(async () => (await w.viewReport())?.source === 'staged')
  await w.win.waitFor(() => q('.cm-editor'))
  expect(q('.cm-content[contenteditable=true]')).toBeNull()
  expect(q('button[name=reject]')).toBeNull()
  expect(text(q('[data-git-view-root] [data-diff-source="Staged"]'))).toBe('Staged')
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
  expect(text(q('[data-git-view-root] [role="alert"]'))).toMatch(/^Error loading diff: .+/)
  expect(q('.cm-editor')).toBeNull()
}, SLOW)
