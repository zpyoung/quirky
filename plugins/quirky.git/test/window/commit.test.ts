import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { click, errorLine, messageBox, modEnter, primary, primaryNow, q, rowOf, text, type } from './dom'
import { boot, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

test('SC-25: the ship bar commits every change with a message, and Cmd+Enter commits', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => primaryNow().label === 'Commit 1 file')
  expect(primaryNow()).toMatchObject({ enabled: true })

  await type(messageBox(), 'Update math')
  await modEnter(messageBox())
  await w.win.waitFor(() => w.git('log', '-1', '--format=%s') === 'Update math')
  await w.win.waitFor(() => messageBox() === null)
  expect(w.git('status', '--porcelain')).toBe('')
  await w.win.waitFor(() => rowOf('math.ts', 'branch'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-26: committing without a message commits nothing, says so in the error line and focuses the box', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => primaryNow().label === 'Commit 1 file')
  const before = w.git('rev-parse', 'HEAD')

  await click(primary())
  await w.win.waitFor(() => errorLine())
  expect(text(errorLine())).toContain('Write a commit message, or click ✦')
  expect(document.activeElement).toBe(messageBox())
  expect(w.git('rev-parse', 'HEAD')).toBe(before)
  expect(w.git('status', '--porcelain')).toBe('M math.ts')
}, SLOW)

test('SC-24: Cmd+Enter commits the staged files only', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.write('other.ts', 'other\n')
  w.git('add', 'math.ts')
  await w.win.waitFor(() => primaryNow().label === 'Commit 1 staged file')
  await type(messageBox(), 'Only math')
  await modEnter(messageBox())
  await w.win.waitFor(() => w.git('log', '-1', '--format=%s') === 'Only math')
  expect(w.git('show', '--name-only', '--format=', 'HEAD')).toBe('math.ts')
  expect(w.git('status', '--porcelain')).toBe('?? other.ts')
}, SLOW)

test('SC-25: Cmd+Enter does nothing while the button is not a commit', async () => {
  const w = await boot(scratch)
  w.commit({ 'math.ts': 'a\nB\nc\nd\ne\n' }, 'work')
  await w.win.waitFor(() => text(primary()) === 'Push 1 commit')
  const before = w.git('rev-parse', 'HEAD')
  await modEnter(q('[data-git-panel]')!)
  expect(w.git('rev-parse', 'HEAD')).toBe(before)
  expect(w.git('rev-parse', 'origin/zoe/feat')).not.toBe(before)
}, SLOW)
