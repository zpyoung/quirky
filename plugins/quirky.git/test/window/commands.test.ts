import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, modifiedEditor, q, qa, rowOf, sectionHeadings, stubIntersectionObserver, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, PANEL, SESSION_VIEW, sc1, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 120_000
afterEach(shutdown)

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const FILES = { ...BASE_FILES, 'math.ts': numbered(60), 'big.txt': rows(12_000, 'before'), 'b.ts': numbered(20) }

/** feat mid-merge with b.ts conflicting in two blocks, plus math.ts changed in two places and big.txt rewritten. */
async function bootEverything(): Promise<World> {
  const w = await boot(scratch, { files: FILES, noPanel: true })
  w.git('checkout', '-q', '-b', 'other')
  w.commit({ 'b.ts': numbered(20, { 2: 'theirs 2', 18: 'theirs 18' }) }, 'theirs')
  w.git('checkout', '-q', 'zoe/feat')
  w.commit({ 'b.ts': numbered(20, { 2: 'ours 2', 18: 'ours 18' }) }, 'ours')
  Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  w.write('big.txt', rows(12_000, 'after'))
  return w
}

const input = async (w: World) => (await openView(w))?.input
const selectedLine = (editor: EditorView) => editor.state.doc.lineAt(editor.state.selection.main.head).text


