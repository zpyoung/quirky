import { afterEach, expect, test } from 'bun:test'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, dialogNamed, messageBox, primary, primaryNow, q, qa, rowOf, text, toasts, type } from './dom'
import { boot, installHook, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

const menuLabels = () => qa('[role="menu"] [role="menuitem"]').map(text)

async function openChevron(w: World): Promise<void> {
  await click(byLabel('More commit and remote actions'))
  await w.win.waitFor(() => q('[role="menu"]'))
}

test('SC-28: Force Push confirms with the daemon\'s question, leases on the shown commit and updates the remote', async () => {
  const w = await boot(scratch)
  w.commit({ 'a.ts': 'one 2\n' }, 'work')
  w.git('push', '-q')
  w.git('commit', '-q', '--amend', '-m', 'work again')
  w.git('fetch', '-q')
  await w.win.waitFor(() => text(primary()) === 'Force Push')

  await click(primary())
  const dialog = await w.win.waitFor(() => dialogNamed('Force push zoe/feat to origin?'))
  expect(text(q('.dialog-message', dialog))).toBe('This replaces the remote branch with your local commits.')
  await click(buttonText('Cancel', dialog))
  await w.win.waitFor(() => !dialogNamed('Force push zoe/feat to origin?'))
  expect(w.git('rev-parse', 'origin/zoe/feat')).not.toBe(w.git('rev-parse', 'HEAD'))

  await click(primary())
  await click(buttonText('Force Push', await w.win.waitFor(() => dialogNamed('Force push zoe/feat to origin?'))))
  await w.win.waitFor(() => text(primary()) === 'Commit' && primary().title === 'Nothing to commit. Branch is up to date.')
  expect(Bun.spawnSync(['git', 'rev-parse', 'refs/heads/zoe/feat'], { cwd: w.originDir }).stdout.toString().trim()).toBe(w.git('rev-parse', 'HEAD'))
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-32: a rejected push toasts "pull first" and fetches, so the ladder moves to Sync', async () => {
  const w = await boot(scratch)
  const peer = w.peer('peer')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'b.ts': 'peer\n' }, 'peer')
  peer.push('zoe/feat')
  w.commit({ 'c.ts': 'mine\n' }, 'mine')
  await w.win.waitFor(() => text(primary()) === 'Push')

  await click(primary())
  await w.win.waitFor(() => toasts().length > 0)
  expect(toasts()).toContainEqual({ title: 'Push rejected — remote has changes', body: 'Pull first, then try again.' })
  await w.win.waitFor(() => text(primary()) === 'Sync')
  expect(primary().title).toBe('Pull 1, push 1')
  expect(q('.scm-remote-error')?.textContent).toBe('Push rejected: remote has newer commits (non-fast-forward). Please pull or sync first.')
}, SLOW)

test('SC-27: a failing pre-commit hook shows the Commit blocked card, its pill and the raw output in Details', async () => {
  const w = await boot(scratch)
  installHook(w, 'pre-commit', 'echo "eslint found 2 problems"\nexit 1')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  w.git('add', 'math.ts')
  await w.win.waitFor(() => rowOf('math.ts', 'staged'))
  await type(messageBox(), 'Add math')
  await click(primary())

  const card = await w.win.waitFor(() => q('.scm-card-blocked'))
  expect(text(q('.scm-card-head strong', card))).toBe('Commit blocked')
  expect(text(q('.scm-pill', card))).toBe('Lint')
  expect(text(q('.scm-summary', card))).toBe('Lint failed during commit.')
  await click(buttonText('Details', card))
  const dialog = await w.win.waitFor(() => dialogNamed('Commit Failed'))
  expect(text(q('pre', dialog))).toContain('eslint found 2 problems')
  await click(buttonText('Close', dialog))
  await w.win.waitFor(() => !dialogNamed('Commit Failed'))
  expect(w.git('log', '-1', '--format=%s')).not.toBe('Add math')
}, SLOW)

