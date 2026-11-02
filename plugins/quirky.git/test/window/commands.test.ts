import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, modifiedEditor, q, qa, rowOf, sectionHeadings, stubIntersectionObserver, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, PANEL, SESSION_VIEW, sc1, shutdown, viewTabs, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 120_000
afterEach(shutdown)

const rows = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix} ${i}`).join('\n') + '\n'
const numbered = (n: number, change: Record<number, string> = {}) =>
  Array.from({ length: n }, (_, i) => change[i + 1] ?? `line ${i + 1}`).join('\n') + '\n'

const FILES = { ...BASE_FILES, 'math.ts': numbered(60), 'big.txt': rows(12_000, 'before'), 'b.ts': numbered(20) }

/** feat with math.ts changed in two places and big.txt rewritten. */
async function bootChanged(): Promise<World> {
  const w = await boot(scratch, { files: FILES, noPanel: true })
  w.write('math.ts', numbered(60, { 3: 'line three', 50: 'line fifty' }))
  w.write('big.txt', rows(12_000, 'after'))
  return w
}

/** Merges a branch that conflicts with feat on b.ts in two blocks. */
async function startConflict(w: World): Promise<void> {
  w.git('checkout', '-q', '-b', 'other')
  w.commit({ 'b.ts': numbered(20, { 2: 'theirs 2', 18: 'theirs 18' }) }, 'theirs')
  w.git('checkout', '-q', 'zoe/feat')
  w.commit({ 'b.ts': numbered(20, { 2: 'ours 2', 18: 'ours 18' }) }, 'ours')
  Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
  await w.win.waitFor(async () => (await w.report())?.operation === 'merge')
}

const input = async (w: World) => (await openView(w))?.input
const selectedLine = (editor: EditorView) => editor.state.doc.lineAt(editor.state.selection.main.head).text
const cardOf = (path: string) => q(`[data-git-view-root] section[data-path="${path}"]`)

test('SC-64: every window command routed through ui.command.run does what its button does', async () => {
  const w = await bootChanged()
  const stub = stubIntersectionObserver()
  try {
    expect((await w.state()).layout.panel).not.toBe(PANEL)
    await w.run('show')
    await w.win.waitFor(async () => (await w.state()).layout.panel === PANEL)

    await expect(w.run('next-change')).rejects.toThrow('No diff view is open.')

    await w.run('open-diff', { path: 'math.ts', source: 'unstaged' })
    await w.win.waitFor(async () => (await input(w))?.mode === 'review')
    expect(await input(w)).toMatchObject({ mode: 'review', reveal: 'math.ts', worktree: w.feat.id })
    expect(await input(w)).not.toHaveProperty('source')
    await w.win.waitFor(() => cardOf('math.ts') && q('[contenteditable]', cardOf('math.ts')!))
    const editor = modifiedEditor(EditorView, cardOf('math.ts')!)
    await w.run('next-change')
    await w.win.waitFor(() => selectedLine(editor) === 'line three')
    await w.run('next-change')
    await w.win.waitFor(() => selectedLine(editor) === 'line fifty')
    await w.run('previous-change')
    await w.win.waitFor(() => selectedLine(editor) === 'line three')
    await w.run('save')
    await w.run('reload-from-disk')
    await w.run('overwrite')

    await w.run('open-changes', { area: 'unstaged' })
    const root = await w.win.waitFor(() => {
      const found = q('[data-git-view-root]')
      return found && q('section[data-path="big.txt"]', found) && q('section[data-path="math.ts"]', found) ? found : undefined
    })
    await w.win.waitFor(() => qa('section[data-path]', root).length === 2)
    expect(qa('section[data-path]', root).map((section) => section.getAttribute('data-path')).sort()).toEqual(['big.txt', 'math.ts'])

    await w.run('collapse-all', { collapsed: true })
    await w.win.waitFor(() =>
      buttonText('Expand all', root) !== undefined &&
      qa('section[data-path] button[aria-expanded="false"]', root).length === 2
    )
    await w.run('collapse-all', { collapsed: false })
    await w.win.waitFor(() =>
      buttonText('Collapse all', root) !== undefined &&
      qa('section[data-path] button[aria-expanded="true"]', root).length === 2
    )
    await w.run('collapse-all')
    await w.win.waitFor(() =>
      buttonText('Expand all', root) !== undefined &&
      qa('section[data-path] button[aria-expanded="false"]', root).length === 2
    )
    const bigSection = q('section[data-path="big.txt"]', root)!
    expect(buttonText('Load diff', bigSection)).toBeDefined()
    await w.run('load-diff', { path: 'big.txt' })
    await w.win.waitFor(() => q('[data-diff-editor]', bigSection))
    await expect(w.run('load-diff', { path: 'nothere.txt' })).rejects.toThrow()

    await w.run('open-branch-changes')
    await w.win.waitFor(() => text(q('[data-git-view-root] [data-review-summary]')).includes(' vs '))
    expect(q('[data-git-view-root] .ui-scope-chip')).toBeNull()
    const commit = w.git('rev-parse', 'HEAD')
    await w.run('open-commit', { commit })
    await w.win.waitFor(() => text(q('[data-git-view-root] .ui-scope-chip')).includes(`Commit ${commit.slice(0, 7)}`))
    await w.win.waitFor(() => q('[data-git-view-root] section[data-path]'))
    expect(await viewTabs(w, DIFF_VIEW)).toHaveLength(1)

    await startConflict(w)
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
  await w.win.waitFor(async () => (await input(w))?.mode === 'review')
  await w.win.waitFor(() => cardOf('math.ts') && q('[contenteditable]', cardOf('math.ts')!))
  const editor = modifiedEditor(EditorView, cardOf('math.ts')!)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', code: 'F7', bubbles: true, cancelable: true }))
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
    return view?.id === DIFF_VIEW && view.input?.mode === 'review' && view.input?.reveal === 'math.ts' ? view : undefined
  })
  expect(hosted.input).toMatchObject({ mode: 'review', reveal: 'math.ts' })
  await w.win.waitFor(() => cardOf('math.ts') && q('[contenteditable]', cardOf('math.ts')!))
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

  const viewInput = { worktree: w.feat.id, mode: 'review' }
  const opened = await w.agent.callAny('ui.view.open', { id: DIFF_VIEW, input: viewInput })
  expect(opened).toMatchObject({ view: { id: DIFF_VIEW, input: viewInput } })
  const view = await w.win.waitFor(async () => {
    const report = await w.viewReport()
    return report?.mode === 'review' && report.sections === 5 && report.changes >= 2 ? report : undefined
  })
  expect(view).toMatchObject({ mode: 'review', sections: 5, dirty: false, commit: null })

  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: w.feat.id } })
  await w.win.waitFor(async () => (await w.state()).layout.view?.id === SESSION_VIEW)
  await w.run('open-changes', { area: 'unstaged' })
  const hostedChanges = await w.win.waitFor(async () => {
    const active = await openView(w)
    return active?.input?.mode === 'review' ? active : undefined
  })
  expect(hostedChanges.input?.worktree).toBe(w.feat.id)
  expect(hostedChanges.input).not.toHaveProperty('area')
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="math.ts"] [role="textbox"]'))
  expect(w.problems()).toEqual([])
}, SLOW)
