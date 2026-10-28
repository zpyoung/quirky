import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, click, press, q, rowOf, text } from './dom'
import { boot, DIFF_VIEW, openView, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

test('SC-15: click opens the diff, Shift-click selects a range, Cmd-click toggles, Escape clears', async () => {
  const w = await boot(scratch)
  for (const name of ['a', 'b', 'c', 'd']) w.write(`${name}.ts`, `${name} changed\n`)
  await w.win.waitFor(() => rowOf('d.ts'))
  const selected = async () => (await w.report()).selection
  const bar = () => q('[role="toolbar"][aria-label="Selection actions"]')

  await click(rowOf('a.ts'))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  expect((await openView(w))!.input).toMatchObject({ mode: 'file', source: 'unstaged', path: 'a.ts', worktree: w.feat.id })
  expect(bar()).toBeNull()
  expect(await selected()).toEqual([])

  await click(rowOf('c.ts'), { shiftKey: true })
  expect(text(bar()?.querySelector('span'))).toBe('3 selected')
  expect(buttonText('Stage (3)', bar()!)).toBeDefined()
  await w.win.waitFor(async () => (await selected()).length === 3)
  expect((await selected()).sort()).toEqual(['a.ts', 'b.ts', 'c.ts'])
  expect((await openView(w))!.input.path).toBe('a.ts')

  await click(rowOf('b.ts'), { metaKey: true })
  expect(text(bar()?.querySelector('span'))).toBe('2 selected')
  await w.win.waitFor(async () => (await selected()).length === 2)
  expect((await selected()).sort()).toEqual(['a.ts', 'c.ts'])

  await press(rowOf('d.ts')!, 'Escape')
  expect(bar()).toBeNull()
  await w.win.waitFor(async () => (await selected()).length === 0)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-15: the bulk bar stages the selection through the daemon', async () => {
  const w = await boot(scratch)
  for (const name of ['a', 'b', 'c', 'd']) w.write(`${name}.ts`, `${name} changed\n`)
  await w.win.waitFor(() => rowOf('d.ts'))
  await click(rowOf('a.ts'))
  await click(rowOf('c.ts'), { shiftKey: true })
  await click(buttonText('Stage (3)', q('[role="toolbar"][aria-label="Selection actions"]')!))
  await w.win.waitFor(() => rowOf('c.ts', 'staged'))
  expect(w.git('diff', '--cached', '--name-only').split('\n')).toEqual(['a.ts', 'b.ts', 'c.ts'])
  await w.win.waitFor(() => buttonText('Unstage (3)', q('[role="toolbar"][aria-label="Selection actions"]') ?? document))
}, SLOW)
