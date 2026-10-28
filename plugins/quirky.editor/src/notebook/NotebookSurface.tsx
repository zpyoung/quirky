import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import type { SurfaceProps } from '../types'
import { parseNotebook, serializeNotebook, sourceLines, type NotebookParse } from './document'
import { base64ImageDataUrl, outputText, parseAnsi, preferredOutput, sanitizeHtml } from './outputs'

type ApiRecord = Record<string, unknown>
type KernelState = { status?: string; pid?: number; stderr?: string; error?: string | null; busy?: boolean; executionCount?: number | null }
type NotebookRuntimeState = { trusted?: boolean; busy?: boolean; executionCount?: number | null; interruptStalled?: boolean; selectedPython?: { path?: string; name?: string; version?: string } | null; kernel?: KernelState }
type Environment = { path: string; name: string; version?: string; source?: string; hasIpykernel?: boolean; externallyManaged?: boolean }
type TrustRequest = { index: number | null; all: boolean; mode: 'advance' | 'in-place' }

const sourceStyle: CSSProperties = { width: '100%', minHeight: 100, resize: 'vertical', fontFamily: 'monospace' }
const outputStyle: CSSProperties = { maxHeight: 420, overflow: 'auto', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }
const imageStyle: CSSProperties = { display: 'block', maxWidth: '100%', maxHeight: 520, objectFit: 'contain' }
const MAX_CELL_PREVIEW_BYTES = 64 * 1024
const MAX_CELL_PREVIEW_LINES = 200
const CELL_PAGE_SIZE = 100
const OUTPUT_PAGE_SIZE = 20

function cellPreview(text: string): { text: string; truncated: boolean } {
  let end = 0
  let bytes = 0
  for (const codePoint of text) {
    const width = codePoint.codePointAt(0)! <= 0x7f ? 1 : codePoint.codePointAt(0)! <= 0x7ff ? 2 : codePoint.length === 1 ? 3 : 4
    if (bytes + width > MAX_CELL_PREVIEW_BYTES) break
    bytes += width
    end += codePoint.length
  }
  const source = text.slice(0, end)
  const lines = source.split(/\r\n|\r|\n/)
  const visible = lines.slice(0, MAX_CELL_PREVIEW_LINES).join('\n')
  return { text: visible, truncated: end < text.length || lines.length > MAX_CELL_PREVIEW_LINES }
}

function asRecord(value: unknown): ApiRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ApiRecord : {}
}

function notebookRuntime(value: unknown): NotebookRuntimeState {
  const state = asRecord(value)
  return {
    trusted: state.trusted === true,
    busy: state.busy === true,
    executionCount: typeof state.executionCount === 'number' ? state.executionCount : null,
    interruptStalled: state.interruptStalled === true,
    selectedPython: state.selectedPython && typeof state.selectedPython === 'object' ? asRecord(state.selectedPython) as NotebookRuntimeState['selectedPython'] : null,
    kernel: state.kernel && typeof state.kernel === 'object' ? asRecord(state.kernel) as KernelState : { status: 'stopped' }
  }
}

function outputColor(name: string): string | undefined {
  const ansi = /^rgb\((\d+), (\d+), (\d+)\)$/.exec(name)
  if (ansi) return name
  return name.startsWith('#') ? name : undefined
}

function StreamOutput({ output }: { output: ApiRecord }) {
  const stream = outputText(output)
  return <pre style={outputStyle} data-output-type={output.output_type === 'error' ? 'error' : output.name === 'stderr' ? 'stderr' : 'stdout'}>
    {parseAnsi(stream).map((segment, index) => <span key={index} style={{
      color: segment.style.color ? outputColor(segment.style.color) : undefined,
      backgroundColor: segment.style.backgroundColor ? outputColor(segment.style.backgroundColor) : undefined,
      fontWeight: segment.style.fontWeight,
      fontStyle: segment.style.fontStyle,
      textDecoration: segment.style.textDecoration
    }}>{segment.text}</span>)}
  </pre>
}

