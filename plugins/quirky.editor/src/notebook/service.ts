import { spawn } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'
import type { MethodHandler, PluginCaller } from '@quirky/protocol'
import type { EditorBuffer, EditorServices, FeatureMethods } from '../types'
import {
  ensureExecutableCells,
  makeCell,
  notebookLanguage,
  parseNotebook,
  parseNotebookRoot,
  serializeNotebook,
  sourceLines,
  sourceText,
  type JsonObject,
  type NotebookCell,
  type NotebookCellType,
  type NotebookDocument,
  type NotebookParse
} from './document'
import { KernelSession, type KernelFrame, type KernelStartResult } from './kernel'
import {
  createWorkspaceVenv,
  describeCandidates,
  describePython,
  discoverPythonCandidates,
  installIpykernel,
  type PythonCandidate,
  type PythonEnvironment
} from './python'

type RuntimeState = {
  trusted: boolean
  selected: PythonEnvironment | null
  kernel: KernelSession | null
  interruptStalled: boolean
  lastSetupError: string | null
}
type NotebookLocation = { root: string; directory: string }
type ExecutionGroupResult = {
  status: 'ok' | 'error' | 'dead' | 'missing-ipykernel' | 'failed'
  completed: number
  cancelled: number
  executionCount: number | null
  outputs: JsonObject[]
  stderr?: string
  externallyManaged?: boolean
}
type Action =
  | 'parse' | 'edit' | 'insert' | 'move' | 'delete' | 'type' | 'clear' | 'save'
  | 'environments' | 'describe' | 'select' | 'trust' | 'install' | 'venv' | 'start'
  | 'run' | 'runAll' | 'interrupt' | 'restart' | 'shutdown' | 'state'

const ACTIONS = new Set<Action>([
  'parse', 'edit', 'insert', 'move', 'delete', 'type', 'clear', 'save', 'environments',
  'describe', 'select', 'trust', 'install', 'venv', 'start', 'run', 'runAll', 'interrupt',
  'restart', 'shutdown', 'state'
])
const MAX_OUTPUT_TEXT = 512 * 1024
const SAFE_MIMES = new Set([
  'text/html', 'image/png', 'image/gif', 'image/webp', 'image/bmp', 'image/jpeg', 'image/jpg',
  'image/svg+xml', 'application/json', 'text/markdown', 'text/plain'
])
const OUTPUT_TYPES = new Set(['stream', 'display_data', 'execute_result', 'update_display_data', 'clear_output', 'error'])

function error(host: EditorServices, kind: 'invalid-params' | 'conflict' | 'not-found', message: string): never {
  throw host.context.error(kind, message)
}

function requiredString(host: EditorServices, value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) error(host, 'invalid-params', `${label} is required`)
  return value
}

function requiredIndex(host: EditorServices, value: unknown, label = 'index'): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) error(host, 'invalid-params', `${label} must be a non-negative integer`)
  return value
}

function currentText(buffer: EditorBuffer): string {
  return buffer.draft !== null ? buffer.draft : buffer.content
}

function parsedOrThrow(host: EditorServices, text: string): NotebookDocument {
  try {
    return parseNotebookRoot(text)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    error(host, 'invalid-params', `Unable to edit notebook: ${detail}`)
  }
}

function cellAt(host: EditorServices, document: NotebookDocument, index: number): NotebookCell {
  const cell = document.cells[index]
  if (!cell) error(host, 'invalid-params', `cell index ${index} is out of range`)
  return cell
}

function actualPathInside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path))
}

async function localLocation(host: EditorServices, bufferId: string, caller: PluginCaller): Promise<NotebookLocation> {
  const buffer = host.get(bufferId)
  if (buffer.kind !== 'notebook') error(host, 'invalid-params', 'Python actions require a notebook buffer')
  let selected: { id: string; path: string }
  let path: string
  try {
    selected = await host.resolve(buffer.worktreeId, caller)
    path = await host.path(buffer.worktreeId, buffer.relativePath)
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    error(host, 'conflict', `Notebook execution requires a resolved local worktree: ${detail}`)
  }
  if (selected.id !== buffer.worktreeId || !isAbsolute(selected.path) || !isAbsolute(path)) {
    error(host, 'conflict', 'Notebook cells can only run for files on this computer.')
  }
  let root: string
  let realFile: string
  try {
    root = realpathSync(selected.path)
    realFile = realpathSync(path)
  } catch {
    error(host, 'conflict', 'Notebook file or worktree no longer exists locally.')
  }
  if (!actualPathInside(root, realFile) || !statSync(realFile).isFile()) {
    error(host, 'conflict', 'Notebook path is not a regular file inside its local worktree.')
  }
  return { root, directory: dirname(realFile) }
}

