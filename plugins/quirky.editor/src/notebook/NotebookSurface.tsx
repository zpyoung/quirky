import { Badge, Button, Dialog, EmptyState, InlineError, ListRow, NoticeLine, TextField } from '@quirky/ui'
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { SurfaceProps } from '../types'
import { parseNotebook, serializeNotebook, sourceLines, type NotebookParse } from './document'
import { base64ImageDataUrl, outputText, parseAnsi, preferredOutput, sanitizeHtml } from './outputs'
import {
  useEditorUiControl,
  useEditorUiControlReport,
  useEditorUiControlSurface,
  type EditorUiControl,
  type EditorUiControlAddress,
  type EditorUiControlResult
} from '../window/uiControl'

type ApiRecord = Record<string, unknown>
type KernelState = { status?: string; pid?: number; stderr?: string; error?: string | null; busy?: boolean; executionCount?: number | null }
type NotebookRuntimeState = { trusted?: boolean; busy?: boolean; executionCount?: number | null; interruptStalled?: boolean; selectedPython?: { path?: string; name?: string; version?: string } | null; kernel?: KernelState }
type Environment = { path: string; name: string; version?: string; source?: string; hasIpykernel?: boolean; externallyManaged?: boolean }
type TrustRequest = { index: number | null; all: boolean; mode: 'advance' | 'in-place' }
type RuntimeReadState = { bufferId: string; worktreeId: string; runtime: NotebookRuntimeState | null; pending: boolean; error: string | null }
type NotebookSession = {
  bufferId: string
  content: string
  contentRevision: number
  worktreeId: string
  generation: string
  sourceSignature: string
  structureSignature: string
  cellIdentityOrder: string[]
  pendingStructure: boolean
  pendingStructureAckRevision: number | null
}
type EnvironmentPicker = {
  generation: string
  sessionGeneration: string
  choices: Environment[]
  pending: boolean
  error: string | null
  settled: boolean
}
type TrustPrompt = {
  generation: string
  sessionGeneration: string
  request: TrustRequest
  python: string | null
}
type SetupPrompt = {
  generation: string
  sessionGeneration: string
  kind: 'install' | 'venv'
  python: string | null
}
type BusyOperation = { token: symbol; sessionGeneration: string }
type SessionMessage = { sessionGeneration: string; message: string }
type SetupFailure = { sessionGeneration: string; promptGeneration: string; message: string }
type OperationNotice = BusyOperation & { message: string }

function notebookSourceSignature(parsed: NotebookParse, content: string): string {
  if (!parsed.document) return content
  const cells = parsed.document.cells.map((cell) => {
    const sourceCell = { ...cell }
    delete sourceCell.outputs
    delete sourceCell.execution_count
    return sourceCell
  })
  return JSON.stringify({
    metadata: parsed.document.metadata,
    cells,
    nbformat: parsed.document.nbformat,
    nbformat_minor: parsed.document.nbformat_minor
  })
}

function notebookStructureSignature(cells: NotebookParse['cells']): string {
  return JSON.stringify(cells.map((cell, index) => [cell.id ?? `position:${index}`, cell.cell_type]))
}
function notebookCellIdentityOrder(cells: NotebookParse['cells']): string[] {
  return cells.map((cell) => {
    const identity = { ...cell }
    delete identity.outputs
    delete identity.execution_count
    return JSON.stringify(identity)
  })
}

function notebookCellOrderRemapped(previous: readonly string[], current: readonly string[]): boolean {
  if (previous.length !== current.length) return true
  const counts = new Map<string, number>()
  const firstIndexes = new Map<string, number>()
  let changed = 0
  for (let index = 0; index < previous.length; index += 1) {
    const identity = previous[index]!
    counts.set(identity, (counts.get(identity) ?? 0) + 1)
    if (!firstIndexes.has(identity)) firstIndexes.set(identity, index)
    if (identity !== current[index]) changed += 1
  }
  if (changed === 0) return false
  const remaining = new Map(counts)
  let sameCells = true
  for (const identity of current) {
    const count = remaining.get(identity)
    if (count === undefined) {
      sameCells = false
      break
    }
    if (count === 1) remaining.delete(identity)
    else remaining.set(identity, count - 1)
  }
  if (sameCells && remaining.size === 0) return true
  for (let index = 0; index < current.length; index += 1) {
    if (previous[index] === current[index]) continue
    const count = counts.get(current[index]!)
    if (count !== undefined && (count > 1 || firstIndexes.get(current[index]!) !== index)) return true
  }
  return changed > 1
}


