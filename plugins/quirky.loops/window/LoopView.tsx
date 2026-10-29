import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { QuirkyEvent, StructuredMessage, UiPluginContext } from '@quirky/protocol'
import type { IterationDetail, LoopConfig, LoopConfigPatch, LoopSnapshot, PauseReason, QueueItem, QueueOperation } from '../src/types'
import { ConfigFields, draftFromLoop, validateDraft } from './config-form'
import type { DraftValidation, LoopDraft, LoopViewProps, SurfaceHandle } from './contracts'
import { LoopIterationDetail, formatDuration, iterationCheckLabel } from './LoopIterationDetail'
import { LoopQueueEditor, type QueueEditorCommand, type QueueEditorState } from './LoopQueueEditor'
import { Badge, Button, Dialog, EmptyState, SectionHeader, TextArea, TextField, ToolPanelFrame } from '@quirky/ui'

type LoopState = LoopSnapshot['state']
type EditPatch = LoopConfigPatch & { name?: string }
type ParsedArgs = Record<string, unknown>

type EditValidation = DraftValidation

const PAUSE_LABELS: Record<PauseReason, string> = {
  user: 'Paused by you',
  'cap-iterations': 'Iteration cap reached',
  'cap-time': 'Time cap reached',
  'cap-cost': 'Cost cap reached',
  'no-progress': 'No progress in recent iterations',
  'protected-path': 'Touched a protected path',
  'agent-blocked': 'The agent is blocked',
  'agent-decide': 'The agent needs a decision',
  crashed: 'The agent kept crashing',
  'usage-limit': 'Agent usage limit reached',
  'interrupted-by-restart': 'Interrupted by an app restart',
  unverifiable: 'Lost contact with the agent host',
  'ask-before-next': 'Waiting for your go-ahead',
  'queue-exhausted': 'The queue is empty'
}

const STATE_LABELS: Record<LoopState, string> = {
  running: 'Running',
  'needs-you': 'Needs you',
  paused: 'Paused',
  completed: 'Completed',
  stopped: 'Stopped'
}

const PHASE_LABELS: Record<NonNullable<LoopSnapshot['phase']>, string> = {
  waiting: 'Waiting for the next iteration',
  sending: 'Sending the iteration prompt',
  relaunching: 'Starting a structured session',
  working: 'Agent working',
  checking: 'Running the completion check',
  evaluating: 'Evaluating completion'
}

const LOOP_STATES: string[] = ['running', 'needs-you', 'paused', 'completed', 'stopped']
const PAUSE_REASONS: string[] = [
  'user', 'cap-iterations', 'cap-time', 'cap-cost', 'no-progress', 'protected-path', 'agent-blocked', 'agent-decide',
  'crashed', 'usage-limit', 'interrupted-by-restart', 'unverifiable', 'ask-before-next', 'queue-exhausted'
]
const ITERATION_ENDS = ['settled', 'crashed', 'interrupted', 'stopped', 'unverifiable']
const MESSAGE_ROLES = ['user', 'assistant', 'tool', 'system', 'result']
const EDITABLE_FIELDS = [
  'name', 'prompt', 'repeatQueue', 'pacingKind', 'intervalMinutes', 'anchor', 'sessionPolicy', 'maxIterations', 'checkCommand',
  'checkTimeout', 'checkWhen', 'evaluatorCondition', 'maxActiveMinutes', 'maxCostUsd', 'protectedPaths', 'noProgress',
  'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset', 'advanced'
]
const STRING_FIELDS = [
  'name', 'prompt', 'pacingKind', 'intervalMinutes', 'maxIterations', 'checkCommand', 'checkTimeout', 'evaluatorCondition',
  'maxActiveMinutes', 'maxCostUsd', 'protectedPaths'
]
const BOOLEAN_FIELDS = ['repeatQueue', 'noProgress', 'checkpointCommits', 'askBeforeNext', 'resumeAtLimitReset', 'advanced']

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function isNullableNumber(value: unknown): value is number | null {
  return value === null || isFiniteNumber(value)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isLoopConfig(value: unknown): value is LoopConfig {
  if (!isRecord(value) || !isRecord(value.promptSource) || !isRecord(value.pacing) || !isRecord(value.done) || !isRecord(value.caps)) return false
  const source = value.promptSource
  const validSource = source.kind === 'repeat'
    ? typeof source.body === 'string'
    : source.kind === 'queue' && typeof source.repeatQueue === 'boolean'
  const pacing = value.pacing
  const validPacing = pacing.kind === 'on-idle' || (
    pacing.kind === 'interval' && isFiniteNumber(pacing.minutes) &&
    (pacing.anchor === 'from-end' || pacing.anchor === 'wall-clock')
  )
  const check = value.done.check
  const evaluator = value.done.evaluator
  const validCheck = check === undefined || (
    isRecord(check) && typeof check.command === 'string' && isFiniteNumber(check.timeoutSeconds) &&
    (check.runWhen === 'every-iteration' || check.runWhen === 'on-claim')
  )
  const validEvaluator = evaluator === undefined || (isRecord(evaluator) && typeof evaluator.condition === 'string')
  const caps = value.caps
  const validCaps = ['maxIterations', 'maxActiveMinutes'].every((key) => caps[key] === undefined || (isFiniteNumber(caps[key]) && caps[key] >= 1)) &&
    (caps.maxCostUsd === undefined || (isFiniteNumber(caps.maxCostUsd) && caps.maxCostUsd > 0))
  return validSource && validPacing &&
    (value.sessionPolicy === 'fresh' || value.sessionPolicy === 'continue') && validCheck && validEvaluator && validCaps &&
    typeof value.noProgress === 'boolean' && typeof value.checkpointCommits === 'boolean' &&
    typeof value.askBeforeNext === 'boolean' && typeof value.resumeAtLimitReset === 'boolean' &&
    (value.protectedPaths === undefined || isStringArray(value.protectedPaths))
}

function isCheck(value: unknown): boolean {
  if (value === null) return true
  return isRecord(value) && typeof value.ran === 'boolean' && typeof value.pass === 'boolean' &&
    (value.exitCode === null || isFiniteNumber(value.exitCode)) && typeof value.timedOut === 'boolean' &&
    typeof value.stdoutTail === 'string' && typeof value.stderrTail === 'string' && isFiniteNumber(value.durationMs) &&
    (value.error === undefined || typeof value.error === 'string')
}

function isUsageLimit(value: unknown): boolean {
  return value === null || (
    isRecord(value) && typeof value.provider === 'string' &&
    (value.resetsAt === null || isFiniteNumber(value.resetsAt))
  )
}

function isIterationDetail(value: unknown): value is IterationDetail {
  if (!isRecord(value) || typeof value.loopId !== 'string' || !Number.isInteger(value.n) || !Number.isInteger(value.attempt) ||
      (typeof value.sessionId !== 'string' && value.sessionId !== null) || typeof value.promptSent !== 'string' ||
      !isFiniteNumber(value.startedAt) || !isNullableNumber(value.endedAt) ||
      (value.endReason !== null && !ITERATION_ENDS.includes(String(value.endReason))) || !isRecord(value.doneConfig) ||
      !isCheck(value.check) || !isRecord(value.markers) || typeof value.markers.done !== 'boolean' ||
      !isNullableNumber(value.costUsd) || !isUsageLimit(value.usageLimit) ||
      typeof value.outputTail !== 'string' || (value.error !== undefined && typeof value.error !== 'string')) return false
  if (value.evaluator !== null && (!isRecord(value.evaluator) || (value.evaluator.verdict !== 'met' && value.evaluator.verdict !== 'not-met') || typeof value.evaluator.reason !== 'string')) return false
  if (value.diff !== null && (!isRecord(value.diff) || !Number.isInteger(value.diff.added) || !Number.isInteger(value.diff.removed) || !isStringArray(value.diff.files))) return false
  if (value.markers.blocked !== undefined && typeof value.markers.blocked !== 'string') return false
  if (value.markers.decide !== undefined && typeof value.markers.decide !== 'string') return false
  if (value.treeBefore !== null && typeof value.treeBefore !== 'string') return false
  if (value.treeAfter !== null && typeof value.treeAfter !== 'string') return false
  return isStringArray(value.protectedPathHits) && (value.checkpointCommit === null || typeof value.checkpointCommit === 'string')
}

function isQueueItem(value: unknown): value is QueueItem {
  return isRecord(value) && typeof value.id === 'string' && Number.isInteger(value.position) && typeof value.body === 'string' &&
    (value.state === 'pending' || value.state === 'in-flight' || value.state === 'done')
}

function isLoopSnapshot(value: unknown, loopId: string): value is LoopSnapshot {
  if (!isRecord(value) || value.id !== loopId || typeof value.name !== 'string' || typeof value.slug !== 'string' ||
      typeof value.worktreeId !== 'string' || typeof value.cwd !== 'string' ||
      (value.workspaceKind !== 'git' && value.workspaceKind !== 'folder') ||
      (value.agent !== 'claude' && value.agent !== 'codex') ||
      (value.preset !== 'until-done' && value.preset !== 'interval' && value.preset !== 'queue') || !isLoopConfig(value.config) ||
      !LOOP_STATES.includes(String(value.state)) ||
      (value.pauseReason !== null && !PAUSE_REASONS.includes(String(value.pauseReason))) ||
      (value.pauseDetail !== null && typeof value.pauseDetail !== 'string') ||
      (value.sessionId !== null && typeof value.sessionId !== 'string') || !Number.isInteger(value.iterationsCompleted) ||
      !isFiniteNumber(value.activeMs) || !isNullableNumber(value.costUsd) ||
      (value.phase !== null && !['waiting', 'sending', 'relaunching', 'working', 'checking', 'evaluating'].includes(String(value.phase))) ||
      !isNullableNumber(value.nextIterationAt) || !isFiniteNumber(value.createdAt) || !isFiniteNumber(value.updatedAt) ||
      !isNullableNumber(value.endedAt) || typeof value.notesPath !== 'string' || !isStringArray(value.warnings) ||
      !Array.isArray(value.recentIterations) || !value.recentIterations.every(isIterationDetail) ||
      !Array.isArray(value.queueItems) || !value.queueItems.every(isQueueItem) || !Number.isInteger(value.skippedTicks)) return false
  return true
}

function isStructuredMessage(value: unknown): value is StructuredMessage {
  return isRecord(value) && typeof value.sessionId === 'string' && Number.isInteger(value.seq) &&
    MESSAGE_ROLES.includes(String(value.role)) && typeof value.text === 'string' && isFiniteNumber(value.at)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) return error.message
  return typeof error === 'string' && error.length > 0 ? error : 'The request failed.'
}

