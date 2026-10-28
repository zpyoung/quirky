import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Worktree, WorktreeCreateResult } from '@quirky/protocol'
import { startGithubWorld, type GithubWorld } from './github-fixtures/world'

let world: GithubWorld | undefined
const TEST_TIMEOUT_MS = 60_000

afterEach(async () => {
  await world?.cleanup()
  world = undefined
})

const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

const create = (params: Record<string, unknown>) => world!.call('quirky.worktree/create', { repo: world!.repo.id, ...params }) as Promise<WorktreeCreateResult>

describe('shared script consent hashes', () => {
  test('an old issue-command hash cannot approve changed content at the selected GitHub issue base', async () => {
    world = await startGithubWorld()
    const scriptA = "printf 'A\\n' >> issue-command-runs.txt"
    const scriptB = "printf 'B\\n' >> issue-command-runs.txt"

    git(world.project, 'checkout', '--quiet', '-b', 'issue-consent-base')
    writeFileSync(join(world.project, 'quirky.yaml'), `issueCommand: ${JSON.stringify(scriptA)}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'add issue command A')
    const refA = git(world.project, 'rev-parse', 'HEAD')
    git(world.project, 'push', '--quiet', 'origin', 'issue-consent-base')
    git(world.project, 'checkout', '--quiet', 'main')
    git(world.project, 'fetch', '--quiet', 'origin')

    const shownA = await create({ github: '#4', base: 'origin/issue-consent-base', branchName: 'consent/issue' }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown> }
    )
    expect(shownA?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'issue', script: scriptA, ref: refA })
    const hashA = shownA?.data?.hash
    if (typeof hashA !== 'string') throw new Error('hooks-untrusted did not include hashA')
    expect(hashA).toMatch(/^[a-f0-9]{64}$/)

    git(world.project, 'checkout', '--quiet', 'issue-consent-base')
    writeFileSync(join(world.project, 'quirky.yaml'), `issueCommand: ${JSON.stringify(scriptB)}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'change issue command to B')
    const refB = git(world.project, 'rev-parse', 'HEAD')
    git(world.project, 'push', '--quiet', 'origin', 'issue-consent-base')
    git(world.project, 'checkout', '--quiet', 'main')
    git(world.project, 'fetch', '--quiet', 'origin')

    const stale = await create({
      github: '#4',
      base: 'origin/issue-consent-base',
      branchName: 'consent/issue',
      trustIssueCommand: true,
      trustIssueCommandHash: hashA
    }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown> }
    )
    expect(stale?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'issue', script: scriptB, ref: refB })
    const hashB = stale?.data?.hash
    if (typeof hashB !== 'string') throw new Error('hooks-untrusted did not include hashB')
    expect(hashB).toMatch(/^[a-f0-9]{64}$/)
    expect(hashB).not.toBe(hashA)
    expect(git(world.project, 'branch', '--list', 'consent/issue')).toBe('')
    expect((await world.call('quirky.worktree/list', { repo: world.repo.id }) as Worktree[])).toHaveLength(1)
    expect(existsSync(join(world.project, 'issue-command-runs.txt'))).toBe(false)

    const approvedCli = await world.cli([
      'worktree', 'create', '--repo', world.repo.id, '--github', '#4',
      '--base', 'origin/issue-consent-base', '--branch-name', 'consent/issue',
      '--trust-issue-command', '--trust-issue-command-hash', hashB, '--json'
    ])
    expect({ code: approvedCli.code, stderr: approvedCli.stderr }).toEqual({ code: 0, stderr: '' })
    const approved = JSON.parse(approvedCli.stdout) as WorktreeCreateResult
    expect(approved.worktree.linkedIssue).toMatchObject({ provider: 'github', kind: 'issue', number: 4 })
    expect(readFileSync(join(approved.worktree.path, 'issue-command-runs.txt'), 'utf8')).toBe('B\n')
    await world.call('quirky.repo/trustHooks', { repo: world.repo.id, kind: 'issue', ref: refB })
    const persistedButPinnedToA = await create({
      github: '#4',
      base: 'origin/issue-consent-base',
      branchName: 'consent/issue-persisted',
      trustIssueCommand: true,
      trustIssueCommandHash: hashA
    }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown> }
    )
    expect(persistedButPinnedToA?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'issue', script: scriptB, hash: hashB, ref: refB })
    expect(git(world.project, 'branch', '--list', 'consent/issue-persisted')).toBe('')
    expect((await world.call('quirky.worktree/list', { repo: world.repo.id }) as Worktree[])).toHaveLength(2)
    expect(readFileSync(join(approved.worktree.path, 'issue-command-runs.txt'), 'utf8')).toBe('B\n')
  }, TEST_TIMEOUT_MS)

  test('an old setup hash cannot approve changed content on the selected local base', async () => {
    world = await startGithubWorld()
    const scriptA = 'touch setup-command-A.txt'
    const scriptB = "printf 'B\\n' >> setup-command-runs.txt"

    git(world.project, 'checkout', '--quiet', '-b', 'setup-consent-base')
    writeFileSync(join(world.project, 'quirky.yaml'), `scripts:\n  setup: ${scriptA}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'add setup command A')
    const refA = git(world.project, 'rev-parse', 'HEAD')
    git(world.project, 'checkout', '--quiet', 'main')

    const shownA = await create({ base: 'setup-consent-base', setup: 'run', branchName: 'consent/setup' }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown> }
    )
    expect(shownA?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'setup', script: scriptA, ref: refA })
    const hashA = shownA?.data?.hash
    if (typeof hashA !== 'string') throw new Error('hooks-untrusted did not include hashA')
    expect(hashA).toMatch(/^[a-f0-9]{64}$/)

    git(world.project, 'checkout', '--quiet', 'setup-consent-base')
    writeFileSync(join(world.project, 'quirky.yaml'), `scripts:\n  setup: ${scriptB}\n`)
    git(world.project, 'add', 'quirky.yaml')
    git(world.project, 'commit', '--quiet', '-m', 'change setup command to B')
    const refB = git(world.project, 'rev-parse', 'HEAD')
    git(world.project, 'checkout', '--quiet', 'main')

    const stale = await create({ base: 'setup-consent-base', setup: 'run', branchName: 'consent/setup', trustSetup: true, trustSetupHash: hashA }).then(
      () => null,
      (error) => error as { data?: Record<string, unknown> }
    )
    expect(stale?.data).toMatchObject({ reason: 'hooks-untrusted', kind: 'setup', script: scriptB, ref: refB })
    const hashB = stale?.data?.hash
    if (typeof hashB !== 'string') throw new Error('hooks-untrusted did not include hashB')
    expect(hashB).toMatch(/^[a-f0-9]{64}$/)
    expect(hashB).not.toBe(hashA)
    expect(git(world.project, 'branch', '--list', 'consent/setup')).toBe('')
    expect((await world.call('quirky.worktree/list', { repo: world.repo.id }) as Worktree[])).toHaveLength(1)
    expect(existsSync(join(world.project, 'setup-command-runs.txt'))).toBe(false)

    const approvedCli = await world.cli([
      'worktree', 'create', '--repo', world.repo.id, '--base', 'setup-consent-base',
      '--setup', 'run', '--branch-name', 'consent/setup',
      '--trust-setup', '--trust-setup-hash', hashB, '--json'
    ])
    expect({ code: approvedCli.code, stderr: approvedCli.stderr }).toEqual({ code: 0, stderr: '' })
    const approved = JSON.parse(approvedCli.stdout) as WorktreeCreateResult
    expect(approved.setup).toMatchObject({ ran: 'daemon', exitCode: 0, timedOut: false })
    expect(readFileSync(join(approved.worktree.path, 'setup-command-runs.txt'), 'utf8')).toBe('B\n')
  }, TEST_TIMEOUT_MS)
})
