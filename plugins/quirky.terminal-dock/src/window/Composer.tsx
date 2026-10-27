import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type ClipboardEvent, type CSSProperties, type DragEvent, type KeyboardEvent, type ReactNode, type SyntheticEvent, type UIEvent } from 'react'
import type { UiPluginContext } from '@quirky/protocol'
import type { DockAttachment, DockOptions, DockQuestion, DockState, PickerItem, SendResult } from '../types'

const PLUGIN_METHOD = 'quirky.terminal-dock/'
const UNCERTAINTY_WARNING = 'Send may not have completed. Check the terminal before retrying.'
const DRAFT_DEBOUNCE_MS = 220
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

type PickerKind = 'slash' | 'file'
type PickerState = {
  kind: PickerKind
  query: string
  start: number
  end: number
  status: 'loading' | 'ready' | 'error'
  items: PickerItem[]
  selected: number
  truncated: boolean
  error: string | null
}
export type ComposerActions = { focus(): void; flush(): Promise<boolean> }
type RegisterActions = (pane: string, actions: ComposerActions | null) => void
type DraftWrite = { baseRevision: number; text: string; version: number }
type SendSnapshot = { baseRevision: number; text: string }
type AgentState = 'working' | 'waiting' | 'blocked' | 'done'
type AgentStatus = { sessionId: string; state: AgentState }
type InteractionAnswer = string[][]
type Props = { context: UiPluginContext; pane: string; session: string; registerActions: RegisterActions }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function validQuestion(value: unknown): value is DockQuestion {
  return record(value) && typeof value.id === 'string' && (value.kind === 'question' || value.kind === 'permission') &&
    typeof value.title === 'string' && typeof value.collapsed === 'boolean' && typeof value.dismissed === 'boolean' &&
    Array.isArray(value.questions) && value.questions.every((question) =>
      record(question) && typeof question.prompt === 'string' && typeof question.multiple === 'boolean' &&
      Array.isArray(question.choices) && question.choices.every((choice) => record(choice) && typeof choice.label === 'string' && typeof choice.value === 'string')
    )
}

function validAttachment(value: unknown): value is DockAttachment {
  return record(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.path === 'string' &&
    typeof value.mime === 'string' && typeof value.image === 'boolean'
}

function validOptions(value: unknown): value is DockOptions {
  if (!record(value) || !record(value.choices)) return false
  const choices = value.choices
  const context = value.context
  const reportedValue = (item: unknown) => item === null || typeof item === 'string'
  const validContext = context === null || record(context) &&
    typeof context.used === 'number' && Number.isFinite(context.used) &&
    typeof context.limit === 'number' && Number.isFinite(context.limit)
  return reportedValue(value.model) && reportedValue(value.effort) && reportedValue(value.permission) &&
    stringArray(choices.model) && stringArray(choices.effort) && stringArray(choices.permission) &&
    validContext && (value.notice === null || typeof value.notice === 'string')
}

function isDockState(value: unknown): value is DockState {
  return record(value) && typeof value.pane === 'string' && typeof value.session === 'string' && typeof value.tab === 'string' &&
    typeof value.revision === 'number' && typeof value.enabled === 'boolean' && typeof value.supported === 'boolean' &&
    (value.agent === null || typeof value.agent === 'string') && typeof value.docked === 'boolean' && typeof value.userUndocked === 'boolean' &&
    typeof value.gutterRows === 'number' && typeof value.mounted === 'boolean' && typeof value.passthrough === 'boolean' &&
    typeof value.draft === 'string' && Array.isArray(value.attachments) && value.attachments.every(validAttachment) &&
    (value.disabledReason === null || typeof value.disabledReason === 'string') &&
    (value.activeSend === null || record(value.activeSend) && typeof value.activeSend.id === 'string' && typeof value.activeSend.phase === 'string') &&
    Array.isArray(value.queuedSends) && value.queuedSends.every((send) => record(send) && typeof send.id === 'string' && typeof send.phase === 'string') &&
    (value.question === null || validQuestion(value.question)) && validOptions(value.options) &&
    (value.notice === null || typeof value.notice === 'string')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function stateFromEvent(event: unknown): { pane: string; state: DockState } | null {
  if (!record(event) || event.type !== 'quirky.terminal-dock/changed' || !record(event.data)) return null
  const pane = event.data.pane
  const state = event.data.state
  return typeof pane === 'string' && isDockState(state) ? { pane, state } : null
}

function statusOf(value: unknown, session: string): AgentStatus | null {
  if (!record(value) || value.sessionId !== session || typeof value.state !== 'string') return null
  if (value.state !== 'working' && value.state !== 'waiting' && value.state !== 'blocked' && value.state !== 'done') return null
  return { sessionId: session, state: value.state }
}

function statusFromEvent(event: unknown, session: string): AgentStatus | null {
  if (!record(event) || event.type !== 'quirky.agent-status/changed' || !record(event.data)) return null
  const data = event.data
  const row = record(data.row) ? data.row : data
  return statusOf(row, session)
}
function statusWasRemoved(event: unknown, session: string): boolean {
  return record(event) && event.type === 'quirky.agent-status/changed' && record(event.data) &&
    event.data.sessionId === session && event.data.row === null
}

function pickerTrigger(text: string, cursor: number): { kind: PickerKind; query: string; start: number; end: number } | null {
  const before = text.slice(0, cursor)
  const at = before.lastIndexOf('@')
  const slash = before.lastIndexOf('/')
  const fileOwnsSlash = at >= 0 && slash > at && !/\s/.test(before.slice(at + 1, slash))
  const index = fileOwnsSlash || at > slash ? at : slash
  if (index < 0) return null
  if (index > 0 && !/\s/.test(before[index - 1] ?? '')) return null
  const marker = before[index]
  const query = before.slice(index + 1)
  if (marker === '@') {
    if (!/^[\p{L}\p{N}._/-]*$/u.test(query)) return null
    return { kind: 'file', query, start: index, end: cursor }
  }
  if (!/^[\p{L}\p{N}._-]*$/u.test(query)) return null
  return { kind: 'slash', query, start: index, end: cursor }
}

function emphasisOverlay(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_)/g)
  return parts.map((part, index) => {
    if (part.length > 4 && (part.startsWith('**') && part.endsWith('**') || part.startsWith('__') && part.endsWith('__'))) {
      const marker = part.slice(0, 2)
      return <span key={index}><span className="qtd-markdown-marker">{marker}</span><strong className="qtd-markdown-strong">{part.slice(2, -2)}</strong><span className="qtd-markdown-marker">{marker}</span></span>
    }
    if (part.length > 2 && (part.startsWith('*') && part.endsWith('*') || part.startsWith('_') && part.endsWith('_'))) {
      const marker = part[0]
      return <span key={index}><span className="qtd-markdown-marker">{marker}</span><em className="qtd-markdown-emphasis">{part.slice(1, -1)}</em><span className="qtd-markdown-marker">{marker}</span></span>
    }
    return <span key={index}>{part}</span>
  })
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)))
  }
  return btoa(binary)
}

