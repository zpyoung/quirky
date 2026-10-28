import { afterEach, expect, test } from 'bun:test'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { byLabel, click, messageBox, primary, q, qa, rowOf, text, type } from './dom'
import { boot, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

/** Waits for a user-visible primary action state and its daemon report. */
async function ladder(w: World, label: string, enabled: boolean) {
  await w.win.waitFor(() => text(primary()) === label && primary().disabled === !enabled)
  const reported = await w.win.waitFor(async () => {
    const state = (await w.report())?.primary
    return state?.label === label && state.enabled === enabled ? state : undefined
  })
  expect(reported).toMatchObject({ label, enabled })
  return { label: text(primary()), enabled: !primary().disabled }
}

test('SC-28: the primary button follows the ladder through Stage All, Commit, Push, Pull, Sync and Publish Branch', async () => {
  const w = await boot(scratch)
  expect(await ladder(w, 'Commit', false)).toEqual({ label: 'Commit', enabled: false })

  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  expect(await ladder(w, 'Stage All', true)).toEqual({ label: 'Stage All', enabled: true })
  await click(primary())
  expect(await ladder(w, 'Commit', false)).toEqual({ label: 'Commit', enabled: false })
  await type(messageBox(), 'Update math')
  expect(await ladder(w, 'Commit', true)).toEqual({ label: 'Commit', enabled: true })
  await click(primary())

  expect(await ladder(w, 'Push', true)).toEqual({ label: 'Push', enabled: true })
  await click(primary())
  await w.win.waitFor(() => text(primary()) === 'Commit')
  expect(w.git('rev-parse', 'HEAD')).toBe(w.git('rev-parse', 'origin/zoe/feat'))

  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'b.ts': 'bee 2\n' }, 'peer one')
  peer.push('zoe/feat')
  w.git('fetch', '-q')
  expect(await ladder(w, 'Pull', true)).toEqual({ label: 'Pull', enabled: true })
  await click(primary())
  await w.win.waitFor(() => text(primary()) === 'Commit')
  expect(w.git('show', 'HEAD:b.ts')).toBe('bee 2')

  peer.commit({ 'c.ts': 'sea 2\n' }, 'peer two')
  peer.push('zoe/feat')
  w.commit({ 'd.ts': 'dee 2\n' }, 'local two')
  w.git('fetch', '-q')
  expect(await ladder(w, 'Sync', true)).toEqual({ label: 'Sync', enabled: true })
  await click(primary())
  await w.win.waitFor(() => text(primary()) === 'Commit' && (w.git('rev-list', '--count', 'origin/zoe/feat..HEAD') === '0'))
  expect(w.git('rev-parse', 'HEAD')).toBe(w.git('rev-parse', 'origin/zoe/feat'))
  expect(w.git('show', 'HEAD:c.ts')).toBe('sea 2')

  w.git('checkout', '-q', '-b', 'zoe/other')
  expect(await ladder(w, 'Publish Branch', true)).toEqual({ label: 'Publish Branch', enabled: true })
  await click(primary())
  await w.win.waitFor(() => text(primary()) === 'Commit')
  expect(w.git('rev-parse', '--abbrev-ref', 'zoe/other@{upstream}')).toBe('origin/zoe/other')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-28: Force Push shows when the commits behind are patch-equivalent', async () => {
  const w = await boot(scratch)
  w.commit({ 'a.ts': 'one 2\n' }, 'work')
  w.git('push', '-q')
  w.git('commit', '-q', '--amend', '-m', 'work again')
  w.git('fetch', '-q')
  const shown = await ladder(w, 'Force Push', true)
  expect(shown.enabled).toBe(true)
}, SLOW)

test('SC-30: a push running from the CLI shows a disabled Push titled "Push in progress…", refuses a second remote call, and clears afterwards', async () => {
  const w = await boot(scratch)
  const hook = join(w.originDir, 'hooks', 'pre-receive')
  writeFileSync(hook, '#!/bin/sh\nsleep 5\n')
  chmodSync(hook, 0o755)
  w.commit({ 'math.ts': 'a\nB\nc\nd\ne\n' }, 'slow push')
  await w.win.waitFor(() => text(primary()) === 'Push')

  const push = w.cli(['git', 'push'])
  const busy = await w.win.waitFor(() => primary().title === 'Push in progress…' && primary())
  expect(busy.disabled).toBe(true)
  expect(text(busy)).toBe('Push')
  await w.win.waitFor(async () => (await w.report()).busy === 'push')
  expect((await w.report()).primary).toEqual({ label: 'Push', enabled: false, title: 'Push in progress…' })
  expect((await w.report()).busy).toBe('push')
  expect(q('[data-git-primary] [aria-label="Action in progress"]')).not.toBeNull()

  await click(byLabel('More commit and remote actions'))
  const rows = qa('[role="menu"] [role="menuitem"]')
  expect(rows.length).toBeGreaterThan(5)
  expect(rows.every((row) => (row as HTMLButtonElement).disabled)).toBe(true)
  await click(byLabel('More commit and remote actions'))

  const fetch = await w.agent.callAny('quirky.git/fetch', { worktree: w.feat.id }).then(
    () => null,
    (error) => ({ message: (error as Error).message, reason: (error as { data?: { reason?: string } }).data?.reason })
  )
  expect(fetch).toEqual({ message: 'A push is already running in this worktree.', reason: 'busy' })

  expect((await push.done).code).toBe(0)
  await w.win.waitFor(() => text(primary()) === 'Commit' && primary().title === 'Nothing to commit. Branch is up to date.')
  await w.win.waitFor(async () => (await w.report())?.busy === null)
  expect(w.git('rev-list', '--count', 'origin/zoe/feat..HEAD')).toBe('0')
  expect(w.problems()).toEqual([])
}, SLOW)
