import { afterEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { bootHosting, type HostingTest } from '../../quirky.hosting/test/helpers'

let host: HostingTest | undefined
afterEach(async () => { await host?.cleanup(); host = undefined })

function git(cwd: string, args: string[]): string {
  const p = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode) throw new Error(new TextDecoder().decode(p.stderr))
  return new TextDecoder().decode(p.stdout).trim()
}

test('merge preview reports exact conflict paths without changing branch/index/worktree or running merge drivers', async () => {
  host = await bootHosting('process.stdout.write("{}")', { extraBuiltins: ['quirky.git', 'quirky.agents', 'quirky.session', 'quirky.terminal'] })
  const repo = host.repoPath
  const file = join(repo, 'README.md')
  writeFileSync(file, 'feature change\n')
  git(repo, ['add', 'README.md']); git(repo, ['commit', '-qm', 'feature'])
  const head = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '--quiet', 'main'])
  writeFileSync(file, 'main change\n')
  git(repo, ['add', 'README.md']); git(repo, ['commit', '-qm', 'main'])
  const base = git(repo, ['rev-parse', 'HEAD'])
  git(repo, ['switch', '--quiet', 'feature'])
  writeFileSync(join(repo, 'local-untracked'), 'keep me')
  const before = { head: git(repo, ['rev-parse', 'HEAD']), index: git(repo, ['write-tree']), status: git(repo, ['status', '--porcelain=v1']), content: readFileSync(file, 'utf8') }
  const preview = await host.call('quirky.git/mergePreview', { base, head })
  expect(preview).toMatchObject({ available: true, base, head, conflicting: true, files: ['README.md'] })
  expect({ head: git(repo, ['rev-parse', 'HEAD']), index: git(repo, ['write-tree']), status: git(repo, ['status', '--porcelain=v1']), content: readFileSync(file, 'utf8') }).toEqual(before)
  const clean = await host.call('quirky.git/mergePreview', { base: head, head })
  expect(clean).toMatchObject({ available: true, conflicting: false, files: [] })
  const unavailable = await host.call('quirky.git/mergePreview', { base: 'f'.repeat(40), head })
  expect(unavailable).toMatchObject({ available: false, reason: 'objects-unavailable', files: [] })
  await expect(host.call('quirky.git/mergePreview', { base: '--help', head })).rejects.toMatchObject({ data: { reason: 'invalid-commit' } })
  git(repo, ['config', 'merge.untrusted.driver', 'touch should-never-exist'])
  const driverPreview = await host.call('quirky.git/mergePreview', { base, head })
  expect(driverPreview).toMatchObject({ available: false, reason: 'custom-merge-driver', files: [] })
  expect(existsSync(join(repo, 'should-never-exist'))).toBe(false)
}, 20_000)
