import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { QuirkyClient, Repo } from '@quirky/protocol'
import { spawnCli } from '../../../../packages/cli/test/fixtures/fake-daemon'
import { startPluginHarness, type PluginHarness } from '../../../quirky.repo/test/harness'

const ENV_KEYS = [
  'HOME', 'QUIRKY_HOME', 'XDG_CONFIG_HOME', 'GH_CONFIG_DIR', 'PATH', 'GH_TOKEN', 'GITHUB_TOKEN',
  'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST', 'GH_REPO', 'GH_PROMPT_DISABLED',
  'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS',
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_TERMINAL_PROMPT', 'QUIRKY_TEST_FIXTURE_DIR', 'QUIRKY_TEST_GH_LOG'
] as const

export type PullFixture = {
  number: number
  title: string
  body: string
  html_url: string
  state: 'open' | 'closed'
  draft?: boolean
  maintainer_can_modify: boolean
  base: { ref: string; sha: string; repo: { name: string; owner: { login: string }; html_url: string } }
  head: { ref: string; sha: string; repo: { name: string; owner: { login: string }; html_url: string } }
}

export type IssueFixture = { number: number; title: string; body: string; html_url: string; state: 'open' | 'closed' }
type FixtureState = { host?: string; authenticated?: boolean; pulls: Record<string, PullFixture>; issues: Record<string, IssueFixture>; apiFailure?: string }

