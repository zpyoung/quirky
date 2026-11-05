import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { click, listbox, press, q, rowOf, rowPaths, selectedPaths, text } from './dom'
import { boot, DIFF_VIEW, openView, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

const countLine = () => text(q('[data-count-line]'))

test('SC-15 and SC-18: a click selects and opens the one Review tab, and the keyboard moves, marks and clears', async () => {
  const w = await boot(scratch)
  for (const name of ['a', 'b', 'c', 'd']) w.write(`${name}.ts`, `${name} changed\n`)
  await w.win.waitFor(() => rowOf('d.ts'))
  await w.win.waitFor(() => countLine() === '0 of 4 reviewed · 4 uncommitted')
  const selection = async () => (await w.report()).selection

  await click(rowOf('a.ts'))
  expect(selectedPaths()).toEqual(['a.ts'])
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'review', reveal: 'a.ts', worktree: w.feat.id })
  await w.win.waitFor(async () => (await selection()).join() === 'a.ts')

  await press(listbox()!, 'ArrowDown')
  expect(selectedPaths()).toEqual(['b.ts'])
  await w.win.waitFor(async () => (await selection()).join() === 'b.ts')

  await press(listbox()!, ' ')
  await w.win.waitFor(() => countLine() === '1 of 4 reviewed · 4 uncommitted')
  expect(text(q('[aria-label="Reviewed"]', rowOf('b.ts')!))).toBe('✓')
  await w.win.waitFor(() => selectedPaths().join() === 'c.ts')
  expect(rowPaths()).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])

  await press(listbox()!, 'Escape')
  expect(selectedPaths()).toEqual([])
  await w.win.waitFor(async () => (await selection()).length === 0)
}, SLOW)

test('SC-4: unmarking with Space keeps the selection, and a marked file survives a commit unchanged', async () => {
  const w = await boot(scratch)
  w.write('a.ts', 'a changed\n')
  w.write('b.ts', 'b changed\n')
  await w.win.waitFor(() => rowOf('b.ts'))
  await click(rowOf('a.ts'))
  await press(listbox()!, ' ')
  await w.win.waitFor(() => countLine() === '1 of 2 reviewed · 2 uncommitted')
  await w.win.waitFor(() => selectedPaths().join() === 'b.ts')
  await click(rowOf('a.ts'))
  await press(listbox()!, ' ')
  await w.win.waitFor(() => countLine() === '0 of 2 reviewed · 2 uncommitted')
  expect(selectedPaths()).toEqual(['a.ts'])
  await press(listbox()!, ' ')
  await w.win.waitFor(() => countLine() === '1 of 2 reviewed · 2 uncommitted')
  w.git('add', '-A')
  w.git('commit', '-q', '-m', 'both')
  await w.win.waitFor(() => countLine() === '1 of 2 reviewed')
  expect(q('.git-row__dirty', rowOf('a.ts')!)).toBeNull()
  expect(text(q('[aria-label="Reviewed"]', rowOf('a.ts')!))).toBe('✓')
  expect(w.problems()).toEqual([])
}, SLOW)
