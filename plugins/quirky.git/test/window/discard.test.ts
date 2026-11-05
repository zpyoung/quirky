import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, listbox, press, q, rowOf, text } from './dom'
import { boot, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

/** Waits until the panel's status read lists `count` uncommitted rows, which Revert plans from. */
const inSync = (w: World, count: number) =>
  w.win.waitFor(async () => ((await w.report()).sections as Array<{ id: string; count: number }>).filter((s) => s.id !== 'branch').reduce((n, s) => n + s.count, 0) === count)

/** SC-14's rows plus two more untracked files. */
async function bootWithChanges(): Promise<World> {
  const w = await boot(scratch)
  w.write('README.md', 'one\ntwo\nthree\n')
  w.git('add', 'README.md')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  rmSync(join(w.dir, 'c.ts'))
  for (const name of ['notes.txt', 'n2.txt', 'n3.txt']) w.write(name, `${name}\n`)
  await w.win.waitFor(() => rowOf('n3.txt') && rowOf('c.ts') && rowOf('README.md', 'staged'))
  await inSync(w, 6)
  return w
}

const dialogBody = (dialog: HTMLElement) => text(q('p', dialog))

/** Selects a row and presses its inline Revert button. */
async function revert(path: string) {
  await click(rowOf(path))
  await click(byLabel(`Revert ${path}`))
}

test('SC-23: each Revert file dialog has Orca\'s text, focuses within the shared modal, and Cancel changes nothing', async () => {
  const w = await bootWithChanges()
  const cases = [
    { path: 'notes.txt', title: 'Delete "notes.txt"?', body: 'This will permanently delete this file. This cannot be undone.', confirm: 'Delete' },
    { path: 'c.ts', title: 'Restore "c.ts"?', body: 'This will restore the last staged version and discard the deletion. This cannot be undone.', confirm: 'Restore' },
    { path: 'math.ts', title: 'Discard changes to "math.ts"?', body: 'This will revert the unstaged changes to this file. This cannot be undone.', confirm: 'Discard' },
    { path: 'README.md', title: 'Discard changes to "README.md"?', body: 'This will unstage and revert the changes to this file. This cannot be undone.', confirm: 'Discard' }
  ]
  for (const c of cases) {
    await revert(c.path)
    const dialog = await w.win.waitFor(() => dialogNamed(c.title))
    expect(dialogBody(dialog)).toBe(c.body)
    expect(buttonText(c.confirm, dialog)).toBeDefined()
    expect(document.activeElement).toBe(byLabel('Close dialog', dialog))
    await click(buttonText('Cancel', dialog))
    await w.win.waitFor(() => !dialogNamed(c.title))
  }
  expect(w.git('status', '--porcelain').split('\n').sort()).toEqual(
    [' D c.ts', ' M math.ts', 'M  README.md', '?? n2.txt', '?? n3.txt', '?? notes.txt'].sort()
  )
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-19: confirming Revert file reverts the file, restores a deleted one, deletes an untracked one and unstages a staged one', async () => {
  const w = await bootWithChanges()

  await revert('math.ts')
  await click(buttonText('Discard', await w.win.waitFor(() => dialogNamed('Discard changes to "math.ts"?'))))
  await w.win.waitFor(() => !rowOf('math.ts'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('a\nb\nc\nd\ne\n')

  await revert('c.ts')
  await click(buttonText('Restore', await w.win.waitFor(() => dialogNamed('Restore "c.ts"?'))))
  await w.win.waitFor(() => !rowOf('c.ts'))
  expect(readFileSync(join(w.dir, 'c.ts'), 'utf8')).toBe('sea\n')

  await revert('notes.txt')
  await click(buttonText('Delete', await w.win.waitFor(() => dialogNamed('Delete "notes.txt"?'))))
  await w.win.waitFor(() => !rowOf('notes.txt'))
  expect(existsSync(join(w.dir, 'notes.txt'))).toBe(false)

  await revert('README.md')
  await click(buttonText('Discard', await w.win.waitFor(() => dialogNamed('Discard changes to "README.md"?'))))
  await w.win.waitFor(() => !rowOf('README.md'))
  expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('one\ntwo\n')
  expect(w.git('status', '--porcelain').split('\n').sort()).toEqual(['?? n2.txt', '?? n3.txt'])
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-19: Revert all… confirms with the file count and reverts every file, and Backspace starts Revert file', async () => {
  const w = await bootWithChanges()

  await click(rowOf('math.ts'))
  await press(listbox()!, 'Backspace')
  await w.win.waitFor(() => dialogNamed('Discard changes to "math.ts"?'))
  await click(buttonText('Cancel', dialogNamed('Discard changes to "math.ts"?')!))

  await click(byLabel('More source control actions'))
  await click(await w.win.waitFor(() => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => text(item) === 'Revert all…')))
  const dialog = await w.win.waitFor(() => dialogNamed('Revert all 6 files?'))
  await click(buttonText('Revert all', dialog))
  await w.win.waitFor(() => !rowOf('n3.txt') && !rowOf('README.md') && !rowOf('notes.txt'), 30_000)
  expect(w.git('status', '--porcelain')).toBe('')
  expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('one\ntwo\n')
  expect(readFileSync(join(w.dir, 'c.ts'), 'utf8')).toBe('sea\n')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-9: Revert file on a committed change writes the base version back as an uncommitted edit', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'a\nB\nc\nd\ne\n' }, 'edit math')
  await w.win.waitFor(() => rowOf('math.ts', 'branch'))
  expect(q('.git-row__dirty', rowOf('math.ts')!)).toBeNull()

  await revert('math.ts')
  await click(buttonText('Revert', await w.win.waitFor(() => dialogNamed('Revert "math.ts"?'))))
  await w.win.waitFor(() => !rowOf('math.ts'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('a\nb\nc\nd\ne\n')
  expect(w.git('status', '--porcelain').trim()).toBe('M math.ts')
  expect(w.problems()).toEqual([])
}, SLOW)
