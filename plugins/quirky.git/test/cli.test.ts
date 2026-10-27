import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { runCli } from '../../../packages/cli/test/fixtures/fake-daemon'
import { waitFor } from '../../../packages/daemon/test/helpers'
import { startGitHarness, type GitHarness } from './support'

let g: GitHarness
beforeEach(async () => {
  g = await startGitHarness()
})
afterEach(() => g.cleanup())

const run = (args: string[], cwd?: string) => runCli(args, { home: g.h.home, ...(cwd ? { cwd } : {}) })

describe('quirky git CLI group', () => {
  test('SC-33: status, stage and commit run through the generated git commands', async () => {
    const status = await run(['git', 'status', '--worktree', g.main.id, '--json'])
    expect(status.code).toBe(0)
    expect(JSON.parse(status.stdout).files).toEqual([{ path: 'a.txt', index: ' ', worktree: 'M', untracked: false }])

    const stage = await run(['git', 'stage', '--worktree', g.main.id, '--paths', 'a.txt'])
    expect(stage.code).toBe(0)
    const commit = await run(['git', 'commit', '--worktree', g.main.id, '--message', 'edit'])
    expect(commit.code).toBe(0)
    expect(commit.stdout).toContain('c'.repeat(40))

    expect(g.git.calls.map((c) => [c.fn, ...c.args.slice(1)])).toEqual([
      ['statusV2'],
      ['statusV2'],
      ['stagePaths', ['a.txt']],
      ['commit', 'edit']
    ])
    await waitFor(() => g.events.filter((e) => e.type === 'quirky.git/changed').length >= 2)
    expect(g.events.filter((e) => e.type === 'quirky.git/changed')).toHaveLength(2)
  })

  test('SC-7: --worktree takes each selector form and the cwd decides when it is omitted', async () => {
    const inFix = join(g.fixLogin.path, 'src')
    const cases: [string[], string | undefined, string][] = [
      [['--worktree', `id:${g.fixLogin.id}`], undefined, g.fixLogin.path],
      [['--worktree', g.fixLogin.id], undefined, g.fixLogin.path],
      [['--worktree', 'name:main'], undefined, g.main.path],
      [['--worktree', 'main'], undefined, g.main.path],
      [['--worktree', 'branch:fix-login'], undefined, g.fixLogin.path],
      [['--worktree', `path:${inFix}`], undefined, g.fixLogin.path],
      [['--worktree', 'current'], inFix, g.fixLogin.path],
      [['--worktree', 'active'], inFix, g.fixLogin.path],
      [[], inFix, g.fixLogin.path]
    ]
    for (const [flags, cwd, expected] of cases) {
      g.git.calls.length = 0
      const result = await run(['git', 'status', ...flags, '--json'], cwd)
      expect(result.code).toBe(0)
      expect(g.git.calls.map((c) => c.args[0])).toEqual([expected])
    }
  })

  test('an unmatched selector exits 1 with the resolver message', async () => {
    const result = await run(['git', 'status', '--worktree', 'name:nope'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('no worktree matches name:nope')
  })
})
