import { afterEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { EditorView } from '@codemirror/view'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, modifiedEditor, q, qa, rowOf, selectedPaths, stubIntersectionObserver, text } from './dom'
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
  const commitB = (content: string, message: string) => {
    w.write('b.ts', content)
    w.git('add', 'b.ts')
    w.git('commit', '-q', '-m', message)
  }
  w.git('checkout', '-q', '-b', 'other')
  commitB(numbered(20, { 2: 'theirs 2', 18: 'theirs 18' }), 'theirs')
  w.git('checkout', '-q', 'zoe/feat')
  commitB(numbered(20, { 2: 'ours 2', 18: 'ours 18' }), 'ours')
  const merge = Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
  const status = w.git('status', '--porcelain')
  if (merge.exitCode !== 1 || !status.split('\n').some((line) => line === 'UU b.ts')) {
    const output = [merge.stdout.toString().trim(), merge.stderr.toString().trim()].filter(Boolean).join('\n')
    throw new Error(`Expected git merge to conflict on b.ts (exit ${merge.exitCode}, status ${JSON.stringify(status)}): ${output}`)
  }
  await w.win.waitFor(async () => (await w.report())?.operation === 'merge')
}

const input = async (w: World) => (await openView(w))?.input
const selectedLine = (editor: EditorView) => editor.state.doc.lineAt(editor.state.selection.main.head).text
const cardOf = (path: string) => q(`[data-git-view-root] section[data-path="${path}"]`)
type WorkspaceTab = { id: string; kind?: 'view'; viewId?: string; input?: Record<string, unknown> }
type WorkspaceGroup = { kind: 'group'; id: string; tabs: WorkspaceTab[]; activeTab: string | null }
type WorkspaceNode = WorkspaceGroup | { kind: 'split'; first: WorkspaceNode; second: WorkspaceNode }

const groupsIn = (node: WorkspaceNode): WorkspaceGroup[] =>
  node.kind === 'group' ? [node] : [...groupsIn(node.first), ...groupsIn(node.second)]

async function windowConnId(world: World): Promise<number> {
  const connId = (await world.state()).windows[0]?.connId
  if (typeof connId !== 'number') throw new Error('The headless window has no connection ID')
  return connId
}

async function runOn<T>(world: World, id: string, args: Record<string, unknown> = {}): Promise<T> {
  const response = await world.agent.callAny('ui.window.command.run', {
    connId: await windowConnId(world),
    id: `command:quirky.git/${id}`,
    args
  }) as { result: T }
  return response.result
}

async function layoutFor(world: World, connId: number): Promise<unknown> {
  return (await world.agent.callAny('ui.window.state', { connId }) as { layout: unknown }).layout
}

async function navigationFor(world: World, connId: number): Promise<unknown> {
  return world.agent.callAny('quirky.worktree/navigationState', { window: connId })
}

async function selectedTab(world: World, worktree = world.feat.id): Promise<string | null> {
  const { workspace } = await world.agent.callAny('quirky.terminal/workspace', { workspace: worktree }) as {
    workspace: { activeGroup: string; root: WorkspaceNode }
  }
  return groupsIn(workspace.root).find((group) => group.id === workspace.activeGroup)?.activeTab ?? null
}

async function editorSentinel(world: World): Promise<string> {
  const opened = await world.agent.callAny('quirky.editor/open', {
    worktree: world.feat.id,
    path: 'a.ts',
    focus: true
  }) as { openedTabId: string }
  return opened.openedTabId
}

