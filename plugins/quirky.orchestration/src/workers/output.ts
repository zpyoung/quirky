import { createHash } from 'node:crypto'
import type { Session } from '@quirky/protocol'
import type { DispatchId, DispatchRow, JsonValue, UtcTimestamp } from '../contracts'
import type {
  OutputFallbackReason, TerminalResource, WorkerArchive, WorkerCore, WorkerObservation,
  WorkerOutput, WorkerReadParams, WorkerReadResult, WorkerRecord, WorkerRepository, WorkerRuntime
} from '../worker-contracts'
import type { SessionIdentity } from '../runtime-contracts'

const DEFAULT_MESSAGE_LIMIT = 40
const MAX_MESSAGE_LIMIT = 50
const MAX_CURSOR_CHARS = 2_048
const MAX_RESPONSE_BYTES = 512 * 1_024
const RESPONSE_TEXT_BUDGET_BYTES = 32 * 1_024
const MAX_TRANSCRIPT_BYTES = 16 * 1_024 * 1_024
const MAX_TERMINAL_ARCHIVE_CHARS = 262_144
const MAX_HISTORY_PAGES = 128
const TERMINAL_HISTORY_PAGE_LINES = 1_024
const AGENT_STATUS_STALE_AFTER_MS = 30 * 60 * 1_000
const FUTURE_STATUS_TOLERANCE_MS = 5_000
const READ_CURSOR_PREFIX = 'owr2_'
const ARCHIVE_IDENTITY_PREFIX = 'wa1_'

type ReadSource = 'transcript' | 'terminal' | 'structured'
type Message = { role: string; text: string; seq?: number; at?: number }
type ArchiveMetadata = {
  version: 1
  dispatchId: string
  resourceId: string
  source: ReadSource
  sessionId: string | null
  processIncarnation: string | null
  processRuntimeEpoch: string | null
  mode: 'terminal' | 'structured' | null
  providerId: string | null
  providerSessionId: string | null
  transcriptPathHash: string | null
  exact: boolean
  truncated: boolean
  fallbackReason: OutputFallbackReason | null
}
type ReadCursor = {
  version: 2
  dispatchId: string
  source: ReadSource
  sourceIdentity: string
  contentPrefixHash: string
  archived: boolean
  messageIndex: number
  offset: number
  fallbackReason: OutputFallbackReason | null
}
type SourceSnapshot = {
  source: ReadSource
  sessionId: string | null
  archived: boolean
  sourceExact: boolean
  fallbackReason: OutputFallbackReason | null
  sourceIdentity: string
  content: string
  messages: Message[]
  clipped: boolean
  warnings: string[]
}
type TranscriptAttempt =
  | { kind: 'ready'; snapshot: SourceSnapshot; metadata: ArchiveMetadata }
  | { kind: 'fallback'; reason: OutputFallbackReason; snapshot: SourceSnapshot | null }
type AgentEvidence = {
  liveStatus: 'fresh' | 'stale' | 'unavailable' | 'redacted_restore'
  reason: string
}
type TerminalCapture = { content: string; truncated: boolean }

function outputError(context: WorkerRuntime['context'], kind: 'invalid-params' | 'conflict', reason: string): Error {
  return Object.assign(context.error(kind, reason), { data: { reason } })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isReadSource(value: unknown): value is ReadSource {
  return value === 'transcript' || value === 'terminal' || value === 'structured'
}
function isOutputFallbackReason(value: unknown): value is OutputFallbackReason {
  return value === 'provider_unsupported'
    || value === 'session_not_reported'
    || value === 'transcript_empty'
    || value === 'transcript_missing'
    || value === 'transcript_unreadable'
    || value === 'transcript_parse_failed'
    || value === 'remote_capability_unavailable'
}


function utf8Size(value: string): number {
  let size = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    size += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
  }
  return size
}

function utf8Prefix(value: string, maxBytes: number): { text: string; consumed: number; bytes: number } {
  let consumed = 0
  let bytes = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    const nextBytes = codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4
    if (bytes + nextBytes > maxBytes) break
    bytes += nextBytes
    consumed += character.length
  }
  return { text: value.slice(0, consumed), consumed, bytes }
}

function safeTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value
  let start = value.length - maxChars
  const first = value.charCodeAt(start)
  if (first >= 0xdc00 && first <= 0xdfff) start++
  return value.slice(start)
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function opaqueSourceIdentity(metadata: ArchiveMetadata): string {
  const sourcePin = {
    version: metadata.version,
    dispatchId: metadata.dispatchId,
    resourceId: metadata.resourceId,
    source: metadata.source,
    sessionId: metadata.sessionId,
    processIncarnation: metadata.processIncarnation,
    processRuntimeEpoch: metadata.processRuntimeEpoch,
    mode: metadata.mode,
    providerId: metadata.providerId,
    providerSessionId: metadata.providerSessionId,
    transcriptPathHash: metadata.transcriptPathHash
  }
  return `wsrc2_${hash(JSON.stringify(sourcePin))}`
}

function encodeArchiveMetadata(metadata: ArchiveMetadata): string {
  return `${ARCHIVE_IDENTITY_PREFIX}${Buffer.from(JSON.stringify(metadata), 'utf8').toString('base64url')}`
}

function archiveMetadata(value: string): ArchiveMetadata | null {
  if (!value.startsWith(ARCHIVE_IDENTITY_PREFIX)) return null
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(ARCHIVE_IDENTITY_PREFIX.length), 'base64url').toString('utf8'))
    if (!isRecord(decoded)) return null
    if (decoded.version !== 1 || typeof decoded.dispatchId !== 'string' || typeof decoded.resourceId !== 'string') return null
    if (!isReadSource(decoded.source) || (decoded.sessionId !== null && typeof decoded.sessionId !== 'string')) return null
    if (decoded.processIncarnation !== null && typeof decoded.processIncarnation !== 'string') return null
    const processRuntimeEpoch = decoded.processRuntimeEpoch === undefined ? null : decoded.processRuntimeEpoch
    if (processRuntimeEpoch !== null && typeof processRuntimeEpoch !== 'string') return null
    if (decoded.mode !== null && decoded.mode !== 'terminal' && decoded.mode !== 'structured') return null
    if (decoded.providerId !== null && typeof decoded.providerId !== 'string') return null
    if (decoded.providerSessionId !== null && typeof decoded.providerSessionId !== 'string') return null
    if (decoded.transcriptPathHash !== null && typeof decoded.transcriptPathHash !== 'string') return null
    if (typeof decoded.exact !== 'boolean' || typeof decoded.truncated !== 'boolean') return null
    const fallbackReason = decoded.fallbackReason === undefined ? null : decoded.fallbackReason
    if (fallbackReason !== null && !isOutputFallbackReason(fallbackReason)) return null
    return {
      version: 1,
      dispatchId: decoded.dispatchId,
      resourceId: decoded.resourceId,
      source: decoded.source,
      sessionId: decoded.sessionId,
      processIncarnation: decoded.processIncarnation,
      processRuntimeEpoch,
      mode: decoded.mode,
      providerId: decoded.providerId,
      providerSessionId: decoded.providerSessionId,
      transcriptPathHash: decoded.transcriptPathHash,
      exact: decoded.exact,
      truncated: decoded.truncated,
      fallbackReason
    }
  } catch {
    return null
  }
}

