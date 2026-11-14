import { afterEach, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { RpcErrorCode } from '@quirky/protocol'
import { bootHosting, type HostingTest } from '../../quirky.hosting/test/helpers'

let host: HostingTest | undefined
afterEach(async () => {
  await host?.cleanup()
  host = undefined
})

function git(realGit: string, cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync([realGit, ...args], {
    cwd,
    env: process.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe'
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function installLocalPushTransport(testHost: HostingTest, realGit: string, bare: string): void {
  const wrapper = `#!${process.execPath}
const args = process.argv.slice(2)
if (args[0] === 'push') {
  const target = args.findIndex((arg, index) => index > 0 && !arg.startsWith('-'))
  if (target < 0) throw new Error('push target is missing')
  args[target] = ${JSON.stringify(bare)}
}
const child = Bun.spawn([${JSON.stringify(realGit)}, ...args], {
  stdin: 'inherit', stdout: 'inherit', stderr: 'inherit', env: process.env
})
process.exitCode = await child.exited
`
  writeFileSync(join(testHost.root, 'fakebin', 'git'), wrapper, { mode: 0o755 })
}

test('forcePush binds to the freshly validated local head and preserves unguarded pushes', async () => {
  host = await bootHosting('process.stdout.write("{}")\n', { extraBuiltins: ['quirky.git'] })
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('the test Git executable is unavailable')

  const repo = host.repoPath
  const bare = join(host.root, 'origin.git')
  git(realGit, repo, 'init', '--bare', '--quiet', bare)
  const a = git(realGit, repo, 'rev-parse', 'HEAD')
  git(realGit, repo, 'push', '--quiet', bare, `${a}:refs/heads/feature`)
  installLocalPushTransport(host, realGit, bare)
  const remoteHead = () => git(realGit, repo, '--git-dir', bare, 'rev-parse', 'refs/heads/feature')
  const forcePush = (params: Record<string, unknown> = {}) => host!.client.callAny('quirky.git/forcePush', {
    worktree: host!.worktree,
    yes: true,
    ...params
  })

  writeFileSync(join(repo, 'b.txt'), 'commit B\n')
  git(realGit, repo, 'add', 'b.txt')
  git(realGit, repo, 'commit', '--quiet', '-m', 'commit B')
  const b = git(realGit, repo, 'rev-parse', 'HEAD')

  writeFileSync(join(repo, 'c.txt'), 'commit C\n')
  git(realGit, repo, 'add', 'c.txt')
  git(realGit, repo, 'commit', '--quiet', '-m', 'commit C')
  const c = git(realGit, repo, 'rev-parse', 'HEAD')

  await expect(forcePush({ expectedLocalHead: b })).rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  for (const invalid of ['abc123', 'g'.repeat(40), 'a'.repeat(64)]) {
    await expect(forcePush({ purpose: 'creation', expectedLocalHead: invalid }))
      .rejects.toMatchObject({ code: RpcErrorCode.InvalidParams })
  }
  expect(remoteHead()).toBe(a)

  await expect(forcePush({ purpose: 'creation', expectedLocalHead: b }))
    .rejects.toMatchObject({ data: { reason: 'stale-target' } })
  expect(remoteHead()).toBe(a)

  git(realGit, repo, 'reset', '--hard', b)
  expect(await forcePush({ purpose: 'creation', expected: a, expectedLocalHead: b })).toMatchObject({
    remote: 'origin',
    branch: 'feature',
    upstream: 'origin/feature'
  })
  expect(remoteHead()).toBe(b)

  git(realGit, repo, 'reset', '--hard', c)
  expect(await forcePush({ purpose: 'creation', expected: b })).toMatchObject({
    remote: 'origin',
    branch: 'feature',
    upstream: 'origin/feature'
  })
  expect(remoteHead()).toBe(c)
}, 20_000)
