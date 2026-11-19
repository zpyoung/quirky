import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpecFolderStatus } from './contracts'
import { SLUG_PATTERN, specFolderStatus } from './spec-folder'

const entry = join(import.meta.dir, 'spec-folder.ts')
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@localhost',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@localhost',
  GIT_CONFIG_GLOBAL: '/dev/null'
}
const scratch: string[] = []

function git(cwd: string, ...args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: gitEnv, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
}

function makeRepo(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'spec-folder-test-')))
  scratch.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'commit', '-q', '--allow-empty', '-m', 'init')
  return root
}

function writeSpec(repo: string, folder: string, files: string[]): void {
  const dir = join(repo, 'docs/quirk/specs', folder)
  mkdirSync(dir, { recursive: true })
  for (const file of files) writeFileSync(join(dir, file), 'x')
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

test('reports the main checkout and its branch', () => {
  const repo = makeRepo()
  const status = specFolderStatus(repo, 'ledger', '2026-11-05')
  expect(status.checkout).toBe('main')
  expect(status.branch).toBe('main')
})

test('reports a linked worktree and its branch', () => {
  const repo = makeRepo()
  const linked = join(repo, '..', `${repo.split('/').pop()}-linked`)
  scratch.push(linked)
  git(repo, 'worktree', 'add', '-q', '-b', 'feature/x', linked)
  const status = specFolderStatus(realpathSync(linked), 'ledger', '2026-11-05')
  expect(status.checkout).toBe('worktree')
  expect(status.branch).toBe('feature/x')
})

test('a missing folder resumes at the before pass and names the dated path', () => {
  const repo = makeRepo()
  const status = specFolderStatus(repo, 'ledger', '2026-11-05')
  expect(status.exists).toBe(false)
  expect(status.folder).toBe('docs/quirk/specs/2026-11-05-ledger-redesign')
  expect(status.resumeAt).toBe('before-pass')
  expect(Object.values(status.files).every((present) => present === false)).toBe(true)
})

test('the newest dated folder for the slug wins, and other slugs are ignored', () => {
  const repo = makeRepo()
  writeSpec(repo, '2026-10-01-ledger-redesign', ['current-state.md'])
  writeSpec(repo, '2026-10-20-ledger-redesign', ['current-state.md', 'goals.json'])
  writeSpec(repo, '2026-11-01-ledger-web-redesign', ['current-state.md'])
  writeSpec(repo, '2026-11-02-ledger-design', ['current-state.md'])
  const status = specFolderStatus(repo, 'ledger', '2026-11-05')
  expect(status.exists).toBe(true)
  expect(status.folder).toBe('docs/quirk/specs/2026-10-20-ledger-redesign')
  expect(status.files['goals.json']).toBe(true)
})

test('resumeAt follows the first missing required file', () => {
  const repo = makeRepo()
  const resume = (folder: string, files: string[]): SpecFolderStatus['resumeAt'] => {
    writeSpec(repo, folder, files)
    return specFolderStatus(repo, 'ledger', '2026-11-05').resumeAt
  }
  writeSpec(repo, '2026-01-01-ledger-redesign', [])
  expect(specFolderStatus(repo, 'ledger', '2026-11-05').resumeAt).toBe('before-pass')
  expect(resume('2026-01-02-ledger-redesign', ['current-state.md'])).toBe('brainstorm')
  expect(resume('2026-01-03-ledger-redesign', ['current-state.md', 'logic.md'])).toBe('build')
  expect(resume('2026-01-04-ledger-redesign', ['current-state.md', 'logic.md', 'comparison.md'])).toBe('done')
  expect(resume('2026-01-05-ledger-redesign', ['logic.md', 'comparison.md', 'tech.md'])).toBe('before-pass')
})

test('tech.md is never required', () => {
  const repo = makeRepo()
  writeSpec(repo, '2026-01-01-ledger-redesign', ['current-state.md', 'logic.md', 'comparison.md'])
  const status = specFolderStatus(repo, 'ledger', '2026-11-05')
  expect(status.files['tech.md']).toBe(false)
  expect(status.resumeAt).toBe('done')
})

test('the slug pattern accepts kebab-case only', () => {
  for (const good of ['git', 'source-control', 'a1-b2']) expect(SLUG_PATTERN.test(good)).toBe(true)
  for (const bad of ['', 'Git', 'a--b', '-a', 'a-', 'a_b', 'a b', '../x']) expect(SLUG_PATTERN.test(bad)).toBe(false)
})

test('the CLI exits 2 on a bad slug, a missing slug or a bad date, and prints one JSON object on success', () => {
  const run = (...args: string[]) => Bun.spawnSync([process.execPath, entry, ...args], { cwd: import.meta.dir, stdout: 'pipe', stderr: 'pipe' })
  expect(run('Bad_Slug').exitCode).toBe(2)
  expect(run().exitCode).toBe(2)
  expect(run('ledger', '--date', 'yesterday').exitCode).toBe(2)
  const ok = run('ledger', '--date', '2026-11-05')
  expect(ok.exitCode).toBe(0)
  const parsed = JSON.parse(ok.stdout.toString()) as SpecFolderStatus
  expect(parsed.folder).toMatch(/^docs\/quirk\/specs\/\d{4}-\d{2}-\d{2}-ledger-redesign$/)
})