function newMetadata(
  dispatchId: DispatchId,
  resource: TerminalResource | null,
  record: WorkerRecord | null,
  source: ReadSource,
  identity: SessionIdentity | null,
  options: { providerSessionId?: string; transcriptPath?: string; exact: boolean; truncated?: boolean; fallbackReason?: OutputFallbackReason | null } = { exact: false }
): ArchiveMetadata {
  return {
    version: 1,
    dispatchId,
    resourceId: resource?.id ?? '',
    source,
    sessionId: identity?.sessionId ?? resource?.sessionId ?? record?.sessionId ?? null,
    processIncarnation: identity?.processIncarnation ?? resource?.processIncarnation ?? record?.processIncarnation ?? null,
    processRuntimeEpoch: identity?.runtimeEpoch ?? record?.processRuntimeEpoch ?? null,
    mode: record?.mode ?? null,
    providerId: identity?.providerId ?? null,
    providerSessionId: options.providerSessionId ?? null,
    transcriptPathHash: options.transcriptPath ? hash(options.transcriptPath) : null,
    exact: options.exact,
    truncated: options.truncated ?? false,
    fallbackReason: options.fallbackReason ?? null
  }
}

function parseReadCursor(value: string | undefined, dispatchId: DispatchId, context: WorkerRuntime['context']): ReadCursor | null {
  if (value === undefined) return null
  if (value.length > MAX_CURSOR_CHARS || !value.startsWith(READ_CURSOR_PREFIX)) {
    throw outputError(context, 'invalid-params', 'cursor_invalid')
  }
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(READ_CURSOR_PREFIX.length), 'base64url').toString('utf8'))
    if (!isRecord(decoded) || decoded.version !== 2 || decoded.dispatchIdHash !== hash(dispatchId) || !isReadSource(decoded.source)) {
      throw new Error('invalid cursor')
    }
    if (typeof decoded.sourceIdentity !== 'string' || typeof decoded.contentPrefixHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(decoded.contentPrefixHash) || typeof decoded.archived !== 'boolean') throw new Error('invalid cursor')
    const messageIndex = decoded.messageIndex
    const offset = decoded.offset
    if (typeof messageIndex !== 'number' || !Number.isSafeInteger(messageIndex) || messageIndex < 0) throw new Error('invalid cursor')
    if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid cursor')
    const fallbackReason = decoded.fallbackReason === undefined ? null : decoded.fallbackReason
    if (fallbackReason !== null && !isOutputFallbackReason(fallbackReason)) throw new Error('invalid cursor')
    return {
      version: 2,
      dispatchId,
      source: decoded.source,
      sourceIdentity: decoded.sourceIdentity,
      contentPrefixHash: decoded.contentPrefixHash,
      archived: decoded.archived,
      messageIndex,
      offset,
      fallbackReason
    }
  } catch {
    throw outputError(context, 'invalid-params', 'cursor_invalid')
  }
}

function makeReadCursor(cursor: ReadCursor): string {
  const { dispatchId, ...payload } = cursor
  const encoded = `${READ_CURSOR_PREFIX}${Buffer.from(JSON.stringify({ ...payload, dispatchIdHash: hash(dispatchId) }), 'utf8').toString('base64url')}`
  if (encoded.length > MAX_CURSOR_CHARS) throw new Error('cursor_invalid')
  return encoded
}
function validateCursorPosition(snapshot: SourceSnapshot, cursor: ReadCursor | null, runtime: WorkerRuntime): void {
  if (!cursor) return
  if (cursor.source !== snapshot.source || cursor.archived !== snapshot.archived) throw sourceChanged(runtime)
  if (cursor.source === 'terminal') {
    if (cursor.messageIndex !== 0 || cursor.offset > snapshot.content.length) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
    if (cursor.offset > 0 && cursor.offset < snapshot.content.length) {
      const next = snapshot.content.charCodeAt(cursor.offset)
      if (next >= 0xdc00 && next <= 0xdfff) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
    }
    return
  }
  if (cursor.messageIndex > snapshot.messages.length) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
  if (cursor.messageIndex === snapshot.messages.length) {
    if (cursor.offset !== 0) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
    return
  }
  const message = snapshot.messages[cursor.messageIndex]
  if (cursor.offset > message.text.length) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
  if (cursor.offset > 0 && cursor.offset < message.text.length) {
    const next = message.text.charCodeAt(cursor.offset)
    if (next >= 0xdc00 && next <= 0xdfff) throw outputError(runtime.context, 'invalid-params', 'cursor_invalid')
  }
}
function sourceContentPrefixHash(snapshot: SourceSnapshot, messageIndex: number, offset: number): string {
  if (snapshot.source === 'terminal') return hash(snapshot.content.slice(0, offset))
  const messages = snapshot.messages.slice(0, messageIndex)
  const current = snapshot.messages[messageIndex]
  if (current && offset > 0) messages.push({ ...current, text: current.text.slice(0, offset) })
  return hash(JSON.stringify(messages))
}

function validateCursorContent(snapshot: SourceSnapshot, cursor: ReadCursor | null, runtime: WorkerRuntime): void {
  if (!cursor) return
  if (cursor.contentPrefixHash !== sourceContentPrefixHash(snapshot, cursor.messageIndex, cursor.offset)) throw sourceChanged(runtime)
}


function parseSession(value: unknown): Pick<Session, 'id' | 'kind' | 'agent' | 'providerSession'> | null {
  if (!isRecord(value) || typeof value.id !== 'string' || (value.kind !== 'terminal' && value.kind !== 'structured') || typeof value.agent !== 'string') return null
  let providerSession: Session['providerSession'] = null
  if (value.providerSession !== null && value.providerSession !== undefined) {
    if (!isRecord(value.providerSession) || typeof value.providerSession.id !== 'string') return null
    const transcriptPath = value.providerSession.transcriptPath
    if (transcriptPath !== null && typeof transcriptPath !== 'string') return null
    providerSession = { id: value.providerSession.id, transcriptPath }
  }
  return { id: value.id, kind: value.kind, agent: value.agent, providerSession }
}
function currentReadableResource(resource: TerminalResource, dispatchId: DispatchId): boolean {
  return resource.ownerDispatchId === dispatchId
    && (resource.ownershipState === 'owned' || resource.ownershipState === 'user_owned' || resource.ownershipState === 'external')
}

