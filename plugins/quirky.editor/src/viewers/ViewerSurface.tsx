import { Badge, Button, EmptyState, InlineError, NoticeLine, TextField } from '@quirky/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import type { SurfaceProps } from '../types'
import { useEditorUiControl, type EditorUiControl } from '../window/uiControl'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href

const MAX_FILE_BYTES = 50 * 1024 * 1024
const PAGE_PRELOAD_BYTES = 256 * 1024

const CSV_EDITABLE_ACTIONS = ['save', 'add-row', 'add-column', 'edit', 'delete-row', 'delete-column', 'delimiter', 'filter', 'sort', 'paste', 'copy', 'copy-range']
const CSV_READ_ONLY_BLOCKED_ACTIONS: Record<string, true> = {
  save: true,
  'add-row': true,
  'add-column': true,
  edit: true,
  'delete-row': true,
  'delete-column': true,
  delimiter: true,
  filter: true,
  sort: true,
  paste: true,
  copy: true,
  'copy-range': true
}
const CSV_CONTROL_FIELDS: Record<string, readonly string[]> = {
  retry: [],
  reload: [],
  'previous-page': [],
  'next-page': [],
  save: [],
  'add-row': [],
  'add-column': [],
  edit: ['row', 'column', 'value'],
  'delete-row': ['row'],
  'delete-column': ['column'],
  delimiter: ['delimiter'],
  filter: ['query'],
  sort: ['column', 'order'],
  paste: ['row', 'column', 'text'],
  copy: ['row', 'column', 'endRow', 'endColumn'],
  'copy-range': ['row', 'column', 'endRow', 'endColumn']
}
const CSV_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  edit: ['row', 'column', 'value'],
  'delete-row': ['row'],
  'delete-column': ['column'],
  delimiter: ['delimiter'],
  filter: ['query'],
  sort: ['column']
}

type ApiRecord = Record<string, unknown>
type CsvRow = { index: number; cells: string[] }
type ViewerMetadata = {
  kind?: string
  format?: string
  size?: number
  bytes?: number
  width?: number
  height?: number
  zoom?: number | 'page-width'
  page?: number
  offset?: number
  readOnly?: boolean
  paged?: boolean
  previewable?: boolean
  error?: string | null
  message?: string | null
  changedOnDisk?: boolean
  contentType?: string
  delimiter?: string
  nextPage?: number | null
  rows?: number | null
  columns?: number | null
  limits?: Record<string, number>
}

function object(value: unknown): ApiRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {}
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function bytesLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}



async function call(props: SurfaceProps, action: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  return props.onAction('quirky.editor/viewer', { bufferId: props.buffer.id, action, ...fields })
}

const VIEWER_SURFACE = 'view:quirky.editor/document'

function viewerIdentity(props: SurfaceProps): string {
  return JSON.stringify([props.buffer.id, props.buffer.tabId])
}

function viewerGeneration(props: SurfaceProps, mountId: string, scope: string): string {
  return JSON.stringify([mountId, props.buffer.id, props.buffer.tabId, props.buffer.path, props.buffer.worktreeId, scope])
}

function viewerAddress(props: SurfaceProps, target: string, generation: string, actions: string[]) {
  return {
    surface: VIEWER_SURFACE,
    target: `${target}:${viewerIdentity(props)}`,
    generation,
    actions
  }
}

function errorMessage(cause: unknown, fallback = 'Viewer operation failed.'): string {
  return cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallback
}

function controlData(control: EditorUiControl, allowed: readonly string[], required: readonly string[] = []): ApiRecord | null {
  const data = control.data ?? {}
  if (Reflect.ownKeys(data).some((key) => typeof key !== 'string' || !allowed.includes(key))) return null
  if (required.some((key) => !Object.hasOwn(data, key))) return null
  return data
}

function safeIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function finiteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}


function SourceText({ props, value, label }: { props: SurfaceProps; value: string; label: string }) {
  return <textarea
    className="editor-viewer-source viewer-source"
    aria-label={label}
    spellCheck={false}
    value={value}
    onChange={(event) => props.onDraft(event.currentTarget.value)}
  />
}

