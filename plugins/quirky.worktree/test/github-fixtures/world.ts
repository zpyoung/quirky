import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
type FixtureState = { authenticated?: boolean; pulls: Record<string, PullFixture>; issues: Record<string, IssueFixture>; apiFailure?: string }

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
  restart(): Promise<void>
  cleanup(): Promise<void>
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], { cwd, env: process.env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.toString()}`)
  return result.stdout.toString().trim()
}

function installRewrite(cwd: string, url: string, localPath: string): void {
  git(cwd, 'config', '--global', `url."file://${localPath}".insteadOf`, url)
}

function itemForPull(number: number, title: string, headRef: string, headSha: string, baseSha: string, baseOwner: string, baseRepo: string): PullFixture {
  return {
    number,
    title,
    body: 'fixture body must never enter a command',
    html_url: `https://github.com/${baseOwner}/${baseRepo}/pull/${number}`,
    state: 'open',
    maintainer_can_modify: true,
    base: {
      ref: 'main',
      sha: baseSha,
      repo: { name: baseRepo, owner: { login: baseOwner }, html_url: `https://github.com/${baseOwner}/${baseRepo}` }
    },
    head: {
      ref: headRef,
      sha: headSha,
      repo: { name: 'fork-repo', owner: { login: 'fork-owner' }, html_url: 'https://github.com/fork-owner/fork-repo' }
    }
  }
}

export async function startGithubWorld(options: { originScheme?: 'ssh' | 'https'; includeTerminal?: boolean; authenticated?: boolean } = {}): Promise<GithubWorld> {
  const root = mkdtempSync(join(tmpdir(), 'quirky-ghwt-'))
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
  const baseUrl = 'https://github.com/test-owner/test-repo.git'
  const forkUrl = 'https://github.com/fork-owner/fork-repo.git'
  const secondBaseUrl = 'https://github.com/other-owner/other-repo.git'
  const remoteBaseUrl = options.originScheme === 'https' ? baseUrl : 'git@github.com:test-owner/test-repo.git'
  const remoteForkUrl = options.originScheme === 'https' ? forkUrl : 'git@github.com:fork-owner/fork-repo.git'
  const remoteSecondBaseUrl = options.originScheme === 'https' ? secondBaseUrl : 'git@github.com:other-owner/other-repo.git'
  const saved = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]))
  let harness: PluginHarness | undefined
  let cleaned = false

  try {
    mkdirSync(home, { recursive: true })
    mkdirSync(fixtureDir, { recursive: true })
    mkdirSync(fakebin, { recursive: true })
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
      GH_HOST: 'github.com',
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
    installRewrite(root, baseUrl, baseBare)
    installRewrite(root, remoteBaseUrl, baseBare)
    git(project, 'remote', 'add', 'origin', remoteBaseUrl)
    git(project, 'fetch', '--quiet', 'origin')

    git(root, 'clone', '--quiet', baseBare, featureSeed)
    git(featureSeed, 'checkout', '--quiet', '-b', 'feature/conflict')
    writeFileSync(join(featureSeed, 'feature.txt'), 'fork head one\n')
    git(featureSeed, 'add', 'feature.txt')
    git(featureSeed, 'commit', '--quiet', '-m', 'fork head one')
    const headSha = git(featureSeed, 'rev-parse', 'HEAD')
    git(root, 'clone', '--quiet', '--bare', featureSeed, forkBare)
    installRewrite(root, forkUrl, forkBare)
    installRewrite(root, remoteForkUrl, forkBare)
    git(featureSeed, 'push', '--quiet', baseBare, 'HEAD:refs/pull/3/head')

    git(root, 'clone', '--quiet', baseBare, secondSeed)
    git(secondSeed, 'checkout', '--quiet', '-b', 'feature/new')
    writeFileSync(join(secondSeed, 'feature.txt'), 'fork head two\n')
    git(secondSeed, 'add', 'feature.txt')
    git(secondSeed, 'commit', '--quiet', '-m', 'fork head two')
    git(secondSeed, 'push', '--quiet', forkBare, 'HEAD:refs/heads/feature/new')
    git(root, 'clone', '--quiet', '--bare', secondSeed, secondBaseBare)
    installRewrite(root, secondBaseUrl, secondBaseBare)
    installRewrite(root, remoteSecondBaseUrl, secondBaseBare)
    git(secondSeed, 'push', '--quiet', secondBaseBare, 'HEAD:refs/pull/3/head')

    const pull = itemForPull(3, 'Reword the README', 'feature/conflict', headSha, baseSha, 'test-owner', 'test-repo')
    const issue: IssueFixture = {
      number: 4,
      title: 'Add a multiply function',
      body: 'fixture issue body must never enter a command',
      html_url: 'https://github.com/test-owner/test-repo/issues/4',
      state: 'open'
    }
    const state: FixtureState = { authenticated: options.authenticated ?? true, pulls: { '3': pull }, issues: { '4': issue } }
    writeFileSync(join(fixtureDir, 'state.json'), JSON.stringify(state))

    const plugins = ['quirky.repo', 'quirky.worktree', 'quirky.hosting', ...(options.includeTerminal ? ['quirky.session', 'quirky.terminal'] : [])]
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
