import { afterEach, expect, test } from 'bun:test'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Repo, Worktree } from '@quirky/protocol'
import { isolateGitConfig, makeRepo } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, press, q, qa, rowOf, sectionHeadings, text, type } from './dom'
import { boot, DIFF_VIEW, openView, SESSION_VIEW, sc1, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const setting = (w: World, name: string, value: unknown) => w.agent.callAny('setting.set', { id: `setting:quirky.git/${name}`, value })
const settingValue = async (w: World, name: string) => ((await w.agent.callAny('setting.get', { id: `setting:quirky.git/${name}` })) as { value: unknown }).value
const menuItem = (label: string) => qa('[role="menuitem"]').find((item) => text(item) === label)

test('SC-9: the group order setting reorders the sections live, with Conflicts first', async () => {
  const w = await boot(scratch)
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt'))
  expect(sectionHeadings()).toEqual(['Changes', 'Staged Changes', 'Untracked Files', 'Commits'])
  await setting(w, 'groupOrder', 'staged-first')
  await w.win.waitFor(() => sectionHeadings()[0] === 'Staged Changes')
  expect(sectionHeadings()).toEqual(['Staged Changes', 'Changes', 'Untracked Files', 'Commits'])
  await setting(w, 'groupOrder', 'untracked-first')
  await w.win.waitFor(() => sectionHeadings()[0] === 'Untracked Files')
  expect(sectionHeadings()).toEqual(['Untracked Files', 'Changes', 'Staged Changes', 'Commits'])
}, SLOW)

test('SC-10: the empty states say what to do', async () => {
  const w = await boot(scratch)
  await w.win.waitFor(() => q('.scm-empty'))
  expect(text(q('.scm-empty strong'))).toBe('No changes on this branch')
  expect(text(q('.scm-empty p'))).toBe('This workspace is clean and this branch has no changes ahead of origin/main')

  const notes = join(scratch(), 'notes')
  mkdirSync(notes, { recursive: true })
  const folder = (await w.agent.callAny('quirky.repo/add', { path: notes, folder: true })) as Repo
  const [folderTree] = (await w.agent.callAny('quirky.worktree/list', { repo: folder.id })) as Worktree[]
  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: folderTree!.id } })
  await w.win.waitFor(() => q('.scm-unavailable'))
  expect(text(q('.scm-unavailable'))).toBe('Opened as folder. Git features are unavailable for this workspace.')

  await w.agent.callAny('ui.view.close', {})
  await w.win.waitFor(() => text(q('.scm-root .muted')) === 'Select a workspace to view changes')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-16: the filter narrows rows, hides the bulk buttons and refuses a long query', async () => {
  const w = await boot(scratch)
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt'))
  await click(byLabel('Filter files by name'))
  const input = (await w.win.waitFor(() => q('input[aria-label="Filter files…"]'))) as HTMLInputElement
  await type(input, 'MATH')
  await w.win.waitFor(async () => (await w.report()).filter === 'MATH')
  expect(qa('.scm-row-name').map(text)).toEqual(['math.ts'])
  expect(q('[data-section="history"]')).toBeNull()
  expect(qa('.scm-section-actions button')).toHaveLength(0)

  await type(input, 'x'.repeat(3000))
  await w.win.waitFor(() => text(q('.scm-empty strong')) === 'Search text is too large')
  expect(text(q('.scm-empty p'))).toBe('Use a shorter file filter.')
  await press(input, 'Escape')
  await w.win.waitFor(() => qa('.scm-row-name').length === 4)
  expect(q('[data-section="history"]')).not.toBeNull()
}, SLOW)

test('SC-17: View as tree groups rows by folder, stages a folder, and the choice persists as the setting', async () => {
  const w = await boot(scratch)
  w.write('src/app/a.ts', 'a\n')
  w.write('src/app/b.ts', 'b\n')
  w.write('lib/c.ts', 'c\n')
  await w.win.waitFor(() => rowOf('lib/c.ts'))
  await click(byLabel('More source control actions'))
  await click(menuItem('View as tree'))
  await w.win.waitFor(() => q('.scm-dir'))
  expect(await settingValue(w, 'viewMode')).toBe('tree')
  expect((await w.report()).viewMode).toBe('tree')
  const dirs = qa('.scm-dir').map((d) => text(q('.scm-row-name', d)) + text(q('.scm-count', d)))
  expect(dirs).toEqual(['lib1', 'src/app2'])

  const folder = qa('.scm-dir').find((d) => text(q('.scm-row-name', d)) === 'src/app')!
  await click(byLabel('Stage folder src/app', folder))
  await w.win.waitFor(() => rowOf('src/app/b.ts', 'staged'))
  expect(w.git('diff', '--cached', '--name-only').split('\n')).toEqual(['src/app/a.ts', 'src/app/b.ts'])
}, SLOW)

