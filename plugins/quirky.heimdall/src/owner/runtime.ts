import { constants as fsConstants, type Stats } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { Json, JournalAppend, JournalEntry, Snapshot } from '../contracts'
import { budgetUsage } from '../budget'
import {
  MAX_OWNER_REPORT_BYTES,
  OWNER_BRIEF_MAX_STATE_BYTES,
  OWNER_DEVIATION_KINDS,
  OWNER_STALL_THRESHOLD_MS,
  type OwnerApplyResult,
  type OwnerConfig,
  type OwnerController,
  type OwnerDeviation,
  type OwnerDeviationKind,
  type OwnerEnrollment,
  type OwnerIntervention,
  type OwnerPending,
  type OwnerRuntimeHost,
  type OwnerState,
  type OwnerStepResult
} from './contracts'

type OwnerRuntimePending = OwnerPending & {
  contentIdentity: string
  deviationId: string
  briefContext: string
  intervalId?: string
  parkCause?: 'silence' | 'ask-human'
}
type OwnerRuntimeState = Omit<OwnerState, 'pending'> & {
  pending: OwnerRuntimePending | null
  queue: string[]
  ownerConfig?: OwnerConfig
  requestedOwnerConfig?: OwnerConfig
  ownerReleased?: boolean
  releaseUncertain?: boolean
  lastError?: string
  lastErrorAtMs?: number
  lastOutcome?: { kind: OwnerApplyResult['kind']; reason?: string }
}
type DeviationStatus = 'open' | 'applied' | 'refused' | 'indeterminate' | 'released'
type DeviationFact = {
  escalationId: string
  naturalKey: string
  revision: number
  foldCount: number
  deviation: OwnerDeviation
  status: DeviationStatus
  resolved: boolean
  reason?: string
}
type IssuedFile = { reportKey: string; reportPath: string }

const NO_CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/
const REPORT_FILENAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/i
const DEVIATION_KIND_SET = new Set<string>(OWNER_DEVIATION_KINDS)
const PENDING_PHASES: Record<OwnerPending['phase'], true> = { deferred: true, issuing: true, waiting: true, ready: true, indeterminate: true, parked: true }
const OWNER_SHUTDOWN_TIMEOUT_MS = 1_500
const OWNER_BRIEF_CONTEXT_MAX_BYTES = 13 * 1024

async function waitUntilOwnerShutdownDeadline(work: Promise<unknown>, deadlineAtMs: number): Promise<boolean> {
  const remainingMs = deadlineAtMs - Date.now()
  if (remainingMs <= 0) {
    void work.catch(() => undefined)
    return false
  }
  const timeout = Promise.withResolvers<boolean>()
  const timer = setTimeout(() => timeout.resolve(false), remainingMs)
  const settled = await Promise.race([work.then(() => true, () => true), timeout.promise])
  clearTimeout(timer)
  return settled
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
}

function exactShape(value: unknown, required: string[], optional: string[], label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain object`)
  const allowed = new Set([...required, ...optional])
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) throw new TypeError(`${label} contains an unsupported field`)
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw new TypeError(`${label} is missing ${key}`)
  }
  return value
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${field} must be a non-empty string`)
  return value
}

function optionalConfigString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '' || NO_CONTROL_CHARACTERS.test(value)) {
    throw new TypeError(`${field} must be a valid string`)
  }
  return value
}

export function parseOwnerConfig(value: unknown): OwnerConfig | null {
  if (value === undefined || value === null) return null
  const config = exactShape(value, ['agent'], ['model', 'effort'], 'owner config')
  if (config.agent !== 'claude') throw new TypeError('owner agent must be claude')
  const model = Object.hasOwn(config, 'model') ? optionalConfigString(config.model, 'owner model') : undefined
  const effort = Object.hasOwn(config, 'effort') ? optionalConfigString(config.effort, 'owner effort') : undefined
  return { agent: 'claude', ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) }
}

export function parseOwnerDeviation(value: unknown): OwnerDeviation {
  const deviation = exactShape(value, ['kind', 'naturalKey', 'detail'], ['dispatchId', 'messageId', 'trigger'], 'owner deviation')
  if (typeof deviation.kind !== 'string' || !DEVIATION_KIND_SET.has(deviation.kind)) throw new TypeError('owner deviation kind is unknown')
  const naturalKey = nonEmptyString(deviation.naturalKey, 'owner deviation naturalKey')
  if (typeof deviation.detail !== 'string') throw new TypeError('owner deviation detail must be a string')
  const dispatchId = Object.hasOwn(deviation, 'dispatchId') ? nonEmptyString(deviation.dispatchId, 'dispatchId') : undefined
  const messageId = Object.hasOwn(deviation, 'messageId') ? nonEmptyString(deviation.messageId, 'messageId') : undefined
  let trigger: OwnerDeviation['trigger']
  if (Object.hasOwn(deviation, 'trigger')) {
    const rawTrigger = deviation.trigger
    if (rawTrigger !== 'idle' && rawTrigger !== 'silent') throw new TypeError('owner deviation trigger is invalid')
    trigger = rawTrigger
  }
  return {
    kind: deviation.kind as OwnerDeviationKind,
    naturalKey,
    detail: deviation.detail,
    ...(dispatchId === undefined ? {} : { dispatchId }),
    ...(messageId === undefined ? {} : { messageId }),
    ...(trigger === undefined ? {} : { trigger })
  }
}

function isJson(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) return value.every(isJson)
  if (!isRecord(value)) return false
  return Reflect.ownKeys(value).every((key) => typeof key === 'string' && isJson(value[key]))
}

export function parseOwnerIntervention(value: unknown): OwnerIntervention {
  if (!isRecord(value) || typeof value.kind !== 'string') throw new TypeError('owner intervention must be an object with a kind')
  switch (value.kind) {
    case 'continue':
      exactShape(value, ['kind'], [], 'continue intervention')
      return { kind: 'continue' }
    case 'ask-human': {
      const intervention = exactShape(value, ['kind', 'question'], [], 'ask-human intervention')
      return { kind: 'ask-human', question: nonEmptyString(intervention.question, 'question') }
    }
    case 'abandon': {
      const intervention = exactShape(value, ['kind', 'reason'], [], 'abandon intervention')
      return { kind: 'abandon', reason: nonEmptyString(intervention.reason, 'reason') }
    }
    case 'answer-worker': {
      const intervention = exactShape(value, ['kind', 'dispatchId', 'messageId', 'body'], [], 'answer-worker intervention')
      return {
        kind: 'answer-worker',
        dispatchId: nonEmptyString(intervention.dispatchId, 'dispatchId'),
        messageId: nonEmptyString(intervention.messageId, 'messageId'),
        body: nonEmptyString(intervention.body, 'body')
      }
    }
    case 'stop-worker': {
      const intervention = exactShape(value, ['kind', 'dispatchId'], [], 'stop-worker intervention')
      return { kind: 'stop-worker', dispatchId: nonEmptyString(intervention.dispatchId, 'dispatchId') }
    }
    case 'message-worker': {
      const intervention = exactShape(value, ['kind', 'dispatchId', 'body'], [], 'message-worker intervention')
      return {
        kind: 'message-worker',
        dispatchId: nonEmptyString(intervention.dispatchId, 'dispatchId'),
        body: nonEmptyString(intervention.body, 'body')
      }
    }
    case 'kind-action': {
      const intervention = exactShape(value, ['kind', 'action'], [], 'kind-action intervention')
      if (!isJson(intervention.action)) throw new TypeError('kind-action action must be JSON')
      return { kind: 'kind-action', action: intervention.action as Json }
    }
    default:
      throw new TypeError('owner intervention kind is unknown')
  }
}

function errorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 2_000 ? `${message.slice(0, 1_997)}...` : message
}

function sameOwnerConfig(left: OwnerConfig, right: OwnerConfig): boolean {
  return left.agent === right.agent && left.model === right.model && left.effort === right.effort
}

function nowMs(host: OwnerRuntimeHost): number {
  const time = host.now()
  if (!Number.isFinite(time)) throw new Error('owner clock returned a non-finite timestamp')
  return Math.trunc(time)
}

function newState(instanceId: string): OwnerRuntimeState {
  return { sessionId: null, pending: null, instanceId, queue: [] }
}

function validPending(value: unknown): OwnerRuntimePending {
  if (!isRecord(value)) throw new TypeError('stored owner pending report is malformed')
  const deviation = parseOwnerDeviation(value.deviation)
  const phase = value.phase
  if (typeof phase !== 'string' || !Object.hasOwn(PENDING_PHASES, phase)) throw new TypeError('stored owner phase is malformed')
  if (typeof value.reportKey !== 'string' || value.reportKey.length === 0 || typeof value.reportPath !== 'string') {
    throw new TypeError('stored owner report identity is malformed')
  }
  if (typeof value.escalationId !== 'string' || value.escalationId.length === 0) throw new TypeError('stored owner escalation identity is malformed')
  if (typeof value.contentIdentity !== 'string') throw new TypeError('stored owner content identity is malformed')
  if (typeof value.issuedAtMs !== 'number' || !Number.isFinite(value.issuedAtMs) || typeof value.lastWakeAtMs !== 'number' || !Number.isFinite(value.lastWakeAtMs)) {
    throw new TypeError('stored owner timestamps are malformed')
  }
  if (typeof value.wakeCount !== 'number' || !Number.isInteger(value.wakeCount) || value.wakeCount < 0) throw new TypeError('stored owner wake count is malformed')
  if (typeof value.deviationId !== 'string' || value.deviationId.length === 0) throw new TypeError('stored owner deviation identity is malformed')
  const intervention = value.intervention === undefined ? undefined : parseOwnerIntervention(value.intervention)
  const intervalId = value.intervalId === undefined ? undefined : nonEmptyString(value.intervalId, 'intervalId')
  const parkCause = value.parkCause
  if (parkCause !== undefined && parkCause !== 'silence' && parkCause !== 'ask-human') throw new TypeError('stored owner park cause is malformed')
  const briefContext = value.briefContext === undefined ? '' : value.briefContext
  if (typeof briefContext !== 'string' || Buffer.byteLength(briefContext, 'utf8') > OWNER_BRIEF_CONTEXT_MAX_BYTES) {
    throw new TypeError('stored owner brief context is malformed')
  }
  return {
    reportKey: value.reportKey,
    reportPath: value.reportPath,
    deviation,
    escalationId: value.escalationId,
    issuedAtMs: value.issuedAtMs,
    lastWakeAtMs: value.lastWakeAtMs,
    wakeCount: value.wakeCount,
    phase: phase as OwnerPending['phase'],
    contentIdentity: value.contentIdentity,
    deviationId: value.deviationId,
    briefContext,
    ...(intervention === undefined ? {} : { intervention }),
    ...(intervalId === undefined ? {} : { intervalId }),
    ...(parkCause === undefined ? {} : { parkCause })
  }
}

