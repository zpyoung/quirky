import { afterEach, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { byLabel, caretEntry, click, messageBox, primary, primaryNow, q, qa, text, type } from './dom'
import { boot, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

/** Waits for a user-visible ship bar state and its daemon report. */
async function ship(w: World, label: string, enabled: boolean) {
  await w.win.waitFor(() => primaryNow().label === label && primaryNow().enabled === enabled)
  const reported = await w.win.waitFor(async () => {
    const state = (await w.report())?.primary
    return state?.label === label && state.enabled === enabled ? state : undefined
  })
  expect(reported).toMatchObject({ label, enabled })
  return primaryNow()
}

test('SC-28: the ship button follows the next step through Commit, Push, Pull, Sync and Publish branch', async () => {
  const w = await boot(scratch)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await ship(w, 'Commit 1 file', true)
  await type(messageBox(), 'Update math')
  await click(primary())

  await ship(w, 'Push 1 commit', true)
  await click(primary())
  await w.win.waitFor(() => primaryNow().label === 'Pushed to origin/zoe/feat' || q('[data-git-clean]'))
  expect(w.git('rev-parse', 'HEAD')).toBe(w.git('rev-parse', 'origin/zoe/feat'))

  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'b.ts': 'bee 2\n' }, 'peer one')
  peer.push('zoe/feat')
  w.git('fetch', '-q')
  await ship(w, 'Pull 1 commit', true)
  await click(primary())
  await w.win.waitFor(() => w.git('show', 'HEAD:b.ts') === 'bee 2')

  peer.commit({ 'c.ts': 'sea 2\n' }, 'peer two')
  peer.push('zoe/feat')
  w.commit({ 'd.ts': 'dee 2\n' }, 'local two')
  w.git('fetch', '-q')
  await ship(w, 'Sync', true)
  await click(primary())
  await w.win.waitFor(() => w.git('rev-list', '--count', 'origin/zoe/feat..HEAD') === '0')
  expect(w.git('rev-parse', 'HEAD')).toBe(w.git('rev-parse', 'origin/zoe/feat'))
  expect(w.git('show', 'HEAD:c.ts')).toBe('sea 2')

  w.git('checkout', '-q', '-b', 'zoe/other')
  await ship(w, 'Publish branch', true)
  await click(primary())
  await w.win.waitFor(() => Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'zoe/other@{upstream}'], { cwd: w.dir }).stdout.toString().trim() === 'origin/zoe/other')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-28: a rebased branch reads "Force push" and a hand-staged file reads "Commit 1 staged file"', async () => {
  const w = await boot(scratch)
  w.commit({ 'a.ts': 'one 2\n' }, 'work')
  w.git('push', '-q')
  w.git('commit', '-q', '--amend', '-m', 'work again')
  w.git('fetch', '-q')
  expect((await ship(w, 'Force push 1 commit', true)).enabled).toBe(true)

  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.write('other.ts', 'other\n')
  w.git('add', 'math.ts')
  await ship(w, 'Commit 1 staged file', true)
}, SLOW)

test('SC-30: a push running from the CLI disables the button with "Push in progress…", refuses a second remote call, and clears afterwards', async () => {
  const w = await boot(scratch)
  const hook = join(w.originDir, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nsleep 5\n')
  chmodSync(hook, 0o755)
  w.commit({ 'math.ts': 'a\nB\nc\nd\ne\n' }, 'slow push')
  await w.win.waitFor(() => text(primary()) === 'Push 1 commit')

  const push = w.cli(['git', 'push'])
  const busy = await w.win.waitFor(() => primary()?.title === 'Push in progress…' && primary())
  expect(busy.disabled).toBe(true)
  await w.win.waitFor(async () => (await w.report()).busy === 'push')
  expect((await w.report()).primary).toEqual({ label: 'Push 1 commit', enabled: false, title: 'Push in progress…' })
  expect(primary().getAttribute('aria-busy')).toBe('true')

  const caret = byLabel('More commit and remote actions')!
  expect(caret.disabled).toBe(true)
  expect(caretEntry('Fetch')).toBeUndefined()
  expect(qa('[role="menu"]')).toHaveLength(0)

  const fetch = await w.agent.callAny('quirky.git/fetch', { worktree: w.feat.id }).then(
    () => null,
    (error) => ({ message: (error as Error).message, reason: (error as { data?: { reason?: string } }).data?.reason })
  )
  expect(fetch).toEqual({ message: 'A push is already running in this worktree.', reason: 'busy' })

  expect((await push.done).code).toBe(0)
  await w.win.waitFor(async () => (await w.report())?.busy === null)
  await w.win.waitFor(() => !primary() || !primary().disabled)
  expect(w.git('rev-list', '--count', 'origin/zoe/feat..HEAD')).toBe('0')
  expect(w.problems()).toEqual([])
}, SLOW)