async function withBufferMutation<T>(
  host: EditorServices,
  bufferId: string,
  locks: Map<string, Promise<void>>,
  mutate: (document: NotebookDocument) => T
): Promise<{ document: NotebookDocument; result: T }> {
  const previous = locks.get(bufferId) ?? Promise.resolve()
  const slot = Promise.withResolvers<void>()
  const tail = previous.then(() => slot.promise)
  locks.set(bufferId, tail)
  await previous
  try {
    const buffer = host.get(bufferId)
    const revision = buffer.contentRevision
    const document = parsedOrThrow(host, currentText(buffer))
    const result = mutate(document)
    await host.draft(bufferId, serializeNotebook(document), revision)
    return { document, result }
  } finally {
    slot.resolve()
    if (locks.get(bufferId) === tail) locks.delete(bufferId)
  }
}

function insertCell(document: NotebookDocument, index: number, position: 'above' | 'below', type: NotebookCellType, language: string): void {
  const target = Math.min(index, document.cells.length)
  const insertion = position === 'below' && target < document.cells.length ? target + 1 : target
  document.cells.splice(insertion, 0, makeCell(type, language))
}

function setCellType(cell: NotebookCell, type: NotebookCellType, language: string): void {
  if (cell.cell_type === type) return
  cell.cell_type = type
  if (type === 'code') {
    cell.execution_count = null
    cell.outputs = []
    const vscode = cell.metadata.vscode
    cell.metadata.vscode = { ...(vscode && typeof vscode === 'object' && !Array.isArray(vscode) ? vscode as JsonObject : {}), languageId: language }
  } else {
    delete cell.execution_count
    delete cell.outputs
  }
}

function updateOutput(document: NotebookDocument, index: number, frame: KernelFrame, clearAfter: { value: boolean }): void {
  const cell = document.cells[index]
  if (!cell || cell.cell_type !== 'code') return
  cell.outputs ??= []
  if (frame.type === 'clear_output') {
    const wait = frame.content?.wait === true
    if (wait) clearAfter.value = true
    else cell.outputs = []
    return
  }
  if (!OUTPUT_TYPES.has(frame.type) || frame.type === 'done') return
  if (clearAfter.value) {
    cell.outputs = []
    clearAfter.value = false
  }
  const content = frame.content ?? {}
  if (frame.type === 'stream') {
    const name = content.name === 'stderr' ? 'stderr' : 'stdout'
    const text = typeof content.text === 'string' ? content.text : ''
    const last = cell.outputs.at(-1)
    if (last?.output_type === 'stream' && last.name === name && typeof last.text === 'string') {
      last.text = mergeStreamText(last.text, text)
    } else {
      cell.outputs.push({ output_type: 'stream', name, text })
    }
    return
  }
  if (frame.type === 'error') {
    cell.outputs.push({
      output_type: 'error',
      ename: typeof content.ename === 'string' ? content.ename : 'Error',
      evalue: typeof content.evalue === 'string' ? content.evalue.slice(0, MAX_OUTPUT_TEXT) : '',
      traceback: Array.isArray(content.traceback) ? content.traceback.filter((line): line is string => typeof line === 'string').slice(-512) : []
    })
    return
  }
  const dataValue = content.data
  const data: JsonObject = {}
  if (dataValue && typeof dataValue === 'object' && !Array.isArray(dataValue)) {
    for (const [mime, value] of Object.entries(dataValue)) {
      if (!SAFE_MIMES.has(mime)) continue
      if (typeof value === 'string') data[mime] = value.slice(0, mime === 'text/html' ? MAX_OUTPUT_TEXT : MAX_OUTPUT_TEXT * 4)
      else if (Array.isArray(value)) data[mime] = value.slice(0, 4096)
      else if (mime === 'application/json' && value && typeof value === 'object') data[mime] = boundedWireValue(value, MAX_OUTPUT_TEXT)
    }
  }
  if (frame.type === 'update_display_data') {
    const displayId = (content.transient as JsonObject | undefined)?.display_id
    const existing = displayId ? cell.outputs.find((output) => (output.transient as JsonObject | undefined)?.display_id === displayId) : undefined
    if (existing) {
      existing.data = data
      existing.metadata = boundedWireValue(content.metadata && typeof content.metadata === 'object' ? content.metadata : {}, MAX_OUTPUT_TEXT)
      return
    }
  }
  const output: JsonObject = {
    output_type: frame.type,
    data,
    metadata: boundedWireValue(content.metadata && typeof content.metadata === 'object' ? content.metadata : {}, MAX_OUTPUT_TEXT)
  }
  if (frame.type === 'execute_result' && typeof content.execution_count === 'number') output.execution_count = content.execution_count
  if (content.transient && typeof content.transient === 'object') output.transient = boundedWireValue(content.transient, MAX_OUTPUT_TEXT)
  cell.outputs.push(output)
}