function deserializeState(value: unknown, instanceId: string): OwnerRuntimeState | null {
  if (!isRecord(value)) return null
  if (value.sessionId !== null && typeof value.sessionId !== 'string') return null
  if (value.instanceId !== undefined && typeof value.instanceId !== 'string') return null
  if (value.pending !== null && value.pending !== undefined && !isRecord(value.pending)) return null
  try {
    const pending = value.pending == null ? null : validPending(value.pending)
    const queue = value.queue === undefined ? [] : value.queue
    if (!Array.isArray(queue) || queue.some((entry) => typeof entry !== 'string')) return null
    const state: OwnerRuntimeState = {
      sessionId: value.sessionId as string | null,
      pending,
      instanceId: typeof value.instanceId === 'string' ? value.instanceId : instanceId,
      queue: [...queue] as string[]
    }
    if (value.ownerConfig !== undefined && value.ownerConfig !== null) {
      const ownerConfig = parseOwnerConfig(value.ownerConfig)
      if (!ownerConfig) return null
      state.ownerConfig = ownerConfig
    }
    if (value.requestedOwnerConfig !== undefined && value.requestedOwnerConfig !== null) {
      const requestedOwnerConfig = parseOwnerConfig(value.requestedOwnerConfig)
      if (!requestedOwnerConfig) return null
      state.requestedOwnerConfig = requestedOwnerConfig
    } else if (state.ownerConfig && value.ownerReleased !== true) {
      state.requestedOwnerConfig = state.ownerConfig
    }
    if (value.ownerReleased !== undefined) {
      if (typeof value.ownerReleased !== 'boolean') return null
      state.ownerReleased = value.ownerReleased
    }
    if (value.releaseUncertain !== undefined) {
      if (typeof value.releaseUncertain !== 'boolean') return null
      state.releaseUncertain = value.releaseUncertain
    }
    if (typeof value.lastError === 'string') state.lastError = value.lastError
    if (typeof value.lastErrorAtMs === 'number' && Number.isFinite(value.lastErrorAtMs)) state.lastErrorAtMs = value.lastErrorAtMs
    if (isRecord(value.lastOutcome) && typeof value.lastOutcome.kind === 'string' && ['applied', 'held', 'indeterminate', 'refused'].includes(value.lastOutcome.kind)) {
      state.lastOutcome = {
        kind: value.lastOutcome.kind as OwnerApplyResult['kind'],
        ...(typeof value.lastOutcome.reason === 'string' ? { reason: value.lastOutcome.reason } : {})
      }
    }
    return state
  } catch {
    return null
  }
}

function cloneState(state: OwnerRuntimeState): OwnerRuntimeState {
  return JSON.parse(JSON.stringify(state)) as OwnerRuntimeState
}

function deviationEscalationId(watcherId: string, naturalKey: string): string {
  return `owner-deviation:${watcherId}:${naturalKey}`
}

function reportEscalationId(watcherId: string, reportKey: string): string {
  return `owner-escalation:${watcherId}:${reportKey}`
}

function deviationFactFrom(entry: JournalEntry): DeviationFact | null {
  if (entry.kind !== 'owner-deviation' || typeof entry.naturalKey !== 'string' || typeof entry.escalationId !== 'string') return null
  let deviation: OwnerDeviation
  try {
    deviation = parseOwnerDeviation(entry.deviation)
  } catch {
    return null
  }
  const revision = entry.revision
  const foldCount = entry.foldCount
  const status = entry.status
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) return null
  if (status !== 'open' && status !== 'applied' && status !== 'refused' && status !== 'indeterminate' && status !== 'released') return null
  return {
    escalationId: entry.escalationId,
    naturalKey: entry.naturalKey,
    revision,
    foldCount: typeof foldCount === 'number' && Number.isInteger(foldCount) && foldCount > 0 ? foldCount : 1,
    deviation,
    status,
    resolved: entry.resolved === true,
    ...(typeof entry.reason === 'string' ? { reason: entry.reason } : {})
  }
}