async function workspaceTabs(world: World, worktree = world.feat.id): Promise<WorkspaceTab[]> {
  const { workspace } = await world.agent.callAny('quirky.terminal/workspace', { workspace: worktree }) as {
    workspace: { root: WorkspaceNode }
  }
  return groupsIn(workspace.root).flatMap((group) => group.tabs)
}


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
    expect(await input(w)).toMatchObject({ mode: 'review', reveal: 'math.ts', worktree: w.feat.id, source: 'unstaged' })
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
    await w.win.waitFor(() => selectedPaths().join() === 'math.ts')
    await w.run('select', { paths: [] })
    await w.win.waitFor(() => selectedPaths().length === 0)
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
  await w.win.waitFor(() => {
    const content = q('[data-git-content]')
    return content !== null && !text(content).includes('Loading…')
  })
  w.commit({ 'util.ts': 'export const u = 1\n' }, 'ahead')
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt') && rowOf('util.ts'))
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
  expect(hostedChanges.input).toMatchObject({ source: 'unstaged' })
  expect(hostedChanges.input).not.toHaveProperty('area')
  await w.win.waitFor(() => q('[data-git-view-root] section[data-path="math.ts"] [role="textbox"]'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('background Review opens keep the window untouched and defer each reveal until shown', async () => {
  const w = await boot(scratch, { noPanel: true })
  sc1(w)
  const sentinel = await editorSentinel(w)
  const connId = await windowConnId(w)
  const layout = await layoutFor(w, connId)
  expect(await selectedTab(w)).toBe(sentinel)

  const first = await runOn<{ worktree: string; tabId: string; created: boolean; focused: boolean; source: string | null; reveal: string | null }>(
    w,
    'open-diff',
    { path: 'math.ts', focus: false }
  )
  expect(first).toMatchObject({
    worktree: w.feat.id, created: true, focused: false, source: null, reveal: 'math.ts'
  })
  expect(typeof first.tabId).toBe('string')
  const tabs = await viewTabs(w, DIFF_VIEW)
  expect(tabs).toHaveLength(1)
  expect(tabs[0]!.input).toMatchObject({ worktree: w.feat.id, mode: 'review', reveal: 'math.ts', tabId: first.tabId })
  await w.win.waitFor(() => qa('.qt-tab-title').some((title) => text(title) === 'Review'))
  expect(q('[data-review-tab]')).toBeNull()
  expect(await selectedTab(w)).toBe(sentinel)
  expect(await layoutFor(w, connId)).toEqual(layout)

  await w.agent.callAny('quirky.terminal/activateTab', { tab: first.tabId })
  await w.win.waitFor(() => cardOf('math.ts')?.hasAttribute('data-active'))
  expect(cardOf('math.ts')?.hasAttribute('data-active')).toBe(true)
  const storedInput = structuredClone((await viewTabs(w, DIFF_VIEW))[0]!.input)

  const next = await runOn<{ worktree: string; tabId: string; created: boolean; focused: boolean; source: string | null; reveal: string | null }>(
    w,
    'open-diff',
    { path: 'README.md', focus: false }
  )
  expect(next).toMatchObject({
    worktree: w.feat.id, tabId: first.tabId, created: false, focused: false, source: null, reveal: 'README.md'
  })
  // Real time lets the delayed renderer effect settle; fake timers cannot advance daemon/renderer scheduling.
  await Bun.sleep(500)
  expect(cardOf('math.ts')?.hasAttribute('data-active')).toBe(true)
  expect(cardOf('README.md')?.hasAttribute('data-active')).not.toBe(true)
  expect((await viewTabs(w, DIFF_VIEW))[0]!.input).toEqual(storedInput)

  await w.agent.callAny('quirky.terminal/activateTab', { tab: sentinel })
  await w.win.waitFor(() => q('[data-review-tab]') === null)
  await w.agent.callAny('quirky.terminal/activateTab', { tab: first.tabId })
  await w.win.waitFor(() => cardOf('README.md')?.hasAttribute('data-active'))
  expect(cardOf('README.md')?.hasAttribute('data-active')).toBe(true)
  expect(w.problems()).toEqual([])
}, SLOW)

test('focused command navigation uses only its routed UI connection', async () => {
  const w = await boot(scratch, { noPanel: true })
  sc1(w)
  const two = await w.addWorktree('two')
  const win = await windowConnId(w)
  const ui2 = await w.harness.connect('ui')
  const { connId: c2 } = await ui2.callAny('ui.window.self', {}) as { connId: number }
  await w.agent.callAny('ui.window.view.open', {
    connId: win, id: SESSION_VIEW, input: { worktree: two.id }
  })
  await ui2.callAny('ui.window.view.open', {
    connId: c2, id: SESSION_VIEW, input: { worktree: two.id }
  })
  const before = {
    winLayout: await layoutFor(w, win),
    c2Layout: await layoutFor(w, c2),
    winHistory: await navigationFor(w, win),
    c2History: await navigationFor(w, c2)
  }

  const background = await runOn<{ focused: boolean; tabId: string }>(
    w,
    'open-diff',
    { worktree: w.feat.id, path: 'math.ts', focus: false }
  )
  expect(background.focused).toBe(false)
  expect(await layoutFor(w, win)).toEqual(before.winLayout)
  expect(await navigationFor(w, win)).toEqual(before.winHistory)
  expect(await layoutFor(w, c2)).toEqual(before.c2Layout)
  expect(await navigationFor(w, c2)).toEqual(before.c2History)

  const [review] = await viewTabs(w, DIFF_VIEW)
  expect(review?.id).toBe(background.tabId)
  const focused = await runOn<{
    worktree: string
    mode: string
    source: string | null
    focused: boolean
    review: { worktree: string; tabId: string; created: boolean; focused: boolean; source: string | null; reveal: string | null }
    opened: unknown[]
    skipped: unknown[]
  }>(w, 'open-changes', { worktree: w.feat.id })
  expect(focused).toMatchObject({
    worktree: w.feat.id,
    mode: 'diff',
    source: null,
    focused: true,
    review: {
      worktree: w.feat.id, tabId: background.tabId, created: false, focused: true, source: null, reveal: null
    },
    opened: [],
    skipped: []
  })
  expect(await layoutFor(w, win)).toMatchObject({ view: { id: SESSION_VIEW, input: { worktree: w.feat.id } } })
  const history = await navigationFor(w, win) as { worktrees: string[]; index: number }
  expect(history.worktrees[history.index]).toBe(w.feat.id)
  expect(await selectedTab(w)).toBe(background.tabId)
  expect(await layoutFor(w, c2)).toEqual(before.c2Layout)
  expect(await navigationFor(w, c2)).toEqual(before.c2History)
  const ambiguous = await w.run('open-changes').then(
    () => null,
    (error: unknown) => error instanceof Error ? error.message : String(error)
  )
  expect(ambiguous).toBe('multiple Quirky windows are open; specify connId')
}, SLOW)

test('staged and unstaged scopes filter one Review tab and reject paths outside the scope', async () => {
  const w = await boot(scratch, { noPanel: true })
  sc1(w)
  const staged = await runOn<{ tabId: string; source: string | null; reveal: string | null }>(
    w,
    'open-diff',
    { path: 'README.md', source: 'staged' }
  )
  expect(staged).toMatchObject({ source: 'staged', reveal: 'README.md' })
  const [review] = await viewTabs(w, DIFF_VIEW)
  expect(review?.id).toBe(staged.tabId)
  expect(review?.input).toMatchObject({ worktree: w.feat.id, mode: 'review', source: 'staged', reveal: 'README.md' })
  await w.win.waitFor(() =>
    qa('[data-git-view-root] section[data-path]').length === 2 &&
    text(q('[data-git-view-root] .ui-scope-chip')).includes('Staged changes') &&
    q('[data-diff-editor]', cardOf('README.md')!)
  )
  expect(qa('[data-git-view-root] section[data-path]').map((section) => section.getAttribute('data-path')).sort())
    .toEqual(['README.md', 'new.ts'])
  expect(text(q('[data-git-view-root] .ui-scope-chip'))).toContain('Staged changes')
  expect(qa('[data-git-view-root] section[data-path] .git-review__review button')).toHaveLength(0)
  expect(q('[contenteditable="true"]', cardOf('README.md')!)).toBeNull()

  const unstaged = await runOn<{ review: { tabId: string } | null; source: string | null }>(
    w,
    'open-changes',
    { area: 'unstaged' }
  )
  expect(unstaged).toMatchObject({ review: { tabId: staged.tabId }, source: 'unstaged' })
  await w.win.waitFor(() =>
    qa('[data-git-view-root] section[data-path]').length === 2 &&
    q('[contenteditable="true"]', cardOf('math.ts')!)
  )
  expect(qa('[data-git-view-root] section[data-path]').map((section) => section.getAttribute('data-path')).sort())
    .toEqual(['math.ts', 'notes.txt'])
  expect(text(q('[data-git-view-root] .ui-scope-chip'))).toContain('Unstaged changes')
  expect(qa('[data-git-view-root] section[data-path] .git-review__review button')).toHaveLength(0)
  expect(q('[contenteditable="true"]', cardOf('math.ts')!)).not.toBeNull()

  const all = await runOn<{ review: { tabId: string } | null; source: string | null }>(w, 'open-changes')
  expect(all).toMatchObject({ review: { tabId: staged.tabId }, source: null })
  await w.win.waitFor(() => qa('[data-git-view-root] section[data-path]').length === 4 && q('.ui-scope-chip') === null)
  expect(qa('[data-git-view-root] section[data-path]').map((section) => section.getAttribute('data-path')).sort())
    .toEqual(['README.md', 'math.ts', 'new.ts', 'notes.txt'])
  expect(q('.ui-scope-chip')).toBeNull()

  const storedInput = structuredClone((await viewTabs(w, DIFF_VIEW))[0]!.input)
  const selected = await selectedTab(w)
  await expect(runOn(w, 'open-diff', { path: 'notes.txt', source: 'staged' })).rejects.toMatchObject({
    code: RpcErrorCode.Conflict,
    message: 'notes.txt has no staged changes.'
  })
  expect((await viewTabs(w, DIFF_VIEW))[0]!.input).toEqual(storedInput)
  expect(await selectedTab(w)).toBe(selected)
  await expect(runOn(w, 'open-diff', { path: 'README.md', source: 'unstaged' })).rejects.toMatchObject({
    code: RpcErrorCode.Conflict,
    message: 'README.md has no unstaged changes.'
  })
  expect((await viewTabs(w, DIFF_VIEW)).map((tab) => tab.id)).toEqual([staged.tabId])
}, SLOW)

test('edit and both open sorted changed files, skip deletions, reuse tabs and leave clean worktrees alone', async () => {
  const w = await boot(scratch, { noPanel: true })
  sc1(w)
  w.git('rm', '-q', 'c.ts')
  rmSync(join(w.dir, 'd.ts'))
  writeFileSync(join(w.dir, 'bin.dat'), new Uint8Array([0, 1, 2, 255, 0]))
  const sentinel = await editorSentinel(w)
  const connId = await windowConnId(w)
  const layout = await layoutFor(w, connId)
  const expectedSkipped = [
    { path: 'c.ts', reason: 'deleted' },
    { path: 'd.ts', reason: 'deleted' }
  ]
  type OpenedFile = { path: string; tabId: string; bufferId: string }
  type ChangesResult = {
    worktree: string
    mode: 'edit' | 'both'
    source: string | null
    focused: boolean
    review: { worktree: string; tabId: string; created: boolean; focused: boolean } | null
    opened: OpenedFile[]
    skipped: { path: string; reason: string }[]
  }

  const edit = await runOn<ChangesResult>(w, 'open-changes', { mode: 'edit', focus: false })
  expect(edit).toMatchObject({
    worktree: w.feat.id,
    mode: 'edit',
    source: null,
    focused: false,
    review: null,
    skipped: expectedSkipped
  })
  expect(edit.opened.map(({ path }) => path)).toEqual(['README.md', 'bin.dat', 'math.ts', 'new.ts', 'notes.txt'])
  for (const file of edit.opened) {
    expect(typeof file.tabId).toBe('string')
    expect(typeof file.bufferId).toBe('string')
  }
  expect(await selectedTab(w)).toBe(sentinel)
  expect(await layoutFor(w, connId)).toEqual(layout)
  expect(await viewTabs(w, DIFF_VIEW)).toHaveLength(0)
  const documentTabs = (await workspaceTabs(w)).filter((tab) => tab.kind === 'view' && tab.viewId === 'view:quirky.editor/document')
  for (const file of edit.opened) {
    expect(documentTabs.filter((tab) => tab.input?.bufferId === file.bufferId).map((tab) => tab.id)).toEqual([file.tabId])
  }

  const both = await runOn<ChangesResult>(w, 'open-changes', { mode: 'both' })
  expect(both).toMatchObject({
    worktree: w.feat.id,
    mode: 'both',
    source: null,
    focused: true,
    skipped: expectedSkipped,
    review: { created: true, focused: true }
  })
  expect(both.opened).toEqual(edit.opened)
  expect((await viewTabs(w, DIFF_VIEW)).map((tab) => tab.id)).toEqual([both.review!.tabId])
  expect(await selectedTab(w)).toBe(both.review!.tabId)

  const staged = await runOn<ChangesResult>(w, 'open-changes', { mode: 'edit', area: 'staged', focus: false })
  expect(staged).toMatchObject({
    mode: 'edit', source: 'staged', focused: false,
    skipped: [{ path: 'c.ts', reason: 'deleted' }]
  })
  expect(staged.opened.map(({ path }) => path)).toEqual(['README.md', 'new.ts'])
  expect(staged.opened.map(({ tabId }) => tabId)).toEqual(edit.opened.filter(({ path }) => ['README.md', 'new.ts'].includes(path)).map(({ tabId }) => tabId))

  const unstaged = await runOn<ChangesResult>(w, 'open-changes', { mode: 'edit', area: 'unstaged' })
  expect(unstaged).toMatchObject({
    mode: 'edit', source: 'unstaged', focused: true,
    skipped: [{ path: 'd.ts', reason: 'deleted' }]
  })
  expect(unstaged.opened.map(({ path }) => path)).toEqual(['bin.dat', 'math.ts', 'notes.txt'])
  expect(await selectedTab(w)).toBe(unstaged.opened[0]!.tabId)
  expect(await layoutFor(w, connId)).toMatchObject({ view: { id: SESSION_VIEW, input: { worktree: w.feat.id } } })

  const two = await w.addWorktree('two')
  const noChangeLayout = await layoutFor(w, connId)
  const noChanges = await runOn<ChangesResult>(w, 'open-changes', { worktree: two.id, mode: 'edit' })
  expect(noChanges).toMatchObject({
    worktree: two.id,
    mode: 'edit',
    source: null,
    focused: false,
    review: null,
    opened: [],
    skipped: []
  })
  expect(await layoutFor(w, connId)).toEqual(noChangeLayout)
}, SLOW)