test('SC-38: a failing pre-push hook shows the Push blocked card and no inline remote error', async () => {
  const w = await boot(scratch)
  installHook(w, 'pre-push', 'echo "lint-staged failed"\nexit 1')
  w.commit({ 'math.ts': 'a\nB\nc\nd\ne\n' }, 'work')
  await w.win.waitFor(() => text(primary()) === 'Push')
  await click(primary())

  const card = await w.win.waitFor(() => q('.scm-card-blocked'))
  expect(text(q('.scm-card-head strong', card))).toBe('Push blocked')
  expect(text(q('.scm-pill', card))).toBe('Lint')
  expect(text(q('.scm-summary', card))).toBe('Lint failed during push.')
  expect(q('.scm-remote-error')).toBeNull()
  await click(buttonText('Details', card))
  expect(text(q('pre', await w.win.waitFor(() => dialogNamed('Push Failed'))))).toContain('lint-staged failed')
}, SLOW)

test('SC-29: the chevron menu lists every action in order, and Fetch, Fast-forward and Rebase from origin/main run through the daemon', async () => {
  const w = await boot(scratch)
  const peer = w.peer('peer')
  peer.commit({ 'd.ts': 'main moved\n' }, 'main moves')
  peer.push('main')
  peer.git('checkout', '-q', '-B', 'zoe/feat', 'origin/zoe/feat')
  peer.commit({ 'b.ts': 'peer\n' }, 'peer')
  peer.push('zoe/feat')
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  await w.win.waitFor(() => rowOf('math.ts'))

  await openChevron(w)
  expect(menuLabels()).toEqual([
    'Commit',
    'Commit & Push',
    'Commit & Sync',
    'Push',
    'Force Push',
    'Pull',
    'Fast-forward',
    'Sync',
    'Rebase from origin/main',
    'Fetch',
    'Publish Branch'
  ])
  const item = (label: string) => qa('[role="menuitem"]').find((i) => text(i) === label) as HTMLButtonElement
  expect(item('Commit').disabled).toBe(true)
  expect(item('Publish Branch').disabled).toBe(true)
  expect(item('Publish Branch').title).toBe('Branch already has an upstream')
  await click(item('Fetch'))
  await w.win.waitFor(() => w.git('rev-parse', 'origin/zoe/feat') === peer.git('rev-parse', 'HEAD'))
  w.git('checkout', '--', 'math.ts')
  await w.win.waitFor(() => !rowOf('math.ts'))

  await openChevron(w)
  expect(menuLabels()).toContain('Fast-forward (1)')
  await click(qa('[role="menuitem"]').find((i) => text(i) === 'Fast-forward (1)'))
  await w.win.waitFor(() => w.git('rev-parse', 'HEAD') === peer.git('rev-parse', 'HEAD'))

  await openChevron(w)
  await click(qa('[role="menuitem"]').find((i) => text(i) === 'Rebase from origin/main'))
  await w.win.waitFor(() => Bun.spawnSync(['git', 'merge-base', '--is-ancestor', 'origin/main', 'HEAD'], { cwd: w.dir }).exitCode === 0)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-59: a capped status offers to add node_modules to .gitignore, once', async () => {
  const w = await boot(scratch)
  for (let i = 0; i < 1100; i++) w.write(`node_modules/pkg/f${i}.js`, `${i}\n`)
  w.write('math.ts', 'a\nB\nc\nd\ne\n')
  const notice = await w.win.waitFor(() => q('.notice'), 20_000)
  expect(text(q('.notice-text', notice))).toBe('This repository has too many active changes. Add "node_modules" to .gitignore?')
  expect(text(q('.scm-card-warning strong'))).toBe('Too many changes detected. Only the first 1000 are shown.')
  await click(buttonText('Add to .gitignore', notice))
  await w.win.waitFor(() => !q('.scm-card-warning'), 20_000)
  expect(await Bun.file(`${w.dir}/.gitignore`).text()).toContain('node_modules/')
}, SLOW)