test('SC-64: every window command routed through ui.command.run does what its button does', async () => {
  const w = await bootEverything()
  const stub = stubIntersectionObserver()
  try {
    expect((await w.state()).layout.panel).not.toBe(PANEL)
    await w.run('show')
    await w.win.waitFor(async () => (await w.state()).layout.panel === PANEL)
    await w.win.waitFor(async () => (await w.report())?.operation === 'merge')

    await expect(w.run('next-change')).rejects.toThrow('No diff view is open.')

    await w.run('open-diff', { path: 'math.ts', source: 'unstaged' })
    await w.win.waitFor(async () => (await input(w))?.path === 'math.ts')
    expect(await input(w)).toMatchObject({ mode: 'file', source: 'unstaged', path: 'math.ts', worktree: w.feat.id })
    await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
    const editor = modifiedEditor(EditorView)
    await w.win.waitFor(() => selectedLine(editor) === 'line three')
    await w.run('next-change')
    await w.win.waitFor(() => selectedLine(editor) === 'line fifty')
    await w.run('previous-change')
    await w.win.waitFor(() => selectedLine(editor) === 'line three')

    editor.dispatch({ changes: { from: 0, insert: 'draft\n' } })
    expect(editor.state.sliceDoc().startsWith('draft\n')).toBe(true)
    expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('draft\n')).toBe(false)
    await w.run('save')
    await w.win.waitFor(() => readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('draft\nline 1\n'))
    expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('draft\nline 1\n')).toBe(true)
    expect(editor.state.sliceDoc()).toBe(readFileSync(join(w.dir, 'math.ts'), 'utf8'))
    await w.run('reload-from-disk')
    await w.run('overwrite')

    await w.run('open-changes', { area: 'unstaged' })
    await w.win.waitFor(async () => {
      const view = await openView(w)
      return view?.id === DIFF_VIEW && view.input?.mode === 'combined' && view.input.area === 'unstaged'
    })
    const combinedRoot = await w.win.waitFor(() => {
      const root = q('[data-git-view-root]')
      return root && q('section[data-path="big.txt"]', root) && q('section[data-path="math.ts"]', root) ? root : undefined
    })
    await w.win.waitFor(() => qa('section[data-path]', combinedRoot).length === 2)
    expect(qa('section[data-path]', combinedRoot).map((section) => section.getAttribute('data-path')).sort()).toEqual(['big.txt', 'math.ts'])

    await w.run('collapse-all', { collapsed: true })
    await w.win.waitFor(() =>
      buttonText('Expand All', combinedRoot) !== undefined &&
      qa('section[data-path] button[aria-expanded="false"]', combinedRoot).length === 2
    )
    await w.run('collapse-all', { collapsed: false })
    await w.win.waitFor(() =>
      buttonText('Collapse All', combinedRoot) !== undefined &&
      qa('section[data-path] button[aria-expanded="true"]', combinedRoot).length === 2
    )
    await w.run('collapse-all')
    await w.win.waitFor(() =>
      buttonText('Expand All', combinedRoot) !== undefined &&
      qa('section[data-path] button[aria-expanded="false"]', combinedRoot).length === 2
    )
    const bigSection = q('section[data-path="big.txt"]', combinedRoot)!
    expect(buttonText('Load diff', bigSection)).toBeDefined()
    await w.run('load-diff', { path: 'big.txt' })
    await w.win.waitFor(() => q('[data-diff-editor]', bigSection))
    await expect(w.run('load-diff', { path: 'nothere.txt' })).rejects.toThrow()

    await w.run('open-branch-changes')
    await w.win.waitFor(async () => {
      const view = await openView(w)
      return view?.id === DIFF_VIEW && view.input?.mode === 'combined' && view.input?.area === 'branch'
    })
    await w.win.waitFor(() => {
      const title = q('[data-git-view-root] h2')
      return title !== null && text(title).includes('Branch Changes')
    })
    const head = w.git('rev-parse', 'HEAD~1')
    const commit = w.git('rev-parse', 'HEAD')
    await w.run('open-commit', { commit })
    await w.win.waitFor(async () => {
      const view = await openView(w)
      return view?.id === DIFF_VIEW && view.input?.mode === 'combined' && view.input?.commit === commit
    })
    await w.win.waitFor(() => q('[data-git-view-root] section[data-path]'))
    expect(head).toHaveLength(40)

    await w.run('review-conflicts')
    await w.win.waitFor(async () => (await input(w))?.mode === 'conflicts')
    await w.win.waitFor(() => qa('[data-git-view-root] nav[aria-label="Files"] [data-path]').length === 1)
    expect(qa('[data-git-view-root] nav[aria-label="Files"] [data-path]').map((row) => row.getAttribute('data-path'))).toEqual(['b.ts'])
    expect(text(q('[data-git-view-root]')!)).toContain('1 unresolved conflict')
    await w.run('open-diff', { path: 'b.ts', source: 'conflict' })
    await w.win.waitFor(async () => {
      const view = await openView(w)
      return view?.id === DIFF_VIEW && view.input?.mode === 'conflict-file' && view.input.path === 'b.ts'
    })
    const conflictCount = () => {
      const badge = q('[data-git-view-root] [aria-label^="Conflict "]')
      return badge === null ? '' : text(badge)
    }
    await w.win.waitFor(() => conflictCount() === '1 / 2')
    await w.run('next-conflict')
    await w.win.waitFor(() => conflictCount() === '2 / 2')
    await w.run('previous-conflict')
    await w.win.waitFor(() => conflictCount() === '1 / 2')

    await w.run('set-filter', { query: 'math' })
    await w.win.waitFor(() => (q('input[aria-label="Filter files…"]') as HTMLInputElement | null)?.value === 'math')
    expect(qa('[data-row-path]').map((row) => text(q('[data-row-name]', row)!))).toEqual(['math.ts'])
    await w.run('set-filter', { query: '' })
    await w.win.waitFor(() => q('input[aria-label="Filter files…"]') === null && rowOf('big.txt') !== null)
    await w.run('select', { paths: ['math.ts', 'big.txt'] })
    await w.win.waitFor(() => {
      const selection = q('[role="toolbar"][aria-label="Selection actions"] > span')
      return selection !== null && text(selection) === '2 selected'
    })
    await w.run('select', { paths: [] })
    await w.win.waitFor(() => q('[role="toolbar"][aria-label="Selection actions"]') === null)
    await w.run('toggle-history', { open: true })
    await w.win.waitFor(() => q('[data-history-content]'))
    await w.run('toggle-history')
    await w.win.waitFor(() => q('[data-history-content]') === null)
    await w.run('refresh-compare')

    expect(w.problems()).toEqual([])
  } finally {
    stub.restore()
  }
}, SLOW)

