/**
 * Asking one quirkyd instance to stop and proving that it did.
 *
 * Runs as a short-lived command on the execution host. It never signals: it writes the
 * instance-bound request the running quirkyd watches for, then observes until the instance is
 * gone. `exited` needs proof — no process with that PID, or a PID whose kernel identity or owner
 * uid shows it now belongs to another process. A wall-clock disagreement, or anything the host
 * cannot answer, is `unverifiable`, never exit.
 */
import { setTimeout as delay } from 'node:timers/promises'
import { writeDurableSecureJsonFile } from '../../shared/secure-file'
import {
  QuirkydManagedStopRequestSchema,
  quirkydManagedStopRequestKey,
  type QuirkydManagedStopInstance,
  type QuirkydManagedStopRequest,
  type QuirkydManagedStopVerdict
} from '../../shared/quirkyd-stop-request'
import {
  compareQuirkydProcessIdentity,
  recordedQuirkydProcessIncarnation,
  type QuirkydProcessIdentityReaders,
  type QuirkydRecordedIdentity
} from './quirkyd-process-start-time'
import { hasErrorCode, inspectProcessSignal } from '../daemon/daemon-process-inspection'
import { persistQuirkydCompletedStopReceipt } from './quirkyd-completed-stop-receipt'
import { readQuirkydManagedStopDecision } from './quirkyd-managed-stop-decision'
import { withdrawQuirkydManagedStopRequest } from './quirkyd-managed-stop-cancellation'
import {
  quirkydInstanceLockNames,
  quirkydManagedStopRequestPath,
  readQuirkydInstanceLockNaming,
  readQuirkydManagedStopRequest
} from './quirkyd-managed-stop-request'
import {
  QUIRKYD_STOP_COMPLETION_POLL_ATTEMPTS,
  QUIRKYD_STOP_COMPLETION_POLL_MS
} from './quirkyd-stop-deadlines'

export type QuirkydProcessProbe = (pid: number) => 'alive' | 'missing' | 'unverifiable'

export type QuirkydManagedStopCompletionOptions = QuirkydProcessIdentityReaders & {
  probeProcess?: QuirkydProcessProbe
  sleep?: () => Promise<void>
  attempts?: number
  now?: () => Date
}

function defaultProbe(pid: number): ReturnType<QuirkydProcessProbe> {
  const signal = inspectProcessSignal(pid)
  // EPERM proves some process holds the PID; it cannot prove ours exited.
  return signal === 'occupied' ? 'alive' : signal === 'missing' ? 'missing' : 'unverifiable'
}

function observeInstance(
  instance: QuirkydManagedStopInstance,
  recorded: QuirkydRecordedIdentity,
  options: QuirkydManagedStopCompletionOptions
): QuirkydManagedStopVerdict {
  const probe = (options.probeProcess ?? defaultProbe)(instance.pid)
  if (probe !== 'alive') {
    return probe === 'missing' ? 'exited' : 'unverifiable'
  }
  // Only a kernel identity, stored creation time or owner uid proves reuse; unknown stays live.
  const identity = compareQuirkydProcessIdentity(instance.pid, recorded, options)
  return identity === 'differs' ? 'exited' : identity === 'unproven' ? 'unverifiable' : 'live'
}

/** An older client's request lacks the incarnation; the lock still naming the instance has it. */
function recordedIdentity(instance: QuirkydManagedStopInstance): QuirkydRecordedIdentity {
  if (recordedQuirkydProcessIncarnation(instance)) {
    return instance
  }
  let record: QuirkydRecordedIdentity | null = null
  try {
    record = readQuirkydInstanceLockNaming(instance)
  } catch {
    return instance
  }
  if (!record) {
    return instance
  }
  // The lock's identity lets a reused PID be proven by its owner uid.
  return { ...instance, ...recordedQuirkydProcessIncarnation(record), identity: record.identity }
}

/** Writes the request only while the lock still names this instance, then waits for exit. */
export async function completeQuirkydManagedStop(
  input: QuirkydManagedStopRequest,
  options: QuirkydManagedStopCompletionOptions = {}
): Promise<QuirkydManagedStopVerdict> {
  const request = QuirkydManagedStopRequestSchema.parse(input)
  const attempts = options.attempts ?? QUIRKYD_STOP_COMPLETION_POLL_ATTEMPTS
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 240) {
    throw new Error('quirkyd_managed_stop_invalid_attempts')
  }
  const completed = (): 'exited' => {
    persistQuirkydCompletedStopReceipt(request, (options.now ?? (() => new Date()))())
    return 'exited'
  }
  const recorded = recordedIdentity(request.instance)
  let verdict = observeInstance(request.instance, recorded, options)
  if (verdict !== 'live') {
    return verdict === 'exited' ? completed() : verdict
  }
  if (!lockStillNamesInstance(request.instance)) {
    // The process lives but no longer owns the lock it published: it is not ours to address.
    return 'unverifiable'
  }
  if (readQuirkydManagedStopDecision(request) === 'canceled') {
    // A cancelled transaction is never reissued; its quirkyd keeps running.
    return 'live'
  }
  const requestPath = quirkydManagedStopRequestPath(request.instance)
  if (!existingRequestMatches(requestPath, request)) {
    return 'unverifiable'
  }
  if (!writeDurableSecureJsonFile(requestPath, request)) {
    throw new Error('quirkyd_managed_stop_request_permissions_unconfirmed')
  }
  // A cancel that won between the check above and this write found no file to remove.
  if (readQuirkydManagedStopDecision(request) === 'canceled') {
    withdrawQuirkydManagedStopRequest(request)
    return 'live'
  }
  for (let attempt = 0; attempt < attempts; attempt++) {
    await (options.sleep ?? (() => delay(QUIRKYD_STOP_COMPLETION_POLL_MS)))()
    verdict = observeInstance(request.instance, recorded, options)
    if (verdict !== 'live') {
      return verdict === 'exited' ? completed() : verdict
    }
  }
  return 'live'
}

function lockStillNamesInstance(instance: QuirkydManagedStopInstance): boolean {
  try {
    return quirkydInstanceLockNames(instance)
  } catch {
    return false
  }
}

/** A request already present must be this one; another transaction's request is not ours. */
function existingRequestMatches(path: string, request: QuirkydManagedStopRequest): boolean {
  try {
    return (
      quirkydManagedStopRequestKey(readQuirkydManagedStopRequest(path)) ===
      quirkydManagedStopRequestKey(request)
    )
  } catch (error) {
    return hasErrorCode(error, 'ENOENT')
  }
}