function mergeStreamText(previous: string, next: string): string {
  const combined = previous + next
  if (next.includes('\r')) {
    const lines = combined.split('\n')
    const last = lines.at(-1) ?? ''
    const carriage = last.lastIndexOf('\r')
    if (carriage >= 0) lines[lines.length - 1] = last.slice(carriage + 1)
    return lines.join('\n').slice(-MAX_OUTPUT_TEXT)
  }
  return combined.slice(-MAX_OUTPUT_TEXT)
}


function outputSnapshot(host: EditorServices, bufferId: string, index: number): JsonObject[] {
  const buffer = host.get(bufferId)
  const document = parseNotebook(currentText(buffer))
  const cell = document.cells[index]
  return cell?.cell_type === 'code' && Array.isArray(cell.outputs) ? cell.outputs : []
}

const NOTEBOOK_API_MAX_BYTES = 1024 * 1024
const NOTEBOOK_CELL_PAGE_SIZE = 8
const NOTEBOOK_MAX_CELL_PAGE_SIZE = 16
const NOTEBOOK_SOURCE_PAGE_SIZE = 16 * 1024
const NOTEBOOK_MAX_SOURCE_PAGE_SIZE = 64 * 1024
const NOTEBOOK_OUTPUT_PAGE_SIZE = 2
const NOTEBOOK_MAX_OUTPUT_PAGE_SIZE = 8
const NOTEBOOK_CELL_METADATA_BYTES = 16 * 1024
const NOTEBOOK_OUTPUT_BYTES = 32 * 1024

function boundedWireValue(value: unknown, limit: number): unknown {
  const json = JSON.stringify(value)
  const byteLength = Buffer.byteLength(json ?? '')
  return byteLength <= limit ? value : { truncated: true, byteLength }
}

function boundedTextSlice(host: EditorServices, text: string, offset: number, requestedLength: number, label: string): { text: string; nextOffset: number | null } {
  if (offset > text.length) error(host, 'invalid-params', `${label} offset exceeds its source length`)
  if (offset > 0 && offset < text.length) {
    const previous = text.charCodeAt(offset - 1)
    const current = text.charCodeAt(offset)
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
      error(host, 'invalid-params', `${label} offset splits a UTF-16 surrogate pair`)
    }
  }
  let end = Math.min(text.length, offset + requestedLength)
  if (end > offset && end < text.length) {
    const previous = text.charCodeAt(end - 1)
    const current = text.charCodeAt(end)
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) end++
  }
  return { text: text.slice(offset, end), nextOffset: end < text.length ? end : null }
}

