import { spawn } from 'node:child_process'
import { lstat, readdir, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import type { PluginCaller, PluginContext, PluginStore } from '@quirky/protocol'
import type { ExplorerEntry } from '../types'
import { FileInventory } from './inventory'
import { WorktreePaths } from './paths'

const ALWAYS_HIDDEN = new Set(['.git', 'node_modules'])
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

type ExplorerParams = {
  worktree?: string
  action: 'list' | 'refresh' | 'reveal' | 'filter' | 'preferences'
  path?: string
  query?: string
  showDotfiles?: boolean
  showIgnored?: boolean
  followSymlinkedDirectories?: boolean
  expanded?: string[]
  displayRoot?: string
}

export type ExplorerResult = {
  root: string
  entries: (ExplorerEntry & { isDirectory: boolean; isSymlink: boolean })[]
  truncated?: boolean
  showDotfiles: boolean
  showIgnored: boolean
  followSymlinkedDirectories: boolean
}

type PreferenceRow = { show_dotfiles: number; display_root: string | null }

export class ExplorerService {
  private readonly expanded = new Map<string, Set<string>>()
  private readonly directoryCache = new Map<string, ExplorerEntry[]>()

  constructor(
    private readonly context: PluginContext,
    private readonly store: PluginStore,
    private readonly paths: WorktreePaths,
    private readonly inventory: FileInventory
  ) {}

  async call(params: ExplorerParams, caller?: PluginCaller): Promise<ExplorerResult> {
    const worktree = await this.paths.resolve(params.worktree, caller)
    if (params.action === 'preferences') return this.preferences(worktree.id, params)
    if (params.action === 'refresh') this.inventory.invalidate(worktree.path)
    if (params.action === 'reveal' && params.path !== undefined) return this.reveal(worktree.id, params.path)
    if (params.action === 'filter') return this.filter(worktree.id, worktree.path, params)
    const preferences = this.preferencesFor(worktree.id)
    const requested = params.path ?? preferences.displayRoot ?? '.'
    const target = await this.paths.path(worktree.id, requested)
    const info = await stat(target.path)
    if (!info.isDirectory()) throw this.context.error('invalid-params', `Explorer path is not a directory: ${requested}`)
    const key = `${worktree.id}\0${target.path}`
    const showIgnored = params.showIgnored ?? this.setting('showGitIgnoredFiles', true)
    try {
      const entries = await this.entries(worktree.id, worktree.path, target.path, preferences.showDotfiles, showIgnored)
      this.directoryCache.set(key, entries)
      return this.result(target.path, entries, worktree.id, showIgnored)
    } catch (error) {
      const previous = this.directoryCache.get(key)
      if (previous === undefined) throw error
      const entries = previous.map((entry) => ({ ...entry, error: error instanceof Error ? error.message : String(error) }))
      return this.result(target.path, entries, worktree.id, showIgnored)
    }
  }

  snapshot(worktreeId: string): { worktreeId: string; showDotfiles: boolean; expanded: string[] } {
    const preference = this.preferencesFor(worktreeId)
    return { worktreeId, showDotfiles: preference.showDotfiles, expanded: [...(this.expanded.get(worktreeId) ?? [])] }
  }

  dispose(): void {
    this.expanded.clear()
    this.directoryCache.clear()
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
        if (info.isDirectory()) expanded.add(authorized.relativePath)
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
      expanded.add(relative(root.path, cursor))
    }
    this.expanded.set(worktreeId, expanded)
    const parentPath = info.isDirectory() ? target.path : dirname(target.path)
    const showIgnored = this.setting('showGitIgnoredFiles', true)
    const entries = await this.entries(worktreeId, root.path, parentPath, this.preferencesFor(worktreeId).showDotfiles, showIgnored)
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
