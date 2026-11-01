import { Badge, Button, EmptyState, TextField } from '@quirky/ui'
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy } from 'pdfjs-dist'
import type { SurfaceProps } from '../types'
import DOMPurify from 'dompurify'
import mermaid from 'mermaid'

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.mjs', import.meta.url).href

const MAX_FILE_BYTES = 50 * 1024 * 1024
const PAGE_PRELOAD_BYTES = 256 * 1024

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

function isCsv(buffer: SurfaceProps['buffer']): boolean {
  return buffer.kind === 'csv'
}


async function call(props: SurfaceProps, action: string, fields: Record<string, unknown> = {}): Promise<unknown> {
  return props.onAction('quirky.editor/viewer', { bufferId: props.buffer.id, action, ...fields })
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

function CsvSurface({ props, sourceMode }: { props: SurfaceProps; sourceMode: boolean }) {
  const { buffer, onView } = props
  const [metadata, setMetadata] = useState<ViewerMetadata | null>(null)
  const restoredView = object(buffer.view.viewer)
  const [page, setPage] = useState(Math.max(0, (number(restoredView.page) ?? 1) - 1))
  const [rows, setRows] = useState<CsvRow[]>([])
  const [nextPage, setNextPage] = useState<number | null>(null)
  const [filter, setFilter] = useState(typeof restoredView.filter === 'string' ? restoredView.filter : '')
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
  const [copyRange, setCopyRange] = useState({ row: '', column: '', endRow: '', endColumn: '' })
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const filterInputId = useId()

  const refresh = async (targetPage = page) => {
    setLoading(true)
    setError(null)
    try {
      const info = object(await call(props, 'metadata')) as ViewerMetadata
      setMetadata(info)
      setChanged(info.changedOnDisk === true)
      if (info.error) {
        setRows([])
        setError(info.error)
        return
      }
      if (isCsv(buffer)) {
        const pageResult = object(await call(props, 'page', { page: targetPage }))
        if (pageResult.changedOnDisk === true) {
          setChanged(true)
          setRows([])
          setNextPage(null)
          return
        }
        const pageRows = Array.isArray(pageResult.rows) ? pageResult.rows.map((row) => object(row) as CsvRow) : []
        setRows(pageRows)
        setNextPage(typeof pageResult.nextPage === 'number' ? pageResult.nextPage : null)
        if (typeof pageResult.delimiter === 'string') setDelimiter(pageResult.delimiter)
        if (info.paged === true && typeof pageResult.offset === 'number') {
          await call(props, 'position', { page: targetPage + 1, offset: pageResult.offset })
        }
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void refresh(page) }, [buffer.id, buffer.contentRevision])

  const saveTable = async () => {
    setLoading(true)
    try {
      const pending = Object.entries(cellDrafts)
      for (const [key, value] of pending) {
        const [row, column] = key.split(':').map(Number)
        await call(props, 'edit', { row, column, value })
      }
      setCellDrafts({})
      await call(props, 'save')
      await refresh(page)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  const changeFilter = async (value: string) => {
    setFilter(value)
    try {
      await call(props, 'filter', { query: value })
      setPage(0)
      await refresh(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const findRows = useCallback(async (args?: Record<string, unknown>) => {
    if (buffer.readOnly || metadata?.paged === true) throw new Error('Find is unavailable in read-only paged CSV previews.')
    const query = typeof args?.query === 'string' ? args.query : undefined
    document.getElementById(filterInputId)?.focus()
    if (query === undefined) return { opened: true }
    await call(props, 'filter', { query })
    setFilter(query)
    setPage(0)
    await refresh(0)
    return { filtered: true, query }
  }, [props])
  useEffect(() => props.registerCommandHandlers({ find: findRows }), [findRows, props.registerCommandHandlers])

  const sortColumn = async (column: number) => {
    const order = sort?.column === column && sort.order === 'asc' ? 'desc' : 'asc'
    setSort({ column, order })
    try {
      await call(props, 'sort', { column, order })
      await refresh(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const insertRow = async () => {
    try {
      await call(props, 'insertRow', { index: rows.length ? rows.at(-1)!.index + 1 : 0, count: 1 })
      await refresh(page)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const insertColumn = async () => {
    const columns = Math.max(0, ...rows.map((row) => row.cells.length))
    try {
      await call(props, 'insertColumn', { index: columns, value: `Column ${columns + 1}` })
      await refresh(page)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const deleteColumn = async (index: number) => {
    try {
      await call(props, 'deleteColumn', { index })
      await refresh(page)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const copySelection = async (fields: Record<string, unknown>) => {
    if (Object.keys(cellDrafts).length > 0) {
      setError('Apply or save pending cell edits before copying.')
      return
    }
    setError(null)
    try {
      const result = object(await call(props, 'copy', fields))
      if (typeof result.text !== 'string') throw new Error('The viewer did not return clipboard text.')
      if (typeof navigator.clipboard?.writeText !== 'function') throw new Error('Clipboard access is unavailable.')
      await navigator.clipboard.writeText(result.text)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Clipboard access failed.')
    }
  }

  const copyCell = (row: number, column: number) => copySelection({ row, column })

  const copySelectedRange = () => {
    const values = [copyRange.row, copyRange.column, copyRange.endRow, copyRange.endColumn]
    if (values.some((value) => !/^\d+$/.test(value))) {
      setError('Copy range needs complete non-negative source row and column indices.')
      return
    }
    const row = Number(copyRange.row)
    const column = Number(copyRange.column)
    const endRow = Number(copyRange.endRow)
    const endColumn = Number(copyRange.endColumn)
    if (![row, column, endRow, endColumn].every(Number.isSafeInteger)) {
      setError('Copy range coordinates must be whole source indices.')
      return
    }
    if (row > endRow || column > endColumn) {
      setError('Copy range end coordinates must not be before the start coordinates.')
      return
    }
    void copySelection({ row, column, endRow, endColumn })
  }

  const paste = async () => {
    try {
      await call(props, 'paste', { row: pasteAt.row, column: pasteAt.column, text: pasteText })
      setPasteText('')
      await refresh(page)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const reload = async () => {
    setLoading(true)
    try {
      await props.onAction('quirky.editor/view', { bufferId: buffer.id, action: 'reload' })
      setPage(0)
      setChanged(false)
      await refresh(0)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  if (sourceMode) {
    if (buffer.size >= 1024 * 1024) return <section className="viewer-empty" aria-label="Large CSV source">
      <EmptyState
        message="Large CSV files are read-only and shown in bounded pages. Use the table preview to browse records."
        action={{ label: 'Return to Table', onAction: () => onView({ mode: 'rich' }) }}
      />
    </section>
    return <SourceText props={props} value={buffer.draft !== null ? buffer.draft : buffer.content} label="CSV source" />
  }


  const header = rows.find((row) => row.index === 0)?.cells ?? []
  const dataRows = rows.filter((row) => row.index !== 0)
  const readOnly = metadata?.paged === true || buffer.readOnly
  const changedBanner = changed && <p role="status">CSV changed on disk. Reload the file to refresh the preview. <Button type="button" onClick={() => void reload()} disabled={loading}>Reload</Button></p>

  return <section className="viewer-csv" aria-label={metadata?.paged ? 'Paged CSV preview' : 'CSV table'} style={{ fontSize: props.fontSize }}>
    <header className="viewer-toolbar">
      <Badge tone={metadata?.paged ? 'needs-you' : 'neutral'}>{metadata?.paged ? 'Read-only paged preview' : `${metadata?.rows ?? rows.length} rows · ${metadata?.columns ?? header.length} columns`}</Badge>
      {!readOnly && <>
        <Button type="button" variant="primary" onClick={() => void saveTable()} disabled={loading}>Save</Button>
        <Button type="button" onClick={() => void insertRow()} disabled={loading}>Add row</Button>
        <Button type="button" onClick={() => void insertColumn()} disabled={loading}>Add column</Button>
        <select className="editor-viewer-select" aria-label="Delimiter" value={delimiter} onChange={(event) => {
          const value = event.currentTarget.value
          setDelimiter(value)
          void call(props, 'delimiter', { delimiter: value }).then(() => refresh(0)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
        }}>
          <option value=",">Comma</option><option value="\t">Tab</option><option value=";">Semicolon</option><option value="|">Pipe</option>
        </select>
        <TextField id={filterInputId} label="Filter rows" value={filter} onChange={(event) => void changeFilter(event.currentTarget.value)} />
        <details className="viewer-csv-advanced">
          <summary className="qe-disclosure-trigger">Paste and copy range</summary>
          <div className="viewer-csv-advanced__body">
            <textarea className="editor-viewer-source viewer-paste" aria-label="Paste CSV cells" value={pasteText} onChange={(event) => setPasteText(event.currentTarget.value)} placeholder="Paste CSV or tab-separated cells" />
            <TextField label="Paste row" type="number" min="0" value={pasteAt.row} onChange={(event) => { const value = Number(event.currentTarget.value); setPasteAt((old) => ({ ...old, row: value })) }} />
            <TextField label="Paste column" type="number" min="0" value={pasteAt.column} onChange={(event) => { const value = Number(event.currentTarget.value); setPasteAt((old) => ({ ...old, column: value })) }} />
            <Button type="button" onClick={() => void paste()} disabled={loading}>Paste</Button>
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
    {error && <p className="viewer-error" role="alert">{error} <Button type="button" onClick={() => void refresh(page)}>Retry</Button></p>}
    {metadata?.limits && metadata.paged && <p>Limits: {metadata.limits.maxColumns} columns · {bytesLabel(metadata.limits.maxRecordBytes ?? 0)} per record · {metadata.limits.maxCachedPages} cached pages</p>}
    {loading && <p role="status">Loading CSV page…</p>}
    <div className="viewer-table-scroll">
      <table className="viewer-table">
        {header.length > 0 && <thead><tr>{header.map((title, column) => <th key={column}>
          <Button type="button" onClick={() => !metadata?.paged && void sortColumn(column)} disabled={Boolean(metadata?.paged)}>{title || `Column ${column + 1}`}</Button>
          {!readOnly && <Button type="button" aria-label={`Copy column ${column} (source index)`} onClick={() => void copySelection({ column })} disabled={loading}>Copy column</Button>}
          {!readOnly && <Button type="button" variant="destructive" aria-label={`Delete column ${column + 1}`} onClick={() => void deleteColumn(column)} disabled={loading}>Delete column</Button>}
        </th>)}{!readOnly && <th><Button type="button" aria-label="Copy row 0 (source index)" onClick={() => void copySelection({ row: 0 })} disabled={loading}>Copy row 0</Button></th>}</tr></thead>}
        <tbody>{dataRows.map((row) => <tr key={row.index}>
          {row.cells.map((cell, column) => <td key={column} onDoubleClick={() => void copyCell(row.index, column)}>
            {readOnly ? <span>{cell}</span> : <input
              className="viewer-cell-input"
              aria-label={`Row ${row.index + 1}, column ${column + 1}`}
              value={cellDrafts[`${row.index}:${column}`] ?? cell}
              onChange={(event) => { const value = event.currentTarget.value; setCellDrafts((old) => ({ ...old, [`${row.index}:${column}`]: value })) }}
              onBlur={(event) => {
                const value = event.currentTarget.value
                if (value === cell) {
                  setCellDrafts((old) => { const next = { ...old }; delete next[`${row.index}:${column}`]; return next })
                  return
                }
                void call(props, 'edit', { row: row.index, column, value }).then(() => {
                  setCellDrafts((old) => { const next = { ...old }; delete next[`${row.index}:${column}`]; return next })
                  return refresh(page)
                }).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
              }}
            />}
            <Button type="button" onClick={() => void copyCell(row.index, column)}>Copy cell</Button>
          </td>)}
          {!readOnly && <td>
            <Button type="button" aria-label={`Copy row ${row.index} (source index)`} onClick={() => void copySelection({ row: row.index })} disabled={loading}>Copy row</Button>
            <Button type="button" variant="destructive" onClick={() => void call(props, 'deleteRow', { row: row.index }).then(() => refresh(page)).catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))}>Delete row</Button>
          </td>}
        </tr>)}</tbody>
      </table>
    </div>
    {metadata?.paged && <nav className="viewer-pages" aria-label="CSV pages">
      <Button type="button" onClick={() => { const next = Math.max(0, page - 1); setPage(next); void refresh(next) }} disabled={page === 0 || loading}>Previous page</Button>
      <span>Page {page + 1}</span>
      <Button type="button" onClick={() => { const next = nextPage ?? page + 1; setPage(next); void refresh(next) }} disabled={nextPage === null || loading}>Next page</Button>
    </nav>}
  </section>
}

function MediaActions({ props, error, retry }: { props: SurfaceProps; error: string | null; retry():void }) {
  const [openError, setOpenError] = useState<string | null>(null)
  const openDefault = async () => {
    try {
      await props.context.call('quirky.terminal/openExternal', { target: props.buffer.path })
      setOpenError(null)
    } catch (cause) {
      setOpenError(cause instanceof Error ? cause.message : String(cause))
    }
  }
  return <div className="viewer-media-actions">
    <Button type="button" onClick={retry}>Retry</Button>
    <Button type="button" onClick={() => void openDefault()}>Open in Default App</Button>
    {error && <p role="alert">{error}</p>}{openError && <p role="alert">{openError}</p>}
  </div>
}

function ImageViewer({ props, metadata, url, error, retry }: { props: SurfaceProps; metadata: ViewerMetadata; url: string | null; error: string | null; retry(): void }) {
  const [zoom, setZoom] = useState(typeof metadata.zoom === 'number' ? metadata.zoom : number(object(props.buffer.view.viewer).zoom) ?? 1)
  const [loadError, setLoadError] = useState(false)
  const touchDistance = useRef<number | null>(null)
  useEffect(() => {
    setZoom(typeof metadata.zoom === 'number' ? metadata.zoom : number(object(props.buffer.view.viewer).zoom) ?? 1)
    setLoadError(false)
  }, [metadata.zoom, props.buffer.id, url])
  const setScale = useCallback(async (value: number) => {
    const result = object(await call(props, 'zoom', { scale: value }))
    const nextZoom = typeof result.zoom === 'number' ? result.zoom : Math.min(8, Math.max(0.25, value))
    setZoom(nextZoom)
    return { zoom: nextZoom }
  }, [props])
  const zoomCommand = useCallback((value: number) => {
    if (!metadata.previewable || error || loadError) {
      throw new Error(error ?? (loadError ? 'Image preview could not be loaded.' : metadata.error ?? 'Image preview is not ready to zoom.'))
    }
    return setScale(value)
  }, [error, loadError, metadata.error, metadata.previewable, setScale])
  useEffect(() => props.registerCommandHandlers({
    'zoom-in': () => zoomCommand(zoom * 1.25),
    'zoom-out': () => zoomCommand(zoom / 1.25),
    'reset-zoom': () => zoomCommand(1)
  }), [props.registerCommandHandlers, zoom, zoomCommand])
  const retryImage = () => {
    setLoadError(false)
    retry()
  }
  if (!metadata.previewable || error || loadError) {
    return <div role="alert"><p>{error ?? (loadError ? 'Failed to load file preview.' : metadata.error ?? 'Failed to load file preview.')}</p><MediaActions props={props} error={error} retry={retryImage} /></div>
  }
  return <section className="viewer-image" aria-label="Image preview" onWheel={(event) => {
    if (!event.ctrlKey && !event.metaKey) return
    event.preventDefault()
    void setScale(zoom * (event.deltaY < 0 ? 1.25 : 0.8))
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
    if (Math.abs(ratio - 1) > 0.12) {
      touchDistance.current = distance
      void setScale(zoom * ratio)
    }
  }} onTouchEnd={() => { touchDistance.current = null }}>
    <header className="viewer-toolbar">
      <Button type="button" onClick={() => void setScale(zoom / 1.25)} disabled={zoom <= 0.25}>Zoom out</Button>
      <Button type="button" onClick={() => void setScale(1)}>Reset zoom</Button>
      <Button type="button" onClick={() => void setScale(zoom * 1.25)} disabled={zoom >= 8}>Zoom in</Button>
      <span>{Math.round(zoom * 100)}%</span>
      <span>{metadata.width ?? '—'} × {metadata.height ?? '—'}</span>
      <span>{bytesLabel(metadata.bytes ?? props.buffer.size)}</span>
    </header>
    {url ? <img className="viewer-image__preview" src={url} alt={props.buffer.name} style={{ transform: `scale(${zoom})` }} onError={() => setLoadError(true)} /> : <p role="status">Loading image…</p>}
  </section>
}

function PdfViewer({ props, url, error, retry }: { props: SurfaceProps; url: string | null; error: string | null; retry(): void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null)
  const [page, setPage] = useState(number(object(props.buffer.view.viewer).page) ?? 1)
  const [scale, setScale] = useState<number | 'page-width'>(object(props.buffer.view.viewer).zoom === undefined ? 'page-width' : number(object(props.buffer.view.viewer).zoom) ?? 'page-width')
  const [query, setQuery] = useState('')
  const [searchMessage, setSearchMessage] = useState<string | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [containerWidth, setContainerWidth] = useState(800)
  const container = useRef<HTMLDivElement | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const scrollTimer = useRef<number | undefined>(undefined)
  const searchInputId = useId()

  useEffect(() => {
    if (!url) return
    let active = true
    setPdf(null)
    setLocalError(null)
    const task = getDocument({ url, disableRange: false, disableAutoFetch: false, rangeChunkSize: PAGE_PRELOAD_BYTES, enableXfa: false })
    void task.promise.then((document) => {
      if (active) {
        setPdf(document)
        setPage(Math.min(page, document.numPages))
      }
    }).catch((cause: unknown) => {
      if (active) setLocalError(cause instanceof Error ? cause.message : 'Failed to load PDF preview.')
    })
    return () => { active = false; void task.destroy() }
  }, [url, props.buffer.id])

  useEffect(() => {
    const node = container.current
    if (!node) return
    const observer = new ResizeObserver((entries) => setContainerWidth(entries[0]?.contentRect.width ?? 800))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    let active = true
    let renderTask: { promise: Promise<void>; cancel(): void } | undefined
    const target = canvas.current
    if (!pdf || !target) return
    void pdf.getPage(page).then((pdfPage) => {
      if (!active) return
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      const fitScale = Math.max(0.25, Math.min(5, (containerWidth - 24) / baseViewport.width))
      const actualScale = scale === 'page-width' ? fitScale : scale
      const viewport = pdfPage.getViewport({ scale: actualScale })
      const context = target.getContext('2d')
      if (!context) throw new Error('PDF canvas is unavailable.')
      target.width = Math.ceil(viewport.width)
      target.height = Math.ceil(viewport.height)
      renderTask = pdfPage.render({ canvas: null, canvasContext: context, viewport })
      return renderTask.promise
    }).then(() => {
      if (active) void call(props, 'position', { page, offset: container.current?.scrollTop ?? 0 })
    }).catch((cause: unknown) => {
      if (active) setLocalError(cause instanceof Error ? cause.message : 'Failed to render PDF page.')
    })
    return () => { active = false; renderTask?.cancel() }
  }, [pdf, page, scale, containerWidth])

  useEffect(() => {
    if (container.current) container.current.scrollTop = number(object(props.buffer.view.viewer).offset) ?? 0
    return () => { if (scrollTimer.current !== undefined) window.clearTimeout(scrollTimer.current) }
  }, [pdf, props.buffer.id])

  const search = useCallback(async (searchQuery = query) => {
    setSearchMessage(null)
    if (!pdf) throw new Error('PDF preview is still loading.')
    if (!searchQuery.trim()) throw new Error('Enter text to find in the PDF.')
    try {
      await call(props, 'find', { query: searchQuery })
      const needle = searchQuery.toLocaleLowerCase()
      for (let index = 1; index <= pdf.numPages; index++) {
        const pdfPage = await pdf.getPage(index)
        const content = await pdfPage.getTextContent()
        const text = content.items.map((item) => 'str' in item && typeof item.str === 'string' ? item.str : '').join(' ')
        if (text.toLocaleLowerCase().includes(needle)) {
          setPage(index)
          await call(props, 'page', { page: index })
          setSearchMessage(`Found on page ${index} of ${pdf.numPages}.`)
          return { found: true, page: index, totalPages: pdf.numPages }
        }
      }
      setSearchMessage('No results')
      return { found: false, totalPages: pdf.numPages }
    } catch (cause) {
      setSearchMessage(cause instanceof Error ? cause.message : 'PDF search failed.')
      throw cause
    }
  }, [pdf, props, query])

  const changeScale = useCallback(async (next: number | 'page-width') => {
    if (!pdf) throw new Error('PDF preview is not ready to zoom.')
    if (typeof next === 'number') await call(props, 'zoom', { scale: next })
    else await props.onAction('quirky.editor/view', {
      bufferId: props.buffer.id,
      action: 'update',
      patch: { viewer: { ...object(props.buffer.view.viewer), zoom: 'page-width' } }
    })
    setScale(next)
    return { zoom: next }
  }, [pdf, props])
  const openFind = useCallback(async (args?: Record<string, unknown>) => {
    const findError = localError || error
    if (findError) throw new Error(findError)
    const requestedQuery = typeof args?.query === 'string' ? args.query : undefined
    if (requestedQuery === undefined || requestedQuery === '') {
      if (requestedQuery === '') setQuery('')
      document.getElementById(searchInputId)?.focus()
      return { opened: true }
    }
    setQuery(requestedQuery)
    return search(requestedQuery)
  }, [error, localError, search])
  useEffect(() => props.registerCommandHandlers({
    find: openFind,
    'zoom-in': () => changeScale(scale === 'page-width' ? 1.25 : Math.min(5, scale * 1.25)),
    'zoom-out': () => changeScale(scale === 'page-width' ? 0.8 : Math.max(0.25, scale / 1.25)),
    'reset-zoom': () => changeScale('page-width')
  }), [changeScale, openFind, props.registerCommandHandlers, scale])



  const goToPage = async (next: number) => {
    if (!pdf || next < 1 || next > pdf.numPages) return
    setPage(next)
    await call(props, 'page', { page: next })
  }

  const onScroll = () => {
    if (scrollTimer.current !== undefined) window.clearTimeout(scrollTimer.current)
    const offset = container.current?.scrollTop ?? 0
    scrollTimer.current = window.setTimeout(() => { void call(props, 'position', { page, offset }) }, 150)
  }

  if (error || localError) return <div role="alert"><p>{localError ?? error}</p><MediaActions props={props} error={localError ?? error} retry={retry} /></div>
  return <section className="viewer-pdf" aria-label="PDF preview">
    <header className="viewer-toolbar">
      <Button type="button" onClick={() => void changeScale(scale === 'page-width' ? 0.8 : Math.max(0.25, scale / 1.25))}>Zoom out</Button>
      <Button type="button" onClick={() => void changeScale('page-width')}>Page width</Button>
      <Button type="button" onClick={() => void changeScale(scale === 'page-width' ? 1.25 : Math.min(5, scale * 1.25))}>Zoom in</Button>
      <span>{scale === 'page-width' ? 'Page width' : `${Math.round(scale * 100)}%`}</span>
      <TextField id={searchInputId} label="Find in PDF" value={query} onChange={(event) => setQuery(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') void search().catch(() => {}) }} />
      <Button type="button" onClick={() => { void search().catch(() => {}) }} disabled={!query.trim()}>Find</Button>
      <Button type="button" onClick={() => void goToPage(page - 1)} disabled={page <= 1}>Previous page</Button>
      <span>{page}{pdf ? ` / ${pdf.numPages}` : ''}</span>
      <Button type="button" onClick={() => void goToPage(page + 1)} disabled={!pdf || page >= pdf.numPages}>Next page</Button>
    </header>
    {searchMessage && <p role="status">{searchMessage}</p>}
    <div ref={container} className="viewer-pdf-page" onScroll={onScroll}>
      {url ? <canvas ref={canvas} aria-label={`PDF page ${page}`} /> : <p role="status">Loading PDF…</p>}
    </div>
    <MediaActions props={props} error={null} retry={retry} />
  </section>
}

function MediaViewer({ props, metadata, url, error, retry }: { props: SurfaceProps; metadata: ViewerMetadata; url: string | null; error: string | null; retry(): void }) {
  const [codecError, setCodecError] = useState<string | null>(null)
  const source = url
  const mediaError = codecError ?? error
  return <section className="viewer-media" aria-label={metadata.kind === 'audio' ? 'Audio preview' : 'Video preview'}>
    {source && metadata.kind === 'audio' && <audio className="viewer-media__audio" controls preload="metadata" src={source} onError={() => setCodecError('Unable to play this media file. The file may be unavailable or use an unsupported codec.')} />}
    {source && metadata.kind === 'video' && <video className="viewer-media__video" controls preload="metadata" src={source} onError={() => setCodecError('Unable to play this media file. The file may be unavailable or use an unsupported codec.')} />}
    {!source && <p role="status">Loading media…</p>}
    <p>{bytesLabel(metadata.size ?? props.buffer.size)}</p>
    <MediaActions props={props} error={mediaError} retry={retry} />
  </section>
}

function MermaidViewer({ props, sourceMode }: { props: SurfaceProps; sourceMode: boolean }) {
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
    if (sourceMode) return
    if (new TextEncoder().encode(source).byteLength > 1024 * 1024) {
      setError('Diagram source exceeds the safe rendering limit. Use Source to edit or view it.')
      return
    }
    let active = true
    setRendering(true)
    setError(null)
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
      if (active) setError(cause instanceof Error ? cause.message : 'Mermaid could not render this diagram.')
    }).finally(() => { if (active) setRendering(false) })
    return () => { active = false }
  }, [id, source, sourceMode, themeRevision])
  if (sourceMode) return <SourceText props={props} value={source} label="Mermaid source" />
  return <section className="viewer-mermaid" aria-label="Mermaid diagram" ref={container}>
    {rendering && <p role="status">Rendering diagram…</p>}
    {error ? <div role="alert"><EmptyState message={error} action={{ label: 'Source', onAction: () => props.onView({ mode: 'source' }) }} /></div> : <div className="viewer-mermaid__diagram" role="img" aria-label="Rendered Mermaid diagram" dangerouslySetInnerHTML={{ __html: svg }} />}
  </section>
}

export function ViewerSurface(props: SurfaceProps) {
  const { buffer, onView } = props
  const canToggleSource = buffer.kind === 'csv' || buffer.kind === 'mermaid'
  const sourceMode = canToggleSource && buffer.mode === 'source'
  const [metadata, setMetadata] = useState<ViewerMetadata>({})
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [retryKey, setRetryKey] = useState(0)

  useEffect(() => {
    let active = true
    let mediaRequested = false
    let leaseId: string | undefined
    const refresh = async () => {
      setLoading(true)
      setError(null)
      setUrl(null)
      try {
        const info = object(await call(props, 'metadata')) as ViewerMetadata
        if (!active) return
        setMetadata(info)
        if (info.error) {
          setError(info.error)
          return
        }
        if (info.changedOnDisk) {
          setError('File changed on disk. Reload before previewing.')
          return
        }
        if (buffer.kind === 'image' && info.previewable === false) {
          setError(info.error ?? 'Failed to load file preview.')
          return
        }
        if (buffer.kind === 'image' || buffer.kind === 'pdf' || buffer.kind === 'audio' || buffer.kind === 'video') {
          leaseId = crypto.randomUUID()
          mediaRequested = true
          const resource = object(await call(props, 'media', { leaseId }))
          if (!active) {
            void call(props, 'release', { leaseId }).catch(() => {})
            return
          }
          if (resource.changedOnDisk === true) {
            setError(typeof resource.error === 'string' ? resource.error : 'File changed on disk. Reload before previewing.')
            return
          }
          const resourceUrl = string(resource.url)
          if (!resourceUrl) throw new Error(typeof resource.error === 'string' ? resource.error : 'The viewer resource is unavailable.')
          setUrl(resourceUrl)
        }
      } catch (cause) {
        if (active) setError(cause instanceof Error ? cause.message : String(cause))
      } finally {
        if (active) setLoading(false)
      }
    }
    void refresh()
    return () => {
      active = false
      if (mediaRequested && leaseId !== undefined) void call(props, 'release', { leaseId }).catch(() => {})
    }
  }, [buffer.id, buffer.contentRevision, buffer.external, buffer.kind, retryKey, sourceMode])

  const retry = () => setRetryKey((value) => value + 1)
  const reload = async () => {
    setLoading(true)
    try {
      await props.onAction('quirky.editor/view', { bufferId: buffer.id, action: 'reload' })
      setError(null)
      setRetryKey((value) => value + 1)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setLoading(false)
    }
  }

  if (buffer.size > MAX_FILE_BYTES) return <section className="viewer-empty" role="alert">
    <EmptyState message="File is too large to preview." action={{ label: 'Retry', onAction: retry }} />
  </section>

  return <section className="quirky-viewer-surface" aria-label={`${buffer.kind} viewer`} style={{ fontSize: props.fontSize }}>
    <header className="viewer-toolbar">
      <strong>{buffer.name}</strong>
      {canToggleSource && <Button className="editor-viewer-mode-toggle" type="button" aria-pressed={sourceMode} onClick={() => onView({ mode: sourceMode ? 'rich' : 'source' })}>{sourceMode ? 'Table / Preview' : 'Source'}</Button>}
      {buffer.kind === 'image' && metadata.width !== undefined && <Badge>{metadata.width} × {metadata.height} · {bytesLabel(metadata.bytes ?? buffer.size)}</Badge>}
      {(buffer.kind === 'audio' || buffer.kind === 'video') && <Badge>{metadata.contentType ?? 'Media'}</Badge>}
    </header>
    {buffer.external === 'changed' && <p className="viewer-notice" role="status">File changed on disk. Reload the viewer. <Button type="button" onClick={() => void reload()} disabled={loading}>Reload</Button></p>}
    {loading && <p role="status">Loading preview…</p>}
    {error && <div className="viewer-error" role="alert"><EmptyState message={error} action={buffer.external === 'changed' ? { label: 'Reload', onAction: () => void reload() } : { label: 'Retry', onAction: retry }} /></div>}
    {buffer.kind === 'csv' && <CsvSurface props={props} sourceMode={sourceMode} />}
    {buffer.kind === 'image' && !sourceMode && <ImageViewer props={props} metadata={metadata} url={url} error={error} retry={retry} />}
    {buffer.kind === 'pdf' && <PdfViewer props={props} url={url} error={error} retry={retry} />}
    {(buffer.kind === 'audio' || buffer.kind === 'video') && <MediaViewer props={props} metadata={metadata} url={url} error={error} retry={retry} />}
    {buffer.kind === 'mermaid' && <MermaidViewer props={props} sourceMode={sourceMode} />}
    {buffer.kind === 'binary' && <div role="alert"><EmptyState message="Binary file — cannot display." action={{ label: 'Retry', onAction: retry }} /></div>}
    {!['csv', 'image', 'pdf', 'audio', 'video', 'mermaid', 'binary'].includes(buffer.kind) && <div role="alert"><EmptyState message="Unsupported file viewer." /></div>}
  </section>
}