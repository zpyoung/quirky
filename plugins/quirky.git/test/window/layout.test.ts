import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, q, qa, rowOf, sectionHeadings, text, type } from './dom'
import { badge, boot, sc1, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

const sectionCounts = () => qa('.scm-section-head .scm-count').map(text)

test('SC-8: the panel shows Orca\'s layout against a real daemon', async () => {
  const w = await boot(scratch)
  w.commit({ 'util.ts': 'export const u = 1\n' }, 'ahead')
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt') && sectionHeadings().includes('Committed on Branch'))

  expect(sectionHeadings()).toEqual(['Changes', 'Staged Changes', 'Untracked Files', 'Committed on Branch', 'Commits'])
  expect(sectionCounts().slice(0, 4)).toEqual(['1', '2', '1', '1'])
  expect(q('[data-section="history"] .scm-history')).toBeNull()
  expect(q('[aria-label="Filter files by name"]')).not.toBeNull()
  expect(q('[aria-label="More source control actions"]')).not.toBeNull()

  const branch = q('.scm-branch')!
  expect(text(q('.scm-branch-name', branch))).toBe('zoe/feat')
  expect(text(q('.scm-base', branch))).toBe('origin/main')
  expect(text(q('.scm-ahead', branch))).toBe('↑1')
  expect(text(q('.scm-chip', branch))).toBe('+1 −0')

  const math = rowOf('math.ts')!
  expect(text(q('.scm-row-name', math))).toBe('math.ts')
  expect(text(q('.scm-added', math))).toMatch(/^\+\d+$/)
  expect(text(q('.scm-letter', math))).toBe('M')
  expect(text(q('.scm-letter', rowOf('new.ts', 'staged')!))).toBe('R')
  expect(text(q('.scm-letter', rowOf('notes.txt')!))).toBe('U')

  const state = await w.win.waitFor(async () => {
    const r = await w.report()
    return r?.base === 'origin/main' && r.sections.length === 4 ? r : undefined
  })
  expect(state).toMatchObject({ branch: 'zoe/feat', base: 'origin/main', ahead: 1, behind: 0, operation: 'none' })
  expect(state.sections).toEqual([
    { id: 'unstaged', count: 1 },
    { id: 'staged', count: 2 },
    { id: 'untracked', count: 1 },
    { id: 'branch', count: 1 }
  ])
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-11: the panel toggle shows the uncommitted count, then nothing once everything is committed', async () => {
  const w = await boot(scratch)
  expect(badge()).toBeNull()
  sc1(w)
  await w.win.waitFor(() => badge())
  expect(badge()).toEqual({ count: '4', title: 'Source Control — 4 uncommitted changes' })

  w.git('add', '-A')
  await w.win.waitFor(() => !rowOf('math.ts', 'unstaged'))
  await type(q('textarea[aria-label="Commit message"]') as HTMLTextAreaElement, 'everything')
  await click(buttonText('Commit'))
  await w.win.waitFor(() => badge() === null)
  expect(w.git('status', '--porcelain')).toBe('')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-11: a capped status shows 1000 on the toggle', async () => {
  const w = await boot(scratch)
  for (let i = 0; i < 1100; i++) w.write(`many/f${i}.txt`, `${i}\n`)
  const shown = await w.win.waitFor(() => badge(), 15_000)
  expect(shown.count).toBe('1000')
  expect(shown.title).toBe('Source Control — 1000+ uncommitted changes')
  await w.win.waitFor(async () => (await w.report())?.capped === true)
}, SLOW)
