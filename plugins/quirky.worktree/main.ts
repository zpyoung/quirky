import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  formatContributionId,
  RpcErrorCode,
  type PluginCaller,
  type PluginContext,
  type PluginStore,
  type QuirkyEvent,
  type Repo,
  type Worktree
} from '@quirky/protocol'
import { BranchCheckedOutError, GitError, gitApi } from '@quirky/git'
import { expandHome, resolveRealPath, worktreeIdForPath } from './paths'
import { SelectorSyntaxError, matchWorktrees, type CallerIdentity } from './selector'

const WORKTREE_NAME = /^[A-Za-z0-9_./-]+$/
const DEFAULT_WORKTREES_ROOT = '~/quirky/workspaces'
const ROOT_SETTING = 'setting:quirky.worktree/worktreesRoot'
const SETTINGS_IMPORTED = 'v1-settings-imported'

type ErrorKind = 'invalid-params' | 'not-found' | 'conflict'
type Handler = (params: Record<string, any>, caller: PluginCaller) => unknown

/** Rows of `table` in the v1 `<home>/quirky.db`, or none when it is missing or unreadable. */
function readV1Rows<T>(home: string, table: string, log: (message: string) => void): T[] {
  const file = join(home, 'quirky.db')
  if (!existsSync(file)) return []
  let db: Database | undefined
  try {
    db = new Database(file, { readonly: true })
    const present = db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)
    return present ? (db.query(`SELECT * FROM ${table}`).all() as T[]) : []
  } catch (error) {
    log(`could not read ${table} from the v1 database: ${error instanceof Error ? error.message : String(error)}`)
    return []
  } finally {
    db?.close()
  }
}

function openWorktreeStore(context: PluginContext): PluginStore {
  return context.openStore([
    (store) => {
      store.exec(`
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          repo_id TEXT NOT NULL
        );
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `)
      for (const row of readV1Rows<{ id: string; repo_id: string }>(context.home, 'worktrees', context.log)) {
        store.run('INSERT OR IGNORE INTO worktrees (id, repo_id) VALUES (?, ?)', row.id, row.repo_id)
      }
    }
  ])
}

function isMethodNotFound(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === RpcErrorCode.MethodNotFound
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** git's own explanation for a failure: its stderr when it has one, else the error message. */
function gitMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown } | null)?.stderr
  if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  return error instanceof Error ? error.message : String(error)
}

/** The cwd and session worktree to read `current` against: explicit params first, then the calling client's. */
function identityOf(caller: PluginCaller, params: { cwd?: string; worktreeId?: string } = {}): CallerIdentity {
  const client: CallerIdentity = caller.role === 'plugin' ? {} : caller
  const cwd = params.cwd ?? client.cwd
  const worktreeId = params.worktreeId ?? client.worktreeId
  return { ...(cwd ? { cwd } : {}), ...(worktreeId ? { worktreeId } : {}) }
}

