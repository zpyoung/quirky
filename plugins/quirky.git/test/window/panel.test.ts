import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Worktree } from '@quirky/protocol'
import { isolateGitConfig, makeRepo } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, press, q, qa, rowOf, rowPaths, sectionHeadings, text, type } from './dom'
import { boot, DIFF_VIEW, openView, SESSION_VIEW, sc1, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
type WorktreeWithSleeping = Worktree & { sleeping: boolean }
afterEach(async () => {
  await shutdown()
  globalThis.__QUIRKY_TEST_REVEAL__ = undefined
})

const setting = (w: World, name: string, value: unknown) => w.agent.callAny('setting.set', { id: `setting:quirky.git/${name}`, value })
const settingValue = async (w: World, name: string) => ((await w.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value
const menuItem = (label: string) => qa('[role="menuitem"]').find((item) => text(item) === label)

test('SC-8: the list is flat, in path order, with the count line under the header line', async () => {
  const w = await boot(scratch)
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt'))
  expect(rowPaths()).toEqual(['README.md', 'math.ts', 'new.ts', 'notes.txt'])
  expect(sectionHeadings()).toEqual(['Commits'])
  expect(text(q('[data-branch-name]'))).toBe('zoe/feat')
  await w.win.waitFor(() => text(q('[data-count-line]')) === '0 of 4 reviewed · 4 uncommitted')
  expect(q('.git-row__dirty--staged', rowOf('README.md')!)).not.toBeNull()
  expect(q('.git-row__dirty--staged', rowOf('math.ts')!)).toBeNull()
  expect(q('.git-row__dirty', rowOf('math.ts')!)).not.toBeNull()
  expect(text(q('.git-row__status', rowOf('new.ts')!))).toBe('R')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-10: opening a terminal from a sleeping Source Control worktree wakes it and opens its session', async () => {
  const w = await boot(scratch)
  await w.win.waitFor(() => q('[data-git-clean]'))
  const sessionsBefore = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
  const previousSessionIds = new Set(sessionsBefore.map((session) => session.id))
  await w.agent.callAny('quirky.worktree/sleep', { worktree: w.feat.id })
  await w.win.waitFor(() => q('main .empty')?.textContent === 'This worktree is sleeping.')
  expect((await w.agent.callAny('quirky.worktree/list', {}) as WorktreeWithSleeping[]).find((worktree) => worktree.id === w.feat.id)?.sleeping).toBe(true)

  await w.agent.callAny('ui.command.run', { id: 'command:quirky.session/new-shell' })
  const terminal = await w.win.waitFor(async () => {
    const view = (await w.state()).slots.find((slot) => slot.id === SESSION_VIEW)?.report
    const sessions = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
    const worktrees = await w.agent.callAny('quirky.worktree/list', {}) as WorktreeWithSleeping[]
    const sleeping = worktrees.find((worktree) => worktree.id === w.feat.id)?.sleeping
    return view && typeof view === 'object' && 'worktree' in view && view.worktree === w.feat.id &&
      'active' in view && typeof view.active === 'string' && !previousSessionIds.has(view.active) &&
      sessions.length === sessionsBefore.length + 1 && sleeping === false &&
      q('main .empty')?.textContent !== 'This worktree is sleeping.' ? view : undefined
  })
  const sessions = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
  expect(sessions).toHaveLength(sessionsBefore.length + 1)
  expect(sessions.find((session) => session.id === terminal.active)).toMatchObject({ id: terminal.active, agent: 'shell' })
  expect((await w.agent.callAny('quirky.session/get', { session: terminal.active }))).toMatchObject({ cwd: w.dir, agent: 'shell' })
  expect((await w.agent.callAny('quirky.worktree/list', {}) as WorktreeWithSleeping[]).find((worktree) => worktree.id === w.feat.id)?.sleeping).toBe(false)
  expect(q('main .empty')?.textContent).not.toBe('This worktree is sleeping.')

  const notes = join(scratch(), 'notes')
  mkdirSync(notes, { recursive: true })
  const folder = (await w.agent.callAny('quirky.repo/add', { path: notes, folder: true })) as Repo
  const [folderTree] = (await w.agent.callAny('quirky.worktree/list', { repo: folder.id })) as Worktree[]
  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: folderTree!.id } })
  await w.win.waitFor(() => q('[data-git-panel] section p'))

  await w.agent.callAny('ui.view.close', {})
  await w.win.waitFor(async () => (await openView(w)) === null)
  expect(w.problems()).toEqual([])
}, SLOW)