function exactLease(record: WorkerRecord | null, resource: TerminalResource | null, observation: WorkerObservation): observation is WorkerObservation & { identity: SessionIdentity } {
  if (!record || !resource || !observation.exactWorker || !observation.identity) return false
  const identity = observation.identity
  return currentReadableResource(resource, record.dispatchId) && resource.releaseState !== 'released'
    && record.processIncarnation === resource.processIncarnation && record.worktreeId === resource.worktreeId
    && identity.sessionId === resource.sessionId && identity.processIncarnation === resource.processIncarnation
    && identity.sessionId.length > 0 && identity.processIncarnation.length > 0 && identity.runtimeEpoch.length > 0
    && record.processRuntimeEpoch !== null && record.processRuntimeEpoch.length > 0 && identity.runtimeEpoch === record.processRuntimeEpoch
    && identity.kind === (record.mode === 'structured' ? 'structured' : 'terminal')
    && (!observation.session || (observation.session.id === identity.sessionId
      && observation.session.kind === identity.kind && observation.session.worktreeId === identity.worktreeId
      && (identity.providerId === null || observation.session.agent === identity.providerId)))
}

function unavailableObservation(reason: string): WorkerObservation {
  return { status: 'unverifiable', exactWorker: false, reason, identity: null, session: null }
}
function unprovenObservation(observation: WorkerObservation): WorkerObservation {
  const status = observation.status === 'live' || observation.status === 'exited' ? 'unverifiable' : observation.status
  return { status, exactWorker: false, reason: observation.reason ?? 'missing_status', identity: null, session: null }
}


async function observeLiveLease(runtime: WorkerRuntime, record: WorkerRecord | null, dispatch: DispatchRow, resource: TerminalResource | null): Promise<WorkerObservation> {
  if (!record || !resource || !currentReadableResource(resource, dispatch.id) || resource.releaseState === 'released') {
    return unavailableObservation('missing_status')
  }
  try {
    return await runtime.observe(record, dispatch)
  } catch {
    return unavailableObservation('host_unavailable')
  }
}
async function sameLease(runtime: WorkerRuntime, dispatch: DispatchRow, record: WorkerRecord, resource: TerminalResource, identity: SessionIdentity): Promise<boolean> {
  try {
    const current = await runtime.observe(record, dispatch)
    if (!exactLease(record, resource, current)) return false
    return current.identity.sessionId === identity.sessionId
      && current.identity.processIncarnation === identity.processIncarnation
      && current.identity.runtimeEpoch === identity.runtimeEpoch
      && current.identity.providerId === identity.providerId
      && current.identity.kind === identity.kind
      && current.identity.worktreeId === identity.worktreeId
      && current.identity.source === identity.source
  } catch {
    return false
  }
}

function parseAgentEvidence(value: unknown, sessionId: string, now: number): AgentEvidence {
  if (!isRecord(value) || value.sessionId !== sessionId || typeof value.evidenceAt !== 'number' || !Number.isFinite(value.evidenceAt) || (value.restoredUnconfirmed !== undefined && typeof value.restoredUnconfirmed !== 'boolean')) {
    return { liveStatus: 'unavailable', reason: 'missing_status' }
  }
  if (value.restoredUnconfirmed === true) return { liveStatus: 'redacted_restore', reason: 'restored_unconfirmed' }
  if (value.evidenceAt > now + FUTURE_STATUS_TOLERANCE_MS) return { liveStatus: 'stale', reason: 'future_status' }
  if (now - value.evidenceAt > AGENT_STATUS_STALE_AFTER_MS) return { liveStatus: 'stale', reason: 'stale_status' }
  return { liveStatus: 'fresh', reason: '' }
}

async function readAgentEvidence(runtime: WorkerRuntime, dispatch: DispatchRow, observation: WorkerObservation, record: WorkerRecord | null, resource: TerminalResource | null): Promise<AgentEvidence> {
  if (!record || !resource || !exactLease(record, resource, observation)) {
    return { liveStatus: 'unavailable', reason: 'missing_status' }
  }
  let evidence: AgentEvidence
  try {
    const value = await runtime.context.call('quirky.agent-status/get', { session: resource.sessionId })
    evidence = parseAgentEvidence(value, resource.sessionId, Date.now())
  } catch {
    evidence = { liveStatus: 'unavailable', reason: 'missing_status' }
  }
  let current: WorkerObservation
  try {
    current = await runtime.observe(record, dispatch)
  } catch {
    return { ...evidence, liveStatus: 'unavailable', reason: 'host_unavailable' }
  }
  if (!exactLease(record, resource, current)) {
    const reason = current.reason === 'host_unavailable' || current.reason === 'capability_unsupported'
      ? current.reason
      : 'peer_changed'
    return { ...evidence, liveStatus: 'unavailable', reason }
  }
  return evidence
}

function isCertifiedExit(terminationReason: DispatchRow['terminationReason']): boolean {
  return terminationReason === 'exited' || terminationReason === 'signaled' || terminationReason === 'operator_close'
}

function agentLiveness(
  evidence: AgentEvidence,
  observation: WorkerObservation,
  worker: WorkerRecord | null,
  resource: TerminalResource | null,
  terminationReason: DispatchRow['terminationReason']
): WorkerReadResult['agentLiveness'] {
  if (resource?.releaseState === 'released' || resource?.ownershipState === 'released' || worker?.state === 'stopped'
    || isCertifiedExit(terminationReason)) {
    return { status: 'exited', reason: null }
  }
  if (observation.status === 'exited' && observation.exactWorker) return { status: 'exited', reason: null }
  if (evidence.liveStatus === 'unavailable'
    && (evidence.reason === 'peer_changed' || evidence.reason === 'host_unavailable' || evidence.reason === 'capability_unsupported')) {
    return { status: 'unverifiable', reason: evidence.reason }
  }
  if (evidence.liveStatus === 'fresh') return { status: 'live', reason: null }
  if (evidence.liveStatus === 'unavailable' && evidence.reason === 'missing_status'
    && observation.status === 'live' && observation.exactWorker) return { status: 'live', reason: null }
  return { status: 'unverifiable', reason: evidence.reason || observation.reason || 'missing_status' }
}

function archiveLiveness(resource: TerminalResource | null, worker: WorkerRecord | null): { terminal: WorkerObservation['status']; agent: WorkerReadResult['agentLiveness'] } {
  if (resource?.releaseState === 'released' || resource?.ownershipState === 'released' || worker?.state === 'stopped') {
    return { terminal: 'exited', agent: { status: 'exited', reason: null } }
  }
  if (resource?.ownershipState === 'transferred' || (resource && resource.ownerDispatchId !== worker?.dispatchId)) {
    return { terminal: 'identity_changed', agent: { status: 'unverifiable', reason: 'identity_changed' } }
  }
  return { terminal: 'unverifiable', agent: { status: 'unverifiable', reason: 'missing_status' } }
}

function textContent(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return null
  const pieces: string[] = []
  for (const block of value) {
    if (!isRecord(block) || typeof block.text !== 'string') continue
    if (block.type === 'text' || block.type === 'input_text' || block.type === 'output_text') pieces.push(block.text)
  }
  return pieces.join('\n')
}

