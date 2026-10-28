import type { PluginStore, StoreMigration } from '@quirky/protocol'
import { parseStoredFloating, type StoredFloating } from '../floating'
import { normalizeQuickCommands } from '../quick-commands/normalize'
import { importMigrations } from '../scrollback'
import type { IdSource } from './tree'
import { TAB_COLORS } from './types'
import type { ClosedTab, GroupNode, PaneNode, QuickCommand, Tab, Workspace } from './types'

/** The plugin store's one migration list: the v1 import table first, then the layout tables. */
export const migrations: StoreMigration[] = [
  ...importMigrations,
  'CREATE TABLE workspaces (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE TABLE quick_commands (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL)',
  'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
]

const MAX_DEPTH = 256

/** A stored workspace row that could not be read back; the service rebuilds it from the sessions. */
export type UnreadableRow = { id: string; revision: number; reason: string }

type Row = { id: string; revision: number; data: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const isString = (value: unknown): value is string => typeof value === 'string'
const isNullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const isDirection = (value: unknown) => value === 'right' || value === 'down'

function isPaneNode(value: unknown, depth = 0): value is PaneNode {
  if (!isRecord(value) || depth > MAX_DEPTH || !isString(value.id)) return false
  if (value.kind === 'pane') {
    const exit = value.exit
    const exitOk =
      exit === null ||
      (isRecord(exit) && (exit.code === null || typeof exit.code === 'number') && (exit.signal === null || typeof exit.signal === 'string'))
    return isString(value.session) && isNullableString(value.title) && exitOk && (value.typed === undefined || typeof value.typed === 'boolean')
  }
  return (
    value.kind === 'split' &&
    isDirection(value.direction) &&
    typeof value.ratio === 'number' &&
    isPaneNode(value.first, depth + 1) &&
    isPaneNode(value.second, depth + 1)
  )
}

function isTab(value: unknown): value is Tab {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !(TAB_COLORS as readonly unknown[]).includes(value.color) ||
    typeof value.pinned !== 'boolean' ||
    !isString(value.createdAt)
  ) {
    return false
  }
  if (value.kind === 'view') {
    return (
      !('root' in value) &&
      !('activePane' in value) &&
      !('session' in value) &&
      isString(value.viewId) &&
      isString(value.key) &&
      (value.input === undefined || isRecord(value.input)) &&
      isString(value.title) &&
      typeof value.preview === 'boolean' &&
      (value.closeCommand === undefined || isString(value.closeCommand)) &&
      (value.closeMethod === undefined || isString(value.closeMethod)) &&
      (value.closeParams === undefined || isRecord(value.closeParams)) &&
      (value.closeContext === undefined || typeof value.closeContext === 'boolean')
    )
  }
  return (
    value.kind === undefined &&
    isString(value.defaultTitle) &&
    isNullableString(value.customTitle) &&
    isNullableString(value.liveTitle) &&
    isPaneNode(value.root) &&
    isString(value.activePane) &&
    isNullableString(value.expandedPane)
  )
}

function isGroupNode(value: unknown, depth = 0): value is GroupNode {
  if (!isRecord(value) || depth > MAX_DEPTH || !isString(value.id)) return false
  if (value.kind === 'group') {
    return (
      Array.isArray(value.tabs) &&
      value.tabs.every(isTab) &&
      isNullableString(value.activeTab) &&
      Array.isArray(value.recent) &&
      value.recent.every(isString) &&
      isNullableString(value.lastQuickCommand)
    )
  }
  return (
    value.kind === 'split' &&
    isDirection(value.direction) &&
    typeof value.ratio === 'number' &&
    isGroupNode(value.first, depth + 1) &&
    isGroupNode(value.second, depth + 1)
  )
}

function isClosedTab(value: unknown): value is ClosedTab {
  return (
    isRecord(value) &&
    isNullableString(value.title) &&
    isString(value.defaultTitle) &&
    isString(value.color) &&
    isString(value.cwd) &&
    isString(value.agent) &&
    isString(value.closedAt)
  )
}