test('New agent tab wakes a sleeping selected worktree and opens exactly its agent session', async () => {
  const agentBin = scratch()
  mkdirSync(agentBin, { recursive: true })
  const executable = join(agentBin, 'opencode')
  writeFileSync(executable, '#!/bin/sh\nexec /bin/sleep 30\n')
  chmodSync(executable, 0o755)
  const previousSearchDirs = process.env.QUIRKY_AGENT_SEARCH_DIRS
  process.env.QUIRKY_AGENT_SEARCH_DIRS = agentBin

  try {
    const w = await boot(scratch)
    await w.win.waitFor(() => q('[data-git-clean]'))
    const sessionsBefore = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
    const previousSessionIds = new Set(sessionsBefore.map((session) => session.id))
    await w.agent.callAny('quirky.agents/setDefault', { agent: 'opencode' })
    expect(await w.agent.callAny('quirky.agents/pick', { forAgentTab: true })).toEqual({ agent: 'opencode' })
    await w.agent.callAny('quirky.worktree/sleep', { worktree: w.feat.id })
    await w.win.waitFor(() => q('main .empty')?.textContent === 'This worktree is sleeping.')

    await w.agent.callAny('ui.command.run', { id: 'command:quirky.agents/new-agent-tab' })
    const terminal = await w.win.waitFor(async () => {
      const view = (await w.state()).slots.find((slot) => slot.id === SESSION_VIEW)?.report
      const sessions = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
      const worktrees = await w.agent.callAny('quirky.worktree/list', {}) as WorktreeWithSleeping[]
      const sleeping = worktrees.find((worktree) => worktree.id === w.feat.id)?.sleeping
      return view && typeof view === 'object' && 'worktree' in view && view.worktree === w.feat.id &&
        'active' in view && typeof view.active === 'string' && !previousSessionIds.has(view.active) &&
        sessions.length === sessionsBefore.length + 1 && sleeping === false &&
        q('main .empty')?.textContent !== 'This worktree is sleeping.' ? view : undefined
    })
    const sessions = await w.agent.callAny('quirky.session/list', { worktree: w.feat.id }) as Array<{ id: string; agent: string }>
    expect(sessions).toHaveLength(sessionsBefore.length + 1)
    expect(sessions.find((session) => session.id === terminal.active)).toMatchObject({ id: terminal.active, agent: 'opencode' })
    expect((await w.agent.callAny('quirky.worktree/list', {}) as WorktreeWithSleeping[]).find((worktree) => worktree.id === w.feat.id)?.sleeping).toBe(false)
    expect(q('main .empty')?.textContent).not.toBe('This worktree is sleeping.')
    expect(w.problems()).toEqual([])
  } finally {
    if (previousSearchDirs === undefined) delete process.env.QUIRKY_AGENT_SEARCH_DIRS
    else process.env.QUIRKY_AGENT_SEARCH_DIRS = previousSearchDirs
  }
}, SLOW)

test('SC-16: the filter narrows rows, hides the Commits dock and refuses a long query', async () => {
  const w = await boot(scratch)
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt'))
  await click(byLabel('Filter files by name'))
  const input = (await w.win.waitFor(() => q('input[aria-label="Filter files…"]'))) as HTMLInputElement
  await type(input, 'MATH')
  await w.win.waitFor(async () => (await w.report()).filter === 'MATH')
  expect(rowPaths()).toEqual(['math.ts'])
  expect(q('[data-section="history"]')).toBeNull()

  await type(input, 'x'.repeat(3000))
  await w.win.waitFor(async () => (await w.report()).filter === input.value)
  await w.win.waitFor(() => q('[data-git-content] section p'))
  expect(rowPaths()).toHaveLength(0)
  await press(input, 'Escape')
  await w.win.waitFor(() => rowPaths().length === 4)
  expect(q('[data-section="history"]')).not.toBeNull()
}, SLOW)

