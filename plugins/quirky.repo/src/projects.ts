import { existsSync, readdirSync, statSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { GitError, NoSuchDirectoryError, gitApi } from '@quirky/git'
import { RpcErrorCode, type PluginContext, type Repo } from '@quirky/protocol'
import { expandHome, resolveRealPath } from '../paths'
import type { Env } from './env'
import { toRepo, type RepoRow } from './store'

const DEFAULT_WORKTREES_ROOT = '~/quirky/workspaces'
const WORKTREES_ROOT_SETTING = 'setting:quirky.worktree/worktreesRoot'

const randomId = (length = 12): string => crypto.randomUUID().replaceAll('-', '').slice(0, length)

const isDirectory = (path: string): boolean => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound
}

/** The result of `method`, or `fallback` when the plugin that provides it is absent or disabled. */
async function callIfPresent<T>(context: PluginContext, method: string, params: Record<string, unknown>, fallback: T): Promise<T> {
  try {
    return (await context.call(method, params)) as T
  } catch (error) {
    if (isMethodNotFound(error)) return fallback
    throw error
  }
}

/** Whether git itself reported that the path is not inside a repository, as opposed to failing to run. */
const isNotARepository = (error: unknown): boolean => error instanceof GitError && error.stderr.includes('not a git repository')

/**
 * Registers the repository containing `path`, or with `folder` a plain directory, and returns it.
 * The same real path is one project, so adding it again returns the existing one.
 */
export async function addRepo(env: Env, path: string, folder: boolean): Promise<Repo> {
  const expanded = expandHome(path)
  let root: string | null = null
  try {
    root = await gitApi().resolveRepoRoot(expanded)
  } catch (error) {
    if (error instanceof NoSuchDirectoryError || !isDirectory(expanded)) throw env.fail('invalid-params', `no such directory: ${expanded}`)
    if (!isNotARepository(error)) throw error
  }
  if (root === null && !folder) {
    throw env.fail('invalid-params', `not a git repository: ${expanded}; pass --folder to add it as a folder project`, {
      reason: 'not-a-repository',
      path: expanded
    })
  }

  const real = resolveRealPath(root ?? expanded)
  const existing = env.store.get<RepoRow>('SELECT * FROM repos WHERE path = ?', real)
  if (existing) return toRepo(existing)
  const repo: Repo = {
    id: `repo_${randomId()}`,
    name: basename(real),
    path: real,
    addedAt: Date.now(),
    kind: root === null ? 'folder' : 'git',
    displayName: null,
    groupId: null
  }
  env.store.run('INSERT INTO repos (id, name, path, added_at, kind) VALUES (?, ?, ?, ?, ?)', repo.id, repo.name, repo.path, repo.addedAt, repo.kind)
  env.changed({ repoId: repo.id })
  return repo
}

/**
 * The folder new projects are cloned or created in: the `quirky.worktree` setting, `~` expanded.
 * The default applies only when the setting doesn't exist (its plugin is off); any other failure propagates.
 */
async function worktreesRoot(env: Env): Promise<string> {
  let configured: unknown
  try {
    configured = ((await env.context.call('setting.get', { id: WORKTREES_ROOT_SETTING })) as { value?: unknown }).value
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== RpcErrorCode.NotFound) throw error
    configured = undefined
  }
  return expandHome(typeof configured === 'string' && configured.trim() !== '' ? configured.trim() : DEFAULT_WORKTREES_ROOT)
}

async function destinationOf(env: Env, location: string | undefined, name: string): Promise<string> {
  if (name === '' || name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw env.fail('invalid-params', `invalid project name: ${name}`, { reason: 'invalid-name' })
  }
  const base = location === undefined ? await worktreesRoot(env) : expandHome(location)
  if (!isAbsolute(base)) throw env.fail('invalid-params', `location must be an absolute path: ${base}`)
  return join(resolve(base), name)
}

const destinationExists = (env: Env, path: string): Error =>
  env.fail('conflict', `destination exists: ${path}`, { reason: 'destination-exists', path })

/** `repo` from `https://host/org/repo.git`, `git@host:org/repo.git` or a local path. */
function nameFromUrl(url: string): string {
  const last = url.trim().replace(/[\\/]+$/, '').split(/[\\/:]/).pop() ?? ''
  return last.replace(/\.git$/, '')
}

/** Clones `url` into `<location ?? worktreesRoot>/<name ?? repo name>` and adds the result. */
export async function cloneRepo(env: Env, params: { url: string; location?: string; name?: string }): Promise<Repo> {
  const dest = await destinationOf(env, params.location, params.name?.trim() || nameFromUrl(params.url))
  if (existsSync(dest)) throw destinationExists(env, dest)
  try {
    await gitApi().cloneRepo(params.url, dest)
  } catch (error) {
    if (!(error instanceof GitError)) throw error
    const detail = error.stderr.trim().split('\n').pop() ?? ''
    throw env.fail('invalid-params', `could not clone ${params.url}${detail ? `: ${detail}` : ''}`)
  }
  return addRepo(env, dest, false)
}

/** Initialises a new repository at `<location ?? worktreesRoot>/<name>` and adds it. */
export async function createRepo(env: Env, params: { name: string; location?: string }): Promise<Repo> {
  const dest = await destinationOf(env, params.location, params.name.trim())
  if (existsSync(dest) && (!isDirectory(dest) || readdirSync(dest).length > 0)) throw destinationExists(env, dest)
  await gitApi().initRepo(dest)
  return addRepo(env, dest, false)
}

/**
 * Closes every session in a worktree of `repo`, so removal leaves nothing running in a folder
 * Quirky no longer tracks. A close that fails aborts the removal and the repo stays.
 */
async function closeSessions(env: Env, repo: Repo): Promise<void> {
  const owned = await callIfPresent<string[]>(env.context, 'quirky.worktree/ownedIds', { repo: repo.id }, [])
  if (owned.length === 0) return
  const sessions = await callIfPresent<{ id: string; worktreeId: string }[]>(env.context, 'quirky.session/list', {}, [])
  for (const session of sessions) {
    if (owned.includes(session.worktreeId)) await env.context.call('quirky.session/close', { session: session.id })
  }
}

/** Forgets the project and its settings and group membership; its folders stay on disk. */
export async function removeRepo(env: Env, selector: string): Promise<{ ok: true }> {
  const repo = env.resolve(selector)
  await closeSessions(env, repo)
  env.store.transaction(() => {
    env.store.run('DELETE FROM trusted_hooks WHERE repo_id = ?', repo.id)
    env.store.run('DELETE FROM repos WHERE id = ?', repo.id)
  })
  env.changed({ repoId: repo.id, ...(repo.groupId ? { groupId: repo.groupId } : {}) })
  return { ok: true }
}
