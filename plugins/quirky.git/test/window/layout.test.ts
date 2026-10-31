import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { click, primary, primaryNow, q, qa, rowContainerOf, rowOf, sectionHeadings, text, type } from './dom'
import { boot, sc1, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

const sectionCounts = () => qa('[data-section-count]').map(text)
const sourceControlStatus = () => {
  const button = qa('button').find((item) => item.getAttribute('aria-label')?.startsWith('Source Control'))
  if (!button) return null
  return {
    count: text(button) || null,
    label: button.getAttribute('aria-label') ?? '',
    clean: /no uncommitted changes/i.test(button.getAttribute('aria-label') ?? '')
  }
}

test('SC-8: the panel shows Orca\'s layout against a real daemon', async () => {
  const w = await boot(scratch)
  w.commit({ 'util.ts': 'export const u = 1\n' }, 'ahead')
  sc1(w)
  await w.win.waitFor(() => rowOf('notes.txt') && sectionHeadings().includes('Committed on Branch'))

  expect(sectionHeadings()).toEqual(['Changes', 'Staged Changes', 'Untracked Files', 'Committed on Branch', 'Commits'])
  expect(sectionCounts().slice(0, 4)).toEqual(['1', '2', '1', '1'])
  expect(q('[data-history-content]')).toBeNull()
  expect(q('[aria-label="Filter files by name"]')).not.toBeNull()
  expect(q('[aria-label="More source control actions"]')).not.toBeNull()

  const branch = q('[data-branch-row]')!
  expect(text(q('[data-branch-name]', branch))).toBe('zoe/feat')
  expect(text(q('[data-base-ref]', branch))).toBe('origin/main')
  expect(text(q('[aria-label="1 commit(s) to push"]', branch))).toBe('↑1')
  expect(text(q('[aria-label="Lines changed on this branch"]', branch))).toBe('+1 −0')

  const math = rowOf('math.ts')!
  expect(text(q('[data-row-name]', math))).toBe('math.ts')
  expect(text(q('[aria-label*="additions"]', rowContainerOf('math.ts')!))).toMatch(/^\+\d+$/)
  expect(text(q('.ui-badge[aria-label="Git status modified"]', rowContainerOf('math.ts')!))).toBe('M')
  expect(text(q('.ui-badge[aria-label="Git status renamed"]', rowContainerOf('new.ts', 'staged')!))).toBe('R')
  expect(text(q('.ui-badge[aria-label="Git status untracked"]', rowContainerOf('notes.txt')!))).toBe('U')

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

test('SC-11: the Source Control activity toggle shows the uncommitted count, then clears when everything is committed', async () => {
  const w = await boot(scratch)
  expect(sourceControlStatus()?.count ?? null).toBeNull()
  sc1(w)
  const shown = await w.win.waitFor(() => {
    const status = sourceControlStatus()
    return status?.count ? status : undefined
  })
  expect(shown.count).toBe('4')
  expect(shown.label).toMatch(/\b4\b.*uncommitted changes?/i)
  await w.win.waitFor(() => rowOf('math.ts', 'unstaged'))

  w.git('add', '-A')
  await w.win.waitFor(() => !rowOf('math.ts', 'unstaged'))
  await type(q('textarea[aria-label="Commit message"]') as HTMLTextAreaElement, 'everything')
  expect(primaryNow()).toMatchObject({ label: 'Commit', enabled: true })
  const previousHead = w.git('rev-parse', 'HEAD')
  await click(primary())
  await w.win.waitFor(() =>
    w.git('rev-parse', 'HEAD') !== previousHead &&
    w.git('status', '--porcelain') === ''
  )
  expect(w.git('status', '--porcelain')).toBe('')
  await w.win.waitFor(() => {
    const status = sourceControlStatus()
    return status !== null && status.count === null && status.clean
  })
  expect(sourceControlStatus()?.count ?? null).toBeNull()
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-11: a capped status shows the capped count on the Source Control activity toggle', async () => {
  const w = await boot(scratch)
  for (let i = 0; i < 1100; i++) w.write(`many/f${i}.txt`, `${i}\n`)
  const shown = await w.win.waitFor(() => {
    const status = sourceControlStatus()
    return status?.count ? status : undefined
  }, 15_000)
  expect(shown.count).toBe('1000+')
  expect(shown.label).toMatch(/1000\+.*uncommitted changes?/i)
  await w.win.waitFor(async () => (await w.report())?.capped === true)
}, SLOW)