export function createOwnerController(host: OwnerRuntimeHost): OwnerController {
  const instanceId = randomUUID()
  const reportDirectory = resolve(host.reportDirectory)
  let shuttingDown = false
  let shutdownPromise: Promise<void> | null = null
  const watcherLocks = new Map<string, Promise<void>>()
  const activeWatcherOperations = new Set<string>()
  const activeOperations = new Set<Promise<unknown>>()
  const stateCache = new Map<string, OwnerRuntimeState>()
  const deviationFactsCache = new Map<string, Map<string, DeviationFact>>()
  const activeIntervals = new Map<string, string>()
  const issuedPathsByWatcher = new Map<string, Set<string>>()
  const releasedWatchers = new Set<string>()
  const ownerRemovalRequested = new Set<string>()
  const releaseWork = new Map<string, Promise<boolean>>()
  const releaseWorkReasons = new Map<string, 'owner-removed' | 'config-changed'>()
  const releaseStopWork = new Map<string, Promise<unknown>>()
  const releaseStopFailures = new Map<string, unknown>()
  const ownerSessions = new Map<string, Set<string>>()
  const issuedPaths = new Set<string>()

  function ensureOpen(): void {
    if (shuttingDown) throw new Error('owner controller is shutting down')
  }

  function ensureWatcherOpen(watcherId: string): void {
    ensureOpen()
    if (releasedWatchers.has(watcherId)) throw new Error('owner watcher is being released')
  }

  function watcherCanWrite(watcherId: string): boolean {
    try {
      return !host.store.readOnly && host.store.get(watcherId) !== null
    } catch {
      return false
    }
  }

  function watcherExists(watcherId: string): boolean {
    try {
      return host.store.get(watcherId) !== null
    } catch {
      return false
    }
  }

  function journal(watcherId: string): JournalEntry[] {
    return host.store.journal(watcherId)
  }

  function append(
    watcherId: string,
    kind: string,
    fields: Record<string, unknown> = {},
    resolved = false,
    releaseCleanup = false
  ): JournalEntry {
    ensureOpen()
    if (releasedWatchers.has(watcherId) && !releaseCleanup) throw new Error('owner watcher is being released')
    if (!watcherCanWrite(watcherId)) throw new Error('owner watcher journal is unavailable')
    const record: JournalAppend = {
      class: 'fact',
      origin: 'owner',
      kind,
      resolved,
      eventId: `owner:${randomUUID()}`,
      atMs: nowMs(host),
      ...fields
    }
    return host.store.append(watcherId, record)
  }

  function persistState(watcherId: string, state: OwnerRuntimeState, releaseCleanup = false): void {
    const saved = cloneState(state)
    if (releaseCleanup && (shuttingDown || !watcherExists(watcherId))) {
      stateCache.set(watcherId, saved)
      return
    }
    append(watcherId, 'owner-state', { state: saved }, false, releaseCleanup)
    stateCache.set(watcherId, saved)
  }
  function readState(watcherId: string): OwnerRuntimeState {
    const cached = stateCache.get(watcherId)
    if (cached) {
      const state = cloneState(cached)
      if (state.sessionId) addOwnedSession(watcherId, state.sessionId)
      if (state.pending?.intervalId) activeIntervals.set(watcherId, state.pending.intervalId)
      return state
    }
    let latest: JournalEntry | undefined
    try {
      const entries = journal(watcherId)
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        if (entries[index]?.kind === 'owner-state' && isRecord(entries[index]?.state)) {
          latest = entries[index]
          break
        }
      }
    } catch {
      return { ...newState(instanceId), lastError: 'Owner journal could not be read.' }
    }
    const state = latest ? deserializeState(latest.state, instanceId) : newState(instanceId)
    const loaded = state ?? { ...newState(instanceId), lastError: 'Persisted owner state is malformed.' }
    stateCache.set(watcherId, cloneState(loaded))
    if (loaded.sessionId) addOwnedSession(watcherId, loaded.sessionId)
    if (loaded.pending?.intervalId) activeIntervals.set(watcherId, loaded.pending.intervalId)
    return loaded
  }

  function addOwnedSession(watcherId: string, sessionId: string): void {
    const sessions = ownerSessions.get(watcherId) ?? new Set<string>()
    sessions.add(sessionId)
    ownerSessions.set(watcherId, sessions)
  }

  function isActive(enrollment: OwnerEnrollment): boolean {
    return enrollment.enabled && !enrollment.paused
  }

  function latestDeviationFacts(watcherId: string): Map<string, DeviationFact> {
    const cached = deviationFactsCache.get(watcherId)
    if (cached) return cached
    const latest = new Map<string, DeviationFact>()
    for (const entry of journal(watcherId)) {
      const fact = deviationFactFrom(entry)
      if (!fact) continue
      const previous = latest.get(fact.escalationId)
      if (!previous || fact.revision >= previous.revision) latest.set(fact.escalationId, fact)
    }
    deviationFactsCache.set(watcherId, latest)
    return latest
  }

  function appendDeviationRevision(
    watcherId: string,
    deviation: OwnerDeviation,
    status: DeviationStatus,
    resolved: boolean,
    reason?: string,
    foldObservation = false,
    releaseCleanup = false
  ): DeviationFact {
    const escalationId = deviationEscalationId(watcherId, deviation.naturalKey)
    const latest = latestDeviationFacts(watcherId)
    const prior = latest.get(escalationId)
    const revision = (prior?.revision ?? 0) + 1
    const foldCount = prior === undefined ? 1 : prior.foldCount + (foldObservation ? 1 : 0)
    host.store.transaction(() => {
      append(watcherId, 'owner-deviation', {
        escalationId,
        naturalKey: deviation.naturalKey,
        revision,
        foldCount,
        deviation,
        status,
        resolved,
        ...(reason === undefined ? {} : { reason })
      }, resolved, releaseCleanup)
      append(watcherId, 'escalation', {
        escalationId,
        naturalKey: deviation.naturalKey,
        revision,
        foldCount,
        status: resolved ? 'resolved' : 'open',
        detail: deviation.detail,
        deviation
      }, resolved, releaseCleanup)
    })
    const fact: DeviationFact = {
      escalationId, naturalKey: deviation.naturalKey, revision, foldCount, deviation, status, resolved,
      ...(reason === undefined ? {} : { reason })
    }
    latest.set(escalationId, fact)
    return fact
  }

  function upsertDeviation(watcherId: string, deviation: OwnerDeviation): DeviationFact | null {
    const escalationId = deviationEscalationId(watcherId, deviation.naturalKey)
    const previous = latestDeviationFacts(watcherId).get(escalationId)
    if (previous?.resolved) return appendDeviationRevision(watcherId, deviation, previous.status, true, previous.reason, true)
    if (previous?.status === 'released') return appendDeviationRevision(watcherId, deviation, 'open', false, undefined, true)
    return appendDeviationRevision(watcherId, deviation, previous?.status ?? 'open', false, previous?.reason, true)
  }


  function setDeviationStatus(
    watcherId: string,
    escalationId: string,
    status: DeviationStatus,
    resolved: boolean,
    reason?: string
  ): void {
    const previous = latestDeviationFacts(watcherId).get(escalationId)
    if (!previous || (previous.resolved && resolved)) return
    appendDeviationRevision(watcherId, previous.deviation, status, resolved, reason)
  }

  function reconcileQueue(watcherId: string, state: OwnerRuntimeState): boolean {
    const queued = new Set(state.queue)
    let changed = false
    for (const [id, fact] of latestDeviationFacts(watcherId)) {
      if (fact.resolved || fact.status !== 'open' || state.pending?.deviationId === id || queued.has(id)) continue
      state.queue.push(id)
      queued.add(id)
      changed = true
    }
    return changed
  }

  function clearError(state: OwnerRuntimeState): void {
    delete state.lastError
    delete state.lastErrorAtMs
  }

  function recordError(watcherId: string, state: OwnerRuntimeState, operation: string, error: unknown): string {
    const detail = errorMessage(error)
    state.lastError = `${operation}: ${detail}`
    state.lastErrorAtMs = nowMs(host)
    try {
      append(watcherId, 'owner-error', { operation, detail, ...(state.pending ? { reportKey: state.pending.reportKey, escalationId: state.pending.escalationId } : {}) })
      persistState(watcherId, state)
    } catch {
      // The in-memory inspection result still exposes the failure if the journal itself is unavailable.
    }
    return detail
  }

  function recordUncertainty(watcherId: string, state: OwnerRuntimeState, operation: string, error: unknown): string {
    const detail = errorMessage(error)
    if (state.pending) state.pending.phase = 'indeterminate'
    state.lastError = `${operation}: ${detail}`
    state.lastErrorAtMs = nowMs(host)
    try {
      append(watcherId, 'owner-error', {
        operation,
        detail,
        uncertainty: true,
        ...(state.pending ? { reportKey: state.pending.reportKey, escalationId: state.pending.escalationId, deviationId: state.pending.deviationId } : {})
      })
      if (state.pending) {
        setDeviationStatus(watcherId, state.pending.deviationId, 'indeterminate', false, detail)
        closeOwnerInterval(watcherId, state.pending, 'contact-lost')
      }
      persistState(watcherId, state)
    } catch {
      // No retry is attempted after an ambiguous external operation.
    }
    return detail
  }

  async function ensurePrivateDirectory(watcherId?: string): Promise<void> {
    if (watcherId === undefined) ensureOpen()
    else ensureWatcherOpen(watcherId)
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
    if (watcherId === undefined) ensureOpen()
    else ensureWatcherOpen(watcherId)
    const before = await lstat(reportDirectory)
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('owner report directory is not a regular directory')
    if ((before.mode & 0o077) !== 0) {
      if (watcherId === undefined) ensureOpen()
      else ensureWatcherOpen(watcherId)
      await chmod(reportDirectory, 0o700)
    }
    const after = await lstat(reportDirectory)
    if (after.isSymbolicLink() || !after.isDirectory() || (after.mode & 0o077) !== 0) {
      throw new Error('owner report directory is not private')
    }
  }

  function isOwnedReportPath(path: string): boolean {
    const resolvedPath = resolve(path)
    const relativePath = relative(reportDirectory, resolvedPath)
    return relativePath !== '' && relativePath !== '..' && !relativePath.startsWith(`..${sep}`) && !relativePath.includes(sep) && REPORT_FILENAME.test(basename(resolvedPath))
  }

  function forgetIssuedPath(watcherId: string, reportPath: string): void {
    issuedPaths.delete(reportPath)
    const paths = issuedPathsByWatcher.get(watcherId)
    paths?.delete(reportPath)
    if (paths?.size === 0) issuedPathsByWatcher.delete(watcherId)
  }

  async function unlinkIssuedReportFile(watcherId: string, reportPath: string): Promise<void> {
    if (!isOwnedReportPath(reportPath)) return
    try {
      await unlink(reportPath)
      forgetIssuedPath(watcherId, reportPath)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') forgetIssuedPath(watcherId, reportPath)
      else throw error
    }
  }

  async function createIssuedFile(watcherId: string): Promise<IssuedFile> {
    await ensurePrivateDirectory(watcherId)
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ensureWatcherOpen(watcherId)
      const reportKey = randomUUID()
      const reportPath = join(reportDirectory, `${randomUUID()}.json`)
      issuedPaths.add(reportPath)
      const paths = issuedPathsByWatcher.get(watcherId) ?? new Set<string>()
      paths.add(reportPath)
      issuedPathsByWatcher.set(watcherId, paths)
      let created = false
      try {
        const handle = await open(reportPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
        created = true
        await handle.close()
        try {
          ensureWatcherOpen(watcherId)
        } catch (error) {
          await unlinkIssuedReportFile(watcherId, reportPath).catch(() => undefined)
          throw error
        }
        return { reportKey, reportPath }
      } catch (error) {
        if (!created) forgetIssuedPath(watcherId, reportPath)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('could not allocate a unique owner report file')
  }

  async function readIssuedReport(watcherId: string, reportPath: string): Promise<OwnerIntervention> {
    if (!isOwnedReportPath(reportPath)) throw new Error('issued report path escaped its private directory')
    await ensurePrivateDirectory(watcherId)
    const before = await lstat(reportPath)
    if (before.isSymbolicLink() || !before.isFile()) throw new Error('issued report is not a regular file')
    if (before.size > MAX_OWNER_REPORT_BYTES) throw new Error('owner report exceeds the 64 KiB limit')
    if (fsConstants.O_NOFOLLOW === undefined) throw new Error('O_NOFOLLOW is unavailable for owner reports')
    const handle = await open(reportPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK)
    try {
      const opened = await handle.stat()
      if (!opened.isFile() || opened.isSymbolicLink()) throw new Error('issued report is not a regular file')
      if (opened.size > MAX_OWNER_REPORT_BYTES) throw new Error('owner report exceeds the 64 KiB limit')
      const buffer = Buffer.alloc(MAX_OWNER_REPORT_BYTES + 1)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
      const after = await handle.stat()
      if (bytesRead > MAX_OWNER_REPORT_BYTES || after.size > MAX_OWNER_REPORT_BYTES) throw new Error('owner report exceeds the 64 KiB limit')
      if (after.size !== bytesRead) throw new Error('owner report changed while it was being read')
      const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead))
      let value: unknown
      try {
        value = JSON.parse(text)
      } catch {
        throw new Error('owner report is not valid JSON')
      }
      return parseOwnerIntervention(value)
    } finally {
      await handle.close()
    }
  }

  function takeUtf8Prefix(value: string, maxBytes: number): string {
    let bytes = 0
    let result = ''
    for (const character of value) {
      const size = Buffer.byteLength(character, 'utf8')
      if (bytes + size > maxBytes) break
      result += character
      bytes += size
    }
    return result
  }

  function truncateBriefString(value: string, maxBytes: number): string {
    if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
    const marker = '…[truncated]'
    const markerBytes = Buffer.byteLength(marker, 'utf8')
    return markerBytes >= maxBytes ? takeUtf8Prefix(marker, maxBytes) : `${takeUtf8Prefix(value, maxBytes - markerBytes)}${marker}`
  }

  function boundedJson(value: unknown, maxBytes: number): string {
    const seen = new WeakSet<object>()
    let remainingNodes = 240
    function simplify(source: unknown, depth: number): unknown {
      remainingNodes -= 1
      if (remainingNodes < 0) return '[additional values truncated]'
      if (source === null || typeof source === 'boolean') return source
      if (typeof source === 'string') return truncateBriefString(source, 768)
      if (typeof source === 'number') return Number.isFinite(source) ? source : String(source)
      if (depth >= 6) return '[nested values truncated]'
      if (Array.isArray(source)) {
        const result: unknown[] = []
        let count = 0
        for (const item of source) {
          if (count >= 20 || remainingNodes <= 0) {
            result.push('[additional array values truncated]')
            break
          }
          result.push(simplify(item, depth + 1))
          count += 1
        }
        return result
      }
      if (typeof source !== 'object') return String(source)
      if (seen.has(source)) return '[repeated object omitted]'
      seen.add(source)
      const result = Object.create(null) as Record<string, unknown>
      let count = 0
      for (const key in source) {
        if (!Object.hasOwn(source, key)) continue
        if (count >= 24 || remainingNodes <= 0) {
          result['…'] = 'additional fields truncated'
          break
        }
        result[truncateBriefString(key, 120)] = simplify((source as Record<string, unknown>)[key], depth + 1)
        count += 1
      }
      seen.delete(source)
      return result
    }
    let text: string
    try {
      text = JSON.stringify(simplify(value, 0))
    } catch {
      return '[context unavailable: source is not serializable]'
    }
    if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
    const marker = `\n[context excerpt truncated at ${maxBytes} UTF-8 bytes]`
    return `${takeUtf8Prefix(text, Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8')))}${marker}`
  }

  function briefJournalFields(entry: JournalEntry, fields: string[]): Record<string, unknown> {
    const result: Record<string, unknown> = {
      seq: entry.seq,
      eventId: entry.eventId,
      atMs: entry.atMs,
      kind: entry.kind
    }
    for (const field of fields) {
      const value = entry[field]
      if (value !== undefined) result[field] = value
    }
    return result
  }

  function captureBriefContext(enrollment: OwnerEnrollment, snapshot: Snapshot, watcherId: string): string {
    const entries = journal(watcherId)
    const latestAttempts = new Map<string, JournalEntry>()
    for (const entry of entries) {
      if (entry.kind !== 'attempt' || typeof entry.attemptId !== 'string') continue
      const previous = latestAttempts.get(entry.attemptId)
      if (!previous || entry.seq >= previous.seq) latestAttempts.set(entry.attemptId, entry)
    }
    let registration: Record<string, unknown> | null = null
    try {
      const found = host.store.registrations().find((candidate) => candidate.id === enrollment.kind)
      if (found) registration = { id: found.id, displayName: found.displayName, pluginId: found.pluginId, hooks: found.hooks }
    } catch {
      registration = { id: enrollment.kind, unavailable: true }
    }
    const attempts = [...latestAttempts.values()]
      .filter((entry) => entry.resolved !== true)
      .sort((left, right) => left.seq - right.seq)
      .slice(-8)
      .map((entry) => briefJournalFields(entry, ['attemptId', 'fingerprint', 'state', 'action', 'dispatchId', 'requestId', 'effect', 'reason', 'generation', 'resolved']))
    const approvals = entries
      .filter((entry) => entry.kind === 'approval')
      .slice(-8)
      .map((entry) => briefJournalFields(entry, ['status', 'approvalScope', 'scope', 'reason', 'resolved']))
    const excludedEvidenceKinds = ['attempt', 'attempt-resolved', 'approval', 'turn']
    const evidence = entries
      .filter((entry) => !entry.kind.startsWith('owner-') && !entry.kind.startsWith('interval-') &&
        !excludedEvidenceKinds.includes(entry.kind) &&
        !(entry.kind === 'escalation' && typeof entry.escalationId === 'string' && entry.escalationId.startsWith('owner-deviation:')))
      .slice(-8)
      .map((entry) => briefJournalFields(entry, ['origin', 'resolved', 'evidenceKind', 'payload', 'status', 'detail', 'escalationId', 'dispatchId', 'messageId', 'runId', 'state', 'effect', 'reason']))
    const currentBudget = budgetUsage(entries, nowMs(host), enrollment.budget)
    return [
      'Issue-time source context; JSON excerpts and oversized values are explicitly truncated:',
      `Snapshot/world: ${boundedJson({ freshness: snapshot.freshness, contentIdentity: snapshot.contentIdentity, observedAtMs: snapshot.observedAtMs, world: snapshot.world }, 4_000)}`,
      `Enrollment: ${boundedJson({
        watcherId: enrollment.watcherId, kind: enrollment.kind, commandRevision: enrollment.commandRevision,
        workspaceKey: enrollment.workspaceKey, workspacePath: enrollment.workspacePath, executionHostId: enrollment.executionHostId,
        schedulerOwner: enrollment.schedulerOwner, repoId: enrollment.repoId, worktreeId: enrollment.worktreeId,
        orchestrationRunId: enrollment.orchestrationRunId, capabilities: enrollment.capabilities, budget: enrollment.budget,
        kindPayload: enrollment.kindPayload, owner: enrollment.owner ?? null
      }, 1_800)}`,
      `Kind registration/API hooks: ${boundedJson(registration, 1_200)}`,
      `Current budget usage: ${boundedJson({ policy: enrollment.budget, usage: currentBudget }, 700)}`,
      `Latest unresolved attempts: ${boundedJson(attempts, 1_800)}`,
      `Recent approvals: ${boundedJson(approvals, 1_000)}`,
      `Recent domain evidence: ${boundedJson(evidence, 1_800)}`
    ].join('\n')
  }

  function shellWord(value: string): string {
    if (/^[A-Za-z0-9._:-]+$/.test(value)) return value
    return `'${value.replaceAll("'", "'\\''")}'`
  }

  function reportCommand(watcherId: string, pending: OwnerRuntimePending): string {
    return `quirky heimdall owner-ready --watcher-id ${shellWord(watcherId)} --report-key ${shellWord(pending.reportKey)}`
  }

  function reportInstructions(watcherId: string, pending: OwnerRuntimePending): string {
    return [
      'Write exactly one JSON intervention object to the issued report file, then run the ready command below.',
      `Report key: ${pending.reportKey}`,
      `Report path: ${pending.reportPath}`,
      `Ready command: ${reportCommand(watcherId, pending)}`,
      'Supported proposal shapes: {"kind":"continue"}; {"kind":"ask-human","question":"..."}; {"kind":"abandon","reason":"..."}; {"kind":"answer-worker","dispatchId":"...","messageId":"...","body":"..."}; {"kind":"stop-worker","dispatchId":"..."}; {"kind":"message-worker","dispatchId":"...","body":"..."}; {"kind":"kind-action","action":...}.',
      'A proposal is not authority to act. Heimdall applies its ordinary owner-intervention, approval, capability, freshness and write-ahead gates.'
    ].join('\n')
  }

  function buildBrief(watcherId: string, pending: OwnerRuntimePending): string {
    const header = [
      `Heimdall owner turn for watcher ${watcherId}.`,
      `Deviation kind: ${pending.deviation.kind}`,
      `Natural key: ${pending.deviation.naturalKey}`,
      ...(pending.deviation.dispatchId === undefined ? [] : [`Dispatch ID: ${pending.deviation.dispatchId}`]),
      ...(pending.deviation.messageId === undefined ? [] : [`Message ID: ${pending.deviation.messageId}`]),
      ...(pending.deviation.trigger === undefined ? [] : [`Trigger: ${pending.deviation.trigger}`]),
      `Snapshot content identity: ${pending.contentIdentity}`,
      pending.briefContext,
      'Deviation detail:'
    ].join('\n') + '\n'
    const footer = `\n\n${reportInstructions(watcherId, pending)}`
    const available = OWNER_BRIEF_MAX_STATE_BYTES - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(footer, 'utf8')
    if (available < 0) throw new Error('owner report identity leaves no room for a bounded brief')
    let detail = pending.deviation.detail
    if (Buffer.byteLength(detail, 'utf8') > available) {
      const marker = '\n[deviation detail truncated to fit the 32 KiB UTF-8 brief]'
      const markerPart = takeUtf8Prefix(marker, available)
      const prefix = takeUtf8Prefix(detail, Math.max(0, available - Buffer.byteLength(markerPart, 'utf8')))
      detail = `${prefix}${markerPart}`
      while (Buffer.byteLength(header + detail + footer, 'utf8') > OWNER_BRIEF_MAX_STATE_BYTES && detail.length > 0) {
        detail = takeUtf8Prefix(detail, Buffer.byteLength(detail, 'utf8') - 4)
      }
    }
    const brief = `${header}${detail}${footer}`
    if (Buffer.byteLength(brief, 'utf8') > OWNER_BRIEF_MAX_STATE_BYTES) throw new Error('owner brief exceeds the 32 KiB UTF-8 limit')
    return brief
  }

  function answerPrompt(watcherId: string, body: string, pending: OwnerRuntimePending): string {
    return [
      'Human reply to the exact parked owner escalation, preserved verbatim:',
      body,
      '',
      'Continue the same owner conversation and produce a fresh proposal for the same deviation. Do not act directly.',
      reportInstructions(watcherId, pending)
    ].join('\n')
  }

  function intervalIsOpen(watcherId: string, intervalId: string): boolean {
    let open = false
    for (const entry of journal(watcherId)) {
      if (entry.intervalId !== intervalId) continue
      if (entry.kind === 'interval-open') open = true
      else if (entry.kind === 'interval-close') open = false
    }
    return open
  }

  function intervalCheckpointAt(watcherId: string, intervalId: string): number | undefined {
    let openedAtMs: number | undefined
    let checkpointAtMs: number | undefined
    for (const entry of journal(watcherId)) {
      if (entry.intervalId !== intervalId) continue
      if (entry.kind === 'interval-open' && typeof entry.atMs === 'number' && Number.isFinite(entry.atMs)) openedAtMs = entry.atMs
      else if (entry.kind === 'interval-checkpoint' && typeof entry.checkpointAtMs === 'number' && Number.isFinite(entry.checkpointAtMs)) {
        checkpointAtMs = entry.checkpointAtMs
      }
    }
    return checkpointAtMs ?? openedAtMs
  }

  function closeOwnerInterval(
    watcherId: string,
    pending: OwnerRuntimePending,
    reason: 'settled' | 'contact-lost' | 'shutdown',
    releaseCleanup = false
  ): void {
    const intervalId = pending.intervalId
    if (!intervalId) return
    if (intervalIsOpen(watcherId, intervalId)) {
      const checkpointAtMs = reason === 'contact-lost' ? intervalCheckpointAt(watcherId, intervalId) : nowMs(host)
      append(watcherId, 'interval-close', {
        intervalId,
        reason,
        ...(checkpointAtMs === undefined ? {} : { checkpointAtMs })
      }, true, releaseCleanup)
    }
    if (activeIntervals.get(watcherId) === intervalId) activeIntervals.delete(watcherId)
    delete pending.intervalId
  }

  function ensureOwnerInterval(watcherId: string, state: OwnerRuntimeState): void {
    const pending = state.pending
    if (!pending) throw new Error('cannot open an owner interval without a pending report')
    if (pending.intervalId && activeIntervals.get(watcherId) === pending.intervalId && intervalIsOpen(watcherId, pending.intervalId)) return
    const intervalId = randomUUID()
    append(watcherId, 'interval-open', { intervalId, cause: 'owner-in-flight' })
    pending.intervalId = intervalId
    activeIntervals.set(watcherId, intervalId)
    persistState(watcherId, state)
  }

  function pendingFromFact(
    watcherId: string,
    fact: DeviationFact,
    contentIdentity: string,
    briefContext: string,
    issued: IssuedFile,
    now: number
  ): OwnerRuntimePending {
    return {
      reportKey: issued.reportKey,
      reportPath: issued.reportPath,
      deviation: fact.deviation,
      escalationId: reportEscalationId(watcherId, issued.reportKey),
      issuedAtMs: now,
      lastWakeAtMs: now,
      wakeCount: 0,
      phase: 'issuing',
      contentIdentity,
      deviationId: fact.escalationId,
      briefContext
    }
  }

  function issueRecord(watcherId: string, pending: OwnerRuntimePending): void {
    append(watcherId, 'owner-report-issued', {
      reportKey: pending.reportKey,
      reportPath: pending.reportPath,
      escalationId: pending.escalationId,
      deviationId: pending.deviationId,
      naturalKey: pending.deviation.naturalKey,
      contentIdentity: pending.contentIdentity
    })
  }

  function returnedSessionId(value: unknown): string | null {
    return isRecord(value) && typeof value.id === 'string' && value.id.length > 0 ? value.id : null
  }

  function validateReturnedSession(value: unknown, sessionId: string): Session {
    if (!isRecord(value) || value.id !== sessionId || value.kind !== 'structured' || value.agent !== 'claude') {
      throw new Error('structured owner API returned an invalid Claude session')
    }
    return value as unknown as Session
  }

  function validateNativeSession(value: unknown, sessionId: string): Session {
    const session = validateReturnedSession(value, sessionId)
    const native = session.providerSession
    if (!isRecord(native) || typeof native.id !== 'string' || native.id.trim() === '') {
      throw new Error('owner session has no native Claude conversation identity')
    }
    return session
  }

  function validateSendReceipt(value: unknown): void {
    if (!isRecord(value) || value.ok !== true) throw new Error('structured owner send did not confirm success')
  }

  function persistReturnedSession(watcherId: string, state: OwnerRuntimeState, raw: unknown): Session {
    ensureWatcherOpen(watcherId)
    const sessionId = returnedSessionId(raw)
    if (!sessionId) throw new Error('structured owner call returned no session ID; conversation outcome is ambiguous')
    addOwnedSession(watcherId, sessionId)
    append(watcherId, 'owner-session', { sessionId, agent: 'claude', kind: 'structured' })
    state.sessionId = sessionId
    state.instanceId = instanceId
    if (state.requestedOwnerConfig) state.ownerConfig = state.requestedOwnerConfig
    state.ownerReleased = false
    state.releaseUncertain = false
    persistState(watcherId, state)
    return validateReturnedSession(raw, sessionId)
  }

  function deferDispatch(watcherId: string, state: OwnerRuntimeState): string {
    if (state.pending) {
      state.pending.phase = 'deferred'
      closeOwnerInterval(watcherId, state.pending, 'settled')
    }
    clearError(state)
    persistState(watcherId, state)
    return 'owner-dispatch-fenced'
  }

  async function ownerCall(watcherId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
    ensureWatcherOpen(watcherId)
    const result = await host.context.call(method, params)
    if (shuttingDown || releasedWatchers.has(watcherId)) {
      if (method === 'quirky.structured/create' || method === 'quirky.structured/resume') {
        try {
          const stopped = parseOwnedStopResult(await stopOwnedForWatcher(watcherId))
          if (stopped.unknown.length > 0) throw new Error('late keyed owner stop returned unknown owner connections')
        } catch (error) {
          releaseStopFailures.set(watcherId, error)
        }
      }
      throw new Error(shuttingDown ? 'owner controller is shutting down' : 'owner watcher is being released')
    }
    return result
  }

  async function deliverPending(
    watcherId: string,
    enrollment: OwnerEnrollment,
    state: OwnerRuntimeState,
    config: OwnerConfig,
    recovering: boolean
  ): Promise<string | null> {
    const pending = state.pending
    if (!pending) return 'owner turn has no pending report'
    pending.phase = 'issuing'
    clearError(state)
    try {
      ensureOpen()
      if (!isOwnedReportPath(pending.reportPath)) throw new Error('issued report path escaped its private directory')
      await ensurePrivateDirectory(watcherId)
      ensureWatcherOpen(watcherId)
      const reportFile = await lstat(pending.reportPath)
      ensureWatcherOpen(watcherId)
      if (reportFile.isSymbolicLink() || !reportFile.isFile()) throw new Error('issued report is not a regular file')
      const prompt = buildBrief(watcherId, pending)
      ensureOwnerInterval(watcherId, state)
      persistState(watcherId, state)
      if (state.sessionId === null) {
        if (host.canDispatch?.(watcherId) === false) return deferDispatch(watcherId, state)
        const raw = await ownerCall(watcherId, 'quirky.structured/create', {
          lifetime: 'plugin',
          lifetimeKey: watcherId,
          worktree: enrollment.worktreeId ? `id:${enrollment.worktreeId}` : `path:${enrollment.workspacePath}`,
          agent: 'claude',
          prompt,
          ...(config.model === undefined ? {} : { model: config.model }),
          ...(config.effort === undefined ? {} : { options: { effort: config.effort } })
        })
        persistReturnedSession(watcherId, state, raw)
      } else if (recovering) {
        const oldSessionId = state.sessionId
        if (!oldSessionId) throw new Error('owner session identity is missing during restart')
        const oldSession = await ownerCall(watcherId, 'quirky.session/get', { session: oldSessionId })
        validateNativeSession(oldSession, oldSessionId)
        if (host.canDispatch?.(watcherId) === false) return deferDispatch(watcherId, state)
        const raw = await ownerCall(watcherId, 'quirky.structured/resume', { lifetime: 'plugin', lifetimeKey: watcherId, session: oldSessionId, prompt })
        persistReturnedSession(watcherId, state, raw)
      } else {
        if (host.canDispatch?.(watcherId) === false) return deferDispatch(watcherId, state)
        validateSendReceipt(await ownerCall(watcherId, 'quirky.structured/send', { session: state.sessionId, text: prompt }))
      }
      ensureWatcherOpen(watcherId)
      pending.phase = 'waiting'
      pending.lastWakeAtMs = nowMs(host)
      pending.wakeCount = 0
      pending.parkCause = undefined
      state.instanceId = instanceId
      state.ownerConfig = config
      state.requestedOwnerConfig = config
      state.ownerReleased = false
      state.releaseUncertain = false
      clearError(state)
      persistState(watcherId, state)
      return null
    } catch (error) {
      if (shuttingDown) return 'owner controller is shutting down'
      return recordUncertainty(watcherId, state, recovering ? 'resume-owner' : state.sessionId === null ? 'create-owner' : 'send-owner', error)
    }
  }

  async function renewPendingReport(watcherId: string, state: OwnerRuntimeState): Promise<string | null> {
    const pending = state.pending
    if (!pending) return 'owner turn has no pending report'
    try {
      const oldPath = pending.reportPath
      const issued = await createIssuedFile(watcherId)
      const renewed: OwnerRuntimePending = {
        ...pending,
        reportKey: issued.reportKey,
        reportPath: issued.reportPath,
        escalationId: reportEscalationId(watcherId, issued.reportKey),
        issuedAtMs: nowMs(host),
        lastWakeAtMs: nowMs(host),
        wakeCount: 0,
        phase: 'issuing',
        ...(pending.intervention === undefined ? {} : { intervention: undefined })
      }
      delete renewed.intervention
      delete renewed.intervalId
      delete renewed.parkCause
      state.pending = renewed
      issueRecord(watcherId, renewed)
      persistState(watcherId, state)
      if (isOwnedReportPath(oldPath)) await unlinkIssuedReportFile(watcherId, oldPath).catch(() => undefined)
      return null
    } catch (error) {
      if (shuttingDown) return 'owner controller is shutting down'
      return recordUncertainty(watcherId, state, 'renew-owner-report', error)
    }
  }

  async function reportFileMissing(reportPath: string): Promise<boolean> {
    if (!isOwnedReportPath(reportPath)) return false
    try {
      const info = await lstat(reportPath)
      return info.isSymbolicLink() || !info.isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      throw error
    }
  }

  function takeNextFact(watcherId: string, state: OwnerRuntimeState): DeviationFact | null {
    const facts = latestDeviationFacts(watcherId)
    while (state.queue.length > 0) {
      const id = state.queue.shift()!
      const fact = facts.get(id)
      if (fact && fact.status === 'open' && !fact.resolved) return fact
    }
    return null
  }

  async function issueNext(
    watcherId: string,
    enrollment: OwnerEnrollment,
    snapshot: Snapshot,
    config: OwnerConfig,
    state: OwnerRuntimeState
  ): Promise<string | null> {
    const fact = takeNextFact(watcherId, state)
    if (!fact) {
      persistState(watcherId, state)
      return null
    }
    try {
      const issued = await createIssuedFile(watcherId)
      ensureWatcherOpen(watcherId)
      const briefContext = captureBriefContext(enrollment, snapshot, watcherId)
      const pending = pendingFromFact(watcherId, fact, snapshot.contentIdentity, briefContext, issued, nowMs(host))
      state.pending = pending
      state.requestedOwnerConfig = config
      state.ownerReleased = false
      state.releaseUncertain = false
      issueRecord(watcherId, pending)
      persistState(watcherId, state)
      return await deliverPending(watcherId, enrollment, state, config, state.sessionId !== null && state.instanceId !== instanceId)
    } catch (error) {
      if (shuttingDown) return 'owner controller is shutting down'
      return recordUncertainty(watcherId, state, 'issue-owner-report', error)
    }
  }

  function recordOutcome(watcherId: string, state: OwnerRuntimeState, kind: OwnerApplyResult['kind'], reason?: string): void {
    state.lastOutcome = { kind, ...(reason === undefined ? {} : { reason }) }
    append(watcherId, 'owner-intervention-result', {
      escalationId: state.pending?.escalationId,
      deviationId: state.pending?.deviationId,
      reportKey: state.pending?.reportKey,
      result: kind,
      ...(reason === undefined ? {} : { reason }),
      ...(state.pending?.intervention === undefined ? {} : { intervention: state.pending.intervention })
    }, kind === 'applied')
  }

  function parkOwner(watcherId: string, enrollment: OwnerEnrollment, state: OwnerRuntimeState, detail: string): void {
    const pending = state.pending
    if (!pending) return
    try {
      host.park(enrollment, pending.escalationId, detail)
    } catch (error) {
      recordError(watcherId, state, 'park-owner', error)
    }
  }

  async function applyReady(
    watcherId: string,
    enrollment: OwnerEnrollment,
    snapshot: Snapshot,
    state: OwnerRuntimeState
  ): Promise<OwnerStepResult> {
    const pending = state.pending
    if (!pending || pending.phase !== 'ready' || !pending.intervention) return { handled: false, reason: 'no ready owner intervention' }
    clearError(state)
    try {
      ensureOpen()
      const result = await host.apply(enrollment, pending.intervention, pending.deviation, snapshot)
      ensureWatcherOpen(watcherId)
      if (result.kind === 'held') {
        pending.phase = 'ready'
        state.lastOutcome = { kind: 'held', ...(result.reason === undefined ? {} : { reason: result.reason }) }
        append(watcherId, 'owner-intervention-result', {
          escalationId: pending.escalationId,
          deviationId: pending.deviationId,
          reportKey: pending.reportKey,
          result: 'held',
          ...(result.reason === undefined ? {} : { reason: result.reason }),
          intervention: pending.intervention
        })
        persistState(watcherId, state)
        return { handled: true, reason: result.reason ?? 'owner intervention remains held' }
      }
      recordOutcome(watcherId, state, result.kind, result.reason)
      if (result.kind === 'applied' && pending.intervention.kind === 'ask-human') {
        pending.phase = 'parked'
        pending.parkCause = 'ask-human'
        persistState(watcherId, state)
        parkOwner(watcherId, enrollment, state, pending.intervention.question)
        return { handled: true, reason: 'owner-human-escalation' }
      }
      if (result.kind === 'applied') {
        setDeviationStatus(watcherId, pending.deviationId, 'applied', true, result.reason)
        state.pending = null
        clearError(state)
        persistState(watcherId, state)
        if (state.queue.length > 0 && isActive(enrollment)) host.wake(watcherId)
        return { handled: true, reason: result.reason ?? 'owner intervention applied', nextCheckAtMs: nowMs(host) }
      }
      if (result.kind === 'refused') {
        setDeviationStatus(watcherId, pending.deviationId, 'refused', false, result.reason)
        state.pending = null
        persistState(watcherId, state)
        if (state.queue.length > 0 && isActive(enrollment)) host.wake(watcherId)
        return { handled: true, reason: result.reason ?? 'owner intervention refused', nextCheckAtMs: nowMs(host) }
      }
      pending.phase = 'indeterminate'
      setDeviationStatus(watcherId, pending.deviationId, 'indeterminate', false, result.reason)
      state.lastError = `apply-owner: ${result.reason ?? 'outcome is indeterminate'}`
      state.lastErrorAtMs = nowMs(host)
      closeOwnerInterval(watcherId, pending, 'contact-lost')
      persistState(watcherId, state)
      return { handled: true, reason: state.lastError }
    } catch (error) {
      if (shuttingDown) return { handled: true, reason: 'owner controller is shutting down' }
      const detail = recordUncertainty(watcherId, state, 'apply-owner', error)
      return { handled: true, reason: detail }
    }
  }

  async function silenceStep(
    watcherId: string,
    enrollment: OwnerEnrollment,
    state: OwnerRuntimeState,
    time: number
  ): Promise<OwnerStepResult> {
    const pending = state.pending
    if (!pending) return { handled: false }
    const dueAt = pending.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS
    if (time < dueAt) return { handled: true, nextCheckAtMs: dueAt }
    if (pending.wakeCount === 0) {
      const sessionId = state.sessionId
      if (!sessionId) {
        const detail = recordUncertainty(watcherId, state, 'remind-owner', new Error('owner session identity is missing'))
        return { handled: true, reason: detail }
      }
      try {
        if (host.canDispatch?.(watcherId) === false) return { handled: true, reason: 'owner-dispatch-fenced' }
        pending.phase = 'indeterminate'
        pending.wakeCount = 1
        pending.lastWakeAtMs = time
        clearError(state)
        persistState(watcherId, state)
        const reminder = `one reminder: finish the current owner report and run ${reportCommand(watcherId, pending)}. Write the proposal to ${pending.reportPath}.`
        validateSendReceipt(await ownerCall(watcherId, 'quirky.structured/send', { session: sessionId, text: reminder }))
        ensureWatcherOpen(watcherId)
        pending.phase = 'waiting'
        persistState(watcherId, state)
        return { handled: true, nextCheckAtMs: pending.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS }
      } catch (error) {
        if (shuttingDown) return { handled: true, reason: 'owner controller is shutting down' }
        const detail = recordUncertainty(watcherId, state, 'remind-owner', error)
        return { handled: true, reason: detail }
      }
    }
    try {
      pending.phase = 'parked'
      pending.parkCause = 'silence'
      const detail = 'Owner remained silent after one reminder; awaiting the exact owner-escalation answer.'
      closeOwnerInterval(watcherId, pending, 'contact-lost')
      persistState(watcherId, state)
      parkOwner(watcherId, enrollment, state, detail)
      return { handled: true, reason: 'owner-escalation' }
    } catch (error) {
      if (shuttingDown) return { handled: true, reason: 'owner controller is shutting down' }
      const detail = recordError(watcherId, state, 'park-silent-owner', error)
      return { handled: true, reason: detail }
    }
  }

  function stopOwnedForWatcher(watcherId: string): Promise<unknown> {
    const running = releaseStopWork.get(watcherId)
    if (running) return running
    const work = Promise.resolve().then(() => host.context.call('quirky.structured/stopOwned', { key: watcherId }))
    releaseStopWork.set(watcherId, work)
    void work.then(
      () => { if (releaseStopWork.get(watcherId) === work) releaseStopWork.delete(watcherId) },
      () => { if (releaseStopWork.get(watcherId) === work) releaseStopWork.delete(watcherId) }
    )
    return work
  }

  function ownerStateHasResources(watcherId: string, state: OwnerRuntimeState): boolean {
    const localResources = state.sessionId !== null || state.pending !== null || state.queue.length > 0 ||
      state.ownerConfig !== undefined || state.requestedOwnerConfig !== undefined || state.releaseUncertain === true ||
      (ownerSessions.get(watcherId)?.size ?? 0) > 0 || (issuedPathsByWatcher.get(watcherId)?.size ?? 0) > 0 ||
      activeIntervals.has(watcherId) || releaseStopFailures.has(watcherId)
    if (state.ownerReleased === true && !state.releaseUncertain && state.sessionId === null && state.pending === null &&
      state.requestedOwnerConfig === undefined && state.queue.length === 0 &&
      (ownerSessions.get(watcherId)?.size ?? 0) === 0 && (issuedPathsByWatcher.get(watcherId)?.size ?? 0) === 0 &&
      !activeIntervals.has(watcherId) && !releaseStopFailures.has(watcherId)) return false
    if (localResources) return true
    try {
      return journal(watcherId).some((entry) =>
        entry.kind === 'owner-state' || entry.kind === 'owner-session' || entry.kind === 'owner-report-issued' || entry.kind === 'owner-deviation'
      )
    } catch {
      return false
    }
  }

  function recordReleaseUncertainty(watcherId: string, state: OwnerRuntimeState, error: unknown): false {
    const detail = errorMessage(error)
    state.ownerReleased = false
    state.releaseUncertain = true
    state.lastError = `release-owner: ${detail}`
    state.lastErrorAtMs = nowMs(host)
    try {
      append(watcherId, 'owner-error', { operation: 'release-owner', detail, uncertainty: true }, false, true)
      persistState(watcherId, state, true)
    } catch {
      stateCache.set(watcherId, cloneState(state))
    }
    return false
  }

  function parseOwnedStopResult(value: unknown): { stopped: string[]; unknown: string[] } {
    const result = exactShape(value, ['stopped', 'unknown'], [], 'owned stop result')
    if (!Array.isArray(result.stopped) || !Array.isArray(result.unknown) ||
      result.stopped.some((id) => typeof id !== 'string' || id.length === 0) ||
      result.unknown.some((id) => typeof id !== 'string' || id.length === 0)) {
      throw new Error('owned stop result is malformed')
    }
    return { stopped: result.stopped as string[], unknown: result.unknown as string[] }
  }

  async function removeOwnedReportFiles(paths: Set<string>): Promise<void> {
    if (paths.size === 0) return
    await ensurePrivateDirectory()
    for (const reportPath of paths) {
      if (!isOwnedReportPath(reportPath)) continue
      let info: Stats
      try {
        info = await lstat(reportPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      if (!info.isFile() && !info.isSymbolicLink()) throw new Error('issued report path is not a regular file')
      await unlink(reportPath)
    }
  }

  async function performWatcherRelease(
    watcherId: string,
    reason: 'owner-removed' | 'config-changed',
    nextConfig: OwnerConfig | undefined,
    waitForOperation: boolean
  ): Promise<boolean> {
    const deadlineAtMs = Date.now() + OWNER_SHUTDOWN_TIMEOUT_MS
    releasedWatchers.add(watcherId)
    const state = readState(watcherId)
    if (!ownerStateHasResources(watcherId, state)) {
      if (state.ownerReleased !== true) releasedWatchers.delete(watcherId)
      ownerRemovalRequested.delete(watcherId)
      return true
    }
    const retryingLateStop = releaseStopFailures.has(watcherId)
    releaseStopFailures.delete(watcherId)
    const priorConfig = state.ownerConfig ?? state.requestedOwnerConfig
    const ownerPaths = new Set(issuedPathsByWatcher.get(watcherId) ?? [])
    const pending = state.pending
    if (pending && isOwnedReportPath(pending.reportPath)) ownerPaths.add(pending.reportPath)
    let journalEntries: JournalEntry[] = []
    try {
      journalEntries = journal(watcherId)
      for (const entry of journalEntries) {
        if (entry.kind === 'owner-report-issued' && typeof entry.reportPath === 'string' && isOwnedReportPath(entry.reportPath)) {
          ownerPaths.add(entry.reportPath)
        }
      }
    } catch {
      // The in-memory per-watcher report inventory remains available after enrollment removal.
    }
    const journalHasOwnerAttempt = journalEntries.some((entry) => entry.kind === 'owner-session' || entry.kind === 'owner-report-issued')
    const hasCurrentConfig = state.ownerConfig !== undefined || state.requestedOwnerConfig !== undefined
    const shouldStop = state.sessionId !== null || state.releaseUncertain === true || retryingLateStop ||
      (ownerSessions.get(watcherId)?.size ?? 0) > 0 ||
      (state.ownerReleased !== true && (pending !== null || hasCurrentConfig || journalHasOwnerAttempt))
    let localError: unknown
    if (pending) {
      try {
        if (shuttingDown && pending.intervalId) activeIntervals.set(watcherId, pending.intervalId)
        else if (watcherCanWrite(watcherId)) closeOwnerInterval(watcherId, pending, 'settled', true)
        else if (watcherExists(watcherId)) {
          if (pending.intervalId) activeIntervals.set(watcherId, pending.intervalId)
          localError ??= new Error('owner interval could not be closed because the journal is read-only')
        }
        else {
          activeIntervals.delete(watcherId)
          delete pending.intervalId
        }
      } catch (error) {
        localError = error
        if (!shuttingDown && !watcherExists(watcherId)) {
          activeIntervals.delete(watcherId)
          delete pending.intervalId
        }
      }
    }
    const activeIntervalId = activeIntervals.get(watcherId)
    if (activeIntervalId && !shuttingDown) {
      let intervalClosed = false
      try {
        if (watcherCanWrite(watcherId)) {
          if (intervalIsOpen(watcherId, activeIntervalId)) {
            append(watcherId, 'interval-close', { intervalId: activeIntervalId, reason: 'settled', checkpointAtMs: nowMs(host) }, true, true)
          }
          intervalClosed = true
        } else if (watcherExists(watcherId)) {
          localError ??= new Error('owner interval could not be closed because the journal is read-only')
        } else {
          intervalClosed = true
        }
      } catch (error) {
        localError ??= error
      }
      if (intervalClosed) activeIntervals.delete(watcherId)
    }

    let facts = new Map<string, DeviationFact>()
    try {
      facts = latestDeviationFacts(watcherId)
    } catch (error) {
      localError ??= error
    }
    const resetQueue: string[] = []
    const queued = new Set<string>()
    const enqueue = (id: string): void => {
      const fact = facts.get(id)
      if (fact && fact.resolved) return
      if (!queued.has(id)) {
        queued.add(id)
        resetQueue.push(id)
      }
    }
    if (reason === 'config-changed') {
      if (pending) enqueue(pending.deviationId)
      for (const id of state.queue) enqueue(id)
      for (const [id, fact] of facts) if (!fact.resolved) enqueue(id)
    } else if (pending) {
      enqueue(pending.deviationId)
    }
    const reopenIds = reason === 'config-changed' ? resetQueue : pending ? [pending.deviationId] : []
    for (const id of reopenIds) {
      const fact = facts.get(id)
      if (!fact || fact.resolved || fact.status === 'open') continue
      if (!watcherCanWrite(watcherId)) {
        localError ??= new Error('owner deviation status could not be reset')
        continue
      }
      try {
        const reopened = appendDeviationRevision(
          watcherId, fact.deviation, 'open', false, reason === 'config-changed' ? 'config-changed' : 'owner-removed', false, true
        )
        facts.set(id, reopened)
      } catch (error) {
        localError ??= error
      }
    }

    state.pending = null
    state.sessionId = null
    state.queue = reason === 'config-changed' ? resetQueue : []
    if (reason === 'config-changed' && nextConfig) state.requestedOwnerConfig = nextConfig
    else delete state.requestedOwnerConfig
    state.ownerReleased = false
    state.releaseUncertain = true
    state.lastError = 'release-owner: release is in progress'
    state.lastErrorAtMs = nowMs(host)
    try {
      persistState(watcherId, state, true)
    } catch (error) {
      localError ??= error
    }

    const hadActiveOperation = waitForOperation && activeWatcherOperations.has(watcherId)
    const watcherOperation = hadActiveOperation ? watcherLocks.get(watcherId) : undefined
    const stopOutcome = shouldStop
      ? stopOwnedForWatcher(watcherId).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
      : Promise.resolve({ ok: true as const, value: { stopped: [], unknown: [] } })
    const fileOutcome = removeOwnedReportFiles(ownerPaths).then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error })
    )
    const [operationSettled, stopSettled, filesSettled] = await Promise.all([
      watcherOperation ? waitUntilOwnerShutdownDeadline(watcherOperation, deadlineAtMs) : Promise.resolve(true),
      waitUntilOwnerShutdownDeadline(stopOutcome, deadlineAtMs),
      waitUntilOwnerShutdownDeadline(fileOutcome, deadlineAtMs)
    ])
    let stopResult: { stopped: string[]; unknown: string[] } | null = null
    if (!stopSettled) localError ??= new Error('keyed owner stop exceeded the release deadline')
    else {
      const outcome = await stopOutcome
      if (!outcome.ok) localError ??= outcome.error
      else {
        try {
          stopResult = parseOwnedStopResult(outcome.value)
          if (stopResult.unknown.length > 0) localError ??= new Error('keyed owner stop returned unknown owner connections')
        } catch (error) {
          localError ??= error
        }
      }
    }
    if (!filesSettled) localError ??= new Error('owner report cleanup exceeded the release deadline')
    else {
      const outcome = await fileOutcome
      if (!outcome.ok) localError ??= outcome.error
      else {
        for (const reportPath of ownerPaths) issuedPaths.delete(reportPath)
        issuedPathsByWatcher.delete(watcherId)
      }
    }
    if (hadActiveOperation && !operationSettled) localError ??= new Error('an owner operation remained in flight at release deadline')
    if (!localError && shouldStop && hadActiveOperation && stopResult) {
      const finalStop = stopOwnedForWatcher(watcherId).then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
      if (!await waitUntilOwnerShutdownDeadline(finalStop, deadlineAtMs)) localError = new Error('final keyed owner stop exceeded the release deadline')
      else {
        const outcome = await finalStop
        if (!outcome.ok) localError = outcome.error
        else {
          try {
            const result = parseOwnedStopResult(outcome.value)
            if (result.unknown.length > 0) localError = new Error('final keyed owner stop returned unknown owner connections')
          } catch (error) {
            localError = error
          }
        }
      }
    }
    if (releaseStopFailures.has(watcherId)) localError ??= releaseStopFailures.get(watcherId)
    if (localError) return recordReleaseUncertainty(watcherId, state, localError)

    const removeAfterRelease = reason === 'owner-removed' || ownerRemovalRequested.has(watcherId)
    if (watcherCanWrite(watcherId)) {
      try {
        append(watcherId, 'owner-reset', {
          reason,
          ...(priorConfig === undefined ? {} : { previousConfig: priorConfig }),
          ...(reason === 'config-changed' && nextConfig ? { requestedConfig: nextConfig } : {})
        }, false, true)
        if (reason === 'config-changed' && removeAfterRelease) {
          append(watcherId, 'owner-reset', {
            reason: 'owner-removed',
            ...(nextConfig === undefined ? {} : { previousConfig: nextConfig })
          }, false, true)
        }
      } catch (error) {
        return recordReleaseUncertainty(watcherId, state, error)
      }
    }
    if (reason === 'config-changed') delete state.ownerConfig
    if (removeAfterRelease) delete state.requestedOwnerConfig
    else if (nextConfig) state.requestedOwnerConfig = nextConfig
    state.sessionId = null
    state.pending = null
    state.queue = reason === 'config-changed' && !removeAfterRelease ? resetQueue : []
    state.ownerReleased = true
    state.releaseUncertain = false
    state.instanceId = instanceId
    clearError(state)
    try {
      persistState(watcherId, state, true)
    } catch (error) {
      return recordReleaseUncertainty(watcherId, state, error)
    }
    ownerSessions.delete(watcherId)
    releaseStopFailures.delete(watcherId)
    activeIntervals.delete(watcherId)
    if (reason === 'config-changed' && !removeAfterRelease) releasedWatchers.delete(watcherId)
    if (removeAfterRelease) ownerRemovalRequested.delete(watcherId)
    return true
  }

  function beginWatcherRelease(
    watcherId: string,
    reason: 'owner-removed' | 'config-changed',
    nextConfig?: OwnerConfig,
    waitForOperation = true
  ): Promise<boolean> {
    if (reason === 'owner-removed') ownerRemovalRequested.add(watcherId)
    releasedWatchers.add(watcherId)
    const running = releaseWork.get(watcherId)
    if (running) {
      if (reason !== 'owner-removed' || releaseWorkReasons.get(watcherId) !== 'config-changed') return running
      const followup = running.then((confirmed) => {
        if (!confirmed) return false
        releaseWork.delete(watcherId)
        releaseWorkReasons.delete(watcherId)
        return beginWatcherRelease(watcherId, 'owner-removed', undefined, waitForOperation)
      }, () => false)
      releaseWork.set(watcherId, followup)
      releaseWorkReasons.set(watcherId, 'owner-removed')
      void followup.then(
        () => {
          if (releaseWork.get(watcherId) === followup) {
            releaseWork.delete(watcherId)
            releaseWorkReasons.delete(watcherId)
          }
        },
        () => {
          if (releaseWork.get(watcherId) === followup) {
            releaseWork.delete(watcherId)
            releaseWorkReasons.delete(watcherId)
          }
        }
      )
      return followup
    }
    const work = performWatcherRelease(watcherId, reason, nextConfig, waitForOperation)
    releaseWork.set(watcherId, work)
    releaseWorkReasons.set(watcherId, reason)
    void work.then(
      () => {
        if (releaseWork.get(watcherId) === work) {
          releaseWork.delete(watcherId)
          releaseWorkReasons.delete(watcherId)
        }
      },
      () => {
        if (releaseWork.get(watcherId) === work) {
          releaseWork.delete(watcherId)
          releaseWorkReasons.delete(watcherId)
        }
      }
    )
    return work
  }

  async function stepLocked(enrollment: OwnerEnrollment, snapshot: Snapshot, deviations: OwnerDeviation[]): Promise<OwnerStepResult> {
    const watcherId = enrollment.watcherId
    let config: OwnerConfig | null
    try {
      config = parseOwnerConfig(enrollment.owner)
    } catch (error) {
      const state = readState(watcherId)
      if (ownerStateHasResources(watcherId, state)) recordError(watcherId, state, 'parse-owner-config', error)
      return { handled: false, reason: errorMessage(error) }
    }
    let state = readState(watcherId)
    if (!config) {
      if (!ownerStateHasResources(watcherId, state)) return { handled: false, reason: 'owner is not configured' }
      const released = await beginWatcherRelease(watcherId, 'owner-removed', undefined, false)
      if (released) return { handled: false, reason: 'owner is not configured' }
      state = readState(watcherId)
      return { handled: true, reason: state.lastError ?? 'owner release is uncertain' }
    }
    if (releasedWatchers.has(watcherId)) {
      if (state.ownerReleased === true && !state.releaseUncertain) releasedWatchers.delete(watcherId)
      else return { handled: true, reason: state.lastError ?? 'owner watcher is being released' }
    }
    if (state.releaseUncertain) return { handled: true, reason: state.lastError ?? 'owner release is uncertain' }

    let stateChanged = false
    try {
      for (const candidate of deviations) {
        let parsed: OwnerDeviation
        try {
          parsed = parseOwnerDeviation(candidate)
        } catch (error) {
          recordError(watcherId, state, 'invalid-owner-deviation', error)
          continue
        }
        const fact = upsertDeviation(watcherId, parsed)
        if (fact && !fact.resolved && fact.status === 'open' && state.pending?.deviationId !== fact.escalationId && !state.queue.includes(fact.escalationId)) {
          state.queue.push(fact.escalationId)
          stateChanged = true
        }
        if (state.pending?.deviationId === fact?.escalationId && fact && !fact.resolved && JSON.stringify(state.pending.deviation) !== JSON.stringify(fact.deviation)) {
          state.pending.deviation = fact.deviation
          stateChanged = true
        }
      }
      if (reconcileQueue(watcherId, state)) stateChanged = true
      if (stateChanged) persistState(watcherId, state)
    } catch (error) {
      if (shuttingDown) return { handled: false, reason: 'owner controller is shutting down' }
      const detail = recordError(watcherId, state, 'record-owner-deviation', error)
      return { handled: false, reason: detail }
    }

    const storedConfig = state.requestedOwnerConfig ?? state.ownerConfig
    const hasPersistedConversation = state.sessionId !== null || state.pending !== null || storedConfig !== undefined
    const configChanged = state.ownerReleased !== true && hasPersistedConversation &&
      (storedConfig === undefined || !sameOwnerConfig(storedConfig, config))
    if (configChanged) {
      const released = await beginWatcherRelease(watcherId, 'config-changed', config, false)
      state = readState(watcherId)
      if (!released || state.releaseUncertain) return { handled: true, reason: state.lastError ?? 'owner release is uncertain' }
      if (releasedWatchers.has(watcherId)) return { handled: true, reason: 'owner watcher is being released' }
      stateChanged = true
    } else if (state.ownerReleased === true) {
      releasedWatchers.delete(watcherId)
      if (state.ownerConfig && !sameOwnerConfig(state.ownerConfig, config)) {
        try {
          append(watcherId, 'owner-reset', { reason: 'config-changed', previousConfig: state.ownerConfig, requestedConfig: config })
          delete state.ownerConfig
          state.requestedOwnerConfig = config
          persistState(watcherId, state)
          stateChanged = true
        } catch (error) {
          const detail = recordError(watcherId, state, 'record-owner-reset', error)
          return { handled: true, reason: detail }
        }
      }
    }
    if (state.releaseUncertain) return { handled: true, reason: state.lastError ?? 'owner release is uncertain' }

    // Reconcile a durable attempt even if that attempt itself parked or disarmed the watcher.
    // The host stages proposals only; the runner still owns every effect and commit fence.
    if (state.pending?.phase === 'ready') return applyReady(watcherId, enrollment, snapshot, state)
    if (!isActive(enrollment)) return { handled: stateChanged || state.pending !== null, reason: 'owner work is paused or disarmed' }
    if (state.pending?.phase === 'deferred') {
      const error = await deliverPending(watcherId, enrollment, state, config, Boolean(state.sessionId && state.instanceId !== instanceId))
      return { handled: true, ...(error ? { reason: error } : { nextCheckAtMs: state.pending!.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS }) }
    }
    if (state.pending?.phase === 'issuing') {
      const detail = recordUncertainty(watcherId, state, 'recover-owner-turn', new Error('an earlier create, send, or resume has an unknown outcome'))
      return { handled: true, reason: detail }
    }
    if (state.pending?.phase === 'indeterminate') return { handled: true, reason: state.lastError ?? 'owner operation is indeterminate' }
    if (state.pending?.phase === 'parked') return { handled: true, reason: 'owner is parked for an exact escalation answer' }
    if (state.pending?.phase === 'waiting') {
      const pending = state.pending
      const recovering = Boolean(state.sessionId && state.instanceId !== instanceId)
      try {
        if (!isOwnedReportPath(pending.reportPath)) throw new Error('issued report path escaped its private directory')
        await ensurePrivateDirectory(watcherId)
        ensureWatcherOpen(watcherId)
        const missing = await reportFileMissing(pending.reportPath)
        ensureWatcherOpen(watcherId)
        if (missing) {
          const renewalError = await renewPendingReport(watcherId, state)
          if (renewalError) return { handled: true, reason: renewalError }
          const deliveryError = await deliverPending(watcherId, enrollment, state, config, recovering)
          if (deliveryError) return { handled: true, reason: deliveryError }
          return { handled: true, nextCheckAtMs: state.pending!.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS }
        }
      } catch (error) {
        if (shuttingDown) return { handled: true, reason: 'owner controller is shutting down' }
        const detail = recordUncertainty(watcherId, state, 'validate-owner-report', error)
        return { handled: true, reason: detail }
      }
      if (recovering) {
        const error = await deliverPending(watcherId, enrollment, state, config, true)
        if (error) return { handled: true, reason: error }
        return { handled: true, nextCheckAtMs: state.pending!.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS }
      }
      return silenceStep(watcherId, enrollment, state, nowMs(host))
    }
    if (state.pending === null && state.queue.length > 0) {
      const error = await issueNext(watcherId, enrollment, snapshot, config, state)
      if (error) return { handled: true, reason: error }
      return { handled: true, nextCheckAtMs: state.pending ? state.pending.lastWakeAtMs + OWNER_STALL_THRESHOLD_MS : undefined }
    }
    if (stateChanged) persistState(watcherId, state)
    return { handled: stateChanged }
  }

  function rejectedReport(watcherId: string, state: OwnerRuntimeState, reportKey: string, reason: string): void {
    state.lastError = `ready-owner-report: ${reason}`
    state.lastErrorAtMs = nowMs(host)
    try {
      append(watcherId, 'owner-report-rejected', {
        ...(reportKey.length <= 128 ? { reportKey } : { reportKey: '[oversized]' }),
        reason,
        ...(state.pending ? { currentReportKey: state.pending.reportKey, escalationId: state.pending.escalationId } : {})
      })
      persistState(watcherId, state)
    } catch {
      // A rejected report remains refused even if its diagnostic cannot be journaled.
    }
  }

  async function readyLocked(watcherId: string, reportKey: string): Promise<{ kind: 'accepted' | 'refused'; reason?: string }> {
    const state = readState(watcherId)
    const pending = state.pending
    if (!pending || typeof reportKey !== 'string' || pending.reportKey !== reportKey || pending.phase !== 'waiting') {
      const reason = !pending ? 'there is no outstanding owner report' : pending.reportKey === reportKey ? 'owner report was already accepted or is not waiting' : 'report key is stale or does not match the issued report'
      rejectedReport(watcherId, state, typeof reportKey === 'string' ? reportKey : '', reason)
      return { kind: 'refused', reason }
    }
    let intervention: OwnerIntervention
    try {
      intervention = await readIssuedReport(watcherId, pending.reportPath)
    } catch (error) {
      const reason = errorMessage(error)
      rejectedReport(watcherId, state, reportKey, reason)
      return { kind: 'refused', reason }
    }
    ensureWatcherOpen(watcherId)
    pending.intervention = intervention
    pending.phase = 'ready'
    pending.parkCause = undefined
    clearError(state)
    append(watcherId, 'owner-report-accepted', {
      reportKey,
      reportPath: pending.reportPath,
      escalationId: pending.escalationId,
      deviationId: pending.deviationId,
      intervention
    })
    persistState(watcherId, state)
    closeOwnerInterval(watcherId, pending, 'settled')
    persistState(watcherId, state)
    const enrollment = host.store.get(watcherId) as OwnerEnrollment | null
    if (enrollment && isActive(enrollment)) {
      try {
        host.wake(watcherId)
      } catch (error) {
        recordError(watcherId, state, 'wake-owner', error)
      }
    }
    return { kind: 'accepted' }
  }

  async function answerLocked(watcherId: string, escalationId: string, body: string): Promise<OwnerStepResult> {
    const state = readState(watcherId)
    const pending = state.pending
    if (!pending || pending.phase !== 'parked' || pending.escalationId !== escalationId) {
      return { handled: false, reason: 'not-current-owner-escalation' }
    }
    if (typeof body !== 'string' || body.trim() === '') return { handled: false, reason: 'owner answer body must be a non-empty string' }
    const ownerSessionId = state.sessionId
    if (!ownerSessionId) {
      recordUncertainty(watcherId, state, 'answer-owner-escalation', new Error('parked owner session identity is missing'))
      return { handled: true, reason: 'owner-answer-indeterminate' }
    }
    const enrollment = host.store.get(watcherId) as OwnerEnrollment | null
    if (!enrollment) return { handled: false, reason: 'owner enrollment is no longer available' }
    const oldPending = pending
    const oldReportPath = oldPending.reportPath
    const recovering = state.instanceId !== instanceId
    let issued: IssuedFile
    try {
      issued = await createIssuedFile(watcherId)
      ensureWatcherOpen(watcherId)
    } catch (error) {
      const reason = errorMessage(error)
      recordError(watcherId, state, 'issue-owner-answer-report', error)
      return { handled: false, reason: `owner-answer-not-sent: ${reason}` }
    }
    const renewed: OwnerRuntimePending = {
      ...oldPending,
      reportKey: issued.reportKey,
      reportPath: issued.reportPath,
      escalationId: reportEscalationId(watcherId, issued.reportKey),
      issuedAtMs: nowMs(host),
      lastWakeAtMs: nowMs(host),
      wakeCount: 0,
      phase: 'issuing',
      contentIdentity: oldPending.contentIdentity,
      deviation: oldPending.deviation,
      ...(oldPending.intervention === undefined ? {} : { intervention: undefined })
    }
    delete renewed.intervention
    delete renewed.parkCause
    delete renewed.intervalId
    state.pending = renewed
    clearError(state)
    try {
      issueRecord(watcherId, renewed)
      persistState(watcherId, state)
      if (isOwnedReportPath(oldReportPath)) await unlinkIssuedReportFile(watcherId, oldReportPath).catch(() => undefined)
      ensureWatcherOpen(watcherId)
      ensureOwnerInterval(watcherId, state)
      persistState(watcherId, state)
      const prompt = answerPrompt(watcherId, body, renewed)
      if (recovering) {
        const oldSession = await ownerCall(watcherId, 'quirky.session/get', { session: ownerSessionId })
        validateNativeSession(oldSession, ownerSessionId)
        const resumedRaw = await ownerCall(watcherId, 'quirky.structured/resume', { lifetime: 'plugin', lifetimeKey: watcherId, session: ownerSessionId, prompt })
        persistReturnedSession(watcherId, state, resumedRaw)
      } else {
        validateSendReceipt(await ownerCall(watcherId, 'quirky.structured/send', { session: ownerSessionId, text: prompt }))
      }
      ensureWatcherOpen(watcherId)
      renewed.phase = 'waiting'
      renewed.lastWakeAtMs = nowMs(host)
      renewed.wakeCount = 0
      renewed.parkCause = undefined
      state.instanceId = instanceId
      clearError(state)
      persistState(watcherId, state)
      return { handled: true, reason: 'owner-answer-sent' }
    } catch (error) {
      if (shuttingDown) return { handled: true, reason: 'owner-answer-indeterminate' }
      recordUncertainty(watcherId, state, 'answer-owner-escalation', error)
      return { handled: true, reason: 'owner-answer-indeterminate' }
    }
  }

  function withWatcherLock<T>(watcherId: string, action: () => Promise<T>, allowReleased = false): Promise<T> {
    const previous = watcherLocks.get(watcherId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(async () => {
      if (allowReleased && releasedWatchers.has(watcherId)) {
        if (releaseWork.has(watcherId)) throw new Error('owner watcher is being released')
        const state = readState(watcherId)
        if (state.ownerReleased === true && !state.releaseUncertain) releasedWatchers.delete(watcherId)
      }
      ensureWatcherOpen(watcherId)
      activeWatcherOperations.add(watcherId)
      try {
        return await action()
      } finally {
        activeWatcherOperations.delete(watcherId)
      }
    })
    const tail = operation.then(() => undefined, () => undefined)
    watcherLocks.set(watcherId, tail)
    activeOperations.add(operation)
    void operation.then(() => activeOperations.delete(operation), () => activeOperations.delete(operation))
    return operation
  }

  function inspect(watcherId: string): OwnerState {
    const state = readState(watcherId)
    if (!state.ownerReleased && !state.releaseUncertain) reconcileQueue(watcherId, state)
    return cloneState(state) as OwnerState
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    const deadlineAtMs = Date.now() + OWNER_SHUTDOWN_TIMEOUT_MS
    shuttingDown = true
    shutdownPromise = (async () => {
      await waitUntilOwnerShutdownDeadline(Promise.allSettled([...activeOperations, ...releaseWork.values()]), deadlineAtMs)
      for (const [watcherId, intervalId] of activeIntervals) {
        try {
          if (intervalIsOpen(watcherId, intervalId) && watcherCanWrite(watcherId)) {
            host.store.append(watcherId, {
              class: 'fact', origin: 'owner', kind: 'interval-close', resolved: true,
              eventId: `owner:${randomUUID()}`, atMs: nowMs(host), intervalId, reason: 'shutdown', checkpointAtMs: nowMs(host)
            })
          }
        } catch {
          // Shutdown still attempts to stop owned sessions and remove issued files.
        }
      }
      activeIntervals.clear()
      const allOwnedSessions = new Set<string>()
      for (const sessionIds of ownerSessions.values()) for (const sessionId of sessionIds) allOwnedSessions.add(sessionId)
      const reportPaths = new Set(issuedPaths)
      try {
        for (const enrollment of host.store.list()) {
          for (const entry of host.store.journal(enrollment.watcherId)) {
            if (entry.kind === 'owner-session' && typeof entry.sessionId === 'string') allOwnedSessions.add(entry.sessionId)
            if (entry.kind === 'owner-report-issued' && typeof entry.reportPath === 'string') reportPaths.add(entry.reportPath)
          }
        }
      } catch {
        // The in-memory owner inventory remains available for shutdown.
      }
      const stopWork = Promise.allSettled([...allOwnedSessions].map(async (sessionId) => {
        try {
          await host.context.call('quirky.structured/stop', { session: sessionId })
        } catch {
          // A missing or already-stopped owner session does not prevent cleanup of the rest.
        }
      }))
      await waitUntilOwnerShutdownDeadline(stopWork, deadlineAtMs)
      const reportCleanup = (async () => {
        let directoryIsPrivate = false
        try {
          const info = await lstat(reportDirectory)
          directoryIsPrivate = info.isDirectory() && !info.isSymbolicLink()
        } catch {
          directoryIsPrivate = false
        }
        if (!directoryIsPrivate) return
        try {
          for (const name of await readdir(reportDirectory)) {
            if (REPORT_FILENAME.test(name)) reportPaths.add(join(reportDirectory, name))
          }
        } catch {
          // Journaled paths are still removed if directory enumeration is unavailable.
        }
        for (const reportPath of reportPaths) {
          if (!isOwnedReportPath(reportPath)) continue
          await unlink(reportPath).catch(() => undefined)
        }
      })()
      await waitUntilOwnerShutdownDeadline(reportCleanup, deadlineAtMs)
      issuedPaths.clear()
      issuedPathsByWatcher.clear()
      ownerSessions.clear()
      stateCache.clear()
      deviationFactsCache.clear()
    })()
    return shutdownPromise
  }

  return {
    step: async (enrollment, snapshot, deviations) => {
      if (shuttingDown) return { handled: false, reason: 'owner controller is shutting down' }
      const watcherId = enrollment.watcherId
      if ((enrollment.owner === null || enrollment.owner === undefined) && releasedWatchers.has(watcherId)) {
        return { handled: false, reason: 'owner is not configured' }
      }
      try {
        return await withWatcherLock(watcherId, () => stepLocked(enrollment, snapshot, deviations), enrollment.owner !== null && enrollment.owner !== undefined)
      } catch (error) {
        return { handled: false, reason: errorMessage(error) }
      }
    },
    ready: async (watcherId, reportKey) => {
      if (shuttingDown) return { kind: 'refused', reason: 'owner controller is shutting down' }
      try {
        return await withWatcherLock(watcherId, () => readyLocked(watcherId, reportKey))
      } catch (error) {
        return { kind: 'refused', reason: errorMessage(error) }
      }
    },
    answer: async (watcherId, escalationId, body) => {
      if (shuttingDown) return { handled: false, reason: 'owner controller is shutting down' }
      try {
        return await withWatcherLock(watcherId, () => answerLocked(watcherId, escalationId, body))
      } catch (error) {
        return { handled: true, reason: 'owner-answer-indeterminate' }
      }
    },
    release: async (watcherId) => {
      await beginWatcherRelease(watcherId, 'owner-removed')
    },
    inspect,
    shutdown
  }
}
