import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import {
  formatContributionId,
  RpcErrorCode,
  type PluginCaller,
  type PluginContext,
  type PluginStore,
  type Repo
} from '@quirky/protocol'
import { NoSuchDirectoryError, gitApi } from '@quirky/git'
import { expandHome, resolveRealPath } from './paths'
import { SelectorSyntaxError, matchRepos } from './selector'

type RepoRow = { id: string; name: string; path: string; added_at: number }

const toRepo = (row: RepoRow): Repo => ({
  id: row.id,
  name: row.name,
  path: row.path,
  addedAt: row.added_at,
  kind: 'git',
  displayName: null,
  groupId: null
})

function randomId(length = 12): string {
  return crypto.randomUUID().replaceAll('-', '').slice(0, length)
}

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

function createStore(context: PluginContext): PluginStore {
  return context.openStore([
    (store) => {
      store.exec(`
        CREATE TABLE repos (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          added_at INTEGER NOT NULL
        )
      `)
      for (const row of readV1Rows<RepoRow>(context.home, 'repos', context.log)) {
        store.run('INSERT OR IGNORE INTO repos (id, name, path, added_at) VALUES (?, ?, ?, ?)', row.id, row.name, row.path, row.added_at)
      }
    }
  ])
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

export function activate(context: PluginContext): void {
  const store = createStore(context)
  const list = (): Repo[] => store.all<RepoRow>('SELECT * FROM repos ORDER BY added_at, id').map(toRepo)

  const fail = (kind: 'invalid-params' | 'not-found' | 'conflict', message: string, data?: unknown) =>
    data === undefined ? context.error(kind, message) : Object.assign(context.error(kind, message), { data })

  function resolve(selector: string): Repo {
    let matches: Repo[]
    try {
      matches = matchRepos(list(), selector)
    } catch (error) {
      if (error instanceof SelectorSyntaxError) throw fail('invalid-params', error.message)
      throw error
    }
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw fail('not-found', `no repo matches ${selector}; use id:, name: or path:`)
    const ids = matches.map((repo) => `id:${repo.id}`)
    throw fail('conflict', `${selector} matches ${matches.length} repos: ${ids.join(', ')}`, { matches: ids })
  }

  async function add(path: string): Promise<Repo> {
    const expanded = expandHome(path)
    const git = gitApi()
    let root: string
    try {
      root = await git.resolveRepoRoot(expanded)
    } catch (error) {
      if (error instanceof NoSuchDirectoryError) throw fail('invalid-params', `no such directory: ${expanded}`)
      throw fail('invalid-params', `not a git repository: ${expanded}`)
    }
    const real = resolveRealPath(root)
    const existing = store.get<RepoRow>('SELECT * FROM repos WHERE path = ?', real)
    if (existing) return toRepo(existing)
    const repo: Repo = {
      id: `repo_${randomId()}`,
      name: basename(real),
      path: real,
      addedAt: Date.now(),
      kind: 'git',
      displayName: null,
      groupId: null
    }
    store.run('INSERT INTO repos (id, name, path, added_at) VALUES (?, ?, ?, ?)', repo.id, repo.name, repo.path, repo.addedAt)
    context.emit('changed', {})
    return repo
  }

  /**
   * Closes every session in a worktree of `repo`, so removal leaves nothing running in a folder
   * Quirky no longer tracks. A close that fails aborts the removal and the repo stays.
   */
  async function closeSessions(repo: Repo): Promise<void> {
    const owned = await callIfPresent<string[]>(context, 'quirky.worktree/ownedIds', { repo: repo.id }, [])
    if (owned.length === 0) return
    const sessions = await callIfPresent<{ id: string; worktreeId: string }[]>(context, 'quirky.session/list', {}, [])
    for (const session of sessions) {
      if (owned.includes(session.worktreeId)) await context.call('quirky.session/close', { session: session.id })
    }
  }

  const provide = (name: string, handler: (params: Record<string, unknown>, caller: PluginCaller) => unknown) =>
    context.provide(formatContributionId('method', context.pluginId, name), handler)

  provide('list', () => list())
  provide('add', (params) => add(String(params.path)))
  provide('resolve', (params) => resolve(String(params.selector)))
  provide('remove', async (params) => {
    const repo = resolve(String(params.repo))
    await closeSessions(repo)
    store.run('DELETE FROM repos WHERE id = ?', repo.id)
    context.emit('changed', {})
    return { ok: true }
  })
}
