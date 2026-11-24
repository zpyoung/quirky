/**
 * Test helper: builds throwaway git repos and allowlist files in a temp dir so
 * the rename tooling never runs against the real tree.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export function createFixtureRepo(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rename-fixture-'))
  const root = join(dir, 'repo')
  mkdirSync(root)
  const git = (...args) =>
    execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })
  git('init', '-q')
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  git('add', '-A')

  return {
    root,
    git,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    read: (path) => readFileSync(join(root, path), 'utf8'),
    readBytes: (path) => readFileSync(join(root, path)),
    exists: (path) => existsSync(join(root, path)),
    tracked: () => git('ls-files').split('\n').filter(Boolean).sort(),
    writeAllowlist: (overrides = {}) => {
      const file = join(dir, 'allowlist.json')
      writeFileSync(
        file,
        JSON.stringify({ version: 1, skipPaths: [], keepTokens: [], creditLines: [], ...overrides })
      )
      return file
    }
  }
}