export async function activate(context: PluginContext): Promise<void> {
  const store = openWorktreeStore(context)

  const fail = (kind: ErrorKind, message: string, data?: unknown) =>
    data === undefined ? context.error(kind, message) : Object.assign(context.error(kind, message), { data })

  const listRepos = async () => (await context.call('quirky.repo/list')) as Repo[]

  function recordWorktrees(repoId: string, ids: string[]): void {
    store.transaction(() => {
      for (const id of ids) {
        store.run('INSERT INTO worktrees (id, repo_id) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET repo_id = excluded.repo_id', id, repoId)
      }
    })
  }

  async function repoWorktrees(repo: Repo): Promise<Worktree[]> {
    const infos = await gitApi().listWorktrees(repo.path)
    const worktrees: Worktree[] = infos.map((info) => ({
      id: worktreeIdForPath(info.path),
      repoId: repo.id,
      path: resolveRealPath(info.path),
      branch: info.branch,
      head: info.head,
      isMain: info.isMain,
      name: info.branch ?? basename(info.path),
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
    }))
    recordWorktrees(repo.id, worktrees.map((worktree) => worktree.id))
    return worktrees
  }

  /** The directory under the worktrees root for a repo's worktrees; unique even for repos sharing a name. */
  async function worktreeDirName(repo: Repo): Promise<string> {
    const shareName = (await listRepos()).some((other) => other.id !== repo.id && other.name === repo.name)
    return shareName ? `${repo.name}-${repo.id.replace(/^repo_/, '').slice(0, 6)}` : repo.name
  }

  function worktreesRoot(): string {
    const configured = String(context.getSetting('worktreesRoot')).trim()
    return resolveRealPath(expandHome(configured === '' ? DEFAULT_WORKTREES_ROOT : configured))
  }

  async function allWorktrees(repos: Repo[]): Promise<Worktree[]> {
    const lists = await Promise.all(repos.map((repo) => repoWorktrees(repo).catch(() => [] as Worktree[])))
    return lists.flat()
  }

  async function findWorktree(selector: string, identity: CallerIdentity): Promise<{ repo: Repo; worktree: Worktree }> {
    const repos = await listRepos()
    let matches: Worktree[]
    try {
      matches = matchWorktrees(await allWorktrees(repos), selector, identity)
    } catch (error) {
      if (error instanceof SelectorSyntaxError) throw fail('invalid-params', error.message)
      throw error
    }
    if (matches.length === 0) {
      throw fail('not-found', `no worktree matches ${selector}; use id:, name:, branch:, path: or current`)
    }
    if (matches.length > 1) {
      const ids = matches.map((worktree) => `id:${worktree.id}`)
      throw fail('conflict', `${selector} matches ${matches.length} worktrees: ${ids.join(', ')}`, { matches: ids })
    }
    const worktree = matches[0]!
    return { repo: repos.find((repo) => repo.id === worktree.repoId)!, worktree }
  }

  /** Closes every session of the worktree, attempting all of them; returns one message per failure. */
  async function closeSessions(worktreeId: string): Promise<string[]> {
    let sessions: { id: string; worktreeId: string }[]
    try {
      sessions = (await context.call('quirky.session/list')) as typeof sessions
    } catch (error) {
      if (isMethodNotFound(error)) return []
      return [`could not list sessions: ${errorMessage(error)}`]
    }
    const errors: string[] = []
    for (const session of sessions) {
      if (session.worktreeId !== worktreeId) continue
      try {
        await context.call('quirky.session/close', { session: session.id })
      } catch (error) {
        errors.push(`could not close session ${session.id}: ${errorMessage(error)}`)
      }
    }
    return errors
  }

  async function create(params: Record<string, any>): Promise<Worktree> {
    const repo = (await context.call('quirky.repo/resolve', { selector: String(params.repo) })) as Repo
    const name = String(params.name)
    if (!WORKTREE_NAME.test(name) || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.includes('..')) {
      throw fail('invalid-params', 'name may contain letters, digits, - _ . and /, cannot start with - or /, and cannot contain ..')
    }
    const path = join(worktreesRoot(), await worktreeDirName(repo), name.replaceAll('/', '-'))
    try {
      await gitApi().addWorktree(repo.path, path, name, params.baseRef)
    } catch (error) {
      if (error instanceof BranchCheckedOutError) throw fail('conflict', error.message)
      throw new Error(gitMessage(error))
    }
    const created = (await repoWorktrees(repo).catch(() => [] as Worktree[])).find((worktree) => worktree.path === path)
    const worktree: Worktree = created ?? {
      id: worktreeIdForPath(path),
      repoId: repo.id,
      path,
      branch: name,
      head: '',
      isMain: false,
      name,
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
    }
    recordWorktrees(repo.id, [worktree.id])
    context.emit('changed', { repoId: repo.id })
    return worktree
  }

  /**
   * Removes a worktree. Without `force`, git decides first and a refusal (dirty or untracked
   * files) is a Conflict that leaves the worktree's sessions running; with `force` the sessions
   * are closed before the forced removal. Once git has removed the worktree, closing its sessions
   * is best effort: failures are reported as `sessionErrors` instead of failing a removal that
   * already happened.
   */
  async function remove(params: Record<string, any>, caller: PluginCaller): Promise<{ ok: true; sessionErrors?: string[] }> {
    const { repo, worktree } = await findWorktree(String(params.worktree), identityOf(caller))
    const force = params.force === true
    if (worktree.isMain) throw fail('conflict', 'the main worktree cannot be removed')
    if (force) {
      const errors = await closeSessions(worktree.id)
      if (errors.length > 0) throw new Error(errors.join('; '))
    }
    try {
      await gitApi().removeWorktree(repo.path, worktree.path, force)
    } catch (error) {
      if (error instanceof GitError && error.exitCode > 0) {
        throw fail('conflict', `could not remove ${worktree.name}: ${gitMessage(error)}`)
      }
      throw new Error(gitMessage(error))
    }
    const sessionErrors = force ? [] : await closeSessions(worktree.id)
    context.emit('changed', { repoId: repo.id })
    return sessionErrors.length > 0 ? { ok: true, sessionErrors } : { ok: true }
  }

  async function describeRemove(params: Record<string, any>, caller: PluginCaller): Promise<string> {
    const { worktree } = await findWorktree(String(params.worktree), identityOf(caller))
    const discarding = params.force === true ? ', discarding uncommitted changes' : ''
    return `Remove worktree ${worktree.name} (${worktree.path})${discarding}?`
  }

  /** Every worktree ID recorded for `repo`, plus its main worktree's, so removing the repo can find their sessions. */
  async function ownedIds(params: Record<string, any>): Promise<string[]> {
    const repo = (await context.call('quirky.repo/resolve', { selector: String(params.repo) })) as Repo
    await repoWorktrees(repo).catch(() => [])
    const recorded = store.all<{ id: string }>('SELECT id FROM worktrees WHERE repo_id = ?', repo.id).map((row) => row.id)
    return [...new Set([...recorded, worktreeIdForPath(repo.path)])].sort()
  }

  /** Drops ownership rows of repos that no longer exist, so a re-added repo starts clean. */
  async function pruneRemovedRepos(): Promise<void> {
    const live = new Set((await listRepos()).map((repo) => repo.id))
    const recorded = store.all<{ repo_id: string }>('SELECT DISTINCT repo_id FROM worktrees').map((row) => row.repo_id)
    for (const repoId of recorded) {
      if (!live.has(repoId)) store.run('DELETE FROM worktrees WHERE repo_id = ?', repoId)
    }
  }

  /** Moves v1's `worktreesRoot` setting over once, unless the user has already chosen a value. */
  async function importV1Root(): Promise<void> {
    if (store.get('SELECT 1 FROM meta WHERE key = ?', SETTINGS_IMPORTED)) return
    store.run('INSERT INTO meta (key, value) VALUES (?, ?)', SETTINGS_IMPORTED, '1')
    const row = readV1Rows<{ key: string; value: string }>(context.home, 'settings', context.log).find((r) => r.key === 'worktreesRoot')
    if (!row) return
    const stored = (await context.call('setting.get', { id: ROOT_SETTING })) as { stored?: unknown }
    if (stored.stored !== undefined) return
    let value: unknown
    try {
      value = JSON.parse(row.value)
    } catch {
      value = undefined
    }
    if (typeof value !== 'string' || value.trim() === '') {
      context.log('skipped the v1 worktreesRoot setting: it is not a non-empty string')
      return
    }
    await context.call('setting.set', { id: ROOT_SETTING, value })
  }

  context.subscribe((event: QuirkyEvent) => {
    if (event.type === 'quirky.repo/changed') pruneRemovedRepos().catch((error) => context.log(`could not prune worktree records: ${error}`))
  })

  const handlers: Record<string, Handler> = {
    async list(params) {
      if (params.repo !== undefined) {
        const repo = (await context.call('quirky.repo/resolve', { selector: String(params.repo) })) as Repo
        try {
          return await repoWorktrees(repo)
        } catch (error) {
          throw new Error(gitMessage(error))
        }
      }
      return await allWorktrees(await listRepos())
    },
    create: (params) => create(params),
    remove,
    describeRemove,
    async resolve(params, caller) {
      return (await findWorktree(String(params.selector), identityOf(caller, params))).worktree
    },
    ownedIds
  }
  for (const [name, handler] of Object.entries(handlers)) {
    context.provide(formatContributionId('method', context.pluginId, name), handler)
  }

  await importV1Root()
}