function CsvSurface({
  props,
  sourceMode,
  retryToken,
  requestMode
}: {
  props: SurfaceProps
  sourceMode: boolean
  retryToken: number
  requestMode(value: 'source' | 'rich'): void
}) {
  const { buffer } = props
  const [mountId] = useState(() => crypto.randomUUID())
  const modeState = useRef({ mode: sourceMode, epoch: 0 })
  if (modeState.current.mode !== sourceMode) {
    modeState.current = { mode: sourceMode, epoch: modeState.current.epoch + 1 }
  }
  const sessionKey = viewerGeneration(props, mountId, `csv:${modeState.current.epoch}`)
  const currentSession = useRef(sessionKey)
  currentSession.current = sessionKey
  const readSequence = useRef(0)
  const filterSequence = useRef(0)
  const draftRef = useRef<Record<string, string>>({})
  const committedCells = useRef(new Map<string, Promise<void>>())
  const previousSession = useRef(sessionKey)
  if (previousSession.current !== sessionKey) {
    previousSession.current = sessionKey
    readSequence.current += 1
    filterSequence.current += 1
    committedCells.current.clear()
  }
  const [metadata, setMetadata] = useState<ViewerMetadata | null>(null)
  const metadataRef = useRef<ViewerMetadata | null>(null)
  const restoredView = object(buffer.view.viewer)
  const [page, setPage] = useState(Math.max(0, (number(restoredView.page) ?? 1) - 1))
  const pageRef = useRef(page)
  pageRef.current = page
  const [rows, setRows] = useState<CsvRow[]>([])
  const [nextPage, setNextPage] = useState<number | null>(null)
  const [filter, setFilter] = useState(typeof restoredView.filter === 'string' ? restoredView.filter : '')
  const filterRef = useRef(filter)
  filterRef.current = filter
  const restoredSort = object(restoredView.sort)
  const [sort, setSort] = useState<{ column: number; order: 'asc' | 'desc' } | null>(
    typeof restoredSort.column === 'number' && (restoredSort.order === 'asc' || restoredSort.order === 'desc')
      ? { column: restoredSort.column, order: restoredSort.order }
      : null
  )
  const [delimiter, setDelimiter] = useState(typeof restoredView.delimiter === 'string' ? restoredView.delimiter : ',')
  const [pasteText, setPasteText] = useState('')
  const [pasteAt, setPasteAt] = useState({ row: 0, column: 0 })
  const [cellDrafts, setCellDrafts] = useState<Record<string, string>>({})
  draftRef.current = cellDrafts
  const [copyRange, setCopyRange] = useState({ row: '', column: '', endRow: '', endColumn: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const [coordinateEpoch, setCoordinateEpoch] = useState(0)
  const filterInputId = useId()

  const refresh = useCallback(async (targetPage = pageRef.current, throwError = false, includeMetadata = true) => {
    if (sourceMode) return
    const requestId = ++readSequence.current
    const requestSession = sessionKey
    const isCurrent = () => currentSession.current === requestSession && readSequence.current === requestId
    setLoading(true)
    setError(null)
    try {
      let info = metadataRef.current
      if (includeMetadata || info === null) {
        metadataRef.current = null
        info = object(await call(props, 'metadata')) as ViewerMetadata
        if (!isCurrent()) return
        metadataRef.current = info
        setMetadata(info)
      }
      setChanged(info.changedOnDisk === true)
      if (info.error) {
        metadataRef.current = null
        setRows([])
        setNextPage(null)
        setError(info.error)
        if (throwError) throw new Error(info.error)
        return
      }
      if (info.changedOnDisk === true) {
        setRows([])
        setNextPage(null)
        return
      }
      const pageResult = object(await call(props, 'page', { page: targetPage }))
      if (!isCurrent()) return
      if (pageResult.changedOnDisk === true) {
        setChanged(true)
        setRows([])
        setNextPage(null)
        return
      }
      const pageRows = Array.isArray(pageResult.rows)
        ? pageResult.rows.flatMap((value): CsvRow[] => {
          const row = object(value)
          return safeIndex(row.index) && Array.isArray(row.cells) && row.cells.every((cell) => typeof cell === 'string')
            ? [{ index: row.index, cells: row.cells as string[] }]
            : []
        })
        : []
      setRows(pageRows)
      setNextPage(safeIndex(pageResult.nextPage) ? pageResult.nextPage : null)
      if (typeof pageResult.delimiter === 'string') setDelimiter(pageResult.delimiter)
      if (info.paged === true && typeof pageResult.offset === 'number' && Number.isFinite(pageResult.offset) && isCurrent()) {
        await call(props, 'position', { page: targetPage + 1, offset: pageResult.offset })
      }
    } catch (cause) {
      if (isCurrent()) setError(errorMessage(cause))
      if (throwError && isCurrent()) throw cause
    } finally {
      if (isCurrent()) setLoading(false)
    }
  }, [props, sessionKey, sourceMode])

  const refreshRef = useRef(refresh)
  refreshRef.current = refresh
  useEffect(() => {
    if (sourceMode) return
    currentSession.current = sessionKey
    void refreshRef.current(pageRef.current)
    return () => {
      readSequence.current += 1
      filterSequence.current += 1
      if (currentSession.current === sessionKey) currentSession.current = ''
    }
  }, [buffer.contentRevision, sessionKey, sourceMode])
  const lastRetryToken = useRef(retryToken)
  useEffect(() => {
    if (lastRetryToken.current === retryToken) return
    lastRetryToken.current = retryToken
    if (!sourceMode) void refreshRef.current(pageRef.current, true, metadataRef.current === null).catch(() => {})
  }, [retryToken, sessionKey, sourceMode])
  const paged = buffer.size >= 1024 * 1024 || metadata?.paged === true
  const readOnly = buffer.readOnly === true || metadata?.readOnly === true || paged
  const isSessionCurrent = () => currentSession.current === sessionKey

  const updateDrafts = (next: Record<string, string>) => {
    draftRef.current = next
    setCellDrafts(next)
  }
  const commitCell = async (row: number, column: number, value: string) => {
    const key = `${row}:${column}`
    const pending = committedCells.current.get(key)
    if (pending) return pending
    const currentRow = rows.find((item) => item.index === row)
    if (!Object.hasOwn(draftRef.current, key) && currentRow?.cells[column] === value) return
    const operation = (async () => {
      await call(props, 'edit', { row, column, value })
      if (!isSessionCurrent()) return
      if (draftRef.current[key] === value) {
        const next = { ...draftRef.current }
        delete next[key]
        updateDrafts(next)
      }
    })()
    committedCells.current.set(key, operation)
    try {
      await operation
    } finally {
      if (committedCells.current.get(key) === operation) committedCells.current.delete(key)
    }
  }

  const applyPendingCells = async () => {
    while (Object.keys(draftRef.current).length > 0) {
      for (const [key, value] of Object.entries(draftRef.current)) {
        const [row, column] = key.split(':').map(Number)
        if (!safeIndex(row) || !safeIndex(column)) throw new Error('CSV edit coordinates are invalid.')
        await commitCell(row, column, value)
        if (!isSessionCurrent()) return false
      }
    }
    return true
  }

  const saveTable = async () => {
    const applied = await applyPendingCells()
    if (!applied || !isSessionCurrent()) return
    await call(props, 'save')
    if (isSessionCurrent()) await refresh(pageRef.current, true)
  }

  const filterTail = useRef<Promise<void>>(Promise.resolve())
  const filterCommit = useCallback(async (query: string) => {
    const requestId = ++filterSequence.current
    const requestSession = sessionKey
    setLoading(true)
    setError(null)
    const apiOperation = filterTail.current.catch(() => {}).then(async () => {
      if (requestId !== filterSequence.current || currentSession.current !== requestSession) return false
      await call(props, 'filter', { query })
      return requestId === filterSequence.current && currentSession.current === requestSession
    })
    filterTail.current = apiOperation.then(() => {}, () => {})
    try {
      if (await apiOperation && requestId === filterSequence.current && currentSession.current === requestSession) {
        setFilter(query)
        filterRef.current = query
        setPage(0)
        pageRef.current = 0
        await refresh(0, true)
      }
    } catch (cause) {
      if (requestId === filterSequence.current && currentSession.current === requestSession) throw cause
    } finally {
      if (requestId === filterSequence.current && currentSession.current === requestSession) setLoading(false)
    }
  }, [props, refresh, sessionKey])

  const findRows = useCallback(async (args?: Record<string, unknown>) => {
    if (readOnly) throw new Error('Find is unavailable in read-only paged CSV previews.')
    const query = typeof args?.query === 'string' ? args.query : undefined
    if (query !== undefined && query.length > 8192) throw new Error('CSV filter query exceeds 8192 characters.')
    document.getElementById(filterInputId)?.focus()
    if (query === undefined) return { opened: true }
    await filterCommit(query)
    return { filtered: true, query }
  }, [filterInputId, filterCommit, readOnly])
  useEffect(() => props.registerCommandHandlers({ find: findRows }), [findRows, props.registerCommandHandlers])

  const sortColumn = async (column: number, requestedOrder?: unknown) => {
    const order = requestedOrder === undefined
      ? sort?.column === column && sort.order === 'asc' ? 'desc' : 'asc'
      : requestedOrder
    if (order !== 'asc' && order !== 'desc') throw new Error('CSV sort order must be asc or desc.')
    await call(props, 'sort', { column, order })
    if (isSessionCurrent()) {
      setSort({ column, order })
      await refresh(0, true)
    }
  }

  const insertRow = async () => {
    if (!await applyPendingCells() || !isSessionCurrent()) return
    const index = safeIndex(metadata?.rows) ? metadata.rows : rows.length ? rows.at(-1)!.index + 1 : 0
    await call(props, 'insertRow', { index, count: 1 })
    if (isSessionCurrent()) {
      updateDrafts({})
      setCoordinateEpoch((value) => value + 1)
      await refresh(pageRef.current, true)
    }
  }

  const insertColumn = async () => {
    if (!await applyPendingCells() || !isSessionCurrent()) return
    const columns = safeIndex(metadata?.columns) ? metadata.columns : Math.max(0, ...rows.map((row) => row.cells.length))
    await call(props, 'insertColumn', { index: columns, value: `Column ${columns + 1}` })
    if (isSessionCurrent()) {
      updateDrafts({})
      setCoordinateEpoch((value) => value + 1)
      await refresh(pageRef.current, true)
    }
  }

  const deleteRow = async (row: number) => {
    if (!await applyPendingCells() || !isSessionCurrent()) return
    await call(props, 'deleteRow', { row })
    if (isSessionCurrent()) {
      updateDrafts({})
      setCoordinateEpoch((value) => value + 1)
      await refresh(pageRef.current, true)
    }
  }

  const deleteColumn = async (column: number) => {
    if (!await applyPendingCells() || !isSessionCurrent()) return
    await call(props, 'deleteColumn', { index: column })
    if (isSessionCurrent()) {
      updateDrafts({})
      setCoordinateEpoch((value) => value + 1)
      await refresh(pageRef.current, true)
    }
  }

  const copyFields = (data: ApiRecord, useDisplayedRange: boolean): ApiRecord | null => {
    const supplied = ['row', 'column', 'endRow', 'endColumn'].filter((key) => Object.hasOwn(data, key))
    if (supplied.length === 0 && useDisplayedRange) {
      const values = [copyRange.row, copyRange.column, copyRange.endRow, copyRange.endColumn]
      if (values.some((value) => !/^\d+$/.test(value))) return null
      const [row, column, endRow, endColumn] = values.map(Number)
      if (![row, column, endRow, endColumn].every(Number.isSafeInteger)) return null
      return row <= endRow && column <= endColumn ? copyFields({ row, column, endRow, endColumn }, false) : null
    }
    const completeRange = ['row', 'column', 'endRow', 'endColumn'].every((key) => Object.hasOwn(data, key))
    if (useDisplayedRange && supplied.length > 0 && !completeRange) return null
    if ((supplied.includes('endRow') || supplied.includes('endColumn')) && !completeRange) return null
    if (supplied.length === 0) return null
    if (supplied.some((key) => !safeIndex(data[key]))) return null
    if (Object.hasOwn(data, 'row') && Object.hasOwn(data, 'endRow') && (data.row as number) > (data.endRow as number)) return null
    if (Object.hasOwn(data, 'column') && Object.hasOwn(data, 'endColumn') && (data.column as number) > (data.endColumn as number)) return null
    const totalRows = number(metadataRef.current?.rows)
    const totalColumns = number(metadataRef.current?.columns)
    for (const key of ['row', 'endRow']) {
      if (Object.hasOwn(data, key) && totalRows !== undefined && (data[key] as number) >= totalRows) return null
    }
    for (const key of ['column', 'endColumn']) {
      if (Object.hasOwn(data, key) && totalColumns !== undefined && (data[key] as number) >= totalColumns) return null
    }
    return Object.fromEntries(supplied.map((key) => [key, data[key]]))
  }

  const copySelection = async (fields: ApiRecord) => {
    if (Object.keys(draftRef.current).length > 0) throw new Error('Apply or save pending cell edits before copying.')
    const result = object(await call(props, 'copy', fields))
    if (!isSessionCurrent()) return
    if (typeof result.text !== 'string') throw new Error('The viewer did not return clipboard text.')
    if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard access is unavailable.')
    await navigator.clipboard.writeText(result.text)
  }

  const pasteCells = async (data: ApiRecord) => {
    const row = Object.hasOwn(data, 'row') ? data.row : pasteAt.row
    const column = Object.hasOwn(data, 'column') ? data.column : pasteAt.column
    const text = Object.hasOwn(data, 'text') ? data.text : pasteText
    if (!safeIndex(row) || !safeIndex(column) || typeof text !== 'string') throw new Error('CSV paste needs valid source coordinates and text.')
    if (new TextEncoder().encode(text).byteLength >= 1024 * 1024) throw new Error('CSV paste must be smaller than 1 MiB.')
    await call(props, 'paste', { row, column, text })
    if (isSessionCurrent()) {
      setPasteText('')
      await refresh(pageRef.current, true)
    }
  }

  const reload = async () => {
    if (!changed && buffer.external !== 'changed') return
    await props.onAction('quirky.editor/view', { bufferId: buffer.id, action: 'reload' })
    if (!isSessionCurrent()) return
    setPage(0)
    pageRef.current = 0
    setChanged(false)
    metadataRef.current = null
    await refresh(0, true)
  }

  const busyActions = useRef(new Set<string>())
  const coordinateBusy = useRef(false)
  const coordinateSession = useRef(sessionKey)
  if (coordinateSession.current !== sessionKey) {
    coordinateSession.current = sessionKey
    coordinateBusy.current = false
    busyActions.current.clear()
  }
  const csvActions = [
    ...(sourceMode ? [] : ['retry']),
    ...(!sourceMode && (changed || buffer.external === 'changed') ? ['reload'] : []),
    ...(!sourceMode && page > 0 ? ['previous-page'] : []),
    ...(!sourceMode && nextPage !== null && nextPage > page ? ['next-page'] : []),
    ...(!sourceMode && !readOnly && metadata !== null ? CSV_EDITABLE_ACTIONS : [])
  ]
  const handleControl = async (control: EditorUiControl) => {
    if (!isSessionCurrent()) return { delivered: false }
    const allowed = CSV_CONTROL_FIELDS[control.action]
    if (!allowed) return { delivered: false }
    const data = controlData(control, allowed, CSV_REQUIRED_FIELDS[control.action] ?? [])
    if (!data) return { delivered: false }
    if (sourceMode || (readOnly || metadata === null) && CSV_READ_ONLY_BLOCKED_ACTIONS[control.action] === true) return { delivered: false }
    if (control.action === 'reload' && !changed && buffer.external !== 'changed') return { delivered: false }
    if (control.action === 'previous-page' && pageRef.current <= 0) return { delivered: false }
    if (control.action === 'next-page' && (nextPage === null || nextPage <= pageRef.current)) return { delivered: false }
    const column = data.column
    if (control.action === 'edit' &&
      (!safeIndex(data.row) || !safeIndex(column) || typeof data.value !== 'string' ||
        !rows.some((row) => row.index === data.row && row.index !== 0 && column < row.cells.length))) return { delivered: false }
    if (control.action === 'delete-row' &&
      (!safeIndex(data.row) || !rows.some((row) => row.index === data.row && row.index !== 0))) return { delivered: false }
    if (control.action === 'delete-column' &&
      (!safeIndex(data.column) || data.column >= Math.max(0, ...rows.map((row) => row.cells.length)))) return { delivered: false }
    if (control.action === 'sort' &&
      (!safeIndex(data.column) || data.column >= Math.max(0, ...rows.map((row) => row.cells.length)) ||
        data.order !== undefined && data.order !== 'asc' && data.order !== 'desc')) return { delivered: false }
    if (control.action === 'delimiter' && (typeof data.delimiter !== 'string' || ![',', '\t', ';', '|'].includes(data.delimiter))) return { delivered: false }
    if (control.action === 'filter' && (typeof data.query !== 'string' || data.query.length > 8192)) return { delivered: false }
    if (control.action === 'paste') {
      const row = Object.hasOwn(data, 'row') ? data.row : pasteAt.row
      const column = Object.hasOwn(data, 'column') ? data.column : pasteAt.column
      const text = Object.hasOwn(data, 'text') ? data.text : pasteText
      if (!safeIndex(row) || !safeIndex(column) || typeof text !== 'string' ||
        new TextEncoder().encode(text).byteLength >= 1024 * 1024) return { delivered: false }
      const totalRows = number(metadataRef.current?.rows)
      const totalColumns = number(metadataRef.current?.columns)
      if (totalRows !== undefined && row > totalRows || totalColumns !== undefined && column > totalColumns) return { delivered: false }
    }
    if ((control.action === 'copy' || control.action === 'copy-range') &&
      !copyFields(data, control.action === 'copy-range')) return { delivered: false }
    const coordinateActions = ['edit', 'delete-row', 'delete-column', 'add-row', 'add-column', 'save', 'sort', 'paste', 'copy', 'copy-range']
    const structuralActions = ['delete-row', 'delete-column', 'add-row', 'add-column']
    if (coordinateBusy.current && coordinateActions.includes(control.action)) return { delivered: false }
    if (structuralActions.includes(control.action) && coordinateActions.some((action) => busyActions.current.has(action))) return { delivered: false }
    const trackBusy = control.action !== 'filter'
    if (trackBusy && busyActions.current.has(control.action)) return { delivered: false }
    if (trackBusy) busyActions.current.add(control.action)
    const structural = structuralActions.includes(control.action)
    if (structural) coordinateBusy.current = true
    if (control.action !== 'filter') {
      setError(null)
      setLoading(true)
    }
    try {
      switch (control.action) {
        case 'retry':
          await refresh(pageRef.current, true, metadataRef.current === null)
          break
        case 'reload':
          await reload()
          break
        case 'previous-page': {
          const target = pageRef.current - 1
          setPage(target)
          pageRef.current = target
          await refresh(target, true, false)
          break
        }
        case 'next-page': {
          const target = nextPage!
          setPage(target)
          pageRef.current = target
          await refresh(target, true, false)
          break
        }
        case 'save':
          await saveTable()
          break
        case 'add-row':
          await insertRow()
          break
        case 'add-column':
          await insertColumn()
          break
        case 'edit':
          await commitCell(data.row as number, data.column as number, data.value as string)
          if (isSessionCurrent()) await refresh(pageRef.current, true, false)
          break
        case 'delete-row':
          await deleteRow(data.row as number)
          break
        case 'delete-column':
          await deleteColumn(data.column as number)
          break
        case 'delimiter':
          await call(props, 'delimiter', { delimiter: data.delimiter })
          if (isSessionCurrent()) {
            setDelimiter(data.delimiter as string)
            await refresh(0, true)
          }
          break
        case 'filter':
          await filterCommit(data.query as string)
          break
        case 'sort':
          await sortColumn(data.column as number, data.order)
          break
        case 'paste':
          await pasteCells(data)
          break
        case 'copy': {
          const fields = copyFields(data, false)
          if (!fields) return { delivered: false }
          await copySelection(fields)
          break
        }
        case 'copy-range': {
          const fields = copyFields(data, true)
          if (!fields) return { delivered: false }
          await copySelection(fields)
          break
        }
      }
      return { delivered: isSessionCurrent() }
    } catch (cause) {
      if (isSessionCurrent()) setError(errorMessage(cause))
      throw cause
    } finally {
      if (trackBusy && isSessionCurrent()) busyActions.current.delete(control.action)
      if (structural && isSessionCurrent()) coordinateBusy.current = false
      if (control.action !== 'filter' && isSessionCurrent()) setLoading(false)
    }
  }
  const controlError = useCallback((cause: Error) => setError(cause.message), [])
  const controls = useEditorUiControl({
    context: props.context,
    address: csvActions.length > 0
      ? viewerAddress(props, 'csv', viewerGeneration(props, mountId, `csv:${modeState.current.epoch}:${coordinateEpoch}`), csvActions)
      : null,
    handler: handleControl,
    onError: controlError
  })

  const request = (action: string, data?: Record<string, unknown>) => { void controls.run(action, data) }
  const changeFilter = (value: string) => {
    setFilter(value)
    filterRef.current = value
    request('filter', { query: value })
  }
  const copyCell = (row: number, column: number) => request('copy', { row, column })
  const copySelectedRange = () => request('copy-range')
  const requestReload = () => request('reload')
  const requestPage = (action: 'previous-page' | 'next-page') => request(action)

  if (sourceMode) {
    if (buffer.size >= 1024 * 1024) return <section className="viewer-empty" aria-label="Large CSV source">
      <EmptyState
        message="Large CSV files are read-only and shown in bounded pages. Use the table preview to browse records."
        action={{ label: 'Return to Table', onAction: () => requestMode('rich') }}
      />
    </section>
    return <SourceText props={props} value={buffer.draft !== null ? buffer.draft : buffer.content} label="CSV source" />
  }

  const header = rows.find((row) => row.index === 0)?.cells ?? []
  const dataRows = rows.filter((row) => row.index !== 0)
  const changedBanner = (changed || buffer.external === 'changed') && <p role="status">CSV changed on disk. Reload the file to refresh the preview. <Button type="button" onClick={requestReload} disabled={loading}>Reload</Button></p>

  return <section className="viewer-csv" aria-label={paged ? 'Paged CSV preview' : 'CSV table'} style={{ fontSize: props.fontSize }}>
    <header className="viewer-toolbar">
      <Badge tone={paged ? 'needs-you' : 'neutral'}>{paged ? 'Read-only paged preview' : `${metadata?.rows ?? rows.length} rows · ${metadata?.columns ?? header.length} columns`}</Badge>
      {!readOnly && <>
        <Button type="button" variant="primary" onClick={() => request('save')} disabled={loading}>Save</Button>
        <Button type="button" onClick={() => request('add-row')} disabled={loading}>Add row</Button>
        <Button type="button" onClick={() => request('add-column')} disabled={loading}>Add column</Button>
        <select className="editor-viewer-select" aria-label="Delimiter" value={delimiter} onChange={(event) => request('delimiter', { delimiter: event.currentTarget.value })} disabled={loading}>
          <option value=",">Comma</option><option value="\t">Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option>
        </select>
        <TextField id={filterInputId} label="Filter rows" value={filter} onChange={(event) => changeFilter(event.currentTarget.value)} />
        <details className="viewer-csv-advanced">
          <summary className="qe-disclosure-trigger">Paste and copy range</summary>
          <div className="viewer-csv-advanced__body">
            <textarea className="editor-viewer-source viewer-paste" aria-label="Paste CSV cells" value={pasteText} onChange={(event) => setPasteText(event.currentTarget.value)} placeholder="Paste CSV or tab-separated cells" />
            <TextField label="Paste row" type="number" min="0" value={pasteAt.row} onChange={(event) => { const value = Number(event.currentTarget.value); setPasteAt((old) => ({ ...old, row: value })) }} />
            <TextField label="Paste column" type="number" min="0" value={pasteAt.column} onChange={(event) => { const value = Number(event.currentTarget.value); setPasteAt((old) => ({ ...old, column: value })) }} />
            <Button type="button" onClick={() => request('paste', { row: pasteAt.row, column: pasteAt.column, text: pasteText })} disabled={loading}>Paste</Button>
            <fieldset className="viewer-copy-range">
              <legend>Copy rectangular range (zero-based source coordinates)</legend>
              <TextField label="Start row (source index)" aria-label="Copy range start row (source index)" type="number" min="0" step="1" value={copyRange.row} onChange={(event) => { const value = event.currentTarget.value; setCopyRange((old) => ({ ...old, row: value })) }} />
              <TextField label="Start column (source index)" aria-label="Copy range start column (source index)" type="number" min="0" step="1" value={copyRange.column} onChange={(event) => { const value = event.currentTarget.value; setCopyRange((old) => ({ ...old, column: value })) }} />
              <TextField label="End row (source index)" aria-label="Copy range end row (source index)" type="number" min="0" step="1" value={copyRange.endRow} onChange={(event) => { const value = event.currentTarget.value; setCopyRange((old) => ({ ...old, endRow: value })) }} />
              <TextField label="End column (source index)" aria-label="Copy range end column (source index)" type="number" min="0" step="1" value={copyRange.endColumn} onChange={(event) => { const value = event.currentTarget.value; setCopyRange((old) => ({ ...old, endColumn: value })) }} />
              <Button type="button" onClick={copySelectedRange} disabled={loading}>Copy range</Button>
            </fieldset>
          </div>
        </details>
      </>}
    </header>
    {changedBanner}
    {error && <InlineError message={error} action={{ label: 'Retry', onAction: () => request('retry') }} />}
    {metadata?.limits && metadata.paged && <p>Limits: {metadata.limits.maxColumns} columns · {bytesLabel(metadata.limits.maxRecordBytes ?? 0)} per record · {metadata.limits.maxCachedPages} cached pages</p>}
    {loading && <div role="status"><NoticeLine>Loading CSV page…</NoticeLine></div>}
    {!loading && !error && dataRows.length === 0 && <EmptyState
      message={paged ? 'No rows on this page.' : filter ? `No rows match “${filter}”.` : 'No CSV rows.'}
      action={!paged && filter ? { label: 'Clear filter', onAction: () => request('filter', { query: '' }) } : undefined}
    />}
    <div className="viewer-table-scroll">
      <table className="viewer-table">
        {header.length > 0 && <thead><tr>{header.map((title, column) => <th key={column}>
          <Button type="button" onClick={() => request('sort', { column })} disabled={readOnly || loading}>{title || `Column ${column + 1}`}</Button>
          {!readOnly && <Button type="button" aria-label={`Copy column ${column} (source index)`} onClick={() => request('copy', { column })} disabled={loading}>Copy column</Button>}
          {!readOnly && <Button type="button" variant="destructive" aria-label={`Delete column ${column + 1}`} onClick={() => request('delete-column', { column })} disabled={loading}>Delete column</Button>}
        </th>)}{!readOnly && <th><Button type="button" aria-label="Copy row 0 (source index)" onClick={() => request('copy', { row: 0 })} disabled={loading}>Copy row 0</Button></th>}</tr></thead>}
        <tbody>{dataRows.map((row) => <tr key={row.index}>
          {row.cells.map((cell, column) => <td key={column} onDoubleClick={() => { if (!readOnly) copyCell(row.index, column) }}>
            {readOnly ? <span>{cell}</span> : <input
              className="viewer-cell-input"
              aria-label={`Row ${row.index + 1}, column ${column + 1}`}
              disabled={loading}
              value={cellDrafts[`${row.index}:${column}`] ?? cell}
              onChange={(event) => {
                const value = event.currentTarget.value
                updateDrafts({ ...draftRef.current, [`${row.index}:${column}`]: value })
              }}
              onBlur={(event) => {
                const value = event.currentTarget.value
                if (value === cell) {
                  const next = { ...draftRef.current }
                  delete next[`${row.index}:${column}`]
                  updateDrafts(next)
                  return
                }
                request('edit', { row: row.index, column, value })
              }}
            />}
            <Button type="button" onClick={() => copyCell(row.index, column)} disabled={readOnly || loading}>Copy cell</Button>
          </td>)}
          {!readOnly && <td>
            <Button type="button" aria-label={`Copy row ${row.index} (source index)`} onClick={() => request('copy', { row: row.index })} disabled={loading}>Copy row</Button>
            <Button type="button" variant="destructive" onClick={() => request('delete-row', { row: row.index })} disabled={loading}>Delete row</Button>
          </td>}
        </tr>)}</tbody>
      </table>
    </div>
    {paged && <nav className="viewer-pages" aria-label="CSV pages">
      <Button type="button" onClick={() => requestPage('previous-page')} disabled={page === 0 || loading}>Previous page</Button>
      <span>Page {page + 1}</span>
      <Button type="button" onClick={() => requestPage('next-page')} disabled={nextPage === null || loading}>Next page</Button>
    </nav>}
  </section>
}

function MediaActions({ onOpenDefault }: { onOpenDefault(): void }) {
  return <div className="viewer-media-actions">
    <Button type="button" onClick={onOpenDefault}>Open in Default App</Button>
  </div>
}

function ImageViewer({
  props,
  metadata,
  url,
  error,
  generation,
  onRetry,
  onOpenDefault
}: {
  props: SurfaceProps
  metadata: ViewerMetadata
  url: string | null
  error: string | null
  generation: string
  onRetry(): void
  onOpenDefault(): void
}) {
  const initialZoom = typeof metadata.zoom === 'number' ? metadata.zoom : number(object(props.buffer.view.viewer).zoom) ?? 1
  const [zoom, setZoom] = useState(initialZoom)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom
  const [imageLoaded, setImageLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const touchDistance = useRef<number | null>(null)
  const generationRef = useRef(generation)
  generationRef.current = generation
  const zoomSequence = useRef(0)
  const ready = Boolean(url) && metadata.previewable !== false && !error

  useEffect(() => {
    setZoom(initialZoom)
    zoomRef.current = initialZoom
    setImageLoaded(false)
    setLoadError(null)
  }, [initialZoom, props.buffer.id, url, generation])

  const applyZoom = useCallback(async (value: number) => {
    if (!ready || !imageLoaded || loadError) {
      throw new Error(error ?? loadError ?? (metadata.error as string | undefined) ?? 'Image preview is not ready to zoom.')
    }
    if (!finiteNumber(value)) throw new Error('Image zoom scale must be a finite number.')
    const requestedScale = Math.min(8, Math.max(0.25, value))
    const requestId = ++zoomSequence.current
    try {
      const result = object(await call(props, 'zoom', { scale: requestedScale }))
      if (generationRef.current !== generation || zoomSequence.current !== requestId) return { zoom: zoomRef.current }
      const nextZoom = Math.min(8, Math.max(0.25, number(result.zoom) ?? requestedScale))
      zoomRef.current = nextZoom
      setZoom(nextZoom)
      return { zoom: nextZoom }
    } catch (cause) {
      if (generationRef.current === generation && zoomSequence.current === requestId) setLoadError(errorMessage(cause))
      throw cause
    }
  }, [error, generation, imageLoaded, loadError, metadata.error, props, ready])

  const handleControl = async (control: EditorUiControl) => {
    if (generationRef.current !== generation || !ready || !imageLoaded || loadError) return { delivered: false }
    const fields = control.action === 'zoom' ? ['scale'] : []
    if (!['zoom', 'zoom-in', 'zoom-out', 'reset-zoom'].includes(control.action)) return { delivered: false }
    const data = controlData(control, fields, control.action === 'zoom' ? ['scale'] : [])
    if (!data) return { delivered: false }
    if (control.action === 'zoom' && !finiteNumber(data.scale)) return { delivered: false }
    if (control.action === 'zoom-in' && zoomRef.current >= 8) return { delivered: false }
    if (control.action === 'zoom-out' && zoomRef.current <= 0.25) return { delivered: false }
    try {
      const requested = control.action === 'zoom' ? data.scale as number :
        control.action === 'zoom-in' ? zoomRef.current * 1.25 :
          control.action === 'zoom-out' ? zoomRef.current / 1.25 : 1
      await applyZoom(requested)
      return { delivered: generationRef.current === generation }
    } catch (cause) {
      if (generationRef.current === generation) setLoadError(errorMessage(cause))
      throw cause
    }
  }
  const controlError = useCallback((cause: Error) => setLoadError(cause.message), [])
  const controls = useEditorUiControl({
    context: props.context,
    address: ready && imageLoaded && !loadError
      ? viewerAddress(props, 'image', generation, ['zoom', 'zoom-in', 'zoom-out', 'reset-zoom'])
      : null,
    handler: handleControl,
    onError: controlError
  })
  useEffect(() => props.registerCommandHandlers({
    'zoom-in': () => applyZoom(zoomRef.current * 1.25),
    'zoom-out': () => applyZoom(zoomRef.current / 1.25),
    'reset-zoom': () => applyZoom(1)
  }), [applyZoom, props.registerCommandHandlers])

  const requestZoom = (scale: number) => { void controls.run('zoom', { scale }) }
  return <section className="viewer-image" aria-label="Image preview" onWheel={(event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    requestZoom(zoomRef.current * (event.deltaY < 0 ? 1.25 : 0.8))
  }} onTouchStart={(event) => {
    if (event.touches.length === 2) {
      const dx = event.touches[0]!.clientX - event.touches[1]!.clientX
      const dy = event.touches[0]!.clientY - event.touches[1]!.clientY
      touchDistance.current = Math.hypot(dx, dy)
    }
  }} onTouchMove={(event) => {
    if (event.touches.length !== 2 || touchDistance.current === null) return
    const dx = event.touches[0]!.clientX - event.touches[1]!.clientX
    const dy = event.touches[0]!.clientY - event.touches[1]!.clientY
    const distance = Math.hypot(dx, dy)
    const ratio = distance / touchDistance.current
    if (Number.isFinite(ratio) && Math.abs(ratio - 1) > 0.12) {
      touchDistance.current = distance
      requestZoom(zoomRef.current * ratio)
    }
  }} onTouchEnd={() => { touchDistance.current = null }}>
    <header className="viewer-toolbar">
      <Button type="button" onClick={() => void controls.run('zoom-out')} disabled={zoom <= 0.25 || !ready || !imageLoaded || Boolean(loadError)}>Zoom out</Button>
      <Button type="button" onClick={() => void controls.run('reset-zoom')} disabled={!ready || !imageLoaded || Boolean(loadError)}>Reset zoom</Button>
      <Button type="button" onClick={() => void controls.run('zoom-in')} disabled={zoom >= 8 || !ready || !imageLoaded || Boolean(loadError)}>Zoom in</Button>
      <span>{Math.round(zoom * 100)}%</span>
      <span>{metadata.width ?? '—'} × {metadata.height ?? '—'}</span>
      <span>{bytesLabel(metadata.bytes ?? props.buffer.size)}</span>
    </header>
    {loadError && !error && <><InlineError message={loadError} action={{ label: 'Retry', onAction: onRetry }} /><MediaActions onOpenDefault={onOpenDefault} /></>}
    {url && !loadError && !error && !imageLoaded && <div role="status"><NoticeLine>Loading image…</NoticeLine></div>}
    {url && !loadError && <img className="viewer-image__preview" src={url} alt={props.buffer.name} style={{ transform: `scale(${zoom})` }}
      onLoad={() => { if (generationRef.current === generation) setImageLoaded(true) }}
      onError={() => { if (generationRef.current === generation) setLoadError('Failed to load file preview.') }} />}
  </section>
}

function PdfViewer({
  props,
  url,
  error,
  generation,
  onRetry,
  onOpenDefault
}: {
  props: SurfaceProps
  url: string | null
  error: string | null
  generation: string
  onRetry(): void
  onOpenDefault(): void
}) {
  const restoredView = object(props.buffer.view.viewer)
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const pdfRef = useRef<PDFDocumentProxy | null>(null)
  const initialPage = Math.max(1, number(restoredView.page) ?? 1)
  const [page, setPage] = useState(initialPage)
  const pageRef = useRef(page)
  pageRef.current = page
  const restoredScale = number(restoredView.zoom)
  const [scale, setScale] = useState<number | 'page-width'>(
    restoredView.zoom === undefined ? 'page-width' : restoredScale === undefined ? 'page-width' : Math.min(5, Math.max(0.25, restoredScale))
  )
  const scaleRef = useRef(scale)
  scaleRef.current = scale
  const [query, setQuery] = useState('')
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [documentLoading, setDocumentLoading] = useState(Boolean(url))
  const [rendering, setRendering] = useState(false)
  const [containerWidth, setContainerWidth] = useState(800)
  const container = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const scrollTimer = useRef<number | undefined>(undefined)
  const searchSequence = useRef(0)
  const pageSequence = useRef(0)
  const scaleSequence = useRef(0)
  const pageQueue = useRef<Promise<void>>(Promise.resolve())
  const generationRef = useRef(generation)
  generationRef.current = generation
  const propsRef = useRef(props)
  propsRef.current = props
  const searchInputId = useId()
  const isCurrent = useCallback(() => generationRef.current === generation, [generation])

  useEffect(() => {
    if (!url) {
      pdfRef.current = null
      setPdf(null)
      setDocumentLoading(false)
      return
    }
    let active = true
    let loadedDocument: PDFDocumentProxy | null = null
    setPdf(null)
    pdfRef.current = null
    setLocalError(null)
    setSearchError(null)
    setSearchMessage(null)
    setDocumentLoading(true)
    let task: { promise: Promise<PDFDocumentProxy>; destroy(): Promise<void> }
    try {
      task = getDocument({ url, disableRange: false, disableAutoFetch: false, rangeChunkSize: PAGE_PRELOAD_BYTES, enableXfa: false })
    } catch (cause) {
      setLocalError(errorMessage(cause, 'Failed to load PDF preview.'))
      setDocumentLoading(false)
      return
    }
    void task.promise.then((document) => {
      if (!active || !isCurrent()) return
      loadedDocument = document
      pdfRef.current = document
      setPdf(document)
      const restored = Math.min(Math.max(1, number(object(propsRef.current.buffer.view.viewer).page) ?? 1), document.numPages)
      pageRef.current = restored
      setPage(restored)
      setDocumentLoading(false)
    }).catch((cause: unknown) => {
      if (active && isCurrent()) {
        setLocalError(errorMessage(cause, 'Failed to load PDF preview.'))
        setDocumentLoading(false)
      }
    })
    return () => {
      active = false
      if (pdfRef.current === loadedDocument) pdfRef.current = null
      void task.destroy().catch(() => {})
    }
  }, [generation, isCurrent, props.buffer.id, url])

  useEffect(() => {
    const node = container.current
    if (!node) return
    const observer = new ResizeObserver((entries) => {
      if (isCurrent()) setContainerWidth(entries[0]?.contentRect.width ?? 800)
    })
    observer.observe(node)
    return () => observer.disconnect()
  }, [generation, isCurrent])

  useEffect(() => {
    let active = true
    let renderTask: { promise: Promise<void>; cancel(): void } | undefined
    const target = canvas.current
    if (!pdf || !target) {
      setRendering(false)
      return
    }
    const isRenderCurrent = () => active && isCurrent() && pdfRef.current === pdf
    setRendering(true)
    setLocalError(null)
    const renderPage = async () => {
      const pdfPage = await pdf.getPage(page)
      if (!isRenderCurrent()) return
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      const fitScale = Math.max(0.25, Math.min(5, (containerWidth - 24) / baseViewport.width))
      const actualScale = scale === 'page-width' ? fitScale : scale
      const viewport = pdfPage.getViewport({ scale: actualScale })
      const context = target.getContext('2d')
      if (!context) throw new Error('PDF canvas is unavailable.')
      target.width = Math.ceil(viewport.width)
      target.height = Math.ceil(viewport.height)
      renderTask = pdfPage.render({ canvas: null, canvasContext: context, viewport })
      await renderTask.promise
      if (!isRenderCurrent()) return
      const offset = container.current?.scrollTop ?? 0
      await call(propsRef.current, 'position', { page, offset })
      if (isRenderCurrent()) setRendering(false)
    }
    void renderPage().catch((cause: unknown) => {
      if (!isRenderCurrent()) return
      setLocalError(errorMessage(cause, 'Failed to render PDF page.'))
      setRendering(false)
    })
    return () => {
      active = false
      try { renderTask?.cancel() } catch {}
    }
  }, [containerWidth, generation, isCurrent, page, pdf, scale])

  useEffect(() => {
    if (container.current) container.current.scrollTop = number(object(propsRef.current.buffer.view.viewer).offset) ?? 0
    return () => {
      if (scrollTimer.current !== undefined) window.clearTimeout(scrollTimer.current)
    }
  }, [generation, isCurrent, props.buffer.id])

  const goToPage = useCallback(async (next: number, searchRequestId?: number) => {
    const capturedPdf = pdfRef.current
    if (!capturedPdf || !safeIndex(next - 1) || next < 1 || next > capturedPdf.numPages) return false
    if (searchRequestId === undefined) searchSequence.current += 1
    if (scrollTimer.current !== undefined) window.clearTimeout(scrollTimer.current)
    const requestId = ++pageSequence.current
    const request = pageQueue.current.catch(() => {}).then(async () => {
      if (!isCurrent() || pdfRef.current !== capturedPdf || pageSequence.current !== requestId ||
        searchRequestId !== undefined && searchSequence.current !== searchRequestId) return false
      await call(propsRef.current, 'page', { page: next })
      if (!isCurrent() || pdfRef.current !== capturedPdf || pageSequence.current !== requestId ||
        searchRequestId !== undefined && searchSequence.current !== searchRequestId) return false
      pageRef.current = next
      setPage(next)
      return true
    })
    pageQueue.current = request.then(() => {}, () => {})
    return request
  }, [generation, isCurrent])

  const search = useCallback(async (searchQuery: string) => {
    const capturedPdf = pdfRef.current
    if (!capturedPdf) throw new Error('PDF preview is still loading.')
    const requestId = ++searchSequence.current
    const current = () => isCurrent() && pdfRef.current === capturedPdf && searchSequence.current === requestId
    setQuery(searchQuery)
    setSearchError(null)
    setSearchMessage(null)
    try {
      if (!searchQuery.trim()) throw new Error('Enter text to find in the PDF.')
      if (searchQuery.length > 8192) throw new Error('PDF search query exceeds 8192 characters.')
      await call(propsRef.current, 'find', { query: searchQuery })
      if (!current()) return { found: false, totalPages: capturedPdf.numPages }
      const needle = searchQuery.toLocaleLowerCase()
      for (let index = 1; index <= capturedPdf.numPages; index++) {
        const pdfPage = await capturedPdf.getPage(index)
        if (!current()) return { found: false, totalPages: capturedPdf.numPages }
        const content = await pdfPage.getTextContent()
        if (!current()) return { found: false, totalPages: capturedPdf.numPages }
        const text = content.items.map((item) => 'str' in item && typeof item.str === 'string' ? item.str : '').join(' ')
        if (text.toLocaleLowerCase().includes(needle)) {
          const pageChanged = await goToPage(index, requestId)
          if (!current() || !pageChanged) return { found: false, totalPages: capturedPdf.numPages }
          setSearchMessage(`Found on page ${index} of ${capturedPdf.numPages}.`)
          return { found: true, page: index, totalPages: capturedPdf.numPages }
        }
      }
      if (current()) setSearchMessage('No results')
      return { found: false, totalPages: capturedPdf.numPages }
    } catch (cause) {
      if (!current()) return { found: false, totalPages: capturedPdf.numPages }
      setSearchError(errorMessage(cause, 'PDF search failed.'))
      throw cause
    }
  }, [generation, goToPage, isCurrent])

  const changeScale = useCallback(async (requested: number | 'page-width') => {
    const capturedPdf = pdfRef.current
    if (!capturedPdf) throw new Error('PDF preview is not ready to zoom.')
    const next: number | 'page-width' = requested === 'page-width'
      ? 'page-width'
      : Math.min(5, Math.max(0.25, requested))
    const requestId = ++scaleSequence.current
    try {
      if (typeof next === 'number') {
        await call(propsRef.current, 'zoom', { scale: next })
      } else {
        await propsRef.current.onAction('quirky.editor/view', {
          bufferId: propsRef.current.buffer.id,
          action: 'update',
          patch: { viewer: { ...object(propsRef.current.buffer.view.viewer), zoom: 'page-width' } }
        })
      }
      if (!isCurrent() || pdfRef.current !== capturedPdf || scaleSequence.current !== requestId) return { zoom: scaleRef.current }
      scaleRef.current = next
      setScale(next)
      return { zoom: next }
    } catch (cause) {
      if (isCurrent() && pdfRef.current === capturedPdf && scaleSequence.current === requestId) setLocalError(errorMessage(cause))
      throw cause
    }
  }, [generation, isCurrent])


  const openFind = useCallback(async (args?: Record<string, unknown>) => {
    const findError = localError || error
    if (findError) throw new Error(findError)
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    if (requestedQuery !== undefined && requestedQuery.length > 8192) throw new Error('PDF search query exceeds 8192 characters.')
    if (requestedQuery === undefined || requestedQuery === '') {
      if (requestedQuery === '') setQuery('')
      document.getElementById(searchInputId)?.focus()
      return { opened: true }
    }
    setQuery(requestedQuery)
    return search(requestedQuery)
  }, [error, localError, search, searchInputId])
  useEffect(() => props.registerCommandHandlers({
    find: openFind,
    'zoom-in': () => changeScale(scaleRef.current === 'page-width' ? 1.25 : scaleRef.current * 1.25),
    'zoom-out': () => changeScale(scaleRef.current === 'page-width' ? 0.8 : scaleRef.current / 1.25),
    'reset-zoom': () => changeScale('page-width')
  }), [changeScale, openFind, props.registerCommandHandlers])

  const actions = pdf && !localError && !error ? [
    ...(page > 1 ? ['previous-page'] : []),
    ...(page < pdf.numPages ? ['next-page'] : []),
    'page',
    'zoom',
    ...(scale === 'page-width' || scale < 5 ? ['zoom-in'] : []),
    ...(scale === 'page-width' || scale > 0.25 ? ['zoom-out'] : []),
    'reset-zoom',
    'find'
  ] : []
  const handleControl = async (control: EditorUiControl) => {
    const capturedPdf = pdfRef.current
    if (!capturedPdf || !isCurrent() || localError || error) return { delivered: false }
    const fields: Record<string, string[]> = {
      'previous-page': [],
      'next-page': [],
      page: ['page'],
      zoom: ['scale'],
      'zoom-in': [],
      'zoom-out': [],
      'reset-zoom': [],
      find: ['query']
    }
    const allowed = fields[control.action]
    if (!allowed) return { delivered: false }
    const data = controlData(control, allowed, control.action === 'page' ? ['page'] : control.action === 'zoom' ? ['scale'] : [])
    if (!data) return { delivered: false }
    if (control.action === 'page' && (!safeIndex(data.page) || data.page < 1 || data.page > capturedPdf.numPages)) return { delivered: false }
    if (control.action === 'zoom' && !finiteNumber(data.scale)) return { delivered: false }
    if (control.action === 'previous-page' && pageRef.current <= 1) return { delivered: false }
    if (control.action === 'next-page' && pageRef.current >= capturedPdf.numPages) return { delivered: false }
    if (control.action === 'zoom-in' && scaleRef.current !== 'page-width' && scaleRef.current >= 5) return { delivered: false }
    if (control.action === 'zoom-out' && scaleRef.current !== 'page-width' && scaleRef.current <= 0.25) return { delivered: false }
    if (control.action === 'find' && Object.hasOwn(data, 'query') && (typeof data.query !== 'string' || data.query.length > 8192)) return { delivered: false }
    try {
      if (control.action === 'previous-page') {
        return { delivered: await goToPage(pageRef.current - 1) }
      }
      if (control.action === 'next-page') {
        return { delivered: await goToPage(pageRef.current + 1) }
      }
      if (control.action === 'page') return { delivered: await goToPage(data.page as number) }
      if (control.action === 'zoom') {
        await changeScale(data.scale as number)
        return { delivered: isCurrent() && pdfRef.current === capturedPdf }
      }
      if (control.action === 'zoom-in') {
        await changeScale(scaleRef.current === 'page-width' ? 1.25 : scaleRef.current * 1.25)
        return { delivered: isCurrent() && pdfRef.current === capturedPdf }
      }
      if (control.action === 'zoom-out') {
        await changeScale(scaleRef.current === 'page-width' ? 0.8 : scaleRef.current / 1.25)
        return { delivered: isCurrent() && pdfRef.current === capturedPdf }
      }
      if (control.action === 'reset-zoom') {
        await changeScale('page-width')
        return { delivered: isCurrent() && pdfRef.current === capturedPdf }
      }
      const requestId = searchSequence.current + 1
      await search(Object.hasOwn(data, 'query') ? data.query as string : query)
      return { delivered: isCurrent() && pdfRef.current === capturedPdf && searchSequence.current === requestId }
    } catch (cause) {
      if (isCurrent() && control.action !== 'find') setLocalError(errorMessage(cause))
      throw cause
    }
  }
  const lastUiAction = useRef<string | null>(null)
  const controlError = useCallback((cause: Error) => {
    if (lastUiAction.current === 'find') setSearchError(cause.message)
    else setLocalError(cause.message)
  }, [])
  const controls = useEditorUiControl({
    context: props.context,
    address: actions.length > 0 ? viewerAddress(props, 'pdf', generation, actions) : null,
    handler: handleControl,
    onError: controlError
  })
  const request = (action: string, data?: Record<string, unknown>) => {
    lastUiAction.current = action
    void controls.run(action, data).finally(() => {
      if (lastUiAction.current === action) lastUiAction.current = null
    })
  }
  const onScroll = () => {
    if (scrollTimer.current !== undefined) window.clearTimeout(scrollTimer.current)
    const offset = container.current?.scrollTop ?? 0
    const capturedPage = pageRef.current
    scrollTimer.current = window.setTimeout(() => {
      if (!isCurrent() || !pdfRef.current) return
      void call(propsRef.current, 'position', { page: capturedPage, offset }).catch((cause: unknown) => {
        if (isCurrent()) setLocalError(errorMessage(cause))
      })
    }, 150)
  }

  return <section className="viewer-pdf" aria-label="PDF preview">
    <header className="viewer-toolbar">
      <Button type="button" onClick={() => request('zoom-out')} disabled={!pdf || localError !== null || (scale !== 'page-width' && scale <= 0.25)}>Zoom out</Button>
      <Button type="button" onClick={() => request('reset-zoom')} disabled={!pdf || localError !== null}>Page width</Button>
      <Button type="button" onClick={() => request('zoom-in')} disabled={!pdf || localError !== null || (scale !== 'page-width' && scale >= 5)}>Zoom in</Button>
      <span>{scale === 'page-width' ? 'Page width' : `${Math.round(scale * 100)}%`}</span>
      <TextField id={searchInputId} label="Find in PDF" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          request('find', { query })
        }
      }} />
      <Button type="button" onClick={() => request('find', { query })} disabled={!query.trim() || query.length > 8192 || !pdf || localError !== null}>Find</Button>
      <Button type="button" onClick={() => request('previous-page')} disabled={!pdf || page <= 1 || localError !== null}>Previous page</Button>
      <span>{page}{pdf ? ` / ${pdf.numPages}` : ''}</span>
      <Button type="button" onClick={() => request('next-page')} disabled={!pdf || page >= pdf.numPages || localError !== null}>Next page</Button>
    </header>
    {localError && !error && <><InlineError message={localError} action={{ label: 'Retry', onAction: onRetry }} /><MediaActions onOpenDefault={onOpenDefault} /></>}
    {searchError && <InlineError message={searchError} action={{ label: 'Find', onAction: () => request('find', { query }) }} />}
    {searchMessage === 'No results' && <EmptyState message="No results" />}
    {searchMessage && searchMessage !== 'No results' && <p role="status">{searchMessage}</p>}
    {url && (documentLoading || rendering) && <div role="status"><NoticeLine>Loading PDF…</NoticeLine></div>}
    <div ref={container} className="viewer-pdf-page" onScroll={onScroll}>
      {url && <canvas ref={canvas} aria-label={`PDF page ${page}`} />}
    </div>
  </section>
}

