import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import { Button, IconButton, ListRow, Menu, TextField } from '@quirky/ui'
import type { ExplorerInteraction } from '../types'
import { activeDocument } from './activeDocument'
import { useEditorState, worktreeFromLayout } from './editorState'
import { clearExplorerSearch, useExplorerSearchIntent } from './explorerIntent'
import { setEditorSetting, useEditorSettings } from './settings'
import { importFiles } from './transfers'

const MAX_EXPLORER_CHILD_LISTINGS = 20_001
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
type ExplorerInteractionResult = ExplorerListing & { expanded?: string[]; interaction?: ExplorerInteraction }
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

function dirname(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

function joinPath(parent: string, child: string): string {
  return parent === '.' ? child : `${parent}/${child}`
}
function explorerSeparator(root: string): string {
  return root.includes('\\') && !root.includes('/') ? '\\' : '/'
}

function absoluteExplorerPath(root: string, relativePath: string): string {
  if (relativePath === '' || relativePath === '.') return root
  const separator = explorerSeparator(root)
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${separator}`
  return `${prefix}${relativePath.split('/').join(separator)}`
}

function relativeExplorerPath(root: string, absolutePath: string): string | null {
  if (absolutePath === root) return '.'
  const separator = explorerSeparator(root)
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}${separator}`
  return absolutePath.startsWith(prefix) ? absolutePath.slice(prefix.length).replaceAll('\\', '/') : null
}

function topLevelPaths(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((parent) => parent !== path && path.startsWith(`${parent}/`)))
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path).replaceAll('#', '%23').replaceAll('?', '%3F')}`
}

function escapedGlob(path: string): string {
  return path.replace(/[\\*?\[\]{}!,]/g, '\\$&')
}

function flattenEntries(entries: ExplorerEntry[], expanded: Set<string>, children: Map<string, ExplorerEntry[]>): TreeRow[] {
  const rows: TreeRow[] = []
  const directories: { entries: ExplorerEntry[]; index: number; depth: number }[] = [{ entries, index: 0, depth: 0 }]
  while (directories.length > 0 && rows.length < MAX_EXPLORER_CHILD_LISTINGS) {
    const current = directories[directories.length - 1]!
    if (current.index >= current.entries.length) {
      directories.pop()
      continue
    }
    const entry = current.entries[current.index++]!
    rows.push({ entry, depth: current.depth })
    if (entry.isDirectory && expanded.has(entry.path)) {
      const nested = children.get(entry.path)
      if (nested !== undefined && nested.length > 0) directories.push({ entries: nested, index: 0, depth: current.depth + 1 })
    }
  }
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
  const currentWorktree = useRef(worktree)
  currentWorktree.current = worktree
  const { state, refresh: refreshEditorState } = useEditorState(context, worktree ? { worktree } : undefined)
  const { settings, error: settingsError } = useEditorSettings(context)
  const intent = useExplorerSearchIntent()
  const [rootListing, setRootListing] = useState<ExplorerListing | null>(null)
  const [gitStatus, setGitStatus] = useState<Map<string, string>>(new Map())
  const [gitError, setGitError] = useState<string | null>(null)
  const [children, setChildren] = useState<Map<string, ExplorerEntry[]>>(new Map())
  const childrenRef = useRef<Map<string, ExplorerEntry[]>>(new Map())
  const directoryLoads = useRef(new Map<string, Promise<void>>())
  const treeLoadGeneration = useRef(0)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const selectedPathsRef = useRef<string[]>([])
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const focusedPathRef = useRef<string | null>(null)
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null)
  const [resolvedWorktreeId, setResolvedWorktreeId] = useState<string | null>(null)
  const worktreeRootRef = useRef<string | null>(null)
  const worktreeRootSelectorRef = useRef<string | null>(null)
  const interactionQueue = useRef(Promise.resolve())
  const treeRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
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
  useEffect(() => {
    if (renamePath === null || renameInputRef.current === null) return
    const name = basename(renamePath)
    const extension = name.lastIndexOf('.')
    const isDirectory = entryForPath(renamePath)?.isDirectory ?? false
    const selectionEnd = !isDirectory && extension > 0 ? extension : name.length
    renameInputRef.current.setSelectionRange(0, selectionEnd)
  }, [renamePath])
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


  useEffect(() => {
    if (!worktree) {
      setWorktreeRoot(null)
      setResolvedWorktreeId(null)
      return
    }
    let cancelled = false
    context.call('quirky.editor/documentRoot', { worktree }).then((value) => {
      if (cancelled) return
      const resolved = value as { id?: unknown; path?: unknown }
      if (typeof resolved.id !== 'string' || typeof resolved.path !== 'string') {
        setError('The selected worktree could not be resolved.')
        return
      }
      worktreeRootRef.current = resolved.path
      worktreeRootSelectorRef.current = worktree
      setResolvedWorktreeId(resolved.id)
      setWorktreeRoot(resolved.path)
    }).catch((reason: unknown) => {
      if (!cancelled && currentWorktree.current === worktree) setError(messageOf(reason))
    })
    return () => { cancelled = true }
  }, [context, worktree])
  const loadDirectory = useCallback(async (path?: string) => {
    if (!worktree) return
    const requestedWorktree = worktree
    const generation = treeLoadGeneration.current
    const key = `${requestedWorktree}\0${path ?? ''}`
    const existing = directoryLoads.current.get(key)
    if (existing !== undefined) return await existing
    const request = (async () => {
      setTreeLoading(true)
      try {
        const listing = await context.call('quirky.editor/explorer', {
          worktree: requestedWorktree,
          action: 'list',
          ...(path ? { path } : {})
        }) as ExplorerListing
        if (generation !== treeLoadGeneration.current || currentWorktree.current !== requestedWorktree) return
        if (path) {
          const next = new Map(childrenRef.current).set(path, listing.entries)
          childrenRef.current = next
          setChildren(next)
        } else {
          setRootListing(listing)
        }
        if (!path) setError(null)
      } catch (reason) {
        if (generation === treeLoadGeneration.current && currentWorktree.current === requestedWorktree) setError(messageOf(reason))
      } finally {
        if (generation === treeLoadGeneration.current && currentWorktree.current === requestedWorktree) setTreeLoading(false)
      }
    })()
    directoryLoads.current.set(key, request)
    try {
      await request
    } finally {
      if (directoryLoads.current.get(key) === request) directoryLoads.current.delete(key)
    }
  }, [context, worktree])
  const reloadExpandedDirectories = async () => {
    let count = 0
    for (const path of expandedRef.current) {
      if (count >= MAX_EXPLORER_CHILD_LISTINGS) break
      count++
      await loadDirectory(path)
    }
  }


  useEffect(() => {
    treeLoadGeneration.current++
    setTreeLoading(false)
    directoryLoads.current.clear()
    childrenRef.current = new Map()
    expandedRef.current = new Set()
    setExpanded(new Set())
    selectedPathsRef.current = []
    setSelectedPaths([])
    focusedPathRef.current = null
    setFocusedPath(null)
    setResolvedWorktreeId(null)
    setWorktreeRoot(null)
    if (!worktree) {
      setRootListing(null)
      setChildren(new Map())
      return
    }
    setRootListing(null)
    setChildren(new Map())
    void loadDirectory()
  }, [loadDirectory, worktree])

  useEffect(() => {
    const explorer = state?.explorer
    if (explorer === undefined || explorer.worktreeId !== resolvedWorktreeId) return
    const selected = explorer.selectedPaths ?? []
    selectedPathsRef.current = selected
    setSelectedPaths(selected)
    focusedPathRef.current = explorer.focusedPath ?? null
    setFocusedPath(explorer.focusedPath ?? null)
  }, [resolvedWorktreeId, state?.explorer?.focusedPath, state?.explorer?.selectedPaths, state?.explorer?.worktreeId])

  useEffect(() => {
    const explorer = state?.explorer
    if (explorer === undefined || explorer.worktreeId !== resolvedWorktreeId || worktreeRoot === null || rootListing === null) return
    const next = new Set(explorer.expanded.map((path) => absoluteExplorerPath(worktreeRoot, path)))
    expandedRef.current = next
    setExpanded(next)
    let loaded = 0
    for (const path of next) {
      if (childrenRef.current.has(path)) continue
      if (loaded >= MAX_EXPLORER_CHILD_LISTINGS) break
      loaded++
      void loadDirectory(path)
    }
  }, [loadDirectory, resolvedWorktreeId, rootListing, state?.explorer?.expanded, state?.explorer?.worktreeId, worktreeRoot])

  const rows = useMemo(() => {
    if (searchMode === 'names' && query.trim() !== '' && filterResult) return filterResult.entries.map((entry) => ({ entry, depth: 0 }))
    return flattenEntries(rootListing?.entries ?? [], expanded, children)
  }, [children, expanded, filterResult, query, rootListing, searchMode])
  const entryForPath = (path: string | null): ExplorerEntry | undefined => {
    if (path === null) return undefined
    if (searchMode === 'names' && query.trim() !== '') return filterResult?.entries.find((entry) => entry.path === path)
    const visible = rows.find((row) => row.entry.path === path)
    if (visible !== undefined) return visible.entry
    if (worktreeRoot === null) return undefined
    const relative = relativeExplorerPath(worktreeRoot, path)
    if (relative === null) return undefined
    const parts = relative.split('/')
    let parent = '.'
    for (let index = 0; index < parts.length - 1; index++) {
      parent = joinPath(parent, parts[index]!)
      if (!expandedRef.current.has(absoluteExplorerPath(worktreeRoot, parent))) return undefined
    }
    for (const entries of childrenRef.current.values()) {
      const entry = entries.find((candidate) => candidate.path === path)
      if (entry !== undefined) return entry
    }
    return rootListing?.entries.find((entry) => entry.path === path)
  }


  useEffect(() => {
    if (focusedPath === null || treeRef.current === null) return
    for (const row of treeRef.current.querySelectorAll<HTMLElement>('[data-path]')) {
      if (row.dataset.path !== focusedPath) continue
      row.scrollIntoView({ block: 'nearest' })
      break
    }
  }, [focusedPath, rows])

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

  const resolveWorktreeRoot = useCallback(async (requestedWorktree: string): Promise<string | null> => {
    if (worktreeRootSelectorRef.current === requestedWorktree && worktreeRootRef.current !== null) return worktreeRootRef.current
    const value = await context.call('quirky.editor/documentRoot', { worktree: requestedWorktree })
    if (currentWorktree.current !== requestedWorktree) return null
    const resolved = value as { id?: unknown; path?: unknown }
    if (typeof resolved.id !== 'string' || typeof resolved.path !== 'string') throw new Error('The selected worktree could not be resolved.')
    worktreeRootRef.current = resolved.path
    worktreeRootSelectorRef.current = requestedWorktree
    setResolvedWorktreeId(resolved.id)
    setWorktreeRoot(resolved.path)
    return resolved.path
  }, [context])

  const applyExplorerInteraction = useCallback(async (
    requestedWorktree: string,
    params: Record<string, unknown>
  ): Promise<ExplorerInteractionResult> => {
    const result = await context.call('quirky.editor/explorer', { worktree: requestedWorktree, ...params }) as ExplorerInteractionResult
    if (currentWorktree.current !== requestedWorktree) return result
    setError(null)
    if (result.interaction !== undefined) {
      selectedPathsRef.current = result.interaction.selectedPaths
      setSelectedPaths(result.interaction.selectedPaths)
      focusedPathRef.current = result.interaction.focusedPath
      setFocusedPath(result.interaction.focusedPath)
    }
    if (result.expanded !== undefined) {
      const root = await resolveWorktreeRoot(requestedWorktree)
      if (root !== null) {
        const previous = expandedRef.current
        const next = new Set(result.expanded.map((path) => absoluteExplorerPath(root, path)))
        expandedRef.current = next
        setExpanded(next)
        let loaded = 0
        for (const path of next) {
          if (previous.has(path) || childrenRef.current.has(path)) continue
          if (loaded >= MAX_EXPLORER_CHILD_LISTINGS) break
          loaded++
          await loadDirectory(path)
        }
      }
    }
    return result
  }, [context, loadDirectory, resolveWorktreeRoot])

  const enqueueInteraction = useCallback((params: Record<string, unknown>) => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return null
      return await applyExplorerInteraction(requestedWorktree, params)
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    return request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
      return null
    })
  }, [applyExplorerInteraction, worktree])

  const activateDirectory = useCallback((path: string, queryParams: Record<string, unknown> = {}) => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return null
      const selection = await applyExplorerInteraction(requestedWorktree, { action: 'select', path, ...queryParams })
      if (selection.expanded === undefined) return selection
      const root = await resolveWorktreeRoot(requestedWorktree)
      if (root === null) return selection
      const relativePath = relativeExplorerPath(root, path)
      if (relativePath === null) return selection
      const key = selection.expanded.includes(relativePath) ? 'ArrowLeft' : 'ArrowRight'
      return await applyExplorerInteraction(requestedWorktree, { action: 'navigate', key, ...queryParams })
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    return request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
      return null
    })
  }, [applyExplorerInteraction, resolveWorktreeRoot, worktree])

  const collapseAll = useCallback(() => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return
      await context.call('quirky.editor/explorer', { worktree: requestedWorktree, action: 'preferences', expanded: [] })
      if (currentWorktree.current !== requestedWorktree) return
      expandedRef.current = new Set()
      setExpanded(expandedRef.current)
      refreshEditorState()
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    void request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
    })
  }, [context, refreshEditorState, worktree])
  const startRename = (path: string) => {
    setRenamePath(path)
    setRenameValue(basename(path))
  }

  const renameFocused = () => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(() => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return
      const path = focusedPathRef.current
      if (path === null || entryForPath(path) === undefined) return
      startRename(path)
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    void request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
    })
  }

  const activateFocused = (queryParams: Record<string, unknown>) => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return
      const path = focusedPathRef.current
      const entry = entryForPath(path)
      if (path === null || entry === undefined) return
      if (entry.isDirectory) {
        const key = expandedRef.current.has(path) ? 'ArrowLeft' : 'ArrowRight'
        await applyExplorerInteraction(requestedWorktree, { action: 'navigate', key, ...queryParams })
      } else {
        await openFile(path, { preview: true })
      }
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    void request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
    })
  }


  const copyPaths = async (relative: boolean, paths = selectedPaths) => {
    if (paths.length === 0) return
    try {
      let values = paths
      if (relative) {
        if (!worktree) return
        const root = await resolveWorktreeRoot(worktree)
        if (root === null) return
        values = paths.map((path) => {
          const value = relativeExplorerPath(root, path)
          if (value === null) throw new Error('The selected path is outside this worktree.')
          return value
        })
      }
      await navigator.clipboard.writeText(values.join('\n'))
      context.toast('Paths copied', `${values.length} path(s)`)
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const renameSelected = async () => {
    if (!worktree || !renamePath || !renameValue.trim()) return
    try {
      await context.call('quirky.editor/mutate', {
        worktree,
        action: 'rename',
        path: renamePath,
        newPath: joinPath(dirname(renamePath), renameValue)
      })
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
      await enqueueInteraction({ action: 'reveal', path })
      await enqueueInteraction({ action: 'select', path })
      await loadDirectory()
      await reloadExpandedDirectories()
      setNewItemKind(null)
      setNewItemName('')
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

  const openInTerminal = async (path: string) => {
    if (!worktree) return
    try {
      await context.call('quirky.terminal/newTab', { workspace: worktree, cwd: path })
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
    const queryParams = searchMode === 'names' && query.trim() !== '' ? { query } : {}
    const params = {
      action: 'select',
      path,
      ...(event.shiftKey ? { extend: true } : {}),
      ...(event.metaKey || event.ctrlKey ? { toggle: true } : {}),
      ...queryParams
    }
    treeRef.current?.focus()
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      void enqueueInteraction(params)
      return
    }
    if (isDirectory) {
      void activateDirectory(path, queryParams)
      return
    }
    void enqueueInteraction(params).then((result) => {
      if (result !== null) void openFile(path, { preview: settings.previewTabs })
    })
  }

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target
    const interactiveTarget = target instanceof HTMLElement &&
      target.closest('input, textarea, select, button, summary, a, [contenteditable]')
    if (event.nativeEvent.isComposing || event.keyCode === 229 ||
      interactiveTarget || newItemKind !== null || renamePath !== null) return
    const queryParams = searchMode === 'names' && query.trim() !== '' ? { query } : {}
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) {
      if (event.metaKey || event.ctrlKey || event.altKey) return
      event.preventDefault()
      void enqueueInteraction({
        action: 'navigate',
        key: event.key,
        ...(event.shiftKey ? { extend: true } : {}),
        ...queryParams
      })
      return
    }
    const unmodified = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    if (event.key === 'Enter' && unmodified) {
      event.preventDefault()
      renameFocused()
    } else if (event.key === ' ' && unmodified) {
      event.preventDefault()
      activateFocused(queryParams)
    } else if (event.key === 'Delete' || (event.key === 'Backspace' && (event.metaKey || event.ctrlKey))) {
      event.preventDefault()
      void deleteSelected()
    } else if (event.key.toLowerCase() === 'z' && (event.metaKey || event.ctrlKey) && !event.altKey) {
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
      await reloadExpandedDirectories()
    } catch (reason) {
      setError(messageOf(reason))
    }
  }

  const refreshExplorer = async () => {
    if (!worktree) return
    try {
      await context.call('quirky.editor/explorer', { worktree, action: 'refresh' })
      await loadDirectory()
      await reloadExpandedDirectories()
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
          <select className="ui-text-field__input qe-explorer-worktree" aria-label="Worktree" value={worktree ?? ''} onChange={(event) => setSelectedWorktree(event.currentTarget.value)}>
            {worktrees.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.path}</option>)}
          </select>
        )}
        <span className="qe-explorer-root" title={rootListing?.root ?? ''}>{rootListing?.root ?? 'Explorer'}</span>
        <Button title="New File" onClick={() => startNewItem('file')}>New File</Button>
        <Button title="New Folder" onClick={() => startNewItem('folder')}>New Folder</Button>
        <Button title="Collapse All" onClick={() => void collapseAll()}>Collapse All</Button>
        <IconButton label="Refresh Explorer" title="Refresh Explorer" onClick={() => void refreshExplorer()}>↻</IconButton>
        <Button title="Undo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'undo' }).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))}>Undo</Button>
        <Button title="Redo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'redo' }).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))}>Redo</Button>
        <Button onClick={() => void openSourceControl()}>Source Control</Button>
        <details className="qe-explorer-more-actions">
          <summary className="qe-disclosure-trigger" aria-label="More Explorer Actions">More</summary>
          <div className="qe-file-actions-menu">
            <label><input type="checkbox" checked={state?.explorer.showDotfiles ?? true} onChange={() => void toggleDotfiles()} />Show Dotfiles</label>
            <label><input type="checkbox" checked={settings.showGitIgnored} onChange={(event) => void setEditorSetting(context, 'showGitIgnoredFiles', event.currentTarget.checked).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))} />Show Git Ignored Files</label>
            <label><input type="checkbox" checked={settings.followSymlinkedDirectories} onChange={(event) => void setEditorSetting(context, 'followSymlinkedDirectories', event.currentTarget.checked).then(refreshExplorer).catch((reason: unknown) => setError(messageOf(reason)))} />Follow symlinked directories</label>
            <label className="qe-range-setting">Explorer Sidebar Width
              <input type="range" min="220" max="900" step="10" value={settings.sidebarWidth} onChange={(event) => void setEditorSetting(context, 'editorSidebarWidth', Number(event.currentTarget.value)).catch((reason: unknown) => setError(messageOf(reason)))} />
              <span>{settings.sidebarWidth}px</span>
            </label>
          </div>
        </details>
      </header>
      <div className="qe-explorer-search-mode" role="group" aria-label="Explorer search mode">
        <Button aria-pressed={searchMode === 'names'} onClick={() => setSearchMode('names')}>Names</Button>
        <Button aria-pressed={searchMode === 'contents'} onClick={() => setSearchMode('contents')}>Contents</Button>
      </div>
      <div className="qe-explorer-query">
        <TextField
          ref={searchInputRef}
          className="qe-explorer-search-field"
          label={searchMode === 'names' ? 'Find files' : 'Search files'}
          placeholder={searchMode === 'names' ? 'Find files' : 'Search'}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && searchMode === 'contents') void runContentsSearch(query) }}
        />
        {searchMode === 'contents' && <Button variant="primary" onClick={() => void runContentsSearch(query)}>Search</Button>}
      </div>
      {searchMode === 'contents' && (
        <div className="qe-content-search-options">
          <label><input type="checkbox" checked={caseSensitive} onChange={(event) => setCaseSensitive(event.currentTarget.checked)} />Match Case</label>
          <label><input type="checkbox" checked={wholeWord} onChange={(event) => setWholeWord(event.currentTarget.checked)} />Match Whole Word</label>
          <label><input type="checkbox" checked={useRegex} onChange={(event) => setUseRegex(event.currentTarget.checked)} />Use Regular Expression</label>
          <TextField label="Files to include" placeholder="files to include (e.g. *.ts, src/**)" value={includePattern} onChange={(event) => setIncludePattern(event.currentTarget.value)} />
          <TextField label="Files to exclude" placeholder="files to exclude (e.g. *.min.js, dist/**)" value={excludePattern} onChange={(event) => setExcludePattern(event.currentTarget.value)} />
        </div>
      )}
      {error && <p className="qe-editor-error" role="alert">{error}</p>}
      {settingsError && <p className="qe-editor-error" role="alert">{settingsError}</p>}
      {treeLoading && <p className="muted" role="status">Loading files…</p>}
      {gitError && <p className="muted" role="status">Git status unavailable: {gitError}</p>}
      {searchMode === 'names' ? (
        <div
          className="qe-explorer-tree"
          onDragOver={(event) => {
            const types = event.dataTransfer.types
            if (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list')) event.preventDefault()
          }}
          onDrop={(event) => { event.preventDefault(); void dropOnFolder(event, '.').catch((reason: unknown) => setError(messageOf(reason))) }}
        >
          <div
            className="qe-explorer-tree-content"
            role="tree"
            tabIndex={0}
            ref={treeRef}
            aria-activedescendant={focusedPath === null ? undefined : `qe-explorer-row-${encodeURIComponent(focusedPath)}`}
            onKeyDown={onTreeKeyDown}
          >
          {rows.map(({ entry, depth }) => (
            <div
              key={entry.path}
              id={`qe-explorer-row-${encodeURIComponent(entry.path)}`}
              className={`qe-explorer-row${selectedPaths.includes(entry.path) ? ' selected' : ''}${entry.ignored ? ' ignored' : ''}`}
              role="treeitem"
              aria-level={depth + 1}
              aria-expanded={entry.isDirectory ? expanded.has(entry.path) : undefined}
              aria-selected={selectedPaths.includes(entry.path)}
              data-path={entry.path}
              style={{ '--qe-tree-indent': `${depth}rem` } as CSSProperties}
              draggable
              onClick={(event) => onRowClick(event, entry.path, entry.isDirectory)}
              onContextMenu={() => {
                treeRef.current?.focus()
                if (!selectedPathsRef.current.includes(entry.path)) {
                  void enqueueInteraction({
                    action: 'select',
                    path: entry.path,
                    ...(searchMode === 'names' && query.trim() !== '' ? { query } : {})
                  })
                }
              }}
              onDoubleClick={() => !entry.isDirectory && void openFile(entry.path, { preview: false, pinned: true })}
              onDragStart={(event) => {
                if (worktreeRoot === null || resolvedWorktreeId === null) {
                  event.preventDefault()
                  return
                }
                const paths = topLevelPaths(selectedPaths.includes(entry.path) ? selectedPaths : [entry.path])
                const relativePaths = paths.map((path) => relativeExplorerPath(worktreeRoot, path))
                if (relativePaths.includes(null)) {
                  event.preventDefault()
                  return
                }
                event.dataTransfer.setData(WORKTREE_PATHS_MIME, JSON.stringify({ worktreeId: resolvedWorktreeId, paths: relativePaths }))
                event.dataTransfer.setData('text/uri-list', paths.map(fileUrl).join('\r\n'))
                event.dataTransfer.effectAllowed = 'copyMove'
              }}
              onDragOver={(event) => {
                const types = event.dataTransfer.types
                if (entry.isDirectory && (types.includes(WORKTREE_PATHS_MIME) || types.includes('Files') || types.includes('text/uri-list'))) event.preventDefault()
              }}
              onDrop={(event) => { if (entry.isDirectory) void dropOnFolder(event, entry.path).catch((reason: unknown) => setError(messageOf(reason))) }}
            >
              <ListRow
                title={<>
                  <span className="qe-explorer-chevron">{entry.isDirectory ? (expanded.has(entry.path) ? '▾' : '▸') : ''}</span>
                  <span className="qe-explorer-name">{entry.name}</span>
                </>}
                selected={selectedPaths.includes(entry.path)}
                trailing={
                  <>
                    {gitStatus.has(entry.path) && <span className="qe-git-status" aria-label={`Git status ${gitStatus.get(entry.path)}`}>{gitStatus.get(entry.path)}</span>}
                    {entry.isSymlink && <span title="Symbolic link">↗</span>}
                    {entry.ignored && <span aria-label="Ignored by .gitignore">⊘</span>}
                    {entry.error && <span className="qe-explorer-row-error" title={entry.error}>!</span>}
                    <div
                      className="qe-explorer-row-actions"
                      onClick={(event) => {
                        event.stopPropagation()
                        if (!(event.target instanceof Element) || event.target.closest('.ui-menu__trigger') === null) return
                        if (!selectedPathsRef.current.includes(entry.path)) {
                          void enqueueInteraction({
                            action: 'select',
                            path: entry.path,
                            ...(searchMode === 'names' && query.trim() !== '' ? { query } : {})
                          })
                        }
                      }}
                      onKeyDown={(event) => event.stopPropagation()}
                    >
                      <Menu
                        label={`Actions for ${entry.name}`}
                        trigger={<span aria-hidden="true">⋯</span>}
                        items={[
                          { id: 'new-file', label: 'New File', onAction: () => startNewItem('file', entry.isDirectory ? entry.path : '.') },
                          { id: 'new-folder', label: 'New Folder', onAction: () => startNewItem('folder', entry.isDirectory ? entry.path : '.') },
                          { id: 'copy-path', label: 'Copy Path', onAction: () => { void copyPaths(false, [entry.path]) } },
                          { id: 'copy-relative-path', label: 'Copy Relative Path', onAction: () => { void copyPaths(true, [entry.path]) } },
                          ...(!entry.isDirectory ? [{ id: 'duplicate', label: 'Duplicate', onAction: () => { void duplicatePath(entry.path) } }] : []),
                          { id: 'rename', label: 'Rename', onAction: () => startRename(entry.path) },
                          { id: 'delete', label: 'Delete', destructive: true, onAction: () => { void deleteSelected([entry.path]) } },
                          ...(entry.isDirectory ? [
                            { id: 'open-in-terminal', label: 'Open in Terminal', onAction: () => { void openInTerminal(entry.path) } },
                            { id: 'find-in-folder', label: 'Find in Folder', onAction: () => { setSearchMode('contents'); setIncludePattern(`${escapedGlob(entry.path)}/**`) } }
                          ] : []),
                          ...(!entry.isDirectory && entry.name.toLowerCase().endsWith('.md') ? [
                            { id: 'open-markdown-preview', label: 'Open Markdown Preview', onAction: () => { void openMarkdownPreview(entry.path) } }
                          ] : [])
                        ]}
                      />
                    </div>
                  </>
                }
              />
            </div>
          ))}
          </div>
          {newItemKind && (
            <div className="qe-explorer-inline-row">
              <TextField
                className="qe-explorer-inline-field"
                label={newItemKind === 'file' ? 'New file name' : 'New folder name'}
                autoFocus
                value={newItemName}
                onChange={(event) => setNewItemName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void commitNewItem() }
                  if (event.key === 'Escape') { setNewItemKind(null); setNewItemName('') }
                }}
                onBlur={() => {
                  if (Date.now() - inlineOpenedAt.current < 200) return
                  if (inlineBlurTimer.current !== undefined) window.clearTimeout(inlineBlurTimer.current)
                  inlineBlurTimer.current = window.setTimeout(() => void commitNewItem(), 150)
                }}
              />
              <Button variant="primary" disabled={itemBusy} onClick={() => void commitNewItem()}>Create</Button>
              <Button onClick={() => { setNewItemKind(null); setNewItemName('') }}>Cancel</Button>
            </div>
          )}
          {renamePath !== null && (
            <div className="qe-explorer-inline-row">
              <input
                ref={renameInputRef}
                className="ui-text-field__input qe-explorer-inline-field"
                autoFocus
                aria-label="Rename file"
                value={renameValue}
                onChange={(event) => setRenameValue(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void renameSelected() }
                  if (event.key === 'Escape') setRenamePath(null)
                }}
              />
              <Button variant="primary" onClick={() => void renameSelected()}>Rename</Button>
              <Button onClick={() => setRenamePath(null)}>Cancel</Button>
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
                  <Button key={`${match.line}:${match.column}:${index}`} onClick={() => void openFile(file.path, { preview: false, pinned: true, line: match.line, column: match.column, matchLength: match.matchLength })}>
                    <span>{match.line}:{match.column}</span>
                    <code>{match.lineContent.slice(0, start)}<mark>{match.lineContent.slice(start, end)}</mark>{match.lineContent.slice(end)}</code>
                  </Button>
                )
              })}
            </section>
          ))}
        </div>
      )}
      <footer className="qe-explorer-footer">
        <Button disabled={selectedPaths.length === 0} onClick={() => void copyPaths(false)}>Copy Path</Button>
        <Button disabled={selectedPaths.length === 0 || !worktree} onClick={() => void copyPaths(true)}>Copy Relative Path</Button>
        <Button variant="destructive" disabled={selectedPaths.length === 0 || !worktree} onClick={() => void deleteSelected()}>Delete</Button>
        <Button onClick={() => { setSearchMode('contents'); setQuery(''); setIncludePattern(''); searchInputRef.current?.focus() }}>Search in Files</Button>
      </footer>
      {rootListing?.truncated && <p className="muted">More files may be available.</p>}
      {state?.explorer.expanded.length === 0 && expanded.size > 0 && <span className="sr-only">Expanded folders are open.</span>}
    </section>
  )
}