function exactArgs(value: unknown, allowed: readonly string[], required: readonly string[] = []): ParsedArgs {
  if (!isRecord(value)) throw new Error('Action parameters must be an object.')
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`Unsupported action parameter: ${key}`)
  }
  for (const key of required) {
    if (!(key in value)) throw new Error(`Missing action parameter: ${key}`)
  }
  return value
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function editPatchFromDraft(base: LoopSnapshot, latest: LoopSnapshot, draft: LoopDraft, next: LoopConfig): EditPatch {
  const patch: EditPatch = {}
  if (draft.name.trim() !== base.name) patch.name = draft.name.trim()
  if (!sameValue(base.config.promptSource, next.promptSource)) patch.promptSource = next.promptSource
  if (!sameValue(base.config.pacing, next.pacing)) patch.pacing = next.pacing
  if (base.config.sessionPolicy !== next.sessionPolicy) patch.sessionPolicy = next.sessionPolicy

  const done: LoopConfig['done'] = { ...latest.config.done }
  let doneChanged = false
  if (!sameValue(base.config.done.check, next.done.check)) {
    doneChanged = true
    if (next.done.check === undefined) delete done.check
    else done.check = next.done.check
  }
  if (!sameValue(base.config.done.evaluator, next.done.evaluator)) {
    doneChanged = true
    if (next.done.evaluator === undefined) delete done.evaluator
    else done.evaluator = next.done.evaluator
  }
  if (doneChanged) patch.done = done

  const caps: LoopConfig['caps'] = { ...latest.config.caps }
  let capsChanged = false
  for (const key of ['maxIterations', 'maxActiveMinutes', 'maxCostUsd'] as const) {
    if (base.config.caps[key] === next.caps[key]) continue
    capsChanged = true
    const value = next.caps[key]
    if (value === undefined) delete caps[key]
    else caps[key] = value
  }
  if (capsChanged) patch.caps = caps

  if (base.config.noProgress !== next.noProgress) patch.noProgress = next.noProgress
  if (!sameValue(base.config.protectedPaths ?? [], next.protectedPaths ?? [])) patch.protectedPaths = next.protectedPaths ?? []
  if (base.config.checkpointCommits !== next.checkpointCommits) patch.checkpointCommits = next.checkpointCommits
  if (base.config.askBeforeNext !== next.askBeforeNext) patch.askBeforeNext = next.askBeforeNext
  if (base.config.resumeAtLimitReset !== next.resumeAtLimitReset) patch.resumeAtLimitReset = next.resumeAtLimitReset
  return patch
}

function stateEnded(loop: LoopSnapshot): boolean {
  return loop.state === 'completed' || loop.state === 'stopped'
}

function usesSavedOutput(loop: LoopSnapshot): boolean {
  return stateEnded(loop) || (loop.state === 'paused' && loop.config.sessionPolicy === 'fresh')
}

function savedIterationOutput(loop: LoopSnapshot, records: readonly IterationDetail[]): IterationDetail | null {
  for (let index = records.length - 1; index >= 0; index--) {
    const detail = records[index]!
    if (detail.loopId === loop.id && detail.endedAt !== null &&
        (loop.sessionId === null || detail.sessionId === loop.sessionId)) return detail
  }
  return null
}