function hasControlData(
  data: unknown,
  allowed: readonly string[],
  required: readonly string[]
): data is ApiRecord {
  if (data === undefined) return required.length === 0
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return false
  const keys = Reflect.ownKeys(data)
  return keys.every((key) => typeof key === 'string' && allowed.includes(key)) &&
    required.every((key) => Object.hasOwn(data, key))
}

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
  return <pre className="notebook-output" data-output-type={output.output_type === 'error' ? 'error' : output.name === 'stderr' ? 'stderr' : 'stdout'}>
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
    return <iframe className="notebook-html-output" title="Notebook HTML output" sandbox="" referrerPolicy="no-referrer" srcDoc={sanitizeHtml(selected.value)} />
  }
  if (selected.mime.startsWith('image/')) {
    const src = base64ImageDataUrl(selected.mime, selected.value)
    if (!src) return <InlineError message="Image output is too large or malformed." />
    return <img className="notebook-image-output" src={src} alt="Notebook output" />
  }
  const value = outputText(output)
  return <pre className="notebook-output" data-output-mime={selected.mime}>{value}</pre>
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
  const sourceSignature = useMemo(() => notebookSourceSignature(parsed, content), [parsed, content])
  const structureSignature = useMemo(() => notebookStructureSignature(cells), [cells])
  const cellIdentityOrder = useMemo(() => notebookCellIdentityOrder(cells), [cells])
  const controlSurface = useEditorUiControlSurface()
  const publishControlReport = useEditorUiControlReport()
  const bufferId = buffer.id
  const worktreeId = buffer.worktreeId
  const sourceMode = buffer.mode === 'source'
  const readOnlyRef = useRef(buffer.readOnly)
  readOnlyRef.current = buffer.readOnly
  const submittedNotebooks = useRef<Array<{ bufferId: string; content: string; raw: boolean }>>([])
  const sessionRef = useRef<NotebookSession | null>(null)
  if (sessionRef.current === null) {
    sessionRef.current = {
      bufferId,
      content,
      contentRevision: buffer.contentRevision,
      worktreeId,
      generation: crypto.randomUUID(),
      sourceSignature,
      structureSignature,
      cellIdentityOrder,
      pendingStructure: false,
      pendingStructureAckRevision: null
    }
  } else {
    const previous = sessionRef.current
    const bufferChanged = previous.bufferId !== bufferId || previous.worktreeId !== worktreeId
    const contentChanged = previous.content !== content
    const localEcho = contentChanged && submittedNotebooks.current.some(
      (submitted) => submitted.bufferId === bufferId && submitted.content === content
    )
    const localRawEcho = contentChanged && submittedNotebooks.current.some(
      (submitted) => submitted.bufferId === bufferId && submitted.content === content && submitted.raw
    )
    const preserveRawStructure = localRawEcho && !parsed.valid
    const observedStructureSignature = preserveRawStructure ? previous.structureSignature : structureSignature
    const observedCellIdentityOrder = preserveRawStructure ? previous.cellIdentityOrder : cellIdentityOrder
    const structureChanged = previous.structureSignature !== observedStructureSignature
    const localRawRemapping = localRawEcho && parsed.valid &&
      notebookCellOrderRemapped(previous.cellIdentityOrder, observedCellIdentityOrder)
    const sourceChanged = sourceSignature !== previous.sourceSignature
    const waitingForStructure = !bufferChanged && previous.pendingStructure
    const acknowledgedStructureRevision = waitingForStructure &&
      previous.pendingStructureAckRevision !== null &&
      buffer.contentRevision >= previous.pendingStructureAckRevision
    const expectedStructureChange = waitingForStructure && (
      structureChanged || localRawRemapping || sourceChanged && !localEcho || acknowledgedStructureRevision
    )
    const rotate = bufferChanged || structureChanged || localRawRemapping ||
      sourceChanged && !localEcho || acknowledgedStructureRevision
    sessionRef.current = {
      bufferId,
      content,
      contentRevision: buffer.contentRevision,
      worktreeId,
      generation: rotate ? crypto.randomUUID() : previous.generation,
      sourceSignature,
      structureSignature: observedStructureSignature,
      cellIdentityOrder: observedCellIdentityOrder,
      pendingStructure: waitingForStructure && !expectedStructureChange,
      pendingStructureAckRevision: waitingForStructure && !expectedStructureChange
        ? previous.pendingStructureAckRevision
        : null
    }
  }
  const session = sessionRef.current!
  const sessionGeneration = session.generation
  const sessionSnapshot = { bufferId, worktreeId, generation: sessionGeneration }
  const runtimeRefreshSequence = useRef(0)
  const componentMounted = useRef(false)
  const [structureRevision, setStructureRevision] = useState(0)
  useEffect(() => {
    componentMounted.current = true
    return () => { componentMounted.current = false }
  }, [])
  const isCurrentSession = (expected: Pick<NotebookSession, 'bufferId' | 'worktreeId' | 'generation'>) =>
    componentMounted.current &&
    sessionRef.current?.bufferId === expected.bufferId &&
    sessionRef.current.worktreeId === expected.worktreeId &&
    sessionRef.current.generation === expected.generation
  const [runtimeRead, setRuntimeRead] = useState<RuntimeReadState>({
    bufferId,
    worktreeId,
    runtime: null,
    pending: true,
    error: null
  })
  const runtimeMatchesSession = runtimeRead.bufferId === bufferId && runtimeRead.worktreeId === worktreeId
  const runtime = runtimeMatchesSession ? runtimeRead.runtime : null
  const runtimePending = !runtimeMatchesSession || runtimeRead.pending
  const runtimeReadError = runtimeMatchesSession ? runtimeRead.error : null
  const [environmentPickerState, setEnvironmentPickerState] = useState<EnvironmentPicker | null>(null)
  const environmentPickerRef = useRef<EnvironmentPicker | null>(null)
  const environmentPicker = environmentPickerState?.sessionGeneration === sessionGeneration ? environmentPickerState : null
  const environmentChoices = environmentPicker?.choices ?? []
  const environmentOpen = environmentPicker !== null
  const environmentPending = environmentPicker?.pending ?? false
  const environmentError = environmentPicker?.error ?? null
  const [editingCell, setEditingCell] = useState<number | null>(null)
  const [cellDrafts, setCellDrafts] = useState<Record<number, string>>({})
  const [trustPromptState, setTrustPromptState] = useState<TrustPrompt | null>(null)
  const trustPromptRef = useRef<TrustPrompt | null>(null)
  const trustPrompt = trustPromptState?.sessionGeneration === sessionGeneration ? trustPromptState : null
  const trustRequest = trustPrompt?.request ?? null
  const [setupPromptState, setSetupPromptState] = useState<SetupPrompt | null>(null)
  const setupPromptRef = useRef<SetupPrompt | null>(null)
  const setupPromptIdentity = setupPromptState?.sessionGeneration === sessionGeneration ? setupPromptState : null
  const setupPrompt = setupPromptIdentity?.kind ?? null
  const [setupErrorState, setSetupErrorState] = useState<SetupFailure | null>(null)
  const setupError = setupPromptIdentity &&
    setupErrorState?.sessionGeneration === sessionGeneration &&
    setupErrorState.promptGeneration === setupPromptIdentity.generation
    ? setupErrorState.message
    : null
  const [sourceErrorState, setSourceErrorState] = useState<SessionMessage | null>(null)
  const sourceError = sourceErrorState?.sessionGeneration === sessionGeneration ? sourceErrorState.message : null
  const [controlErrorState, setControlErrorState] = useState<SessionMessage | null>(null)
  const controlError = controlErrorState?.sessionGeneration === sessionGeneration ? controlErrorState.message : null
  const [kernelErrorState, setKernelErrorState] = useState<SessionMessage | null>(null)
  const kernelError = kernelErrorState?.sessionGeneration === sessionGeneration ? kernelErrorState.message : null
  const [busyOperationState, setBusyOperationState] = useState<BusyOperation | null>(null)
  const busyOperationRef = useRef<BusyOperation | null>(null)
  const actionBusy = busyOperationState?.sessionGeneration === sessionGeneration
  const [operationNoticeState, setOperationNoticeState] = useState<OperationNotice | null>(null)
  const operationNotice = operationNoticeState?.sessionGeneration === sessionGeneration ? operationNoticeState.message : null
  const [cellOffset, setCellOffset] = useState(0)
  const [outputLimits, setOutputLimits] = useState<Record<number, number>>({})
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(-1)
  const findInputId = useId()
  const cellElements = useRef(new Map<number, HTMLElement>())
  const cellTextareas = useRef(new Map<number, HTMLTextAreaElement>())
  const pendingCellChanges = useRef(new Map<number, string>())
  const cellTimer = useRef<number | undefined>(undefined)
  const lastObservedNotebook = useRef<{
    bufferId: string
    worktreeId: string
    content: string
    sourceSignature: string
    structureSignature: string
  } | null>(null)
  useEffect(() => {
    let active = true
    const refreshPublishedRuntime = async () => {
      const request = ++runtimeRefreshSequence.current
      setRuntimeRead({ bufferId, worktreeId, runtime: null, pending: true, error: null })
      try {
        const value = await onAction('quirky.editor/notebook', { bufferId, action: 'state' })
        if (active && request === runtimeRefreshSequence.current) {
          setRuntimeRead({ bufferId, worktreeId, runtime: notebookRuntime(value), pending: false, error: null })
        }
      } catch (error) {
        if (active && request === runtimeRefreshSequence.current) {
          setRuntimeRead({
            bufferId,
            worktreeId,
            runtime: null,
            pending: false,
            error: error instanceof Error ? error.message : String(error)
          })
        }
      }
    }
    const unsubscribe = props.context.subscribe((event) => {
      if (event.type === 'quirky.editor/changed') void refreshPublishedRuntime()
    })
    void refreshPublishedRuntime()
    return () => {
      active = false
      runtimeRefreshSequence.current++
      unsubscribe()
    }
  }, [props.context, bufferId, worktreeId, buffer.contentRevision, onAction])

  useEffect(() => {
    const previous = lastObservedNotebook.current
    lastObservedNotebook.current = { bufferId, worktreeId, content, sourceSignature, structureSignature }
    if (previous?.bufferId === bufferId && previous.worktreeId === worktreeId && previous.content === content) return

    if (previous?.bufferId === bufferId && previous.worktreeId === worktreeId) {
      const acknowledgedIndex = submittedNotebooks.current.findIndex(
        (submitted) => submitted.bufferId === bufferId && submitted.content === content
      )
      if (acknowledgedIndex !== -1) {
        submittedNotebooks.current.splice(0, acknowledgedIndex + 1)
        return
      }
      if (previous.sourceSignature === sourceSignature) return
    }

    submittedNotebooks.current = []
    pendingCellChanges.current.clear()
    if (cellTimer.current !== undefined) {
      window.clearTimeout(cellTimer.current)
      cellTimer.current = undefined
    }
    setCellDrafts({})
    setEditingCell(null)
    setCellOffset(0)
    setOutputLimits({})
    environmentPickerRef.current = null
    setEnvironmentPickerState(null)
    trustPromptRef.current = null
    setTrustPromptState(null)
    setupPromptRef.current = null
    setSetupPromptState(null)
    setSetupErrorState(null)
    setSourceErrorState(null)
    setKernelErrorState(null)
    setControlErrorState(null)
  }, [bufferId, worktreeId, buffer.contentRevision, buffer.draft, content, sourceSignature, structureSignature])


  const refreshRuntime = async (expected = sessionSnapshot): Promise<NotebookRuntimeState | null> => {
    if (!isCurrentSession(expected)) return null
    const request = ++runtimeRefreshSequence.current
    setRuntimeRead({
      bufferId: expected.bufferId,
      worktreeId: expected.worktreeId,
      runtime: runtimeMatchesSession ? runtime : null,
      pending: true,
      error: null
    })
    try {
      const result = await onAction('quirky.editor/notebook', { bufferId: expected.bufferId, action: 'state' })
      if (!isCurrentSession(expected) || request !== runtimeRefreshSequence.current) return null
      const refreshed = notebookRuntime(result)
      setRuntimeRead({ bufferId: expected.bufferId, worktreeId: expected.worktreeId, runtime: refreshed, pending: false, error: null })
      return refreshed
    } catch (error) {
      if (isCurrentSession(expected) && request === runtimeRefreshSequence.current) {
        setRuntimeRead({
          bufferId: expected.bufferId,
          worktreeId: expected.worktreeId,
          runtime: runtimeMatchesSession ? runtime : null,
          pending: false,
          error: error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
  }

  const action = async (
    name: string,
    fields: Record<string, unknown> = {},
    expected = sessionSnapshot
  ): Promise<unknown> => {
    if (!isCurrentSession(expected)) throw new Error('The notebook control is no longer available.')
    return onAction('quirky.editor/notebook', { bufferId: expected.bufferId, action: name, ...fields })
  }

  const showSourceError = (message: string | null, expected = sessionSnapshot) => {
    if (!isCurrentSession(expected)) return
    setSourceErrorState(message === null ? null : { sessionGeneration: expected.generation, message })
  }

  const showKernelError = (message: string | null, expected = sessionSnapshot) => {
    if (!isCurrentSession(expected)) return
    setKernelErrorState(message === null ? null : { sessionGeneration: expected.generation, message })
  }

  const showControlError = (message: string | null, expected = sessionSnapshot) => {
    if (!isCurrentSession(expected)) return
    setControlErrorState(message === null ? null : { sessionGeneration: expected.generation, message })
  }

  const beginBusy = (expected: typeof sessionSnapshot, notice?: string): BusyOperation | null => {
    if (!isCurrentSession(expected) || busyOperationRef.current?.sessionGeneration === expected.generation) return null
    const operation = { token: Symbol(), sessionGeneration: expected.generation }
    busyOperationRef.current = operation
    setBusyOperationState(operation)
    setOperationNoticeState(notice === undefined ? null : { ...operation, message: notice })
    return operation
  }

  const finishBusy = (operation: BusyOperation, expected: typeof sessionSnapshot) => {
    if (!isCurrentSession(expected) || busyOperationRef.current?.token !== operation.token) return
    busyOperationRef.current = null
    setBusyOperationState((current) => current?.token === operation.token ? null : current)
    setOperationNoticeState((current) => current?.token === operation.token ? null : current)
  }

  const beginStructureMutation = (expected: typeof sessionSnapshot) => {
    if (!isCurrentSession(expected) || sessionRef.current?.pendingStructure) return null
    const generation = crypto.randomUUID()
    sessionRef.current = {
      ...sessionRef.current!,
      generation,
      pendingStructure: true,
      pendingStructureAckRevision: null
    }
    setStructureRevision((revision) => revision + 1)
    return { ...expected, generation }
  }

  const releaseStructureMutation = (expected: typeof sessionSnapshot): typeof sessionSnapshot => {
    const current = sessionRef.current
    if (!isCurrentSession(expected) || !current?.pendingStructure) return expected
    const generation = crypto.randomUUID()
    sessionRef.current = { ...current, generation, pendingStructure: false, pendingStructureAckRevision: null }
    setStructureRevision((revision) => revision + 1)
    return { ...expected, generation }
  }

  const submitNotebookDraft = (draft: string, raw = false) => {
    submittedNotebooks.current.push({ bufferId, content: draft, raw })
    onDraft(draft)
  }

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
    const serialized = serializeNotebook(updated)
    submitNotebookDraft(serialized)
  }

  const flushCellChangesRef = useRef(flushCellChanges)
  flushCellChangesRef.current = flushCellChanges
  useEffect(() => {
    const mountedBuffer = sessionSnapshot
    return () => {
      if (sessionRef.current?.bufferId === mountedBuffer.bufferId && sessionRef.current?.worktreeId === mountedBuffer.worktreeId) {
        flushCellChangesRef.current()
      }
    }
  }, [bufferId, worktreeId])

  const saveNotebook = async (expected = sessionSnapshot): Promise<boolean> => {
    const operation = beginBusy(expected)
    if (!operation) return false
    flushCellChanges()
    showSourceError(null, expected)
    showControlError(null, expected)
    try {
      await action('save', {}, expected)
      return isCurrentSession(expected)
    } catch (error) {
      showSourceError(error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const mutateNotebook = async (
    name: string,
    fields: Record<string, unknown>,
    expected = sessionSnapshot,
    structural = false
  ): Promise<boolean> => {
    if (!isCurrentSession(expected) || busyOperationRef.current?.sessionGeneration === expected.generation) return false
    const operationSession = structural ? beginStructureMutation(expected) : expected
    if (!operationSession) return false
    const operation = beginBusy(operationSession)
    if (!operation) {
      if (structural) releaseStructureMutation(operationSession)
      return false
    }
    flushCellChanges()
    showSourceError(null, operationSession)
    showControlError(null, operationSession)
    try {
      const result = asRecord(await action(name, fields, operationSession))
      const revision = result.contentRevision
      const current = sessionRef.current
      if (structural && isCurrentSession(operationSession) && current?.pendingStructure &&
        typeof revision === 'number' && Number.isSafeInteger(revision) &&
        revision >= buffer.contentRevision) {
        sessionRef.current = { ...current, pendingStructureAckRevision: revision }
      }
      return isCurrentSession(operationSession)
    } catch (error) {
      const errorSession = structural ? releaseStructureMutation(operationSession) : operationSession
      showSourceError(error instanceof Error ? error.message : String(error), errorSession ?? operationSession)
      throw error
    } finally {
      finishBusy(operation, operationSession)
    }
  }

  const isEnvironmentPromptCurrent = (
    prompt: EnvironmentPicker,
    expected: typeof sessionSnapshot
  ) => isCurrentSession(expected) &&
    prompt.sessionGeneration === expected.generation &&
    environmentPickerRef.current?.generation === prompt.generation

  const updateEnvironmentPrompt = (
    prompt: EnvironmentPicker,
    expected: typeof sessionSnapshot,
    patch: Partial<EnvironmentPicker>
  ): boolean => {
    if (!isEnvironmentPromptCurrent(prompt, expected)) return false
    const next = { ...environmentPickerRef.current!, ...patch }
    environmentPickerRef.current = next
    setEnvironmentPickerState(next)
    return true
  }

  const closeEnvironmentPrompt = (prompt: EnvironmentPicker, expected: typeof sessionSnapshot): boolean => {
    if (!isEnvironmentPromptCurrent(prompt, expected)) return false
    environmentPickerRef.current = null
    setEnvironmentPickerState(null)
    return true
  }

  const discoverEnvironments = async (
    prompt: EnvironmentPicker,
    expected: typeof sessionSnapshot
  ): Promise<boolean> => {
    if (!isEnvironmentPromptCurrent(prompt, expected) || environmentPickerRef.current?.pending) return false
    showControlError(null, expected)
    if (!updateEnvironmentPrompt(prompt, expected, { choices: [], pending: true, error: null, settled: false })) return false
    try {
      const result = asRecord(await action('environments', {}, expected))
      if (!isEnvironmentPromptCurrent(prompt, expected)) return true
      const environments = Array.isArray(result.environments)
        ? result.environments.map(asRecord).filter((entry): entry is ApiRecord & Environment =>
          typeof entry.path === 'string' && typeof entry.name === 'string')
        : []
      updateEnvironmentPrompt(prompt, expected, { choices: environments, pending: false, error: null, settled: true })
      return true
    } catch (error) {
      if (!isEnvironmentPromptCurrent(prompt, expected)) return true
      updateEnvironmentPrompt(prompt, expected, {
        pending: false,
        error: error instanceof Error ? error.message : String(error),
        settled: true
      })
      throw error
    }
  }

  const openEnvironmentPicker = async (expected = sessionSnapshot): Promise<boolean> => {
    if (!isCurrentSession(expected) || actionBusy || environmentPickerRef.current?.sessionGeneration === expected.generation) return false
    const prompt: EnvironmentPicker = {
      generation: crypto.randomUUID(),
      sessionGeneration: expected.generation,
      choices: [],
      pending: false,
      error: null,
      settled: false
    }
    environmentPickerRef.current = prompt
    setEnvironmentPickerState(prompt)
    return discoverEnvironments(prompt, expected)
  }

  const selectEnvironment = async (
    prompt: EnvironmentPicker,
    path: string,
    expected = sessionSnapshot
  ): Promise<boolean> => {
    if (!isEnvironmentPromptCurrent(prompt, expected) || !prompt.settled || prompt.pending || prompt.error !== null ||
      !prompt.choices.some((environment) => environment.path === path)) return false
    const operation = beginBusy(expected)
    if (!operation) return false
    updateEnvironmentPrompt(prompt, expected, { error: null })
    try {
      const selected = asRecord(await action('select', { python: path }, expected))
      if (!isEnvironmentPromptCurrent(prompt, expected)) return false
      if (selected.cancelled === true) return true
      const refreshed = await refreshRuntime(expected)
      if (!refreshed || !isEnvironmentPromptCurrent(prompt, expected)) return false
      closeEnvironmentPrompt(prompt, expected)
      showKernelError(null, expected)
      return true
    } catch (error) {
      updateEnvironmentPrompt(prompt, expected, {
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const browseEnvironment = async (
    prompt: EnvironmentPicker,
    expected = sessionSnapshot
  ): Promise<boolean> => {
    if (!isEnvironmentPromptCurrent(prompt, expected) || prompt.pending || actionBusy) return false
    const operation = beginBusy(expected)
    if (!operation) return false
    updateEnvironmentPrompt(prompt, expected, { error: null })
    try {
      const selected = asRecord(await action('select', { browse: true }, expected))
      if (!isEnvironmentPromptCurrent(prompt, expected)) return false
      if (selected.cancelled === true) return true
      const refreshed = await refreshRuntime(expected)
      if (!refreshed || !isEnvironmentPromptCurrent(prompt, expected)) return false
      closeEnvironmentPrompt(prompt, expected)
      showKernelError(null, expected)
      return true
    } catch (error) {
      updateEnvironmentPrompt(prompt, expected, {
        error: error instanceof Error ? error.message : String(error)
      })
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const isTrustPromptCurrent = (prompt: TrustPrompt, expected: typeof sessionSnapshot) =>
    isCurrentSession(expected) &&
    prompt.sessionGeneration === expected.generation &&
    trustPromptRef.current?.generation === prompt.generation

  const openTrustPrompt = (
    request: TrustRequest,
    expected: typeof sessionSnapshot,
    python: string | null
  ): TrustPrompt | null => {
    if (!isCurrentSession(expected) || trustPromptRef.current?.sessionGeneration === expected.generation) return null
    const prompt = {
      generation: crypto.randomUUID(),
      sessionGeneration: expected.generation,
      request: { ...request },
      python
    }
    trustPromptRef.current = prompt
    setTrustPromptState(prompt)
    return prompt
  }

  const closeTrustPrompt = (prompt: TrustPrompt, expected: typeof sessionSnapshot): boolean => {
    if (!isTrustPromptCurrent(prompt, expected)) return false
    trustPromptRef.current = null
    setTrustPromptState(null)
    return true
  }

  const isSetupPromptCurrent = (prompt: SetupPrompt, expected: typeof sessionSnapshot) =>
    isCurrentSession(expected) &&
    prompt.sessionGeneration === expected.generation &&
    setupPromptRef.current?.generation === prompt.generation

  const openSetupPrompt = (
    kind: 'install' | 'venv',
    expected: typeof sessionSnapshot,
    python: string | null,
    error: string | null = null
  ): SetupPrompt | null => {
    if (!isCurrentSession(expected)) return null
    const prompt = { generation: crypto.randomUUID(), sessionGeneration: expected.generation, kind, python }
    setupPromptRef.current = prompt
    setSetupPromptState(prompt)
    setSetupErrorState(error === null ? null : {
      sessionGeneration: expected.generation,
      promptGeneration: prompt.generation,
      message: error
    })
    return prompt
  }

  const updateSetupError = (prompt: SetupPrompt, message: string, expected: typeof sessionSnapshot) => {
    if (!isSetupPromptCurrent(prompt, expected)) return
    setSetupErrorState({ sessionGeneration: expected.generation, promptGeneration: prompt.generation, message })
  }

  const closeSetupPrompt = (prompt: SetupPrompt, expected: typeof sessionSnapshot): boolean => {
    if (!isSetupPromptCurrent(prompt, expected)) return false
    setupPromptRef.current = null
    setSetupPromptState(null)
    setSetupErrorState(null)
    return true
  }

  const setup = async (prompt: SetupPrompt, expected = sessionSnapshot): Promise<boolean> => {
    if (!isSetupPromptCurrent(prompt, expected)) return false
    const operation = beginBusy(expected, 'Setting up Python environment…')
    if (!operation) return false
    setSetupErrorState(null)
    showControlError(null, expected)
    try {
      const result = asRecord(await action(
        prompt.kind,
        prompt.python === null ? {} : { python: prompt.python },
        expected
      ))
      if (!isSetupPromptCurrent(prompt, expected)) return false
      if (result.status === 'venv-required') {
        openSetupPrompt(
          'venv',
          expected,
          prompt.python,
          typeof result.error === 'string' ? result.error : 'Python environment setup needs attention.'
        )
        return true
      }
      if (result.status === 'failed') {
        updateSetupError(
          prompt,
          typeof result.error === 'string' ? result.error : 'Python environment setup needs attention.',
          expected
        )
        return true
      }
      const refreshed = await refreshRuntime(expected)
      if (!refreshed || !isSetupPromptCurrent(prompt, expected)) return false
      closeSetupPrompt(prompt, expected)
      return true
    } catch (error) {
      updateSetupError(prompt, error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const useAnotherPython = async (prompt: SetupPrompt, expected = sessionSnapshot): Promise<boolean> => {
    if (prompt.kind !== 'install' || !isSetupPromptCurrent(prompt, expected) || actionBusy) return false
    if (!closeSetupPrompt(prompt, expected)) return false
    return openEnvironmentPicker(expected)
  }

  const executeRun = async (
    request: TrustRequest,
    expected: typeof sessionSnapshot,
    operation: BusyOperation,
    python: string | null,
    runtimeForRun: NotebookRuntimeState,
    trustPrompt?: TrustPrompt
  ): Promise<boolean> => {
    try {
      if (!isCurrentSession(expected) || readOnlyRef.current || runtimeForRun.busy) return false
      flushCellChanges()
      if (!isCurrentSession(expected) || readOnlyRef.current) return false
      showKernelError(null, expected)
      const result = request.all
        ? asRecord(await action('runAll', {}, expected))
        : asRecord(await action('run', { index: request.index, mode: request.mode }, expected))
      if (!isCurrentSession(expected) || trustPrompt && !isTrustPromptCurrent(trustPrompt, expected)) return false
      let refreshed: NotebookRuntimeState | null = null
      if (result.status === 'missing-ipykernel') {
        refreshed = await refreshRuntime(expected)
        if (!refreshed || !isCurrentSession(expected) || trustPrompt && !isTrustPromptCurrent(trustPrompt, expected)) {
          return false
        }
        openSetupPrompt(
          result.externallyManaged === true ? 'venv' : 'install',
          expected,
          refreshed.selectedPython?.path ?? python
        )
      } else if (result.status === 'failed' || result.status === 'dead' || result.status === 'error') {
        showKernelError(typeof result.stderr === 'string' ? result.stderr : 'Notebook execution failed.', expected)
      } else if (!request.all && request.mode === 'advance' &&
        typeof result.nextIndex === 'number' && Number.isSafeInteger(result.nextIndex) &&
        result.nextIndex >= 0 && result.nextIndex < cells.length) {
        setEditingCell(result.nextIndex)
      }
      refreshed ??= await refreshRuntime(expected)
      return refreshed !== null && isCurrentSession(expected) &&
        (!trustPrompt || isTrustPromptCurrent(trustPrompt, expected))
    } catch (error) {
      showKernelError(error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      if (trustPrompt) closeTrustPrompt(trustPrompt, expected)
      finishBusy(operation, expected)
    }
  }

  const requestRun = async (request: TrustRequest, expected = sessionSnapshot): Promise<boolean> => {
    if (!isCurrentSession(expected) || runtimePending || !runtime || readOnlyRef.current ||
      !parsed.valid || !parsed.language.startsWith('python') || runtime.busy ||
      busyOperationRef.current?.sessionGeneration === expected.generation) return false
    if (!runtime.trusted) return openTrustPrompt(request, expected, runtime.selectedPython?.path ?? null) !== null
    const operation = beginBusy(expected, 'Running notebook…')
    if (!operation) return false
    showControlError(null, expected)
    return executeRun(request, expected, operation, runtime.selectedPython?.path ?? null, runtime)
  }

  const confirmTrust = async (prompt: TrustPrompt, expected = sessionSnapshot): Promise<boolean> => {
    if (!isTrustPromptCurrent(prompt, expected) || readOnlyRef.current) return false
    const operation = beginBusy(expected, 'Running notebook…')
    if (!operation) return false
    showControlError(null, expected)
    try {
      await action('trust', {}, expected)
      if (!isTrustPromptCurrent(prompt, expected) || readOnlyRef.current) return false
      const refreshed = await refreshRuntime(expected)
      if (!refreshed || !isTrustPromptCurrent(prompt, expected) || readOnlyRef.current) return false
      if (!refreshed.trusted || (refreshed.selectedPython?.path ?? null) !== prompt.python) {
        throw new Error('Notebook trust or selected Python changed before execution.')
      }
      return await executeRun(prompt.request, expected, operation, prompt.python, refreshed, prompt)
    } catch (error) {
      showKernelError(error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const restartKernel = async (expected = sessionSnapshot): Promise<boolean> => {
    if (!isCurrentSession(expected)) return false
    const operation = beginBusy(expected)
    if (!operation) return false
    showKernelError(null, expected)
    try {
      await action('restart', {}, expected)
      if (!isCurrentSession(expected)) return false
      const refreshed = await refreshRuntime(expected)
      return refreshed !== null && isCurrentSession(expected)
    } catch (error) {
      showKernelError(error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const interruptKernel = async (expected = sessionSnapshot): Promise<boolean> => {
    if (!isCurrentSession(expected)) return false
    const operation = beginBusy(expected)
    if (!operation) return false
    showKernelError(null, expected)
    try {
      await action('interrupt', {}, expected)
      return isCurrentSession(expected)
    } catch (error) {
      showKernelError(error instanceof Error ? error.message : String(error), expected)
      throw error
    } finally {
      finishBusy(operation, expected)
    }
  }

  const insertCell = (
    index: number,
    position: 'above' | 'below',
    cellType: 'code' | 'markdown' | 'raw',
    expected = sessionSnapshot
  ) => mutateNotebook('insert', { index, position, cellType }, expected, true)

  const updateCell = (index: number, value: string) => {
    setCellDrafts((current) => ({ ...current, [index]: value }))
    pendingCellChanges.current.set(index, value)
    if (cellTimer.current !== undefined) window.clearTimeout(cellTimer.current)
    cellTimer.current = window.setTimeout(() => flushCellChangesRef.current(), 400)
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
    window.requestAnimationFrame(() => document.getElementById(findInputId)?.focus())
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

  const pythonNotebook = parsed.valid && parsed.language.startsWith('python') && !sourceMode
  const richNotebook = parsed.valid && !sourceMode
  const indexActionsAvailable = richNotebook && !buffer.readOnly && !session.pendingStructure
  const viewIndexActionsAvailable = richNotebook && !session.pendingStructure
  const hasMoreOutputs = cells.some((cell, index) =>
    cell.cell_type === 'code' && Array.isArray(cell.outputs) && cell.outputs.length > (outputLimits[index] ?? OUTPUT_PAGE_SIZE)
  )
  const notebookActions: string[] = ['mode', 'find']
  if (!buffer.readOnly) notebookActions.unshift('save')
  if (findOpen) {
    notebookActions.push('find-close')
    if (findMatches.length > 0) notebookActions.push('find-next', 'find-previous')
  }
  if (pythonNotebook) {
    notebookActions.push('environments')
    if (!buffer.readOnly) {
      notebookActions.push('clear-all')
      if (!runtimePending && runtime && !runtime.busy) notebookActions.push('run-all')
    }
    if (runtime?.busy) notebookActions.push('interrupt')
    if (runtime?.kernel?.status === 'ready' || runtime?.kernel?.status === 'dead') notebookActions.push('restart')
  }
  if (viewIndexActionsAvailable) {
    if (cells.length > CELL_PAGE_SIZE) notebookActions.push('page')
    if (hasMoreOutputs) notebookActions.push('show-outputs')
  }
  if (indexActionsAvailable) {
    notebookActions.push('append-cell')
    if (cells.length > 0) notebookActions.push('edit-cell', 'delete-cell', 'cell-type', 'insert-cell')
    if (cells.length > 1) notebookActions.push('move-cell')
    if (cells.some((cell) => cell.cell_type === 'code')) notebookActions.push('clear-cell')
    if (pythonNotebook && !runtimePending && runtime && !runtime.busy && cells.some((cell) => cell.cell_type === 'code')) {
      notebookActions.push('run-cell')
    }
  }

  const validIndex = (
    data: unknown,
    allowEnd = false,
    allowed: readonly string[] = ['index']
  ): number | null => {
    if (!hasControlData(data, allowed, ['index']) || typeof data.index !== 'number' ||
      !Number.isSafeInteger(data.index) || data.index < 0) return null
    if (data.index > (allowEnd ? cells.length : cells.length - 1)) return null
    return data.index
  }

  const dispatchNotebookControl = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    if (control.surface !== controlSurface || control.target !== `notebook:${bufferId}` ||
      control.generation !== sessionGeneration || !isCurrentSession(sessionSnapshot) || actionBusy) {
      return { delivered: false }
    }
    const noData = hasControlData(control.data, [], [])
    switch (control.action) {
      case 'save':
        if (!noData || buffer.readOnly) return { delivered: false }
        return { delivered: await saveNotebook(sessionSnapshot) }
      case 'mode': {
        if (!hasControlData(control.data, ['value'], ['value']) ||
          (control.data.value !== 'source' && control.data.value !== 'rich')) return { delivered: false }
        flushCellChanges()
        onView({ mode: control.data.value })
        return { delivered: true }
      }
      case 'find': {
        if (!hasControlData(control.data, ['query'], []) ||
          control.data !== undefined && Object.hasOwn(control.data, 'query') && typeof control.data.query !== 'string') {
          return { delivered: false }
        }
        try {
          openFind(control.data)
        } catch (error) {
          showSourceError(error instanceof Error ? error.message : String(error), sessionSnapshot)
          throw error
        }
        return { delivered: true }
      }
      case 'find-close':
        if (!noData || !findOpen) return { delivered: false }
        setFindOpen(false)
        return { delivered: true }
      case 'find-next':
        if (!noData || !findOpen || findMatches.length === 0) return { delivered: false }
        moveFind(1)
        return { delivered: true }
      case 'find-previous':
        if (!noData || !findOpen || findMatches.length === 0) return { delivered: false }
        moveFind(-1)
        return { delivered: true }
      case 'environments':
        if (!noData || !pythonNotebook) return { delivered: false }
        return { delivered: await openEnvironmentPicker(sessionSnapshot) }
      case 'run-all':
        if (!noData || !pythonNotebook || runtimePending || !runtime) return { delivered: false }
        return { delivered: await requestRun({ index: null, all: true, mode: 'in-place' }, sessionSnapshot) }
      case 'clear-all':
        if (!noData || !pythonNotebook || buffer.readOnly) return { delivered: false }
        return { delivered: await mutateNotebook('clear', {}, sessionSnapshot) }
      case 'interrupt':
        if (!noData || !runtime?.busy) return { delivered: false }
        return { delivered: await interruptKernel(sessionSnapshot) }
      case 'restart':
        if (!noData || (runtime?.kernel?.status !== 'ready' && runtime?.kernel?.status !== 'dead')) {
          return { delivered: false }
        }
        return { delivered: await restartKernel(sessionSnapshot) }
      case 'append-cell':
        if (!noData || !richNotebook || buffer.readOnly || sessionRef.current?.pendingStructure) return { delivered: false }
        setCellOffset(Math.max(0, Math.floor(cells.length / CELL_PAGE_SIZE) * CELL_PAGE_SIZE))
        return { delivered: await insertCell(cells.length, 'below', 'code', sessionSnapshot) }
      case 'page': {
        if (!hasControlData(control.data, ['direction'], ['direction']) ||
          (control.data.direction !== 'previous' && control.data.direction !== 'next') ||
          !richNotebook || cells.length <= CELL_PAGE_SIZE || sessionRef.current?.pendingStructure) {
          return { delivered: false }
        }
        if (control.data.direction === 'previous') {
          if (cellOffset === 0) return { delivered: false }
          setCellOffset(Math.max(0, cellOffset - CELL_PAGE_SIZE))
        } else {
          if (visibleCellEnd >= cells.length) return { delivered: false }
          setCellOffset(Math.min(cells.length - 1, cellOffset + CELL_PAGE_SIZE))
        }
        return { delivered: true }
      }
      case 'edit-cell': {
        if (!hasControlData(control.data, ['index', 'editing'], ['index', 'editing']) ||
          typeof control.data.editing !== 'boolean' || !indexActionsAvailable) return { delivered: false }
        const index = validIndex(control.data, false, ['index', 'editing'])
        if (index === null || control.data.editing === false && editingCell !== index) return { delivered: false }
        setEditingCell(control.data.editing ? index : null)
        return { delivered: true }
      }
      case 'show-outputs': {
        if (!hasControlData(control.data, ['index'], ['index']) ||
          !viewIndexActionsAvailable || sessionRef.current?.pendingStructure) return { delivered: false }
        const index = validIndex(control.data)
        const cell = index === null ? undefined : cells[index]
        const outputCount = cell?.cell_type === 'code' && Array.isArray(cell.outputs) ? cell.outputs.length : 0
        const outputLimit = index === null ? OUTPUT_PAGE_SIZE : outputLimits[index] ?? OUTPUT_PAGE_SIZE
        if (index === null || outputCount <= outputLimit) return { delivered: false }
        setOutputLimits((current) => ({ ...current, [index]: outputLimit + OUTPUT_PAGE_SIZE }))
        return { delivered: true }
      }
      case 'clear-cell':
      case 'delete-cell': {
        if (!hasControlData(control.data, ['index'], ['index']) || !indexActionsAvailable) return { delivered: false }
        const index = validIndex(control.data)
        const cell = index === null ? undefined : cells[index]
        if (index === null || control.action === 'clear-cell' && cell?.cell_type !== 'code') return { delivered: false }
        return { delivered: await mutateNotebook(
          control.action === 'clear-cell' ? 'clear' : 'delete',
          { index },
          sessionSnapshot,
          control.action === 'delete-cell'
        ) }
      }
      case 'run-cell': {
        if (!hasControlData(control.data, ['index', 'mode'], ['index', 'mode']) ||
          (control.data.mode !== 'advance' && control.data.mode !== 'in-place') ||
          !pythonNotebook || runtimePending || !runtime || buffer.readOnly || runtime.busy || !indexActionsAvailable) {
          return { delivered: false }
        }
        const index = validIndex(control.data, false, ['index', 'mode'])
        if (index === null || cells[index]!.cell_type !== 'code') return { delivered: false }
        return { delivered: await requestRun({ index, all: false, mode: control.data.mode }, sessionSnapshot) }
      }
      case 'insert-cell': {
        if (!hasControlData(control.data, ['index', 'position', 'cellType'], ['index', 'position', 'cellType']) ||
          (control.data.position !== 'above' && control.data.position !== 'below') ||
          (control.data.cellType !== 'code' && control.data.cellType !== 'markdown' && control.data.cellType !== 'raw') ||
          !indexActionsAvailable) return { delivered: false }
        const index = validIndex(control.data, true, ['index', 'position', 'cellType'])
        if (index === null) return { delivered: false }
        return { delivered: await insertCell(index, control.data.position, control.data.cellType, sessionSnapshot) }
      }
      case 'move-cell': {
        if (!hasControlData(control.data, ['index', 'direction'], ['index', 'direction']) ||
          (control.data.direction !== 'up' && control.data.direction !== 'down') ||
          !indexActionsAvailable || cells.length < 2) return { delivered: false }
        const index = validIndex(control.data, false, ['index', 'direction'])
        if (index === null || control.data.direction === 'up' && index === 0 ||
          control.data.direction === 'down' && index === cells.length - 1) return { delivered: false }
        return { delivered: await mutateNotebook('move', { index, direction: control.data.direction }, sessionSnapshot, true) }
      }
      case 'cell-type': {
        if (!hasControlData(control.data, ['index', 'cellType'], ['index', 'cellType']) ||
          (control.data.cellType !== 'code' && control.data.cellType !== 'markdown' && control.data.cellType !== 'raw') ||
          !indexActionsAvailable) return { delivered: false }
        const index = validIndex(control.data, false, ['index', 'cellType'])
        if (index === null || cells[index]!.cell_type === control.data.cellType) return { delivered: false }
        return { delivered: await mutateNotebook('type', { index, cellType: control.data.cellType }, sessionSnapshot, true) }
      }
      default:
        return { delivered: false }
    }
  }

  const dispatchEnvironmentControl = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    const prompt = environmentPickerRef.current
    if (!prompt || control.surface !== controlSurface || control.target !== `notebook-environments:${bufferId}` ||
      control.generation !== prompt.generation || !isEnvironmentPromptCurrent(prompt, sessionSnapshot)) {
      return { delivered: false }
    }
    const noData = hasControlData(control.data, [], [])
    if (control.action === 'refresh') {
      if (!noData) return { delivered: false }
      return { delivered: await discoverEnvironments(prompt, sessionSnapshot) }
    }
    if (control.action === 'browse') {
      if (!noData) return { delivered: false }
      return { delivered: await browseEnvironment(prompt, sessionSnapshot) }
    }
    if (control.action === 'cancel') {
      if (!noData || actionBusy) return { delivered: false }
      return { delivered: closeEnvironmentPrompt(prompt, sessionSnapshot) }
    }
    if (control.action === 'select') {
      if (!hasControlData(control.data, ['python'], ['python']) || typeof control.data.python !== 'string') {
        return { delivered: false }
      }
      return { delivered: await selectEnvironment(prompt, control.data.python, sessionSnapshot) }
    }
    return { delivered: false }
  }

  const dispatchTrustControl = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    const prompt = trustPromptRef.current
    if (!prompt || control.surface !== controlSurface || control.target !== `notebook-trust:${bufferId}` ||
      control.generation !== prompt.generation || !isTrustPromptCurrent(prompt, sessionSnapshot)) {
      return { delivered: false }
    }
    if (!hasControlData(control.data, [], [])) return { delivered: false }
    if (control.action === 'cancel') {
      if (actionBusy) return { delivered: false }
      return { delivered: closeTrustPrompt(prompt, sessionSnapshot) }
    }
    if (control.action === 'confirm') return { delivered: await confirmTrust(prompt, sessionSnapshot) }
    return { delivered: false }
  }

  const dispatchSetupControl = async (control: EditorUiControl): Promise<EditorUiControlResult> => {
    const prompt = setupPromptRef.current
    if (!prompt || control.surface !== controlSurface || control.target !== `notebook-setup:${bufferId}` ||
      control.generation !== prompt.generation || !isSetupPromptCurrent(prompt, sessionSnapshot)) {
      return { delivered: false }
    }
    if (!hasControlData(control.data, [], [])) return { delivered: false }
    if (control.action === 'cancel') {
      if (actionBusy) return { delivered: false }
      return { delivered: closeSetupPrompt(prompt, sessionSnapshot) }
    }
    if (control.action === 'confirm') return { delivered: await setup(prompt, sessionSnapshot) }
    if (control.action === 'another-python') return { delivered: await useAnotherPython(prompt, sessionSnapshot) }
    return { delivered: false }
  }

  const notebookControlAddress: EditorUiControlAddress = {
    surface: controlSurface,
    target: `notebook:${bufferId}`,
    generation: sessionGeneration,
    actions: notebookActions
  }
  const notebookControls = useEditorUiControl({
    context: props.context,
    address: notebookControlAddress,
    handler: dispatchNotebookControl,
    onError: (error) => showControlError(error.message, sessionSnapshot)
  })
  const environmentControls = useEditorUiControl({
    context: props.context,
    address: environmentPicker ? {
      surface: controlSurface,
      target: `notebook-environments:${bufferId}`,
      generation: environmentPicker.generation,
      actions: ['refresh', 'browse', 'cancel', ...(environmentPicker.settled && environmentPicker.choices.length > 0 ? ['select'] : [])]
    } : null,
    handler: dispatchEnvironmentControl,
    onError: (error) => showControlError(error.message, sessionSnapshot)
  })
  const trustControls = useEditorUiControl({
    context: props.context,
    address: trustPrompt ? {
      surface: controlSurface,
      target: `notebook-trust:${bufferId}`,
      generation: trustPrompt.generation,
      actions: buffer.readOnly ? ['cancel'] : ['confirm', 'cancel']
    } : null,
    handler: dispatchTrustControl,
    onError: (error) => showControlError(error.message, sessionSnapshot)
  })
  const setupControls = useEditorUiControl({
    context: props.context,
    address: setupPromptIdentity ? {
      surface: controlSurface,
      target: `notebook-setup:${bufferId}`,
      generation: setupPromptIdentity.generation,
      actions: ['confirm', 'cancel', ...(setupPromptIdentity.kind === 'install' ? ['another-python'] : [])]
    } : null,
    handler: dispatchSetupControl,
    onError: (error) => showControlError(error.message, sessionSnapshot)
  })

  useEffect(() => {
    publishControlReport({})
  }, [publishControlReport, structureRevision])

  const onCellKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>, index: number) => {
    if (event.key !== 'Enter' || !event.shiftKey && !event.metaKey && !event.ctrlKey) return
    event.preventDefault()
    void notebookControls.run('run-cell', { index, mode: event.metaKey || event.ctrlKey ? 'in-place' : 'advance' })
  }

  const visibleCellEnd = Math.min(cellOffset + CELL_PAGE_SIZE, cells.length)
  const visibleCells = cells.slice(cellOffset, visibleCellEnd)

  return <section className="quirky-notebook-surface" aria-label="Notebook" style={{ fontSize: props.fontSize }}>
    <header className="notebook-toolbar">
      <strong>{buffer.name}</strong>
      <Badge tone={parsed.valid ? 'accent' : 'failing'}>{parsed.valid ? `${parsed.cellCount} cells · ${parsed.language}` : 'Notebook parse error'}</Badge>
      <Button
        className="editor-viewer-mode-toggle"
        type="button"
        aria-pressed={sourceMode}
        disabled={actionBusy}
        onClick={() => { void notebookControls.run('mode', { value: sourceMode ? 'rich' : 'source' }) }}
      >
        {sourceMode ? 'Notebook' : 'Source'}
      </Button>
      <Button type="button" onClick={() => { void notebookControls.run('save') }} disabled={buffer.readOnly || actionBusy}>Save notebook</Button>
      <Button type="button" onClick={() => { void notebookControls.run('find') }} disabled={actionBusy}>Find</Button>
      {!sourceMode && parsed.valid && parsed.language.startsWith('python') && <>
        <Button type="button" onClick={() => { void notebookControls.run('environments') }} disabled={actionBusy}>
          {runtime?.selectedPython?.name ? `${runtime.selectedPython.name}${runtime.selectedPython.version ? ` (Python ${runtime.selectedPython.version})` : ''}` : 'Select Kernel'}
        </Button>
        <Button type="button" variant="primary" onClick={() => { void notebookControls.run('run-all') }} disabled={actionBusy || runtimePending || !runtime || runtime.busy === true || buffer.readOnly}>Run all</Button>
        <Button type="button" variant="destructive" onClick={() => { void notebookControls.run('clear-all') }} disabled={actionBusy || buffer.readOnly}>Clear all outputs</Button>
        {runtime?.busy && <Button type="button" onClick={() => { void notebookControls.run('interrupt') }} disabled={actionBusy}>Interrupt</Button>}
        {(runtime?.kernel?.status === 'ready' || runtime?.kernel?.status === 'dead') && <Button type="button" onClick={() => { void notebookControls.run('restart') }} disabled={actionBusy}>Restart kernel</Button>}
      </>}
    </header>
    {runtimePending && <NoticeLine>Loading notebook runtime…</NoticeLine>}
    {operationNotice && <NoticeLine>{operationNotice}</NoticeLine>}
    {runtimeReadError && <InlineError message={runtimeReadError} />}
    {findOpen && <div className="notebook-toolbar" role="search" aria-label="Find in notebook">
      <TextField
        id={findInputId}
        label="Find in notebook"
        value={findQuery}
        onChange={(event) => { setFindQuery(event.currentTarget.value); setFindIndex(-1) }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            void notebookControls.run('find-next')
          } else if (event.key === 'Escape') {
            event.preventDefault()
            void notebookControls.run('find-close')
          }
        }}
      />
      <Button type="button" onClick={() => { void notebookControls.run('find-previous') }} disabled={findMatches.length === 0 || actionBusy}>Previous</Button>
      <Button type="button" onClick={() => { void notebookControls.run('find-next') }} disabled={findMatches.length === 0 || actionBusy}>Next</Button>
      <Button type="button" onClick={() => { void notebookControls.run('find-close') }} disabled={actionBusy}>Close</Button>
    </div>}

    {sourceMode ? <textarea
      className="editor-viewer-source notebook-source"
      aria-label="Notebook source JSON"
      style={{ fontSize: props.fontSize }}
      spellCheck={false}
      value={content}
      onChange={(event) => submitNotebookDraft(event.currentTarget.value, true)}
    /> : parsed.valid ? <main className="notebook-cells">
      {cells.length === 0 && <EmptyState message="Empty notebook" />}
      {cells.length > CELL_PAGE_SIZE && <nav aria-label="Notebook cell pages">
        <span>Cells {cellOffset + 1}–{visibleCellEnd} of {cells.length}</span>
        <Button type="button" onClick={() => { void notebookControls.run('page', { direction: 'previous' }) }} disabled={cellOffset === 0 || actionBusy || session.pendingStructure}>Previous cells</Button>
        <Button type="button" onClick={() => { void notebookControls.run('page', { direction: 'next' }) }} disabled={visibleCellEnd >= cells.length || actionBusy || session.pendingStructure}>Next cells</Button>
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
            <Badge tone="neutral" label={`Cell type: ${cell.cell_type}`}>{cell.cell_type}</Badge>
            {cell.cell_type === 'code' && <Badge tone={runtime?.busy ? 'working' : 'neutral'} label="Execution count">[{typeof cell.execution_count === 'number' ? cell.execution_count : runtime?.busy ? '*' : ' '}]</Badge>}
            {cell.cell_type === 'code' && <Button type="button" onClick={() => { void notebookControls.run('run-cell', { index, mode: 'in-place' }) }} disabled={actionBusy || runtimePending || !runtime || runtime.busy === true || buffer.readOnly}>Run cell</Button>}
            <Button type="button" onClick={() => { void notebookControls.run('edit-cell', { index, editing: !isEditing }) }} disabled={buffer.readOnly || actionBusy}>{isEditing ? 'Done editing' : 'Edit cell'}</Button>
            <details>
              <summary>More cell actions</summary>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'above', cellType: 'code' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert code above</Button>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'above', cellType: 'markdown' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert Markdown above</Button>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'above', cellType: 'raw' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert raw above</Button>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'below', cellType: 'code' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert code below</Button>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'below', cellType: 'markdown' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert Markdown below</Button>
              <Button type="button" onClick={() => { void notebookControls.run('insert-cell', { index, position: 'below', cellType: 'raw' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Insert raw below</Button>
            </details>
            <Button type="button" onClick={() => { void notebookControls.run('move-cell', { index, direction: 'up' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure || index === 0}>Move up</Button>
            <Button type="button" onClick={() => { void notebookControls.run('move-cell', { index, direction: 'down' }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure || index === cells.length - 1}>Move down</Button>
            <select className="editor-viewer-select" aria-label="Cell type" value={cell.cell_type} disabled={actionBusy || buffer.readOnly || session.pendingStructure} onChange={(event) => { void notebookControls.run('cell-type', { index, cellType: event.currentTarget.value }) }}>
              <option value="code">Code</option><option value="markdown">Markdown</option><option value="raw">Raw</option>
            </select>
            {cell.cell_type === 'code' && <Button type="button" variant="destructive" onClick={() => { void notebookControls.run('clear-cell', { index }) }} disabled={actionBusy || buffer.readOnly}>Clear outputs</Button>}
            <Button type="button" variant="destructive" onClick={() => { void notebookControls.run('delete-cell', { index }) }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Delete cell</Button>
          </div>
          {isEditing ? <textarea
            className="editor-viewer-source notebook-cell-editor"
            ref={(element) => {
              if (element) cellTextareas.current.set(index, element)
              else cellTextareas.current.delete(index)
            }}
            style={{ fontSize: props.fontSize }}
            spellCheck={cell.cell_type === 'markdown'}
            value={cellText}
            onKeyDown={cell.cell_type === 'code' ? (event) => onCellKeyDown(event, index) : undefined}
            onChange={(event) => updateCell(index, event.currentTarget.value)}
            readOnly={buffer.readOnly}
          /> : <pre className="notebook-cell-source" onClick={() => { void notebookControls.run('edit-cell', { index, editing: true }) }}>{preview.text}</pre>}
          {preview.truncated && !isEditing && <p role="status">Cell preview limited to 200 lines or 64 KiB. Edit this cell to access its complete source.</p>}
          {visibleOutputs.length > 0 && <div className="notebook-cell-outputs" aria-label={`Outputs for cell ${index + 1}`}>
            {visibleOutputs.map((output, outputIndex) => <CellOutput key={`${output.output_type}-${outputIndex}`} output={output} />)}
            {outputList.length > outputLimit && <>
              <p role="status">Showing {outputLimit} of {outputList.length} output frames.</p>
              <Button type="button" onClick={() => { void notebookControls.run('show-outputs', { index }) }} disabled={actionBusy || session.pendingStructure}>Show next output frames</Button>
            </>}
          </div>}
        </article>
      })}
      {cells.length > CELL_PAGE_SIZE && <nav aria-label="Notebook cell pages">
        <Button type="button" onClick={() => { void notebookControls.run('page', { direction: 'previous' }) }} disabled={cellOffset === 0 || actionBusy || session.pendingStructure}>Previous cells</Button>
        <Button type="button" onClick={() => { void notebookControls.run('page', { direction: 'next' }) }} disabled={visibleCellEnd >= cells.length || actionBusy || session.pendingStructure}>Next cells</Button>
      </nav>}
      <Button type="button" onClick={() => { void notebookControls.run('append-cell') }} disabled={actionBusy || buffer.readOnly || session.pendingStructure}>Add code cell</Button>
    </main> : <InlineError
      message={parsed.error ?? 'Notebook parse error'}
      action={{ label: 'Open raw source', onAction: () => { void notebookControls.run('mode', { value: 'source' }) }}} 
    />}

    {environmentOpen && <section className="notebook-kernel-menu" aria-label="Python environments">
      <strong>Recommended and Python on PATH</strong>
      {environmentPending && <NoticeLine>Loading Python environments…</NoticeLine>}
      {!environmentPending && !environmentError && environmentChoices.length === 0 && <EmptyState message="No Python environments found." />}
      {environmentError && <InlineError
        message={environmentError}
        action={{ label: 'Retry', onAction: () => { void environmentControls.run('refresh') } }}
      />}
      {environmentChoices.length > 0 && <ul>{environmentChoices.map((environment) => <li key={environment.path}>
        <ListRow
          title={`${environment.name}${environment.version ? ` · Python ${environment.version}` : ''}`}
          description={environment.path}
          disabled={actionBusy}
          onClick={() => { void environmentControls.run('select', { python: environment.path }) }}
        />
      </li>)}</ul>}
      <Button type="button" onClick={() => { void environmentControls.run('browse') }} disabled={actionBusy}>Browse for Python…</Button>
      <Button type="button" onClick={() => { void environmentControls.run('cancel') }} disabled={actionBusy}>Cancel</Button>
    </section>}


    {trustPrompt && <Dialog
      open
      title="Run Notebook Code?"
      closeOnBackdrop={false}
      onClose={() => { void trustControls.run('cancel') }}
      actions={<>
        <Button type="button" onClick={() => { void trustControls.run('cancel') }} disabled={actionBusy}>Cancel</Button>
        <Button type="button" variant="primary" onClick={() => { void trustControls.run('confirm') }} disabled={actionBusy || buffer.readOnly}>{trustRequest?.all ? 'Run all' : 'Run cell'}</Button>
      </>}
    >
      <p>Notebook cells execute local Python on this machine from the notebook folder. Only run cells from files you trust.</p>
    </Dialog>}

    {setupPromptIdentity && <Dialog
      open
      title={setupPrompt === 'venv' ? 'Create a virtual environment?' : 'Install ipykernel?'}
      closeOnBackdrop={false}
      onClose={() => { void setupControls.run('cancel') }}
      actions={<>
        <Button type="button" onClick={() => { void setupControls.run('cancel') }} disabled={actionBusy}>Cancel</Button>
        <Button type="button" variant="primary" onClick={() => { void setupControls.run('confirm') }} disabled={actionBusy}>{setupPrompt === 'venv' ? 'Create .venv' : 'Install'}</Button>
        {setupPrompt === 'install' && <Button type="button" onClick={() => { void setupControls.run('another-python') }} disabled={actionBusy}>Use another Python</Button>}
      </>}
    >
      <p>{setupPrompt === 'venv' ? 'A workspace .venv will be created and ipykernel installed there.' : 'This installs or upgrades ipykernel in the selected Python environment.'}</p>
      {setupError && <InlineError message={setupError} />}
    </Dialog>}

    {runtime?.interruptStalled && <p role="status">Not responding. Restart kernel.</p>}
    {sourceError && <InlineError message={sourceError} />}
    {kernelError && <InlineError message={kernelError} />}
    {controlError && controlError !== sourceError && controlError !== kernelError &&
      controlError !== environmentError && controlError !== setupError &&
      <InlineError message={controlError} />}
    {runtime?.kernel?.status === 'dead' && <InlineError message={`The kernel died. ${runtime.kernel.error || runtime.kernel.stderr || 'The kernel process exited unexpectedly.'}`} />}
    {runtime?.kernel?.error && runtime.kernel.status !== 'dead' && <InlineError message={runtime.kernel.error} />}
  </section>
}
