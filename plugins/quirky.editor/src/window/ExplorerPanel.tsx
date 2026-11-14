import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent, type MouseEvent as ReactMouseEvent } from 'react'
import { RpcErrorCode, type UiPluginContext } from '@quirky/protocol'
import { Button, ControlIcon, EmptyState, IconButton, InlineError, ListRow, NoticeLine, PopupMenu, TextField, ToolPanelFrame } from '@quirky/ui'
import type { ExplorerInteraction } from '../types'
import { activeDocument } from './activeDocument'
import { useEditorState, worktreeFromLayout } from './editorState'
import { clearExplorerSearch, useExplorerSearchIntent } from './explorerIntent'
import { setEditorSetting, useEditorSettings } from './settings'
import { importFiles } from './transfers'
import { beginEditorFocusHandoff, type EditorFocusHandoff } from './editorFocus'
import { useEditorUiControl, useEditorUiControlReport, useEditorUiControlSurface, type EditorUiControl, type EditorUiControlActions } from './uiControl'

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
type NameFilterRead = { worktree: string; query: string; status: 'pending' | 'success' | 'error'; listing?: ExplorerListing; error?: string }
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

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}${explorerSeparator(parent)}`)
}

function topLevelPaths(paths: string[]): string[] {
  return paths.filter((path) => !paths.some((parent) => parent !== path && isPathWithin(path, parent)))
}

function renameNeighborPaths(paths: string[], source: string, destination: string): string[] {
  const index = paths.indexOf(source)
  if (index < 0) return []
  const remap = (path: string) => isPathWithin(path, source)
    ? `${destination}${path.slice(source.length)}`
    : path
  return [
    ...paths.slice(index + 1).filter((path) => path !== source).map(remap),
    ...paths.slice(0, index).reverse().filter((path) => path !== source).map(remap)
  ]
}

function deletionNeighborPaths(paths: string[], deletedPaths: string[], pivotPath?: string): string[] {
  const deleted = (path: string) => deletedPaths.some((deletedPath) => isPathWithin(path, deletedPath))
  const pivotIndex = pivotPath === undefined ? -1 : paths.indexOf(pivotPath)
  const index = pivotIndex >= 0 ? pivotIndex : paths.findIndex(deleted)
  if (index < 0) return []
  return [
    ...paths.slice(index + 1).filter((path) => !deleted(path)),
    ...paths.slice(0, index).reverse().filter((path) => !deleted(path))
  ]
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

function isMissingExplorerPathError(reason: unknown): boolean {
  if (typeof reason !== 'object' || reason === null || !('code' in reason)) return false
  return reason.code === RpcErrorCode.NotFound || reason.code === 'ENOENT' || reason.code === 'ENOTDIR'
}

let nextExplorerControlGeneration = 0

function newExplorerControlGeneration(): string {
  return `explorer-${++nextExplorerControlGeneration}`
}


function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}
/** Explorer, names filtering, contents search, and safe file operations for one worktree. */
export function ExplorerPanel({ context, report }: { context: UiPluginContext; report?(state: unknown): void }) {
  const reportFromScope = useEditorUiControlReport()
  const controlSurface = useEditorUiControlSurface()
  const publishReport = report ?? reportFromScope
  const [layoutWorktree, setLayoutWorktree] = useState(() => worktreeFromLayout(context))
  const [selectedWorktree, setSelectedWorktree] = useState<string | undefined>()
  const [worktrees, setWorktrees] = useState<Worktree[]>([])
  const worktree = layoutWorktree ?? selectedWorktree ?? activeDocument()?.worktreeId
  const currentWorktree = useRef(worktree)
  currentWorktree.current = worktree
  const { state, error: editorStateError, refresh: refreshEditorState } = useEditorState(context, worktree ? { worktree } : undefined)
  const { settings, error: settingsError } = useEditorSettings(context)
  const intent = useExplorerSearchIntent()
  const [rootListing, setRootListing] = useState<ExplorerListing | null>(null)
  const [gitStatus, setGitStatus] = useState<Map<string, string>>(new Map())
  const [gitError, setGitError] = useState<string | null>(null)
  const [children, setChildren] = useState<Map<string, ExplorerEntry[]>>(new Map())
  const childrenRef = useRef<Map<string, ExplorerEntry[]>>(new Map())
  const directoryLoads = useRef(new Map<string, Promise<ExplorerListing | undefined>>())
  const foregroundDirectoryLoads = useRef(new Set<Promise<ExplorerListing | undefined>>())
  const missingExpandedDirectories = useRef(false)
  const treeLoadGeneration = useRef(0)
  const mutationReloads = useRef(0)
  const pendingExplorerReload = useRef<(() => void) | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const expandedRef = useRef<Set<string>>(new Set())
  const [selectedPaths, setSelectedPaths] = useState<string[]>([])
  const [rowAction, setRowAction] = useState<{ anchor: HTMLButtonElement; entry: ExplorerEntry } | null>(null)
  const selectedPathsRef = useRef<string[]>([])
  const [focusedPath, setFocusedPath] = useState<string | null>(null)
  const focusedPathRef = useRef<string | null>(null)
  const [worktreeRoot, setWorktreeRoot] = useState<string | null>(null)
  const [resolvedWorktreeId, setResolvedWorktreeId] = useState<string | null>(null)
  const resolvedWorktreeIdRef = useRef<string | null>(null)
  const worktreeRootRef = useRef<string | null>(null)
  const worktreeRootSelectorRef = useRef<string | null>(null)
  const interactionQueue = useRef(Promise.resolve())
  const treeRef = useRef<HTMLDivElement>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const newItemRowRef = useRef<HTMLDivElement>(null)
  const renameRowRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renamePathRef = useRef<string | null>(null)
  const mountedRef = useRef(false)
  const userIntentRef = useRef(0)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [nameFilter, setNameFilter] = useState<NameFilterRead | null>(null)
  const [searchMode, setSearchMode] = useState<'names' | 'contents'>('names')
  const [query, setQuery] = useState('')
  const searchModeRef = useRef(searchMode)
  const queryRef = useRef(query)
  searchModeRef.current = searchMode
  queryRef.current = query
  const [includePattern, setIncludePattern] = useState('')
  const [excludePattern, setExcludePattern] = useState('')
  const [caseSensitive, setCaseSensitive] = useState(false)
  const [wholeWord, setWholeWord] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [searchState, setSearchState] = useState<{ key: string; result: SearchResult } | null>(null)
  const contentsSearchKey = JSON.stringify([
    worktree ?? null, query, includePattern, excludePattern, caseSensitive, wholeWord, useRegex
  ])
  const searchResult = searchState?.key === contentsSearchKey ? searchState.result : null
  const [treeLoading, setTreeLoading] = useState(false)
  const [errorState, setErrorState] = useState<{ message: string; form?: 'create' | 'rename' } | null>(null)
  const error = errorState?.message ?? null
  const setError = (message: string | null, form?: 'create' | 'rename') => {
    setErrorState(message === null ? null : form === undefined ? { message } : { message, form })
  }
  const clearInlineError = (form: 'create' | 'rename') => {
    setErrorState((current) => current?.form === form ? null : current)
  }
  const [newItemKind, setNewItemKind] = useState<'file' | 'folder' | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const [renamePath, setRenamePath] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [itemBusy, setItemBusy] = useState(false)
  const [focusAfterCreate, setFocusAfterCreate] = useState<EditorFocusHandoff | null>(null)
  const focusHandoffRef = useRef<EditorFocusHandoff | null>(null)
  const searchRequest = useRef<string | undefined>(undefined)
  const searchSequence = useRef(0)
  const nameFilterSequence = useRef(0)
  const inlineOpenedAt = useRef(0)
  const inlineBlurTimer = useRef<number | undefined>(undefined)
  const [controlGeneration, setControlGeneration] = useState(newExplorerControlGeneration)
  const controlGenerationRef = useRef(controlGeneration)
  controlGenerationRef.current = controlGeneration
  const controlTarget = worktree === undefined ? 'explorer:unselected' : `explorer:${worktree}`
  const previousControlTargetRef = useRef(controlTarget)
  const createSessionRef = useRef<{ generation: string; kind: 'file' | 'folder'; worktree: string } | null>(null)
  const renameSessionRef = useRef<{ generation: string; path: string; worktree: string } | null>(null)
  const itemBusyRef = useRef(false)
  const itemBusySessionRef = useRef<string | null>(null)
  const renameBusyRef = useRef(false)
  const renameBusySessionRef = useRef<string | null>(null)
  const controlsRef = useRef<EditorUiControlActions | null>(null)

  const rotateControlGeneration = () => {
    const generation = newExplorerControlGeneration()
    controlGenerationRef.current = generation
    setControlGeneration(generation)
    return generation
  }
  useEffect(() => {
    if (previousControlTargetRef.current === controlTarget) return
    previousControlTargetRef.current = controlTarget
    createSessionRef.current = null
    renameSessionRef.current = null
    itemBusyRef.current = false
    itemBusySessionRef.current = null
    renameBusyRef.current = false
    setItemBusy(false)
    setRenameBusy(false)
    setNewItemKind(null)
    setNewItemName('')
    renamePathRef.current = null
    setRenamePath(null)
    setRenameValue('')
    setRowAction(null)
    setErrorState(null)
    focusHandoffRef.current?.cancel()
    focusHandoffRef.current = null
    setFocusAfterCreate(null)
    rotateControlGeneration()
  }, [controlTarget])
  useEffect(() => {
    if (renamePath === null || renameInputRef.current === null) return
    const name = basename(renamePath)
    const extension = name.lastIndexOf('.')
    const isDirectory = entryForPath(renamePath)?.isDirectory ?? false
    const selectionEnd = !isDirectory && extension > 0 ? extension : name.length
    renameInputRef.current.setSelectionRange(0, selectionEnd)
  }, [renamePath])
  useEffect(() => {
    if (focusAfterCreate === null) return
    focusAfterCreate.request()
    setFocusAfterCreate(null)
  }, [focusAfterCreate])
  useEffect(() => {
    mountedRef.current = true
    const recordUserIntent = () => { userIntentRef.current++ }
    document.addEventListener('pointerdown', recordUserIntent, true)
    document.addEventListener('keydown', recordUserIntent, true)
    document.addEventListener('input', recordUserIntent, true)
    return () => {
      mountedRef.current = false
      document.removeEventListener('pointerdown', recordUserIntent, true)
      document.removeEventListener('keydown', recordUserIntent, true)
      document.removeEventListener('input', recordUserIntent, true)
      focusHandoffRef.current?.cancel()
      focusHandoffRef.current = null
    }
  }, [])
  useEffect(() => context.onLayout(() => {
    const nextLayoutWorktree = worktreeFromLayout(context)
    const nextWorktree = nextLayoutWorktree ?? selectedWorktree ?? activeDocument()?.worktreeId
    if (currentWorktree.current !== nextWorktree) {
      currentWorktree.current = nextWorktree
      rotateControlGeneration()
    }
    setLayoutWorktree(nextLayoutWorktree)
  }), [context, selectedWorktree])

  useEffect(() => {
    if (rowAction === null) return
    const closeOnFocusOutside = (event: FocusEvent) => {
      const target = event.target
      if (!(target instanceof Node) || rowAction.anchor.contains(target)) return
      const menuLabel = `Actions for ${rowAction.entry.name}`
      const targetElement = target instanceof Element ? target : null
      const menu = targetElement?.closest<HTMLElement>('[role="menu"][aria-label]')
      const isInsideMenu = menu?.getAttribute('aria-label') === menuLabel
      if (!isInsideMenu) void controlsRef.current?.run('menu-close')
    }
    document.addEventListener('focusin', closeOnFocusOutside)
    return () => document.removeEventListener('focusin', closeOnFocusOutside)
  }, [rowAction])

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
      worktreeRootRef.current = null
      worktreeRootSelectorRef.current = null
      resolvedWorktreeIdRef.current = null
      setWorktreeRoot(null)
      setResolvedWorktreeId(null)
      return
    }
    let cancelled = false
    context.call('quirky.editor/documentRoot', { worktree }).then((value) => {
      if (cancelled || currentWorktree.current !== worktree) return
      const resolved = value as { id?: unknown; path?: unknown }
      if (typeof resolved.id !== 'string' || typeof resolved.path !== 'string') {
        setError('The selected worktree could not be resolved.')
        return
      }
      worktreeRootRef.current = resolved.path
      worktreeRootSelectorRef.current = worktree
      resolvedWorktreeIdRef.current = resolved.id
      setResolvedWorktreeId(resolved.id)
      setWorktreeRoot(resolved.path)
    }).catch((reason: unknown) => {
      if (!cancelled && currentWorktree.current === worktree) setError(messageOf(reason))
    })
    return () => { cancelled = true }
  }, [context, worktree])
  const pruneMissingDirectory = useCallback((requestedWorktree: string, path: string, generation: number) => {
    if (!mountedRef.current || generation !== treeLoadGeneration.current || currentWorktree.current !== requestedWorktree) return
    const root = worktreeRootRef.current
    if (root === null || worktreeRootSelectorRef.current !== requestedWorktree) return
    const previousExpanded = expandedRef.current
    const nextExpanded = new Set(Array.from(previousExpanded).filter((candidate) => !isPathWithin(candidate, path)))
    const nextChildren = new Map(childrenRef.current)
    let childrenChanged = false
    for (const candidate of nextChildren.keys()) {
      if (isPathWithin(candidate, path)) {
        nextChildren.delete(candidate)
        childrenChanged = true
      }
    }
    if (nextExpanded.size !== previousExpanded.size) {
      expandedRef.current = nextExpanded
      missingExpandedDirectories.current = true
      setExpanded(nextExpanded)
    }
    if (childrenChanged) {
      childrenRef.current = nextChildren
      setChildren(nextChildren)
    }
  }, [])
  const loadDirectory = useCallback(async (path?: string, showLoading = true, isCurrent?: () => boolean) => {
    if (!mountedRef.current || !worktree || currentWorktree.current !== worktree || (isCurrent !== undefined && !isCurrent())) return
    const requestedWorktree = worktree
    const generation = treeLoadGeneration.current
    const key = `${requestedWorktree}\0${path ?? ''}`
    let request = directoryLoads.current.get(key)
    if (request === undefined) {
      request = (async () => {
        try {
          const listing = await context.call('quirky.editor/explorer', {
            worktree: requestedWorktree,
            action: 'list',
            ...(path ? { path } : {})
          }) as ExplorerListing
          if (!mountedRef.current || generation !== treeLoadGeneration.current || currentWorktree.current !== requestedWorktree || (isCurrent !== undefined && !isCurrent())) return
          if (path) {
            const next = new Map(childrenRef.current).set(path, listing.entries)
            childrenRef.current = next
            setChildren(next)
          } else {
            setRootListing(listing)
          }
          if (!path) setError(null)
          return listing
        } catch (reason) {
          if (mountedRef.current && generation === treeLoadGeneration.current && currentWorktree.current === requestedWorktree && (isCurrent === undefined || isCurrent())) {
            if (path && isMissingExplorerPathError(reason)) pruneMissingDirectory(requestedWorktree, path, generation)
            else setError(messageOf(reason))
          }
        }
      })()
      directoryLoads.current.set(key, request)
    }
    if (showLoading) {
      foregroundDirectoryLoads.current.add(request)
      setTreeLoading(true)
    }
    try {
      return await request
    } finally {
      if (directoryLoads.current.get(key) === request) directoryLoads.current.delete(key)
      if (foregroundDirectoryLoads.current.delete(request) && mountedRef.current && currentWorktree.current === requestedWorktree) {
        setTreeLoading(foregroundDirectoryLoads.current.size > 0)
      }
    }
  }, [context, pruneMissingDirectory, worktree])
  const reloadExpandedDirectories = async (
    requestedWorktree = worktree,
    generation = treeLoadGeneration.current,
    showLoading = true,
    isCurrent?: () => boolean
  ) => {
    if (
      requestedWorktree === undefined ||
      !mountedRef.current ||
      currentWorktree.current !== requestedWorktree ||
      generation !== treeLoadGeneration.current ||
      (isCurrent !== undefined && !isCurrent())
    ) return
    let count = 0
    for (const path of expandedRef.current) {
      if (count >= MAX_EXPLORER_CHILD_LISTINGS) break
      if (
        !mountedRef.current ||
        currentWorktree.current !== requestedWorktree ||
        generation !== treeLoadGeneration.current ||
        (isCurrent !== undefined && !isCurrent())
      ) return
      count++
      await loadDirectory(path, showLoading, isCurrent)
    }
    const root = worktreeRootRef.current
    if (
      !missingExpandedDirectories.current ||
      !mountedRef.current ||
      currentWorktree.current !== requestedWorktree ||
      generation !== treeLoadGeneration.current ||
      (isCurrent !== undefined && !isCurrent()) ||
      root === null ||
      worktreeRootSelectorRef.current !== requestedWorktree
    ) return
    try {
      await context.call('quirky.editor/explorer', {
        worktree: requestedWorktree,
        action: 'preferences',
        expanded: Array.from(expandedRef.current, (path) => relativeExplorerPath(root, path))
          .filter((path): path is string => path !== null)
      })
      if (
        currentWorktree.current === requestedWorktree &&
        generation === treeLoadGeneration.current &&
        mountedRef.current &&
        (isCurrent === undefined || isCurrent())
      ) {
        missingExpandedDirectories.current = false
        refreshEditorState()
      }
    } catch (reason) {
      if (
        currentWorktree.current === requestedWorktree &&
        generation === treeLoadGeneration.current &&
        mountedRef.current &&
        (isCurrent === undefined || isCurrent())
      ) setError(messageOf(reason))
    }
  }


  useEffect(() => {
    treeLoadGeneration.current++
    nameFilterSequence.current++
    setNameFilter(null)
    setTreeLoading(false)
    missingExpandedDirectories.current = false
    directoryLoads.current.clear()
    foregroundDirectoryLoads.current.clear()
    childrenRef.current = new Map()
    expandedRef.current = new Set()
    setExpanded(new Set())
    selectedPathsRef.current = []
    setSelectedPaths([])
    focusedPathRef.current = null
    setFocusedPath(null)
    setResolvedWorktreeId(null)
    worktreeRootRef.current = null
    worktreeRootSelectorRef.current = null
    resolvedWorktreeIdRef.current = null
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
      void loadDirectory(path, false)
    }
  }, [loadDirectory, resolvedWorktreeId, rootListing !== null, state?.explorer?.expanded, state?.explorer?.worktreeId, worktreeRoot])
  const currentNameFilter = nameFilter !== null && nameFilter.worktree === worktree && nameFilter.query === query ? nameFilter : null
  const currentFilterListing = currentNameFilter?.status === 'success' ? currentNameFilter.listing : undefined
  const namesFilterPending = searchMode === 'names' && query.trim() !== '' &&
    (currentNameFilter === null || currentNameFilter.status === 'pending')
  const namesFilterError = currentNameFilter?.status === 'error' ? currentNameFilter.error ?? null : null

  const rows = useMemo(() => {
    if (searchMode === 'names' && query.trim() !== '') {
      return currentFilterListing?.entries.map((entry) => ({ entry, depth: 0 })) ?? []
    }
    return flattenEntries(rootListing?.entries ?? [], expanded, children)
  }, [children, currentFilterListing, expanded, query, rootListing, searchMode])

  const visibleSelectedPaths = useMemo(() => {
    const visiblePaths = new Set(rows.map(({ entry }) => entry.path))
    return selectedPaths.filter((path) => visiblePaths.has(path))
  }, [rows, selectedPaths])
  const entryForPath = (path: string | null): ExplorerEntry | undefined => {
    if (path === null) return undefined
    if (searchMode === 'names' && query.trim() !== '') return currentFilterListing?.entries.find((entry) => entry.path === path)
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
    newItemRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [newItemKind, error])

  useEffect(() => {
    renameRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [renamePath, error])

  useEffect(() => {
    publishReport({
      mounted: true,
      worktreeId: worktree ?? null,
      queryLength: query.length,
      loading: treeLoading || namesFilterPending || searchResult?.loading === true,
      resultCount: searchMode === 'contents' ? searchResult?.totalMatches ?? 0 : rows.length,
      truncated: searchMode === 'contents'
        ? searchResult?.truncated ?? false
        : currentFilterListing?.truncated ?? rootListing?.truncated ?? false,
      selectedCount: selectedPaths.length,
      expandedCount: expanded.size,
      error: error ?? settingsError ?? editorStateError ?? namesFilterError ?? searchResult?.error ?? null
    })
  }, [publishReport, worktree, searchMode, query, treeLoading, namesFilterPending, searchResult, rows.length, currentFilterListing?.truncated, rootListing?.truncated, selectedPaths, expanded, error, settingsError, editorStateError, namesFilterError])


  useEffect(() => {
    const attempt = ++nameFilterSequence.current
    if (!worktree || searchMode !== 'names' || query.trim() === '') {
      setNameFilter(null)
      return () => { if (nameFilterSequence.current === attempt) nameFilterSequence.current++ }
    }
    const requestedWorktree = worktree
    const requestedQuery = query
    setNameFilter({ worktree: requestedWorktree, query: requestedQuery, status: 'pending' })
    const isCurrent = () => mountedRef.current &&
      attempt === nameFilterSequence.current &&
      currentWorktree.current === requestedWorktree &&
      searchModeRef.current === 'names' &&
      queryRef.current === requestedQuery
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const listing = await context.call('quirky.editor/explorer', {
            worktree: requestedWorktree, action: 'filter', query: requestedQuery
          }) as ExplorerListing
          if (!isCurrent()) return
          setNameFilter({ worktree: requestedWorktree, query: requestedQuery, status: 'success', listing })
          setError(null)
        } catch (reason) {
          if (isCurrent()) setNameFilter({
            worktree: requestedWorktree, query: requestedQuery, status: 'error', error: messageOf(reason)
          })
        }
      })()
    }, 120)
    return () => {
      window.clearTimeout(timer)
      if (nameFilterSequence.current === attempt) nameFilterSequence.current++
    }
  }, [context, query, searchMode, worktree])

  const { runContentsSearch } = useMemo(() => ({ async runContentsSearch(text: string, include = includePattern, exclude = excludePattern) {
    const attempt = ++searchSequence.current
    if (!worktree) return
    if (searchRequest.current) {
      void context.call('quirky.editor/search', { worktree, action: 'cancel', requestId: searchRequest.current }).catch(() => {})
      searchRequest.current = undefined
    }
    if (text.trim() === '') {
      setSearchState(null)
      return
    }
    const key = JSON.stringify([worktree, text, include, exclude, caseSensitive, wholeWord, useRegex])
    setSearchState({ key, result: { files: [], totalMatches: 0, truncated: false, error: null, loading: true } })
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
      if (attempt !== searchSequence.current || currentWorktree.current !== worktree) return
      searchRequest.current = result.requestId
      setSearchState({ key, result })
    } catch (reason) {
      if (attempt === searchSequence.current && currentWorktree.current === worktree) {
        setSearchState({ key, result: { files: [], totalMatches: 0, truncated: false, error: messageOf(reason), loading: false } })
      }
    }
  } }), [caseSensitive, context, excludePattern, includePattern, useRegex, wholeWord, worktree])


  useEffect(() => {
    if (!intent || !worktree || intent.worktree !== worktree) return
    setSearchMode('contents')
    setQuery(intent.query)
    setNameFilter(null)
    void runContentsSearch(intent.query)
    clearExplorerSearch(intent.id)
  }, [intent?.id, intent?.query, intent?.worktree, runContentsSearch, worktree])

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
      await context.call('quirky.editor/open', {
        worktree,
        path,
        focus: true,
        preview: options.preview ?? settings.previewTabs,
        ...(options.pinned === undefined ? {} : { pinned: options.pinned }),
        ...(options.line === undefined ? {} : { line: options.line }),
        ...(options.column === undefined ? {} : { column: options.column }),
        ...(options.matchLength === undefined ? {} : { matchLength: options.matchLength })
      })
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
    resolvedWorktreeIdRef.current = resolved.id
    setResolvedWorktreeId(resolved.id)
    setWorktreeRoot(resolved.path)
    return resolved.path
  }, [context])

  const isRestoreCurrent = (
    requestedWorktree: string,
    intent: number,
    requestedMode: 'names' | 'contents',
    requestedQuery: string
  ) => mountedRef.current &&
    currentWorktree.current === requestedWorktree &&
    userIntentRef.current === intent &&
    searchModeRef.current === requestedMode &&
    queryRef.current === requestedQuery

  const updateExpandedPathsAfterMutation = async (
    requestedWorktree: string,
    removedPaths: string[],
    rename?: { from: string; to: string },
    isCurrent?: () => boolean
  ) => {
    const root = await resolveWorktreeRoot(requestedWorktree)
    if (root === null || currentWorktree.current !== requestedWorktree || !mountedRef.current ||
      (isCurrent !== undefined && !isCurrent())) return
    const removedRelative = removedPaths
      .map((path) => relativeExplorerPath(root, path))
      .filter((path): path is string => path !== null)
    const fromRelative = rename ? relativeExplorerPath(root, rename.from) : null
    const toRelative = rename ? relativeExplorerPath(root, rename.to) : null
    const next = new Set<string>()
    for (const path of expandedRef.current) {
      const relative = relativeExplorerPath(root, path)
      if (relative !== null && removedRelative.some((removed) => isPathWithin(relative, removed))) continue
      if (relative !== null && fromRelative !== null && toRelative !== null && isPathWithin(relative, fromRelative)) {
        next.add(absoluteExplorerPath(root, `${toRelative}${relative.slice(fromRelative.length)}`))
      } else {
        next.add(path)
      }
    }
    const previous = expandedRef.current
    if (next.size === previous.size && Array.from(next).every((path) => previous.has(path))) return
    if (isCurrent !== undefined && !isCurrent()) return
    expandedRef.current = next
    setExpanded(next)
    try {
      await context.call('quirky.editor/explorer', {
        worktree: requestedWorktree,
        action: 'preferences',
        expanded: Array.from(next, (path) => relativeExplorerPath(root, path)).filter((path): path is string => path !== null)
      })
      if (currentWorktree.current === requestedWorktree && mountedRef.current &&
        (isCurrent === undefined || isCurrent())) refreshEditorState()
    } catch (reason) {
      if (currentWorktree.current === requestedWorktree && mountedRef.current &&
        (isCurrent === undefined || isCurrent())) setError(messageOf(reason))
    }
  }

  const reloadTree = async (
    requestedWorktree: string,
    requestedMode: 'names' | 'contents',
    requestedQuery: string,
    showLoading = true,
    isCurrent?: () => boolean
  ): Promise<ExplorerListing | null> => {
    if (currentWorktree.current !== requestedWorktree || !mountedRef.current || (isCurrent !== undefined && !isCurrent())) return null
    treeLoadGeneration.current++
    const generation = treeLoadGeneration.current
    directoryLoads.current.clear()
    const listing = await loadDirectory(undefined, showLoading, isCurrent)
    if (
      generation !== treeLoadGeneration.current ||
      currentWorktree.current !== requestedWorktree ||
      !mountedRef.current ||
      (isCurrent !== undefined && !isCurrent())
    ) return null
    await reloadExpandedDirectories(requestedWorktree, generation, showLoading, isCurrent)
    if (
      generation !== treeLoadGeneration.current ||
      currentWorktree.current !== requestedWorktree ||
      !mountedRef.current ||
      (isCurrent !== undefined && !isCurrent())
    ) return null
    if (requestedMode !== 'names' || requestedQuery.trim() === '') {
      return listing ? { ...listing, entries: flattenEntries(listing.entries, expandedRef.current, childrenRef.current).map(({ entry }) => entry) } : null
    }
    if (searchModeRef.current !== requestedMode || queryRef.current !== requestedQuery || (isCurrent !== undefined && !isCurrent())) return null
    if (generation !== treeLoadGeneration.current) return null
    try {
      const listing = await context.call('quirky.editor/explorer', {
        worktree: requestedWorktree,
        action: 'filter',
        query: requestedQuery
      }) as ExplorerListing
      if (
        currentWorktree.current !== requestedWorktree ||
        !mountedRef.current ||
        searchModeRef.current !== requestedMode ||
        queryRef.current !== requestedQuery ||
        (isCurrent !== undefined && !isCurrent())
      ) return null
      if (generation !== treeLoadGeneration.current) return null
      setNameFilter({ worktree: requestedWorktree, query: requestedQuery, status: 'success', listing })
      return listing
    } catch (reason) {
      if (
        currentWorktree.current === requestedWorktree &&
        generation === treeLoadGeneration.current &&
        mountedRef.current &&
        searchModeRef.current === requestedMode &&
        queryRef.current === requestedQuery &&
        (isCurrent === undefined || isCurrent())
      ) setNameFilter({ worktree: requestedWorktree, query: requestedQuery, status: 'error', error: messageOf(reason) })
      return null
    }
  }
  const reloadAfterMutation = async (
    requestedWorktree: string,
    requestedMode: 'names' | 'contents',
    requestedQuery: string,
    isCurrent?: () => boolean
  ): Promise<ExplorerListing | null> => {
    mutationReloads.current++
    try {
      return await reloadTree(requestedWorktree, requestedMode, requestedQuery, true, isCurrent)
    } finally {
      mutationReloads.current--
      if (mutationReloads.current === 0) {
        const reload = pendingExplorerReload.current
        pendingExplorerReload.current = null
        reload?.()
      }
    }
  }
  const reloadTreeRef = useRef(reloadTree)
  reloadTreeRef.current = reloadTree

  useEffect(() => {
    let timer: number | undefined
    const unsubscribe = context.subscribe((event) => {
      if (event.type !== 'quirky.editor/explorerChanged' || typeof event.data !== 'object' || event.data === null || !('worktreeId' in event.data)) return
      const worktreeId = event.data.worktreeId
      const requestedWorktree = currentWorktree.current
      if (
        typeof worktreeId !== 'string' ||
        requestedWorktree === undefined ||
        worktreeRootSelectorRef.current !== requestedWorktree ||
        resolvedWorktreeIdRef.current !== worktreeId
      ) return
      if (timer !== undefined) window.clearTimeout(timer)
      const reload = () => {
        if (
          !mountedRef.current ||
          currentWorktree.current !== requestedWorktree ||
          worktreeRootSelectorRef.current !== requestedWorktree ||
          resolvedWorktreeIdRef.current !== worktreeId
        ) return
        if (mutationReloads.current > 0) {
          pendingExplorerReload.current = reload
          return
        }
        void reloadTreeRef.current(requestedWorktree, searchModeRef.current, queryRef.current, false)
      }
      timer = window.setTimeout(() => {
        timer = undefined
        reload()
      }, 100)
    })
    return () => {
      unsubscribe()
      if (timer !== undefined) window.clearTimeout(timer)
      pendingExplorerReload.current = null
    }
  }, [context])


  const { applyExplorerInteraction } = useMemo(() => ({ async applyExplorerInteraction(
    requestedWorktree: string,
    params: Record<string, unknown>,
    isCurrent?: () => boolean
  ): Promise<ExplorerInteractionResult> {
    const result = await context.call('quirky.editor/explorer', { worktree: requestedWorktree, ...params }) as ExplorerInteractionResult
    if (currentWorktree.current !== requestedWorktree || (isCurrent !== undefined && !isCurrent())) return result
    refreshEditorState()
    setError(null)
    if (result.interaction !== undefined) {
      selectedPathsRef.current = result.interaction.selectedPaths
      setSelectedPaths(result.interaction.selectedPaths)
      focusedPathRef.current = result.interaction.focusedPath
      setFocusedPath(result.interaction.focusedPath)
    }
    if (result.expanded !== undefined) {
      const root = await resolveWorktreeRoot(requestedWorktree)
      if (root !== null && (isCurrent === undefined || isCurrent())) {
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
  } }), [context, loadDirectory, refreshEditorState, resolveWorktreeRoot])

  const { enqueueInteraction } = useMemo(() => ({ enqueueInteraction(params: Record<string, unknown>, isCurrent?: () => boolean) {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree || (isCurrent !== undefined && !isCurrent())) return null
      return await applyExplorerInteraction(requestedWorktree, params, isCurrent)
    })
    interactionQueue.current = request.then(() => undefined, () => undefined)
    return request.catch((reason: unknown) => {
      if (currentWorktree.current === requestedWorktree) setError(messageOf(reason))
      return null
    })
  } }), [applyExplorerInteraction, worktree])

  const { activateDirectory } = useMemo(() => ({ activateDirectory(path: string, queryParams: Record<string, unknown> = {}) {
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
  } }), [applyExplorerInteraction, resolveWorktreeRoot, worktree])

  const { collapseAll } = useMemo(() => ({ collapseAll() {
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
  } }), [context, refreshEditorState, worktree])
  const changeRenamePath = (path: string | null) => {
    renamePathRef.current = path
    setRenamePath(path)
  }

  const startRename = (path: string) => {
    if (!worktree || entryForPath(path) === undefined) return false
    const generation = rotateControlGeneration()
    renameSessionRef.current = { generation, path, worktree }
    renameBusyRef.current = false
    renameBusySessionRef.current = null
    setRenameBusy(false)
    changeRenamePath(path)
    setRenameValue(basename(path))
    setRowAction(null)
    clearInlineError('rename')
    return true
  }
  const dismissRename = () => {
    renameSessionRef.current = null
    renameBusyRef.current = false
    setRenameBusy(false)
    changeRenamePath(null)
    setRenameValue('')
    clearInlineError('rename')
  }


  const renameFocused = () => {
    const requestedWorktree = worktree
    const request = interactionQueue.current.then(async () => {
      if (!requestedWorktree || currentWorktree.current !== requestedWorktree) return
      const path = focusedPathRef.current
      if (path === null || entryForPath(path) === undefined) return
      await controlsRef.current?.run('rename-start', { path })
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


  const copyPaths = async (
    relative: boolean,
    paths: string[],
    isCurrent: () => boolean
  ): Promise<boolean> => {
    const requestedWorktree = worktree
    if (!requestedWorktree || paths.length === 0 || !paths.every((path) => entryForPath(path) !== undefined)) return false
    try {
      const root = await resolveWorktreeRoot(requestedWorktree)
      if (root === null || !isCurrent() || currentWorktree.current !== requestedWorktree) return false
      const relativePaths = paths.map((path) => relativeExplorerPath(root, path))
      if (relativePaths.includes(null)) throw new Error('The selected path is outside this worktree.')
      const values = relative ? relativePaths : paths
      await navigator.clipboard.writeText(values.join('\n'))
      if (!isCurrent() || currentWorktree.current !== requestedWorktree) return false
      context.toast('Paths copied', `${values.length} path(s)`)
      return true
    } catch (reason) {
      if (isCurrent() && currentWorktree.current === requestedWorktree) setError(messageOf(reason))
      return isCurrent()
    }
  }

  const renameSelected = async (explicitName?: string): Promise<boolean> => {
    const requestedWorktree = worktree
    const session = renameSessionRef.current
    const sourcePath = renamePathRef.current
    const value = explicitName ?? renameValue
    if (!requestedWorktree || !session || session.worktree !== requestedWorktree ||
      session.path !== sourcePath || !sourcePath || !value.trim() || renameBusyRef.current) return false
    if (explicitName !== undefined) setRenameValue(explicitName)
    const isCurrent = () => mountedRef.current &&
      currentWorktree.current === requestedWorktree &&
      renameSessionRef.current === session
    const destinationPath = joinPath(dirname(sourcePath), value)
    const sourceIsDirectory = entryForPath(sourcePath)?.isDirectory === true
    const visiblePaths = rows.map(({ entry }) => entry.path)
    const requestedMode = searchMode
    const requestedQuery = query
    const intent = userIntentRef.current
    renameBusyRef.current = true
    renameBusySessionRef.current = session.generation
    setRenameBusy(true)
    try {
      if (!isCurrent()) return false
      await context.call('quirky.editor/mutate', {
        worktree: requestedWorktree,
        action: 'rename',
        path: sourcePath,
        newPath: destinationPath
      })
      if (!isCurrent()) return false
      const preserveEditedInput = userIntentRef.current !== intent && document.activeElement === renameInputRef.current
      if (renamePathRef.current === sourcePath && !preserveEditedInput) {
        changeRenamePath(null)
        setRenameValue('')
      }
      await updateExpandedPathsAfterMutation(
        requestedWorktree,
        [],
        sourceIsDirectory ? { from: sourcePath, to: destinationPath } : undefined,
        isCurrent
      )
      if (!isCurrent()) return false
      const filterListing = await reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery, isCurrent)
      if (!isCurrent()) return false
      if (filterListing !== null && isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery)) {
        const visible = new Set(filterListing.entries.map((entry) => entry.path))
        const targetPath = visible.has(destinationPath)
          ? destinationPath
          : renameNeighborPaths(visiblePaths, sourcePath, destinationPath).find((path) => visible.has(path)) ?? null
        const queryParams = requestedMode === 'names' && requestedQuery.trim() !== '' ? { query: requestedQuery } : {}
        const result = await enqueueInteraction(targetPath === null
          ? { action: 'navigate', key: 'Home', ...queryParams }
          : { action: 'select', path: targetPath, ...queryParams },
        () => isCurrent() && isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery))
        if (!isCurrent()) return false
        if (result !== null && isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery)) {
          treeRef.current?.focus()
          refreshEditorState()
        }
      }
      if (!preserveEditedInput && renameSessionRef.current === session) renameSessionRef.current = null
      return true
    } catch (reason) {
      if (!isCurrent()) return false
      setError(messageOf(reason), 'rename')
      return true
    } finally {
      if (renameBusySessionRef.current === session.generation) {
        renameBusySessionRef.current = null
        renameBusyRef.current = false
        setRenameBusy(false)
      }
    }
  }
  const startNewItem = (kind: 'file' | 'folder', directory = '.') => {
    if (!worktree) return false
    const generation = rotateControlGeneration()
    createSessionRef.current = { generation, kind, worktree }
    itemBusyRef.current = false
    itemBusySessionRef.current = null
    setItemBusy(false)
    focusHandoffRef.current?.cancel()
    focusHandoffRef.current = null
    setFocusAfterCreate(null)
    inlineOpenedAt.current = Date.now()
    setNewItemKind(kind)
    setNewItemName(directory === '.' ? '' : `${directory}/`)
    setRowAction(null)
    return true
  }
  const dismissNewItem = () => {
    if (inlineBlurTimer.current !== undefined) {
      window.clearTimeout(inlineBlurTimer.current)
      inlineBlurTimer.current = undefined
    }
    createSessionRef.current = null
    itemBusyRef.current = false
    itemBusySessionRef.current = null
    setItemBusy(false)
    setNewItemKind(null)
    setNewItemName('')
    clearInlineError('create')
  }

  const commitNewItem = async (explicitName?: string): Promise<boolean> => {
    if (inlineBlurTimer.current !== undefined) {
      window.clearTimeout(inlineBlurTimer.current)
      inlineBlurTimer.current = undefined
    }
    const requestedWorktree = worktree
    const session = createSessionRef.current
    const kind = newItemKind
    const name = explicitName ?? newItemName
    if (!requestedWorktree || !session || session.worktree !== requestedWorktree || session.kind !== kind ||
      kind === null || !name.trim() || itemBusyRef.current) return false
    if (explicitName !== undefined) setNewItemName(explicitName)
    const isCurrent = () => mountedRef.current &&
      currentWorktree.current === requestedWorktree &&
      createSessionRef.current === session
    const path = name.trim()
    const requestedMode = searchMode
    const requestedQuery = query
    const focusHandoff = kind === 'file' ? beginEditorFocusHandoff() : null
    if (focusHandoff !== null) focusHandoffRef.current = focusHandoff
    itemBusyRef.current = true
    itemBusySessionRef.current = session.generation
    setItemBusy(true)
    let openedTabId: string | undefined
    try {
      if (!isCurrent()) return false
      if (kind === 'file') {
        await context.call('quirky.editor/mutate', { worktree: requestedWorktree, action: 'createFile', path, content: '' })
        if (!isCurrent()) {
          focusHandoff?.cancel()
          return false
        }
        const opened = await context.call('quirky.editor/open', { worktree: requestedWorktree, path, preview: false, focus: true }) as { openedTabId?: unknown }
        if (!isCurrent()) {
          focusHandoff?.cancel()
          return false
        }
        if (typeof opened.openedTabId === 'string' && opened.openedTabId !== '') {
          openedTabId = opened.openedTabId
          focusHandoff?.setTarget(openedTabId)
        }
      } else {
        await context.call('quirky.editor/mutate', { worktree: requestedWorktree, action: 'createFolder', path })
        if (!isCurrent()) return false
      }
      await enqueueInteraction({ action: 'reveal', path }, isCurrent)
      if (!isCurrent()) return false
      await enqueueInteraction({ action: 'select', path }, isCurrent)
      if (!isCurrent()) return false
      await reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery, isCurrent)
      if (!isCurrent()) return false
      createSessionRef.current = null
      setNewItemKind(null)
      setNewItemName('')
      if (openedTabId !== undefined && focusHandoff !== null && focusHandoffRef.current === focusHandoff) {
        setFocusAfterCreate(focusHandoff)
      } else {
        focusHandoff?.cancel()
        if (focusHandoffRef.current === focusHandoff) focusHandoffRef.current = null
      }
      refreshEditorState()
      return true
    } catch (reason) {
      focusHandoff?.cancel()
      if (focusHandoffRef.current === focusHandoff) focusHandoffRef.current = null
      if (!isCurrent()) return false
      setError(messageOf(reason), 'create')
      return true
    } finally {
      if (itemBusySessionRef.current === session.generation) {
        itemBusySessionRef.current = null
        itemBusyRef.current = false
        setItemBusy(false)
      }
    }
  }

  const deleteSelected = async (paths = visibleSelectedPaths, opener?: HTMLElement) => {
    const requestedWorktree = worktree
    if (!requestedWorktree || paths.length === 0) return
    const requestedPaths = [...paths]
    const deletionRoots = topLevelPaths(requestedPaths)
    const visiblePaths = rows.map(({ entry }) => entry.path)
    const focusedAtStart = focusedPathRef.current
    const pivotPath = requestedPaths.length === 1
      ? requestedPaths[0]!
      : focusedAtStart !== null && requestedPaths.includes(focusedAtStart)
        ? focusedAtStart
        : requestedPaths[0]!
    const requestedMode = searchMode
    const requestedQuery = query
    const confirmed = await context.confirm({
      title: requestedPaths.length === 1 ? `Delete ${basename(requestedPaths[0]!)}?` : `Delete ${requestedPaths.length} items?`,
      body: 'Dirty files are saved before deletion. Undo is available for supported file operations.'
    })
    if (!confirmed) {
      if (opener?.isConnected) {
        const ownerDocument = opener.ownerDocument
        const focusedElement = ownerDocument.activeElement
        requestAnimationFrame(() => {
          if (!opener.isConnected || ownerDocument.querySelector('[role="dialog"]') !== null) return
          const currentFocus = ownerDocument.activeElement
          if (currentFocus === focusedElement || currentFocus === ownerDocument.body) opener.focus()
        })
      }
      return
    }
    const intent = userIntentRef.current
    setItemBusy(true)
    try {
      for (const path of deletionRoots) {
        await context.call('quirky.editor/mutate', { worktree: requestedWorktree, action: 'delete', path, yes: true })
      }
      if (currentWorktree.current !== requestedWorktree || !mountedRef.current) return
      await updateExpandedPathsAfterMutation(requestedWorktree, deletionRoots)
      const filterListing = await reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery)
      if (!isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery)) return
      const neighbors = deletionNeighborPaths(visiblePaths, deletionRoots, pivotPath)
      if (filterListing === null) return
      const visible = new Set(filterListing.entries.map((entry) => entry.path))
      const targetPath = neighbors.find((path) => visible.has(path)) ?? null
      const queryParams = requestedMode === 'names' && requestedQuery.trim() !== '' ? { query: requestedQuery } : {}
      const result = await enqueueInteraction(targetPath === null
        ? { action: 'navigate', key: 'Home', ...queryParams }
        : { action: 'select', path: targetPath, ...queryParams },
      () => isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery))
      if (result === null || !isRestoreCurrent(requestedWorktree, intent, requestedMode, requestedQuery)) return
      treeRef.current?.focus()
      refreshEditorState()
    } catch (reason) {
      if (currentWorktree.current === requestedWorktree && mountedRef.current) setError(messageOf(reason))
    } finally {
      setItemBusy(false)
    }
  }

  const duplicatePath = async (path: string) => {
    const requestedWorktree = worktree
    const requestedMode = searchMode
    const requestedQuery = query
    if (!requestedWorktree) return
    try {
      const result = await context.call('quirky.editor/mutate', { worktree: requestedWorktree, action: 'duplicate', path }) as { path: string }
      await enqueueInteraction({ action: 'reveal', path: result.path })
      await enqueueInteraction({ action: 'select', path: result.path })
      await reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery)
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
    userIntentRef.current++
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
      const requestedWorktree = worktree
      if (!requestedWorktree) return
      const requestedMode = searchMode
      const requestedQuery = query
      void context.call('quirky.editor/history', { worktree: requestedWorktree, action: event.shiftKey ? 'redo' : 'undo' })
        .then(() => reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery))
        .catch((reason: unknown) => setError(messageOf(reason)))
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

  const refreshExplorer = async (mutation = false) => {
    const requestedWorktree = worktree
    const requestedMode = searchMode
    const requestedQuery = query
    if (!requestedWorktree) return
    try {
      await context.call('quirky.editor/explorer', { worktree: requestedWorktree, action: 'refresh' })
      if (mutation) {
        await reloadAfterMutation(requestedWorktree, requestedMode, requestedQuery)
      } else {
        await loadDirectory()
        await reloadExpandedDirectories()
      }
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
      await refreshExplorer(true)
      return
    }
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) {
      const imported = await importFiles(context, worktree, destination || '.', files)
      for (const path of imported) await openFile(path, { preview: false, pinned: true })
      await refreshExplorer(true)
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
      await refreshExplorer(true)
    }
  }

  async function handleExplorerControl(control: EditorUiControl) {
    if (control.surface !== controlSurface || control.target !== controlTarget ||
      control.generation !== controlGenerationRef.current) return { delivered: false }
    const data = control.data ?? {}
    const exactData = (keys: readonly string[]) => hasOnlyKeys(data, keys)
    const directory = (value: unknown): string | null => {
      if (value === undefined || value === '.') return '.'
      if (typeof value !== 'string' || value.trim() === '') return null
      const entry = entryForPath(value)
      return entry?.isDirectory ? value : null
    }
    switch (control.action) {
      case 'new-file':
      case 'new-folder': {
        const hasDirectory = Object.hasOwn(data, 'directory')
        if (!exactData(['directory']) || !worktree || (hasDirectory && typeof data.directory !== 'string')) {
          return { delivered: false }
        }
        const targetDirectory = directory(hasDirectory ? data.directory : undefined)
        if (targetDirectory === null) return { delivered: false }
        return { delivered: startNewItem(control.action === 'new-file' ? 'file' : 'folder', targetDirectory) }
      }
      case 'create': {
        const hasName = Object.hasOwn(data, 'name')
        const name = data.name
        if (!exactData(['name']) || !createSessionRef.current || newItemKind === null || itemBusyRef.current ||
          (hasName && (typeof name !== 'string' || name.trim() === ''))) return { delivered: false }
        return { delivered: await commitNewItem(typeof name === 'string' ? name : undefined) }
      }
      case 'cancel-create':
        if (!exactData([]) || !createSessionRef.current) return { delivered: false }
        dismissNewItem()
        return { delivered: true }
      case 'rename-start': {
        if (!exactData(['path']) || typeof data.path !== 'string' || entryForPath(data.path) === undefined) {
          return { delivered: false }
        }
        return { delivered: startRename(data.path) }
      }
      case 'rename': {
        const hasName = Object.hasOwn(data, 'name')
        const name = data.name
        if (!exactData(['name']) || !renameSessionRef.current || renamePathRef.current === null ||
          renameBusyRef.current || (hasName && (typeof name !== 'string' || name.trim() === ''))) {
          return { delivered: false }
        }
        return { delivered: await renameSelected(typeof name === 'string' ? name : undefined) }
      }
      case 'cancel-rename':
        if (!exactData([]) || !renameSessionRef.current) return { delivered: false }
        dismissRename()
        return { delivered: true }
      case 'menu': {
        if (!exactData(['path', 'open']) || typeof data.path !== 'string' || typeof data.open !== 'boolean') {
          return { delivered: false }
        }
        const entry = entryForPath(data.path)
        if (!entry) return { delivered: false }
        if (!data.open) {
          if (rowAction?.entry.path !== data.path) return { delivered: false }
          setRowAction(null)
          return { delivered: true }
        }
        const row = Array.from(sectionRef.current?.querySelectorAll<HTMLElement>('[data-path]') ?? [])
          .find((candidate) => candidate.dataset.path === data.path)
        const anchor = row?.querySelector<HTMLButtonElement>('button[aria-label^="Actions for "]')
        if (!anchor) return { delivered: false }
        setRowAction({ entry, anchor })
        return { delivered: true }
      }
      case 'menu-close':
        if (!exactData([])) return { delivered: false }
        setRowAction(null)
        return { delivered: true }
      case 'clear-filter':
        if (!exactData([])) return { delivered: false }
        setQuery('')
        setNameFilter(null)
        searchInputRef.current?.focus()
        return { delivered: true }
      case 'mode':
        if (!exactData(['value']) || (data.value !== 'names' && data.value !== 'contents')) return { delivered: false }
        setSearchMode(data.value)
        return { delivered: true }
      case 'choose-worktree': {
        if (!exactData(['worktree']) || typeof data.worktree !== 'string' || layoutWorktree !== undefined ||
          !worktrees.some((candidate) => candidate.id === data.worktree)) return { delivered: false }
        if (data.worktree === worktree) return { delivered: true }
        rotateControlGeneration()
        previousControlTargetRef.current = `explorer:${data.worktree}`
        createSessionRef.current = null
        renameSessionRef.current = null
        itemBusyRef.current = false
        itemBusySessionRef.current = null
        renameBusyRef.current = false
        renameBusySessionRef.current = null
        setItemBusy(false)
        setRenameBusy(false)
        setNewItemKind(null)
        setNewItemName('')
        renamePathRef.current = null
        setRenamePath(null)
        setRenameValue('')
        setRowAction(null)
        setErrorState(null)
        focusHandoffRef.current?.cancel()
        focusHandoffRef.current = null
        setFocusAfterCreate(null)
        setSelectedWorktree(data.worktree)
        return { delivered: true }
      }
      case 'search-in-files': {
        const hasDirectory = Object.hasOwn(data, 'directory')
        if (!exactData(['directory']) || (hasDirectory && typeof data.directory !== 'string')) return { delivered: false }
        const targetDirectory = directory(hasDirectory ? data.directory : undefined)
        if (targetDirectory === null) return { delivered: false }
        setSearchMode('contents')
        if (!hasDirectory) {
          setQuery('')
          setIncludePattern('')
        } else {
          setIncludePattern(`${escapedGlob(targetDirectory)}/**`)
        }
        searchInputRef.current?.focus()
        return { delivered: true }
      }
      case 'copy-path': {
        if (searchMode !== 'names') return { delivered: false }
        const hasPaths = Object.hasOwn(data, 'paths')
        const hasRelative = Object.hasOwn(data, 'relative')
        if (!exactData(['paths', 'relative']) ||
          (hasRelative && typeof data.relative !== 'boolean') ||
          (hasPaths && (!Array.isArray(data.paths) || !data.paths.every((path) => typeof path === 'string')))) {
          return { delivered: false }
        }
        const paths: string[] = hasPaths ? data.paths as string[] : visibleSelectedPaths
        if (paths.length === 0 || !paths.every((path) => entryForPath(path) !== undefined)) return { delivered: false }
        const requestedWorktree = worktree
        const generation = control.generation
        if (!requestedWorktree) return { delivered: false }
        const isCurrent = () => mountedRef.current &&
          currentWorktree.current === requestedWorktree &&
          controlGenerationRef.current === generation
        return { delivered: await copyPaths(data.relative === true, paths, isCurrent) }
      }
      default:
        return { delivered: false }
    }
  }

  const controlActions = useEditorUiControl({
    context,
    address: {
      surface: controlSurface,
      target: controlTarget,
      generation: controlGeneration,
      actions: [
        'new-file', 'new-folder', 'create', 'cancel-create', 'rename-start', 'rename', 'cancel-rename',
        'menu', 'menu-close', 'clear-filter', 'mode', 'choose-worktree', 'search-in-files', 'copy-path'
      ]
    },
    handler: handleExplorerControl,
    onError: (reason) => {
      if (controlGenerationRef.current === controlGeneration && currentWorktree.current === worktree) setError(reason.message)
    }
  })
  controlsRef.current = controlActions


  const tools = (
    <>
      <IconButton label="New File" title="New File" onClick={() => { void controlsRef.current?.run('new-file') }}><ControlIcon name="plus" /></IconButton>
      <IconButton label="New Folder" title="New Folder" onClick={() => { void controlsRef.current?.run('new-folder') }}>▭</IconButton>
      <IconButton label="Collapse All" title="Collapse All" onClick={() => void collapseAll()}>⊟</IconButton>
      <IconButton label="Refresh Explorer" title="Refresh Explorer" onClick={() => void refreshExplorer()}><ControlIcon name="arrows-clockwise" /></IconButton>
      <IconButton label="Undo file operation" title="Undo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'undo' }).then(() => refreshExplorer(true)).catch((reason: unknown) => setError(messageOf(reason)))}>↶</IconButton>
      <IconButton label="Redo file operation" title="Redo file operation" onClick={() => void context.call('quirky.editor/history', { worktree, action: 'redo' }).then(() => refreshExplorer(true)).catch((reason: unknown) => setError(messageOf(reason)))}>↷</IconButton>
      <IconButton label="Source Control" title="Source Control" onClick={() => void openSourceControl()}>⑂</IconButton>
    </>
  )
  const selectionActions = (
    <>
      <Button disabled={searchMode !== 'names' || visibleSelectedPaths.length === 0} onClick={() => { void controlsRef.current?.run('copy-path', { relative: false }) }}>Copy Path</Button>
      <Button disabled={searchMode !== 'names' || visibleSelectedPaths.length === 0 || !worktree} onClick={() => { void controlsRef.current?.run('copy-path', { relative: true }) }}>Copy Relative Path</Button>
      <Button variant="destructive" disabled={searchMode !== 'names' || visibleSelectedPaths.length === 0 || !worktree} onClick={(event) => void deleteSelected(undefined, event.currentTarget)}>Delete</Button>
      <Button onClick={() => { void controlsRef.current?.run('search-in-files') }}>Search in Files</Button>
    </>
  )
  const actions = (
    <details className="qe-explorer-more-actions">
      <summary className="qe-disclosure-trigger" aria-label="More Explorer Actions"><ControlIcon name="dots-three" /></summary>
      <div className="qe-file-actions-menu">
        {selectionActions}
        <label><input type="checkbox" checked={state?.explorer.showDotfiles ?? true} onChange={() => void toggleDotfiles()} />Show Dotfiles</label>
        <label><input type="checkbox" checked={settings.showGitIgnored} onChange={(event) => void setEditorSetting(context, 'showGitIgnoredFiles', event.currentTarget.checked).then(() => refreshExplorer()).catch((reason: unknown) => setError(messageOf(reason)))} />Show Git Ignored Files</label>
        <label><input type="checkbox" checked={settings.followSymlinkedDirectories} onChange={(event) => void setEditorSetting(context, 'followSymlinkedDirectories', event.currentTarget.checked).then(() => refreshExplorer()).catch((reason: unknown) => setError(messageOf(reason)))} />Follow symlinked directories</label>
        <label className="qe-range-setting">Explorer Sidebar Width
          <input type="range" min="220" max="900" step="10" value={settings.sidebarWidth} onChange={(event) => void setEditorSetting(context, 'editorSidebarWidth', Number(event.currentTarget.value)).catch((reason: unknown) => setError(messageOf(reason)))} />
          <span>{settings.sidebarWidth}px</span>
        </label>
      </div>
    </details>
  )

  return (
    <ToolPanelFrame title="Explorer" tools={tools} actions={actions}>
    <section ref={sectionRef} className="qe-explorer" aria-label="File Explorer">
      <div className="qe-explorer-location">
        {worktrees.length > 1 && !layoutWorktree && (
          <select className="ui-text-field__input qe-explorer-worktree" aria-label="Worktree" value={worktree ?? ''} onChange={(event) => { void controlsRef.current?.run('choose-worktree', { worktree: event.currentTarget.value }) }}>
            {worktrees.map((entry) => <option key={entry.id} value={entry.id}>{entry.name ?? entry.path}</option>)}
          </select>
        )}
        <span className="qe-explorer-root" title={rootListing?.root ?? ''}>{rootListing?.root ?? 'Explorer'}</span>
      </div>
      <div className="qe-explorer-search-mode" role="group" aria-label="Explorer search mode">
        <Button aria-pressed={searchMode === 'names'} onClick={() => { void controlsRef.current?.run('mode', { value: 'names' }) }}>Names</Button>
        <Button aria-pressed={searchMode === 'contents'} onClick={() => { void controlsRef.current?.run('mode', { value: 'contents' }) }}>Contents</Button>
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
          <TextField label="Files to include" placeholder="files to include (e.g. *.ts, src/**)" value={includePattern} onChange={(event) => setIncludePattern(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runContentsSearch(query) }} />
          <TextField label="Files to exclude" placeholder="files to exclude (e.g. *.min.js, dist/**)" value={excludePattern} onChange={(event) => setExcludePattern(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void runContentsSearch(query) }} />
        </div>
      )}
      {error && <InlineError message={error} />}
      {settingsError && <InlineError message={settingsError} />}
      {editorStateError && <InlineError message={editorStateError} />}
      {namesFilterError && <InlineError message={namesFilterError} />}
      {treeLoading && <NoticeLine>Loading files…</NoticeLine>}
      {gitError && <p className="muted" role="status">Git status unavailable: {gitError}</p>}
      {searchMode === 'names' && namesFilterPending && <NoticeLine>Searching files…</NoticeLine>}
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
                userIntentRef.current++
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
                    <div className={`qe-explorer-row-actions${rowAction?.entry.path === entry.path ? ' open' : ''}`}>
                      <IconButton
                        className="qe-explorer-row-action-trigger"
                        label={`Actions for ${entry.name}`}
                        aria-haspopup="menu"
                        aria-expanded={rowAction?.entry.path === entry.path}
                        onClick={(event) => {
                          event.stopPropagation()
                          if (!selectedPathsRef.current.includes(entry.path)) {
                            void enqueueInteraction({
                              action: 'select',
                              path: entry.path,
                              ...(searchMode === 'names' && query.trim() !== '' ? { query } : {})
                            })
                          }
                          void controlsRef.current?.run('menu', {
                            path: entry.path,
                            open: rowAction?.entry.path !== entry.path
                          })
                        }}
                        onKeyDown={(event) => event.stopPropagation()}
                      >
                        <ControlIcon name="dots-three" />
                      </IconButton>
                    </div>
                  </>
                }
              />
            </div>
          ))}
          </div>
          {currentNameFilter?.status === 'success' && currentFilterListing?.entries.length === 0 && (
            <EmptyState
              message={`No files match “${query}”. Clear the filter to show all files.`}
              action={{ label: 'Clear filter', onAction: () => { void controlsRef.current?.run('clear-filter') } }}
            />
          )}
          {query.trim() === '' && rootListing !== null && rootListing.entries.length === 0 && !treeLoading && (
            <EmptyState message="No files in this folder." />
          )}
          {newItemKind && (
            <div className="qe-explorer-inline-row" ref={newItemRowRef}>
              <TextField
                className="qe-explorer-inline-field"
                label={newItemKind === 'file' ? 'New file name' : 'New folder name'}
                autoFocus
                value={newItemName}
                onChange={(event) => setNewItemName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void controlsRef.current?.run('create') }
                  if (event.key === 'Escape') { void controlsRef.current?.run('cancel-create') }
                }}
                onBlur={() => {
                  if (Date.now() - inlineOpenedAt.current < 200) return
                  if (inlineBlurTimer.current !== undefined) window.clearTimeout(inlineBlurTimer.current)
                  const controls = controlsRef.current
                  inlineBlurTimer.current = window.setTimeout(() => {
                    void controls?.run('create')
                  }, 150)
                }}
              />
              <Button variant="primary" disabled={itemBusy} onClick={() => { void controlsRef.current?.run('create') }}>Create</Button>
              <Button onClick={() => { void controlsRef.current?.run('cancel-create') }}>Cancel</Button>
            </div>
          )}
          {renamePath !== null && (
            <div className="qe-explorer-inline-row" ref={renameRowRef}>
              <input
                ref={renameInputRef}
                className="ui-text-field__input qe-explorer-inline-field"
                autoFocus
                aria-label="Rename file"
                value={renameValue}
                onChange={(event) => setRenameValue(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); void controlsRef.current?.run('rename') }
                  if (event.key === 'Escape') { void controlsRef.current?.run('cancel-rename') }
                }}
              />
              <Button variant="primary" disabled={renameBusy} onClick={() => { void controlsRef.current?.run('rename') }}>Rename</Button>
              <Button onClick={() => { void controlsRef.current?.run('cancel-rename') }}>Cancel</Button>
            </div>
          )}
          {currentFilterListing?.truncated && <p className="muted">More matches may be available.</p>}
        </div>
      ) : (
        <div className="qe-explorer-content-results">
          {!query.trim() && <p className="muted">Type to search in files</p>}
          {query.trim() && !searchResult && <p className="muted">Press Enter to search</p>}
          {searchResult?.loading && <NoticeLine>Searching files…</NoticeLine>}
          {searchResult?.error && <InlineError message={searchResult.error} />}
          {searchResult && !searchResult.loading && !searchResult.error && searchResult.totalMatches === 0 && (
            <EmptyState message="No results" />
          )}
          {searchResult && !searchResult.loading && !searchResult.error && searchResult.totalMatches > 0 && <p>
            {`${searchResult.totalMatches} result${searchResult.totalMatches === 1 ? '' : 's'} in ${searchResult.files.length} file${searchResult.files.length === 1 ? '' : 's'}`}
            {searchResult.truncated ? ' (results truncated)' : ''}
          </p>}
          {searchResult?.files.map((file) => (
            <section className="qe-search-file" key={file.path}>
              <h4>{file.relativePath}</h4>
              {file.matches.map((match, index) => {
                const start = (match.displayColumn ?? match.column) - 1
                const end = start + (match.displayMatchLength ?? match.matchLength)
                return (
                  <Button key={`${match.line}:${match.column}:${index}`} onClick={() => void openFile(file.path, { preview: false, line: match.line, column: match.column, matchLength: match.matchLength })}>
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
        {selectionActions}
      </footer>
      {rootListing?.truncated && <p className="muted">More files may be available.</p>}
      {state?.explorer.expanded.length === 0 && expanded.size > 0 && <span className="sr-only">Expanded folders are open.</span>}
    </section>
      {rowAction && (
        <PopupMenu
          key={rowAction.entry.path}
          anchor={rowAction.anchor}
          title={`Actions for ${rowAction.entry.name}`}
          items={[
            { id: 'new-file', label: 'New File', onSelect: () => { void controlsRef.current?.run('new-file', { directory: rowAction.entry.isDirectory ? rowAction.entry.path : '.' }) } },
            { id: 'new-folder', label: 'New Folder', onSelect: () => { void controlsRef.current?.run('new-folder', { directory: rowAction.entry.isDirectory ? rowAction.entry.path : '.' }) } },
            { id: 'copy-path', label: 'Copy Path', onSelect: () => { void controlsRef.current?.run('copy-path', { paths: [rowAction.entry.path], relative: false }) } },
            { id: 'copy-relative-path', label: 'Copy Relative Path', onSelect: () => { void controlsRef.current?.run('copy-path', { paths: [rowAction.entry.path], relative: true }) } },
            ...(!rowAction.entry.isDirectory ? [{ id: 'duplicate', label: 'Duplicate', onSelect: () => { void duplicatePath(rowAction.entry.path) } }] : []),
            { id: 'rename', label: 'Rename', onSelect: () => { void controlsRef.current?.run('rename-start', { path: rowAction.entry.path }) } },
            { id: 'delete', label: 'Delete', danger: true, onSelect: () => { void deleteSelected([rowAction.entry.path]) } },
            ...(rowAction.entry.isDirectory ? [
              { id: 'open-in-terminal', label: 'Open in Terminal', onSelect: () => { void openInTerminal(rowAction.entry.path) } },
              { id: 'find-in-folder', label: 'Find in Folder', onSelect: () => { void controlsRef.current?.run('search-in-files', { directory: rowAction.entry.path }) } }
            ] : []),
            ...(!rowAction.entry.isDirectory && rowAction.entry.name.toLowerCase().endsWith('.md') ? [
              { id: 'open-markdown-preview', label: 'Open Markdown Preview', onSelect: () => { void openMarkdownPreview(rowAction.entry.path) } }
            ] : [])
          ]}
          onClose={() => { void controlsRef.current?.run('menu-close') }}
        />
      )}
    </ToolPanelFrame>
  )
}