function makeSendResult(value: unknown): SendResult | null {
  if (!record(value) || typeof value.id !== 'string' || typeof value.accepted !== 'boolean') return null
  const outcomes = ['observed-cleared', 'unobservable', 'may-not-have-sent', 'refused', 'cancelled']
  if (typeof value.outcome !== 'string' || !outcomes.includes(value.outcome)) return null
  if (value.reason !== undefined && typeof value.reason !== 'string') return null
  return value as unknown as SendResult
}
function composeRecoveredDraft(snapshot: string, remote: string, local: string): string {
  let recovered = remote
  if (snapshot !== '' && recovered !== snapshot && !recovered.startsWith(`${snapshot}\n\n`)) {
    recovered = recovered === '' ? snapshot : `${snapshot}\n\n${recovered}`
  }
  let newer = local
  if (snapshot !== '' && newer.startsWith(snapshot)) newer = newer.slice(snapshot.length).replace(/^\n+/, '')
  if (newer === '' || newer === recovered || recovered.endsWith(`\n\n${newer}`)) return recovered
  if (recovered !== '') {
    for (let separator = newer.indexOf('\n\n'); separator >= 0; separator = newer.indexOf('\n\n', separator + 2)) {
      const shared = newer.slice(0, separator)
      if (shared !== '' && recovered.endsWith(shared)) {
        const suffix = newer.slice(separator + 2)
        return suffix === '' ? recovered : `${recovered}\n\n${suffix}`
      }
    }
  }
  return recovered === '' ? newer : `${recovered}\n\n${newer}`
}

function matchesRecovery(draft: string, snapshot: string): boolean {
  return snapshot !== '' && (draft === snapshot || draft.startsWith(`${snapshot}\n\n`))
}
function validPickerItem(value: unknown): value is PickerItem {
  return record(value) && typeof value.id === 'string' && typeof value.label === 'string' &&
    typeof value.insert === 'string' && (value.kind === 'command' || value.kind === 'skill' || value.kind === 'file') &&
    (value.detail === undefined || typeof value.detail === 'string')
}


function eventError(error: unknown): { code: string | null; acceptedBytes: number | null } {
  if (!record(error)) return { code: null, acceptedBytes: null }
  return {
    code: typeof error.code === 'string' ? error.code : null,
    acceptedBytes: typeof error.acceptedBytes === 'number' ? error.acceptedBytes : null
  }
}