function MediaViewer({
  props,
  metadata,
  url,
  error,
  generation,
  onRetry,
  onOpenDefault
}: {
  props: SurfaceProps
  metadata: ViewerMetadata
  url: string | null
  error: string | null
  generation: string
  onRetry(): void
  onOpenDefault(): void
}) {
  const [codecError, setCodecError] = useState<string | null>(null)
  const mediaRef = useRef<HTMLMediaElement | null>(null)
  const [elementReady, setElementReady] = useState(false)
  const [, setMediaRevision] = useState(0)
  const generationRef = useRef(generation)
  generationRef.current = generation
  const isVideo = metadata.kind === 'video'
  const mediaError = codecError ?? error
  const setMediaElement = useCallback((element: HTMLMediaElement | null) => {
    mediaRef.current = element
    setElementReady(element !== null)
  }, [])
  useEffect(() => {
    setCodecError(null)
    setMediaRevision((revision) => revision + 1)
  }, [generation, url])
  const element = mediaRef.current
  let seekAvailable = false
  if (elementReady && element && Number.isFinite(element.duration)) {
    try { seekAvailable = element.seekable.length > 0 } catch { seekAvailable = false }
  }

  const handleControl = async (control: EditorUiControl) => {
    const element = mediaRef.current
    if (generationRef.current !== generation || !url || error || codecError || !elementReady || !element) return { delivered: false }
    const allowedFields: Record<string, string[]> = {
      play: [],
      pause: [],
      seek: ['time'],
      volume: ['value'],
      muted: ['value'],
      'playback-rate': ['value'],
      fullscreen: ['open']
    }
    const allowed = allowedFields[control.action]
    if (!allowed || control.action === 'fullscreen' && !isVideo) return { delivered: false }
    const required = control.action === 'seek' ? ['time'] :
      control.action === 'fullscreen' ? ['open'] :
        ['volume', 'muted', 'playback-rate'].includes(control.action) ? ['value'] : []
    const data = controlData(control, allowed, required)
    if (!data) return { delivered: false }
    if (control.action === 'seek') {
      if (!seekAvailable || !finiteNumber(data.time) || data.time < 0 || !Number.isFinite(element.duration) || data.time > element.duration) return { delivered: false }
      let seekable = false
      try {
        for (let index = 0; index < element.seekable.length; index++) {
          if (data.time >= element.seekable.start(index) && data.time <= element.seekable.end(index)) {
            seekable = true
            break
          }
        }
      } catch {
        return { delivered: false }
      }
      if (!seekable) return { delivered: false }
    }
    if (control.action === 'volume' && (!finiteNumber(data.value) || data.value < 0 || data.value > 1)) return { delivered: false }
    if (control.action === 'muted' && typeof data.value !== 'boolean') return { delivered: false }
    if (control.action === 'playback-rate' && (!finiteNumber(data.value) || data.value <= 0)) return { delivered: false }
    if (control.action === 'fullscreen') {
      if (typeof data.open !== 'boolean') return { delivered: false }
      if (data.open && typeof element.requestFullscreen !== 'function') return { delivered: false }
      if (!data.open && (element.ownerDocument.fullscreenElement !== element || typeof element.ownerDocument.exitFullscreen !== 'function')) return { delivered: false }
    }
    try {
      switch (control.action) {
        case 'play':
          if (typeof element.play !== 'function') return { delivered: false }
          await element.play()
          break
        case 'pause':
          if (typeof element.pause !== 'function') return { delivered: false }
          element.pause()
          break
        case 'seek':
          element.currentTime = data.time as number
          break
        case 'volume':
          element.volume = data.value as number
          break
        case 'muted':
          element.muted = data.value as boolean
          break
        case 'playback-rate':
          element.playbackRate = data.value as number
          break
        case 'fullscreen':
          if (data.open) await element.requestFullscreen()
          else await element.ownerDocument.exitFullscreen()
          break
      }
      return { delivered: generationRef.current === generation && mediaRef.current === element }
    } catch (cause) {
      if (generationRef.current === generation && mediaRef.current === element) setCodecError(errorMessage(cause))
      throw cause
    }
  }
  const controlError = useCallback((cause: Error) => setCodecError(cause.message), [])
  const mediaActions = [
    'play',
    'pause',
    ...(seekAvailable ? ['seek'] : []),
    'volume',
    'muted',
    'playback-rate',
    ...(isVideo ? ['fullscreen'] : [])
  ]
  const controls = useEditorUiControl({
    context: props.context,
    address: url && !mediaError && elementReady
      ? viewerAddress(props, 'media', generation, mediaActions)
      : null,
    handler: handleControl,
    onError: controlError
  })
  const setErrorEvent = () => {
    if (generationRef.current === generation) setCodecError('Unable to play this media file. The file may be unavailable or use an unsupported codec.')
  }
  const onMediaState = () => setMediaRevision((revision) => revision + 1)

  return <section className="viewer-media" aria-label={isVideo ? 'Video preview' : 'Audio preview'}>
    {url && isVideo && <video ref={setMediaElement} className="viewer-media__video" controls preload="metadata" src={url} onLoadedMetadata={onMediaState} onDurationChange={onMediaState} onProgress={onMediaState} onError={setErrorEvent} />}
    {url && !isVideo && <audio ref={setMediaElement} className="viewer-media__audio" controls preload="metadata" src={url} onLoadedMetadata={onMediaState} onDurationChange={onMediaState} onProgress={onMediaState} onError={setErrorEvent} />}
    <p>{bytesLabel(metadata.size ?? props.buffer.size)}</p>
    {codecError && !error && <><InlineError message={codecError} action={{ label: 'Retry', onAction: onRetry }} /><MediaActions onOpenDefault={onOpenDefault} /></>}
  </section>
}