test('SC-18: the row menu opens the diff, copies paths and reveals the file; dragging carries the absolute path', async () => {
  const w = await boot(scratch)
  const copied: string[] = []
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (value: string) => void copied.push(value) }, configurable: true })
  const revealed: string[] = []
  globalThis.__QUIRKY_TEST_REVEAL__ = (path) => void revealed.push(path)
  w.write('src/app/a.ts', 'a\n')
  await w.win.waitFor(() => rowOf('src/app/a.ts'))
  const row = rowOf('src/app/a.ts')!.closest('li')!

  const open = async () => {
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 30, clientY: 40 }))
    await w.win.waitFor(() => q('[role="menu"]'))
  }
  await open()
  expect(qa('[role="menuitem"]').map(text)).toEqual(['View', 'Copy Path', 'Copy Relative Path', 'Reveal in Finder'])
  await click(menuItem('Copy Path'))
  await open()
  await click(menuItem('Copy Relative Path'))
  await open()
  await click(menuItem('Reveal in Finder'))
  expect(copied).toEqual([join(w.dir, 'src/app/a.ts'), 'src/app/a.ts'])
  await w.win.waitFor(() => revealed.length === 1)
  expect(revealed).toEqual([join(w.dir, 'src/app/a.ts')])
  await open()
  await click(menuItem('View'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)

  const data = new Map<string, string>()
  const drag = new Event('dragstart', { bubbles: true }) as Event & { dataTransfer: unknown }
  drag.dataTransfer = { setData: (type: string, value: string) => void data.set(type, value) }
  row.dispatchEvent(drag)
  expect(data.get('text/plain')).toBe(join(w.dir, 'src/app/a.ts'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-24: a bulk discard that fails shows one notice with the first message, replaced rather than stacked', async () => {
  const w = await boot(scratch)
  w.write('ro/a.txt', 'a\n')
  w.write('ro/b.txt', 'b\n')
  await w.win.waitFor(() => rowOf('ro/b.txt'))
  chmodSync(join(w.dir, 'ro'), 0o555)
  try {
    for (let round = 0; round < 2; round++) {
      await click(byLabel('Delete all untracked', q('[data-section="untracked"]')!))
      await click(buttonText('Delete 2', await w.win.waitFor(() => dialogNamed('Delete 2 untracked files?'))))
      await w.win.waitFor(() => q('.notice'))
      await Bun.sleep(300)
      expect(qa('.notice')).toHaveLength(1)
    }
    const notice = q('.notice')!
    expect(text(q('strong', notice))).toBe('Failed to discard 2 file(s)')
    expect(text(q('.notice-text', notice))).toContain('ro/a.txt, ro/b.txt')
    expect(buttonText('Retry', notice)).toBeDefined()
    expect(buttonText('Dismiss', notice)).toBeDefined()
  } finally {
    chmodSync(join(w.dir, 'ro'), 0o755)
  }
}, SLOW)

test('SC-54: Load more shows the rest of the history, up to 200', async () => {
  const w = await boot(scratch)
  Bun.spawnSync(['sh', '-c', 'for i in $(seq 1 59); do git commit -q --allow-empty -m "c$i"; done'], { cwd: w.dir, env: process.env })
  await w.win.waitFor(() => q('[data-section="history"]'))
  await click(q('[data-section="history"] .scm-section-toggle'))
  await w.win.waitFor(() => qa('.scm-commit').length === 50)
  await click(buttonText('Load more'))
  await w.win.waitFor(() => qa('.scm-commit').length === 60)
  expect(buttonText('Load more')).toBeUndefined()
}, SLOW)

test('quirky.git/changed events refresh the panel and an open diff before the next poll', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => rowOf('math.ts'))
  await w.agent.callAny('ui.command.run', { id: 'command:quirky.git/open-diff', args: { path: 'math.ts', source: 'unstaged' } })
  await w.win.waitFor(() => q('.cm-editor'))
  const quickly = (check: () => unknown) => w.win.waitFor(check, 1500)

  expect((await w.cli(['git', 'stage', '--paths', 'math.ts']).done).code).toBe(0)
  await quickly(() => rowOf('math.ts', 'staged'))
  expect((await w.cli(['git', 'unstage', '--paths', 'math.ts']).done).code).toBe(0)
  await quickly(() => rowOf('math.ts', 'unstaged'))
  expect((await w.cli(['git', 'discard', '--paths', 'math.ts', '--yes']).done).code).toBe(0)
  await quickly(() => !rowOf('math.ts'))
  await quickly(() => q('.qgv-file') && (byLabel('Next change') as HTMLButtonElement).disabled)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-7: a dirty submodule row expands to its read-only changes from the daemon', async () => {
  const w = await boot(scratch)
  const lib = makeRepo(join(scratch(), 'lib'), { 'x.c': 'int x;\n' })
  w.git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', lib, 'vendor/lib')
  w.git('commit', '-q', '-m', 'add submodule')
  w.write('vendor/lib/x.c', 'int y;\n')
  await w.win.waitFor(() => rowOf('vendor/lib', 'unstaged'))
  expect(text(rowOf('vendor/lib'))).toContain('Stage inside submodule')
  expect(qa('.scm-row-actions button', rowOf('vendor/lib')!.parentElement!)).toHaveLength(0)

  await click(byLabel('Expand vendor/lib'))
  await w.win.waitFor(() => qa('.scm-sub-entry').length === 1)
  expect(text(q('.scm-sub-entry .scm-row-name'))).toBe('x.c')
  expect(text(q('.scm-sub-entry .scm-letter'))).toBe('M')
  expect(qa('.scm-sub-entry button')).toHaveLength(0)
  expect((await openView(w))?.id).not.toBe(DIFF_VIEW)

  await click(byLabel('Collapse vendor/lib'))
  expect(qa('.scm-sub-entry')).toHaveLength(0)
  expect(w.problems()).toEqual([])
}, SLOW)
