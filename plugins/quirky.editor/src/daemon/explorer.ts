import { spawn } from 'node:child_process'
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve as resolvePath, sep } from 'node:path'
import { RpcErrorCode, type PluginCaller, type PluginContext, type PluginStore } from '@quirky/protocol'
import type { ExplorerEntry, ExplorerInteraction, ExplorerNavigationKey, ExplorerParams } from '../types'
import { FileInventory, QUICK_OPEN_MAX_ENTRIES } from './inventory'
import { KeyedQueue } from './queue'
import { WorktreePaths, type ResolvedWorktree } from './paths'

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })
const NAVIGATION_KEYS: Record<ExplorerNavigationKey, true> = {
  ArrowUp: true,
  ArrowDown: true,
  ArrowLeft: true,
  ArrowRight: true,
  Home: true,
  End: true,
  PageUp: true,
  PageDown: true
}


export type ExplorerResult = {
  root: string
  entries: (ExplorerEntry & { isDirectory: boolean; isSymlink: boolean })[]
  truncated?: boolean
  showDotfiles: boolean
  showIgnored: boolean
  followSymlinkedDirectories: boolean
  expanded?: string[]
  interaction?: ExplorerInteraction
}

type PreferenceRow = { show_dotfiles: number; display_root: string | null }