function publicNotebookParse(host: EditorServices, bufferId: string, params: Record<string, unknown>): Record<string, unknown> {
  const buffer = host.get(bufferId)
  if (buffer.kind !== 'notebook') error(host, 'invalid-params', 'notebook actions require a notebook buffer')
  const parsed = parseNotebook(currentText(buffer))
  const sourceOffset = requiredIndex(host, params.sourceOffset ?? 0, 'sourceOffset')
  const sourceLength = typeof params.sourceLength === 'number'
    ? Math.min(NOTEBOOK_MAX_SOURCE_PAGE_SIZE, requiredIndex(host, params.sourceLength, 'sourceLength'))
    : NOTEBOOK_SOURCE_PAGE_SIZE
  if (!parsed.valid || !parsed.document) {
    const raw = boundedTextSlice(host, parsed.rawSource, sourceOffset, sourceLength, 'raw notebook source')
    return {
      valid: false,
      error: parsed.error,
      language: parsed.language,
      cellCount: 0,
      contentRevision: buffer.contentRevision,
      rawSource: raw.text,
      rawSourceLength: parsed.rawSource.length,
      rawSourceOffset: sourceOffset,
      rawSourceNextOffset: raw.nextOffset,
      rawSourceTruncated: raw.nextOffset !== null
    }
  }
  const document = parsed.document
  const offset = requiredIndex(host, params.offset ?? 0, 'offset')
  const requestedLimit = params.limit === undefined ? NOTEBOOK_CELL_PAGE_SIZE : requiredIndex(host, params.limit, 'limit')
  if (requestedLimit === 0) error(host, 'invalid-params', 'limit must be at least 1')
  const limit = Math.min(NOTEBOOK_MAX_CELL_PAGE_SIZE, requestedLimit)
  if (offset > document.cells.length) error(host, 'invalid-params', 'cell offset is out of range')
  const outputOffset = requiredIndex(host, params.outputOffset ?? 0, 'outputOffset')
  const requestedOutputLimit = params.outputLimit === undefined ? NOTEBOOK_OUTPUT_PAGE_SIZE : requiredIndex(host, params.outputLimit, 'outputLimit')
  if (requestedOutputLimit === 0) error(host, 'invalid-params', 'outputLimit must be at least 1')
  const outputLimit = Math.min(NOTEBOOK_MAX_OUTPUT_PAGE_SIZE, requestedOutputLimit)
  const result: Record<string, unknown> = {
    valid: true,
    error: null,
    language: notebookLanguage(document),
    nbformat: document.nbformat,
    nbformat_minor: document.nbformat_minor,
    metadata: boundedWireValue(document.metadata, NOTEBOOK_CELL_METADATA_BYTES),
    cellCount: document.cells.length,
    contentRevision: buffer.contentRevision,
    offset,
    limit,
    cells: []
  }
  let payloadBytes = Buffer.byteLength(JSON.stringify(result))
  const cells: JsonObject[] = []
  const end = Math.min(document.cells.length, offset + limit)
  for (let index = offset; index < end; index++) {
    const cell = document.cells[index]!
    const wholeSource = sourceText(cell.source)
    const sourcePage = boundedTextSlice(host, wholeSource, sourceOffset, sourceLength, `cell ${index} source`)
    const outputs = cell.cell_type === 'code' ? cell.outputs ?? [] : []
    if (outputOffset > outputs.length) error(host, 'invalid-params', `outputOffset exceeds cell ${index} output count`)
    const outputSlice = outputs.slice(outputOffset, outputOffset + outputLimit).map((output) => boundedWireValue(output, NOTEBOOK_OUTPUT_BYTES))
    const nextOutputOffset = outputOffset + outputSlice.length < outputs.length ? outputOffset + outputSlice.length : null
    const cellInfo: JsonObject = {
      cell_type: cell.cell_type,
      metadata: boundedWireValue(cell.metadata, NOTEBOOK_CELL_METADATA_BYTES),
      source: sourcePage.text,
      sourceOffset,
      sourceTotalLength: wholeSource.length,
      sourceNextOffset: sourcePage.nextOffset,
      sourceTruncated: sourcePage.nextOffset !== null,
      outputs: outputSlice,
      outputCount: outputs.length,
      outputOffset,
      outputNextOffset: nextOutputOffset,
      outputsTruncated: nextOutputOffset !== null
    }
    if (typeof cell.id === 'string') cellInfo.id = cell.id
    if (cell.cell_type === 'code') cellInfo.execution_count = cell.execution_count ?? null
    if (Object.keys(cell).some((key) => !['cell_type', 'id', 'metadata', 'source', 'outputs', 'execution_count'].includes(key))) {
      cellInfo.additionalFieldsAvailableInSource = true
    }
    const cellBytes = Buffer.byteLength(JSON.stringify(cellInfo))
    if (payloadBytes + cellBytes > NOTEBOOK_API_MAX_BYTES) break
    cells.push(cellInfo)
    payloadBytes += cellBytes
  }
  const nextOffset = offset + cells.length < document.cells.length ? offset + cells.length : null
  result.cells = cells
  result.nextOffset = nextOffset
  result.eof = nextOffset === null
  return result
}

