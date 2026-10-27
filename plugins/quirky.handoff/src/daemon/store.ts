import type { PluginStore, StoreMigration } from '@quirky/protocol'
import { BUILTIN_TEMPLATES, normalizeTemplates, type Template } from '../core'
import { TEMPLATE_LIMIT } from '../core/template'
import type { Catalog, Include, Prefs, TemplateOp } from './types'

export const migrations: StoreMigration[] = [
  'CREATE TABLE lineage (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record TEXT NOT NULL)',
  'CREATE INDEX lineage_created_at ON lineage (created_at)',
  'CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)'
]

/** Why a template change was refused: `limit` when the catalog is full, `invalid` for anything else. */
export class TemplateError extends Error {
  constructor(
    readonly reason: 'limit' | 'invalid',
    message: string,
    readonly missing = false
  ) {
    super(message)
  }
}

export const DEFAULT_INCLUDE: Include = { repoState: true, diffBodies: false, openEditorTabs: true }

function readJson(store: PluginStore, key: string): unknown {
  const row = store.get<{ value: string }>('SELECT value FROM kv WHERE key = ?', key)
  if (row === null) return undefined
  try {
    return JSON.parse(row.value)
  } catch {
    return undefined
  }
}

function writeJson(store: PluginStore, key: string, value: unknown): void {
  store.run(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    key,
    JSON.stringify(value)
  )
}

const builtins = (): Template[] => BUILTIN_TEMPLATES.map((template) => ({ ...template }))

/** The template catalog: the built-ins until it is first changed, then the stored list, which may be empty. */
export function readCatalog(store: PluginStore): Catalog {
  const stored = readJson(store, 'templates')
  if (!Array.isArray(stored)) return { templates: builtins(), custom: false }
  return { templates: normalizeTemplates(stored), custom: true }
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase()
}

function writeCatalog(store: PluginStore, templates: Template[]): Template[] {
  const clean = normalizeTemplates(templates)
  writeJson(store, 'templates', clean)
  return clean
}

/**
 * Applies one catalog change. The first change to an untouched catalog starts from the built-ins;
 * every write is normalized. `warnings` carries `duplicate-name` when the saved template shares a
 * name with another. Throws `TemplateError` for a full catalog or a template that normalizes away.
 */
export function mutateCatalog(store: PluginStore, change: TemplateOp): Catalog & { warnings: 'duplicate-name'[] } {
  if (change.op === 'reset') {
    store.run("DELETE FROM kv WHERE key = 'templates'")
    return { templates: builtins(), custom: false, warnings: [] }
  }
  const current = readCatalog(store).templates
  if (change.op === 'remove') {
    if (!current.some((template) => template.id === change.id)) {
      throw new TemplateError('invalid', `no template ${String(change.id)}`, true)
    }
    return { templates: writeCatalog(store, current.filter((template) => template.id !== change.id)), custom: true, warnings: [] }
  }

  const incoming = change.template
  if (!incoming) throw new TemplateError('invalid', 'template is required')
  if (change.op === 'add') {
    if (current.length >= TEMPLATE_LIMIT) throw new TemplateError('limit', `at most ${TEMPLATE_LIMIT} templates`)
    if (incoming.id !== undefined && current.some((template) => template.id === incoming.id)) {
      throw new TemplateError('invalid', `template ${incoming.id} already exists`)
    }
  } else if (!current.some((template) => template.id === incoming.id)) {
    throw new TemplateError('invalid', `no template ${String(incoming.id)}`, true)
  }

  const next =
    change.op === 'add'
      ? [...current, incoming]
      : current.map((template) => (template.id === incoming.id ? { ...incoming, id: template.id } : template))
  const written = normalizeTemplates(next)
  const saved = change.op === 'add' ? written[written.length - 1] : written.find((template) => template.id === incoming.id)
  if (written.length !== next.length || !saved) throw new TemplateError('invalid', 'a template needs a name and instructions')
  writeJson(store, 'templates', written)
  const duplicate = written.some((template) => template.id !== saved.id && sameName(template.name, saved.name))
  return { templates: written, custom: true, warnings: duplicate ? ['duplicate-name'] : [] }
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

/** The remembered agent, include toggles and template, or null before any successful handoff. */
export function readPrefs(store: PluginStore): Prefs | null {
  const stored = readJson(store, 'prefs')
  if (typeof stored !== 'object' || stored === null || Array.isArray(stored)) return null
  const { lastAgent, includeToggles, lastTemplateId } = stored as Record<string, unknown>
  const toggles = (typeof includeToggles === 'object' && includeToggles !== null ? includeToggles : {}) as Record<string, unknown>
  return {
    lastAgent: typeof lastAgent === 'string' && lastAgent !== '' ? lastAgent : null,
    includeToggles: {
      repoState: booleanOr(toggles.repoState, DEFAULT_INCLUDE.repoState),
      diffBodies: booleanOr(toggles.diffBodies, DEFAULT_INCLUDE.diffBodies),
      openEditorTabs: booleanOr(toggles.openEditorTabs, DEFAULT_INCLUDE.openEditorTabs)
    },
    lastTemplateId: typeof lastTemplateId === 'string' && lastTemplateId !== '' ? lastTemplateId : null
  }
}

export function writePrefs(store: PluginStore, prefs: Prefs): void {
  writeJson(store, 'prefs', prefs)
}
