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
    const rows = store.all<GroupRow>('SELECT * FROM groups ORDER BY sort_order, id')
    const byId = new Map(rows.map((row) => [row.id, row]))
    const completed = new Set<string>()
    const repairs = new Set<string>()
    for (const start of rows) {
      if (completed.has(start.id)) continue
      const chain: GroupRow[] = []
      const seen = new Set<string>()
      let current: GroupRow | undefined = start
      while (current && !completed.has(current.id)) {
        if (seen.has(current.id)) {
          const closing = chain[chain.length - 1]!
          closing.parent_id = null
          repairs.add(closing.id)
          break
        }
        seen.add(current.id)
        chain.push(current)
        if (current.parent_id === null) break
        const parent = byId.get(current.parent_id)
        if (!parent || parent.id === current.id) {
          current.parent_id = null
          repairs.add(current.id)
          break
        }
        current = parent
      }
      for (const row of chain) completed.add(row.id)
    }
    if (repairs.size > 0) {
      store.transaction(() => {
        for (const id of repairs) store.run('UPDATE groups SET parent_id = NULL WHERE id = ?', id)
      })
    }
    const members = store.all<{ id: string; group_id: string }>('SELECT id, group_id FROM repos WHERE group_id IS NOT NULL ORDER BY added_at, id')
    return rows.map((row) => toGroup(row, members.filter((member) => member.group_id === row.id).map((member) => member.id)))
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