export class ExplorerService {
  private readonly expanded = new Map<string, Set<string>>()
  private readonly interactions = new Map<string, ExplorerInteraction>()
  private readonly interactionQueue = new KeyedQueue()
  private readonly directoryCache = new Map<string, ExplorerEntry[]>()

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore,
    private readonly paths: WorktreePaths,
    private readonly inventory: FileInventory
  ) {}

  async call(params: ExplorerParams, caller?: PluginCaller): Promise<ExplorerResult> {
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (
      params.action === 'navigate' ||
      params.action === 'select' ||
      params.action === 'preferences' ||
      (params.action === 'reveal' && params.path !== undefined)
    ) {
      return await this.interactionQueue.run([`explorer:${worktree.id}`], async () => {
        if (params.action === 'preferences') return await this.preferences(worktree.id, params)
        if (params.action === 'reveal' && params.path !== undefined) return await this.reveal(worktree.id, params.path)
        return await this.interact(worktree, params)
      })
    }
    if (params.action === 'refresh') this.inventory.invalidate(worktree.path)
    if (params.action === 'filter') return await this.filter(worktree.id, worktree.path, params)
    const preferences = this.preferencesFor(worktree.id)
    const requested = params.path ?? preferences.displayRoot ?? '.'
    const target = await this.paths.path(worktree.id, requested)
    const info = await stat(target.path)
    if (!info.isDirectory()) throw this.context.error('invalid-params', `Explorer path is not a directory: ${requested}`)
    const entries = await this.directoryEntries(
      worktree.id,
      worktree.path,
      target.path,
      preferences.showDotfiles,
      params.showIgnored ?? this.setting('showGitIgnoredFiles', true)
    )
    return this.result(target.path, entries, worktree.id, params.showIgnored ?? this.setting('showGitIgnoredFiles', true))
  }

  snapshot(worktreeId: string): { worktreeId: string; showDotfiles: boolean; expanded: string[] } & Partial<ExplorerInteraction> {
    const preference = this.preferencesFor(worktreeId)
    const interaction = this.interactions.get(worktreeId)
    return {
      worktreeId,
      showDotfiles: preference.showDotfiles,
      expanded: [...(this.expanded.get(worktreeId) ?? [])],
      ...(interaction ?? {})
    }
  }

  dispose(): void {
    this.expanded.clear()
    this.interactions.clear()
    this.directoryCache.clear()
  }

  /** Keeps Explorer interaction paths valid after successful filesystem mutations. */
  async clearMutationInteraction(worktreeId: string, mutationPaths: readonly string[], includeDescendants: boolean): Promise<void> {
    await this.interactionQueue.run([`explorer:${worktreeId}`], async () => {
      const current = this.interactions.get(worktreeId)
      if (current === undefined) return
      const affects = (candidate: string) => mutationPaths.some((path) =>
        candidate === path || (includeDescendants && this.paths.isWithin(path, candidate))
      )
      const checkedPaths = new Map<string, Promise<boolean>>()
      const pathExists = (candidate: string): Promise<boolean> => {
        let check = checkedPaths.get(candidate)
        if (check === undefined) {
          check = this.paths.entryPath(worktreeId, candidate).then(
            () => true,
            (error) => (error as { code?: unknown } | null)?.code !== RpcErrorCode.NotFound
          )
          checkedPaths.set(candidate, check)
        }
        return check
      }
      const isStale = async (candidate: string): Promise<boolean> =>
        affects(candidate) || !(await pathExists(candidate))
      const selectedPaths: string[] = []
      for (const candidate of current.selectedPaths) {
        if (!(await isStale(candidate))) selectedPaths.push(candidate)
      }
      let focusedPath = current.focusedPath
      if (focusedPath !== null && await isStale(focusedPath)) focusedPath = null
      let selectionAnchor = current.selectionAnchor
      if (selectionAnchor !== null && await isStale(selectionAnchor)) selectionAnchor = null
      if (
        selectedPaths.length !== current.selectedPaths.length ||
        focusedPath !== current.focusedPath ||
        selectionAnchor !== current.selectionAnchor
      ) {
        this.interactions.set(worktreeId, { selectedPaths, focusedPath, selectionAnchor })
      }
    })
  }

  private async interact(worktree: ResolvedWorktree, params: ExplorerParams): Promise<ExplorerResult> {
    if (params.action === 'navigate' && (params.key === undefined || !Object.hasOwn(NAVIGATION_KEYS, params.key))) {
      throw this.context.error('invalid-params', 'navigate requires a supported key.')
    }
    if (params.action === 'select' && params.path === undefined) throw this.context.error('invalid-params', 'select requires a path.')

    const query = params.query?.trim() === '' ? undefined : params.query
    let expanded = new Set(this.expanded.get(worktree.id) ?? [])
    let rows = await this.visibleRows(worktree, query, expanded)
    let current = this.sanitizeInteraction(this.interactionFor(worktree.id), rows)
    let next = current

    if (params.action === 'select') {
      await this.paths.path(worktree.id, params.path!)
      const requested = resolvePath(worktree.path, params.path!)
      const target = rows.find((entry) => resolvePath(entry.path) === requested)
      if (target === undefined) throw this.context.error('invalid-params', 'Explorer selection must target a visible path.')
      next = this.selectTarget(current, rows, target.path, params.extend === true, params.toggle === true)
    } else {
      const key = params.key!
      const currentIndex = rows.findIndex((entry) => entry.path === current.focusedPath)
      let target: string | null = null
      let changedExpansion = false

      if (key === 'ArrowRight' && currentIndex >= 0) {
        const row = rows[currentIndex]!
        if (row.isDirectory) {
          const relativePath = normalizeRelativePath(relative(worktree.path, row.path))
          if (!expanded.has(relativePath)) {
            expanded.add(relativePath)
            rows = await this.visibleRows(worktree, query, expanded)
            current = this.sanitizeInteraction(current, rows)
            changedExpansion = true
          } else {
            const child = rows[currentIndex + 1]
            if (child !== undefined && dirname(child.path) === row.path) target = child.path
          }
        }
      } else if (key === 'ArrowLeft' && currentIndex >= 0) {
        const row = rows[currentIndex]!
        const relativePath = normalizeRelativePath(relative(worktree.path, row.path))
        if (row.isDirectory && expanded.has(relativePath)) {
          expanded.delete(relativePath)
          rows = await this.visibleRows(worktree, query, expanded)
          current = this.sanitizeInteraction(current, rows)
          changedExpansion = true
        } else {
          const parentIndex = rows.findIndex((entry) => entry.path === dirname(row.path))
          if (parentIndex >= 0) target = rows[parentIndex]!.path
        }
      } else if (rows.length > 0) {
        const page = Math.max(1, Math.floor(rows.length / 10))
        let targetIndex: number
        if (key === 'Home') targetIndex = 0
        else if (key === 'End') targetIndex = rows.length - 1
        else {
          const upward = key === 'ArrowUp' || key === 'PageUp'
          const step = key === 'PageUp' || key === 'PageDown' ? page : 1
          const base = currentIndex < 0 ? (upward ? rows.length : -1) : currentIndex
          targetIndex = Math.max(0, Math.min(rows.length - 1, base + (upward ? -step : step)))
        }
        target = rows[targetIndex]!.path
      }

      if (target !== null) next = this.selectTarget(current, rows, target, params.extend === true, false)
      else if (!changedExpansion) next = current
    }

    const root = await this.listingRoot(worktree)
    this.expanded.set(worktree.id, expanded)
    this.interactions.set(worktree.id, next)
    return {
      ...this.result(root, [], worktree.id),
      interaction: next,
      expanded: [...expanded]
    }
  }

  private async visibleRows(
    worktree: ResolvedWorktree,
    query: string | undefined,
    expanded: Set<string>
  ): Promise<ExplorerResult['entries']> {
    if (query !== undefined) return (await this.filter(worktree.id, worktree.path, { action: 'filter', query })).entries

    const preferences = this.preferencesFor(worktree.id)
    const root = await this.listingRoot(worktree)
    const showIgnored = this.setting('showGitIgnoredFiles', true)
    const rows: ExplorerResult['entries'] = []
    const rootEntries = await this.directoryEntries(worktree.id, worktree.path, root, preferences.showDotfiles, showIgnored)
    const directories: { entries: ExplorerEntry[]; index: number }[] = [{
      entries: this.visibleDirectoryEntries(rootEntries, preferences.showDotfiles, showIgnored),
      index: 0
    }]

    while (directories.length > 0 && rows.length < QUICK_OPEN_MAX_ENTRIES) {
      const current = directories[directories.length - 1]!
      if (current.index >= current.entries.length) {
        directories.pop()
        continue
      }
      const entry = current.entries[current.index++]!
      rows.push(entry)
      if (entry.isDirectory && expanded.has(normalizeRelativePath(relative(worktree.path, entry.path)))) {
        const children = await this.directoryEntries(worktree.id, worktree.path, entry.path, preferences.showDotfiles, showIgnored)
        const visibleChildren = this.visibleDirectoryEntries(children, preferences.showDotfiles, showIgnored)
        if (visibleChildren.length > 0) directories.push({ entries: visibleChildren, index: 0 })
      }
    }
    return rows
  }

  private async listingRoot(worktree: ResolvedWorktree): Promise<string> {
    const displayRoot = this.preferencesFor(worktree.id).displayRoot
    return displayRoot === null ? worktree.path : (await this.paths.path(worktree.id, displayRoot)).path
  }

  private interactionFor(worktreeId: string): ExplorerInteraction {
    return this.interactions.get(worktreeId) ?? { selectedPaths: [], focusedPath: null, selectionAnchor: null }
  }

  private sanitizeInteraction(interaction: ExplorerInteraction, rows: ExplorerResult['entries']): ExplorerInteraction {
    const selected = new Set(interaction.selectedPaths)
    const visible = new Set(rows.map((entry) => entry.path))
    return {
      selectedPaths: rows.filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
      focusedPath: interaction.focusedPath !== null && visible.has(interaction.focusedPath) ? interaction.focusedPath : null,
      selectionAnchor: interaction.selectionAnchor !== null && visible.has(interaction.selectionAnchor) ? interaction.selectionAnchor : null
    }
  }
  private visibleDirectoryEntries(entries: ExplorerEntry[], showDotfiles: boolean, showIgnored: boolean): ExplorerEntry[] {
    return entries.filter((entry) =>
      (showDotfiles || !entry.name.startsWith('.') || entry.name === '.') &&
      (showIgnored || entry.ignored !== true)
    )
  }


  private selectTarget(
    interaction: ExplorerInteraction,
    rows: ExplorerResult['entries'],
    target: string,
    extend: boolean,
    toggle: boolean
  ): ExplorerInteraction {
    const targetIndex = rows.findIndex((entry) => entry.path === target)
    if (toggle) {
      const selected = new Set(interaction.selectedPaths)
      if (selected.has(target)) selected.delete(target)
      else selected.add(target)
      return {
        selectedPaths: rows.filter((entry) => selected.has(entry.path)).map((entry) => entry.path),
        focusedPath: target,
        selectionAnchor: interaction.selectionAnchor ?? target
      }
    }
    if (extend) {
      const anchorIndex = interaction.selectionAnchor === null
        ? -1
        : rows.findIndex((entry) => entry.path === interaction.selectionAnchor)
      if (anchorIndex >= 0) {
        const low = Math.min(anchorIndex, targetIndex)
        const high = Math.max(anchorIndex, targetIndex)
        return {
          selectedPaths: rows.slice(low, high + 1).map((entry) => entry.path),
          focusedPath: target,
          selectionAnchor: interaction.selectionAnchor
        }
      }
    }
    return { selectedPaths: [target], focusedPath: target, selectionAnchor: target }
  }

  private async directoryEntries(
    worktreeId: string,
    worktreeRoot: string,
    directory: string,
    showDotfiles: boolean,
    showIgnored: boolean
  ): Promise<ExplorerEntry[]> {
    const key = `${worktreeId}\0${directory}`
    try {
      const entries = await this.entries(worktreeId, worktreeRoot, directory, showDotfiles, showIgnored)
      this.directoryCache.set(key, entries)
      return entries
    } catch (error) {
      const previous = this.directoryCache.get(key)
      if (previous === undefined) throw error
      return previous.map((entry) => ({ ...entry, error: error instanceof Error ? error.message : String(error) }))
    }
  }


  private async preferences(worktreeId: string, params: ExplorerParams): Promise<ExplorerResult> {
    const current = this.preferencesFor(worktreeId)
    if (params.showDotfiles !== undefined || params.displayRoot !== undefined) {
      const displayRoot = params.displayRoot === undefined ? current.displayRoot : params.displayRoot
      if (displayRoot !== null) await this.paths.path(worktreeId, displayRoot)
      this.store.run(
        `INSERT INTO editor_explorer_preferences(worktree_id, show_dotfiles, display_root)
         VALUES (?, ?, ?) ON CONFLICT(worktree_id) DO UPDATE SET
         show_dotfiles=excluded.show_dotfiles, display_root=excluded.display_root`,
        worktreeId,
        Number(params.showDotfiles ?? current.showDotfiles),
        displayRoot
      )
    }
    if (params.expanded !== undefined) {
      const expanded = new Set<string>()
      for (const path of params.expanded) {
        const authorized = await this.paths.path(worktreeId, path)
        const info = await stat(authorized.path)
        if (info.isDirectory()) expanded.add(normalizeRelativePath(authorized.relativePath))
      }
      this.expanded.set(worktreeId, expanded)
    }
    const worktree = await this.paths.forId(worktreeId)
    const pref = this.preferencesFor(worktreeId)
    const root = pref.displayRoot === null ? worktree.path : (await this.paths.path(worktreeId, pref.displayRoot)).path
    return this.result(root, [], worktreeId)
  }

  private async reveal(worktreeId: string, requestedPath: string): Promise<ExplorerResult> {
    const target = await this.paths.path(worktreeId, requestedPath)
    let info
    try {
      info = await stat(target.path)
    } catch (error) {
      throw this.context.error('not-found', error instanceof Error ? error.message : String(error))
    }
    const root = await this.paths.forId(worktreeId)
    const parts = target.relativePath === '.' ? [] : target.relativePath.split(sep)
    const expanded = this.expanded.get(worktreeId) ?? new Set<string>()
    let cursor = root.path
    for (const part of (info.isDirectory() ? parts : parts.slice(0, -1))) {
      cursor = join(cursor, part)
      expanded.add(normalizeRelativePath(relative(root.path, cursor)))
    }
    this.expanded.set(worktreeId, expanded)
    const parentPath = info.isDirectory() ? target.path : dirname(target.path)
    const showIgnored = this.setting('showGitIgnoredFiles', true)
    const entries = await this.directoryEntries(worktreeId, root.path, parentPath, this.preferencesFor(worktreeId).showDotfiles, showIgnored)
    return this.result(parentPath, entries, worktreeId, showIgnored)
  }

  private async filter(worktreeId: string, root: string, params: ExplorerParams): Promise<ExplorerResult> {
    const query = params.query ?? ''
    const preferences = this.preferencesFor(worktreeId)
    if (Buffer.byteLength(query, 'utf8') > 2048) return this.result(root, [], worktreeId)
    const showIgnored = params.showIgnored ?? this.setting('showGitIgnoredFiles', true)
    const inventory = await this.inventory.list(root, showIgnored, this.setting('followSymlinkedDirectories', false))
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
    const matching = inventory.paths.filter((path) => {
      if (!preferences.showDotfiles && path.split('/').some((segment) => segment.startsWith('.') && segment.length > 1)) return false
      const lowered = path.toLowerCase()
      return terms.every((term) => lowered.includes(term))
    })
    const entries = matching.slice(0, 20_001).map((path) => ({
      path: join(root, path),
      name: basename(path),
      isDirectory: false,
      isSymlink: false
    }))
    return { ...this.result(root, entries, worktreeId, showIgnored), truncated: inventory.truncated || matching.length > 20_001 }
  }

  private async entries(worktreeId: string, worktreeRoot: string, directory: string, showDotfiles: boolean, showIgnored: boolean): Promise<ExplorerEntry[]> {
    const children = await readdir(directory, { withFileTypes: true })
    const candidates = children.filter((entry) => {
      if (ALWAYS_HIDDEN.has(entry.name)) return false
      return showDotfiles || !entry.name.startsWith('.') || entry.name === '.'
    })
    const relativePaths = candidates.map((entry) => relative(worktreeRoot, join(directory, entry.name)).split(sep).join('/'))
    const ignored = await ignoredPaths(worktreeRoot, relativePaths)
    const entries: ExplorerEntry[] = []
    for (const entry of candidates) {
      const absolute = join(directory, entry.name)
      const relativePath = relative(worktreeRoot, absolute)
      const ignoredEntry = ignored.has(relativePath.split(sep).join('/'))
      if (ignoredEntry && !showIgnored) continue
      const link = entry.isSymbolicLink()
      let isDirectory = entry.isDirectory()
      let error: string | undefined
      if (link) {
        try {
          const target = await this.paths.path(worktreeId, absolute)
          const targetInfo = await stat(target.path)
          isDirectory = targetInfo.isDirectory()
          if (isDirectory && !this.setting('followSymlinkedDirectories', false)) error = 'Following linked directories is disabled.'
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause)
          error = message.includes('outside worktree')
            ? 'This link points outside the worktree.'
            : message.includes('does not exist') || message.includes('not-found')
              ? 'The symlink target does not exist.'
              : message
        }
      }
      entries.push({ path: absolute, name: entry.name, isDirectory, isSymlink: link, ...(ignoredEntry ? { ignored: true } : {}), ...(error === undefined ? {} : { error }) })
    }
    entries.sort((left, right) => Number(right.isDirectory) - Number(left.isDirectory) || collator.compare(left.name, right.name) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
    return entries
  }

  private result(root: string, entries: ExplorerEntry[], worktreeId: string, showIgnored?: boolean): ExplorerResult {
    return {
      root,
      entries,
      showDotfiles: this.preferencesFor(worktreeId).showDotfiles,
      showIgnored: showIgnored ?? this.setting('showGitIgnoredFiles', true),
      followSymlinkedDirectories: this.setting('followSymlinkedDirectories', false)
    }
  }

  private preferencesFor(worktreeId: string): { showDotfiles: boolean; displayRoot: string | null } {
    const row = this.store.get<PreferenceRow>(
      'SELECT show_dotfiles, display_root FROM editor_explorer_preferences WHERE worktree_id=?',
      worktreeId
    )
    return row === null ? { showDotfiles: true, displayRoot: null } : { showDotfiles: row.show_dotfiles !== 0, displayRoot: row.display_root }
  }

  private setting(name: string, fallback: boolean): boolean {
    const value = this.context.getSetting(name)
    return typeof value === 'boolean' ? value : fallback
  }
}

function normalizeRelativePath(path: string): string {
  return path.split(sep).join('/')
}

async function ignoredPaths(root: string, paths: string[]): Promise<Set<string>> {
  const ignored = new Set<string>()
  let chunk: string[] = []
  let bytes = 0
  const batches: string[][] = []
  for (const path of paths) {
    const size = Buffer.byteLength(path, 'utf8') + 1
    if (chunk.length > 0 && bytes + size > 1024 * 1024) {
      batches.push(chunk)
      chunk = []
      bytes = 0
    }
    chunk.push(path)
    bytes += size
  }
  if (chunk.length > 0) batches.push(chunk)
  for (const batch of batches) {
    const child = spawn('git', ['check-ignore', '-z', '--stdin'], { cwd: root, stdio: ['pipe', 'pipe', 'ignore'] })
    const { promise, resolve } = Promise.withResolvers<void>()
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (part: string) => { output += part })
    child.once('close', () => resolve())
    child.once('error', () => resolve())
    child.stdin.on('error', () => resolve())
    child.stdin.end(`${batch.join('\0')}\0`)
    await promise
    for (const path of output.split('\0').filter(Boolean)) ignored.add(path)
  }
  return ignored
}
