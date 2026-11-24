/** Validating an instance-bound stop request before the running quirkyd acts on it. */
import { createHash } from 'node:crypto'
import { lstatSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { readNodeFileSyncWithinLimit } from '../../shared/node-bounded-file-reader'
import {
  QUIRKYD_MANAGED_STOP_REQUEST_MAX_BYTES,
  QUIRKYD_MANAGED_STOP_REQUEST_PREFIX,
  QuirkydManagedStopRequestSchema,
  type QuirkydManagedStopContext,
  type QuirkydManagedStopInstance,
  type QuirkydManagedStopRequest
} from '../../shared/quirkyd-stop-request'
import { readQuirkydInstanceLockRecord, type QuirkydLockRecord } from './quirkyd-instance-lock'

/** Keyed by the lock nonce, so a request for a previous instance is never this one's. */
export function quirkydManagedStopRequestPath(instance: QuirkydManagedStopInstance): string {
  const digest = createHash('sha256').update(instance.nonce).digest('hex')
  return join(dirname(instance.lockPath), `${QUIRKYD_MANAGED_STOP_REQUEST_PREFIX}.${digest}`)
}

export function readQuirkydManagedStopRequest(path: string): QuirkydManagedStopRequest {
  if (!lstatSync(path).isFile()) {
    throw new Error('quirkyd_managed_stop_request_not_regular_file')
  }
  const { buffer } = readNodeFileSyncWithinLimit(path, QUIRKYD_MANAGED_STOP_REQUEST_MAX_BYTES)
  return QuirkydManagedStopRequestSchema.parse(JSON.parse(buffer.toString('utf8')))
}

export function sameQuirkydManagedStopInstance(
  left: QuirkydManagedStopInstance,
  right: Pick<QuirkydManagedStopInstance, 'pid' | 'startedAtMs' | 'nonce'>
): boolean {
  return (
    left.pid === right.pid && left.startedAtMs === right.startedAtMs && left.nonce === right.nonce
  )
}

/** Whether the instance lock still names exactly this instance. */
export function quirkydInstanceLockNames(instance: QuirkydManagedStopInstance): boolean {
  return readQuirkydInstanceLockNaming(instance) !== null
}

/** The lock record, only while it still names exactly this instance. */
export function readQuirkydInstanceLockNaming(
  instance: QuirkydManagedStopInstance
): QuirkydLockRecord | null {
  if (!lstatSync(instance.lockPath).isFile()) {
    return null
  }
  const record = readQuirkydInstanceLockRecord(instance.lockPath)
  return record !== null && sameQuirkydManagedStopInstance(instance, record) ? record : null
}

/** Throws unless the request names this running instance and its lock is still ours. */
export function validateQuirkydManagedStopRequest(
  context: QuirkydManagedStopContext,
  requestPath: string
): QuirkydManagedStopRequest {
  const request = readQuirkydManagedStopRequest(requestPath)
  if (
    request.version !== context.version ||
    request.runtimeId !== context.runtimeId ||
    // Resolved: a Windows client names the lock with `/`, quirkyd's own path.join with `\`.
    resolve(request.instance.lockPath) !== resolve(context.instance.lockPath) ||
    !sameQuirkydManagedStopInstance(request.instance, context.instance)
  ) {
    throw new Error('quirkyd_managed_stop_request_identity_mismatch')
  }
  if (!quirkydInstanceLockNames(context.instance)) {
    throw new Error('quirkyd_managed_stop_instance_lock_changed')
  }
  return request
}
