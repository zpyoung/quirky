import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { activeDocument } from './activeDocument'
import { useEditorState, worktreeFromLayout } from './editorState'
import { clearExplorerSearch, useExplorerSearchIntent } from './explorerIntent'
import { setEditorSetting, useEditorSettings } from './settings'
import { importFiles } from './transfers'

const WORKTREE_PATHS_MIME = 'application/x-quirky-worktree-paths'

type ExplorerEntry = { path: string; name: string; isDirectory: boolean; isSymlink: boolean; ignored?: boolean; error?: string }
type ExplorerListing = {
  root: string
  entries: ExplorerEntry[]
  truncated?: boolean
  showDotfiles: boolean
  showIgnored: boolean
  followSymlinkedDirectories: boolean
}
type Worktree = { id: string; path: string; name?: string }
type SearchMatch = { line: number; column: number; matchLength: number; lineContent: string; displayColumn?: number; displayMatchLength?: number }
type SearchFile = { path: string; relativePath: string; matches: SearchMatch[] }
type SearchResult = { files: SearchFile[]; totalMatches: number; truncated: boolean; error: string | null; loading: boolean; requestId?: string }
type GitStatusFile = { path: string; index: string; worktree: string }
type GitStatusResult = { files: GitStatusFile[] }
type TreeRow = { entry: ExplorerEntry; depth: number }
type InternalPaths = { worktreeId: string; paths: string[] }

