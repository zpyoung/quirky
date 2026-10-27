import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { click, messageBox, modEnter, primary, primaryNow, q, rowOf, type } from './dom'
import { boot, shutdown } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 60_000
afterEach(shutdown)

test('SC-25: the commit box enables with staged files and a message, and Cmd+Enter commits', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => rowOf('math.ts'))
  expect(primaryNow()).toEqual({ label: 'Stage All', enabled: true, title: 'Stage all changes' })

  await click(primary())
  await w.win.waitFor(() => rowOf('math.ts', 'staged'))
  expect(primaryNow()).toEqual({ label: 'Commit', enabled: false, title: 'Enter a commit message to commit' })

  await type(messageBox(), 'Update math')
  expect(primaryNow()).toEqual({ label: 'Commit', enabled: true, title: 'Commit staged changes' })

  await modEnter(messageBox())
  await w.win.waitFor(() => rowOf('math.ts', 'branch'))
  expect(messageBox().value).toBe('')
  expect(w.git('log', '-1', '--format=%s')).toBe('Update math')
  await w.win.waitFor(() => !q('[data-section="staged"]'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-25: Cmd+Enter does nothing while the primary is not an enabled Commit', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => rowOf('math.ts'))
  const before = w.git('rev-parse', 'HEAD')
  await modEnter(primary())
  expect(w.git('rev-parse', 'HEAD')).toBe(before)
  expect(rowOf('math.ts')).not.toBeNull()
}, SLOW)