/** The workspace in `data` (with the row's revision), or why it can't be used. */
export function parseWorkspace(id: string, revision: number, data: string): { ok: true; workspace: Workspace } | { ok: false; reason: string } {
  let value: unknown
  try {
    value = JSON.parse(data)
  } catch (error) {
    return { ok: false, reason: `not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(value) || value.id !== id) return { ok: false, reason: 'not a workspace of this row' }
  if (!isGroupNode(value.root)) return { ok: false, reason: 'the group tree is malformed' }
  if (!isString(value.activeGroup)) return { ok: false, reason: 'activeGroup is missing' }
  if (!Array.isArray(value.closed) || !value.closed.every(isClosedTab)) return { ok: false, reason: 'closed tabs are malformed' }
  return { ok: true, workspace: { id, revision, root: value.root, activeGroup: value.activeGroup, closed: value.closed } }
}

/** An `IdSource` over the store's single counter; `value` is what to persist once the change commits. */
export class CounterIds implements IdSource {
  constructor(private n: number) {}

  next(kind: 'tab' | 'grp' | 'pane' | 'split'): string {
    this.n += 1
    return `${kind}-${this.n}`
  }

  get value(): number {
    return this.n
  }
}

/** Reads and writes the layout tables: workspaces, quick commands and the `meta` rows. */
export class LayoutStore {
  constructor(private readonly store: PluginStore) {}

  /** Every stored workspace; rows that can't be parsed come back separately. */
  loadWorkspaces(): { workspaces: Workspace[]; unreadable: UnreadableRow[] } {
    const workspaces: Workspace[] = []
    const unreadable: UnreadableRow[] = []
    for (const row of this.store.all<Row>('SELECT id, revision, data FROM workspaces ORDER BY id')) {
      const parsed = parseWorkspace(row.id, Number(row.revision), row.data)
      if (parsed.ok) workspaces.push(parsed.workspace)
      else unreadable.push({ id: row.id, revision: Number.isInteger(row.revision) ? row.revision : 0, reason: parsed.reason })
    }
    return { workspaces, unreadable }
  }

  /** Writes a workspace and, when given, the ID counter in one transaction. */
  save(workspace: Workspace, counter?: number): void {
    this.store.transaction(() => {
      this.store.run(
        'INSERT INTO workspaces (id, revision, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, data = excluded.data',
        workspace.id,
        workspace.revision,
        JSON.stringify(workspace)
      )
      if (counter !== undefined) this.setMeta('counter', String(counter))
    })
  }

  counter(): number {
    const value = Number(this.meta('counter'))
    return Number.isInteger(value) && value >= 0 ? value : 0
  }

  floating(): StoredFloating {
    return parseStoredFloating(this.meta('floating'))
  }

  saveFloating(state: StoredFloating): void {
    this.setMeta('floating', JSON.stringify(state))
  }

  quickCommands(): QuickCommand[] {
    const rows = this.store.all<{ data: string }>('SELECT data FROM quick_commands ORDER BY position')
    const parsed: unknown[] = []
    for (const row of rows) {
      try {
        parsed.push(JSON.parse(row.data))
      } catch {
        // a damaged row is skipped so the rest of the list stays usable
      }
    }
    return normalizeQuickCommands(parsed)
  }

  saveQuickCommands(commands: readonly QuickCommand[]): void {
    this.store.transaction(() => {
      this.store.run('DELETE FROM quick_commands')
      commands.forEach((command, position) => {
        this.store.run('INSERT INTO quick_commands (id, position, data) VALUES (?, ?, ?)', command.id, position, JSON.stringify(command))
      })
    })
  }

  private meta(key: string): string | null {
    return this.store.get<{ value: string }>('SELECT value FROM meta WHERE key = ?', key)?.value ?? null
  }

  private setMeta(key: string, value: string): void {
    this.store.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value)
  }
}