export type GithubWorld = {
  root: string
  home: string
  project: string
  baseBare: string
  forkBare: string
  secondBaseBare: string
  baseUrl: string
  forkUrl: string
  secondBaseUrl: string
  worktreesRoot: string
  repo: Repo
  client: QuirkyClient
  harness: PluginHarness
  state: FixtureState
  call(method: string, params?: Record<string, unknown>): Promise<unknown>
  cli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
  setPull(item: PullFixture): void
  setIssue(item: IssueFixture): void
  repointToSecond(item: PullFixture): void
  restart(): Promise<void>
  cleanup(): Promise<void>
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
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
function writeSshShim(path: string, realSsh: string, config: string): void {
  const script = `#!${process.execPath}
const realSsh = ${JSON.stringify(realSsh)}
const config = ${JSON.stringify(config)}
const args = process.argv.slice(2)
const result = Bun.spawnSync([realSsh, '-F', config, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
if (result.stdout.byteLength > 0) process.stdout.write(result.stdout)
if (result.stderr.byteLength > 0) process.stderr.write(result.stderr)
process.exit(result.exitCode ?? 1)
`
  writeFileSync(path, script)
  chmodSync(path, 0o755)
}

function itemForPull(number: number, title: string, headRef: string, headSha: string, baseSha: string, baseOwner: string, baseRepo: string, host = 'github.com'): PullFixture {
  return {
    number,
    title,
    body: 'fixture body must never enter a command',
    html_url: `https://${host}/${baseOwner}/${baseRepo}/pull/${number}`,
    state: 'open',
    maintainer_can_modify: true,
    base: {
      ref: 'main',
      sha: baseSha,
      repo: { name: baseRepo, owner: { login: baseOwner }, html_url: `https://${host}/${baseOwner}/${baseRepo}` }
    },
    head: {
      ref: headRef,
      sha: headSha,
      repo: { name: 'fork-repo', owner: { login: 'fork-owner' }, html_url: `https://${host}/fork-owner/fork-repo` }
    }
  }
}

export async function startGithubWorld(options: { originScheme?: 'ssh' | 'https'; includeTerminal?: boolean; authenticated?: boolean; sshAlias?: boolean; host?: string; enterpriseHost?: string } = {}): Promise<GithubWorld> {
  const realGit = Bun.which('git')
  if (!realGit) throw new Error('Git is required to start the GitHub fixture')
  const realSsh = options.sshAlias ? Bun.which('ssh') : null
  if (options.sshAlias && realSsh === null) throw new Error('SSH is required for the alias fixture')
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'quirky-ghwt-')))
  const home = join(root, 'home')
  const fixtureDir = join(root, 'fixture')
  const fakebin = join(root, 'fakebin')
  const gitConfig = join(home, '.gitconfig')
  const project = join(root, 'project')
  const baseBare = join(root, 'base.git')
  const forkBare = join(root, 'fork.git')
  const secondBaseBare = join(root, 'second-base.git')
  const featureSeed = join(root, 'feature-seed')
  const secondSeed = join(root, 'second-seed')
  const host = options.enterpriseHost ?? options.host ?? 'github.com'
  const sshHost = host.startsWith('[') && host.includes(']') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '')
  const baseUrl = `https://${host}/test-owner/test-repo.git`
  const forkUrl = `https://${host}/fork-owner/fork-repo.git`
  const secondBaseUrl = `https://${host}/other-owner/other-repo.git`
  const sshUrl = (owner: string, repo: string) => sshHost.startsWith('[')
    ? `ssh://git@${sshHost}/${owner}/${repo}.git`
    : `git@${sshHost}:${owner}/${repo}.git`
  const remoteBaseUrl = options.originScheme === 'https' ? baseUrl : sshUrl('test-owner', 'test-repo')
  const remoteForkUrl = options.originScheme === 'https' ? forkUrl : sshUrl('fork-owner', 'fork-repo')
  const remoteSecondBaseUrl = options.originScheme === 'https' ? secondBaseUrl : sshUrl('other-owner', 'other-repo')
  const gitRewrites: [string, string][] = [...new Map<string, string>([
    [baseUrl, baseBare],
    [remoteBaseUrl, baseBare],
    [forkUrl, forkBare],
    [remoteForkUrl, forkBare],
    [secondBaseUrl, secondBaseBare],
    [remoteSecondBaseUrl, secondBaseBare],
    ['git@github-work:test-owner/test-repo.git', baseBare],
    ['git@github-work:fork-owner/fork-repo.git', forkBare],
    ['git@github-work:other-owner/other-repo.git', secondBaseBare]
  ]).entries()]
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
  let harness: PluginHarness | undefined
  let cleaned = false

  try {
    mkdirSync(home, { recursive: true })
    if (options.sshAlias) {
      const sshDir = join(home, '.ssh')
      mkdirSync(sshDir, { recursive: true, mode: 0o700 })
      const sshConfig = join(sshDir, 'config')
      writeFileSync(sshConfig, 'Host github-work\n  HostName github.com\n  User git\n', { mode: 0o600 })
      chmodSync(sshConfig, 0o600)
    }
    mkdirSync(fixtureDir, { recursive: true })
    mkdirSync(fakebin, { recursive: true })
    writeGitShim(join(fakebin, 'git'), realGit, gitRewrites)
    if (realSsh !== null) writeSshShim(join(fakebin, 'ssh'), realSsh, join(home, '.ssh', 'config'))
    writeFileSync(gitConfig, '')
    const gh = join(fakebin, 'gh')
    writeFileSync(gh, readFileSync(join(import.meta.dir, 'gh.mjs')))
    chmodSync(gh, 0o755)
    writeFileSync(join(fixtureDir, 'gh.jsonl'), '')
    for (const [key, value] of Object.entries({
      HOME: home,
      QUIRKY_HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      GH_CONFIG_DIR: join(home, '.config', 'gh'),
      PATH: `${fakebin}${delimiter}${saved.get('PATH') ?? ''}`,
      GH_HOST: host,
      GH_PROMPT_DISABLED: '1',
      GIT_CONFIG_GLOBAL: gitConfig,
      GIT_CONFIG_SYSTEM: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0',
      QUIRKY_TEST_FIXTURE_DIR: fixtureDir,
      QUIRKY_TEST_GH_LOG: join(fixtureDir, 'gh.jsonl')
    })) process.env[key] = value
    for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE']) delete process.env[key]
    git(root, 'config', '--global', 'github.user', 'fixture-user')
    git(root, 'config', '--global', 'user.name', 'GitHub Worktree Fixture')
    git(root, 'config', '--global', 'user.email', 'fixture@example.invalid')
    git(root, 'config', '--global', 'commit.gpgsign', 'false')

    mkdirSync(project, { recursive: true })
    git(project, 'init', '--quiet', '--initial-branch=main')
    git(project, 'config', 'user.name', 'GitHub Worktree Fixture')
    git(project, 'config', 'user.email', 'fixture@example.invalid')
    git(project, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(project, 'README.md'), 'base commit\n')
    git(project, 'add', 'README.md')
    git(project, 'commit', '--quiet', '-m', 'base')
    const baseSha = git(project, 'rev-parse', 'HEAD')

    git(root, 'clone', '--quiet', '--bare', project, baseBare)
    git(project, 'remote', 'add', 'origin', remoteBaseUrl)
    git(project, 'fetch', '--quiet', 'origin')

    git(root, 'clone', '--quiet', baseBare, featureSeed)
    git(featureSeed, 'checkout', '--quiet', '-b', 'feature/conflict')
    writeFileSync(join(featureSeed, 'feature.txt'), 'fork head one\n')
    git(featureSeed, 'add', 'feature.txt')
    git(featureSeed, 'commit', '--quiet', '-m', 'fork head one')
    const headSha = git(featureSeed, 'rev-parse', 'HEAD')
    git(root, 'clone', '--quiet', '--bare', featureSeed, forkBare)
    git(featureSeed, 'push', '--quiet', baseBare, 'HEAD:refs/pull/3/head')

    git(root, 'clone', '--quiet', baseBare, secondSeed)
    git(secondSeed, 'checkout', '--quiet', '-b', 'feature/new')
    writeFileSync(join(secondSeed, 'feature.txt'), 'fork head two\n')
    git(secondSeed, 'add', 'feature.txt')
    git(secondSeed, 'commit', '--quiet', '-m', 'fork head two')
    git(secondSeed, 'push', '--quiet', forkBare, 'HEAD:refs/heads/feature/new')
    git(root, 'clone', '--quiet', '--bare', secondSeed, secondBaseBare)
    git(secondSeed, 'push', '--quiet', secondBaseBare, 'HEAD:refs/pull/3/head')

    const pull = itemForPull(3, 'Reword the README', 'feature/conflict', headSha, baseSha, 'test-owner', 'test-repo', host)
    const issue: IssueFixture = {
      number: 4,
      title: 'Add a multiply function',
      body: 'fixture issue body must never enter a command',
      html_url: `https://${host}/test-owner/test-repo/issues/4`,
      state: 'open'
    }
    const state: FixtureState = { authenticated: options.authenticated ?? true, ...(host !== 'github.com' ? { host } : {}), pulls: { '3': pull }, issues: { '4': issue } }
    writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state))

    const plugins = ['quirky.cli', 'quirky.repo', 'quirky.worktree', 'quirky.hosting', ...(options.includeTerminal ? ['quirky.agents', 'quirky.session', 'quirky.terminal'] : [])]
    harness = await startPluginHarness({ plugins, realGit: true, fakeSession: false, home })
    const repo = (await harness.client.callAny('quirky.repo/add', { path: project })) as Repo
    const worktreesRoot = join(root, 'worktrees')
    mkdirSync(worktreesRoot, { recursive: true })
    await harness.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: worktreesRoot })

    const world: GithubWorld = {
      root,
      home,
      project,
      baseBare,
      forkBare,
      secondBaseBare,
      baseUrl: remoteBaseUrl,
      forkUrl: remoteForkUrl,
      secondBaseUrl: remoteSecondBaseUrl,
      worktreesRoot,
      repo,
      client: harness.client,
      harness,
      state,
      call: (method, params = {}) => world.client.callAny(method, params),
      async cli(args) {
        const proc = spawnCli(args, { home: world.home })
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
        return { code, stdout, stderr }
      },
      setPull(item) {
        state.pulls[String(item.number)] = item
        writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state))
      },
      setIssue(item) {
        state.issues[String(item.number)] = item
        writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state))
      },
      repointToSecond(item) {
        git(project, 'remote', 'set-url', 'origin', remoteSecondBaseUrl)
        git(project, 'fetch', '--quiet', 'origin')
        state.pulls[String(item.number)] = item
        writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state))
      },
      async restart() {
        const restarted = await world.harness.restart()
        world.client = restarted.client
      },
      async cleanup() {
        if (cleaned) return
        cleaned = true
        try {
          await harness?.cleanup()
        } finally {
          for (const key of ENV_KEYS) {
            const value = saved.get(key)
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
          }
          rmSync(root, { recursive: true, force: true })
        }
      }
    }
    return world
  } catch (error) {
    try {
      await harness?.cleanup()
    } finally {
      for (const key of ENV_KEYS) {
        const value = saved.get(key)
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      rmSync(root, { recursive: true, force: true })
    }
    throw error
  }
}

export function makePull(item: PullFixture, changes: Partial<PullFixture> = {}): PullFixture {
  return { ...item, ...changes }
}