function MimeOutput({ output }: { output: ApiRecord }) {
  const selected = preferredOutput(output)
  if (!selected) return null
  if (selected.mime === 'text/html' && typeof selected.value === 'string') {
    return <iframe title="Notebook HTML output" sandbox="" referrerPolicy="no-referrer" srcDoc={sanitizeHtml(selected.value)} style={{ width: '100%', height: 288, border: 0 }} />
  }
  if (selected.mime.startsWith('image/')) {
    const src = base64ImageDataUrl(selected.mime, selected.value)
    if (!src) return <p role="status">Image output is too large or malformed.</p>
    return <img src={src} alt="Notebook output" style={imageStyle} />
  }
  const value = outputText(output)
  return <pre style={outputStyle} data-output-mime={selected.mime}>{value}</pre>
}

function CellOutput({ output }: { output: ApiRecord }) {
  if (output.output_type === 'stream' || output.output_type === 'error') return <StreamOutput output={output} />
  return <MimeOutput output={output} />
}

export function NotebookSurface(props: SurfaceProps) {
  const { buffer, onAction, onDraft, onView } = props
  const content = buffer.draft !== null ? buffer.draft : buffer.content
  const parsed: NotebookParse = useMemo(() => parseNotebook(content), [content])
  const cells = parsed.valid ? parsed.cells : []
  const [runtime, setRuntime] = useState<NotebookRuntimeState>({ trusted: false, busy: false, kernel: { status: 'stopped' } })
  const [environmentChoices, setEnvironmentChoices] = useState<Environment[]>([])
  const [editingCell, setEditingCell] = useState<number | null>(null)
  const [cellDrafts, setCellDrafts] = useState<Record<number, string>>({})
  const [trustRequest, setTrustRequest] = useState<TrustRequest | null>(null)
  const [setupPrompt, setSetupPrompt] = useState<'install' | 'venv' | null>(null)
  const [setupError, setSetupError] = useState<string | null>(null)
  const [sourceError, setSourceError] = useState<string | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [kernelError, setKernelError] = useState<string | null>(null)
  const [cellOffset, setCellOffset] = useState(0)
  const [outputLimits, setOutputLimits] = useState<Record<number, number>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const findInput = useRef<HTMLInputElement>(null)
  const cellElements = useRef(new Map<number, HTMLElement>())
  const cellTextareas = useRef(new Map<number, HTMLTextAreaElement>())
  const pendingCellChanges = useRef(new Map<number, string>())
  const cellTimer = useRef<number | undefined>(undefined)
  const sourceMode = buffer.mode === 'source'
  const bufferId = buffer.id

  useEffect(() => {
    let active = true
    void onAction('quirky.editor/notebook', { bufferId, action: 'state' }).then((value) => {
      if (active) setRuntime(notebookRuntime(value))
    }).catch((error: unknown) => {
      if (active) setKernelError(error instanceof Error ? error.message : String(error))
    })
    return () => { active = false }
  }, [bufferId, buffer.contentRevision, onAction])

  useEffect(() => {
    setCellDrafts({})
    setEditingCell(null)
    setCellOffset(0)
    setOutputLimits({})
    setSourceError(null)
  }, [bufferId, buffer.contentRevision])

  const refreshRuntime = async () => {
    const result = await onAction('quirky.editor/notebook', { bufferId, action: 'state' })
    setRuntime(notebookRuntime(result))
  }

  const action = async (name: string, fields: Record<string, unknown> = {}): Promise<unknown> =>
    onAction('quirky.editor/notebook', { bufferId, action: name, ...fields })

  const flushCellChanges = () => {
    if (cellTimer.current !== undefined) {
      window.clearTimeout(cellTimer.current)
      cellTimer.current = undefined
    }
    if (pendingCellChanges.current.size === 0 || !parsed.document) return
    const updated = structuredClone(parsed.document)
    for (const [index, value] of pendingCellChanges.current) {
      const cell = updated.cells[index]
      if (cell) cell.source = sourceLines(value)
    }
    pendingCellChanges.current.clear()
    onDraft(serializeNotebook(updated))
  }

  const flushCellChangesRef = useRef(flushCellChanges)
  flushCellChangesRef.current = flushCellChanges
  useEffect(() => () => flushCellChangesRef.current(), [bufferId])

  const saveNotebook = async () => {
    flushCellChanges()
    try {
      await action('save')
      setSourceError(null)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    }
  }

  const mutateNotebook = async (name: string, fields: Record<string, unknown>) => {
    flushCellChanges()
    try {
      await action(name, fields)
      setSourceError(null)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    }
  }

  const toggleSource = () => {
    flushCellChanges()
    onView({ mode: sourceMode ? 'rich' : 'source' })
  }

  const startRun = async (request: TrustRequest) => {
    flushCellChanges()
    setActionBusy(true)
    setKernelError(null)
    try {
      if (request.all) {
        const result = asRecord(await action('runAll'))
        if (result.status === 'missing-ipykernel') {
          setSetupPrompt(result.externallyManaged === true ? 'venv' : 'install')
        } else if (result.status === 'failed' || result.status === 'dead' || result.status === 'error') {
          setKernelError(typeof result.stderr === 'string' ? result.stderr : 'Notebook execution failed.')
        }
      } else if (request.index !== null) {
        const result = asRecord(await action('run', { index: request.index, mode: request.mode }))
        if (result.status === 'missing-ipykernel') {
          setSetupPrompt(result.externallyManaged === true ? 'venv' : 'install')
        } else if (result.status === 'failed' || result.status === 'dead' || result.status === 'error') {
          setKernelError(typeof result.stderr === 'string' ? result.stderr : 'Notebook execution failed.')
        } else if (request.mode === 'advance' && typeof result.nextIndex === 'number' && result.nextIndex < cells.length) {
          setEditingCell(result.nextIndex)
        }
      }
      await refreshRuntime()
    } catch (error) {
      setKernelError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionBusy(false)
      setTrustRequest(null)
    }
  }

  const requestRun = (request: TrustRequest) => {
    if (!runtime.trusted) setTrustRequest(request)
    else void startRun(request)
  }

  const grantTrustAndRun = async () => {
    if (!trustRequest) return
    setActionBusy(true)
    try {
      await action('trust')
      await refreshRuntime()
      await startRun(trustRequest)
    } catch (error) {
      setKernelError(error instanceof Error ? error.message : String(error))
      setActionBusy(false)
      setTrustRequest(null)
    }
  }

  const loadEnvironments = async () => {
    setSourceError(null)
    try {
      const result = asRecord(await action('environments'))
      setEnvironmentChoices(Array.isArray(result.environments) ? result.environments.map((entry) => asRecord(entry) as Environment) : [])
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    }
  }

  const selectEnvironment = async (path: string) => {
    setActionBusy(true)
    try {
      const selected = asRecord(await action('select', { python: path }))
      if (selected.cancelled === true) return
      await refreshRuntime()
      setEnvironmentChoices([])
      setKernelError(null)
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionBusy(false)
    }
  }

  const browseEnvironment = async () => {
    setActionBusy(true)
    try {
      const selected = asRecord(await action('select', { browse: true }))
      if (selected.cancelled === true) return
      await refreshRuntime()
      setKernelError(null)
      setEnvironmentChoices([])
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionBusy(false)
    }
  }

  const setup = async (kind: 'install' | 'venv') => {
    setActionBusy(true)
    setSetupError(null)
    try {
      const result = asRecord(await action(kind, runtime.selectedPython?.path ? { python: runtime.selectedPython.path } : {}))
      if (result.status === 'venv-required') setSetupPrompt('venv')
      else setSetupPrompt(null)
      if (result.status === 'failed' || result.status === 'venv-required') setSetupError(typeof result.error === 'string' ? result.error : 'Python environment setup needs attention.')
      await refreshRuntime()
    } catch (error) {
      setSetupError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionBusy(false)
    }
  }

  const updateCell = (index: number, value: string) => {
    setCellDrafts((current) => ({ ...current, [index]: value }))
    pendingCellChanges.current.set(index, value)
    if (cellTimer.current !== undefined) window.clearTimeout(cellTimer.current)
    cellTimer.current = window.setTimeout(() => flushCellChangesRef.current(), 400)
  }

  const insertCell = async (index: number, position: 'above' | 'below', cellType: 'code' | 'markdown' | 'raw') => {
    flushCellChanges()
    setActionBusy(true)
    try {
      await action('insert', { index, position, cellType })
    } catch (error) {
      setSourceError(error instanceof Error ? error.message : String(error))
    } finally {
      setActionBusy(false)
    }
  }

  const onCellKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => {
    if (event.key !== 'Enter' || !event.shiftKey && !event.metaKey && !event.ctrlKey) return
    if (event.metaKey || event.ctrlKey) {
      event.preventDefault()
      requestRun({ index, all: false, mode: 'in-place' })
    } else if (event.shiftKey) {
      event.preventDefault()
      requestRun({ index, all: false, mode: 'advance' })
    }
  }
  const findNotebookMatches = useCallback((query: string) => {
    const needle = query.toLocaleLowerCase()
    if (needle === '') return []
    const matches: { cellIndex: number; from: number; to: number }[] = []
    for (let cellIndex = 0; cellIndex < cells.length; cellIndex += 1) {
      const text = cellDrafts[cellIndex] ?? cells[cellIndex]!.source
      const lower = text.toLocaleLowerCase()
      let from = lower.indexOf(needle)
      while (from >= 0 && matches.length < 10_000) {
        matches.push({ cellIndex, from, to: from + needle.length })
        from = lower.indexOf(needle, from + needle.length)
      }
      if (matches.length === 10_000) break
    }
    return matches
  }, [cellDrafts, cells])
  const findMatches = useMemo(() => findNotebookMatches(findQuery), [findNotebookMatches, findQuery])
  const selectNotebookMatch = useCallback((match: { cellIndex: number; from: number; to: number }) => {
    setCellOffset(Math.floor(match.cellIndex / CELL_PAGE_SIZE) * CELL_PAGE_SIZE)
    setEditingCell(match.cellIndex)
    window.requestAnimationFrame(() => {
      cellElements.current.get(match.cellIndex)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      const textarea = cellTextareas.current.get(match.cellIndex)
      if (textarea) {
        textarea.focus()
        textarea.setSelectionRange(match.from, match.to)
      }
    })
  }, [])
  const moveFind = (direction: number) => {
    if (findMatches.length === 0) throw new Error('Enter text found in the notebook before moving between matches.')
    const next = findIndex < 0
      ? (direction < 0 ? findMatches.length - 1 : 0)
      : (findIndex + direction + findMatches.length) % findMatches.length
    setFindIndex(next)
    selectNotebookMatch(findMatches[next]!)
    return { match: next + 1, total: findMatches.length, truncated: findMatches.length === 10_000 }
  }
  const openFind = useCallback((args?: Record<string, unknown>) => {
    const query = typeof args?.query === 'string' ? args.query : undefined
    setFindOpen(true)
    if (query !== undefined) setFindQuery(query)
    window.requestAnimationFrame(() => findInput.current?.focus())
    if (query === undefined || query === '') return { opened: true }
    const matches = findNotebookMatches(query)
    if (matches.length === 0) throw new Error(`No notebook cell contains “${query}”.`)
    setFindIndex(0)
    selectNotebookMatch(matches[0]!)
    return { opened: true, query, matches: matches.length, truncated: matches.length === 10_000 }
  }, [findNotebookMatches, selectNotebookMatch])
  useEffect(() => props.registerCommandHandlers({
    find: openFind,
    flush: () => flushCellChangesRef.current()
  }), [openFind, props.registerCommandHandlers])

  const visibleCellEnd = Math.min(cellOffset + CELL_PAGE_SIZE, cells.length)
  const visibleCells = cells.slice(cellOffset, visibleCellEnd)

  return <section className="quirky-notebook-surface" aria-label="Notebook" style={{ fontSize: props.fontSize }}>
    <header className="notebook-toolbar">
      <strong>{buffer.name}</strong>
      <span>{parsed.valid ? `${parsed.cellCount} cells · ${parsed.language}` : 'Notebook parse error'}</span>
      <button type="button" aria-pressed={sourceMode} onClick={toggleSource}>
        {sourceMode ? 'Notebook' : 'Source'}
      </button>
      <button type="button" onClick={() => void saveNotebook()} disabled={buffer.readOnly || actionBusy}>Save notebook</button>
      <button type="button" onClick={() => { setFindOpen(true); window.requestAnimationFrame(() => findInput.current?.focus()) }}>Find</button>
      {!sourceMode && parsed.valid && parsed.language.startsWith('python') && <>
        <button type="button" onClick={() => void loadEnvironments()} disabled={actionBusy}>
          {runtime.selectedPython?.name ? `${runtime.selectedPython.name}${runtime.selectedPython.version ? ` (Python ${runtime.selectedPython.version})` : ''}` : 'Select Kernel'}
        </button>
        <button type="button" onClick={() => requestRun({ index: null, all: true, mode: 'in-place' })} disabled={actionBusy || buffer.readOnly}>Run all</button>
        <button type="button" onClick={() => void mutateNotebook('clear', {})} disabled={actionBusy || buffer.readOnly}>Clear all outputs</button>
        {runtime.busy && <button type="button" onClick={() => void action('interrupt')} disabled={actionBusy}>Interrupt</button>}
        {runtime.kernel?.status === 'ready' && <button type="button" onClick={() => void action('restart').then(refreshRuntime)} disabled={actionBusy}>Restart kernel</button>}
      </>}
    </header>
    {findOpen && <div className="notebook-toolbar" role="search" aria-label="Find in notebook">
      <input
        ref={findInput}
        aria-label="Find in notebook"
        value={findQuery}
        onChange={(event) => { setFindQuery(event.currentTarget.value); setFindIndex(-1) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            try { moveFind(1) } catch (error) { setSourceError(error instanceof Error ? error.message : String(error)) }
          } else if (event.key === 'Escape') {
            event.preventDefault()
            setFindOpen(false)
          }
        }}
      />
      <span>{findMatches.length === 10_000 ? '10,000+ matches' : `${findMatches.length} match${findMatches.length === 1 ? '' : 'es'}`}</span>
      <button type="button" onClick={() => { try { moveFind(-1) } catch (error) { setSourceError(error instanceof Error ? error.message : String(error)) } }} disabled={findMatches.length === 0}>Previous</button>
      <button type="button" onClick={() => { try { moveFind(1) } catch (error) { setSourceError(error instanceof Error ? error.message : String(error)) } }} disabled={findMatches.length === 0}>Next</button>
      <button type="button" onClick={() => setFindOpen(false)}>Close</button>
    </div>}

    {sourceMode ? <textarea
      aria-label="Notebook source JSON"
      style={{ ...sourceStyle, minHeight: 420, fontSize: props.fontSize }}
      spellCheck={false}
      value={content}
      onChange={(event) => onDraft(event.currentTarget.value)}
    /> : parsed.valid ? <main className="notebook-cells">
      {cells.length === 0 && <p>Empty notebook</p>}
      {cells.length > CELL_PAGE_SIZE && <nav aria-label="Notebook cell pages">
        <span>Cells {cellOffset + 1}–{visibleCellEnd} of {cells.length}</span>
        <button type="button" onClick={() => setCellOffset(Math.max(0, cellOffset - CELL_PAGE_SIZE))} disabled={cellOffset === 0}>Previous cells</button>
        <button type="button" onClick={() => setCellOffset(Math.min(cells.length - 1, cellOffset + CELL_PAGE_SIZE))} disabled={visibleCellEnd >= cells.length}>Next cells</button>
      </nav>}
      {visibleCells.map((cell, visibleIndex) => {
        const index = cellOffset + visibleIndex
        const cellText = cellDrafts[index] ?? cell.source
        const preview = cellPreview(cellText)
        const isEditing = editingCell === index
        const outputList = Array.isArray(cell.outputs) ? cell.outputs.map(asRecord) : []
        const outputLimit = outputLimits[index] ?? OUTPUT_PAGE_SIZE
        const visibleOutputs = outputList.slice(0, outputLimit)
        return <article className={`notebook-cell notebook-cell-${cell.cell_type}`} key={cell.id ?? index} ref={(element) => {
          if (element) cellElements.current.set(index, element)
          else cellElements.current.delete(index)
        }}>
          <div className="notebook-cell-toolbar">
            <span aria-label="Cell type">{cell.cell_type}</span>
            {cell.cell_type === 'code' && <span aria-label="Execution count">[{typeof cell.execution_count === 'number' ? cell.execution_count : runtime.busy ? '*' : ' '}]</span>}
            {cell.cell_type === 'code' && <button type="button" onClick={() => requestRun({ index, all: false, mode: 'in-place' })} disabled={actionBusy || buffer.readOnly}>Run cell</button>}
            <button type="button" onClick={() => setEditingCell(isEditing ? null : index)} disabled={buffer.readOnly}>{isEditing ? 'Done editing' : 'Edit cell'}</button>
            <details>
              <summary>More cell actions</summary>
              <button type="button" onClick={() => void insertCell(index, 'above', 'code')} disabled={actionBusy || buffer.readOnly}>Insert code above</button>
              <button type="button" onClick={() => void insertCell(index, 'above', 'markdown')} disabled={actionBusy || buffer.readOnly}>Insert Markdown above</button>
              <button type="button" onClick={() => void insertCell(index, 'above', 'raw')} disabled={actionBusy || buffer.readOnly}>Insert raw above</button>
              <button type="button" onClick={() => void insertCell(index, 'below', 'code')} disabled={actionBusy || buffer.readOnly}>Insert code below</button>
              <button type="button" onClick={() => void insertCell(index, 'below', 'markdown')} disabled={actionBusy || buffer.readOnly}>Insert Markdown below</button>
              <button type="button" onClick={() => void insertCell(index, 'below', 'raw')} disabled={actionBusy || buffer.readOnly}>Insert raw below</button>
            </details>
            <button type="button" onClick={() => void mutateNotebook('move', { index, direction: 'up' })} disabled={actionBusy || buffer.readOnly || index === 0}>Move up</button>
            <button type="button" onClick={() => void mutateNotebook('move', { index, direction: 'down' })} disabled={actionBusy || buffer.readOnly || index === cells.length - 1}>Move down</button>
            <select aria-label="Cell type" value={cell.cell_type} disabled={actionBusy || buffer.readOnly} onChange={(event) => void mutateNotebook('type', { index, cellType: event.currentTarget.value })}>
              <option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option>
            </select>
            {cell.cell_type === 'code' && <button type="button" onClick={() => void mutateNotebook('clear', { index })} disabled={actionBusy || buffer.readOnly}>Clear outputs</button>}
            <button type="button" onClick={() => void mutateNotebook('delete', { index })} disabled={actionBusy || buffer.readOnly}>Delete cell</button>
          </div>
          {isEditing ? <textarea
            ref={(element) => {
              if (element) cellTextareas.current.set(index, element)
              else cellTextareas.current.delete(index)
            }}
            style={{ ...sourceStyle, fontSize: props.fontSize }}
            spellCheck={cell.cell_type === 'markdown'}
            value={cellText}
            onKeyDown={cell.cell_type === 'code' ? (event) => onCellKeyDown(event, index) : undefined}
            onChange={(event) => updateCell(index, event.currentTarget.value)}
            readOnly={buffer.readOnly}
          /> : <pre className="notebook-cell-source" onClick={() => setEditingCell(index)}>{preview.text}</pre>}
          {preview.truncated && !isEditing && <p role="status">Cell preview limited to 200 lines or 64 KiB. Edit this cell to access its complete source.</p>}
          {visibleOutputs.length > 0 && <div className="notebook-cell-outputs" aria-label={`Outputs for cell ${index + 1}`}>
            {visibleOutputs.map((output, outputIndex) => <CellOutput key={`${output.output_type}-${outputIndex}`} output={output} />)}
            {outputList.length > outputLimit && <>
              <p role="status">Showing {outputLimit} of {outputList.length} output frames.</p>
              <button type="button" onClick={() => setOutputLimits((current) => ({ ...current, [index]: outputLimit + OUTPUT_PAGE_SIZE }))}>Show next output frames</button>
            </>}
          </div>}
        </article>
      })}
      {cells.length > CELL_PAGE_SIZE && <nav aria-label="Notebook cell pages">
        <button type="button" onClick={() => setCellOffset(Math.max(0, cellOffset - CELL_PAGE_SIZE))} disabled={cellOffset === 0}>Previous cells</button>
        <button type="button" onClick={() => setCellOffset(Math.min(cells.length - 1, cellOffset + CELL_PAGE_SIZE))} disabled={visibleCellEnd >= cells.length}>Next cells</button>
      </nav>}
      <button type="button" onClick={() => { setCellOffset(Math.max(0, Math.floor(cells.length / CELL_PAGE_SIZE) * CELL_PAGE_SIZE)); void insertCell(cells.length, 'below', 'code') }} disabled={actionBusy || buffer.readOnly}>Add code cell</button>
    </main> : <div role="alert" className="notebook-error">
      <p>{parsed.error}</p>
      <button type="button" onClick={() => onView({ mode: 'source' })}>Open raw source</button>
    </div>}

    {environmentChoices.length > 0 && <section className="notebook-kernel-menu" aria-label="Python environments">
      <strong>Recommended and Python on PATH</strong>
      <ul>{environmentChoices.map((environment) => <li key={environment.path}>
        <button type="button" onClick={() => void selectEnvironment(environment.path)} disabled={actionBusy}>
          {environment.name}{environment.version ? ` · Python ${environment.version}` : ''} — {environment.path}
        </button>
      </li>)}</ul>
      <button type="button" onClick={() => void browseEnvironment()} disabled={actionBusy}>Browse for Python…</button>
      <button type="button" onClick={() => setEnvironmentChoices([])}>Cancel</button>
    </section>}

    {trustRequest && <div role="dialog" aria-modal="true" aria-labelledby="notebook-trust-title" className="notebook-confirmation">
      <h2 id="notebook-trust-title">Run Notebook Code?</h2>
      <p>Notebook cells execute local Python on this machine from the notebook folder. Only run cells from files you trust.</p>
      <button type="button" onClick={() => setTrustRequest(null)} disabled={actionBusy}>Cancel</button>
      <button type="button" onClick={() => void grantTrustAndRun()} disabled={actionBusy}>{trustRequest.all ? 'Run all' : 'Run cell'}</button>
    </div>}

    {setupPrompt && <div role="dialog" aria-modal="true" aria-labelledby="notebook-setup-title" className="notebook-confirmation">
      <h2 id="notebook-setup-title">{setupPrompt === 'venv' ? 'Create a virtual environment?' : 'Install ipykernel?'}</h2>
      <p>{setupPrompt === 'venv' ? 'A workspace .venv will be created and ipykernel installed there.' : 'This installs or upgrades ipykernel in the selected Python environment.'}</p>
      {setupError && <p role="alert">{setupError}</p>}
      <button type="button" onClick={() => setSetupPrompt(null)} disabled={actionBusy}>Cancel</button>
      <button type="button" onClick={() => void setup(setupPrompt)} disabled={actionBusy}>{setupPrompt === 'venv' ? 'Create .venv' : 'Install'}</button>
      {setupPrompt === 'install' && <button type="button" onClick={() => { setSetupPrompt(null); void loadEnvironments() }}>Use another Python</button>}
    </div>}

    {runtime.interruptStalled && <p role="status">Not responding. Restart kernel.</p>}
    {sourceError && <p role="alert">{sourceError}</p>}
    {kernelError && <p role="alert">{kernelError}</p>}
    {runtime.kernel?.status === 'dead' && <p role="alert">The kernel died. {runtime.kernel.stderr}</p>}
    {runtime.kernel?.error && runtime.kernel.status !== 'dead' && <p role="alert">{runtime.kernel.error}</p>}
  </section>
}