export function Composer({ context, pane, session, registerActions }: Props) {
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const overlayRef = useRef<HTMLPreElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const disposedRef = useRef(false)
  const stateRef = useRef<DockState | null>(null)
  const localDraftRef = useRef('')
  const localVersionRef = useRef(0)
  const syncedVersionRef = useRef(0)
  const dirtyRef = useRef(false)
  const conflictRef = useRef(false)
  const pendingWriteRef = useRef<DraftWrite | null>(null)
  const sendSnapshotsRef = useRef(new Map<string, SendSnapshot>())
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const debounceTimerRef = useRef<number | null>(null)
  const pickerGenerationRef = useRef(0)
  const pickerRef = useRef<PickerState | null>(null)
  const composingRef = useRef(false)
  const historyBrowsingRef = useRef(false)
  const [state, setState] = useState<DockState | null>(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [conflicted, setConflicted] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
  const [picker, setPicker] = useState<PickerState | null>(null)
  const [cursor, setCursor] = useState(0)
  const [answers, setAnswers] = useState<InteractionAnswer>([])
  const [sending, setSending] = useState(false)
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null)
  const [answering, setAnswering] = useState(false)

  pickerRef.current = picker

  const setLocalValue = useCallback((value: string) => {
    localDraftRef.current = value
    setDraft(value)
  }, [])

  const clearDebounce = useCallback(() => {
    if (debounceTimerRef.current !== null) window.clearTimeout(debounceTimerRef.current)
    debounceTimerRef.current = null
  }, [])

  const reconcileState = useCallback((incoming: DockState) => {
    if (incoming.pane !== pane || incoming.session !== session || disposedRef.current) return
    const previous = stateRef.current
    if (previous !== null && incoming.revision < previous.revision) return
    const pendingWrite = pendingWriteRef.current
    const sendSnapshots = [...sendSnapshotsRef.current.values()]
    const isWriteAck = pendingWrite !== null && incoming.revision > pendingWrite.baseRevision && incoming.draft === pendingWrite.text
    const isSendClear = incoming.draft === '' && sendSnapshots.some((snapshot) => incoming.revision > snapshot.baseRevision)
    const isSendRecovery = sendSnapshots.some((snapshot) => incoming.revision > snapshot.baseRevision && matchesRecovery(incoming.draft, snapshot.text))
    if (previous !== null && incoming.revision > previous.revision && dirtyRef.current &&
      !isWriteAck && !isSendClear && !isSendRecovery && incoming.draft !== previous.draft) {
      conflictRef.current = true
      setConflicted(true)
      setError('Draft conflict: a newer revision is stored for this pane. Copy or reconcile the local text before sending.')
    }
    stateRef.current = incoming
    setState(incoming)
    if (!dirtyRef.current && !conflictRef.current && pendingWriteRef.current === null) {
      setLocalValue(incoming.draft)
      syncedVersionRef.current = localVersionRef.current
    }
  }, [pane, session, setLocalValue])

  const refreshState = useCallback(async (): Promise<DockState | null> => {
    try {
      const result = await context.call(`${PLUGIN_METHOD}get`, { pane, session })
      if (!isDockState(result)) throw new Error('Terminal dock returned invalid state.')
      reconcileState(result)
      return result
    } catch (reason) {
      if (!disposedRef.current) setError(errorMessage(reason))
      return null
    }
  }, [context, pane, session, reconcileState])

  const persistCurrent = useCallback(async function persist(): Promise<boolean> {
    const operation = writeQueueRef.current.then(async () => {
      if (conflictRef.current) return false
      const canonical = stateRef.current
      if (canonical === null) return false
      if (!canonical.enabled) return false
      const version = localVersionRef.current
      const text = localDraftRef.current
      if (version === syncedVersionRef.current && text === canonical.draft) {
        dirtyRef.current = false
        setDirty(false)
        return true
      }
      const write: DraftWrite = { baseRevision: canonical.revision, text, version }
      pendingWriteRef.current = write
      try {
        const result = await context.call(`${PLUGIN_METHOD}set`, { pane, revision: write.baseRevision, draft: write.text })
        if (!isDockState(result)) throw new Error('Terminal dock returned invalid state after saving the draft.')
        reconcileState(result)
        pendingWriteRef.current = null
        if (conflictRef.current) {
          dirtyRef.current = true
          setDirty(true)
          return false
        }
        syncedVersionRef.current = version
        if (localVersionRef.current === version) {
          dirtyRef.current = false
          setDirty(false)
          setError(null)
        } else {
          dirtyRef.current = true
          setDirty(true)
        }
        return true
      } catch (reason) {
        pendingWriteRef.current = null
        const conflictState = record(reason) && 'state' in reason && isDockState(reason.state) ? reason.state : null
        if (conflictState !== null) {
          conflictRef.current = true
          setConflicted(true)
          reconcileState(conflictState)
          setError('Draft conflict: a newer revision is stored for this pane. Copy or reconcile the local text before sending.')
        } else {
          const details = eventError(reason)
          const message = errorMessage(reason)
          if (details.code === 'PTY_WRITE_UNCERTAIN' || details.acceptedBytes !== null && details.acceptedBytes > 0) setWarning(UNCERTAINTY_WARNING)
          setError(message)
        }
        return false
      }
    })
    writeQueueRef.current = operation.then(() => undefined, () => undefined)
    const saved = await operation
    if (!saved || conflictRef.current) return saved
    if (syncedVersionRef.current !== localVersionRef.current) return persist()
    return true
  }, [context, pane, reconcileState])

  const schedulePersist = useCallback(() => {
    clearDebounce()
    if (conflictRef.current || stateRef.current === null || disposedRef.current) return
    debounceTimerRef.current = window.setTimeout(() => {
      debounceTimerRef.current = null
      void persistCurrent()
    }, DRAFT_DEBOUNCE_MS)
  }, [clearDebounce, persistCurrent])

  const flushDraft = useCallback(async (): Promise<boolean> => {
    clearDebounce()
    if (conflictRef.current) return false
    if (stateRef.current === null) {
      const refreshed = await refreshState()
      if (refreshed === null) return false
    }
    return persistCurrent()
  }, [clearDebounce, persistCurrent, refreshState])

  useEffect(() => {
    disposedRef.current = false
    const unsubscribe = context.subscribe((event) => {
      const changed = stateFromEvent(event)
      if (changed !== null && changed.pane === pane) reconcileState(changed.state)
      if (statusWasRemoved(event, session)) setAgentStatus(null)
      else {
        const status = statusFromEvent(event, session)
        if (status !== null) setAgentStatus(status)
      }
    })
    const unsubscribeConnection = context.onConnection((connection) => {
      if (connection === 'connected') {
        void refreshState()
        void context.call('quirky.agent-status/get', { session }).then((result) => {
          if (!disposedRef.current) setAgentStatus(statusOf(result, session))
        }).catch(() => {})
      }
    })
    void refreshState().then((loaded) => {
      if (loaded !== null && localVersionRef.current > syncedVersionRef.current) schedulePersist()
    })
    void context.call('quirky.agent-status/get', { session }).then((result) => {
      if (!disposedRef.current) setAgentStatus(statusOf(result, session))
    }).catch(() => {})
    return () => {
      disposedRef.current = true
      clearDebounce()
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, pane, session, clearDebounce, reconcileState, refreshState, schedulePersist])

  useEffect(() => {
    if (state?.question?.id !== undefined) setAnswers([])
  }, [state?.question?.id])

  useEffect(() => {
    const trigger = pickerTrigger(draft, cursor)
    const generation = ++pickerGenerationRef.current
    if (trigger === null) {
      setPicker(null)
      return
    }
    setPicker({ ...trigger, status: 'loading', items: [], selected: 0, truncated: false, error: null })
    let active = true
    context.call(`${PLUGIN_METHOD}pick`, { pane, kind: trigger.kind, query: trigger.query }).then((value) => {
      if (!active || generation !== pickerGenerationRef.current) return
      if (!record(value) || !Array.isArray(value.items)) throw new Error('Picker returned invalid results.')
      const items = value.items.filter(validPickerItem)
      const next: PickerState = {
        ...trigger,
        status: 'ready',
        items,
        selected: 0,
        truncated: value.truncated === true,
        error: null
      }
      pickerRef.current = next
      setPicker(next)
    }).catch((reason: unknown) => {
      if (!active || generation !== pickerGenerationRef.current) return
      const next: PickerState = { ...trigger, status: 'error', items: [], selected: 0, truncated: false, error: errorMessage(reason) }
      pickerRef.current = next
      setPicker(next)
    })
    return () => { active = false }
  }, [context, pane, draft, cursor])

  useLayoutEffect(() => {
    registerActions(pane, {
      focus() { editorRef.current?.focus() },
      flush: flushDraft
    })
    return () => registerActions(pane, null)
  }, [pane, registerActions, flushDraft])

  const changeDraft = useCallback((value: string, caret: number) => {
    localVersionRef.current += 1
    dirtyRef.current = true
    setDirty(true)
    setLocalValue(value)
    setCursor(caret)
    setError(null)
    setWarning(null)
    historyBrowsingRef.current = false
    schedulePersist()
  }, [schedulePersist, setLocalValue])

  const insertPickerItem = useCallback((item: PickerItem) => {
    const current = pickerRef.current
    if (current === null) return
    const value = localDraftRef.current
    const next = value.slice(0, current.start) + item.insert + value.slice(current.end)
    const caret = current.start + item.insert.length
    pickerRef.current = null
    setPicker(null)
    changeDraft(next, caret)
    const editor = editorRef.current
    if (editor !== null) {
      editor.focus()
      editor.setSelectionRange(caret, caret)
    }
  }, [changeDraft])

  const browseHistory = useCallback(async (direction: 'previous' | 'next') => {
    if (!(await flushDraft())) return
    try {
      const result = await context.call(`${PLUGIN_METHOD}history`, { pane, direction })
      if (!record(result) || !isDockState(result.state) || !Array.isArray(result.entries)) throw new Error('History returned invalid state.')
      reconcileState(result.state)
      const nextDraft = result.state.draft
      setLocalValue(nextDraft)
      syncedVersionRef.current = localVersionRef.current
      dirtyRef.current = false
      setDirty(false)
      historyBrowsingRef.current = direction === 'previous' || historyBrowsingRef.current && direction === 'next'
      setError(null)
      const editor = editorRef.current
      if (editor !== null) {
        const caret = direction === 'previous' ? 0 : nextDraft.length
        editor.setSelectionRange(caret, caret)
        setCursor(caret)
      }
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [context, pane, flushDraft, reconcileState, setLocalValue])

  const stop = useCallback(async () => {
    if (stateRef.current?.enabled !== true) return
    try {
      await context.call(`${PLUGIN_METHOD}cancel`, { pane, interrupt: true })
      await refreshState()
      if (dirtyRef.current && !conflictRef.current && !(await flushDraft())) return
      setError(null)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }, [context, pane, flushDraft, refreshState])
  const restoreFailedSend = useCallback((id: string, sentVersion: number) => {
    if (localVersionRef.current === sentVersion || !dirtyRef.current) return
    const snapshot = sendSnapshotsRef.current.get(id)
    if (snapshot === undefined) return
    const recovered = composeRecoveredDraft(snapshot.text, stateRef.current?.draft ?? '', localDraftRef.current)
    if (recovered === localDraftRef.current) return
    conflictRef.current = false
    setConflicted(false)
    localVersionRef.current += 1
    dirtyRef.current = true
    setDirty(true)
    setLocalValue(recovered)
    schedulePersist()
  }, [schedulePersist, setLocalValue])

  const send = useCallback(async () => {
    const current = stateRef.current
    if (current === null || current.question !== null || !current.enabled || !current.supported || current.disabledReason !== null || conflictRef.current) return
    if (localDraftRef.current.trim() === '' && current.attachments.length === 0) return
    setSending(true)
    setError(null)
    setWarning(null)
    let sendId: string | null = null
    let sentVersion: number | null = null
    try {
      if (!(await flushDraft())) return
      const canonical = stateRef.current
      if (canonical === null || canonical.question !== null || !canonical.enabled || !canonical.supported || canonical.disabledReason !== null || conflictRef.current) return
      sentVersion = localVersionRef.current
      sendId = crypto.randomUUID()
      sendSnapshotsRef.current.set(sendId, { baseRevision: canonical.revision, text: canonical.draft })
      const result = makeSendResult(await context.call(`${PLUGIN_METHOD}send`, { pane, id: sendId, revision: canonical.revision }))
      if (result === null) throw new Error('Terminal dock returned an invalid send result.')
      await refreshState()
      if (localVersionRef.current === sentVersion && !dirtyRef.current) setLocalValue(stateRef.current?.draft ?? '')
      const restoresPrompt = result.outcome !== 'observed-cleared' && result.outcome !== 'unobservable'
      if (restoresPrompt && sentVersion !== null) restoreFailedSend(sendId, sentVersion)
      if (result.outcome === 'may-not-have-sent' || result.outcome === 'cancelled' && result.accepted) setWarning(UNCERTAINTY_WARNING)
      else if (result.outcome === 'refused') setError(result.reason ?? 'The terminal refused this send before accepting the prompt.')
      else if (result.outcome === 'unobservable') setWarning('Sent to the terminal; this agent does not provide delivery evidence.')
    } catch (reason) {
      const details = eventError(reason)
      if (details.code === 'PTY_WRITE_UNCERTAIN' || details.acceptedBytes !== null && details.acceptedBytes > 0) setWarning(UNCERTAINTY_WARNING)
      setError(errorMessage(reason))
      await refreshState()
      if (sendId !== null && sentVersion !== null) restoreFailedSend(sendId, sentVersion)
    } finally {
      if (sendId !== null) sendSnapshotsRef.current.delete(sendId)
      setSending(false)
    }
  }, [context, flushDraft, pane, refreshState, restoreFailedSend, setLocalValue])

  const chooseAnswer = (questionIndex: number, value: string, multiple: boolean) => {
    setAnswers((current) => {
      const next = current.map((answers) => [...answers])
      while (next.length <= questionIndex) next.push([])
      next[questionIndex] = multiple
        ? next[questionIndex]!.includes(value) ? next[questionIndex]!.filter((answer) => answer !== value) : [...next[questionIndex]!, value]
        : [value]
      return next
    })
  }

  const answerQuestion = async () => {
    const question = stateRef.current?.question
    if (question === null || question === undefined || !answersComplete(question, answers)) return
    if (stateRef.current?.enabled !== true) return
    setAnswering(true)
    try {
      const result = await context.call(`${PLUGIN_METHOD}interaction`, { pane, request: question.id, action: 'answer', answers })
      if (!isDockState(result)) throw new Error('The question response returned invalid state.')
      reconcileState(result)
      setAnswers([])
      setError(null)
    } catch (reason) {
      setError(errorMessage(reason))
    } finally {
      setAnswering(false)
    }
  }

  const interact = async (question: DockQuestion, action: 'collapse' | 'expand' | 'dismiss') => {
    try {
      if (stateRef.current?.enabled !== true) return
      const result = await context.call(`${PLUGIN_METHOD}interaction`, { pane, request: question.id, action })
      if (!isDockState(result)) throw new Error('The question action returned invalid state.')
      reconcileState(result)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const optionChange = async (kind: 'model' | 'effort' | 'permission', event: ChangeEvent<HTMLSelectElement>) => {
    const value = event.currentTarget.value
    if (stateRef.current?.enabled !== true) return
    if (value === '') return
    try {
      const result = await context.call(`${PLUGIN_METHOD}options`, { pane, kind, value })
      if (!isDockState(result)) throw new Error('The session option action returned invalid state.')
      reconcileState(result)
      setError(null)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  const uploadFiles = useCallback(async (files: File[]) => {
    if (stateRef.current?.enabled !== true) {
      setError('Terminal dock is disabled.')
      return
    }
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        setError(`${file.name} is larger than the 10 MiB attachment limit.`)
        continue
      }
      try {
        const bytes = new Uint8Array(await file.arrayBuffer())
        const result = await context.call(`${PLUGIN_METHOD}attach`, {
          pane,
          name: file.name,
          mime: file.type || 'application/octet-stream',
          base64: encodeBase64(bytes)
        })
        if (!isDockState(result)) throw new Error('Attachment acquisition returned invalid state.')
        reconcileState(result)
        setError(null)
      } catch (reason) {
        setError(`Could not attach ${file.name}: ${errorMessage(reason)}`)
      }
    }
  }, [context, pane, reconcileState])

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (files.length > 0) void uploadFiles(files)
  }

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(event.clipboardData.files)
    if (files.length === 0) return
    event.preventDefault()
    void uploadFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = Array.from(event.dataTransfer.files)
    if (files.length === 0) return
    event.preventDefault()
    void uploadFiles(files)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    const currentPicker = pickerRef.current
    if (currentPicker !== null) {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        pickerRef.current = null
        setPicker(null)
        return
      }
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        event.stopPropagation()
        if (currentPicker.status === 'ready' && currentPicker.items.length > 0) {
          const offset = event.key === 'ArrowDown' ? 1 : -1
          const selected = (currentPicker.selected + offset + currentPicker.items.length) % currentPicker.items.length
          const next = { ...currentPicker, selected }
          pickerRef.current = next
          setPicker(next)
        }
        return
      }
      if (event.key === 'Enter' && !event.shiftKey) {
        if (event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
        event.preventDefault()
        event.stopPropagation()
        if (currentPicker.status === 'ready' && currentPicker.items.length > 0) insertPickerItem(currentPicker.items[currentPicker.selected]!)
        return
      }
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      void stop()
      return
    }
    if (event.key === 'Enter') {
      event.stopPropagation()
      if (event.shiftKey || event.nativeEvent.isComposing || composingRef.current || event.keyCode === 229) return
      event.preventDefault()
      if (stateRef.current !== null && (localDraftRef.current.trim() !== '' || stateRef.current.attachments.length > 0)) void send()
      return
    }
    if (event.key === 'ArrowUp') {
      const field = event.currentTarget
      const atFirstLine = field.selectionStart === 0 || !field.value.slice(0, field.selectionStart).includes('\n')
      if (atFirstLine && (field.value === '' || field.selectionStart === 0 || historyBrowsingRef.current)) {
        event.preventDefault()
        event.stopPropagation()
        void browseHistory('previous')
        return
      }
    }
    if (event.key === 'ArrowDown' && historyBrowsingRef.current) {
      event.preventDefault()
      event.stopPropagation()
      void browseHistory('next')
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey) event.stopPropagation()
  }

  const onCompositionStart = () => { composingRef.current = true }
  const onCompositionEnd = () => { composingRef.current = false }
  const onSelection = (event: SyntheticEvent<HTMLTextAreaElement>) => setCursor(event.currentTarget.selectionStart)
  const onDraftChange = (event: ChangeEvent<HTMLTextAreaElement>) => changeDraft(event.currentTarget.value, event.currentTarget.selectionStart)
  const onScroll = (event: UIEvent<HTMLTextAreaElement>) => {
    const overlay = overlayRef.current
    if (overlay === null) return
    overlay.scrollTop = event.currentTarget.scrollTop
    overlay.scrollLeft = event.currentTarget.scrollLeft
  }

  const activeQuestion = state?.question ?? null
  const unresolvedQuestion = activeQuestion !== null
  const isWorking = agentStatus?.state === 'working'
  const hasPendingSend = state?.activeSend !== null && state?.activeSend !== undefined || (state?.queuedSends.length ?? 0) > 0 || sending
  const shouldStop = hasPendingSend || isWorking
  const disabledReason = state === null ? 'Connecting to terminal dock' : state.disabledReason ?? (!state.enabled ? 'Terminal dock is disabled' : !state.supported ? 'This terminal agent is not supported' : null)
  const sendDisabled = !shouldStop && (state === null || !state.enabled || !state.supported || disabledReason !== null || unresolvedQuestion || conflicted || (localDraftRef.current.trim() === '' && (state.attachments?.length ?? 0) === 0))
  const contextUsage = state?.options.context ?? null
  const contextPercent = contextUsage !== null && contextUsage.limit > 0 ? Math.min(100, Math.max(0, Math.round((contextUsage.used / contextUsage.limit) * 100))) : null
  const contextStyle = contextPercent === null ? undefined : { '--qtd-context-used': `${contextPercent}%` } as CSSProperties

  return (
    <div className={`qtd-composer${state?.passthrough ? ' qtd-passthrough' : ''}`} onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) event.preventDefault() }} onDrop={onDrop}>
      {state?.passthrough && <div className="qtd-notice qtd-passthrough-notice" role="status">Passthrough active — terminal has keyboard focus</div>}
      {disabledReason !== null && state !== null && !shouldStop && <div className="qtd-notice" role="status">{disabledReason}</div>}
      {state?.notice && <div className="qtd-notice" role="status">{state.notice}</div>}
      {state?.options.notice && <div className="qtd-notice" role="status">{state.options.notice}</div>}
      {warning !== null && <div className="qtd-notice qtd-warning" role="alert">{warning}</div>}
      {error !== null && <div className="qtd-notice qtd-error" role="alert">{error}</div>}
      {activeQuestion !== null && !activeQuestion.dismissed && (
        <QuestionCard
          question={activeQuestion}
          answers={answers}
          answering={answering}
          disabled={state?.enabled !== true}
          onAnswer={chooseAnswer}
          onSubmit={() => void answerQuestion()}
          onInteract={(action) => void interact(activeQuestion, action)}
        />
      )}
      <div className="qtd-editor-region">
        <pre ref={overlayRef} className="qtd-editor-overlay" aria-hidden="true">{draft.length === 0 ? '\u200b' : emphasisOverlay(draft)}</pre>
        <textarea
          ref={editorRef}
          className="qtd-editor"
          aria-label="Message to agent"
          aria-describedby={disabledReason !== null && state !== null ? 'qtd-disabled-reason' : undefined}
          placeholder="Ask anything, @ to mention files, / for commands"
          value={draft}
          rows={3}
          onChange={onDraftChange}
          onSelect={onSelection}
          onScroll={onScroll}
          onKeyDown={onKeyDown}
          onCompositionStart={onCompositionStart}
          onCompositionEnd={onCompositionEnd}
          onPaste={onPaste}
          spellCheck={false}
          data-unsynchronized={dirty ? 'true' : 'false'}
          data-conflicted={conflicted ? 'true' : 'false'}
        />
      </div>
      {picker !== null && <PickerMenu picker={picker} onChoose={insertPickerItem} onSelect={(selected) => {
        const next = { ...picker, selected }
        pickerRef.current = next
        setPicker(next)
      }} />}
      <div className="qtd-attachments" role="list" aria-label="Attachments">
        {state === null ? null : state.attachments.map((attachment) => (
          <AttachmentChip key={attachment.id} attachment={attachment} disabled={!state.enabled} onRemove={() => {
            if (state.enabled !== true) return
            void context.call(`${PLUGIN_METHOD}removeAttachment`, { pane, attachment: attachment.id }).then((result) => {
              if (!isDockState(result)) throw new Error('Attachment removal returned invalid state.')
              reconcileState(result)
            }).catch((reason: unknown) => setError(errorMessage(reason)))
          }} />
        ))}
      </div>
      <div className="qtd-toolbar">
        <div className="qtd-control-group" role="group" aria-label="Session options">
          <SessionOption state={state} kind="model" onChange={optionChange} />
          <SessionOption state={state} kind="effort" onChange={optionChange} />
          <SessionOption state={state} kind="permission" onChange={optionChange} />
        </div>
        <div className="qtd-context" aria-label="Context usage">
          {contextPercent === null ? <span>Context usage unknown</span> : (
            <span className="qtd-context__ring" role="progressbar" aria-label="Context usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={contextPercent} style={contextStyle}>
              {contextPercent}%
            </span>
          )}
        </div>
      </div>
      <div className="qtd-actions">
        <input ref={fileRef} className="qtd-file-input" type="file" multiple aria-label="Attach files" disabled={state === null || !state.enabled} onChange={onFileChange} />
        <button type="button" className="qtd-attach" aria-label="Attach file" disabled={state === null || !state.enabled} onClick={() => fileRef.current?.click()}>Attach</button>
        <span className="qtd-actions-spacer" />
        {dirty && <span className="qtd-draft-status" role="status">{conflicted ? 'Draft conflict' : 'Saving draft…'}</span>}
        {state?.activeSend !== null && state?.activeSend !== undefined && <span className="qtd-send-phase" role="status">{state.activeSend.phase}</span>}
        {disabledReason !== null && state !== null && <span id="qtd-disabled-reason" className="qtd-disabled-reason">{disabledReason}</span>}
        <button type="button" className="qtd-send" aria-label={shouldStop ? 'Stop' : 'Send'} disabled={state === null || !state.enabled || !shouldStop && sendDisabled} onClick={() => shouldStop ? void stop() : void send()}>{shouldStop ? 'Stop' : 'Send'}</button>
      </div>
    </div>
  )
}