function timeLabel(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'Unavailable'
  return new Date(value).toLocaleString()
}
function lastCheckLabel(detail: IterationDetail | null): string {
  if (detail === null) return 'No checks recorded'
  if (detail.check === null || !detail.check.ran) return `No check in iteration ${detail.n}`
  return `${detail.check.pass ? 'Passed' : 'Failed'} in iteration ${detail.n}`
}

function costLabel(value: number): string {
  return `$${value.toFixed(2)}`
}

function moneyCap(loop: LoopSnapshot): string | null {
  const cap = loop.config.caps.maxCostUsd
  return cap !== undefined && Number.isFinite(cap) ? costLabel(cap) : null
}

function isPausedCap(loop: LoopSnapshot): boolean {
  return loop.state === 'paused' && loop.pauseReason === 'cap-iterations'
}

function detailList(history: readonly IterationDetail[]): IterationDetail[] {
  return history.filter((detail) => detail.endedAt !== null).slice().sort((left, right) => {
    const time = left.startedAt - right.startedAt
    return time === 0 ? (left.n - right.n || left.attempt - right.attempt) : time
  })
}

function prettyData(data: unknown): string | null {
  if (data === undefined) return null
  try {
    const value = JSON.stringify(data, null, 2)
    return value === undefined ? null : value
  } catch {
    return null
  }
}