function parseTranscriptLine(providerId: string, row: Record<string, unknown>): { message?: Message; malformed: boolean } {
  if (providerId === 'claude' || providerId === 'openclaude') {
    if (row.type !== 'user' && row.type !== 'assistant') return { malformed: false }
    if (!isRecord(row.message)) return { malformed: true }
    const role = row.type
    if (typeof row.message.role === 'string' && row.message.role !== role) return { malformed: true }
    const text = textContent(row.message.content)
    if (text === null) return { malformed: true }
    return { message: text.length > 0 ? { role, text } : undefined, malformed: false }
  }
  if (providerId === 'codex') {
    if (row.type === 'event_msg') {
      if (!isRecord(row.payload)) return { malformed: true }
      const eventType = row.payload.type
      if (eventType !== 'user_message' && eventType !== 'agent_message') return { malformed: false }
      if (typeof row.payload.message !== 'string') return { malformed: true }
      const role = eventType === 'user_message' ? 'user' : 'assistant'
      return { message: row.payload.message.length > 0 ? { role, text: row.payload.message } : undefined, malformed: false }
    }
    if (row.type === 'response_item') {
      if (!isRecord(row.payload) || row.payload.type !== 'message') return { malformed: false }
      if (row.payload.role !== 'user' && row.payload.role !== 'assistant') return { malformed: false }
      const text = textContent(row.payload.content)
      if (text === null) return { malformed: true }
      return { message: text.length > 0 ? { role: row.payload.role, text } : undefined, malformed: false }
    }
  }
  return { malformed: false }
}

function parseProviderTranscript(providerId: string, raw: string): { messages: Message[] } | { reason: 'transcript_parse_failed' | 'transcript_empty' } {
  if (providerId !== 'claude' && providerId !== 'openclaude' && providerId !== 'codex') return { reason: 'transcript_parse_failed' }
  const messages: Message[] = []
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return { reason: 'transcript_parse_failed' }
    }
    if (!isRecord(parsed)) return { reason: 'transcript_parse_failed' }
    const result = parseTranscriptLine(providerId, parsed)
    if (result.malformed) return { reason: 'transcript_parse_failed' }
    if (result.message) messages.push(result.message)
  }
  return messages.length > 0 ? { messages } : { reason: 'transcript_empty' }
}

function parseStructuredMessages(value: unknown, sessionId: string): Message[] | null {
  if (!Array.isArray(value)) return null
  const messages: Message[] = []
  for (const item of value) {
    if (!isRecord(item) || item.sessionId !== sessionId || typeof item.seq !== 'number' || !Number.isSafeInteger(item.seq) || typeof item.text !== 'string' || typeof item.at !== 'number' || !Number.isFinite(item.at)) return null
    if (item.role !== 'user' && item.role !== 'assistant' && item.role !== 'tool' && item.role !== 'system' && item.role !== 'result') return null
    messages.push({ role: item.role, text: item.text, seq: item.seq, at: item.at })
  }
  return messages
}

function structuredArchiveContent(sessionId: string, messages: readonly Message[]): string {
  const rows: JsonValue[] = messages.map((message) => ({
    sessionId,
    seq: message.seq ?? 0,
    role: message.role,
    text: message.text,
    at: message.at ?? 0
  }))
  return JSON.stringify(rows)
}

function parseStructuredArchive(content: string, sessionId: string): Message[] | null {
  try {
    const decoded: unknown = JSON.parse(content)
    return parseStructuredMessages(decoded, sessionId)
  } catch {
    return null
  }
}


function formattedMessages(messages: readonly Message[]): string {
  return messages.map((message) => `${message.role}: ${message.text}`).join('\n\n')
}

function historyLines(value: unknown): { lines: string[]; cursor: string | null } | null {
  if (!isRecord(value) || !Array.isArray(value.lines)) return null
  if (value.cursor !== null && typeof value.cursor !== 'string') return null
  const lines: string[] = []
  for (const line of value.lines) {
    if (typeof line !== 'string') return null
    lines.push(line)
  }
  return { lines, cursor: value.cursor }
}

function pageText(lines: readonly string[], maxChars: number): { text: string; truncated: boolean } {
  const parts: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    if (size >= maxChars) break
    const separator = parts.length === 0 ? 0 : 1
    const room = maxChars - size - separator
    if (room <= 0) break
    const part = safeTail(lines[index], room)
    parts.push(part)
    size += separator + part.length
  }
  return { text: parts.reverse().join('\n'), truncated: size < lines.reduce((total, line) => total + line.length, Math.max(0, lines.length - 1)) }
}

async function loadTerminalTail(runtime: WorkerRuntime, sessionId: string): Promise<TerminalCapture | null> {
  let before: string | undefined
  let output = ''
  let truncated = false
  const seen = new Set<string>()
  for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
    let raw: unknown
    try {
      raw = await runtime.context.call('quirky.terminal/history', {
        session: sessionId,
        lines: TERMINAL_HISTORY_PAGE_LINES,
        format: 'text',
        ...(before ? { before } : {})
      })
    } catch {
      return null
    }
    const history = historyLines(raw)
    if (!history) return null
    const pageContent = pageText(history.lines, MAX_TERMINAL_ARCHIVE_CHARS)
    if (output.length === 0) {
      output = pageContent.text
      truncated = pageContent.truncated
    } else {
      const room = Math.max(0, MAX_TERMINAL_ARCHIVE_CHARS - output.length - 1)
      const older = safeTail(pageContent.text, room)
      truncated ||= pageContent.truncated || older.length < pageContent.text.length
      output = older.length > 0 ? `${older}\n${output}` : output
    }
    if (!history.cursor) break
    if (seen.has(history.cursor)) {
      truncated = true
      break
    }
    if (output.length >= MAX_TERMINAL_ARCHIVE_CHARS) {
      truncated = true
      break
    }
    seen.add(history.cursor)
    before = history.cursor
    if (page === MAX_HISTORY_PAGES - 1) truncated = true
  }
  return { content: safeTail(output, MAX_TERMINAL_ARCHIVE_CHARS), truncated }
}

function terminalReadLines(value: unknown): string[] | null {
  if (!isRecord(value) || !Array.isArray(value.lines)
    || typeof value.cols !== 'number' || !Number.isSafeInteger(value.cols) || value.cols < 1
    || typeof value.rows !== 'number' || !Number.isSafeInteger(value.rows) || value.rows < 1
    || typeof value.alt !== 'boolean') return null
  const lines: string[] = []
  for (const line of value.lines) {
    if (typeof line !== 'string') return null
    lines.push(line)
  }
  return lines
}

async function loadTerminalArchiveTail(runtime: WorkerRuntime, sessionId: string): Promise<TerminalCapture | null> {
  let raw: unknown
  try {
    raw = await runtime.context.pty.read(sessionId, 0)
  } catch {
    return null
  }
  const lines = terminalReadLines(raw)
  if (!lines) return null
  const screen = pageText(lines, MAX_TERMINAL_ARCHIVE_CHARS)
  const history = await loadTerminalTail(runtime, sessionId)
  if (!history) return null
  const combined = history.content.length > 0 && screen.text.length > 0
    ? `${history.content}\n${screen.text}`
    : `${history.content}${screen.text}`
  const content = safeTail(combined, MAX_TERMINAL_ARCHIVE_CHARS)
  return {
    content,
    truncated: history.truncated || screen.truncated || content.length < combined.length
  }
}