function internalPaths(value: unknown): InternalPaths | null {
  if (typeof value !== 'object' || value === null || !('worktreeId' in value) || !('paths' in value)) return null
  const worktreeId = value.worktreeId
  const paths = value.paths
  if (typeof worktreeId !== 'string' || !Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string')) return null
  return { worktreeId, paths }
}

function basename(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function joinPath(parent: string, child: string): string {
  return parent === '.' ? child : `${parent}/${child}`
}
function topLevelPaths(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((parent) => parent !== path && path.startsWith(`${parent}/`)))
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path).replaceAll('#', '%23')}`
}

function escapedGlob(path: string): string {
  return path.replace(/[\\*?\[\]{}!,]/g, '\\$&')
}

function flattenEntries(entries: ExplorerEntry[], expanded: Set<string>, children: Map<string, ExplorerEntry[]>): TreeRow[] {
  const rows: TreeRow[] = []
  const visit = (items: ExplorerEntry[], depth: number) => {
    for (const entry of items) {
      rows.push({ entry, depth })
      if (entry.isDirectory && expanded.has(entry.path)) {
        const nested = children.get(entry.path)
        if (nested) visit(nested, depth + 1)
      }
    }
  }
  visit(entries, 0)
  return rows
}

function messageOf(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

/** Explorer, names filtering, contents search, and safe file operations for one worktree. */
export function ExplorerPanel({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const [layoutWorktree, setLayoutWorktree] = useState(() => worktreeFromLayout(context))
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const worktree = layoutWorktree ?? activeDocument()?.worktreeId ?? selectedWorktree
  const { state, refresh: refreshEditorState } = useEditorState(context, worktree ? { worktree } : undefined)
  const { settings, error: settingsError } = useEditorSettings(context)
  const intent = useExplorerSearchIntent()
  const [rootListing, setRootListing] = useState<ExplorerListing | null>(null)
  const [gitStatus, setGitStatus] = useState<Map<string, string>>(new Map())
  const [gitError, setGitError] = useState<string | null>(null)
  const [children, setChildren] = useState<Map<string, ExplorerEntry[]>>(new Map())
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const selectionAnchor = useRef<string | null>(null)
  const [filterResult, setFilterResult] = useState<ExplorerListing | null>(null)
  const [searchMode, setSearchMode] = useState<'names' | 'contents'>('names')
  const [query, setQuery] = useState('')
  const [includePattern, setIncludePattern] = useState('')
  const [excludePattern, setExcludePattern] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [searchResult, setSearchResult] = useState<SearchResult | null>(null)
  const [treeLoading, setTreeLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [newItemKind, setNewItemKind] = useState<'file' | 'folder' | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [itemBusy, setItemBusy] = useState(false)
  const searchRequest = useRef<string | undefined>(undefined)
  const searchSequence = useRef(0)
  const inlineOpenedAt = useRef(0)
  const inlineBlurTimer = useRef<number | undefined>(undefined)

  useEffect(() => context.onLayout(() => setLayoutWorktree(worktreeFromLayout(context))), [context])

  useEffect(() => {
    if (worktree) return
    let cancelled = false
    context.call('quirky.worktree/list', {}).then((value) => {
      if (cancelled) return
      const rows = value as Worktree[]
      setWorktrees(rows)
      if (rows.length === 1) setSelectedWorktree(rows[0]!.id)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(messageOf(reason))
    })
    return () => { cancelled = true }
  }, [context, worktree])

  useEffect(() => {
    if (!worktree) {
      setGitStatus(new Map())
      return
    }
    let cancelled = false
    context.call('quirky.git/status', { worktree }).then((value) => {
      if (cancelled) return
      const status = value as GitStatusResult
      const files = new Map<string, string>()
      for (const file of status.files) {
        const code = `${file.index.trim()}${file.worktree.trim()}`
        if (code !== '') files.set(file.path, code)
      }
      setGitStatus(files)
      setGitError(null)
    }).catch((reason: unknown) => {
      if (!cancelled) {
        setGitStatus(new Map())
        setGitError(messageOf(reason))
      }
    })
    return () => { cancelled = true }
  }, [context, worktree])


  const loadDirectory = useCallback(async (path?: string) => {
    if (!worktree) return
    setTreeLoading(true)
    try {
      const listing = await context.call('quirky.editor/explorer', {
        worktree,
        action: 'list',
        ...(path ? { path } : {})
      }) as ExplorerListing
      if (path) setChildren((current) => new Map(current).set(path, listing.entries))
      else setRootListing(listing)
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setTreeLoading(false)
    }
  }, [context, worktree])

  useEffect(() => {
    if (!worktree) {
      setRootListing(null)
      setChildren(new Map())
      return
    }
    setRootListing(null)
    setChildren(new Map())
    setSelectedPaths([])
    void loadDirectory()
  }, [loadDirectory, worktree])

  useEffect(() => {
    const paths = state?.explorer?.expanded
    if (paths) setExpanded(new Set(paths))
  }, [state?.explorer?.worktreeId])

  const rows = useMemo(() => {
    if (searchMode === 'names' && query.trim() !== '' && filterResult) return filterResult.entries.map((entry) => ({ entry, depth: 0 }))
    return flattenEntries(rootListing?.entries ?? [], expanded, children)
  }, [children, expanded, filterResult, query, rootListing, searchMode])
  useEffect(() => {
    report?.({
      mounted: true,
      worktreeId: worktree ?? null,
      queryLength: query.length,
      loading: treeLoading || searchResult?.loading === true,
      resultCount: searchMode === 'contents' ? searchResult?.totalMatches ?? 0 : rows.length,
      truncated: searchMode === 'contents'
        ? searchResult?.truncated ?? false
        : filterResult?.truncated ?? rootListing?.truncated ?? false,
      selectedCount: selectedPaths.length,
      expandedCount: expanded.size,
      error: error ?? settingsError ?? gitError ?? searchResult?.error ?? null
    })
  }, [report, worktree, searchMode, query, treeLoading, searchResult, rows.length, filterResult?.truncated, rootListing?.truncated, selectedPaths, expanded, error, settingsError, gitError])


  const runNameFilter = useCallback(async (text: string) => {
    if (!worktree) return
    if (text.trim() === '') {
      setFilterResult(null)
      return
    }
    try {
      const result = await context.call('quirky.editor/explorer', { worktree, action: 'filter', query: text }) as ExplorerListing
      setFilterResult(result)
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }, [context, worktree])

  const runContentsSearch = useCallback(async (text: string, include = includePattern, exclude = excludePattern) => {
    const attempt = ++searchSequence.current
    if (!worktree) return
    if (searchRequest.current) {
      void context.call('quirky.editor/search', { worktree, action: 'cancel', requestId: searchRequest.current }).catch(() => {})
      searchRequest.current = undefined
    }
    if (text.trim() === '') {
      setSearchResult(null)
      return
    }
    setSearchResult({ files: [], totalMatches: 0, truncated: false, error: null, loading: true })
    try {
      const result = await context.call('quirky.editor/search', {
        worktree,
        action: 'run',
        query: text,
        caseSensitive,
        wholeWord,
        useRegex,
        ...(include === '' ? {} : { includePattern: include }),
        ...(exclude === '' ? {} : { excludePattern: exclude }),
        maxResults: 2000
      }) as SearchResult
      if (attempt !== searchSequence.current) return
      searchRequest.current = result.requestId
      setSearchResult(result)
    } catch (reason) {
      if (attempt === searchSequence.current) setSearchResult({ files: [], totalMatches: 0, truncated: false, error: messageOf(reason), loading: false })
    }
  }, [caseSensitive, context, excludePattern, includePattern, useRegex, wholeWord, worktree])

  useEffect(() => {
    if (!intent || !worktree || intent.worktree !== worktree) return
    setSearchMode('contents')
    setQuery(intent.query)
    setFilterResult(null)
    void runContentsSearch(intent.query)
    clearExplorerSearch(intent.id)
  }, [intent?.id, intent?.query, intent?.worktree, runContentsSearch, worktree])

  useEffect(() => {
    if (searchMode !== 'names' || query.trim() === '') return
    const timer = window.setTimeout(() => void runNameFilter(query), 120)
    return () => window.clearTimeout(timer)
  }, [query, runNameFilter, searchMode])
  useEffect(() => () => {
    searchSequence.current += 1
    if (searchRequest.current && worktree) {
      void context.call('quirky.editor/search', { worktree, action: 'cancel', requestId: searchRequest.current }).catch(() => {})
      searchRequest.current = undefined
    }
    if (inlineBlurTimer.current !== undefined) window.clearTimeout(inlineBlurTimer.current)
  }, [context, worktree])

  const openFile = async (path: string, options: { preview?: boolean; pinned?: boolean; line?: number; column?: number; matchLength?: number } = {}) => {
    if (!worktree) return
    try {
      const opened = await context.call('quirky.editor/open', {
        worktree,
        path,
        focus: true,
        preview: options.preview ?? settings.previewTabs,
        ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
        ...(options.line === undefined ? {} : { line: options.line }),
        ...(options.column === undefined ? {} : { column: options.column })
      }) as { id: string }
      if (options.line !== undefined) {
        await context.call('quirky.editor/view', {
          bufferId: opened.id,
          action: 'reveal',
          patch: { line: options.line, column: options.column ?? 1, matchLength: options.matchLength ?? 0 }
        })
      }
      setError(null)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const toggleFolder = async (path: string) => {
    const next = new Set(expanded)
    if (next.has(path)) next.delete(path)
    else {
      next.add(path)
      if (!children.has(path)) await loadDirectory(path)
    }
    setExpanded(next)
  }

  const copyPaths = async (relative: boolean, paths = selectedPaths) => {
    if (!rootListing || paths.length === 0) return
    const root = rootListing.root.replace(/\/$/, '')
    const values = paths.map((path) => relative ? path : `${root}/${path}`)
    try {
      await navigator.clipboard.writeText(values.join('\n'))
      context.toast('Paths copied', `${values.length} path(s)`)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const renameSelected = async () => {
    if (!worktree || !renamePath || !renameValue.trim()) return
    try {
      await context.call('quirky.editor/mutate', { worktree, action: 'rename', path: renamePath, newPath: renameValue.trim() })
      setRenamePath(null)
      setRenameValue('')
      await loadDirectory()
      refreshEditorState()
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const startNewItem = (kind: 'file' | 'folder', directory = '.') => {
    inlineOpenedAt.current = Date.now()
    setNewItemKind(kind)
    setNewItemName(directory === '.' ? '' : `${directory}/`)
  }

  const commitNewItem = async () => {
    if (!worktree || !newItemKind || !newItemName.trim()) return
    const path = newItemName.trim()
    setItemBusy(true)
    try {
      if (newItemKind === 'file') {
        await context.call('quirky.editor/mutate', { worktree, action: 'createFile', path, content: '' })
        await context.call('quirky.editor/open', { worktree, path, preview: false, focus: true })
      } else {
        await context.call('quirky.editor/mutate', { worktree, action: 'createFolder', path })
      }
      setNewItemKind(null)
      setNewItemName('')
      await loadDirectory()
      refreshEditorState()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setItemBusy(false)
    }
  }

  const deleteSelected = async (paths = selectedPaths) => {
    if (!worktree || paths.length === 0) return
    const confirmed = await context.confirm({ title: `Delete ${paths.length} item(s)?`, body: 'Dirty files are saved before deletion. Undo is available for supported file operations.' })
    if (!confirmed) return
    setItemBusy(true)
    try {
      for (const path of paths) await context.call('quirky.editor/mutate', { worktree, action: 'delete', path, yes: true })
      setSelectedPaths((current) => current.filter((path) => !paths.includes(path)))
      await loadDirectory()
    } catch (reason) {
      setError(messageOf(reason))
    } finally {
      setItemBusy(false)
    }
  }

  const duplicatePath = async (path: string) => {
    if (!worktree) return
    try {
      const result = await context.call('quirky.editor/mutate', { worktree, action: 'duplicate', path }) as { path: string }
      await loadDirectory()
      await openFile(result.path, { preview: false, pinned: true })
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const openInTerminal = async (path: string, isDirectory: boolean) => {
    if (!worktree || !rootListing) return
    const directory = isDirectory ? path : path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
    const cwd = directory === '.' ? rootListing.root : `${rootListing.root.replace(/\/$/, '')}/${directory}`
    try {
      await context.call('quirky.terminal/newTab', { workspace: worktree, cwd })
    } catch (reason) {
      setError(messageOf(reason))
    }
  }
  const openMarkdownPreview = async (path: string) => {
    if (!worktree) return
    try {
      await context.call('quirky.editor/open', { worktree, path, mode: 'preview', preview: false, focus: true })
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const openSourceControl = async () => {
    try {
      await context.executeCommand('command:quirky.editor/source-control')
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const onRowClick = (event: ReactMouseEvent, path: string, isDirectory: boolean) => {
    const index = rows.findIndex((row) => row.entry.path === path)
    if (event.shiftKey && selectionAnchor.current) {
      const start = rows.findIndex((row) => row.entry.path === selectionAnchor.current)
      const low = Math.max(0, Math.min(start, index))
      const high = Math.max(start, index)
      setSelectedPaths(rows.slice(low, high + 1).map((row) => row.entry.path))
    } else if (event.metaKey || event.ctrlKey) {
      setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path])
      selectionAnchor.current = path
    } else {
      setSelectedPaths([path])
      selectionAnchor.current = path
    }
    if (isDirectory) void toggleFolder(path)
    else void openFile(path, { preview: settings.previewTabs })
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target instanceof HTMLInputElement) return
    const currentIndex = rows.findIndex((row) => row.entry.path === selectedPaths.at(-1))
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const next = Math.max(0, Math.min(rows.length - 1, currentIndex + (event.key === 'ArrowDown' ? 1 : -1)))
      const row = rows[next]
      if (row) setSelectedPaths([row.entry.path])
    } else if (event.key === 'Enter' || event.key === ' ') {
      const row = rows[currentIndex]
      if (!row) return
      event.preventDefault()
      if (row.entry.isDirectory) void toggleFolder(row.entry.path)
      else void openFile(row.entry.path, { preview: true })
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      void deleteSelected()
    } else if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      void context.call('quirky.editor/history', { worktree, action: event.shiftKey ? 'redo' : 'undo' }).then(() => loadDirectory()).catch((reason: unknown) => setError(messageOf(reason)))
    }
  }

  const toggleDotfiles = async () => {
    if (!worktree) return
    try {
      await context.call('quirky.editor/explorer', { worktree, action: 'preferences', showDotfiles: !(state?.explorer.showDotfiles ?? true) })
      refreshEditorState()
      await loadDirectory()
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const refreshExplorer = async () => {
    if (!worktree) return
    try {
      await context.call('quirky.editor/explorer', { worktree, action: 'refresh' })
      setChildren(new Map())
      await loadDirectory()
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const dropOnFolder = async (event: DragEvent<HTMLDivElement>, destination: string) => {
    event.preventDefault()
    event.stopPropagation()
    if (!worktree) return
    const custom = event.dataTransfer.getData(WORKTREE_PATHS_MIME)
    if (custom) {
      const payload = internalPaths(JSON.parse(custom))
      if (!payload || payload.worktreeId !== worktree) throw new Error('Dropped items must belong to this worktree.')
      for (const path of topLevelPaths(payload.paths)) {
        const newPath = joinPath(destination, basename(path))
        if (newPath === path) continue
        await context.call('quirky.editor/mutate', { worktree, action: 'move', path, newPath })
      }
      await refreshExplorer()
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) {
      const imported = await importFiles(context, worktree, destination || '.', files)
      for (const path of imported) await openFile(path, { preview: false, pinned: true })
      await refreshExplorer()
      return
    }
    const uris = event.dataTransfer.getData('text/uri-list')
    if (uris) {
      const paths = uris.split(/\r?\n/).filter((value) => value !== '' && !value.startsWith('#')).map((line) => {
        const url = new URL(line)
        if (url.protocol !== 'file:') throw new Error(`Unsupported dropped URL: ${line}`)
        return decodeURIComponent(url.pathname)
      })
      if (paths.length > 256) throw new Error('Import is limited to 256 files.')
      const metadataBytes = paths.reduce((total, path) => total + new TextEncoder().encode(path).byteLength, 0)
      if (metadataBytes > 256 * 1024) throw new Error('Dropped path names exceed the 256 KiB metadata limit.')
      const result = await context.call('quirky.editor/mutate', {
        worktree,
        action: 'import',
        path: destination || '.',
        sourcePaths: paths
      }) as { path?: string; paths?: string[] }
      const imported = result.paths ?? (result.path ? [result.path] : [])
      if (imported.length === 0) throw new Error('The dropped files could not be imported.')
      for (const path of imported) await openFile(path, { preview: false, pinned: true })
      await refreshExplorer()
    }
  }


  return (
    <section className="qe-explorer" aria-label="File Explorer">
      <header className="qe-explorer-toolbar">
        {worktrees.length > 1 && !layoutWorktree && (
          <select aria-label="Worktree" value={worktree ?? ''} onChange={(event) => setSelectedWorktree(event.currentTarget.value)}>
            {worktrees.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.path}</option>)}
          </select>
        )}
        <span className="qe-explorer-root" title={rootListing?.root ?? ''}>{rootListing?.root ?? 'Explorer'}</span>
        <button type="button" title="New File" onClick={() => startNewItem('file')}>New File</button>
        <button type="button" title="New Folder" onClick={() => startNewItem('folder')}>New Folder</button>
        <button type="button" title="Collapse All" onClick={() => setExpanded(new Set())}>Collapse All</button>
        <button type="button" title="Refresh Explorer" onClick={() => void refreshExplorer()}>↻</button>
        <button type="button" title="Undo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'undo' }).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))}>Undo</button>
        <button type="button" title="Redo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'redo' }).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))}>Redo</button>
        <button type="button" onClick={() => void openSourceControl()}>Source Control</button>
        <details className="qe-explorer-more-actions">
          <summary aria-label="More Explorer Actions">More</summary>
          <div className="qe-file-actions-menu">
            <label><input type="checkbox" checked={state?.explorer.showDotfiles ?? true} onChange={() => void toggleDotfiles()} />Show Dotfiles</label>
            <label><input type="checkbox" checked={settings.showGitIgnored} onChange={(event) => void setEditorSetting(context, 'showGitIgnoredFiles', event.currentTarget.checked).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))} />Show Git Ignored Files</label>
            <label><input type="checkbox" checked={settings.followSymlinkedDirectories} onChange={(event) => void setEditorSetting(context, 'followSymlinkedDirectories', event.currentTarget.checked).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))} />Follow symlinked directories</label>
            <label>Activity Bar Position
              <select value={settings.activityBarPosition} onChange={(event) => void setEditorSetting(context, 'activityBarPosition', event.currentTarget.value).catch((reason: unknown) => setError(messageOf(reason)))}>
                <option value="top">Top</option>
                <option value="side">Side</option>
              </select>
            </label>
            <label className="qe-range-setting">Explorer Sidebar Width
              <input type="range" min="220" max="900" step="10" value={settings.sidebarWidth} onChange={(event) => void setEditorSetting(context, 'editorSidebarWidth', Number(event.currentTarget.value)).catch((reason: unknown) => setError(messageOf(reason)))} />
              <span>{settings.sidebarWidth}px</span>
            </label>
          </div>
        </details>
      </header>
      <div className="qe-explorer-search-mode" role="group" aria-label="Explorer search mode">
        <button type="button" aria-pressed={searchMode === 'names'} onClick={() => setSearchMode('names')}>Names</button>
        <button type="button" aria-pressed={searchMode === 'contents'} onClick={() => setSearchMode('contents')}>Contents</button>
      </div>
      <div className="qe-explorer-query">
        <input aria-label={searchMode === 'names' ? 'Find files' : 'Search files'} placeholder={searchMode === 'names' ? 'Find files' : 'Search'} value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && searchMode === 'contents') void runContentsSearch(query) }} />
        {searchMode === 'contents' && <button type="button" onClick={() => void runContentsSearch(query)}>Search</button>}
      </div>
      {searchMode === 'contents' && (
        <div className="qe-content-search-options">
          <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.currentTarget.checked)} />Match Case</label>
          <label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} />Match Whole Word</label>
          <label><input type="checkbox" checked={useRegex} onChange={(event) => setUseRegex(event.currentTarget.checked)} />Use Regular Expression</label>
          <input aria-label="Files to include" placeholder="files to include (e.g. *.ts, src/**)" value={includePattern} onChange={(event) => setIncludePattern(event.currentTarget.value)} />
          <input aria-label="Files to exclude" placeholder="files to exclude (e.g. *.min.js, dist/**)" value={excludePattern} onChange={(event) => setExcludePattern(event.currentTarget.value)} />
        </div>
      )}
      {error && <p className="qe-editor-error" role="alert">{error}</p>}
      {settingsError && <p className="qe-editor-error" role="alert">{settingsError}</p>}
      {treeLoading && <p className="muted" role="status">Loading files…</p>}
      {gitError && <p className="muted" role="status">Git status unavailable: {gitError}</p>}
      {searchMode === 'names' ? (
        <div
          className="qe-explorer-tree"
          role="tree"
          tabIndex={0}
          onKeyDown={onTreeKeyDown}
          onDragOver={(event) => {
            const types = event.dataTransfer.types
            if (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list')) event.preventDefault()
          }}
          onDrop={(event) => { event.preventDefault(); void dropOnFolder(event, '.').catch((reason: unknown) => setError(messageOf(reason))) }}
        >
          {rows.map(({ entry, depth }) => (
            <div
              key={entry.path}
              className={`qe-explorer-row${selectedPaths.includes(entry.path) ? ' selected' : ''}${entry.ignored ? ' ignored' : ''}`}
              role="treeitem"
              aria-expanded={entry.isDirectory ? expanded.has(entry.path) : undefined}
              aria-selected={selectedPaths.includes(entry.path)}
              data-path={entry.path}
              style={{ paddingLeft: `${8 + depth * 16}px` }}
              draggable
              onClick={(event) => onRowClick(event, entry.path, entry.isDirectory)}
              onDoubleClick={() => !entry.isDirectory && void openFile(entry.path, { preview: false, pinned: true })}
              onDragStart={(event) => {
                const paths = topLevelPaths(selectedPaths.includes(entry.path) ? selectedPaths : [entry.path])
                event.dataTransfer.setData(WORKTREE_PATHS_MIME, JSON.stringify({ worktreeId: state?.explorer.worktreeId ?? worktree, paths }))
                const root = rootListing?.root.replace(/\/$/, '') ?? ''
                event.dataTransfer.setData('text/uri-list', paths.map((path) => fileUrl(`${root}/${path}`)).join('\r\n'))
                event.dataTransfer.effectAllowed = 'copyMove'
              }}
              onDragOver={(event) => {
                const types = event.dataTransfer.types
                if (entry.isDirectory && (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list'))) event.preventDefault()
              }}
              onDrop={(event) => { if (entry.isDirectory) void dropOnFolder(event, entry.path).catch((reason: unknown) => setError(messageOf(reason))) }}
            >
              <span className="qe-explorer-chevron">{entry.isDirectory ? (expanded.has(entry.path) ? '▾' : '▸') : ''}</span>
              <span className="qe-explorer-name">{entry.name}</span>
              {gitStatus.has(entry.path) && <span className="qe-git-status" aria-label={`Git status ${gitStatus.get(entry.path)}`}>{gitStatus.get(entry.path)}</span>}
              {entry.isSymlink && <span title="Symbolic link">↗</span>}
              {entry.ignored && <span aria-label="Ignored by .gitignore">⊘</span>}
              {entry.error && <span className="qe-explorer-row-error" title={entry.error}>!</span>}
              <details className="qe-explorer-row-actions" onClick={(event) => { event.stopPropagation(); if (!selectedPaths.includes(entry.path)) setSelectedPaths([entry.path]) }}>
                <summary aria-label={`Actions for ${entry.name}`}>⋯</summary>
                <div className="qe-file-actions-menu">
                  <button type="button" onClick={() => startNewItem('file', entry.isDirectory ? entry.path : '.')} >New File</button>
                  <button type="button" onClick={() => startNewItem('folder', entry.isDirectory ? entry.path : '.')}>New Folder</button>
                  <button type="button" onClick={() => void copyPaths(false, [entry.path])}>Copy Path</button>
                  <button type="button" onClick={() => void copyPaths(true, [entry.path])}>Copy Relative Path</button>
                  {!entry.isDirectory && <button type="button" onClick={() => void duplicatePath(entry.path)}>Duplicate</button>}
                  <button type="button" onClick={() => { setRenamePath(entry.path); setRenameValue(entry.path) }}>Rename</button>
                  <button type="button" onClick={() => void deleteSelected([entry.path])}>Delete</button>
                  {entry.isDirectory && <button type="button" onClick={() => void openInTerminal(entry.path, true)}>Open in Terminal</button>}
                  {entry.isDirectory && <button type="button" onClick={() => { setSearchMode('contents'); setIncludePattern(`${escapedGlob(entry.path)}/**`) }}>Find in Folder</button>}
                  {!entry.isDirectory && entry.name.toLowerCase().endsWith('.md') && <button type="button" onClick={() => void openMarkdownPreview(entry.path)}>Open Markdown Preview</button>}
                </div>
              </details>
            </div>
          ))}
          {newItemKind && (
            <div className="qe-explorer-inline-row">
              <input autoFocus aria-label={newItemKind === 'file' ? 'New file name' : 'New folder name'} value={newItemName} onChange={(event) => setNewItemName(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void commitNewItem() }
                if (event.key === 'Escape') { setNewItemKind(null); setNewItemName('') }
              }} onBlur={() => {
                if (Date.now() - inlineOpenedAt.current < 200) return
                if (inlineBlurTimer.current !== undefined) window.clearTimeout(inlineBlurTimer.current)
                inlineBlurTimer.current = window.setTimeout(() => void commitNewItem(), 150)
              }} />
              <button type="button" disabled={itemBusy} onClick={() => void commitNewItem()}>Create</button>
              <button type="button" onClick={() => { setNewItemKind(null); setNewItemName('') }}>Cancel</button>
            </div>
          )}
          {renamePath !== null && (
            <div className="qe-explorer-inline-row">
              <input autoFocus aria-label="Rename file" value={renameValue} onChange={(event) => setRenameValue(event.currentTarget.value)} onKeyDown={(event) => {
                if (event.key === 'Enter') { event.preventDefault(); void renameSelected() }
                if (event.key === 'Escape') setRenamePath(null)
              }} />
              <button type="button" onClick={() => void renameSelected()}>Rename</button>
              <button type="button" onClick={() => setRenamePath(null)}>Cancel</button>
            </div>
          )}
          {filterResult?.truncated && <p className="muted">More matches may be available.</p>}
        </div>
      ) : (
        <div className="qe-explorer-content-results">
          {!query.trim() && <p className="muted">Type to search in files</p>}
          {query.trim() && !searchResult && <p className="muted">Press Enter to search</p>}
          {searchResult?.loading && <p className="muted" role="status">Searching files…</p>}
          {searchResult?.error && <p className="qe-editor-error" role="alert">{searchResult.error}</p>}
          {searchResult && !searchResult.error && <p>{searchResult.totalMatches} result(s) in {searchResult.files.length} file(s){searchResult.truncated ? ' (results truncated)' : ''}</p>}
          {searchResult?.files.map((file) => (
            <section className="qe-search-file" key={file.path}>
              <h4>{file.relativePath}</h4>
              {file.matches.map((match, index) => {
                const start = (match.displayColumn ?? match.column) - 1
                const end = start + (match.displayMatchLength ?? match.matchLength)
                return (
                  <button key={`${match.line}:${match.column}:${index}`} type="button" onClick={() => void openFile(file.path, { preview: false, pinned: true, line: match.line, column: match.column, matchLength: match.matchLength })}>
                    <span>{match.line}:{match.column}</span>
                    <code>{match.lineContent.slice(0, start)}<mark>{match.lineContent.slice(start, end)}</mark>{match.lineContent.slice(end)}</code>
                  </button>
                )
              })}
            </section>
          ))}
        </div>
      )}
      <footer className="qe-explorer-footer">
        <button type="button" onClick={() => void copyPaths(false)}>Copy Path</button>
        <button type="button" onClick={() => void copyPaths(true)}>Copy Relative Path</button>
        <button type="button" onClick={() => void deleteSelected()}>Delete</button>
        <button type="button" onClick={() => { setSearchMode('contents'); setQuery(''); setIncludePattern('') }}>Search in Files</button>
      </footer>
      {rootListing?.truncated && <p className="muted">More files may be available.</p>}
      {state?.explorer.expanded.length === 0 && expanded.size > 0 && <span className="sr-only">Expanded folders are open.</span>}
    </section>
  )
}