export function LoopView({ context, loopId, onHandle, report }: LoopViewProps) {
  const [loop, setLoop] = useState<LoopSnapshot | null>(null)
  const [history, setHistory] = useState<IterationDetail[]>([])
  const [messages, setMessages] = useState<StructuredMessage[]>([])
  const [messageLoading, setMessageLoading] = useState(true)
  const [loading, setLoading] = useState(true)
  const [unverifiable, setUnverifiable] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'reconnecting'>('connected')
  const [viewError, setViewError] = useState<string | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [messageError, setMessageError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [stopOpen, setStopOpen] = useState(false)
  const [steerOpen, setSteerOpen] = useState(false)
  const [steerDraft, setSteerDraft] = useState('')
  const [editDraft, setEditDraft] = useState<LoopDraft | null>(null)
  const [editBase, setEditBase] = useState<LoopSnapshot | null>(null)
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const [resumeAdd, setResumeAdd] = useState('5')
  const [selectedDetail, setSelectedDetail] = useState<IterationDetail | null>(null)
  const [queueState, setQueueState] = useState<QueueEditorState>({ addDraft: '', editingId: null, editingBody: '' })

  const loopRef = useRef<LoopSnapshot | null>(null)
  const busyRef = useRef<string | null>(null)
  const aliveRef = useRef(false)
  const viewGeneration = useRef(0)
  const refreshSequence = useRef(0)
  const historySequence = useRef(0)
  const messageSequence = useRef(0)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const loadMessagesRef = useRef<(sessionId: string | null, generation: number) => Promise<void>>(async () => {})
  const dispatchRef = useRef<SurfaceHandle['dispatch']>(async () => { throw new Error('Loop surface is unavailable.') })
  const surfaceStateRef = useRef<Record<string, unknown>>({})

  const setCurrentLoop = useCallback((value: LoopSnapshot) => {
    loopRef.current = value
    setLoop(value)
  }, [])

  const loadMessages = useCallback(async (sessionId: string | null, generation: number) => {
    const sequence = ++messageSequence.current
    const current = loopRef.current
    if (sessionId === null || (current !== null && usesSavedOutput(current))) {
      if (aliveRef.current && generation === viewGeneration.current) {
        setMessages([])
        setMessageError(null)
        setMessageLoading(false)
      }
      return
    }
    if (aliveRef.current && generation === viewGeneration.current) {
      setMessageLoading(true)
      setMessageError(null)
    }
    try {
      const response = await context.call('quirky.structured/messages', { session: sessionId, limit: 100, tail: true })
      if (!aliveRef.current || generation !== viewGeneration.current || sequence !== messageSequence.current || loopRef.current?.sessionId !== sessionId) return
      if (!Array.isArray(response) || !response.every(isStructuredMessage)) throw new Error('The structured journal returned invalid message data.')
      setMessages(response)
      setMessageError(null)
    } catch (error) {
      if (!aliveRef.current || generation !== viewGeneration.current || sequence !== messageSequence.current || loopRef.current?.sessionId !== sessionId) return
      setMessageError(errorMessage(error))
    } finally {
      if (aliveRef.current && generation === viewGeneration.current && sequence === messageSequence.current) setMessageLoading(false)
    }
  }, [context])
  loadMessagesRef.current = loadMessages

  const refresh = useCallback(async () => {
    const generation = viewGeneration.current
    const sequence = ++refreshSequence.current
    if (!aliveRef.current) return

    let response: unknown
    try {
      response = await context.call('quirky.loops/get', { loopId })
    } catch (error) {
      if (!aliveRef.current || generation !== viewGeneration.current || sequence !== refreshSequence.current) return
      setUnverifiable(true)
      setViewError(errorMessage(error))
      setLoading(false)
      return
    }
    if (!aliveRef.current || generation !== viewGeneration.current || sequence !== refreshSequence.current) return
    if (!isLoopSnapshot(response, loopId)) {
      setUnverifiable(true)
      setViewError('The loop service returned an unverifiable snapshot.')
      setLoading(false)
      return
    }

    const previousSession = loopRef.current?.sessionId
    setCurrentLoop(response)
    setUnverifiable(false)
    setConnectionStatus('connected')
    setViewError(null)
    setHistoryError(null)
    setLoading(false)
    if (previousSession !== response.sessionId) {
      setMessages([])
      setMessageLoading(true)
    }

    const historyRequest = ++historySequence.current
    try {
      const historyResponse = await context.call('quirky.loops/iterations', { loopId })
      if (!aliveRef.current || generation !== viewGeneration.current || sequence !== refreshSequence.current || historyRequest !== historySequence.current) return
      if (!Array.isArray(historyResponse) || !historyResponse.every(isIterationDetail)) throw new Error('The loop service returned invalid iteration history.')
      setHistory(historyResponse)
      setHistoryError(null)
    } catch (error) {
      if (!aliveRef.current || generation !== viewGeneration.current || sequence !== refreshSequence.current || historyRequest !== historySequence.current) return
      setHistoryError(errorMessage(error))
    }
    if (aliveRef.current && generation === viewGeneration.current && sequence === refreshSequence.current) {
      await loadMessagesRef.current(response.sessionId, generation)
    }
  }, [context, loopId, setCurrentLoop])
  refreshRef.current = refresh


  useEffect(() => {
    const generation = ++viewGeneration.current
    aliveRef.current = true
    busyRef.current = null
    setBusy(null)
    setLoop(null)
    loopRef.current = null
    setHistory([])
    setMessages([])
    setLoading(true)
    setUnverifiable(false)
    setConnectionStatus('connected')
    setViewError(null)
    setHistoryError(null)
    setMessageError(null)
    setActionError(null)
    setStopOpen(false)
    setSteerOpen(false)
    setSteerDraft('')
    setEditDraft(null)
    setEditBase(null)
    setEditErrors({})
    setResumeAdd('5')
    setSelectedDetail(null)
    setQueueState({ addDraft: '', editingId: null, editingBody: '' })
    setMessageLoading(true)

    const unsubscribe = context.subscribe((event: QuirkyEvent) => {
      if (!aliveRef.current || generation !== viewGeneration.current) return
      const eventType = event.type
      const data = 'data' in event ? event.data : undefined
      if (eventType === 'quirky.loops/changed') {
        if (!isRecord(data) || data.id === loopId) void refreshRef.current()
        return
      }
      if (eventType === 'quirky.structured/message') {
        const message = isRecord(data) && isRecord(data.message) ? data.message : null
        if (message && message.sessionId === loopRef.current?.sessionId && typeof message.sessionId === 'string') {
          void loadMessagesRef.current(message.sessionId, generation)
        }
        return
      }
      if (eventType === 'quirky.structured/settled' && isRecord(data) && data.sessionId === loopRef.current?.sessionId && typeof data.sessionId === 'string') {
        void loadMessagesRef.current(data.sessionId, generation)
      }
    })
    const unsubscribeConnection = context.onConnection((status) => {
      if (!aliveRef.current || generation !== viewGeneration.current) return
      if (status === 'reconnecting') setConnectionStatus('reconnecting')
      else void refreshRef.current()
    })
    void refreshRef.current()

    return () => {
      aliveRef.current = false
      viewGeneration.current += 1
      refreshSequence.current += 1
      historySequence.current += 1
      messageSequence.current += 1
      busyRef.current = null
      unsubscribe()
      unsubscribeConnection()
    }
  }, [context, loopId])

  const currentHistory = useMemo(() => detailList(history), [history])
  const ended = loop !== null && stateEnded(loop)
  const editValidation: EditValidation | null = editDraft !== null && loop !== null
    ? validateDraft(editDraft, {
      workspaceKind: loop.workspaceKind,
      showCost: loop.costUsd !== null || loop.config.caps.maxCostUsd !== undefined,
      editing: true
    })
    : null
  const editPatch = editDraft !== null && editBase !== null && loop !== null && editValidation !== null && editValidation.config !== null
    ? editPatchFromDraft(editBase, loop, editDraft, editValidation.config)
    : null
  const hasEditChanges = editPatch !== null && Object.keys(editPatch).length > 0
  const validationErrors = editValidation?.errors ?? {}

  const mutate = useCallback(async (action: string, method: string, params: Record<string, unknown>, refreshOnFailure = false) => {
    const generation = viewGeneration.current
    if (!aliveRef.current) throw new Error('Loop surface is unavailable.')
    if (busyRef.current !== null) throw new Error('Another loop action is already in progress.')
    busyRef.current = action
    setBusy(action)
    setActionError(null)
    try {
      const result = await context.call(method, params)
      if (!aliveRef.current || generation !== viewGeneration.current) return result
      await refreshRef.current()
      return result
    } catch (error) {
      if (aliveRef.current && generation === viewGeneration.current) {
        setActionError(errorMessage(error))
        if (refreshOnFailure) await refreshRef.current()
      }
      throw error
    } finally {
      if (aliveRef.current && generation === viewGeneration.current) {
        busyRef.current = null
        setBusy(null)
      }
    }
  }, [context])

  const dispatch = useCallback(async (action: string, rawParams: Record<string, unknown> = {}): Promise<unknown> => {
    const generation = viewGeneration.current
    try {
      if (!aliveRef.current) throw new Error('Loop surface is unavailable.')
      const current = loopRef.current
      const requireSnapshot = (): LoopSnapshot => {
        if (current === null || unverifiable || connectionStatus === 'reconnecting') throw new Error('The loop cannot be verified right now.')
        return current
      }
      const requireMutable = (): LoopSnapshot => {
        const snapshot = requireSnapshot()
        if (stateEnded(snapshot)) throw new Error('This loop has ended and is read-only.')
        return snapshot
      }
      switch (action) {
        case 'pause': {
          exactArgs(rawParams, [])
          const snapshot = requireMutable()
          if (snapshot.state !== 'running') throw new Error('Only a running loop can be paused.')
          return await mutate(action, 'quirky.loops/pause', { loopId, mode: 'after-iteration' })
        }
        case 'resume': {
          const params = exactArgs(rawParams, ['addIterations'])
          const snapshot = requireSnapshot()
          if (snapshot.state !== 'paused') throw new Error('Only a paused loop can be resumed.')
          let addIterations: number | undefined
          if (params.addIterations !== undefined) {
            if (!isFiniteNumber(params.addIterations) || !Number.isInteger(params.addIterations) || params.addIterations < 1) {
              throw new Error('Iterations to add must be a positive whole number.')
            }
            if (snapshot.pauseReason !== 'cap-iterations') throw new Error('Additional iterations are only available at the iteration cap.')
            addIterations = params.addIterations
          } else if (isPausedCap(snapshot)) {
            const requested = Number(resumeAdd)
            if (!Number.isInteger(requested) || requested < 1) throw new Error('Iterations to add must be a positive whole number.')
            addIterations = requested
          }
          const result = await mutate(action, 'quirky.loops/resume', {
            loopId,
            ...(addIterations === undefined ? {} : { addIterations })
          })
          if (isPausedCap(snapshot) && aliveRef.current && generation === viewGeneration.current) setResumeAdd('5')
          return result
        }
        case 'stop-open': {
          exactArgs(rawParams, [])
          requireMutable()
          setStopOpen(true)
          setActionError(null)
          return { open: true }
        }
        case 'stop': {
          const params = exactArgs(rawParams, ['mode'], ['mode'])
          const snapshot = requireMutable()
          if (snapshot.state !== 'running' && snapshot.state !== 'needs-you' && snapshot.state !== 'paused') {
            throw new Error('This loop cannot be stopped in its current state.')
          }
          if (params.mode !== 'after-iteration' && params.mode !== 'now') throw new Error('Stop mode must be after-iteration or now.')
          const result = await mutate(action, 'quirky.loops/stop', { loopId, mode: params.mode })
          if (!aliveRef.current || generation !== viewGeneration.current) return result
          setStopOpen(false)
          return result
        }
        case 'stop-cancel':
          exactArgs(rawParams, [])
          setStopOpen(false)
          return { cancelled: true }
        case 'steer-open': {
          exactArgs(rawParams, [])
          requireMutable()
          setSteerDraft('')
          setSteerOpen(true)
          setActionError(null)
          return { open: true }
        }
        case 'steer': {
          const params = exactArgs(rawParams, ['text'], ['text'])
          requireMutable()
          if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('Enter guidance for the next iteration.')
          const result = await mutate(action, 'quirky.loops/steer', { loopId, text: params.text })
          if (!aliveRef.current || generation !== viewGeneration.current) return result
          setSteerOpen(false)
          setSteerDraft('')
          return result
        }
        case 'steer-cancel':
          exactArgs(rawParams, [])
          setSteerOpen(false)
          return { cancelled: true }
        case 'edit-open': {
          exactArgs(rawParams, [])
          const snapshot = requireMutable()
          setEditBase(snapshot)
          setEditDraft(draftFromLoop(snapshot))
          setEditErrors({})
          setActionError(null)
          return { open: true }
        }
        case 'edit-update': {
          const params = exactArgs(rawParams, ['patch'], ['patch'])
          const snapshot = requireMutable()
          if (editDraft === null) throw new Error('Open the edit form before changing its draft.')
          if (!isRecord(params.patch) || Object.keys(params.patch).length === 0) throw new Error('Edit updates require at least one field.')
          const changes = params.patch
          const requestedPacingKind = changes.pacingKind === 'on-idle' || changes.pacingKind === 'interval'
            ? changes.pacingKind
            : editDraft.pacingKind
          const checkCommand = typeof changes.checkCommand === 'string' ? changes.checkCommand : editDraft.checkCommand
          const patch: Partial<LoopDraft> = {}
          for (const [key, value] of Object.entries(changes)) {
            if (!EDITABLE_FIELDS.includes(key)) throw new Error(`Field cannot be edited: ${key}`)
            if (key === 'prompt' && snapshot.config.promptSource.kind !== 'repeat') throw new Error('Queue prompts cannot be edited in the repeat configuration form.')
            if ((key === 'intervalMinutes' || key === 'anchor') && requestedPacingKind !== 'interval') {
              throw new Error('Interval fields require interval pacing.')
            }
            if (key === 'repeatQueue' && snapshot.preset !== 'queue') throw new Error('Queue repetition can only be edited on queue loops.')
            if ((key === 'checkTimeout' || key === 'checkWhen') && !checkCommand.trim()) {
              throw new Error('Add a check command before editing its settings.')
            }
            if (key === 'checkpointCommits' && value === true && snapshot.workspaceKind === 'folder') {
              throw new Error('Checkpoint commits are unavailable in folder workspaces.')
            }
            if (key === 'maxCostUsd' && snapshot.costUsd === null && snapshot.config.caps.maxCostUsd === undefined) {
              throw new Error('Cost caps are unavailable without an existing cost measurement or cap.')
            }
            if (STRING_FIELDS.includes(key) && typeof value !== 'string') throw new Error(`Edit field ${key} must be text.`)
            if (BOOLEAN_FIELDS.includes(key) && typeof value !== 'boolean') throw new Error(`Edit field ${key} must be boolean.`)
            if (key === 'pacingKind' && value !== 'on-idle' && value !== 'interval') throw new Error('Pacing must be on-idle or interval.')
            if (key === 'sessionPolicy' && value !== 'fresh' && value !== 'continue') throw new Error('Session policy must be fresh or continue.')
            if (key === 'anchor' && value !== 'from-end' && value !== 'wall-clock') throw new Error('Interval anchor is invalid.')
            if (key === 'checkWhen' && value !== 'every-iteration' && value !== 'on-claim') throw new Error('Check timing is invalid.')
            Object.assign(patch, { [key]: value })
          }
          setEditDraft((draft) => draft === null ? draft : { ...draft, ...patch })
          setEditErrors({})
          setActionError(null)
          return { updated: true }
        }
        case 'edit-save': {
          exactArgs(rawParams, [])
          const snapshot = requireMutable()
          if (editDraft === null || editBase === null) throw new Error('Open the edit form before saving.')
          const validation = validateDraft(editDraft, {
            workspaceKind: snapshot.workspaceKind,
            showCost: snapshot.costUsd !== null || snapshot.config.caps.maxCostUsd !== undefined,
            editing: true
          })
          setEditErrors(validation.errors)
          if (validation.config === null || Object.keys(validation.errors).length > 0) throw new Error('Correct the invalid configuration before saving.')
          const patch = editPatchFromDraft(editBase, snapshot, editDraft, validation.config)
          if (Object.keys(patch).length === 0) throw new Error('There are no configuration changes to save.')
          const result = await mutate(action, 'quirky.loops/edit', { loopId, patch })
          if (!aliveRef.current || generation !== viewGeneration.current) return result
          setEditDraft(null)
          setEditBase(null)
          setEditErrors({})
          return result
        }
        case 'edit-cancel':
          exactArgs(rawParams, [])
          setEditDraft(null)
          setEditBase(null)
          setEditErrors({})
          return { cancelled: true }
        case 'resume-update': {
          const params = exactArgs(rawParams, ['value'], ['value'])
          const snapshot = requireSnapshot()
          if (!isPausedCap(snapshot)) throw new Error('Iteration additions are only editable at the iteration cap.')
          if (typeof params.value !== 'string') throw new Error('Iterations to add must be text.')
          setResumeAdd(params.value)
          setActionError(null)
          return { updated: true }
        }
        case 'steer-update': {
          const params = exactArgs(rawParams, ['text'], ['text'])
          requireMutable()
          if (!steerOpen) throw new Error('Open the guidance form before editing its draft.')
          if (typeof params.text !== 'string') throw new Error('Guidance must be text.')
          setSteerDraft(params.text)
          setActionError(null)
          return { updated: true }
        }
        case 'queue-draft': {
          const params = exactArgs(rawParams, ['body'], ['body'])
          const snapshot = requireMutable()
          if (snapshot.preset !== 'queue') throw new Error('This loop does not have a queue.')
          const body = params.body
          if (typeof body !== 'string') throw new Error('Queue draft must be text.')
          setQueueState((state) => ({ ...state, addDraft: body }))
          setActionError(null)
          return { updated: true }
        }
        case 'queue-edit-open': {
          const params = exactArgs(rawParams, ['id'], ['id'])
          const snapshot = requireMutable()
          if (snapshot.preset !== 'queue') throw new Error('This loop does not have a queue.')
          if (typeof params.id !== 'string' || params.id.length === 0) throw new Error('Queue item id is required.')
          if (queueState.editingId !== null) throw new Error('Cancel or save the current queue item edit first.')
          const item = snapshot.queueItems.find(({ id }) => id === params.id)
          if (item === undefined) throw new Error(`Queue item not found: ${params.id}`)
          if (item.state === 'in-flight') throw new Error('The in-progress queue item cannot be edited.')
          setQueueState((state) => ({ ...state, editingId: item.id, editingBody: item.body }))
          setActionError(null)
          return { open: true }
        }
        case 'queue-edit-update': {
          const params = exactArgs(rawParams, ['body'], ['body'])
          const snapshot = requireMutable()
          if (snapshot.preset !== 'queue') throw new Error('This loop does not have a queue.')
          if (queueState.editingId === null) throw new Error('Open a queue item before changing its draft.')
          const body = params.body
          if (typeof body !== 'string') throw new Error('Queue draft must be text.')
          const item = snapshot.queueItems.find(({ id }) => id === queueState.editingId)
          if (item === undefined || item.state === 'in-flight') throw new Error('The queue item is no longer editable.')
          setQueueState((state) => ({ ...state, editingBody: body }))
          setActionError(null)
          return { updated: true }
        }
        case 'queue-edit-cancel':
          exactArgs(rawParams, [])
          if (queueState.editingId === null) throw new Error('There is no queue item edit to cancel.')
          setQueueState((state) => ({ ...state, editingId: null, editingBody: '' }))
          return { cancelled: true }
        case 'queue-add':
        case 'queue-edit':
        case 'queue-move':
        case 'queue-remove': {
          const snapshot = requireMutable()
          let operation: QueueOperation
          if (action === 'queue-add') {
            const params = exactArgs(rawParams, ['body'], ['body'])
            if (typeof params.body !== 'string' || !params.body.trim()) throw new Error('Queue prompts cannot be blank.')
            operation = { kind: 'add', body: params.body }
          } else if (action === 'queue-edit') {
            const params = exactArgs(rawParams, ['id', 'body'], ['id', 'body'])
            if (typeof params.id !== 'string' || params.id.length === 0 || typeof params.body !== 'string' || !params.body.trim()) {
              throw new Error('Queue item id and nonblank body are required.')
            }
            operation = { kind: 'edit', id: params.id, body: params.body }
          } else if (action === 'queue-move') {
            const params = exactArgs(rawParams, ['id', 'position'], ['id', 'position'])
            if (typeof params.id !== 'string' || params.id.length === 0 || !Number.isInteger(params.position) || Number(params.position) < 0) {
              throw new Error('Queue item id and a nonnegative whole position are required.')
            }
            operation = { kind: 'move', id: params.id, position: Number(params.position) }
          } else {
            const params = exactArgs(rawParams, ['id'], ['id'])
            if (typeof params.id !== 'string' || params.id.length === 0) throw new Error('Queue item id is required.')
            operation = { kind: 'remove', id: params.id }
          }
          if (snapshot.preset !== 'queue') throw new Error('This loop does not have a queue.')
          const result = await mutate(action, 'quirky.loops/queue', { loopId, op: operation }, true)
          if (!aliveRef.current || generation !== viewGeneration.current) return result
          if (operation.kind === 'add') {
            setQueueState((state) => state.addDraft === operation.body ? { ...state, addDraft: '' } : state)
          } else if (operation.kind === 'edit') {
            setQueueState((state) => state.editingId === operation.id && state.editingBody === operation.body
              ? { ...state, editingId: null, editingBody: '' }
              : state)
          }
          return result
        }
        case 'iteration': {
          const params = exactArgs(rawParams, ['n', 'attempt'], ['n', 'attempt'])
          if (!Number.isInteger(params.n) || Number(params.n) < 1 || !Number.isInteger(params.attempt) || Number(params.attempt) < 1) {
            throw new Error('Iteration number and attempt must be positive whole numbers.')
          }
          const detail = currentHistory.find((item) => item.n === params.n && item.attempt === params.attempt)
          if (detail === undefined) throw new Error('That retained iteration is unavailable.')
          setSelectedDetail(detail)
          return detail
        }
        case 'back':
          exactArgs(rawParams, [])
          setSelectedDetail(null)
          return { detail: null }
        default:
          throw new Error(`Unknown loop action: ${action}`)
      }
    } catch (error) {
      if (aliveRef.current && generation === viewGeneration.current) setActionError(errorMessage(error))
      throw error
    }
  }, [connectionStatus, currentHistory, editBase, editDraft, loopId, mutate, queueState, resumeAdd, steerOpen, unverifiable])
  dispatchRef.current = dispatch

  const visibleError = actionError ?? (loop === null ? null : viewError)
  const queueEditVisible = selectedDetail === null && queueState.editingId !== null &&
    loop?.queueItems.some((item) => item.id === queueState.editingId && item.state !== 'in-flight') === true
  const activeForm = ended || unverifiable || connectionStatus === 'reconnecting' || selectedDetail !== null ? null : stopOpen ? 'stop' : steerOpen ? 'steer' : editDraft !== null ? 'edit' :
    queueEditVisible ? 'queue-edit' : queueState.addDraft.trim() ? 'queue-add' : null
  const surfaceState: Record<string, unknown> = {
    snapshot: loop,
    outputSource: loop === null ? null : usesSavedOutput(loop) ? 'iteration' : 'structured',
    connectionStatus,
    activeForm,
    steerDraft,
    editDraft,
    selectedDetail,
    queueDraft: queueState,
    errors: {
      action: actionError,
      snapshot: viewError,
      history: historyError,
      output: messageError,
      validation: editErrors,
      draftValidation: validationErrors
    },
    busy,
    resumeAdd
  }
  surfaceStateRef.current = surfaceState

  const handleRef = useRef<SurfaceHandle | null>(null)
  if (handleRef.current === null) {
    handleRef.current = {
      read: () => surfaceStateRef.current,
      dispatch: (action, params) => dispatchRef.current(action, params)
    }
  }
  useEffect(() => {
    const handle = handleRef.current
    if (handle === null) return
    onHandle(handle)
    return () => onHandle(null)
  }, [onHandle])
  useEffect(() => {
    report?.(surfaceState)
  }, [report, surfaceState])

  const runFromDom = useCallback((action: string, params: Record<string, unknown> = {}) => {
    void dispatchRef.current(action, params).catch(() => {})
  }, [])
  const onQueueAction = useCallback((command: QueueEditorCommand) => {
    switch (command.action) {
      case 'queue-draft': return dispatchRef.current(command.action, { body: command.params.body })
      case 'queue-edit-open': return dispatchRef.current(command.action, { id: command.params.id })
      case 'queue-edit-update': return dispatchRef.current(command.action, { body: command.params.body })
      case 'queue-edit-cancel': return dispatchRef.current(command.action, {})
      case 'queue-add': return dispatchRef.current(command.action, { body: command.params.body })
      case 'queue-edit': return dispatchRef.current(command.action, { id: command.params.id, body: command.params.body })
      case 'queue-move': return dispatchRef.current(command.action, { id: command.params.id, position: command.params.position })
      case 'queue-remove': return dispatchRef.current(command.action, { id: command.params.id })
    }
  }, [])

  if (loading && loop === null) {
    return <ToolPanelFrame title="Loop"><p role="status">Loading loop…</p></ToolPanelFrame>
  }

  const currentLoop = loop
  const status = currentLoop === null || unverifiable ? 'Unverifiable' : connectionStatus === 'reconnecting' ? 'Reconnecting' : STATE_LABELS[currentLoop.state]
  const statusTone = currentLoop === null || unverifiable || connectionStatus === 'reconnecting'
    ? 'neutral'
    : currentLoop.state === 'running' ? 'working' : currentLoop.state === 'needs-you' ? 'needs-you' : currentLoop.state === 'completed' ? 'accent' : 'neutral'
  const isReadOnly = currentLoop === null || unverifiable || connectionStatus === 'reconnecting' || ended
  const latestDetail = currentHistory[currentHistory.length - 1] ?? null
  const evidenceDetail = currentLoop?.recentIterations[currentLoop.recentIterations.length - 1] ?? latestDetail
  const checkDetail = latestDetail ?? evidenceDetail
  const showSavedOutput = currentLoop !== null && usesSavedOutput(currentLoop)
  const savedOutput = currentLoop !== null && showSavedOutput
    ? savedIterationOutput(currentLoop, currentLoop.recentIterations) ?? savedIterationOutput(currentLoop, currentHistory)
    : null
  const iterationCap = currentLoop?.config.caps.maxIterations
  const costCap = currentLoop === null ? null : moneyCap(currentLoop)
  const configuredCaps = currentLoop === null ? [] : [
    iterationCap === undefined ? null : `${iterationCap} iterations`,
    currentLoop.config.caps.maxActiveMinutes === undefined ? null : `${currentLoop.config.caps.maxActiveMinutes} active minutes`,
    costCap === null ? null : `Cost cap ${costCap}`
  ].filter((value): value is string => value !== null)
  const costMeter = currentLoop === null ? null : currentLoop.costUsd !== null && Number.isFinite(currentLoop.costUsd)
    ? `Cost ${costLabel(currentLoop.costUsd)}${costCap === null ? '' : ` / ${costCap}`}`
    : costCap === null ? null : `Cost unavailable / cap ${costCap}`
  const activeTime = currentLoop !== null && Number.isFinite(currentLoop.activeMs)
    ? `Active time ${formatDuration(currentLoop.activeMs)}${currentLoop.config.caps.maxActiveMinutes === undefined ? '' : ` / ${currentLoop.config.caps.maxActiveMinutes}m`}`
    : null
  const latestBlocked = evidenceDetail?.markers.blocked
  const latestDecision = evidenceDetail?.markers.decide
  const formErrors = Object.keys(editErrors).length > 0 ? editErrors : validationErrors
  const editSaveDisabled = busy !== null || editDraft === null || editBase === null || editValidation === null ||
    editValidation.config === null || Object.keys(editValidation.errors).length > 0 || !hasEditChanges

  return (
    <div className="ui-stack">
      <ToolPanelFrame title="Loop output">
        <div className="ui-stack">
          {currentLoop === null ? (
            <EmptyState message="Loop output is unavailable until its state can be verified." />
          ) : showSavedOutput ? (
            <>
              <p className="ui-text-muted">
                {savedOutput === null ? 'Saved iteration output' : `Saved iteration ${savedOutput.n}${savedOutput.attempt > 1 ? ` · attempt ${savedOutput.attempt}` : ''} output`}
              </p>
              {savedOutput?.error && <p role="alert">{savedOutput.error}</p>}
              <div className="ui-stack" role="log" aria-label="Saved iteration output">
                {savedOutput?.outputTail ? <pre className="ui-readout">{savedOutput.outputTail}</pre> : <EmptyState message="No output recorded for this iteration." />}
              </div>
            </>
          ) : currentLoop.sessionId === null ? (
            <EmptyState message="No structured session is attached." />
          ) : (
            <>
              <p className="ui-text-muted">Session {currentLoop.sessionId}</p>
              {messageError !== null && <p role="alert">Output unavailable: {messageError}</p>}
              {messageLoading && <p role="status">Loading output…</p>}
              {!messageLoading && messages.length === 0 && messageError === null && <EmptyState message="No messages recorded." />}
              <div className="ui-stack" role="log" aria-label="Structured session journal" aria-live="polite">
                {messages.map((message) => {
                  const data = prettyData(message.data)
                  return <article className="ui-stack" key={`${message.sessionId}:${message.seq}`}>
                    <div className="ui-cluster">
                      <strong>{message.role}</strong>
                      <time dateTime={new Date(message.at).toISOString()}>{new Date(message.at).toLocaleTimeString()}</time>
                    </div>
                    <pre className="ui-readout">{message.text}</pre>
                    {data !== null && <details>
                      <summary>Structured details</summary>
                      <pre className="ui-readout">{data}</pre>
                    </details>}
                  </article>
                })}
              </div>
            </>
          )}
        </div>
      </ToolPanelFrame>

      <ToolPanelFrame
        title={currentLoop?.name ?? 'Loop unavailable'}
        actions={
          <div className="ui-cluster">
            <Badge tone={statusTone}>{status}</Badge>
            {currentLoop !== null && (
              <Badge>
                {currentLoop.preset === 'until-done' ? 'Until done' : currentLoop.preset === 'interval' ? 'On an interval' : 'Work through a queue'} · {currentLoop.agent}
              </Badge>
            )}
          </div>
        }
      >
        <section className="ui-stack" aria-label="Loop controls and history">
          {currentLoop !== null && <p className="ui-text-muted">{currentLoop.sessionId === null ? 'No session' : `Session ${currentLoop.sessionId}`}</p>}
          {connectionStatus === 'reconnecting' && <p role="status">Reconnecting to loop state…</p>}
          {currentLoop === null && !loading && <p role="alert">{viewError ?? 'Loop state is unavailable.'}</p>}
          {currentLoop !== null && <>
            <p><strong>Phase:</strong> {currentLoop.phase === null ? 'No active phase' : PHASE_LABELS[currentLoop.phase]}</p>
            <div role="status">
              {unverifiable
                ? 'Current loop state could not be verified.'
                : currentLoop.state === 'paused' && currentLoop.pauseReason !== null
                  ? PAUSE_LABELS[currentLoop.pauseReason]
                  : currentLoop.state === 'needs-you' && (latestBlocked || latestDecision)
                    ? latestBlocked ? `Blocked: ${latestBlocked}` : `Decision needed: ${latestDecision}`
                    : currentLoop.state === 'running' && currentLoop.phase !== null
                      ? PHASE_LABELS[currentLoop.phase]
                      : STATE_LABELS[currentLoop.state]}
            </div>
            {currentLoop.pauseDetail !== null && <p><strong>Pause detail:</strong> {currentLoop.pauseDetail}</p>}
            {latestBlocked && <p><strong>Blocked:</strong> {latestBlocked}</p>}
            {latestDecision && <p><strong>Decision:</strong> {latestDecision}</p>}
            <div className="ui-cluster">
              {iterationCap === undefined
                ? <span>{currentLoop.iterationsCompleted} iterations</span>
                : <><progress max={iterationCap} value={Math.min(currentLoop.iterationsCompleted, iterationCap)} aria-label="Iteration progress" />
                  <span>{currentLoop.state === 'running' ? `Iteration ${currentLoop.iterationsCompleted} of ${iterationCap}` : `${currentLoop.iterationsCompleted} of ${iterationCap} iterations done`}</span></>}
            </div>
            <p><strong>Caps:</strong> {configuredCaps.length === 0 ? 'None configured' : configuredCaps.join(' · ')}</p>
            <div className="ui-cluster">
              {activeTime !== null && <span>{activeTime}</span>}
              {costMeter !== null && <span>{costMeter}</span>}
            </div>
            <p><strong>Last check:</strong> {lastCheckLabel(checkDetail)}</p>
            {currentLoop.nextIterationAt !== null && <p><strong>Next iteration:</strong> {timeLabel(currentLoop.nextIterationAt)}</p>}
            <p><strong>Skipped ticks:</strong> {currentLoop.skippedTicks}</p>
            {currentLoop.warnings.length > 0 && <ul aria-label="Warnings">{currentLoop.warnings.map((warning, index) => <li key={`${index}:${warning}`}>{warning}</li>)}</ul>}
          </>}

          {visibleError !== null && <p role="alert">{visibleError}</p>}
          {historyError !== null && <p role="alert">Iteration history unavailable: {historyError}</p>}

          {currentLoop !== null && !isReadOnly && <div className="ui-stack" role="group" aria-label="Loop lifecycle controls">
            {currentLoop.state === 'running' && <Button disabled={busy !== null} onClick={() => runFromDom('pause')}>Pause after this iteration</Button>}
            {currentLoop.state === 'paused' && <div className="ui-stack">
              {isPausedCap(currentLoop) && (
                <TextField
                  label="Iterations to add"
                  aria-label="Iterations to add"
                  type="number"
                  min="1"
                  step="1"
                  value={resumeAdd}
                  help={`+ ${resumeAdd} iterations`}
                  onChange={(event) => runFromDom('resume-update', { value: event.currentTarget.value })}
                  disabled={busy !== null}
                />
              )}
              <Button disabled={busy !== null || (isPausedCap(currentLoop) && (!Number.isInteger(Number(resumeAdd)) || Number(resumeAdd) < 1))} onClick={() => runFromDom('resume')}>Resume</Button>
            </div>}
            <Button variant="destructive" disabled={busy !== null} onClick={() => runFromDom('stop-open')}>Stop</Button>
            <Button disabled={busy !== null} onClick={() => runFromDom('steer-open')}>Steer</Button>
            <Button disabled={busy !== null} onClick={() => runFromDom('edit-open')}>Edit configuration</Button>
          </div>}

          <Dialog
            open={stopOpen && !isReadOnly}
            title="Stop the loop"
            onClose={() => runFromDom('stop-cancel')}
            closeOnBackdrop={false}
            actions={<>
              <Button disabled={busy !== null} onClick={() => runFromDom('stop', { mode: 'after-iteration' })}>After this iteration</Button>
              <Button variant="destructive" disabled={busy !== null} onClick={() => runFromDom('stop', { mode: 'now' })}>Now</Button>
              <Button disabled={busy !== null} onClick={() => runFromDom('stop-cancel')}>Cancel</Button>
            </>}
          >
            <p>Choose when the loop should stop.</p>
          </Dialog>

          <Dialog
            open={steerOpen && !isReadOnly}
            title="Guidance for the next iteration"
            onClose={() => runFromDom('steer-cancel')}
            closeOnBackdrop={false}
            actions={<>
              <Button disabled={busy !== null || !steerDraft.trim()} onClick={() => runFromDom('steer', { text: steerDraft })}>Send</Button>
              <Button disabled={busy !== null} onClick={() => runFromDom('steer-cancel')}>Cancel</Button>
            </>}
          >
            <TextArea
              label="Guidance"
              aria-label="Guidance for the next iteration"
              value={steerDraft}
              onChange={(event) => runFromDom('steer-update', { text: event.currentTarget.value })}
              disabled={busy !== null}
            />
          </Dialog>

          <Dialog
            open={editDraft !== null && currentLoop !== null && !isReadOnly}
            title="Edit configuration"
            onClose={() => runFromDom('edit-cancel')}
            closeOnBackdrop={false}
            actions={<>
              <Button disabled={editSaveDisabled} onClick={() => runFromDom('edit-save')}>Save</Button>
              <Button disabled={busy !== null} onClick={() => runFromDom('edit-cancel')}>Cancel</Button>
            </>}
          >
            {editDraft !== null && currentLoop !== null && (
              <div className="ui-stack">
                <TextField
                  label="Name"
                  aria-label="Loop name"
                  type="text"
                  value={editDraft.name}
                  onChange={(event) => { void dispatchRef.current('edit-update', { patch: { name: event.currentTarget.value } }).catch(() => {}) }}
                  disabled={busy !== null}
                  error={formErrors.name}
                />
                {currentLoop.config.promptSource.kind === 'repeat' && <TextArea
                  label="Prompt"
                  aria-label="Loop prompt"
                  value={editDraft.prompt}
                  onChange={(event) => { void dispatchRef.current('edit-update', { patch: { prompt: event.currentTarget.value } }).catch(() => {}) }}
                  disabled={busy !== null}
                  error={formErrors.prompt}
                />}
                <ConfigFields
                  draft={editDraft}
                  onChange={(patch) => { void dispatchRef.current('edit-update', { patch }).catch(() => {}) }}
                  errors={formErrors}
                  workspaceKind={currentLoop.workspaceKind}
                  showCost={currentLoop.costUsd !== null || currentLoop.config.caps.maxCostUsd !== undefined}
                  editing
                  disabled={busy !== null}
                />
              </div>
            )}
          </Dialog>

          {currentLoop?.preset === 'queue' && <div hidden={selectedDetail !== null || isReadOnly} aria-hidden={selectedDetail !== null || isReadOnly}>
            <LoopQueueEditor
              items={currentLoop.queueItems}
              state={queueState}
              disabled={busy !== null || isReadOnly}
              onAction={onQueueAction}
            />
          </div>}
          {currentLoop?.preset === 'queue' && !selectedDetail && isReadOnly && <section className="ui-stack" aria-label="Loop queue history">
            <SectionHeader title="Queue" />
            <ol className="ui-stack">{currentLoop.queueItems.map((item) => <li className="ui-stack" data-queue-id={item.id} key={item.id}>
              <Badge tone={item.state === 'in-flight' ? 'working' : item.state === 'done' ? 'accent' : 'neutral'}>
                {item.state === 'in-flight' ? 'In progress' : item.state === 'done' ? 'Done' : 'Pending'}
              </Badge>
              <p>{item.body}</p>
            </li>)}</ol>
          </section>}

          {selectedDetail !== null ? <LoopIterationDetail detail={selectedDetail} onBack={() => runFromDom('back')} /> : (
            <section className="ui-stack" aria-label="Iteration history">
              <SectionHeader title="Iterations" />
              {historyError !== null ? <EmptyState message="History could not be loaded." /> : currentHistory.length === 0
                ? <EmptyState message="No finished iterations." />
                : <ol className="ui-stack">{currentHistory.slice().reverse().map((detail) => {
                  const duration = detail.endedAt === null ? null : detail.endedAt - detail.startedAt
                  const changes = detail.diff === null ? 'Diff unavailable' : `+${detail.diff.added} / −${detail.diff.removed}`
                  const attempt = detail.attempt > 1 ? ` · Attempt ${detail.attempt}` : ''
                  return <li key={`${detail.n}:${detail.attempt}`}>
                    <Button
                      aria-label={`Iteration ${detail.n}${attempt}`}
                      className="ui-stack"
                      onClick={() => runFromDom('iteration', { n: detail.n, attempt: detail.attempt })}
                    >
                      <span>#{detail.n}{attempt}</span>
                      <span>{iterationCheckLabel(detail)}</span>
                      <span>{changes}</span>
                      <span>{formatDuration(duration)}</span>
                    </Button>
                  </li>
                })}</ol>}
            </section>
          )}
          {busy !== null && <p role="status">Working…</p>}
        </section>
      </ToolPanelFrame>
    </div>
  )
}

