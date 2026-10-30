import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, modS, modifiedEditor, q, qa, rowOf, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, SESSION_VIEW, shutdown, viewTabs, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const FILES = { ...BASE_FILES, 'math.ts': numbered(60) }
const selectedLine = (editor: EditorView) => editor.state.doc.lineAt(editor.state.selection.main.head).text
const diffEditors = () =>
  qa('[data-git-view-root] [data-diff-editor] .cm-editor').map((editor) => EditorView.findFromDOM(editor)!)
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

  const readmeDiff = await w.win.waitFor(() =>
    qa('[data-git-view-root]').find((root) => text(q('h2', root)) === 'README.md (diff)')
  )
  await w.win.waitFor(() => q('[contenteditable]', readmeDiff))
  expect(q('[contenteditable="true"]', readmeDiff)).toBeNull()
  expect(q('[data-diff-source="Staged"]', readmeDiff)).not.toBeNull()
}, SLOW)

test('qa-git-3: staging an open Changes diff keeps its comparison and unstage restores the editable diff', async () => {
  const original = 'one\ntwo\n'
  const modified = 'one\nchanged\n'
  const w = await boot(scratch, { files: FILES })
  w.write('README.md', modified)
  await w.win.waitFor(() => rowOf('README.md', 'unstaged'))
  await w.agent.callAny('setting.set', { id: 'setting:quirky.git/diffDefaultView', value: 'side-by-side' })
  await openRow(w, 'README.md')

  await w.win.waitFor(() => {
    const editors = diffEditors()
    const next = byLabel('Next change')
    const previous = byLabel('Previous change')
    return editors.length === 2 &&
      editors[0]?.state.doc.toString() === original &&
      editors[1]?.state.doc.toString() === modified &&
      next !== null && !next.disabled && previous !== null && !previous.disabled
  })
  expect(byLabel('Next change')?.disabled).toBe(false)
  expect(byLabel('Previous change')?.disabled).toBe(false)
  expect(q('[data-git-view-root] [data-diff-source="Staged"]')).toBeNull()
  expect(q('[data-git-view-root] [contenteditable="true"]')).not.toBeNull()

  await click(byLabel('Stage README.md'))
  await w.win.waitFor(() => rowOf('README.md', 'staged') && !rowOf('README.md', 'unstaged'))
  await w.win.waitFor(async () => {
    const editors = diffEditors()
    const next = byLabel('Next change')
    const previous = byLabel('Previous change')
    return q('[data-git-view-root] [data-diff-source="Staged"]') !== null &&
      next !== null && !next.disabled && previous !== null && !previous.disabled &&
      editors.length === 2
  })
  expect(byLabel('Next change')?.disabled).toBe(false)
  expect(byLabel('Previous change')?.disabled).toBe(false)
  expect(qa('[data-git-view-root] [contenteditable="true"]')).toHaveLength(0)
  expect(qa('[data-git-view-root] [data-diff-editor] .cm-content[contenteditable="false"]')).toHaveLength(2)

  await click(byLabel('Unstage README.md'))
  await w.win.waitFor(() => rowOf('README.md', 'unstaged') && !rowOf('README.md', 'staged'))
  await w.win.waitFor(async () => {
    const editors = diffEditors()
    const next = byLabel('Next change')
    const previous = byLabel('Previous change')
    return q('[data-git-view-root] [data-diff-source="Staged"]') === null &&
      next !== null && !next.disabled && previous !== null && !previous.disabled &&
      editors.length === 2 &&
      editors[0]?.state.doc.toString() === original &&
      editors[1]?.state.doc.toString() === modified
  })
  expect(byLabel('Next change')?.disabled).toBe(false)
  expect(byLabel('Previous change')?.disabled).toBe(false)
  expect(q('[data-git-view-root] [contenteditable="true"]')).not.toBeNull()
}, SLOW)

