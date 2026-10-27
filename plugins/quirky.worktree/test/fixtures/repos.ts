import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { QuirkyClient, Repo } from '@quirky/protocol'
import { makeTempDir } from '../../../../packages/daemon/test/plugins/fixtures'
import { commitFiles, git } from '../../../quirky.repo/test/git-fixtures'
import { startPluginHarness, type PluginHarness } from '../../../quirky.repo/test/harness'

/** Points git's global config at a temp file holding `text` (or at nothing), for the rest of the process or until called again. */
export function useGlobalGitConfig(scratch: () => string, text: string | null): void {
  if (text === null) {
    process.env.GIT_CONFIG_GLOBAL = '/dev/null'
    return
  }
  const file = join(scratch(), 'gitconfig')
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, text)
  process.env.GIT_CONFIG_GLOBAL = file
}

/** A global git config naming the user that branch prefixes come from. */
export const githubUser = (name: string): string => `[github]\n\tuser = ${name}\n`

function configure(dir: string): void {
  git(dir, 'config', 'user.name', 'Test')
  git(dir, 'config', 'user.email', 'test@example.com')
  git(dir, 'config', 'commit.gpgsign', 'false')
}

/**
 * A bare repository to use as a remote: `files` committed on `branch` (default main). Its HEAD
 * points at that branch, so a clone's `origin/HEAD` does too.
 */
export function makeOrigin(dir: string, options: { files?: Record<string, string>; branch?: string } = {}): string {
  const branch = options.branch ?? 'main'
  const seed = `${dir}-seed`
  mkdirSync(seed, { recursive: true })
  git(seed, 'init', '-q', '-b', branch)
  configure(seed)
  commitFiles(seed, options.files ?? { 'a.txt': 'one\n' })
  mkdirSync(dir, { recursive: true })
  git(dir, 'init', '-q', '--bare', '-b', branch)
  git(seed, 'push', '-q', dir, branch)
  return realpathSync(dir)
}

/**
 * A working repository with one commit on main. With `origin` it is a clone of it (so `origin/main`
 * and `origin/HEAD` exist); `ignored` lines go in `.gitignore` and `files` are committed.
 */
export function makeProject(dir: string, options: { origin?: string; files?: Record<string, string>; ignored?: string[] } = {}): string {
  if (options.origin) {
    mkdirSync(dirname(dir), { recursive: true })
    git(dirname(dir), 'clone', '-q', options.origin, dir)
    configure(dir)
    if (options.files || options.ignored) commitFiles(dir, { ...(options.ignored ? { '.gitignore': `${options.ignored.join('\n')}\n` } : {}), ...options.files })
  } else {
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q', '-b', 'main')
    configure(dir)
    commitFiles(dir, { ...(options.ignored ? { '.gitignore': `${options.ignored.join('\n')}\n` } : {}), ...(options.files ?? { 'a.txt': 'one\n' }) })
  }
  return realpathSync(dir)
}

/** Which session plugin the daemon runs with. */
export type SessionMode = 'fake' | 'real' | 'none'

export type World = {
  t: PluginHarness
  client: QuirkyClient
  /** The worktrees folder the plugin is configured with. */
  root: string
  add(path: string): Promise<Repo>
}

/** A daemon on real git with the worktrees folder set to a temp directory. */
export async function startWorld(sessions: SessionMode = 'fake'): Promise<World> {
  const t = await startPluginHarness({
    realGit: true,
    ...(sessions === 'real' ? { plugins: ['quirky.repo', 'quirky.worktree', 'quirky.session'], fakeSession: false } : {}),
    ...(sessions === 'none' ? { fakeSession: false } : {})
  })
  const root = realpathSync(makeTempDir('qw-'))
  await t.client.callAny('setting.set', { id: 'setting:quirky.worktree/worktreesRoot', value: root })
  return { t, client: t.client, root, add: async (path) => (await t.client.callAny('quirky.repo/add', { path })) as Repo }
}

export const setSetting = (client: QuirkyClient, name: string, value: unknown) => client.callAny('setting.set', { id: `setting:quirky.worktree/${name}`, value })

export const repoSet = (client: QuirkyClient, repo: string, params: Record<string, unknown>) => client.callAny('quirky.repo/set', { repo, ...params })
