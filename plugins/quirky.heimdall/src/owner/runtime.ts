import { constants as fsConstants } from 'node:fs'
import { chmod, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { basename, join, relative, resolve, sep } from 'node:path'
import type { Session } from '@quirky/protocol'
import type { Json, JournalAppend, JournalEntry, Snapshot } from '../contracts'
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
  intervalId?: string
  parkCause?: 'silence' | 'ask-human'
}
type OwnerRuntimeState = Omit<OwnerState, 'pending'> & {
  pending: OwnerRuntimePending | null
  queue: string[]
  lastError?: string
  lastErrorAtMs?: number
  lastOutcome?: { kind: OwnerApplyResult['kind']; reason?: string }
}
type DeviationStatus = 'open' | 'applied' | 'refused' | 'indeterminate'
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
const PENDING_PHASES = new Set<OwnerPending['phase']>(['issuing', 'waiting', 'ready', 'indeterminate', 'parked'])
const OWNER_SHUTDOWN_TIMEOUT_MS = 1_500

async function waitUntilOwnerShutdownDeadline(work: Promise<unknown>, deadlineAtMs: number): Promise<void> {
  const remainingMs = deadlineAtMs - Date.now()
  if (remainingMs <= 0) {
    void work.catch(() => undefined)
    return
  }
  const timeout = Promise.withResolvers<void>()
  const timer = setTimeout(() => timeout.resolve(), remainingMs)
  await Promise.race([work.then(() => undefined, () => undefined), timeout.promise])
  clearTimeout(timer)
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
  if (typeof phase !== 'string' || !PENDING_PHASES.has(phase as OwnerPending['phase'])) throw new TypeError('stored owner phase is malformed')
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
  if (status !== 'open' && status !== 'applied' && status !== 'refused' && status !== 'indeterminate') return null
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
  const activeOperations = new Set<Promise<unknown>>()
  const stateCache = new Map<string, OwnerRuntimeState>()
  const deviationFactsCache = new Map<string, Map<string, DeviationFact>>()
  const activeIntervals = new Map<string, string>()
  const ownerSessions = new Map<string, Set<string>>()
  const issuedPaths = new Set<string>()

  function ensureOpen(): void {
    if (shuttingDown) throw new Error('owner controller is shutting down')
  }

  function journal(watcherId: string): JournalEntry[] {
    return host.store.journal(watcherId)
  }

  function append(watcherId: string, kind: string, fields: Record<string, unknown> = {}, resolved = false): JournalEntry {
    ensureOpen()
    if (host.store.readOnly) throw new Error('owner journal is read-only')
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

  function persistState(watcherId: string, state: OwnerRuntimeState): void {
    const saved = cloneState(state)
    append(watcherId, 'owner-state', { state: saved })
    stateCache.set(watcherId, saved)
  }

  function readState(watcherId: string): OwnerRuntimeState {
    const cached = stateCache.get(watcherId)
    if (cached) {
      const state = cloneState(cached)
      if (state.sessionId) addOwnedSession(watcherId, state.sessionId)
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
    foldObservation = false
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
      }, resolved)
      append(watcherId, 'escalation', {
        escalationId,
        naturalKey: deviation.naturalKey,
        revision,
        foldCount,
        status: resolved ? 'resolved' : 'open',
        detail: deviation.detail,
        deviation
      }, resolved)
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

  async function ensurePrivateDirectory(): Promise<void> {
    ensureOpen()
    await mkdir(reportDirectory, { recursive: true, mode: 0o700 })
    const before = await lstat(reportDirectory)
    if (before.isSymbolicLink() || !before.isDirectory()) throw new Error('owner report directory is not a regular directory')
    await chmod(reportDirectory, 0o700)
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

  async function createIssuedFile(): Promise<IssuedFile> {
    await ensurePrivateDirectory()
    for (let attempt = 0; attempt < 4; attempt += 1) {
      ensureOpen()
      const reportKey = randomUUID()
      const reportPath = join(reportDirectory, `${randomUUID()}.json`)
      issuedPaths.add(reportPath)
      try {
        const handle = await open(reportPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, 0o600)
        await handle.close()
        return { reportKey, reportPath }
      } catch (error) {
        issuedPaths.delete(reportPath)
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw error
      }
    }
    throw new Error('could not allocate a unique owner report file')
  }

  async function readIssuedReport(reportPath: string): Promise<OwnerIntervention> {
    if (!isOwnedReportPath(reportPath)) throw new Error('issued report path escaped its private directory')
    await ensurePrivateDirectory()
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
      `Snapshot content identity: ${pending.contentIdentity}`,
      'Deviation detail:'
    ].join('\n') + '\n'
    const footer = `\n\n${reportInstructions(watcherId, pending)}`
    const available = OWNER_BRIEF_MAX_STATE_BYTES - Buffer.byteLength(header, 'utf8') - Buffer.byteLength(footer, 'utf8')
    if (available < 0) throw new Error('owner report identity leaves no room for a bounded brief')
    let detail = pending.deviation.detail
    if (Buffer.byteLength(detail, 'utf8') > available) {
      const marker = '\n[deviation detail truncated to fit the 32 KiB UTF-8 brief]'
      const prefix = takeUtf8Prefix(detail, Math.max(0, available - Buffer.byteLength(marker, 'utf8')))
      detail = `${prefix}${marker}`
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

  function closeOwnerInterval(watcherId: string, pending: OwnerRuntimePending, reason: 'settled' | 'contact-lost' | 'shutdown'): void {
    const intervalId = pending.intervalId
    if (!intervalId) return
    if (intervalIsOpen(watcherId, intervalId)) {
      const checkpointAtMs = reason === 'contact-lost' ? intervalCheckpointAt(watcherId, intervalId) : nowMs(host)
      append(watcherId, 'interval-close', {
        intervalId,
        reason,
        ...(checkpointAtMs === undefined ? {} : { checkpointAtMs })
      }, true)
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
      deviationId: fact.escalationId
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

  function persistReturnedSession(watcherId: string, state: OwnerRuntimeState, raw: unknown): Session {
    const sessionId = returnedSessionId(raw)
    if (!sessionId) throw new Error('structured owner call returned no session ID; conversation outcome is ambiguous')
    addOwnedSession(watcherId, sessionId)
    append(watcherId, 'owner-session', { sessionId, agent: 'claude', kind: 'structured' })
    state.sessionId = sessionId
    state.instanceId = instanceId
    persistState(watcherId, state)
    return validateReturnedSession(raw, sessionId)
  }

  async function ownerCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    ensureOpen()
    const result = await host.context.call(method, params)
    if (shuttingDown && (method === 'quirky.structured/create' || method === 'quirky.structured/resume')) {
      const sessionId = returnedSessionId(result)
      if (sessionId) {
        try {
          await host.context.call('quirky.structured/stop', { session: sessionId })
        } catch {
          // Plugin-lifetime structured ownership is the backstop if the host has already revoked calls.
        }
      }
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
      await ensurePrivateDirectory()
      const reportFile = await lstat(pending.reportPath)
      if (reportFile.isSymbolicLink() || !reportFile.isFile()) throw new Error('issued report is not a regular file')
      const prompt = buildBrief(watcherId, pending)
      ensureOwnerInterval(watcherId, state)
      persistState(watcherId, state)
      if (state.sessionId === null) {
        const raw = await ownerCall('quirky.structured/create', {
          lifetime: 'plugin',
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
        const oldSession = await ownerCall('quirky.session/get', { session: oldSessionId })
        validateNativeSession(oldSession, oldSessionId)
        const raw = await ownerCall('quirky.structured/resume', { lifetime: 'plugin', session: oldSessionId, prompt })
        persistReturnedSession(watcherId, state, raw)
      } else {
        await ownerCall('quirky.structured/send', { session: state.sessionId, text: prompt })
      }
      ensureOpen()
      pending.phase = 'waiting'
      pending.lastWakeAtMs = nowMs(host)
      pending.wakeCount = 0
      pending.parkCause = undefined
      state.instanceId = instanceId
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
      const issued = await createIssuedFile()
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
      if (isOwnedReportPath(oldPath)) await unlink(oldPath).catch(() => undefined)
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
      const issued = await createIssuedFile()
      const pending = pendingFromFact(watcherId, fact, snapshot.contentIdentity, issued, nowMs(host))
      state.pending = pending
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
      ensureOpen()
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
        return { handled: true, reason: result.reason ?? 'owner intervention applied' }
      }
      if (result.kind === 'refused') {
        setDeviationStatus(watcherId, pending.deviationId, 'refused', false, result.reason)
        state.pending = null
        persistState(watcherId, state)
        if (state.queue.length > 0 && isActive(enrollment)) host.wake(watcherId)
        return { handled: true, reason: result.reason ?? 'owner intervention refused' }
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
        pending.phase = 'indeterminate'
        pending.wakeCount = 1
        pending.lastWakeAtMs = time
        clearError(state)
        persistState(watcherId, state)
        const reminder = `one reminder: finish the current owner report and run ${reportCommand(watcherId, pending)}. Write the proposal to ${pending.reportPath}.`
        await ownerCall('quirky.structured/send', { session: sessionId, text: reminder })
        ensureOpen()
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

  async function stepLocked(enrollment: OwnerEnrollment, snapshot: Snapshot, deviations: OwnerDeviation[]): Promise<OwnerStepResult> {
    const watcherId = enrollment.watcherId
    const state = readState(watcherId)
    let stateChanged = false
    let config: OwnerConfig | null
    try {
      config = parseOwnerConfig(enrollment.owner)
      if (!config) return { handled: false, reason: 'owner is not configured' }
      for (const candidate of deviations) {
        let parsed: OwnerDeviation
        try {
          parsed = parseOwnerDeviation(candidate)
        } catch (error) {
          recordError(watcherId, state, 'invalid-owner-deviation', error)
          continue
        }
        const escalationId = deviationEscalationId(watcherId, parsed.naturalKey)
        const previous = latestDeviationFacts(watcherId).get(escalationId)
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
    // Reconcile a durable attempt even if that attempt itself parked or disarmed the watcher.
    // The host stages proposals only; the runner still owns every effect and commit fence.
    if (state.pending?.phase === 'ready') return applyReady(watcherId, enrollment, snapshot, state)
    if (!isActive(enrollment)) return { handled: stateChanged || state.pending !== null, reason: 'owner work is paused or disarmed' }
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
        await ensurePrivateDirectory()
        if (await reportFileMissing(pending.reportPath)) {
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
      intervention = await readIssuedReport(pending.reportPath)
    } catch (error) {
      const reason = errorMessage(error)
      rejectedReport(watcherId, state, reportKey, reason)
      return { kind: 'refused', reason }
    }
    ensureOpen()
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
      issued = await createIssuedFile()
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
      if (isOwnedReportPath(oldReportPath)) await unlink(oldReportPath).catch(() => undefined)
      ensureOwnerInterval(watcherId, state)
      persistState(watcherId, state)
      const prompt = answerPrompt(watcherId, body, renewed)
      if (recovering) {
        const oldSession = await ownerCall('quirky.session/get', { session: ownerSessionId })
        validateNativeSession(oldSession, ownerSessionId)
        const resumedRaw = await ownerCall('quirky.structured/resume', { lifetime: 'plugin', session: ownerSessionId, prompt })
        persistReturnedSession(watcherId, state, resumedRaw)
      } else {
        await ownerCall('quirky.structured/send', { session: ownerSessionId, text: prompt })
      }
      ensureOpen()
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

  function withWatcherLock<T>(watcherId: string, action: () => Promise<T>): Promise<T> {
    const previous = watcherLocks.get(watcherId) ?? Promise.resolve()
    const operation = previous.catch(() => undefined).then(() => {
      ensureOpen()
      return action()
    })
    const tail = operation.then(() => undefined, () => undefined)
    watcherLocks.set(watcherId, tail)
    activeOperations.add(operation)
    void operation.then(() => activeOperations.delete(operation), () => activeOperations.delete(operation))
    return operation
  }

  function inspect(watcherId: string): OwnerState {
    const state = readState(watcherId)
    reconcileQueue(watcherId, state)
    return cloneState(state) as OwnerState
  }

  async function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise
    const deadlineAtMs = Date.now() + OWNER_SHUTDOWN_TIMEOUT_MS
    shuttingDown = true
    shutdownPromise = (async () => {
      await waitUntilOwnerShutdownDeadline(Promise.allSettled([...activeOperations]), deadlineAtMs)
      for (const [watcherId, intervalId] of activeIntervals) {
        try {
          if (intervalIsOpen(watcherId, intervalId) && !host.store.readOnly) {
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
      ownerSessions.clear()
      stateCache.clear()
      deviationFactsCache.clear()
    })()
    return shutdownPromise
  }

  return {
    step: async (enrollment, snapshot, deviations) => {
      if (shuttingDown) return { handled: false, reason: 'owner controller is shutting down' }
      try {
        return await withWatcherLock(enrollment.watcherId, () => stepLocked(enrollment, snapshot, deviations))
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
    inspect,
    shutdown
  }
}
