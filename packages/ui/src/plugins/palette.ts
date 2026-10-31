import type { UiToolHue } from '@quirky/protocol'

export type PaletteKind = 'command' | 'tool' | 'view' | 'worktree' | 'file'

export type PaletteEntry = {
  id: string
  title: string
  description?: string
  kind: PaletteKind
  /** Tool entries only: the tool's own icon name and hue. */
  icon?: string
  hue?: UiToolHue
}

export type PaletteScope = 'all' | 'worktrees' | 'commands' | 'files'

export const PALETTE_SCOPES: readonly { id: PaletteScope; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'worktrees', label: 'Worktrees' },
  { id: 'commands', label: 'Commands' },
  { id: 'files', label: 'Files' }
]

const SCOPE_KIND: Record<Exclude<PaletteScope, 'all'>, PaletteKind> = {
  worktrees: 'worktree',
  commands: 'command',
  files: 'file'
}

/** The most files one search asks for, matching the quick-open service's own cap. */
export const FILE_SEARCH_LIMIT = 50

/** Delay between the last keystroke and a file search. */
export const FILE_SEARCH_DEBOUNCE_MS = 150

export type PaletteSection = { title: string | null; entries: PaletteEntry[] }

/** The id the palette records for an entry, and the key its recents are stored under. */
export function entryKey(entry: Pick<PaletteEntry, 'kind' | 'id'>): string {
  return `${entry.kind}:${entry.id}`
}

/** Whether `scope` lets entries of `kind` through: All takes everything, the others take one kind. */
export function inScope(scope: PaletteScope, kind: PaletteKind): boolean {
  return scope === 'all' || SCOPE_KIND[scope] === kind
}

export function filterScope(entries: readonly PaletteEntry[], scope: PaletteScope): PaletteEntry[] {
  return entries.filter((entry) => inScope(scope, entry.kind))
}

/** The scope after `scope` in tab order, wrapping around; `step` -1 goes backwards. */
export function cycleScope(scope: PaletteScope, step: 1 | -1): PaletteScope {
  const index = PALETTE_SCOPES.findIndex((candidate) => candidate.id === scope)
  return PALETTE_SCOPES[(index + step + PALETTE_SCOPES.length) % PALETTE_SCOPES.length]!.id
}

/** Whether a scope searches files; only All and Files do. */
export function searchesFiles(scope: PaletteScope): boolean {
  return scope === 'all' || scope === 'files'
}

/** A file entry's id, which carries its worktree and path so a recent can reopen without searching. */
export function encodeFileId(worktree: string, path: string): string {
  return `${encodeURIComponent(worktree)}/${encodeURIComponent(path)}`
}

/** The worktree and path in a file entry's id, or null when `id` is not one `encodeFileId` made. */
export function decodeFileId(id: string): { worktree: string; path: string } | null {
  const parts = id.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return null
  try {
    return { worktree: decodeURIComponent(parts[0]!), path: decodeURIComponent(parts[1]!) }
  } catch {
    return null
  }
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

/** The file paths in a `quirky.editor/quickOpen` search reply; anything else yields none. */
export function quickOpenPaths(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || !('results' in value) || !Array.isArray(value.results)) return []
  const results: unknown[] = value.results
  const paths: string[] = []
  for (const result of results) {
    if (typeof result !== 'object' || result === null || !('path' in result)) continue
    if (typeof result.path === 'string' && result.path !== '') paths.push(result.path)
  }
  return paths.slice(0, FILE_SEARCH_LIMIT)
}

export function fileEntry(worktree: string, path: string): PaletteEntry {
  return { id: encodeFileId(worktree, path), title: fileName(path), description: path, kind: 'file' }
}

/**
 * The entries behind the stored recent keys, in stored order and within `scope`. A key whose target
 * is gone is skipped, not an error: a tool or worktree absent from `entries`, or a file whose
 * worktree is not in `worktreeIds`.
 */
export function resolveRecents(
  recents: readonly string[],
  entries: readonly PaletteEntry[],
  scope: PaletteScope,
  worktreeIds: ReadonlySet<string>
): PaletteEntry[] {
  const byKey = new Map(entries.map((entry) => [entryKey(entry), entry]))
  const resolved: PaletteEntry[] = []
  const seen = new Set<string>()
  for (const key of recents) {
    if (seen.has(key)) continue
    let entry = byKey.get(key)
    if (entry === undefined && key.startsWith('file:')) {
      const file = decodeFileId(key.slice('file:'.length))
      if (file !== null && worktreeIds.has(file.worktree)) entry = fileEntry(file.worktree, file.path)
    }
    if (entry === undefined || !inScope(scope, entry.kind)) continue
    seen.add(key)
    resolved.push(entry)
  }
  return resolved
}

/**
 * The palette's visible sections. With no query, recents come first under "Recent" and the rest of
 * the scope follows under its own name without repeating them; with a query there are no headers.
 */
export function paletteSections(options: {
  entries: readonly PaletteEntry[]
  scope: PaletteScope
  query: string
  recents: readonly string[]
  worktreeIds: ReadonlySet<string>
}): PaletteSection[] {
  const { entries, scope, query, recents, worktreeIds } = options
  const scoped = filterScope(entries, scope)
  if (query !== '') return scoped.length === 0 ? [] : [{ title: null, entries: scoped }]
  const recent = resolveRecents(recents, entries, scope, worktreeIds)
  const recentKeys = new Set(recent.map(entryKey))
  const rest = scoped.filter((entry) => !recentKeys.has(entryKey(entry)))
  const sections: PaletteSection[] = []
  if (recent.length > 0) sections.push({ title: 'Recent', entries: recent })
  if (rest.length > 0) {
    const label = PALETTE_SCOPES.find((candidate) => candidate.id === scope)!.label
    sections.push({ title: recent.length > 0 ? label : null, entries: rest })
  }
  return sections
}

/** Ranks title matches exact, prefix, substring, then metadata-only, preserving order within each rank. */
export function rankPaletteEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
  if (query === '') return [...entries]
  const ranked: [PaletteEntry[], PaletteEntry[], PaletteEntry[], PaletteEntry[]] = [[], [], [], []]
  for (const entry of entries) {
    const title = entry.title.trim().toLowerCase()
    const rank = title === query ? 0 : title.startsWith(query) ? 1 : title.includes(query) ? 2 : 3
    ranked[rank]!.push(entry)
  }
  return [...ranked[0], ...ranked[1], ...ranked[2], ...ranked[3]]
}

export type PaletteKey = { selected: number; run: boolean }

/**
 * Applies a key press to the palette's selection over `count` entries: arrows move and wrap, Enter
 * asks to run the selected entry (never when the list is empty). Other keys change nothing.
 */
export function paletteKey(key: string, selected: number, count: number): PaletteKey {
  if (count === 0) return { selected: 0, run: false }
  const current = Math.min(Math.max(selected, 0), count - 1)
  if (key === 'ArrowDown') return { selected: (current + 1) % count, run: false }
  if (key === 'ArrowUp') return { selected: (current - 1 + count) % count, run: false }
  return { selected: current, run: key === 'Enter' }
}