function makeArchive(
  dispatchId: DispatchId,
  resource: TerminalResource | null,
  source: ReadSource,
  content: string,
  metadata: ArchiveMetadata,
  status: WorkerArchive['status']
): WorkerArchive {
  return Object.freeze({
    dispatchId,
    resourceId: resource?.id ?? '',
    kind: source === 'transcript' ? 'transcript_pin' : source === 'structured' ? 'structured_journal' : 'terminal_tail',
    content,
    sourceIdentity: encodeArchiveMetadata(metadata),
    status,
    createdAt: new Date().toISOString()
  })
}

function exactIdentity(record: WorkerRecord | null, resource: TerminalResource | null, observation: WorkerObservation): SessionIdentity | null {
  return exactLease(record, resource, observation) ? observation.identity : null
}

async function publicSession(runtime: WorkerRuntime, sessionId: string): Promise<Pick<Session, 'id' | 'kind' | 'agent' | 'providerSession'> | null> {
  try {
    return parseSession(await runtime.context.call('quirky.session/get', { session: sessionId }))
  } catch {
    return null
  }
}

async function attemptTranscript(
  runtime: WorkerRuntime,
  dispatch: DispatchRow,
  dispatchId: DispatchId,
  record: WorkerRecord | null,
  resource: TerminalResource | null,
  identity: SessionIdentity | null
): Promise<TranscriptAttempt> {
  if (!record || !resource || !identity || !record.sessionId || record.sessionId !== identity.sessionId) {
    return { kind: 'fallback', reason: 'session_not_reported', snapshot: null }
  }
  const session = await publicSession(runtime, identity.sessionId)
  if (!session || session.id !== identity.sessionId || session.kind !== identity.kind || session.agent !== identity.providerId) {
    return { kind: 'fallback', reason: 'session_not_reported', snapshot: null }
  }
  const providerSession = session.providerSession
  if (!providerSession || !providerSession.id) return { kind: 'fallback', reason: 'session_not_reported', snapshot: null }
  if (!providerSession.transcriptPath) return { kind: 'fallback', reason: 'transcript_missing', snapshot: null }
  if (identity.providerId !== 'claude' && identity.providerId !== 'openclaude' && identity.providerId !== 'codex') {
    return { kind: 'fallback', reason: 'provider_unsupported', snapshot: null }
  }
  let raw: unknown
  try {
    raw = await runtime.context.call('quirky.session-info/transcript', { session: identity.sessionId })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const reason = /not[- ]found|missing|no transcript/i.test(message) ? 'transcript_missing' : 'transcript_unreadable'
    return { kind: 'fallback', reason, snapshot: null }
  }
  if (!isRecord(raw) || typeof raw.path !== 'string' || typeof raw.text !== 'string') {
    return { kind: 'fallback', reason: 'transcript_unreadable', snapshot: null }
  }
  if (raw.path !== providerSession.transcriptPath) return { kind: 'fallback', reason: 'transcript_missing', snapshot: null }
  const currentSession = await publicSession(runtime, identity.sessionId)
  if (!currentSession?.providerSession
    || currentSession.providerSession.id !== providerSession.id
    || currentSession.providerSession.transcriptPath !== providerSession.transcriptPath
    || currentSession.agent !== session.agent || currentSession.kind !== session.kind) {
    return { kind: 'fallback', reason: 'session_not_reported', snapshot: null }
  }
  if (!await sameLease(runtime, dispatch, record, resource, identity)) {
    return { kind: 'fallback', reason: 'session_not_reported', snapshot: null }
  }
  const transcriptSize = utf8Size(raw.text)
  if (transcriptSize > MAX_TRANSCRIPT_BYTES) return { kind: 'fallback', reason: 'transcript_unreadable', snapshot: null }
  let parsed: { messages: Message[] } | { reason: 'transcript_parse_failed' | 'transcript_empty' }
  if (raw.text.length === 0) parsed = { reason: 'transcript_empty' }
  else parsed = parseProviderTranscript(identity.providerId, raw.text)
  const fallbackReason = 'reason' in parsed ? parsed.reason : null
  const messages = 'reason' in parsed ? [] : parsed.messages
  const metadata = newMetadata(dispatchId, resource, record, 'transcript', identity, {
    exact: true,
    providerSessionId: providerSession.id,
    transcriptPath: providerSession.transcriptPath,
    truncated: transcriptSize === MAX_TRANSCRIPT_BYTES,
    fallbackReason
  })
  const snapshot: SourceSnapshot = {
    source: 'transcript',
    sessionId: identity.sessionId,
    archived: false,
    sourceExact: true,
    fallbackReason,
    sourceIdentity: opaqueSourceIdentity(metadata),
    content: raw.text,
    messages,
    clipped: metadata.truncated,
    warnings: fallbackReason ? [fallbackReason] : metadata.truncated ? ['transcript_service_limit_reached'] : []
  }
  if (fallbackReason) return { kind: 'fallback', reason: fallbackReason, snapshot }
  return { kind: 'ready', snapshot, metadata }
}

async function loadStructured(
  runtime: WorkerRuntime,
  dispatch: DispatchRow,
  dispatchId: DispatchId,
  record: WorkerRecord | null,
  resource: TerminalResource | null,
  identity: SessionIdentity | null
): Promise<SourceSnapshot> {
  if (!record || !resource || !identity || record.mode !== 'structured' || identity.kind !== 'structured') {
    const metadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: false })
    return { source: 'structured', sessionId: resource?.sessionId ?? null, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(metadata), content: '', messages: [], clipped: false, warnings: ['structured_lease_unavailable'] }
  }
  let raw: unknown
  try {
    raw = await runtime.context.call('quirky.structured/messages', { session: identity.sessionId })
  } catch {
    const metadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: false })
    return { source: 'structured', sessionId: identity.sessionId, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(metadata), content: '', messages: [], clipped: false, warnings: ['structured_journal_unreadable'] }
  }
  const messages = parseStructuredMessages(raw, identity.sessionId)
  if (!messages) {
    const metadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: false })
    return { source: 'structured', sessionId: identity.sessionId, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(metadata), content: '', messages: [], clipped: false, warnings: ['structured_journal_invalid'] }
  }
  if (!await sameLease(runtime, dispatch, record, resource, identity)) {
    const changedMetadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: false })
    return { source: 'structured', sessionId: identity.sessionId, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(changedMetadata), content: '', messages: [], clipped: false, warnings: ['structured_lease_changed'] }
  }
  const content = structuredArchiveContent(identity.sessionId, messages)
  const metadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: true })
  return {
    source: 'structured',
    sessionId: identity.sessionId,
    archived: false,
    sourceExact: true,
    fallbackReason: null,
    sourceIdentity: opaqueSourceIdentity(metadata),
    content,
    messages,
    clipped: false,
    warnings: []
  }
}

