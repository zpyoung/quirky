import { chmodSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { startAgentsE2E, type E2E } from '../../../quirky.agents/test/support/e2e'
import { bootTasks, type TasksTest } from '../helpers'
import { fixtureIssue, fixturePullRequest, listFixtureSource, seedListFixture, type FixtureItem } from './list'

const BASE_URL = 'https://github.com/test-owner/test-repo.git'
const FORK_URL = 'https://github.com/fork-owner/fork-repo.git'
const PULL_SOURCE = 'https://github.com/test-owner/test-repo/pull/3'
const ISSUE_SOURCE = 'https://github.com/test-owner/test-repo/issues/4'
const PASTE_READY = '\u001b[?2004h\r\n> \r\n'
const DEFAULT_HOOK_FILE = 'quirky.yaml'

function replaceRequired(source: string, before: string, after: string): string {
  if (!source.includes(before)) throw new Error('The shared GitHub fixture no longer contains the expected pull-request mapper.')
  return source.replace(before, after)
}

const restPull = `function toRestPull(item) {
  const node = toPullRequest(item)
  return { ...node, state: item.state === 'merged' ? 'closed' : item.state, merged: item.state === 'merged', draft: item.state === 'draft', head: { ref: item.headRefName ?? 'feature', sha: item.headRefOid ?? 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) }, html_url: item.url, mergeable: true, mergeable_state: 'clean' }
}`
const workspaceRestPull = `function toRestPull(item) {
  const node = toPullRequest(item)
  const headOwner = item.headOwner ?? 'fork-owner'
  const headRepo = item.headRepoName ?? 'fork-repo'
  const headUrl = 'https://github.com/' + headOwner + '/' + headRepo
  const baseOwner = item.baseOwner ?? 'test-owner'
  const baseRepo = item.baseRepoName ?? 'test-repo'
  const baseUrl = 'https://github.com/' + baseOwner + '/' + baseRepo
  return {
    ...node,
    state: item.state === 'merged' ? 'closed' : item.state,
    merged: item.state === 'merged',
    draft: item.state === 'draft',
    head: {
      ref: item.headRefName ?? 'feature',
      sha: item.headRefOid ?? 'a'.repeat(40),
      repo: { name: headRepo, owner: { login: headOwner }, html_url: headUrl, clone_url: headUrl + '.git', ssh_url: 'git@github.com:' + headOwner + '/' + headRepo + '.git' }
    },
    base: {
      ref: 'main',
      sha: item.baseRefOid ?? 'b'.repeat(40),
      repo: { name: baseRepo, owner: { login: baseOwner }, html_url: baseUrl, clone_url: baseUrl + '.git', ssh_url: 'git@github.com:' + baseOwner + '/' + baseRepo + '.git' }
    },
    html_url: item.url,
    maintainer_can_modify: true,
    mergeable: true,
    mergeable_state: 'clean'
  }
}`

/** Existing stateful Tasks GitHub fixture plus the full REST fields required by canonical PR checkout. */
export const workspaceFixtureSource = replaceRequired(listFixtureSource, restPull, workspaceRestPull)

export type WorkspaceFixtureItem = FixtureItem & {
  baseRefOid?: string
  headOwner?: string
  headRepoName?: string
}

export type WorkspaceFixture = TasksTest & {
  baseBare: string
  forkBare: string
  seedItems(items?: Record<string, WorkspaceFixtureItem[]>): void
  setHooks(hooks: { setup?: string; issueCommand?: string; file?: string }): string
}

export type WorkspaceAgentFixture = E2E & {
  worktree: string
  fixtureRoot: string
  baseBare: string
  readState(): unknown
  writeState(value: unknown): void
}

function runGit(realGit: string, cwd: string, args: string[]): string {
  const result = Bun.spawnSync([realGit, '-C', cwd, ...args], { env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function writeGitShim(path: string, realGit: string, rewrites: [string, string][]): void {
  const script = `#!${process.execPath}
const realGit = ${JSON.stringify(realGit)}
const rewrites = ${JSON.stringify(rewrites)}
const args = process.argv.slice(2)
const configArgs = ['fetch', 'push', 'ls-remote'].includes(args[0] ?? '')
  ? rewrites.flatMap(([url, localPath]) => ['-c', 'url.file://' + localPath + '.insteadOf=' + url])
  : []
const result = Bun.spawnSync([realGit, ...configArgs, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
if (result.stdout.byteLength > 0) process.stdout.write(result.stdout)
if (result.stderr.byteLength > 0) process.stderr.write(result.stderr)
process.exit(result.exitCode ?? 1)
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}


export async function bootWorkspace(options: { extraBuiltins?: string[] } = {}): Promise<WorkspaceFixture> {
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('Git is required to start the workspace fixture.')
  let host: TasksTest | undefined
  try {
    host = await bootTasks(workspaceFixtureSource, options)
    const baseBare = join(host.root, 'base.git')
    const forkBare = join(host.root, 'fork.git')
    const forkSeed = join(host.root, 'fork-seed')
    runGit(realGit, host.root, ['init', '--quiet', '--bare', baseBare])
    runGit(realGit, host.repoPath, ['push', '--quiet', baseBare, 'refs/heads/main:refs/heads/main'])
    runGit(realGit, host.root, ['clone', '--quiet', host.repoPath, forkSeed])
    runGit(realGit, forkSeed, ['checkout', '--quiet', '-b', 'fixture/pr-head', 'refs/remotes/origin/main'])
    writeFileSync(join(forkSeed, 'PR_HEAD.md'), 'fork pull-request head\n')
    runGit(realGit, forkSeed, ['add', 'PR_HEAD.md'])
    runGit(realGit, forkSeed, ['-c', 'user.name=Workspace Fixture', '-c', 'user.email=workspace@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'pull request head'])
    const headOid = runGit(realGit, forkSeed, ['rev-parse', 'HEAD'])
    const baseOid = runGit(realGit, host.repoPath, ['rev-parse', 'refs/heads/main'])
    runGit(realGit, forkSeed, ['push', '--quiet', baseBare, 'HEAD:refs/pull/3/head'])
    runGit(realGit, host.root, ['init', '--quiet', '--bare', forkBare])

    writeGitShim(join(host.root, 'fakebin', 'git'), realGit, [[BASE_URL, baseBare], [FORK_URL, forkBare]])
    const fixture = Object.assign(host, {
      baseBare,
      forkBare,
      seedItems(items: Record<string, WorkspaceFixtureItem[]> = {}) {
        const issue = fixtureIssue('test-owner', 'test-repo', 4, '2026-10-01T00:00:00Z')
        const pull = Object.assign(fixturePullRequest('test-owner', 'test-repo', 3, '2026-10-02T00:00:00Z'), {
          headRefName: 'fixture/pr-head',
          headRefOid: headOid,
          baseRefOid: baseOid,
          headOwner: 'fork-owner',
          headRepoName: 'fork-repo'
        }) as WorkspaceFixtureItem
        host!.writeState(seedListFixture({ ...items, 'test-owner/test-repo': [issue, pull, ...(items['test-owner/test-repo'] ?? [])] }))
      },
      setHooks(hooks: { setup?: string; issueCommand?: string; file?: string }) {
        const filename = hooks.file ?? DEFAULT_HOOK_FILE
        const path = join(host!.repoPath, filename)
        const body = [
          ...(hooks.setup === undefined ? [] : [`scripts:\n  setup: ${JSON.stringify(hooks.setup)}`]),
          ...(hooks.issueCommand === undefined ? [] : [`issueCommand: ${JSON.stringify(hooks.issueCommand)}`])
        ].join('\n') + '\n'
        runGit(realGit, host!.repoPath, ['checkout', '--quiet', 'main'])
        writeFileSync(path, body)
        runGit(realGit, host!.repoPath, ['add', filename])
        runGit(realGit, host!.repoPath, ['-c', 'user.name=Workspace Fixture', '-c', 'user.email=workspace@example.test', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', `set ${filename}`])
        const revision = runGit(realGit, host!.repoPath, ['rev-parse', 'HEAD'])
        runGit(realGit, host!.repoPath, ['update-ref', 'refs/remotes/origin/main', revision])
        runGit(realGit, host!.repoPath, ['push', '--quiet', baseBare, 'refs/heads/main:refs/heads/main'])
        runGit(realGit, host!.repoPath, ['checkout', '--quiet', 'feature'])
        return revision
      }
    }) as WorkspaceFixture
    fixture.seedItems()
    return fixture
  } catch (error) {
    await host?.cleanup()
    throw error
  }
}
export async function bootWorkspaceWithAgent(): Promise<WorkspaceAgentFixture> {
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('Git is required to start the real-agent workspace fixture.')
  const fixtureRoot = mkdtempSync(join(tmpdir(), 'quirky-task-agent-gh-'))
  const fixtureStatePath = join(fixtureRoot, 'state.json')
  const issue = fixtureIssue('test-owner', 'test-repo', 4, '2026-10-01T00:00:00Z')
  writeFileSync(fixtureStatePath, JSON.stringify(seedListFixture({ 'test-owner/test-repo': [issue] })))
  let e2e: E2E | undefined
  let cleaned = false
  try {
    e2e = await startAgentsE2E({
      fakes: { goose: { raw: true, steps: [{ afterMs: 40, write: PASTE_READY }] } },
      extraEnv: { QUIRKY_TEST_FIXTURE_DIR: fixtureRoot }
    })
    const ghPath = join(e2e.fakebin, 'gh')
    writeFileSync(ghPath, `#!${process.execPath}\n${workspaceFixtureSource}\n`)
    chmodSync(ghPath, 0o755)
    const baseBare = join(fixtureRoot, 'base.git')
    runGit(realGit, fixtureRoot, ['init', '--quiet', '--bare', baseBare])
    runGit(realGit, e2e.repo, ['push', '--quiet', baseBare, 'refs/heads/main:refs/heads/main'])
    runGit(realGit, e2e.repo, ['remote', 'add', 'origin', BASE_URL])
    runGit(realGit, e2e.repo, ['update-ref', 'refs/remotes/origin/main', 'HEAD'])
    writeGitShim(join(e2e.fakebin, 'git'), realGit, [[BASE_URL, baseBare]])

    const pluginList = await e2e.call('plugin.list')
    const installedPlugins = new Set<string>()
    if (Array.isArray(pluginList)) {
      for (const plugin of pluginList) {
        if (typeof plugin === 'object' && plugin !== null && !Array.isArray(plugin) && 'id' in plugin && typeof plugin.id === 'string') installedPlugins.add(plugin.id)
      }
    }
    const requiredPlugins = [
      ['quirky.repo', resolve(import.meta.dir, '../../../quirky.repo')],
      ['quirky.worktree', resolve(import.meta.dir, '../../../quirky.worktree')],
      ['quirky.hosting', resolve(import.meta.dir, '../../../quirky.hosting')],
      ['quirky.agents', resolve(import.meta.dir, '../../../quirky.agents')],
      ['quirky.session', resolve(import.meta.dir, '../../../quirky.session')],
      ['quirky.tasks', resolve(import.meta.dir, '../..')]
    ] as const
    for (const [id, path] of requiredPlugins) {
      if (installedPlugins.has(id)) continue
      await e2e.call('plugin.install', { path, yes: true })
      installedPlugins.add(id)
    }

    const resolved = await e2e.call('quirky.worktree/resolve', { selector: `path:${e2e.repo}` })
    if (typeof resolved !== 'object' || resolved === null || Array.isArray(resolved) || !('id' in resolved) || typeof resolved.id !== 'string') {
      throw new Error('The real-agent workspace repository was not registered.')
    }
    const worktree = resolved.id
    await e2e.call('quirky.tasks/state', { worktree })

    const cleanupAgentRuntime = e2e.cleanup
    const cleanup = async () => {
      if (cleaned) return
      cleaned = true
      try {
        await cleanupAgentRuntime()
      } finally {
        rmSync(fixtureRoot, { recursive: true, force: true })
      }
    }
    return Object.assign(e2e, {
      worktree,
      fixtureRoot,
      baseBare,
      readState: () => JSON.parse(readFileSync(fixtureStatePath, 'utf8')) as unknown,
      writeState(value: unknown) {
        const temporary = `${fixtureStatePath}.${process.pid}.tmp`
        writeFileSync(temporary, JSON.stringify(value))
        renameSync(temporary, fixtureStatePath)
      },
      cleanup
    }) as WorkspaceAgentFixture
  } catch (error) {
    try {
      await e2e?.cleanup()
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true })
    }
    throw error
  }
}

export const workspaceSources = { issue: ISSUE_SOURCE, pullRequest: PULL_SOURCE }
export const workspaceFixtureFiles = { baseUrl: BASE_URL, forkUrl: FORK_URL, hookFile: DEFAULT_HOOK_FILE }

export function workspaceItemUrl(kind: 'issue' | 'pullRequest', number: number): string {
  return kind === 'issue'
    ? `https://github.com/test-owner/test-repo/issues/${number}`
    : `https://github.com/test-owner/test-repo/pull/${number}`
}