function answersComplete(question: DockQuestion, answers: InteractionAnswer): boolean {
  if (question.questions.length === 0) return false
  return question.questions.every((item, index) => (answers[index]?.length ?? 0) > 0)
}

function QuestionCard({ question, answers, answering, disabled, onAnswer, onSubmit, onInteract }: {
  question: DockQuestion
  answers: InteractionAnswer
  answering: boolean
  disabled: boolean
  onAnswer(index: number, value: string, multiple: boolean): void
  onSubmit(): void
  onInteract(action: 'collapse' | 'expand' | 'dismiss'): void
}) {
  const collapsed = question.collapsed
  return (
    <section className={`qtd-question-card${collapsed ? ' qtd-question-card__collapsed' : ''}`} role="region" aria-label={question.kind === 'permission' ? 'Pending permission' : 'Pending question'}>
      <header className="qtd-question-card__header">
        <div><strong>{question.title}</strong><span className="qtd-question-kind">{question.kind === 'permission' ? 'Permission request' : 'Agent question'}</span></div>
        <button type="button" aria-label={collapsed ? 'Expand question' : 'Collapse question'} disabled={disabled} onClick={() => onInteract(collapsed ? 'expand' : 'collapse')}>{collapsed ? 'Expand question' : 'Collapse question'}</button>
        <button type="button" aria-label="Dismiss question" disabled={disabled} onClick={() => onInteract('dismiss')}>Dismiss</button>
      </header>
      {!collapsed && <div className="qtd-question-card__content">
        {question.questions.map((item, questionIndex) => (
          <fieldset key={`${question.id}-${questionIndex}`} className="qtd-question-prompt">
            <legend>{item.prompt}</legend>
            {item.choices.length > 0 ? item.choices.map((choice) => {
              const checked = answers[questionIndex]?.includes(choice.value) ?? false
              return <label key={choice.value} className="qtd-question-choice">
                <input
                  type={item.multiple ? 'checkbox' : 'radio'}
                  name={`qtd-${question.id}-${questionIndex}`}
                  aria-label={choice.label}
                  checked={checked}
                  disabled={disabled}
                  onChange={() => onAnswer(questionIndex, choice.value, item.multiple)}
                />
                <span>{choice.label}</span>
              </label>
            }) : question.kind === 'question' ? (
              <textarea aria-label={item.prompt} disabled={disabled} value={answers[questionIndex]?.[0] ?? ''} onChange={(event) => onAnswer(questionIndex, event.currentTarget.value, false)} />
            ) : <p>A permission answer is unavailable because the agent supplied no safe choices.</p>}
          </fieldset>
        ))}
        <button type="button" className="qtd-question-submit" disabled={disabled || answering || !answersComplete(question, answers)} onClick={onSubmit}>{answering ? 'Answering…' : 'Submit answer'}</button>
      </div>}
    </section>
  )
}

