import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { QuirkyClient, QuirkyEvent, Worktree } from '@quirky/protocol'
import { useTestGit, type FakeGit, createFakeGit } from '@quirky/git/testing'
import type { GitApi } from '@quirky/git'
import { startHarness, type Harness } from '../../../packages/daemon/test/helpers'

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..')
const FAKES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fakes')

const WORKTREE_DEFAULTS = {
  kind: 'git',
  displayName: null,
  comment: '',
  status: 'in-progress',
  pinned: false,
  unread: false,
  parentId: null,
  createdAt: 0,
  createdBy: 'external',
  baseRef: null,
  keepBranch: false,
  removing: false,
  groupId: null
} as const

function worktree(id: string, path: string, name: string, isMain: boolean): Worktree {
  return {
    id,
    repoId: 'repo_api',
    path,
    branch: name,
    head: id.padEnd(40, 'a'),
    isMain,
    name,
    ...WORKTREE_DEFAULTS
  }
}

export type GitHarness = {
  h: Harness
  git: FakeGit
  client: QuirkyClient
  /** Calls a plugin method as the harness client and returns its untyped result. */
  call(method: string, params: Record<string, unknown>): Promise<any>
  /** Worktree "main" of repo api; both worktrees are real directories under the harness root. */
  main: Worktree
  /** Worktree "fix-login", with a `src` directory to run the CLI in. */
  fixLogin: Worktree
  /** Folder workspace "notes" (kind folder), which has no git. */
  notes: Worktree
  events: QuirkyEvent[]
  cleanup(): Promise<void>
}

/**
 * Starts a daemon whose built-ins are the real `quirky.git` plus a fake `quirky.worktree` that
 * knows the two worktrees of `GitHarness`. Git runs through a fresh fake by default, or the real
 * `@quirky/git` with `realGit`, which also makes `main` a repository with one commit.
 */
export async function startGitHarness(
  options: { git?: GitApi & Partial<FakeGit>; realGit?: boolean } = {}
): Promise<GitHarness> {
  const root = realpathSync(mkdtempSync('/tmp/qg-'))
  const builtin = join(root, 'builtin')
  mkdirSync(builtin)
  mkdirSync(join(root, 'home'))
  symlinkSync(PLUGIN_DIR, join(builtin, 'quirky.git'))
  symlinkSync(join(FAKES_DIR, 'quirky.worktree'), join(builtin, 'quirky.worktree'))

  const main = worktree('wt_main', join(root, 'api'), 'main', true)
  const fixLogin = worktree('wt_fix', join(root, 'api-worktrees', 'fix-login'), 'fix-login', false)
  const notes: Worktree = { ...worktree('wt_notes', join(root, 'notes'), 'notes', true), kind: 'folder', branch: null, head: '' }
  mkdirSync(main.path)
  mkdirSync(notes.path)
  mkdirSync(join(fixLogin.path, 'src'), { recursive: true })

  const git = (options.git as FakeGit | undefined) ?? createFakeGit()
  let restoreEnv = () => {}
  if (options.realGit) {
    restoreEnv = initRepo(main.path)
    useTestGit(null)
  } else useTestGit(git)
  globalThis.__QUIRKY_TEST_WORKTREES__ = [main, fixLogin, notes]
  const h = await startHarness({ home: join(root, 'home'), builtinPluginsDir: builtin })
  const { client, events } = await h.connectWithEvents('cli')
  return {
    h,
    git,
    client,
    call: (method, params) => client.callAny(method, params),
    main,
    fixLogin,
    notes,
    events,
    async cleanup() {
      await h.cleanup()
      restoreEnv()
      useTestGit(null)
      globalThis.__QUIRKY_TEST_WORKTREES__ = undefined
      rmSync(root, { recursive: true, force: true })
    }
  }
}

/**
 * Makes `path` a repository with one commit holding `a.txt`. The git identity and config come from
 * the process environment, since the daemon runs in-process; the returned function restores it.
 */
function initRepo(path: string): () => void {
  const overrides: Record<string, string> = {
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Quirky Test',
    GIT_AUTHOR_EMAIL: 'test@quirky.invalid',
    GIT_COMMITTER_NAME: 'Quirky Test',
    GIT_COMMITTER_EMAIL: 'test@quirky.invalid'
  }
  const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]))
  Object.assign(process.env, overrides)
  const env = process.env
  const git = (...args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], { cwd: path, env })
    if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  }
  git('init', '-b', 'main')
  writeFileSync(join(path, 'a.txt'), 'old\n')
  git('add', 'a.txt')
  git('commit', '-m', 'init')
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}
