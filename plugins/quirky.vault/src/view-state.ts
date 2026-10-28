import type { PluginStore } from '@quirky/protocol'
import { HISTORY_AGENTS } from './agents'
import type { ViewState } from './types'

export type StableViewState = Pick<ViewState, 'disabledAgents' | 'browseSort' | 'searchSort' | 'group' | 'hideEmptySessions' | 'sessionLimit'>
type TransientViewState = Omit<Pick<ViewState, 'host' | 'scope' | 'query' | 'selectedId' | 'expandedIds' | 'focusedSearch'>, 'scope'> & {
  scope?: ViewState['scope']
}

const DEFAULT_STABLE: StableViewState = {
  disabledAgents: [],
  browseSort: 'updated',
  searchSort: 'relevance',
  group: 'project',
  hideEmptySessions: false,
  sessionLimit: 250
}

const DEFAULT_TRANSIENT: Omit<TransientViewState, 'scope'> = {
  host: 'local',
  query: '',
  selectedId: null,
  expandedIds: [],
  focusedSearch: false
}

const TRANSIENT_KEYS: Record<keyof TransientViewState, true> = {
  host: true,
  scope: true,
  query: true,
  selectedId: true,
  expandedIds: true,
  focusedSearch: true
}
const STABLE_KEYS: Record<keyof StableViewState, true> = {
  disabledAgents: true,
  browseSort: true,
  searchSort: true,
  group: true,
  hideEmptySessions: true,
  sessionLimit: true
}

function validStable(value: unknown): value is StableViewState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  return (
    Array.isArray(record.disabledAgents) &&
    record.disabledAgents.every((agent) => typeof agent === 'string' && HISTORY_AGENTS.some((supported) => supported === agent)) &&
    (record.browseSort === 'updated' || record.browseSort === 'created') &&
    (record.searchSort === 'relevance' || record.searchSort === 'newest') &&
    (record.group === 'project' || record.group === 'folder' || record.group === 'agent') &&
    typeof record.hideEmptySessions === 'boolean' &&
    (record.sessionLimit === 250 || record.sessionLimit === 500 || record.sessionLimit === 1000 || record.sessionLimit === null)
  )
}

/** Stable view preferences persist in the plugin store; query and context are process-local. */
export class VaultViewState {
  private stable: StableViewState
  private transient: TransientViewState = { ...DEFAULT_TRANSIENT, expandedIds: [] }

  constructor(private readonly store: PluginStore) {
    this.stable = this.readStable()
  }

  get(defaultScope: ViewState['scope'] = 'all'): ViewState {
    return {
      ...this.stable,
      ...this.transient,
      disabledAgents: [...this.stable.disabledAgents],
      expandedIds: [...this.transient.expandedIds],
      scope: this.transient.scope ?? defaultScope
    }
  }

  set(patch: Record<string, unknown>, defaultScope: ViewState['scope'] = 'all'): ViewState {
    const nextStable = { ...this.stable, disabledAgents: [...this.stable.disabledAgents] }
    const nextTransient = { ...this.transient, expandedIds: [...this.transient.expandedIds] }
    let stableChanged = false
    for (const [key, value] of Object.entries(patch)) {
      if (Object.hasOwn(STABLE_KEYS, key)) {
        this.setStable(nextStable, key as keyof StableViewState, value)
        stableChanged = true
      } else if (Object.hasOwn(TRANSIENT_KEYS, key)) {
        this.setTransient(nextTransient, key as keyof TransientViewState, value)
      } else {
        throw new Error(`unknown view field '${key}'`)
      }
    }
    if (!validStable(nextStable)) throw new Error('view contains invalid stable values')
    if (stableChanged) {
      this.store.run(
        'INSERT INTO vault_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
        'view',
        JSON.stringify(nextStable)
      )
    }
    this.stable = nextStable
    this.transient = nextTransient
    return this.get(defaultScope)
  }

  reset(defaultScope: ViewState['scope'] = 'all'): ViewState {
    const next = { ...DEFAULT_STABLE, disabledAgents: [] }
    this.store.run(
      'INSERT INTO vault_state (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value',
      'view',
      JSON.stringify(next)
    )
    this.stable = next
    this.transient = { ...DEFAULT_TRANSIENT, scope: defaultScope, expandedIds: [] }
    return this.get(defaultScope)
  }

  private readStable(): StableViewState {
    const stored = this.store.get<{ value: string }>('SELECT value FROM vault_state WHERE name = ?', 'view')
    if (!stored) return { ...DEFAULT_STABLE, disabledAgents: [] }
    try {
      const value: unknown = JSON.parse(stored.value)
      if (validStable(value)) return { ...value, disabledAgents: [...value.disabledAgents] }
    } catch {
      // A malformed preference falls back to defaults; it never widens any source scan.
    }
    return { ...DEFAULT_STABLE, disabledAgents: [] }
  }

  private setStable(target: StableViewState, key: keyof StableViewState, value: unknown): void {
    switch (key) {
      case 'disabledAgents': {
        if (!Array.isArray(value)) throw new Error('disabledAgents must contain supported agent IDs')
        const agents: string[] = []
        for (const agent of value) {
          if (typeof agent !== 'string' || !HISTORY_AGENTS.some((supported) => supported === agent)) {
            throw new Error('disabledAgents must contain supported agent IDs')
          }
          if (!agents.includes(agent)) agents.push(agent)
        }
        target.disabledAgents = agents
        return
      }
      case 'browseSort':
        if (value !== 'updated' && value !== 'created') throw new Error('browseSort must be updated or created')
        target.browseSort = value
        return
      case 'searchSort':
        if (value !== 'relevance' && value !== 'newest') throw new Error('searchSort must be relevance or newest')
        target.searchSort = value
        return
      case 'group':
        if (value !== 'project' && value !== 'folder' && value !== 'agent') throw new Error('group must be project, folder or agent')
        target.group = value
        return
      case 'hideEmptySessions':
        if (typeof value !== 'boolean') throw new Error('hideEmptySessions must be a boolean')
        target.hideEmptySessions = value
        return
      case 'sessionLimit':
        if (value !== 250 && value !== 500 && value !== 1000 && value !== null) throw new Error('sessionLimit must be 250, 500, 1000 or null')
        target.sessionLimit = value
        return
    }
  }

  private setTransient(target: TransientViewState, key: keyof TransientViewState, value: unknown): void {
    switch (key) {
      case 'host':
        if (typeof value !== 'string' || value === '' || value.length > 256) throw new Error('host must be a non-empty host selector')
        target.host = value
        return
      case 'scope':
        if (value !== 'workspace' && value !== 'project' && value !== 'all') throw new Error('scope must be workspace, project or all')
        target.scope = value
        return
      case 'query':
        if (typeof value !== 'string' || value.length > 512) throw new Error('query must be at most 512 characters')
        target.query = value
        return
      case 'selectedId':
        if (value !== null && (typeof value !== 'string' || value.length > 1024)) throw new Error('selectedId must be a bounded string or null')
        target.selectedId = value
        return
      case 'expandedIds': {
        if (!Array.isArray(value) || value.length > 200) throw new Error('expandedIds must contain at most 200 bounded IDs')
        const ids: string[] = []
        for (const id of value) {
          if (typeof id !== 'string' || id.length > 1024) throw new Error('expandedIds must contain at most 200 bounded IDs')
          if (!ids.includes(id)) ids.push(id)
        }
        target.expandedIds = ids
        return
      }
      case 'focusedSearch':
        if (typeof value !== 'boolean') throw new Error('focusedSearch must be a boolean')
        target.focusedSearch = value
        return
    }
  }
}