async function loadTerminal(
  runtime: WorkerRuntime,
  dispatch: DispatchRow,
  dispatchId: DispatchId,
  record: WorkerRecord | null,
  resource: TerminalResource | null,
  identity: SessionIdentity | null,
  loadTail: typeof loadTerminalTail = loadTerminalTail
): Promise<SourceSnapshot> {
  if (!record || !resource || !identity) {
    const metadata = newMetadata(dispatchId, resource, record, 'terminal', identity, { exact: false })
    return { source: 'terminal', sessionId: resource?.sessionId ?? null, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(metadata), content: '', messages: [], clipped: false, warnings: ['terminal_lease_unavailable'] }
  }
  const capture = await loadTail(runtime, identity.sessionId)
  if (!capture) {
    const metadata = newMetadata(dispatchId, resource, record, 'terminal', identity, { exact: false })
    return { source: 'terminal', sessionId: identity.sessionId, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(metadata), content: '', messages: [], clipped: false, warnings: ['terminal_history_unreadable'] }
  }
  if (!await sameLease(runtime, dispatch, record, resource, identity)) {
    const changedMetadata = newMetadata(dispatchId, resource, record, 'terminal', identity, { exact: false })
    return { source: 'terminal', sessionId: identity.sessionId, archived: false, sourceExact: false, fallbackReason: null, sourceIdentity: opaqueSourceIdentity(changedMetadata), content: '', messages: [], clipped: false, warnings: ['terminal_lease_changed'] }
  }
  const metadata = newMetadata(dispatchId, resource, record, 'terminal', identity, { exact: true, truncated: capture.truncated })
  return {
    source: 'terminal',
    sessionId: identity.sessionId,
    archived: false,
    sourceExact: true,
    fallbackReason: null,
    sourceIdentity: opaqueSourceIdentity(metadata),
    content: capture.content,
    messages: [],
    clipped: capture.truncated,
    warnings: capture.truncated ? ['terminal_tail_limited'] : []
  }
}

function sourceFromArchive(dispatchId: DispatchId, archive: WorkerArchive): SourceSnapshot {
  const metadata = archiveMetadata(archive.sourceIdentity)
  const source = archive.kind === 'transcript_pin' ? 'transcript' : archive.kind === 'structured_journal' ? 'structured' : 'terminal'
  const exact = Boolean(metadata && metadata.exact && metadata.sessionId && metadata.processIncarnation && metadata.processRuntimeEpoch && metadata.dispatchId === dispatchId && metadata.resourceId === archive.resourceId && metadata.source === source)
  const sessionId = metadata?.sessionId ?? null
  let messages: Message[] = []
  let fallbackReason: OutputFallbackReason | null = metadata?.fallbackReason ?? null
  const warnings: string[] = []
  if (archive.status === 'unavailable') warnings.push('archive_unavailable')
  if (source === 'transcript' && archive.status !== 'unavailable') {
    if (!metadata?.providerId || (metadata.providerId !== 'claude' && metadata.providerId !== 'openclaude' && metadata.providerId !== 'codex')) {
      fallbackReason = 'provider_unsupported'
      warnings.push('archive_provider_unsupported')
    } else {
      const parsed = parseProviderTranscript(metadata.providerId, archive.content)
      if ('reason' in parsed) {
        fallbackReason = parsed.reason
        warnings.push(parsed.reason)
      } else {
        messages = parsed.messages
      }
    }
  } else if (source === 'structured' && archive.status !== 'unavailable' && sessionId) {
    const parsed = parseStructuredArchive(archive.content, sessionId)
    if (!parsed) warnings.push('structured_archive_invalid')
    else messages = parsed
  }
  const sourcePin = metadata ?? newMetadata(dispatchId, null, null, source, null, { exact: false })
  const sourceIdentity = `wsrc2_${hash(`${opaqueSourceIdentity(sourcePin)}\n${archive.content}`)}`
  return {
    source,
    sessionId,
    archived: true,
    sourceExact: exact,
    fallbackReason,
    sourceIdentity,
    content: archive.content,
    messages,
    clipped: metadata?.truncated ?? false,
    warnings
  }
}

function unavailableArchiveSnapshot(
  dispatchId: DispatchId,
  resource: TerminalResource | null,
  record: WorkerRecord | null,
  sourceOverride?: ReadSource
): SourceSnapshot {
  const source = sourceOverride ?? (record?.mode === 'structured' ? 'structured' : 'terminal')
  const fallbackReason: OutputFallbackReason | null = source === 'transcript' || (sourceOverride === undefined && source === 'terminal')
    ? 'session_not_reported'
    : null
  const metadata = newMetadata(dispatchId, resource, record, source, null, { exact: false, fallbackReason })
  return {
    source,
    sessionId: resource?.sessionId ?? record?.sessionId ?? null,
    archived: true,
    sourceExact: false,
    fallbackReason,
    sourceIdentity: opaqueSourceIdentity(metadata),
    content: '',
    messages: [],
    clipped: false,
    warnings: ['archive_unavailable']
  }
}

function buildMessageResult(
  params: WorkerReadParams,
  snapshot: SourceSnapshot,
  cursor: ReadCursor | null,
  observation: WorkerObservation,
  agent: WorkerReadResult['agentLiveness'],
  limit: number
): WorkerReadResult {
  const messages = snapshot.messages
  const startIndex = cursor?.messageIndex ?? 0
  let index = startIndex
  let offset = cursor?.offset ?? 0
  let remainingBytes = RESPONSE_TEXT_BUDGET_BYTES
  const selected: Message[] = []
  let clipped = snapshot.clipped
  while (index < messages.length && selected.length < limit) {
    const source = messages[index]
    if (offset > source.text.length) throw new Error('cursor_invalid')
    const rest = source.text.slice(offset)
    const prefix = utf8Prefix(rest, remainingBytes)
    selected.push({ role: source.role, text: prefix.text, ...(source.seq !== undefined ? { seq: source.seq } : {}), ...(source.at !== undefined ? { at: source.at } : {}) })
    remainingBytes -= prefix.bytes
    if (prefix.consumed < rest.length) {
      offset += prefix.consumed
      clipped = true
      break
    }
    index++
    offset = 0
  }
  const hasMore = index < messages.length
  const nextCursor = hasMore ? makeReadCursor({
    version: 2,
    dispatchId: params.dispatchId,
    source: snapshot.source,
    sourceIdentity: snapshot.sourceIdentity,
    archived: snapshot.archived,
    messageIndex: index,
    contentPrefixHash: sourceContentPrefixHash(snapshot, index, offset),
    offset,
    fallbackReason: snapshot.fallbackReason,
  }) : null
  const jsonMessages: JsonValue[] = selected.map((message) => ({
    role: message.role,
    text: message.text,
    ...(message.seq !== undefined ? { seq: message.seq } : {}),
    ...(message.at !== undefined ? { at: message.at } : {})
  }))
  const content = formattedMessages(selected)
  const complete = nextCursor === null && !clipped && snapshot.fallbackReason === null && snapshot.sourceExact && snapshot.warnings.length === 0
  return {
    dispatchId: params.dispatchId,
    sessionId: snapshot.sessionId,
    source: snapshot.source,
    archived: snapshot.archived,
    sourceExact: snapshot.sourceExact,
    fallbackReason: snapshot.fallbackReason,
    content,
    messages: jsonMessages,
    contentComplete: complete,
    clipping: { clipped, maxBytes: MAX_RESPONSE_BYTES },
    nextCursor,
    terminalLiveness: observation.status,
    agentLiveness: agent,
    warnings: snapshot.warnings,
    sourceIdentity: snapshot.sourceIdentity
  }
}