export function createNotebookMethods(host: EditorServices): FeatureMethods {
  const runtimes = new Map<string, RuntimeState>()
  const mutationLocks = new Map<string, Promise<void>>()
  let disposed = false

  const runtimeFor = (bufferId: string): RuntimeState => {
    const current = runtimes.get(bufferId)
    if (current) return current
    const created: RuntimeState = { trusted: false, selected: null, kernel: null, interruptStalled: false, lastSetupError: null }
    runtimes.set(bufferId, created)
    return created
  }

  const getDocument = (bufferId: string): { buffer: EditorBuffer; parsed: NotebookParse } => {
    const buffer = host.get(bufferId)
    if (buffer.kind !== 'notebook') error(host, 'invalid-params', 'notebook actions require a notebook buffer')
    return { buffer, parsed: parseNotebook(currentText(buffer)) }
  }

  const requirePython = (parsed: NotebookParse): void => {
    if (!parsed.valid || !parsed.language.toLowerCase().startsWith('python')) {
      error(host, 'conflict', 'Only Python notebooks can run in Quirky.')
    }
  }

  const getEnvironment = async (state: RuntimeState, location: NotebookLocation, requested?: unknown): Promise<PythonEnvironment> => {
    if (typeof requested === 'string' && requested.trim()) {
      const environment = await describePython(requested, 'selected')
      state.selected = environment
      return environment
    }
    if (state.selected) return state.selected
    const candidates = discoverPythonCandidates(location.directory, location.root)
    const environments = await describeCandidates(candidates)
    const chosen = environments.find((environment) => environment.source === 'venv' || environment.source === 'workspace') ?? environments[0]
    if (!chosen) error(host, 'not-found', 'Python was not found. Install Python, select an interpreter, then run the cell again.')
    state.selected = chosen
    return chosen
  }

  const ensureKernel = async (
    bufferId: string,
    caller: PluginCaller,
    requestedPython?: unknown
  ): Promise<{ state: RuntimeState; location: NotebookLocation; result: KernelStartResult }> => {
    const state = runtimeFor(bufferId)
    if (!state.trusted) error(host, 'conflict', 'Notebook trust is required before starting a Python kernel.')
    const { parsed } = getDocument(bufferId)
    requirePython(parsed)
    const location = await localLocation(host, bufferId, caller)
    if (state.kernel?.status === 'ready') return { state, location, result: { status: 'ready', session: state.kernel } }
    const python = await getEnvironment(state, location, requestedPython)
    const bridgePath = join(host.context.dir, 'src/notebook/kernel-bridge.py')
    if (!python.hasIpykernel) {
      return { state, location, result: { status: 'missing-ipykernel', externallyManaged: python.externallyManaged, session: new KernelSession(python, location.directory, bridgePath, host.context.dataDir) } }
    }
    const kernel = new KernelSession(python, location.directory, bridgePath, host.context.dataDir)
    state.kernel = kernel
    state.lastSetupError = null
    const result = await kernel.start()
    if (result.status === 'failed') state.lastSetupError = result.detail
    return { state, location, result }
  }

  const disposeBuffer = async (bufferId: string): Promise<void> => {
    const state = runtimes.get(bufferId)
    if (!state) return
    state.trusted = false
    state.selected = null
    runtimes.delete(bufferId)
    await state.kernel?.shutdown()
  }

  const unsubscribeClose = host.onClose((bufferId) => { void disposeBuffer(bufferId) })

  const setupConfirmation: MethodHandler = async (params, caller) => {
    const action = params.action
    if (action !== 'install' && action !== 'venv') return null
    const bufferId = requiredString(host, params.bufferId, 'bufferId')
    const location = await localLocation(host, bufferId, caller)
    const selected = runtimeFor(bufferId).selected?.path
    const interpreter = typeof params.python === 'string' ? params.python : typeof params.path === 'string' ? params.path : selected ?? 'the selected local Python'
    if (action === 'install') {
      return `Install or upgrade ipykernel in ${JSON.stringify(interpreter)}? This changes packages in that Python environment.`
    }
    return `Create a workspace virtual environment at ${JSON.stringify(join(location.root, '.venv'))} using ${JSON.stringify(interpreter)}?`
  }
  const readParse = (bufferId: string): NotebookParse => getDocument(bufferId).parsed

  const mutateCell = async (bufferId: string, params: Record<string, unknown>, action: Exclude<Action, 'parse' | 'save' | 'environments' | 'describe' | 'select' | 'trust' | 'install' | 'venv' | 'start' | 'run' | 'runAll' | 'interrupt' | 'restart' | 'shutdown' | 'state'>): Promise<Record<string, unknown>> => {
    await withBufferMutation(host, bufferId, mutationLocks, (document) => {
      const language = notebookLanguage(document)
      if (action === 'edit') {
        const cell = cellAt(host, document, requiredIndex(host, params.index))
        cell.source = sourceLines(requiredString(host, params.source, 'source'))
      } else if (action === 'insert') {
        const index = requiredIndex(host, params.index)
        if (index > document.cells.length) error(host, 'invalid-params', 'insert index is out of range')
        const position = params.position === 'below' ? 'below' : params.position === 'above' ? 'above' : null
        if (!position) error(host, 'invalid-params', 'position must be above or below')
        const type = params.cellType
        if (type !== 'code' && type !== 'markdown' && type !== 'raw') error(host, 'invalid-params', 'cellType must be code, markdown, or raw')
        insertCell(document, index, position, type, language)
      } else if (action === 'move') {
        const index = requiredIndex(host, params.index)
        const cell = cellAt(host, document, index)
        const direction = params.direction
        if (direction !== 'up' && direction !== 'down') error(host, 'invalid-params', 'direction must be up or down')
        const target = direction === 'up' ? index - 1 : index + 1
        if (target < 0 || target >= document.cells.length) error(host, 'invalid-params', `cell cannot move ${direction} from this position`)
        document.cells[index] = document.cells[target]!
        document.cells[target] = cell
      } else if (action === 'delete') {
        const index = requiredIndex(host, params.index)
        cellAt(host, document, index)
        if (document.cells.length === 1) document.cells[0] = makeCell('code', language)
        else document.cells.splice(index, 1)
      } else if (action === 'type') {
        const cell = cellAt(host, document, requiredIndex(host, params.index))
        const type = params.cellType
        if (type !== 'code' && type !== 'markdown' && type !== 'raw') error(host, 'invalid-params', 'cellType must be code, markdown, or raw')
        setCellType(cell, type, language)
      } else if (action === 'clear') {
        if (params.index === undefined) {
          for (const cell of document.cells) {
            if (cell.cell_type === 'code') {
              cell.outputs = []
              cell.execution_count = null
            }
          }
        } else {
          const cell = cellAt(host, document, requiredIndex(host, params.index))
          if (cell.cell_type === 'code') {
            cell.outputs = []
            cell.execution_count = null
          }
        }
      }
      return undefined
    })
    return publicNotebookParse(host, bufferId, {})
  }

  const renderState = (bufferId: string): Record<string, unknown> => {
    const { buffer, parsed } = getDocument(bufferId)
    const runtime = runtimeFor(bufferId)
    const kernel = runtime.kernel
    return {
      bufferId,
      valid: parsed.valid,
      cellCount: parsed.cellCount,
      language: parsed.language,
      error: parsed.error,
      contentRevision: buffer.contentRevision,
      trusted: runtime.trusted,
      selectedPython: runtime.selected,
      busy: kernel?.busy ?? false,
      executionCount: kernel?.executionCount ?? null,
      interruptStalled: runtime.interruptStalled,
      kernel: kernel ? {
        status: kernel.status,
        pid: kernel.pid,
        stderr: kernel.stderr,
        error: kernel.error,
        executionCount: kernel.executionCount,
        busy: kernel.busy
      } : { status: 'stopped', stderr: '', error: runtime.lastSetupError, busy: false, executionCount: null }
    }
  }

  const runGroup = async (bufferId: string, indices: number[], caller: PluginCaller, requestedPython?: unknown): Promise<ExecutionGroupResult> => {
    const { result } = await ensureKernel(bufferId, caller, requestedPython)
    if (result.status === 'missing-ipykernel') {
      return { status: 'missing-ipykernel', completed: 0, cancelled: indices.length, executionCount: null, outputs: [], externallyManaged: result.externallyManaged }
    }
    if (result.status === 'failed') {
      return { status: 'failed', completed: 0, cancelled: indices.length, executionCount: null, outputs: [], stderr: result.detail }
    }
    const session = result.session
    await withBufferMutation(host, bufferId, mutationLocks, (document) => {
      ensureExecutableCells(document)
      return undefined
    })
    let completed = 0
    let finalStatus: ExecutionGroupResult['status'] = 'ok'
    let executionCount: number | null = session.executionCount
    let outputs: JsonObject[] = []
    let stderr = ''
    for (const index of indices) {
      const { parsed } = getDocument(bufferId)
      if (!parsed.valid || !parsed.document) error(host, 'conflict', 'Notebook changed to an invalid document while execution was queued.')
      const cell = cellAt(host, parsed.document, index)
      if (cell.cell_type !== 'code') {
        completed++
        continue
      }
      const code = sourceText(cell.source)
      await withBufferMutation(host, bufferId, mutationLocks, (document) => {
        const current = cellAt(host, document, index)
        current.outputs = []
        current.execution_count = null
        return undefined
      })
      const clearAfter = { value: false }
      const execution = await session.execute(code, async (frame: KernelFrame) => {
        if (frame.type === 'done' || frame.type === 'ready') return
        if (!OUTPUT_TYPES.has(frame.type)) return
        await withBufferMutation(host, bufferId, mutationLocks, (document) => {
          updateOutput(document, index, frame, clearAfter)
          return undefined
        })
      })
      await withBufferMutation(host, bufferId, mutationLocks, (document) => {
        const current = cellAt(host, document, index)
        current.execution_count = execution.executionCount
        return undefined
      })
      completed++
      executionCount = execution.executionCount
      stderr = execution.stderr
      outputs = outputSnapshot(host, bufferId, index)
      if (execution.status !== 'ok') {
        finalStatus = execution.status
        break
      }
    }
    return { status: finalStatus, completed, cancelled: indices.length - completed, executionCount, outputs, ...(stderr ? { stderr } : {}) }
  }

  const handle: MethodHandler = async (params, caller) => {
    if (disposed) error(host, 'conflict', 'Notebook service is disposed.')
    const actionValue = params.action
    if (typeof actionValue !== 'string' || !ACTIONS.has(actionValue as Action)) error(host, 'invalid-params', 'unknown notebook action')
    const action = actionValue as Action
    const bufferId = requiredString(host, params.bufferId, 'bufferId')

    if (action === 'parse') return publicNotebookParse(host, bufferId, params)
    if (action === 'state') return renderState(bufferId)
    if (action === 'edit' || action === 'insert' || action === 'move' || action === 'delete' || action === 'type' || action === 'clear') {
      return mutateCell(bufferId, params, action)
    }
    if (action === 'save') return host.save(bufferId, 'user')
    if (action === 'trust') {
      const state = runtimeFor(bufferId)
      state.trusted = params.granted !== false
      return { trusted: state.trusted }
    }
    if (action === 'environments') {
      const location = await localLocation(host, bufferId, caller)
      const candidates = discoverPythonCandidates(location.directory, location.root)
      const environments = params.runWorkspaceInterpreters === true ? await describeCandidates(candidates) : candidates
      return { environments, probed: params.runWorkspaceInterpreters === true }
    }
    if (action === 'describe') {
      const location = await localLocation(host, bufferId, caller)
      const pythonPath = requiredString(host, params.path ?? params.python, 'path')
      try {
        const environment = await describePython(pythonPath)
        return { environment }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        error(host, 'invalid-params', detail)
      }
    }
    if (action === 'select') {
      const location = await localLocation(host, bufferId, caller)
      let pythonPath = params.python ?? params.path
      if (params.browse === true && (typeof pythonPath !== 'string' || !pythonPath.trim())) {
        if (process.platform !== 'darwin') error(host, 'invalid-params', 'Browse for Python is supported on macOS; pass an explicit interpreter path on this host.')
        const chooser = spawn('osascript', ['-e', 'POSIX path of (choose file with prompt "Select Python interpreter")'], {
          cwd: location.directory, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
        })
        const selected = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveChoice, rejectChoice) => {
          let stdout = ''
          let stderr = ''
          chooser.stdout?.setEncoding('utf8').on('data', (chunk: string) => { stdout += chunk.slice(0, 4096) })
          chooser.stderr?.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk.slice(0, 4096) })
          chooser.once('error', rejectChoice)
          chooser.once('close', (code) => resolveChoice({ code, stdout, stderr }))
        })
        if (selected.code !== 0) {
          if (/cancel/i.test(selected.stderr)) return { cancelled: true, selected: runtimeFor(bufferId).selected }
          error(host, 'conflict', selected.stderr.trim() || 'The Python file chooser failed.')
        }
        pythonPath = selected.stdout.trim()
      }
      const selectedPath = requiredString(host, pythonPath, 'python')
      try {
        const environment = await describePython(selectedPath)
        const state = runtimeFor(bufferId)
        if (state.kernel && state.kernel.python.path !== environment.path) {
          const kernel = state.kernel
          state.kernel = null
          state.trusted = false
          await kernel.shutdown()
        }
        state.selected = environment
        state.lastSetupError = null
        return { selected: true, environment, trusted: state.trusted, language: notebookLanguage(parseNotebookRoot(currentText(host.get(bufferId)))) }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        error(host, 'invalid-params', detail)
      }
    }
    if (action === 'install') {
      const state = runtimeFor(bufferId)
      if (!state.trusted) error(host, 'conflict', 'Trust the notebook before changing its Python environment.')
      const location = await localLocation(host, bufferId, caller)
      const environment = await getEnvironment(state, location, params.python ?? params.path)
      try {
        const installed = await installIpykernel(environment, location.root)
        state.selected = installed.python
        state.lastSetupError = null
        return { status: 'installed', environment: installed.python, command: installed.command }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        state.lastSetupError = detail
        if (environment.externallyManaged) return { status: 'venv-required', error: detail }
        error(host, 'conflict', detail)
      }
    }
    if (action === 'venv') {
      const state = runtimeFor(bufferId)
      if (!state.trusted) error(host, 'conflict', 'Trust the notebook before creating a virtual environment.')
      const location = await localLocation(host, bufferId, caller)
      const environment = await getEnvironment(state, location, params.python ?? params.path)
      try {
        const result = await createWorkspaceVenv(environment, location.directory, location.root)
        state.selected = result.python
        state.lastSetupError = null
        return { status: 'created', path: result.path, environment: result.python, command: result.command }
      } catch (cause) {
        const detail = cause instanceof Error ? cause.message : String(cause)
        state.lastSetupError = detail
        error(host, 'conflict', detail)
      }
    }
    if (action === 'start') {
      const { result } = await ensureKernel(bufferId, caller, params.python ?? params.path)
      if (result.status === 'missing-ipykernel') return { status: result.status, externallyManaged: result.externallyManaged }
      if (result.status === 'failed') return { status: result.status, error: result.detail }
      return { status: 'ready', python: result.session.python, pid: result.session.pid }
    }
    if (action === 'run' || action === 'runAll') {
      const parsed = readParse(bufferId)
      if (!parsed.valid || !parsed.document) error(host, 'invalid-params', parsed.error ?? 'Unable to render notebook')
      requirePython(parsed)
      const indices = action === 'run'
        ? [requiredIndex(host, params.index)]
        : parsed.document.cells.map((cell, index) => cell.cell_type === 'code' ? index : -1).filter((index) => index >= 0)
      if (indices.some((index) => index >= parsed.document!.cells.length)) error(host, 'invalid-params', 'run cell index is out of range')
      const result = await runGroup(bufferId, indices, caller, params.python ?? params.path)
      const { outputs, ...summary } = result
      return {
        ...summary,
        ...(action === 'run' ? {
          outputCount: outputs.length,
          nextIndex: params.mode === 'advance' ? (indices[0] ?? -1) + 1 : undefined
        } : {})
      }
    }
    if (action === 'interrupt') {
      const state = runtimeFor(bufferId)
      const result = await state.kernel?.interrupt() ?? { interrupted: false, stalled: false }
      state.interruptStalled = result.stalled
      return result
    }
    if (action === 'restart') {
      const state = runtimeFor(bufferId)
      const kernel = state.kernel
      state.kernel = null
      state.trusted = false
      state.interruptStalled = false
      state.lastSetupError = null
      await kernel?.shutdown()
      return { status: 'stopped', trusted: false, outputsKept: true, queueCancelled: true }
    }
    if (action === 'shutdown') {
      const state = runtimeFor(bufferId)
      const kernel = state.kernel
      state.kernel = null
      state.interruptStalled = false
      await kernel?.shutdown()
      return { status: 'stopped', trusted: state.trusted }
    }
    return undefined
  }

  return {
    methods: { notebook: handle, setupConfirmation },
    async dispose() {
      if (disposed) return
      disposed = true
      unsubscribeClose()
      const states = [...runtimes.entries()]
      runtimes.clear()
      await Promise.all(states.map(async ([bufferId, state]) => {
        state.trusted = false
        state.selected = null
        await state.kernel?.shutdown()
        runtimes.delete(bufferId)
      }))
    }
  }
}