test('SC-17: Tree groups rows by folder, the keyboard follows the tree, and the choice persists as the setting', async () => {
  const w = await boot(scratch)
  w.write('src/app/a.ts', 'a\n')
  w.write('src/app/b.ts', 'b\n')
  w.write('lib/c.ts', 'c\n')
  await w.win.waitFor(() => rowOf('lib/c.ts'))
  await click(byLabel('More source control actions'))
  await click(menuItem('Tree'))
  await w.win.waitFor(() => q('[data-directory-path]'))
  expect(await settingValue(w, 'viewMode')).toBe('tree')
  expect((await w.report()).viewMode).toBe('tree')
  const dirs = qa('[data-directory-path]')
  expect(dirs.map((dir) => `${dir.getAttribute('data-directory-name')}${text(q('[role="img"]', dir))}`)).toEqual(['lib1', 'src/app2'])
  expect(rowPaths()).toEqual(['lib/c.ts', 'src/app/a.ts', 'src/app/b.ts'])
  await click(q('[data-directory-path="lib"] button'))
  await w.win.waitFor(() => !rowOf('lib/c.ts'))
  expect(w.git('diff', '--cached', '--name-only')).toBe('')
}, SLOW)

test('SC-18: the row menu opens Review, copies paths and reveals the file; dragging carries the absolute path', async () => {
  const copied: string[] = []
  const revealed: string[] = []
  globalThis.__QUIRKY_TEST_REVEAL__ = (path) => void revealed.push(path)
  const w = await boot(scratch)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => void copied.push(value) }, configurable: true })
  w.write('src/app/a.ts', 'a\n')
  await w.win.waitFor(() => rowOf('src/app/a.ts'))
  const row = rowOf('src/app/a.ts')!

  const open = async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
    await w.win.waitFor(() => q('[role="menu"]'))
  }
  await open()
  expect(qa('[role="menuitem"]').map(text)).toEqual(['Open in Review', 'Open file', 'Mark reviewed', 'Revert file…', 'Stage', 'Copy path', 'Copy relative path', 'Reveal in Finder'])
  await click(menuItem('Copy path'))
  await open()
  await click(menuItem('Copy relative path'))
  await open()
  await click(menuItem('Reveal in Finder'))
  expect(copied).toEqual([join(w.dir, 'src/app/a.ts'), 'src/app/a.ts'])
  await w.win.waitFor(() => revealed.length === 1)
  expect(revealed).toEqual([join(w.dir, 'src/app/a.ts')])
  await open()
  await click(menuItem('Open in Review'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'review', reveal: 'src/app/a.ts' })

  const data = new Map<string, string>()
  const drag = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown }
  drag.dataTransfer = { setData: (type: string, value: string) => void data.set(type, value) }
  row.dispatchEvent(drag)
  expect(data.get('text/plain')).toBe(join(w.dir, 'src/app/a.ts'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-24: a Revert all that fails stops at the first file with one notice, replaced rather than stacked', async () => {
  const w = await boot(scratch)
  w.write('ro/a.txt', 'a\n')
  w.write('ro/b.txt', 'b\n')
  await w.win.waitFor(() => rowOf('ro/b.txt'))
  await w.win.waitFor(async () => ((await w.report()).sections as Array<{ id: string; count: number }>).some((section) => section.id === 'untracked' && section.count === 2))
  chmodSync(join(w.dir, 'ro'), 0o555)
  const notices = '[aria-label="Source control notices"] > [role="alert"], [aria-label="Source control notices"] > [role="status"]'
  try {
    for (let round = 0; round < 2; round++) {
      await click(byLabel('More source control actions'))
      await click(await w.win.waitFor(() => menuItem('Revert all…')))
      await click(buttonText('Revert all', await w.win.waitFor(() => dialogNamed('Revert all 2 files?'))))
      await w.win.waitFor(() => q(notices))
      await Bun.sleep(300)
      expect(qa(notices)).toHaveLength(1)
    }
    const notice = q(notices)!
    expect(text(notice)).toContain('Revert all stopped at “ro/a.txt”')
    expect(text(notice)).toContain('2 of 2 files left')
    expect(buttonText('Retry', notice)).toBeDefined()
    expect(byLabel('Dismiss notification', notice)).toBeDefined()
    expect(rowOf('ro/b.txt')).not.toBeNull()
  } finally {
    chmodSync(join(w.dir, 'ro'), 0o755)
  }
}, SLOW)

