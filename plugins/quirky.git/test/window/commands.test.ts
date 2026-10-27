import { afterEach, expect, test } from 'bun:test'
import { EditorView } from '@codemirror/view'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { commandHandlers } from '../../src/view/commands'
import manifest from '../../quirky-plugin.json'
import { click, modifiedEditor, q, qa, rowOf, sectionHeadings, stubIntersectionObserver, text } from './dom'
import { BASE_FILES, boot, DIFF_VIEW, openView, PANEL, sc1, shutdown, type World } from './world'

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
const waitView = (w: World, check: (report: any) => boolean) =>
  w.win.waitFor(async () => {
    const report = await w.viewReport()
    return report && check(report) ? report : undefined
  })

test('SC-64: the manifest declares exactly the commands the window provides', async () => {
  const declared = manifest.contributes.command.map((command) => command.id).sort()
  const provided = Object.keys(commandHandlers({} as never)).sort()
  expect(provided).toEqual(declared)
  const w = await boot(scratch, { noPanel: true })
  const known = ((await w.agent.callAny('ui.contributions', {})) as { commands: Array<{ id: string }> }).commands
    .map((command) => command.id)
    .filter((id) => id.startsWith('command:quirky.git/'))
    .map((id) => id.slice('command:quirky.git/'.length))
    .sort()
  expect(known).toEqual(declared)
  expect(manifest.contributes.keybinding.map((binding) => [binding.key, binding.command])).toEqual([
    ['mod+shift+g', 'show'],
    ['f7', 'next-change'],
    ['shift+f7', 'previous-change'],
    ['mod+shift+a', 'add-review-note']
  ])
}, SLOW)

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
    await waitView(w, (r) => r.mode === 'file' && r.changes === 2 && r.currentChange === 1)
    await w.run('next-change')
    await waitView(w, (r) => r.currentChange === 2)
    await w.run('previous-change')
    await waitView(w, (r) => r.currentChange === 1)

    const editor = modifiedEditor(EditorView)
    editor.dispatch({ changes: { from: 0, insert: 'draft\n' } })
    await waitView(w, (r) => r.dirty === true)
    await w.run('save')
    await waitView(w, (r) => r.dirty === false)
    expect(readFileSync(join(w.dir, 'math.ts'), 'utf8').startsWith('draft\nline 1\n')).toBe(true)
    await w.run('reload-from-disk')
    await w.run('overwrite')

    await w.run('open-changes', { area: 'unstaged' })
    await w.win.waitFor(async () => (await input(w))?.mode === 'combined')
    await waitView(w, (r) => r.mode === 'combined' && r.area === 'unstaged' && r.sections === 2)
    await w.run('collapse-all', { collapsed: true })
    await waitView(w, (r) => r.collapsed === true)
    await w.run('collapse-all', { collapsed: false })
    await waitView(w, (r) => r.collapsed === false)
    await w.run('collapse-all')
    await waitView(w, (r) => r.collapsed === true)
    await w.run('load-diff', { path: 'big.txt' })
    await waitView(w, (r) => r.loadedSections.includes('big.txt'))
    await expect(w.run('load-diff', { path: 'nothere.txt' })).rejects.toThrow()

    await w.run('open-branch-changes')
    await waitView(w, (r) => r.mode === 'combined' && r.area === 'branch')
    const head = w.git('rev-parse', 'HEAD~1')
    await w.run('open-commit', { commit: w.git('rev-parse', 'HEAD') })
    await waitView(w, (r) => r.mode === 'combined' && r.commit === w.git('rev-parse', 'HEAD'))
    expect(head).toHaveLength(40)

    await w.run('review-conflicts')
    await waitView(w, (r) => r.mode === 'conflicts' && r.conflicts === 1)
    await w.run('open-diff', { path: 'b.ts', source: 'conflict' })
    await waitView(w, (r) => r.mode === 'conflict-file' && r.path === 'b.ts' && r.conflicts === 2 && r.currentConflict === 1)
    await w.run('next-conflict')
    await waitView(w, (r) => r.currentConflict === 2)
    await w.run('previous-conflict')
    await waitView(w, (r) => r.currentConflict === 1)

    await w.run('set-filter', { query: 'math' })
    await w.win.waitFor(async () => (await w.report())?.filter === 'math')
    expect(q('input[aria-label="Filter files…"]')).not.toBeNull()
    await w.run('set-filter', { query: '' })
    await w.win.waitFor(async () => (await w.report())?.filter === '')
    await w.run('select', { paths: ['math.ts', 'big.txt'] })
    await w.win.waitFor(async () => ((await w.report())?.selection ?? []).length === 2)
    expect(text(q('.scm-bulk span'))).toBe('2 selected')
    await w.run('select', { paths: [] })
    await w.win.waitFor(async () => (await w.report())?.selection.length === 0)
    await w.run('toggle-history', { open: true })
    await w.win.waitFor(async () => (await w.report())?.historyOpen === true)
    await w.win.waitFor(() => q('[data-section="history"] .scm-history'))
    await w.run('toggle-history')
    await w.win.waitFor(async () => (await w.report())?.historyOpen === false)
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
  await waitView(w, (r) => r.changes === 2 && r.currentChange === 1)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', code: 'F7', bubbles: true, cancelable: true }))
  await waitView(w, (r) => r.currentChange === 2)
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F7', code: 'F7', shiftKey: true, bubbles: true, cancelable: true }))
  await waitView(w, (r) => r.currentChange === 1)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-65: ui state shows what the panel and the diff view display', async () => {
  const w = await boot(scratch)
  w.commit({ 'util.ts': 'export const u = 1\n' }, 'ahead')
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt') && sectionHeadings().includes('Committed on Branch'))
  await w.run('open-diff', { path: 'math.ts', source: 'unstaged' })
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  await click(rowOf('math.ts'), { metaKey: true })

  const panel = await w.win.waitFor(async () => {
    const r = await w.report()
    return r?.selection?.length === 1 && r.base === 'origin/main' && r.sections.length === 4 ? r : undefined
  })
  expect(panel).toEqual({
    worktree: w.feat.id,
    branch: 'zoe/feat',
    base: 'origin/main',
    ahead: 1,
    behind: 0,
    operation: 'none',
    busy: null,
    capped: false,
    sections: [
      { id: 'unstaged', count: 1 },
      { id: 'staged', count: 2 },
      { id: 'untracked', count: 1 },
      { id: 'branch', count: 1 }
    ],
    primary: { label: 'Commit', enabled: false, title: 'Enter a commit message to commit' },
    selection: ['math.ts'],
    filter: '',
    viewMode: 'list',
    historyOpen: false
  })

  const view = await waitView(w, (r) => r.mode === 'file' && r.changes === 2)
  expect(view).toEqual({
    mode: 'file',
    source: 'unstaged',
    path: 'math.ts',
    area: null,
    commit: null,
    changes: 2,
    currentChange: 1,
    dirty: false,
    stale: false,
    tooLarge: false
  })
  expect(w.problems()).toEqual([])
}, SLOW)
