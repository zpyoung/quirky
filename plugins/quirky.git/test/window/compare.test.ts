import { afterEach, expect, test } from 'bun:test'
import type { Repo, Worktree } from '@quirky/protocol'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, q, qa, rowContainerOf, rowOf, text, type } from './dom'
import { boot, DIFF_VIEW, openView, SESSION_VIEW, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const lines = (n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join('\n') + '\n'

test('SC-47: Committed on Branch lists what the branch changed since its base, with totals', async () => {
  const w = await boot(scratch)
  const peer = w.peer('peer')
  peer.commit({ 'd.ts': 'moved on\n' }, 'main moves')
  peer.push('main')
  w.commit({ 'math.ts': 'A\nB\nC\nd\ne\n' + lines(9, 'x') }, 'math')
  w.commit({ 'util.ts': lines(40, 'u') }, 'util')
  w.git('fetch', '-q')

  const compare = (await w.agent.callAny('quirky.git/compare', { worktree: w.feat.id })) as any
  expect(compare).toMatchObject({ status: 'ready', base: 'origin/main', ahead: 2, behind: 1, added: 52, removed: 3 })

  await w.win.waitFor(() => rowOf('util.ts', 'branch') && q('[aria-label="Lines changed on this branch"]'))
  const section = q('[data-section="branch"]')!
  expect(qa('[data-row-name]', section).map(text)).toEqual(['math.ts', 'util.ts'])
  expect(text(q('[aria-label="Lines changed on this branch"]'))).toBe('+52 −3')
  expect(text(q('[data-base-ref]'))).toBe('origin/main')
  expect(text(q('[aria-label="Git status added"]', rowContainerOf('util.ts', 'branch')!))).toBe('A')

  await click(rowOf('math.ts', 'branch'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'file', source: 'branch', path: 'math.ts' })
  await w.win.waitFor(() => q('[data-git-view-root] [contenteditable]'))
  expect(w.problems()).toEqual([])
}, SLOW)

/** The branch row's base shown on the panel. */
const baseShown = () => text(q('[data-base-ref]'))

async function changeBase(w: World, search: string, pick: string): Promise<void> {
  await click(byLabel('More source control actions'))
  await click(await w.win.waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === 'Change Base Ref…')))
  const dialog = await w.win.waitFor(() => dialogNamed('Change Base Ref'))
  await type(q('input[aria-label="Search branches"]', dialog) as HTMLInputElement, search)
  const item = await w.win.waitFor(() => qa('[aria-label="Branches"] button[aria-pressed]', dialog).find((button) => text(button).startsWith(pick)))
  await click(item)
  await w.win.waitFor(() => !dialogNamed('Change Base Ref'))
}

test('SC-50: Change Base Ref writes the worktree base, the project default, and Use Primary clears it', async () => {
  const w = await boot(scratch)
  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'release', 'origin/main')
  peer.commit({ 'release.txt': 'r\n' }, 'release')
  peer.push('release')
  w.git('fetch', '-q')
  w.git('branch', 'release', 'origin/release')
  const w2 = await w.addWorktree('w2')
  const baseOf = async (wt: Worktree) => ((await w.agent.callAny('quirky.worktree/show', { worktree: wt.id })) as Worktree).baseRef
  const projectBase = async () =>
    ((await w.agent.callAny('quirky.repo/show', { repo: w.repo.id })) as { settings: { defaultBase?: string | null } }).settings.defaultBase

  await click(byLabel('More source control actions'))
  await click(await w.win.waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === 'Change Base Ref…')))
  const dialog = await w.win.waitFor(() => dialogNamed('Change Base Ref'))
  await w.win.waitFor(() => qa('[aria-label="Branches"] button[aria-pressed]', dialog).length > 3)
  expect(q('[aria-label="Branches"] [aria-pressed="true"]', dialog)).not.toBeNull()
  await type(q('input[aria-label="Search branches"]', dialog) as HTMLInputElement, 'rel')
  await w.win.waitFor(() => qa('[aria-label="Branches"] button[aria-pressed]', dialog).length === 2)
  await click(qa('[aria-label="Branches"] button[aria-pressed]', dialog)[0])
  await w.win.waitFor(() => !dialogNamed('Change Base Ref'))
  expect(await baseOf(w.feat)).toBe('release')
  expect(await projectBase()).toBeFalsy()
  await w.win.waitFor(() => baseShown() === 'release')

  await w.agent.callAny('ui.view.open', { id: SESSION_VIEW, input: { worktree: w2.id } })
  await w.win.waitFor(() => text(q('[data-branch-name]')) === 'zoe/w2')
  await changeBase(w, 'main', 'origin/main')
  expect(await baseOf(w2)).toBeNull()
  expect(await projectBase()).toBe('origin/main')
  await w.win.waitFor(() => baseShown() === 'origin/main')

  await click(byLabel('More source control actions'))
  await click(await w.win.waitFor(() => qa('[role="menuitem"]').find((i) => text(i) === 'Change Base Ref…')))
  const again = await w.win.waitFor(() => dialogNamed('Change Base Ref'))
  await click(buttonText('Use Primary', again))
  await w.win.waitFor(() => !dialogNamed('Change Base Ref'))
  await w.win.waitFor(async () => !(await projectBase()))
  expect(await w.agent.callAny('quirky.git/compare', { worktree: w2.id })).toMatchObject({ baseSource: 'detected' })
  expect(await baseOf(w.feat)).toBe('release')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-54: the Commits dock opens a commit\'s combined diff and one of its files', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'A\nb\nc\nd\ne\n', 'util.ts': 'u\n' }, 'Touch two files')
  const oid = w.git('rev-parse', 'HEAD')
  await w.win.waitFor(() => q('[data-section="history"]'))
  expect(q('[data-history-content]')).toBeNull()

  await click(byLabel('Expand Commits'))
  const row = await w.win.waitFor(() => q('[data-commit-row]'))
  const commitButton = q('button[aria-pressed]', row)!
  expect(text(commitButton)).toContain('Touch two files')
  expect(qa('[aria-label^="Commit ref "]', row).map(text)).toContain('HEAD -> zoe/feat')

  await click(q('[data-commit-row] button[aria-pressed]', row))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'combined', commit: oid, title: `Commit ${oid.slice(0, 7)}: Touch two files` })
  await w.win.waitFor(async () => (await w.viewReport())?.mode === 'combined')

  await click(byLabel(`Expand commit ${oid.slice(0, 7)}`))
  const file = await w.win.waitFor(() => q('[data-commit-row] [data-row-path="util.ts"] button[aria-pressed]'))
  await click(file)
  await w.win.waitFor(async () => (await openView(w))?.input?.path === 'util.ts')
  expect((await openView(w))!.input).toMatchObject({ mode: 'file', source: 'commit', commit: oid, path: 'util.ts' })
  await w.win.waitFor(async () => (await w.viewReport())?.source === 'commit')
  expect(w.problems()).toEqual([])
}, SLOW)
