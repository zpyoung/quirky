import { afterEach, expect, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isolateGitConfig } from '../../../quirky.repo/test/git-fixtures'
import { buttonText, byLabel, click, q, qa, rowOf, text } from './dom'
import { boot, DIFF_VIEW, openView, SESSION_VIEW, shutdown, type World } from './world'

const { scratch } = isolateGitConfig()
const SLOW = 90_000
afterEach(shutdown)

/** feat has merged a branch that conflicts on every file in `files`. */
async function mergeConflict(w: World, files: string[]): Promise<void> {
  w.git('checkout', '-q', '-b', 'other')
  w.commit(Object.fromEntries(files.map((f) => [f, 'theirs\n'])), 'theirs')
  w.git('checkout', '-q', 'zoe/feat')
  w.commit(Object.fromEntries(files.map((f) => [f, 'ours\n'])), 'ours')
  Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
  await w.win.waitFor(() => q('.scm-card-conflict'))
}

const reviewRows = () => qa('[data-git-view-root] nav[aria-label="Files"] [data-path]').map((r) => text(r))

test('SC-45: the conflict review lists the snapshot, then Refresh marks a staged file Resolved and a removed one Gone', async () => {
  const w = await boot(scratch)
  await mergeConflict(w, ['a.ts', 'b.ts'])
  await click(buttonText('Review conflicts', q('.scm-card-conflict')!))
  await w.win.waitFor(async () => (await openView(w))?.id === DIFF_VIEW)
  await w.win.waitFor(() => reviewRows().length === 2)
  expect(reviewRows()).toEqual(['a.tsUnresolvedOpen', 'b.tsUnresolvedOpen'])
  expect(text(q('[data-git-view-root]')!)).toMatch(/^2 unresolved conflicts · Snapshot captured at .+\.$/)
  expect(text(q('[data-git-view-root] nav[aria-label="Files"] h2'))).toBe('Files')
  await w.win.waitFor(async () => (await w.viewReport())?.conflicts === 2)

  writeFileSync(join(w.dir, 'a.ts'), 'merged\n')
  w.git('add', 'a.ts')
  w.git('rm', '-q', '-f', 'b.ts')
  await click(buttonText('Refresh'))
  await w.win.waitFor(() => reviewRows().join() === 'a.tsResolved,b.tsGone')
  expect(text(q('[data-git-view-root] [role="region"][aria-label="All conflicts resolved"]'))).toContain('All conflicts resolved')
  expect(text(q('[data-git-view-root] [role="region"][aria-label="All conflicts resolved"]'))).toContain('This review snapshot no longer has any live unresolved conflicts.')
  expect(text(q('[data-git-view-root]'))).not.toContain('unresolved conflicts ·')
  await click(buttonText('Dismiss'))
  await w.win.waitFor(async () => (await openView(w))?.id === SESSION_VIEW)
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-41: a conflict staged in a terminal without being opened in Quirky is not listed as resolved locally', async () => {
  const w = await boot(scratch)
  await mergeConflict(w, ['a.ts', 'b.ts'])
  await click(rowOf('a.ts', 'conflicts'))
  await w.win.waitFor(() => q('.cm-editor'))
  writeFileSync(join(w.dir, 'a.ts'), 'merged a\n')
  writeFileSync(join(w.dir, 'b.ts'), 'merged b\n')
  w.git('add', 'a.ts', 'b.ts')
  await w.win.waitFor(() => text(q('.scm-card strong')) === 'Merge in progress')
  expect(qa('[data-section="conflicts"] .scm-row-name').map(text)).toEqual(['a.ts'])
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-44: the conflict file view tints the markers, labels the blocks and wraps Next conflict', async () => {
  const w = await boot(scratch)
  await mergeConflict(w, ['a.ts'])
  await click(rowOf('a.ts', 'conflicts'))
  await w.win.waitFor(() => q('[data-git-view-root] .cm-editor') && text(q('[data-git-view-root] [aria-label="Conflict 1 of 1"]')) === '1 / 1')
  expect(text(q('[data-git-view-root] [role="status"]'))).toContain('Unresolved conflict · Both modified')
  expect(qa('[data-git-view-root] .ui-editor-conflict-label').map(text)).toEqual(['Current change', 'Incoming change', 'End conflict'])
  expect(qa('[data-git-view-root] .ui-editor-conflict-marker').length).toBe(3)
  await click(byLabel('Next conflict'))
  expect(text(q('[data-git-view-root] [aria-label="Conflict 1 of 1"]'))).toBe('1 / 1')
}, SLOW)

test('SC-44: a file deleted by them asks whether to keep it, and a file with no working copy says so', async () => {
  const w = await boot(scratch)
  w.git('checkout', '-q', '-b', 'other')
  w.git('rm', '-q', 'a.ts')
  w.git('commit', '-q', '-m', 'delete a')
  w.git('rm', '-q', 'b.ts')
  w.git('commit', '-q', '-m', 'delete b')
  w.git('checkout', '-q', 'zoe/feat')
  w.commit({ 'a.ts': 'ours a\n', 'b.ts': 'ours b\n' }, 'ours')
  Bun.spawnSync(['git', 'merge', 'other'], { cwd: w.dir, env: process.env })
  await w.win.waitFor(() => rowOf('a.ts', 'conflicts'))
  expect(w.git('status', '--porcelain')).toContain('UD a.ts')

  await click(rowOf('a.ts', 'conflicts'))
  await w.win.waitFor(() => q('[data-git-view-root] [role="status"]'))
  expect(text(q('[data-git-view-root] [role="status"]'))).toContain('Deleted by them')
  expect(text(q('[data-git-view-root] [role="status"]'))).toContain('Decide whether to keep the file or accept deletion')
  expect(readFileSync(join(w.dir, 'a.ts'), 'utf8')).toBe('ours a\n')
  expect(w.problems()).toEqual([])
}, SLOW)

test('SC-46: a cherry-pick with nothing left to resolve shows its banner with Continue and no Abort', async () => {
  const w = await boot(scratch)
  w.git('checkout', '-q', '-b', 'other')
  w.commit({ 'a.ts': 'theirs\n' }, 'pick me')
  const pick = w.git('rev-parse', 'HEAD')
  w.git('checkout', '-q', 'zoe/feat')
  w.commit({ 'a.ts': 'ours\n' }, 'ours')
  Bun.spawnSync(['git', 'cherry-pick', pick], { cwd: w.dir, env: process.env })
  await w.win.waitFor(() => q('.scm-card-conflict'))
  expect(buttonText('Abort cherry-pick', q('.scm-card-conflict')!)).toBeUndefined()
  expect(text(q('.scm-card-conflict strong'))).toBe('Cherry-pick conflicts: 1 unresolved')

  writeFileSync(join(w.dir, 'a.ts'), 'picked\n')
  w.git('add', 'a.ts')
  const banner = await w.win.waitFor(() => (text(q('.scm-card strong')) === 'Cherry-pick in progress' ? q('.scm-card') : undefined))
  expect(buttonText('Continue cherry-pick', banner)).toBeDefined()
  expect(buttonText('Abort cherry-pick', banner)).toBeUndefined()
  expect(q('textarea[aria-label="Commit message"]')).toBeNull()

  await click(buttonText('Continue cherry-pick', banner))
  await w.win.waitFor(() => !q('.scm-card'))
  expect(w.git('log', '-1', '--format=%s')).toBe('pick me')
  expect(q('textarea[aria-label="Commit message"]')).not.toBeNull()
}, SLOW)