function buildTerminalResult(
  params: WorkerReadParams,
  snapshot: SourceSnapshot,
  cursor: ReadCursor | null,
  observation: WorkerObservation,
  agent: WorkerReadResult['agentLiveness']
): WorkerReadResult {
  const offset = cursor?.offset ?? 0
  if (offset > snapshot.content.length) throw new Error('cursor_invalid')
  const remaining = snapshot.content.slice(offset)
  const prefix = utf8Prefix(remaining, RESPONSE_TEXT_BUDGET_BYTES)
  const nextOffset = offset + prefix.consumed
  const hasMore = nextOffset < snapshot.content.length
  const nextCursor = hasMore ? makeReadCursor({
    version: 2,
    dispatchId: params.dispatchId,
    source: 'terminal',
    sourceIdentity: snapshot.sourceIdentity,
    archived: snapshot.archived,
    messageIndex: 0,
    offset: nextOffset,
    contentPrefixHash: sourceContentPrefixHash(snapshot, 0, nextOffset),
    fallbackReason: snapshot.fallbackReason,
  }) : null
  const clipped = snapshot.clipped || prefix.consumed < remaining.length
  return {
    dispatchId: params.dispatchId,
    sessionId: snapshot.sessionId,
    source: 'terminal',
    archived: snapshot.archived,
    sourceExact: snapshot.sourceExact,
    fallbackReason: snapshot.fallbackReason,
    content: prefix.text,
    contentComplete: nextCursor === null && !clipped && snapshot.fallbackReason === null && snapshot.sourceExact && snapshot.warnings.length === 0,
    clipping: { clipped, maxBytes: MAX_RESPONSE_BYTES },
    nextCursor,
    terminalLiveness: observation.status,
    agentLiveness: agent,
    warnings: snapshot.warnings,
    sourceIdentity: snapshot.sourceIdentity
  }
}

function sourceChanged(runtime: WorkerRuntime): Error {
  return outputError(runtime.context, 'conflict', 'source_changed')
}

function fallbackForNoSource(source: ReadSource, dispatchId: DispatchId, record: WorkerRecord | null, resource: TerminalResource | null): SourceSnapshot {
  const fallbackReason: OutputFallbackReason | null = source === 'transcript' ? 'session_not_reported' : null
  const metadata = newMetadata(dispatchId, resource, record, source, null, { exact: false })
  return {
    source,
    sessionId: resource?.sessionId ?? record?.sessionId ?? null,
    archived: false,
    sourceExact: false,
    fallbackReason,
    sourceIdentity: opaqueSourceIdentity(metadata),
    content: '',
    messages: [],
    clipped: false,
    warnings: source === 'terminal' ? ['terminal_lease_unavailable'] : []
  }
}

function cursorLimit(value: number | undefined, runtime: WorkerRuntime): number {
  if (value === undefined) return DEFAULT_MESSAGE_LIMIT
  if (!Number.isSafeInteger(value) || value < 1) throw outputError(runtime.context, 'invalid-params', 'invalid_limit')
  return Math.min(MAX_MESSAGE_LIMIT, value)
}

function requestSource(value: WorkerReadParams['source'], runtime: WorkerRuntime): ReadSource | 'auto' {
  if (value === undefined || value === 'auto') return 'auto'
  if (value === 'transcript' || value === 'terminal') return value
  throw outputError(runtime.context, 'invalid-params', 'invalid_source')
}

async function sourceFromRequested(
  source: ReadSource,
  dispatch: DispatchRow,
  dispatchId: DispatchId,
  record: WorkerRecord | null,
  resource: TerminalResource | null,
  identity: SessionIdentity | null,
  runtime: WorkerRuntime
): Promise<SourceSnapshot> {
  if (source === 'transcript') {
    const transcript = await attemptTranscript(runtime, dispatch, dispatchId, record, resource, identity)
    if (!transcript.snapshot) throw sourceChanged(runtime)
    return transcript.snapshot
  }
  if (source === 'structured') return loadStructured(runtime, dispatch, dispatchId, record, resource, identity)
  return loadTerminal(runtime, dispatch, dispatchId, record, resource, identity)
}