test('SC-54: Load more shows the rest of the history, up to 200', async () => {
  const w = await boot(scratch)
  Bun.spawnSync(['sh', '-c', 'for i in $(seq 1 59); do git commit -q --allow-empty -m "c$i"; done'], { cwd: w.dir, env: process.env })
  await w.win.waitFor(() => q('[data-section="history"]'))
  await click(q('[data-section="history"] [aria-label="Expand Commits"]'))
  await w.win.waitFor(() => qa('[data-commit-row]').length === 50)
  await click(buttonText('Load more'))
  await w.win.waitFor(() => qa('[data-commit-row]').length === 60)
  expect(buttonText('Load more')).toBeUndefined()
}, SLOW)

test('quirky.git/changed events refresh the panel and an open diff before the next poll', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => rowOf('math.ts'))
  await w.agent.callAny('ui.command.run', { id: 'command:quirky.git/open-diff', args: { path: 'math.ts', source: 'unstaged' } })
  const card = () => q('[data-git-view-root] section[data-path="math.ts"]')
  await w.win.waitFor(() => card() && q('[contenteditable]', card()!))
  const quickly = (check: () => unknown) => w.win.waitFor(check, 2500)

  expect((await w.cli(['git', 'stage', '--paths', 'math.ts']).done).code).toBe(0)
  await quickly(() => rowOf('math.ts', 'staged'))
  expect((await w.cli(['git', 'unstage', '--paths', 'math.ts']).done).code).toBe(0)
  await quickly(() => rowOf('math.ts') && !rowOf('math.ts', 'staged'))
  expect((await w.cli(['git', 'discard', '--paths', 'math.ts', '--yes']).done).code).toBe(0)
  await quickly(() => !rowOf('math.ts'))
  await quickly(() => card() === null && text(q('[data-review-scroll]')).includes('Nothing changed against'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-7: a dirty submodule row expands to its read-only changes from the daemon', async () => {
  const w = await boot(scratch)
  const lib = makeRepo(join(scratch(), 'lib'), { 'x.c': 'int x;\n' })
  w.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
  w.git('commit', '-q', '-m', 'add submodule')
  w.write('vendor/lib/x.c', 'int y;\n')
  await w.win.waitFor(() => byLabel('Expand vendor/lib'))
  expect(qa('.git-row__actions button', rowOf('vendor/lib')!)).toHaveLength(0)

  await click(byLabel('Expand vendor/lib'))
  await w.win.waitFor(() => qa('[data-submodule-entry]').length === 1)
  const submoduleEntry = q('[data-submodule-entry]')!
  expect(text(q('[data-row-name]', submoduleEntry))).toBe('x.c')
  expect(text(q('.git-row__status[aria-label="Git status modified"]', submoduleEntry))).toBe('M')
  expect(qa('[data-submodule-entry] button')).toHaveLength(0)
  expect((await openView(w))?.id).not.toBe(DIFF_VIEW)

  await click(byLabel('Collapse vendor/lib'))
  expect(qa('[data-submodule-entry]')).toHaveLength(0)
  expect(w.problems()).toEqual([])
}, SLOW)