function MermaidViewer({
  props,
  sourceMode,
  retryToken,
  requestMode
}: {
  props: SurfaceProps
  sourceMode: boolean
  retryToken: number
  requestMode(value: 'source' | 'rich'): void
}) {
  const source = props.buffer.draft !== null ? props.buffer.draft : props.buffer.content
  const id = useId().replaceAll(':', '')
  const container = useRef<HTMLElement | null>(null)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [rendering, setRendering] = useState(false)
  const [themeRevision, setThemeRevision] = useState(0)
  useEffect(() => {
    const themeRoot = container.current?.closest('[data-theme]') ?? document.documentElement
    const observer = new MutationObserver(() => setThemeRevision((revision) => revision + 1))
    observer.observe(themeRoot, { attributes: true, attributeFilter: ['data-theme'], subtree: true })
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (sourceMode) {
      setRendering(false)
      return
    }
    if (new TextEncoder().encode(source).byteLength > 1024 * 1024) {
      setSvg('')
      setRendering(false)
      setError('Diagram source exceeds the safe rendering limit. Use Source to edit or view it.')
      return
    }
    let active = true
    setRendering(true)
    setError(null)
    setSvg('')
    const computed = getComputedStyle(container.current ?? document.documentElement)
    const token = (name: string) => computed.getPropertyValue(name).trim()
    const text = token('--ui-text')
    const surface = token('--ui-surface')
    const selected = token('--ui-selected')
    const rail = token('--ui-rail')
    const border = token('--ui-border')
    const muted = token('--ui-muted')
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      htmlLabels: false,
      theme: 'base',
      themeVariables: {
        background: surface,
        primaryColor: selected,
        primaryTextColor: text,
        primaryBorderColor: border,
        lineColor: muted,
        secondaryColor: rail,
        secondaryTextColor: text,
        secondaryBorderColor: border,
        tertiaryColor: surface,
        tertiaryTextColor: text,
        tertiaryBorderColor: border,
        mainBkg: surface,
        nodeBkg: selected,
        clusterBkg: rail,
        titleColor: text,
        edgeLabelBackground: surface
      }
    })
    void mermaid.render(`quirky-mermaid-${id}`, source).then(({ svg: result }) => {
      if (active) setSvg(DOMPurify.sanitize(result, { USE_PROFILES: { svg: true, svgFilters: true }, FORBID_TAGS: ['script', 'foreignObject'] }))
    }).catch((cause: unknown) => {
      if (active) setError(errorMessage(cause, 'Mermaid could not render this diagram.'))
    }).finally(() => { if (active) setRendering(false) })
    return () => { active = false }
  }, [id, retryToken, source, sourceMode, themeRevision])
  if (sourceMode) return <SourceText props={props} value={source} label="Mermaid source" />
  return <section className="viewer-mermaid" aria-label="Mermaid diagram" ref={container}>
    {rendering && <div role="status"><NoticeLine>Rendering diagram…</NoticeLine></div>}
    {error ? <InlineError message={error} action={{ label: 'Source', onAction: () => requestMode('source') }} /> : <div className="viewer-mermaid__diagram" role="img" aria-label="Rendered Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />}
  </section>
}