function PickerMenu({ picker, onChoose, onSelect }: { picker: PickerState; onChoose(item: PickerItem): void; onSelect(index: number): void }) {
  const label = picker.kind === 'slash' ? 'Slash commands and skills' : 'Workspace files'
  return (
    <div className="qtd-picker" role="listbox" aria-label={label} aria-busy={picker.status === 'loading'}>
      {picker.status === 'loading' && <div className="qtd-picker__state" role="status">Loading {picker.kind === 'slash' ? 'commands and skills' : 'workspace files'}…</div>}
      {picker.status === 'error' && <div className="qtd-picker__state" role="alert">Could not load {picker.kind === 'slash' ? 'commands and skills' : 'workspace files'}: {picker.error}</div>}
      {picker.status === 'ready' && picker.items.length === 0 && <div className="qtd-picker__state" role="status">{picker.kind === 'slash' ? 'No commands or skills found.' : 'No matching workspace files.'}</div>}
      {picker.status === 'ready' && picker.items.map((item, index) => (
        <button key={item.id} type="button" role="option" aria-selected={index === picker.selected} className={`qtd-picker__item${index === picker.selected ? ' qtd-picker__item--active' : ''}`} onMouseEnter={() => onSelect(index)} onClick={() => onChoose(item)}>
          <span>{item.label}</span>{item.detail && <small>{item.detail}</small>}
        </button>
      ))}
      {picker.status === 'ready' && picker.truncated && <div className="qtd-picker__state">More results are available; refine the query.</div>}
    </div>
  )
}

