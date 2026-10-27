import type { PluginContext, PluginErrorKind, PluginStore, ProjectGroup, Repo } from '@quirky/protocol'
import { SelectorSyntaxError, matchRepos } from '../selector'
import { toGroup, toRepo, type GroupRow, type RepoRow } from './store'

/** What every `quirky.repo` operation shares: the plugin context, its store and the error helper. */
export type Env = {
  context: PluginContext
  store: PluginStore
  /** A plugin error whose `data` carries the machine-readable `reason` and any extra fields. */
  fail(kind: PluginErrorKind, message: string, data?: unknown): Error
  list(): Repo[]
  resolve(selector: string): Repo
  groups(): ProjectGroup[]
  resolveGroup(selector: string): ProjectGroup
  /** Broadcasts `quirky.repo/changed`. */
  changed(data: { repoId?: string; groupId?: string }): void
}

export function createEnv(context: PluginContext, store: PluginStore): Env {
  const fail: Env['fail'] = (kind, message, data) =>
    data === undefined ? context.error(kind, message) : Object.assign(context.error(kind, message), { data })

  const list = (): Repo[] => store.all<RepoRow>('SELECT * FROM repos ORDER BY added_at, id').map(toRepo)

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

  function groups(): ProjectGroup[] {
    const members = store.all<{ id: string; group_id: string }>('SELECT id, group_id FROM repos WHERE group_id IS NOT NULL ORDER BY added_at, id')
    return store
      .all<GroupRow>('SELECT * FROM groups ORDER BY sort_order, id')
      .map((row) => toGroup(row, members.filter((member) => member.group_id === row.id).map((member) => member.id)))
  }

  function resolveGroup(selector: string): ProjectGroup {
    const all = groups()
    const byId = all.filter((group) => group.id === selector)
    const matches = byId.length > 0 ? byId : all.filter((group) => group.name === selector)
    if (matches.length === 1) return matches[0]!
    if (matches.length === 0) throw fail('not-found', `no group matches ${selector}; use its ID or exact name`)
    const ids = matches.map((group) => group.id)
    throw fail('conflict', `${selector} matches ${matches.length} groups: ${ids.join(', ')}`, { matches: ids })
  }

  return { context, store, fail, list, resolve, groups, resolveGroup, changed: (data) => void context.emit('changed', data) }
}
