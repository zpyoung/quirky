import type { CommandRequest, WatcherCommand, WatcherDetail, WatcherTarget, WorkerIdentity } from './control-contracts'
import type { FleetRow, FleetSnapshot } from './control-contracts'
import type { TickTrace } from './contracts'

export type StatusPresentation = {
  label: string
  reason?: string
  detail?: string
}

export type DecisionTraceGroup = {
  firstSeq: number
  lastSeq: number
  count: number
  representative: TickTrace
}

function ageLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Keeps contact certainty and the underlying owner status explanation visible together. */
export function statusPresentation(row: Pick<FleetRow, 'status' | 'ownerContact' | 'observedAtMs'>, now: number): StatusPresentation {
  let label: string
  if (row.ownerContact === 'unverifiable') {
    label = `Host unreachable · last confirmed ${ageLabel(now - row.observedAtMs)}`
  } else if (row.status.state === 'held' && (row.status.reason === 'tick-error' || row.status.consecutiveErrors > 0)) {
    label = 'Error · retrying'
  } else {
    switch (row.status.state) {
      case 'watching': label = 'Watching'; break
      case 'held': label = 'Held'; break
      case 'acting': label = 'Acting'; break
      case 'escalated': label = 'Escalated'; break
      case 'parked': label = 'Parked'; break
      case 'terminal': label = 'Complete'; break
      case 'disabled': label = 'Stopped'; break
      case 'unreachable': label = 'Host unreachable'; break
      case 'malformed': label = 'Malformed'; break
      default: label = 'Unknown'; break
    }
  }
  return {
    label,
    ...(row.status.reason ? { reason: row.status.reason } : {}),
    ...(row.status.detail ? { detail: row.status.detail } : {})
  }
}

/** Retains the last confirmed snapshot unless the incoming snapshot is strictly newer. */
export function acceptFleetSnapshot(current: FleetSnapshot | null, incoming: FleetSnapshot): FleetSnapshot {
  return current === null || incoming.generatedAtMs > current.generatedAtMs ? incoming : current
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? String(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`
}


function workerIdentityKey(identity: WorkerIdentity): string {
  return canonical({
    dispatchId: identity.dispatchId,
    sessionId: identity.sessionId,
    processIncarnation: identity.processIncarnation,
    pid: identity.pid,
    startTime: identity.startTime,
    terminalHandle: identity.terminalHandle
  })
}

function targetIdentityKey(target: WatcherTarget): string {
  return canonical([target.watcherId, target.connectionId ?? null, target.pairingRevision ?? null])
}

function ownerFenceKey(ownerFence: WatcherDetail['ownerFence']): string {
  return canonical({
    executionHostId: ownerFence.executionHostId,
    schedulerOwner: ownerFence.schedulerOwner,
    workspaceKey: ownerFence.workspaceKey,
    revision: ownerFence.revision
  })
}

/** Host, scheduler, workspace and remote incarnation; excludes ownerFence.revision (enrollment.commandRevision). */
export function ownerEpochKey(detail: Pick<WatcherDetail, 'target' | 'ownerFence' | 'ownerIncarnation'>): string {
  return canonical({
    executionHostId: detail.ownerFence.executionHostId,
    schedulerOwner: detail.ownerFence.schedulerOwner,
    workspaceKey: detail.ownerFence.workspaceKey,
    ownerIncarnation: detail.ownerIncarnation
  })
}

/** Partitions answer drafts by exact worker session, process and question (dispatchId, sessionId, processIncarnation, messageId). */
export function answerDraftKey(identity: WorkerIdentity, messageId: string): string {
  return canonical([
    identity.dispatchId,
    identity.sessionId,
    identity.processIncarnation,
    identity.pid,
    identity.startTime,
    identity.terminalHandle,
    messageId
  ])
}

/** UI-private capture taken when the user acts; never sent to the daemon. */
export type CommandReceipt =
  | { kind: 'answer'; worker: WorkerIdentity; messageId: string }
  | { kind: 'none' }

/**
 * Null when the command may still be sent against `latest`; otherwise the user-facing reason:
 * 'The worker's question changed', 'The worker's process changed' or 'The approval scope changed'.
 */
export function commandEligibility(command: WatcherCommand, receipt: CommandReceipt, latest: WatcherDetail): string | null {
  if (command.kind === 'approve') {
    const escalation = latest.openEscalations.find((candidate) => candidate.escalationId === command.escalationId)
    if (
      !escalation || escalation.status !== 'open' || !escalation.approvalScope ||
      canonical(escalation.approvalScope) !== canonical(command.scope)
    ) return 'The approval scope changed'
    return null
  }

  if (command.kind === 'stop-worker') {
    const worker = latest.workers.find((candidate) => candidate.identity.dispatchId === command.identity.dispatchId)
    if (!worker || worker.state !== 'live' || workerIdentityKey(worker.identity) !== workerIdentityKey(command.identity)) {
      return "The worker's process changed"
    }
    return null
  }

  if (command.kind === 'answer-question') {
    if (receipt.kind !== 'answer' || receipt.messageId !== command.messageId) return "The worker's question changed"
    const worker = latest.workers.find((candidate) => candidate.identity.dispatchId === receipt.worker.dispatchId)
    if (!worker) return "The worker's question changed"
    if (workerIdentityKey(worker.identity) !== workerIdentityKey(receipt.worker)) return "The worker's process changed"
    if (
      !worker.question || worker.question.answered ||
      worker.question.messageId !== receipt.messageId || worker.question.messageId !== command.messageId
    ) return "The worker's question changed"
    return null
  }

  return null
}

/** True only when target key, every ownerFence field (including revision) and ownerIncarnation all match. */
export function sameCommandOwner(
  captured: CommandRequest & { expectedIncarnation?: string },
  latest: WatcherDetail
): boolean {
  return targetIdentityKey(captured.target) === targetIdentityKey(latest.target) &&
    ownerFenceKey(captured.expectedOwner) === ownerFenceKey(latest.ownerFence) &&
    captured.expectedIncarnation === latest.ownerIncarnation
}

function gateHeldIdentity(trace: TickTrace): string {
  return canonical({
    contentIdentity: trace.contentIdentity,
    snapshot: trace.snapshot,
    decision: trace.decision,
    declined: trace.declined,
    gate: trace.gate,
    budget: trace.budget,
    error: trace.error
  })
}

/** Collapses adjacent, semantically identical gate-held traces; all other traces stay distinct. */
export function groupDecisionTraces(traces: readonly TickTrace[]): DecisionTraceGroup[] {
  const ordered = [...traces].sort((a, b) => a.seq - b.seq)
  const groups: DecisionTraceGroup[] = []
  for (const trace of ordered) {
    const previous = groups.at(-1)
    if (
      trace.exitPath === 'gate-held' && previous?.representative.exitPath === 'gate-held' &&
      trace.seq === previous.lastSeq + 1 && gateHeldIdentity(trace) === gateHeldIdentity(previous.representative)
    ) {
      previous.lastSeq = trace.seq
      previous.count += 1
      continue
    }
    groups.push({ firstSeq: trace.seq, lastSeq: trace.seq, count: 1, representative: trace })
  }
  return groups
}