test('SC-64: Mod+Shift+G shows the panel and F7 runs next-change', async () => {
  const w = await boot(scratch, { files: { ...BASE_FILES, 'math.ts': numbered(60) }, noPanel: true })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  expect((await w.state()).layout.panel).not.toBe(PANEL)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }))
  await w.win.waitFor(async () => (await w.state()).layout.panel === PANEL)

  await w.run('open-diff', { path: 'math.ts' })
  await w.win.waitFor(async () => (await input(w))?.path === 'math.ts')
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
  const editor = modifiedEditor(EditorView)
  await w.win.waitFor(() => selectedLine(editor) === 'line three')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', code: 'F7', bubbles: true, cancelable: true }))
  await w.win.waitFor(() => selectedLine(editor) === 'line fifty')
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', code: 'F7', shiftKey: true, bubbles: true, cancelable: true }))
  await w.win.waitFor(() => selectedLine(editor) === 'line three')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-65: the panel report and an explicit top-level diff view report their state', async () => {
  const w = await boot(scratch)
  w.commit({ 'util.ts': 'export const u = 1\n' }, 'ahead')
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt') && sectionHeadings().includes('Committed on Branch'))
  await w.run('open-diff', { path: 'math.ts', source: 'unstaged' })
  const hosted = await w.win.waitFor(async () => {
    const view = await openView(w)
    return view?.id === DIFF_VIEW && view.input?.mode === 'file' && view.input?.source === 'unstaged' && view.input?.path === 'math.ts' ? view : undefined
  })
  expect(hosted.input).toMatchObject({ mode: 'file', source: 'unstaged', path: 'math.ts' })
  await w.win.waitFor(() => {
    const title = q('[data-git-view-root] h2')
    return title !== null && text(title) === 'math.ts (diff)' && q('[data-git-view-root] [contenteditable]') !== null
  })
  await click(rowOf('math.ts'), { metaKey: true })

  const panel = await w.win.waitFor(async () => {
    const r = await w.report()
    return r?.selection?.length === 1 && r.base === 'origin/main' && r.sections.length === 4 ? r : undefined
  })
  expect(panel).toMatchObject({
    worktree: w.feat.id,
    branch: 'zoe/feat',
    base: 'origin/main',
    ahead: 1,
    behind: 0,
    operation: 'none',
    sections: [
      { id: 'unstaged', count: 1 },
      { id: 'staged', count: 2 },
      { id: 'untracked', count: 1 },
      { id: 'branch', count: 1 }
    ],
    selection: ['math.ts']
  })

  const viewInput = { worktree: w.feat.id, mode: 'file', source: 'unstaged', path: 'math.ts' }
  const opened = await w.agent.callAny('ui.view.open', { id: DIFF_VIEW, input: viewInput })
  expect(opened).toMatchObject({ view: { id: DIFF_VIEW, input: viewInput } })
  const view = await w.win.waitFor(async () => {
    const report = await w.viewReport()
    return report?.mode === 'file' && report.source === 'unstaged' && report.path === 'math.ts' && report.changes === 2 && report.currentChange === 1 ? report : undefined
  })
  expect(view).toMatchObject({
    mode: 'file',
    source: 'unstaged',
    path: 'math.ts',
    changes: 2,
    currentChange: 1,
    dirty: false
  })

  await w.run('open-changes', { area: 'unstaged' })
  await w.win.waitFor(async () => (await w.state()).layout.view?.id === SESSION_VIEW)
  const hostedChanges = await w.win.waitFor(async () => {
    const active = await openView(w)
    return active?.input?.mode === 'combined' && active.input.area === 'unstaged' ? active : undefined
  })
  expect(hostedChanges.input?.worktree).toBe(w.feat.id)
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="math.ts"] [role="textbox"]'))
  expect(w.problems()).toEqual([])
}, SLOW)