export function ViewerSurface(props: SurfaceProps) {
  const { buffer } = props
  const [mountId] = useState(() => crypto.randomUUID())
  const isTooLarge = buffer.size > MAX_FILE_BYTES
  const canToggleSource = !isTooLarge && (buffer.kind === 'csv' || buffer.kind === 'mermaid')
  const sourceMode = canToggleSource && buffer.mode === 'source'
  const canChangeMode = canToggleSource && (buffer.kind !== 'csv' || buffer.size < 1024 * 1024 || sourceMode)
  const modeState = useRef({ mode: buffer.mode, epoch: 0 })
  if (modeState.current.mode !== buffer.mode) {
    modeState.current = { mode: buffer.mode, epoch: modeState.current.epoch + 1 }
  }
  const surfaceGeneration = viewerGeneration(props, mountId, `viewer:${buffer.kind}:${modeState.current.epoch}`)
  const currentSurface = useRef(surfaceGeneration)
  currentSurface.current = surfaceGeneration
  const propsRef = useRef(props)
  propsRef.current = props
  const bufferRef = useRef(buffer)
  bufferRef.current = buffer
  const isResourceKind = buffer.kind === 'image' || buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video'
  const [metadata, setMetadata] = useState<ViewerMetadata>({})
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [commandError, setCommandError] = useState<string | null>(null)
  const [changedOnDisk, setChangedOnDisk] = useState(buffer.external === 'changed')
  const [loading, setLoading] = useState(isResourceKind && !isTooLarge)
  const [loadingMessage, setLoadingMessage] = useState('Loading preview…')
  const [retryKey, setRetryKey] = useState(0)
  const changed = buffer.external === 'changed' || changedOnDisk || metadata.changedOnDisk === true
  const canRetry = !isTooLarge && !sourceMode && (isResourceKind || buffer.kind === 'csv' || buffer.kind === 'mermaid')
  const canOpenDefault = isResourceKind && !isTooLarge
  const resourceGeneration = viewerGeneration(
    props,
    mountId,
    `resource:${buffer.kind}:${buffer.contentRevision}:${modeState.current.epoch}:${retryKey}`
  )
  const resourceEffectKey = JSON.stringify([resourceGeneration, buffer.external, buffer.size])

  useEffect(() => {
    if (!isResourceKind) {
      setMetadata({})
      setUrl(null)
      setError(null)
      setCommandError(null)
      setChangedOnDisk(bufferRef.current.external === 'changed')
      setLoading(false)
      return
    }
    let active = true
    let leaseId: string | undefined
    let acquisitionSettled = false
    let released = false
    const capturedProps = propsRef.current
    const capturedBuffer = bufferRef.current
    const capturedBufferId = capturedBuffer.id
    const release = () => {
      if (!leaseId || !acquisitionSettled || released) return
      released = true
      void capturedProps.onAction('quirky.editor/viewer', {
        bufferId: capturedBufferId,
        action: 'release',
        leaseId
      }).catch(() => {})
    }
    setMetadata({})
    setUrl(null)
    setError(null)
    setCommandError(null)
    setChangedOnDisk(capturedBuffer.external === 'changed')
    setLoading(true)
    setLoadingMessage('Loading preview…')
    if (capturedBuffer.size > MAX_FILE_BYTES) {
      setLoading(false)
      return () => { active = false }
    }
    const load = async () => {
      try {
        const info = object(await call(capturedProps, 'metadata')) as ViewerMetadata
        if (!active) return
        setMetadata(info)
        if (typeof info.error === 'string' && info.error.length > 0) {
          setError(info.error)
          return
        }
        if (info.changedOnDisk === true) {
          setChangedOnDisk(true)
          return
        }
        if (capturedBuffer.kind === 'image' && info.previewable === false) {
          setError(info.error ?? 'Failed to load file preview.')
          return
        }
        if (capturedBuffer.kind === 'audio' || capturedBuffer.kind === 'video') setLoadingMessage('Loading media…')
        leaseId = crypto.randomUUID()
        let resource: ApiRecord
        try {
          resource = object(await call(capturedProps, 'media', { leaseId }))
          acquisitionSettled = true
        } catch (cause) {
          acquisitionSettled = true
          release()
          throw cause
        }
        if (!active) {
          release()
          return
        }
        if (resource.changedOnDisk === true) {
          setChangedOnDisk(true)
          release()
          return
        }
        const resourceUrl = string(resource.url)
        if (!resourceUrl) throw new Error(string(resource.error) ?? 'The viewer resource is unavailable.')
        setUrl(resourceUrl)
      } catch (cause) {
        release()
        if (active) setError(errorMessage(cause))
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    return () => {
      active = false
      release()
    }
  }, [isResourceKind, resourceEffectKey])

  const handleControl = async (control: EditorUiControl) => {
    if (currentSurface.current !== surfaceGeneration) return { delivered: false }
    const fields: Record<string, string[]> = {
      retry: [],
      reload: [],
      mode: ['value'],
      'open-default': []
    }
    const allowed = fields[control.action]
    if (!allowed) return { delivered: false }
    const data = controlData(control, allowed, control.action === 'mode' ? ['value'] : [])
    if (!data) return { delivered: false }
    try {
      if (control.action === 'retry') {
        if (!canRetry) return { delivered: false }
        setError(null)
        setCommandError(null)
        if (isResourceKind) {
          setLoading(true)
          setLoadingMessage('Loading preview…')
          setUrl(null)
        }
        setRetryKey((value) => value + 1)
        return { delivered: currentSurface.current === surfaceGeneration }
      }
      if (control.action === 'reload') {
        if (!changed || buffer.kind === 'csv') return { delivered: false }
        setCommandError(null)
        await props.onAction('quirky.editor/view', { bufferId: buffer.id, action: 'reload' })
        if (currentSurface.current !== surfaceGeneration) return { delivered: false }
        setError(null)
        setUrl(null)
        setLoading(true)
        setLoadingMessage('Loading preview…')
        setRetryKey((value) => value + 1)
        return { delivered: true }
      }
      if (control.action === 'mode') {
        if (!canChangeMode || data.value !== 'source' && data.value !== 'rich') return { delivered: false }
        if (data.value === 'source' && buffer.kind === 'csv' && buffer.size >= 1024 * 1024) return { delivered: false }
        props.onView({ mode: data.value })
        return { delivered: currentSurface.current === surfaceGeneration }
      }
      if (control.action === 'open-default') {
        if (!canOpenDefault) return { delivered: false }
        setCommandError(null)
        await props.context.call('quirky.terminal/openExternal', { target: buffer.path })
        return { delivered: currentSurface.current === surfaceGeneration }
      }
      return { delivered: false }
    } catch (cause) {
      if (currentSurface.current === surfaceGeneration) setCommandError(errorMessage(cause))
      throw cause
    }
  }
  const viewerActions = [
    ...(canRetry ? ['retry'] : []),
    ...(changed && buffer.kind !== 'csv' ? ['reload'] : []),
    ...(canChangeMode ? ['mode'] : []),
    ...(canOpenDefault ? ['open-default'] : [])
  ]
  const controlError = useCallback((cause: Error) => setCommandError(cause.message), [])
  const controls = useEditorUiControl({
    context: props.context,
    address: viewerActions.length > 0 ? viewerAddress(props, 'viewer', surfaceGeneration, viewerActions) : null,
    handler: handleControl,
    onError: controlError
  })
  const request = (action: string, data?: Record<string, unknown>) => { void controls.run(action, data) }
  const requestMode = (value: 'source' | 'rich') => request('mode', { value })
  const requestRetry = () => request('retry')
  const requestOpenDefault = () => request('open-default')
  const requestReload = () => request('reload')
  const visibleError = isTooLarge ? 'File is too large to preview.' : error

  return <section className="quirky-viewer-surface" aria-label={`${buffer.kind} viewer`} style={{ fontSize: props.fontSize }}>
    <header className="viewer-toolbar">
      <strong>{buffer.name}</strong>
      {canToggleSource && <Button className="editor-viewer-mode-toggle" type="button" aria-pressed={sourceMode} disabled={!canChangeMode} onClick={() => requestMode(sourceMode ? 'rich' : 'source')}>{sourceMode ? 'Table / Preview' : 'Source'}</Button>}
      {buffer.kind === 'image' && metadata.width !== undefined && <Badge>{metadata.width} × {metadata.height} · {bytesLabel(metadata.bytes ?? buffer.size)}</Badge>}
      {(buffer.kind === 'audio' || buffer.kind === 'video') && <Badge>{metadata.contentType ?? 'Media'}</Badge>}
      {canOpenDefault && <Button type="button" onClick={requestOpenDefault}>Open in Default App</Button>}
    </header>
    {changed && <p className="viewer-notice" role="status">File changed on disk. Reload the viewer. <Button type="button" onClick={requestReload} disabled={loading}>Reload</Button></p>}
    {loading && !isTooLarge && <div role="status"><NoticeLine>{loadingMessage}</NoticeLine></div>}
    {visibleError && <InlineError message={visibleError} action={!isTooLarge ? { label: changed ? 'Reload' : 'Retry', onAction: changed ? requestReload : requestRetry } : undefined} />}
    {commandError && <InlineError message={commandError} action={{ label: 'Retry', onAction: requestRetry }} />}
    {!isTooLarge && buffer.kind === 'csv' && <CsvSurface props={props} sourceMode={sourceMode} retryToken={retryKey} requestMode={requestMode} />}
    {!isTooLarge && buffer.kind === 'image' && !sourceMode && <ImageViewer key={resourceGeneration} props={props} metadata={metadata} url={url} error={error} generation={resourceGeneration} onRetry={requestRetry} onOpenDefault={requestOpenDefault} />}
    {!isTooLarge && buffer.kind === 'pdf' && <PdfViewer key={resourceGeneration} props={props} url={url} error={error} generation={resourceGeneration} onRetry={requestRetry} onOpenDefault={requestOpenDefault} />}
    {!isTooLarge && (buffer.kind === 'audio' || buffer.kind === 'video') && <MediaViewer key={resourceGeneration} props={props} metadata={metadata} url={url} error={error} generation={resourceGeneration} onRetry={requestRetry} onOpenDefault={requestOpenDefault} />}
    {!isTooLarge && buffer.kind === 'mermaid' && <MermaidViewer props={props} sourceMode={sourceMode} retryToken={retryKey} requestMode={requestMode} />}
    {!isTooLarge && buffer.kind === 'binary' && <InlineError message="Binary file — cannot display." />}
    {!isTooLarge && !['csv', 'image', 'pdf', 'audio', 'video', 'mermaid', 'binary'].includes(buffer.kind) && <InlineError message="Unsupported file viewer." />}
  </section>
}