test('qa-git-3: Markdown Preview and Source keep the staged diff in one hosted tab', async () => {
  const original = 'one\ntwo\n'
  const modified = 'one\nchanged\n'
  const w = await boot(scratch, { files: FILES })
  w.write('README.md', modified)
  await w.win.waitFor(() => rowOf('README.md', 'unstaged'))
  await w.agent.callAny('setting.set', { id: 'setting:quirky.git/diffDefaultView', value: 'side-by-side' })
  await click(rowOf('README.md'), { detail: 2 })
  const opened = await w.win.waitFor(async () => {
    const view = await openView(w)
    return view?.id === DIFF_VIEW && view.input?.source === 'unstaged' ? view : undefined
  })
  expect(opened.input).toMatchObject({ source: 'unstaged', preview: false })
  await w.win.waitFor(() => {
    const editors = diffEditors()
    return editors.length === 2 &&
      editors[0]?.state.doc.toString() === original &&
      editors[1]?.state.doc.toString() === modified
  })

  await click(byLabel('Stage README.md'))
  await w.win.waitFor(() => q('[data-git-view-root] [data-diff-source="Staged"]'))
  await w.win.waitFor(() => {
    const editors = diffEditors()
    return editors.length === 2 &&
      q('[data-git-view-root] [contenteditable="true"]') === null
  })
  const firstTabs = await w.win.waitFor(async () => {
    const tabs = (await viewTabs(w, DIFF_VIEW)).filter((tab) => tab.input?.path === 'README.md')
    return tabs.length === 1 ? tabs : undefined
  })
  const tabId = firstTabs[0]!.id

  await click(byLabel('Preview Modified Markdown'))
  await w.win.waitFor(async () => {
    const view = await openView(w)
    return view?.id === DIFF_VIEW && view.input?.display === 'preview' && q('[data-markdown-preview]')
  })
  const previewTabs = (await viewTabs(w, DIFF_VIEW)).filter((tab) => tab.input?.path === 'README.md')
  expect(previewTabs).toHaveLength(1)
  expect(previewTabs[0]?.id).toBe(tabId)
  expect(previewTabs[0]?.input).toMatchObject({ source: 'unstaged', display: 'preview' })

  await click(byLabel('Show Source'))
  await w.win.waitFor(async () => {
    const view = await openView(w)
    const editors = diffEditors()
    return view?.id === DIFF_VIEW && view.input?.display === 'source' &&
      q('[data-git-view-root] [data-diff-source="Staged"]') !== null &&
      editors.length === 2
  })
  const sourceTabs = (await viewTabs(w, DIFF_VIEW)).filter((tab) => tab.input?.path === 'README.md')
  expect(sourceTabs).toHaveLength(1)
  expect(sourceTabs[0]?.id).toBe(tabId)
  expect(sourceTabs[0]?.input).toMatchObject({ source: 'unstaged', display: 'source' })
}, SLOW)

test('qa-git-3: opening a partly staged file from Changes keeps the index as its comparison', async () => {
  const original = numbered(20)
  const staged = numbered(20, { 3: 'line three staged' })
  const modified = numbered(20, { 3: 'line three staged', 15: 'line fifteen unstaged' })
  const w = await boot(scratch, { files: { ...FILES, 'README.md': original } })
  w.write('README.md', modified)
  const indexFile = join(w.dir, '.qa-git-3-partial-index')
  writeFileSync(indexFile, staged)
  const blob = w.git('hash-object', '-w', indexFile)
  w.git('update-index', '--cacheinfo', `100644,${blob},README.md`)
  rmSync(indexFile)
  await w.win.waitFor(() => rowOf('README.md', 'staged') && rowOf('README.md', 'unstaged'))
  await w.agent.callAny('setting.set', { id: 'setting:quirky.git/diffDefaultView', value: 'side-by-side' })
  await openRow(w, 'README.md')

  await w.win.waitFor(async () => {
    const editors = diffEditors()
    const next = byLabel('Next change')
    const previous = byLabel('Previous change')
    return next !== null && !next.disabled && previous !== null && !previous.disabled &&
      editors.length === 2 &&
      editors[0]?.state.doc.toString() === staged &&
      editors[1]?.state.doc.toString() === modified
  })
  expect((await openView(w))!.input).toMatchObject({ source: 'unstaged', path: 'README.md' })
  expect(byLabel('Next change')?.disabled).toBe(false)
  expect(byLabel('Previous change')?.disabled).toBe(false)
  expect(q('[data-git-view-root] [data-diff-source="Staged"]')).toBeNull()
  expect(q('[data-git-view-root] [contenteditable="true"]')).not.toBeNull()
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