function AttachmentChip({ attachment, disabled, onRemove }: { attachment: DockAttachment; disabled: boolean; onRemove(): void }) {
  return (
    <span className="qtd-attachments__chip" title={attachment.path} role="listitem">
      <span aria-hidden="true">{attachment.image ? 'Image' : 'File'}</span>
      <span>{attachment.name}</span>
      <button type="button" className="qtd-attachments__remove" aria-label={`Remove ${attachment.name}`} disabled={disabled} onClick={onRemove}>Remove</button>
    </span>
  )
}

function SessionOption({ state, kind, onChange }: {
  state: DockState | null
  kind: 'model' | 'effort' | 'permission'
  onChange(kind: 'model' | 'effort' | 'permission', event: ChangeEvent<HTMLSelectElement>): void
}) {
  const labels = { model: 'Model', effort: 'Effort', permission: 'Permission' }
  const current = state?.options[kind] ?? ''
  const choices = state?.options.choices[kind] ?? []
  const disabled = state === null || !state.enabled || !state.supported || choices.length === 0
  return (
    <label className="qtd-control-option">
      <span>{labels[kind]}</span>
      <select aria-label={labels[kind]} value={current} disabled={disabled} onChange={(event) => onChange(kind, event)}>
        {current === '' && <option value="">Not reported</option>}
        {choices.length === 0 && <option value="">No session-specific {labels[kind].toLowerCase()} choices available</option>}
        {choices.map((choice) => <option key={choice} value={choice}>{choice}</option>)}
      </select>
      {choices.length === 0 && <small>{labels[kind]} control unavailable for this session.</small>}
    </label>
  )
}
