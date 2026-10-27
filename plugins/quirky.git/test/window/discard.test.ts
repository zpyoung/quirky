import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, q, rowOf, text } from './dom'
import { boot, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

/** SC-14's rows plus two more untracked files. */
async function bootWithChanges(): Promise<World> {
  const w = await boot(scratch)
  w.write('README.md', 'one\ntwo\nthree\n')
  w.git('add', 'README.md')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  rmSync(join(w.dir, 'c.ts'))
  for (const name of ['notes.txt', 'n2.txt', 'n3.txt']) w.write(name, `${name}\n`)
  await w.win.waitFor(() => rowOf('n3.txt') && rowOf('c.ts') && rowOf('README.md', 'staged'))
  return w
}

const dialogBody = (dialog: HTMLElement) => text(q('.dialog-message', dialog))

test('SC-23: each discard dialog has Orca\'s text, focuses its confirm button and Cancel changes nothing', async () => {
  const w = await bootWithChanges()
  const cases = [
    { button: 'Delete untracked file notes.txt', title: 'Delete "notes.txt"?', body: 'This will permanently delete this file. This cannot be undone.', confirm: 'Delete' },
    { button: 'Restore file c.ts', title: 'Restore "c.ts"?', body: 'This will restore the last staged version and discard the deletion. This cannot be undone.', confirm: 'Restore' },
    { button: 'Discard changes math.ts', title: 'Discard changes to "math.ts"?', body: 'This will revert the unstaged changes to this file. This cannot be undone.', confirm: 'Discard' },
    {
      section: 'untracked',
      button: 'Delete all untracked',
      title: 'Delete 3 untracked files?',
      body: 'This will permanently delete these 3 untracked files. This cannot be undone.',
      confirm: 'Delete 3'
    },
    {
      section: 'staged',
      button: 'Discard all',
      title: 'Discard all staged changes?',
      body: 'This will unstage and revert all staged changes. Staged new files will be deleted. This cannot be undone.',
      confirm: 'Discard all'
    },
    {
      section: 'unstaged',
      button: 'Discard all',
      title: 'Discard all unstaged changes?',
      body: 'This will revert all unstaged changes. This cannot be undone.',
      confirm: 'Discard all'
    }
  ]
  for (const c of cases) {
    const scope: ParentNode = c.section ? q(`[data-section="${c.section}"]`)! : document
    await click(byLabel(c.button, scope))
    const dialog = await w.win.waitFor(() => dialogNamed(c.title))
    expect(dialogBody(dialog)).toBe(c.body)
    const confirm = buttonText(c.confirm, dialog)!
    expect(document.activeElement).toBe(confirm)
    await click(buttonText('Cancel', dialog))
    await w.win.waitFor(() => !dialogNamed(c.title))
  }
  expect(w.git('status', '--porcelain').split('\n').sort()).toEqual(
    [' D c.ts', ' M math.ts', 'M  README.md', '?? n2.txt', '?? n3.txt', '?? notes.txt'].sort()
  )
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-19: confirming a discard from the window reverts the file, restores a deleted one and deletes an untracked one', async () => {
  const w = await bootWithChanges()

  await click(byLabel('Discard changes math.ts'))
  await click(buttonText('Discard', await w.win.waitFor(() => dialogNamed('Discard changes to "math.ts"?'))))
  await w.win.waitFor(() => !rowOf('math.ts'))
  expect(readFileSync(join(w.dir, 'math.ts'), 'utf8')).toBe('a\nb\nc\nd\ne\n')

  await click(byLabel('Restore file c.ts'))
  await click(buttonText('Restore', await w.win.waitFor(() => dialogNamed('Restore "c.ts"?'))))
  await w.win.waitFor(() => !rowOf('c.ts'))
  expect(readFileSync(join(w.dir, 'c.ts'), 'utf8')).toBe('sea\n')

  await click(byLabel('Delete untracked file notes.txt'))
  await click(buttonText('Delete', await w.win.waitFor(() => dialogNamed('Delete "notes.txt"?'))))
  await w.win.waitFor(() => !rowOf('notes.txt'))
  expect(existsSync(join(w.dir, 'notes.txt'))).toBe(false)

  await click(byLabel('Delete all untracked', q('[data-section="untracked"]')!))
  await click(buttonText('Delete 2', await w.win.waitFor(() => dialogNamed('Delete 2 untracked files?'))))
  await w.win.waitFor(() => !q('[data-section="untracked"]'))
  expect(existsSync(join(w.dir, 'n2.txt'))).toBe(false)

  await click(byLabel('Discard all', q('[data-section="staged"]')!))
  await click(buttonText('Discard all', await w.win.waitFor(() => dialogNamed('Discard all staged changes?'))))
  await w.win.waitFor(() => !rowOf('README.md'))
  expect(w.git('status', '--porcelain')).toBe('')
  expect(readFileSync(join(w.dir, 'README.md'), 'utf8')).toBe('one\ntwo\n')
  expect(w.problems()).toEqual([])
}, SLOW)
