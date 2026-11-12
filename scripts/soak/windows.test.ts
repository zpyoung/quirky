import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { FixtureWorktree } from '../ui-review/fixtures'
import { assignWorktrees } from './windows.ts'

function fixtureWorktrees(): FixtureWorktree[] {
  return [
    { id: 'fixture-main', path: '/fixture', repoId: 'repo-ui', name: 'ui-review-fixture', isMain: true, status: 'idle' },
    { id: 'ready', path: '/ready', repoId: 'repo-ui', name: 'ui-review-ready', isMain: false, status: 'working' },
    { id: 'notes', path: '/notes', repoId: 'repo-ui', name: 'ui-review-notes', isMain: false, status: 'needs-you' },
    { id: 'harbor-main', path: '/harbor', repoId: 'repo-harbor', name: 'harbor-api', isMain: true, status: 'idle' },
    { id: 'retry', path: '/retry', repoId: 'repo-harbor', name: 'retry-queue', isMain: false, status: 'failing' },
    { id: 'ledger-main', path: '/ledger', repoId: 'repo-ledger', name: 'ledger-web', isMain: true, status: 'idle' },
    { id: 'export', path: '/export', repoId: 'repo-ledger', name: 'export-csv', isMain: false, status: 'done' }
  ]
}

test('assigns one non-main worktree from each project first', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 3)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv'
  ])
})

test('continues assignment round-robin with remaining worktrees and project mains', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 7)

  expect(assigned.map((worktree) => worktree.name)).toEqual([
    'ui-review-ready', 'retry-queue', 'export-csv', 'ui-review-notes',
    'harbor-api', 'ledger-web', 'ui-review-fixture'
  ])
})

test('assigns no worktrees when the requested count is zero', () => {
  expect(assignWorktrees(fixtureWorktrees(), 0)).toEqual([])
})

test('chooses different repositories before repeating a repository', () => {
  const assigned = assignWorktrees(fixtureWorktrees(), 2)

  expect(assigned).toHaveLength(2)
  expect(new Set(assigned.map((worktree) => worktree.repoId)).size).toBe(2)
})

test('chromiumPath returns null when Playwright has no installed browsers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'quirky-soak-chromium-path-'))
  const home = join(root, 'home')
  const browsers = join(root, 'browsers')
  mkdirSync(home)
  mkdirSync(browsers)
  const moduleUrl = pathToFileURL(resolve(import.meta.dir, 'windows.ts')).href
  const source = `import { chromiumPath } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(chromiumPath()))`
  const child = Bun.spawn([process.execPath, '-e', source], {
    env: { ...process.env, QUIRKY_HOME: home, PLAYWRIGHT_BROWSERS_PATH: browsers },
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })

  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text()
    ])
    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toBe('null')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