export function createWorkerOutput(core: WorkerCore, repo: WorkerRepository, runtime: WorkerRuntime): WorkerOutput {
  async function capture(dispatchId: DispatchId): Promise<WorkerArchive> {
    const dispatch = core.getDispatch(dispatchId)
    const record = repo.get(dispatchId)
    const resource = repo.resource(dispatchId)
    const baseSource: ReadSource = record?.mode === 'structured' ? 'structured' : 'terminal'
    if (!record || !resource || resource.ownerDispatchId !== dispatchId || resource.ownershipState !== 'owned' || record.sessionId !== resource.sessionId || record.processIncarnation !== resource.processIncarnation) {
      const metadata = newMetadata(dispatchId, resource, record, baseSource, null, { exact: false })
      return makeArchive(dispatchId, resource, baseSource, '', metadata, 'unavailable')
    }
    const observation = await observeLiveLease(runtime, record, dispatch, resource)
    const identity = exactIdentity(record, resource, observation)
    if (!identity) {
      const metadata = newMetadata(dispatchId, resource, record, baseSource, observation.identity, { exact: false })
      return makeArchive(dispatchId, resource, baseSource, '', metadata, 'unavailable')
    }
    if (record.mode === 'structured') {
      const snapshot = await loadStructured(runtime, dispatch, dispatchId, record, resource, identity)
      const content = snapshot.sourceExact ? structuredArchiveContent(identity.sessionId, snapshot.messages) : ''
      const metadata = newMetadata(dispatchId, resource, record, 'structured', identity, { exact: snapshot.sourceExact })
      const status = !snapshot.sourceExact ? 'unavailable' : snapshot.messages.length === 0 ? 'empty' : 'captured'
      return makeArchive(dispatchId, resource, 'structured', content, metadata, status)
    }
    const transcript = await attemptTranscript(runtime, dispatch, dispatchId, record, resource, identity)
    if (transcript.kind === 'ready') {
      return makeArchive(dispatchId, resource, 'transcript', transcript.snapshot.content, transcript.metadata, 'captured')
    }
    const terminal = await loadTerminal(runtime, dispatch, dispatchId, record, resource, identity, loadTerminalArchiveTail)
    const content = terminal.sourceExact ? terminal.content : ''
    const metadata = newMetadata(dispatchId, resource, record, 'terminal', identity, { exact: terminal.sourceExact, truncated: terminal.clipped, fallbackReason: transcript.reason })
    const status = !terminal.sourceExact ? 'unavailable' : content.length === 0 ? 'empty' : 'captured'
    return makeArchive(dispatchId, resource, 'terminal', content, metadata, status)
  }

  async function read(params: WorkerReadParams): Promise<WorkerReadResult> {
    const dispatch = core.getDispatch(params.dispatchId)
    const record = repo.get(params.dispatchId)
    const resource = repo.resource(params.dispatchId)
    const cursor = parseReadCursor(params.cursor, params.dispatchId, runtime.context)
    const requested = requestSource(params.source, runtime)
    const limit = cursorLimit(params.limit, runtime)
    if (cursor && requested !== 'auto' && requested !== cursor.source) throw sourceChanged(runtime)

    const existingArchive = repo.archive(params.dispatchId)
    const ownershipTransferred = Boolean(resource && !currentReadableResource(resource, params.dispatchId))
    const uncertainRelease = resource?.releaseState === 'unknown' || resource?.releaseState === 'releasing' || resource?.releaseState === 'released'
    const archiveRequired = ownershipTransferred || uncertainRelease || (!resource && existingArchive !== null)
      || Boolean(existingArchive && resource?.releaseState === 'requested')
    if (cursor?.archived || archiveRequired) {
      if (!existingArchive || existingArchive.dispatchId !== params.dispatchId) {
        if (cursor) throw sourceChanged(runtime)
        const sourceOverride = requested === 'auto' ? undefined : requested
        const snapshot = unavailableArchiveSnapshot(params.dispatchId, resource, record, sourceOverride)
        const status = archiveLiveness(resource, record)
        const observation: WorkerObservation = {
          status: status.terminal, exactWorker: false, reason: status.agent.reason, identity: null, session: null
        }
        if (snapshot.source === 'terminal') return buildTerminalResult(params, snapshot, null, observation, status.agent)
        return buildMessageResult(params, snapshot, null, observation, status.agent, limit)
      }
      const archiveSnapshot = sourceFromArchive(params.dispatchId, existingArchive)
      const snapshot = requested !== 'auto' && requested !== archiveSnapshot.source
        ? {
            ...unavailableArchiveSnapshot(params.dispatchId, resource, record, requested),
            archived: true,
            fallbackReason: requested === 'transcript' ? archiveSnapshot.fallbackReason ?? 'session_not_reported' : null,
            warnings: ['archive_source_unavailable']
          }
        : archiveSnapshot
      if (cursor && (!cursor.archived || cursor.source !== snapshot.source || cursor.sourceIdentity !== snapshot.sourceIdentity)) throw sourceChanged(runtime)
      validateCursorPosition(snapshot, cursor, runtime)
      validateCursorContent(snapshot, cursor, runtime)
      const status = archiveLiveness(resource, record)
      const observation: WorkerObservation = {
        status: status.terminal, exactWorker: false, reason: status.agent.reason, identity: null, session: null
      }
      if (snapshot.source === 'terminal') return buildTerminalResult(params, snapshot, cursor, observation, status.agent)
      return buildMessageResult(params, snapshot, cursor, observation, status.agent, limit)
    }

    const observed = await observeLiveLease(runtime, record, dispatch, resource)
    const identity = exactIdentity(record, resource, observed)
    const observation = identity ? observed : unprovenObservation(observed)
    let snapshot: SourceSnapshot
    if (cursor) {
      if (cursor.archived) throw sourceChanged(runtime)
      if (!identity) throw sourceChanged(runtime)
      snapshot = await sourceFromRequested(cursor.source, dispatch, params.dispatchId, record, resource, identity, runtime)
      if (cursor.fallbackReason !== null) {
        if (snapshot.source !== 'terminal' || !snapshot.sourceExact) throw sourceChanged(runtime)
        const metadata = newMetadata(params.dispatchId, resource, record, 'terminal', identity, {
          exact: true, truncated: snapshot.clipped, fallbackReason: cursor.fallbackReason
        })
        snapshot = {
          ...snapshot,
          fallbackReason: cursor.fallbackReason,
          sourceIdentity: opaqueSourceIdentity(metadata)
        }
      }
      if (snapshot.sourceIdentity !== cursor.sourceIdentity || !snapshot.sourceExact) throw sourceChanged(runtime)
    } else if (requested === 'transcript') {
      const result = await attemptTranscript(runtime, dispatch, params.dispatchId, record, resource, identity)
      snapshot = result.snapshot ?? fallbackForNoSource('transcript', params.dispatchId, record, resource)
      if (result.kind === 'fallback') snapshot = { ...snapshot, fallbackReason: result.reason }
    } else if (requested === 'terminal') {
      snapshot = await loadTerminal(runtime, dispatch, params.dispatchId, record, resource, identity)
    } else if (record?.mode === 'structured') {
      snapshot = await loadStructured(runtime, dispatch, params.dispatchId, record, resource, identity)
    } else {
      const result = await attemptTranscript(runtime, dispatch, params.dispatchId, record, resource, identity)
      if (result.kind === 'ready') snapshot = result.snapshot
      else {
        snapshot = await loadTerminal(runtime, dispatch, params.dispatchId, record, resource, identity)
        const metadata = newMetadata(params.dispatchId, resource, record, 'terminal', identity, {
          exact: snapshot.sourceExact, truncated: snapshot.clipped, fallbackReason: result.reason
        })
        snapshot = {
          ...snapshot,
          fallbackReason: result.reason,
          sourceIdentity: opaqueSourceIdentity(metadata)
        }
      }
    }
    validateCursorPosition(snapshot, cursor, runtime)
    validateCursorContent(snapshot, cursor, runtime)
    const evidence = await readAgentEvidence(runtime, dispatch, observation, record, resource)
    const live = agentLiveness(evidence, observation, record, resource, dispatch.terminationReason)
    const responseObservation: WorkerObservation = evidence.reason === 'peer_changed'
      ? { status: 'identity_changed', exactWorker: false, reason: 'peer_changed', identity: null, session: null }
      : isCertifiedExit(dispatch.terminationReason)
        ? { ...observation, status: 'exited', reason: null }
        : observation.status === 'exited' && observation.exactWorker
          ? observation
          : evidence.liveStatus === 'unavailable' && (evidence.reason === 'host_unavailable' || evidence.reason === 'capability_unsupported')
            ? unavailableObservation(evidence.reason)
            : observation
    if (snapshot.source === 'terminal') return buildTerminalResult(params, snapshot, cursor, responseObservation, live)
    return buildMessageResult(params, snapshot, cursor, responseObservation, live, limit)
  }

  return { read, capture }
}
